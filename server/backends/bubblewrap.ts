import { existsSync } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import {
  baseEnvironment,
  extraArguments,
  resolveMounts,
  runCli,
  shellQuote,
  type ContainerPolicy,
  type ContainerTarget,
} from "../container";
import type { SandboxBackend } from "./types";

// With --clearenv nothing is inherited; the login shell environment `sandbox-run` captures, and the
// variables it forwards, are set over these.
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * The host's system, read-only, and fresh /proc, /dev, /tmp, and /run. The top-level /bin, /lib and
 * friends are links into /usr on merged-/usr systems and directories elsewhere, so each is copied as
 * it is. Nothing of the home directory is visible unless a mount adds it.
 */
async function systemArguments(): Promise<string[]> {
  const args = ["--ro-bind", "/usr", "/usr"];
  for (const dir of ["/bin", "/sbin", "/lib", "/lib32", "/lib64"]) {
    const info = await lstat(dir).catch(() => null);
    if (!info) continue;
    if (info.isSymbolicLink()) args.push("--symlink", await readlink(dir), dir);
    else args.push("--ro-bind", dir, dir);
  }
  args.push("--ro-bind", "/etc", "/etc");
  for (const dir of ["/opt", "/nix"]) if (existsSync(dir)) args.push("--ro-bind", dir, dir);
  args.push(
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/run",
    // systemd-resolved's resolv.conf lives here; /etc/resolv.conf often links to it.
    "--ro-bind-try",
    "/run/systemd/resolve",
    "/run/systemd/resolve",
    "--dir",
    "/var",
    "--tmpfs",
    "/var/tmp",
  );
  return args;
}

/**
 * Everything but the environment and the command; mounts arrive sorted parents first. The home
 * directory is a scratch folder for the launch unless a mount covers it.
 */
async function sandboxArguments(
  target: ContainerTarget,
  policy: ContainerPolicy,
): Promise<string[]> {
  const mounts = await resolveMounts(target, policy);
  return [
    "--die-with-parent",
    "--unshare-all",
    ...(policy.network === "none" ? [] : ["--share-net"]),
    ...(await systemArguments()),
    "--dir",
    homedir(),
    ...mounts.flatMap((mount) => [
      mount.readOnly ? "--ro-bind" : "--bind",
      mount.source ?? mount.path,
      mount.path,
    ]),
    ...extraArguments(policy),
  ];
}

function environmentArguments(target: ContainerTarget): string[] {
  return [
    "--clearenv",
    ...[["PATH", DEFAULT_PATH] as [string, string], ...baseEnvironment(target, true)].flatMap(
      ([name, value]) => ["--setenv", name, value],
    ),
  ];
}

/**
 * Bubblewrap: a fresh sandbox for each launch, from the host's own system, read-only. There is no
 * image and nothing to start or remove; "starting" runs `true` with the configuration, so problems
 * such as disabled user namespaces surface as a failed start.
 */
export const bubblewrapBackend: SandboxBackend = {
  persistent: false,

  async start(target, policy) {
    await this.runOnce(target, policy, ["true"]);
  },

  async status() {
    return { state: "running" };
  },

  async remove() {},

  async runOnce(target, policy, argv) {
    return runCli(policy.cli, [
      ...(await sandboxArguments(target, policy)),
      ...environmentArguments(target),
      "--chdir",
      target.workdir,
      "--",
      ...argv,
    ]);
  },

  async spec(target, policy) {
    const fixed = [...(await sandboxArguments(target, policy)), ...environmentArguments(target)]
      .map(shellQuote)
      .join(" ");
    return [
      `sandbox_cli=${shellQuote(policy.cli)}`,
      "sandbox_tracks_pid=0",
      'sandbox_ready() { [ -x "$sandbox_cli" ]; }',
      "sandbox_id() { echo bubblewrap; }",
      "# sandbox_exec ENV_FILE TTY WORKDIR -- COMMAND...: replaces the calling shell.",
      "sandbox_exec() {",
      "  _env=$1 _dir=$3",
      "  shift 4",
      '  set -- --chdir "$_dir" -- "$@"',
      '  if [ -n "$_env" ]; then',
      "    # Prepended in reverse, so later lines still win.",
      "    while IFS= read -r _line; do",
      "      case $_line in '' | '#'*) continue ;; esac",
      '      set -- --setenv "${_line%%=*}" "${_line#*=}" "$@"',
      "    done <<SANDBOX_ENV",
      '$(reverse_lines "$_env")',
      "SANDBOX_ENV",
      '    rm -f "$_env"',
      "  fi",
      `  exec "$sandbox_cli" ${fixed} "$@"`,
      "}",
    ].join("\n");
  },
};
