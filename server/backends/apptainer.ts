import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  baseEnvironment,
  extraArguments,
  resolveMounts,
  runCli,
  shellQuote,
  type ContainerPolicy,
  type ContainerTarget,
  type Mount,
} from "../container";
import { remoteDigests } from "../registry";
import { resolveDataDirectory } from "../store";
import { commandArguments, type ImageStore, type SandboxBackend } from "./types";

/**
 * Apptainer and Singularity: a fresh container per launch from a SIF image, like Bubblewrap. They
 * run as you by default and add your account to the container's /etc/passwd themselves.
 *
 * Both evaluate `--env`, `--env-file`, and `APPTAINERENV_*` values as shell words, expanding `$`
 * and command substitutions, so no value goes through them. The base environment is written into
 * the loader script, shell-quoted, and each launch's environment arrives on file descriptor 3,
 * which the launcher opens and deletes before the engine starts; `sh` in the container exports
 * each line as is.
 */

/** A local SIF file, used as it is, rather than a registry reference the plugin pulls. */
function isImageFile(image: string): boolean {
  return path.isAbsolute(image);
}

/** Where a registry image's SIF and the digests it was pulled at live. */
function cachedImage(image: string): { sif: string; digests: string } {
  const name = image.replace(/[^A-Za-z0-9_.-]+/g, "_");
  const directory = path.join(resolveDataDirectory(), "images");
  return {
    sif: path.join(directory, `${name}.sif`),
    digests: path.join(directory, `${name}.digests.json`),
  };
}

function sifPath(image: string): string {
  return isImageFile(image) ? image : cachedImage(image).sif;
}

const images: ImageStore = {
  async localDigests(_cli, image) {
    if (isImageFile(image)) return existsSync(image) ? [] : null;
    const cached = cachedImage(image);
    if (!existsSync(cached.sif)) return null;
    // Recorded at pull time; a SIF without them counts as built locally.
    const raw = await readFile(cached.digests, "utf8").catch(() => "[]");
    const digests: unknown = JSON.parse(raw);
    return Array.isArray(digests) ? digests.filter((d): d is string => typeof d === "string") : [];
  },
  pullable: (image) => !isImageFile(image),
  async pull(cli, image) {
    const cached = cachedImage(image);
    await mkdir(path.dirname(cached.sif), { recursive: true });
    const partial = `${cached.sif}.partial`;
    // The registry's digests now, which is what the pull fetches, for later freshness checks.
    const digests = (await remoteDigests(image)) ?? [];
    try {
      await runCli(cli, ["pull", "--force", partial, `docker://${image}`], { long: true });
      await rename(partial, cached.sif);
    } finally {
      await rm(partial, { force: true });
    }
    await writeFile(cached.digests, `${JSON.stringify(digests)}\n`);
  },
};

/** The options of `exec` before the image, besides the working directory. */
function containerArguments(policy: ContainerPolicy, mounts: Mount[]): string[] {
  return [
    // No automatic mounts of your home, the working directory, or /tmp; private /dev, PID, and IPC.
    "--containall",
    "--cleanenv",
    // The image is read-only; this gives each launch a writable layer over it.
    "--writable-tmpfs",
    ...(policy.network === "none" ? ["--net", "--network", "none"] : []),
    ...mounts.flatMap((mount) => [
      "--bind",
      `${mount.source ?? mount.path}:${mount.path}${mount.readOnly ? ":ro" : ""}`,
    ]),
    ...extraArguments(policy),
  ];
}

/** Exports the base environment, then each line on file descriptor 3 when given, then runs. */
function loaderScript(target: ContainerTarget, readLaunchEnvironment: boolean): string {
  return [
    ...baseEnvironment(target, true).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
    ...(readLaunchEnvironment
      ? [
          'while IFS= read -r line <&3; do case $line in "" | "#"*) continue ;; esac; export "$line"; done',
          "exec 3<&-",
        ]
      : []),
    'exec "$@"',
  ].join("\n");
}

export const apptainerBackend: SandboxBackend = {
  persistent: false,
  images,

  async start(target, policy) {
    await this.runOnce(target, policy, ["true"]);
  },

  // Nothing is kept between launches; the image is what has to be there.
  async status(target) {
    return existsSync(sifPath(target.image)) ? { state: "running" } : { state: "missing" };
  },

  async remove() {},

  async runOnce(target, policy, argv) {
    if (!existsSync(sifPath(target.image))) {
      throw new Error(`The image file ${sifPath(target.image)} does not exist`);
    }
    const mounts = await resolveMounts(target, policy);
    return runCli(
      policy.cli,
      commandArguments(await this.commandLine(target, policy, mounts, argv)),
    );
  },

  async commandLine(target, policy, mounts, launch) {
    return {
      head: ["exec"],
      options: [...containerArguments(policy, mounts), "--pwd", target.workdir],
      tail: [sifPath(target.image), "sh", "-c", loaderScript(target, false), "sh", ...launch],
    };
  },

  async spec(target, policy) {
    const mounts = await resolveMounts(target, policy);
    const fixed = ["exec", ...containerArguments(policy, mounts)].map(shellQuote).join(" ");
    const image = shellQuote(sifPath(target.image));
    return [
      `sandbox_cli=${shellQuote(policy.cli)}`,
      `sandbox_image=${image}`,
      "sandbox_tracks_pid=0",
      'sandbox_ready() { [ -x "$sandbox_cli" ] && [ -f "$sandbox_image" ]; }',
      // A replaced image (an update) captures the login shell environment again.
      'sandbox_id() { stat -c "%i:%Y" "$sandbox_image" 2>/dev/null; }',
      `sandbox_loader=${shellQuote(loaderScript(target, false))}`,
      `sandbox_env_loader=${shellQuote(loaderScript(target, true))}`,
      "# sandbox_exec ENV_FILE TTY WORKDIR -- COMMAND...: replaces the calling shell.",
      "sandbox_exec() {",
      "  _env=$1 _dir=$3",
      "  shift 4",
      '  if [ -n "$_env" ]; then',
      "    # Open it, then delete it: the container reads it from the open descriptor.",
      '    exec 3<"$_env"',
      '    rm -f "$_env"',
      `    exec "$sandbox_cli" ${fixed} --pwd "$_dir" "$sandbox_image" sh -c "$sandbox_env_loader" sh "$@"`,
      "  fi",
      `  exec "$sandbox_cli" ${fixed} --pwd "$_dir" "$sandbox_image" sh -c "$sandbox_loader" sh "$@"`,
      "}",
    ].join("\n");
  },
};
