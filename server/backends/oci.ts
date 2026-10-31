import { userInfo } from "node:os";
import type { ContainerStatus } from "../../shared/rpc";
import {
  HOST_ACCOUNT_SCRIPT,
  PROVIDER_LINKS_SCRIPT,
  baseEnvironment,
  extraArguments,
  hostAccount,
  isPodman,
  sharedProviderDirectories,
  resolveMounts,
  runCli,
  shellQuote,
  type ContainerPolicy,
  type ContainerTarget,
  type Mount,
} from "../container";
import { KEEPALIVE, commandArguments, type SandboxBackend } from "./types";

/**
 * Podman with only your ids mapped, to the same ids. Podman sets ping_group_range to "0 0" in a
 * container's own network namespace, which fails while group 0 is unmapped.
 */
function squashedIdentity(network: ContainerPolicy["network"]): string[] {
  const user = userInfo();
  return [
    "--uidmap",
    `${user.uid}:0:1`,
    "--gidmap",
    `${user.gid}:0:1`,
    "--user",
    `${user.uid}:${user.gid}`,
    "--group-add",
    "keep-groups",
    ...(network === "host"
      ? []
      : ["--sysctl", `net.ipv4.ping_group_range=${user.gid} ${user.gid}`]),
  ];
}

/**
 * Squashed: a read-only root, since nothing in it can act as root and the image's files appear as
 * yours, with /tmp, /var/tmp, /run, /dev/shm, and HOME (unless a mount provides it) in memory.
 * They start empty: Podman's own read-only tmpfs copies the image's /run in and fails on files
 * there owned by ids that are not mapped, such as dbus's. Podman adds your account for a uid the
 * image has no account for; it leaves an existing one alone, and nothing inside could change it.
 */
async function squashedOptions(policy: ContainerPolicy, mountPaths: string[]): Promise<string[]> {
  const [name, uid, gid, group, home] = await hostAccount();
  const homeMounted = mountPaths.some(
    (mount) => mount === "/" || mount === home || home!.startsWith(`${mount}/`),
  );
  return [
    ...squashedIdentity(policy.network),
    "--read-only",
    "--read-only-tmpfs=false",
    ...["/tmp", "/var/tmp", "/dev/shm"].flatMap((folder) => [
      "--tmpfs",
      `${folder}:notmpcopyup,mode=1777`,
    ]),
    "--tmpfs",
    "/run:notmpcopyup",
    "--passwd-entry",
    `${name}:x:${uid}:${gid}::${home}:/bin/sh`,
    "--group-entry",
    `${group}:x:${gid}:${name}`,
    ...(homeMounted ? [] : ["--tmpfs", `${home}:notmpcopyup,mode=0700`]),
  ];
}

/** Everything between `run` and the image, shared by the sandbox and its throwaway runs. */
async function containerOptions(
  target: ContainerTarget,
  policy: ContainerPolicy,
  resolved: Mount[],
): Promise<string[]> {
  const user = userInfo();
  // A Docker profile may run on podman-docker, which resolves to Podman itself.
  const podman = policy.engine === "podman" || (await isPodman(policy.cli));
  // As you, files the container writes keep your ownership: Podman maps your uid into its
  // namespace, Docker runs the process as your uid. Otherwise the image's default user runs.
  // keep-id alone drops your supplementary groups, so files you reach through a group (a team's
  // project folder, a shared file system) would be refused; keep-groups keeps them (crun only).
  let identity: string[] = [];
  if (policy.user === "squashed") {
    identity = await squashedOptions(
      policy,
      resolved.map((mount) => mount.path),
    );
  } else if (policy.user === "host") {
    identity = podman
      ? ["--userns=keep-id", "--group-add", "keep-groups"]
      : ["--user", `${user.uid}:${user.gid}`];
  }
  const mounts = resolved.flatMap((mount) => [
    "-v",
    `${mount.source ?? mount.path}:${mount.path}${mount.readOnly ? ":ro" : ""}`,
  ]);
  return [
    // Images download only through `pull`, after the user agreed; see ImageStore.
    "--pull=never",
    "--network",
    // Podman's private is a namespace of its own whichever way it runs: pasta or slirp4netns
    // rootless, the bridge as root, which a rootless Podman can't join.
    podman && policy.network === "bridge" ? "private" : policy.network,
    ...identity,
    "--workdir",
    target.workdir,
    ...baseEnvironment(target, policy.user !== "image").flatMap(([name, value]) => [
      "-e",
      `${name}=${value}`,
    ]),
    ...mounts,
    ...extraArguments(policy),
  ];
}

async function inspect(cli: string, name: string): Promise<ContainerStatus> {
  try {
    const stdout = await runCli(cli, [
      "container",
      "inspect",
      "--format",
      "{{.State.Running}}",
      name,
    ]);
    return stdout.trim() === "true" ? { state: "running" } : { state: "stopped" };
  } catch {
    return { state: "missing" };
  }
}

/**
 * Once, in a container just created: your account, as root, when it runs as you; otherwise links
 * to the provider folders in the image user's home. A squashed sandbox has no root; Podman wrote
 * its account. A failure leaves a working sandbox, so it is logged rather than thrown.
 */
async function prepareUser(target: ContainerTarget, policy: ContainerPolicy): Promise<void> {
  try {
    if (policy.user === "squashed") return;
    if (policy.user === "host") {
      await runCli(policy.cli, [
        "exec",
        "--user",
        "0",
        target.container,
        "sh",
        "-c",
        HOST_ACCOUNT_SCRIPT,
        "sh",
        ...(await hostAccount()),
      ]);
      return;
    }
    const directories = sharedProviderDirectories(policy);
    if (directories.length === 0) return;
    await runCli(policy.cli, [
      "exec",
      target.container,
      "sh",
      "-c",
      PROVIDER_LINKS_SCRIPT,
      "sh",
      ...directories,
    ]);
  } catch (error) {
    console.error(`Preparing the user of ${target.container} failed`, error);
  }
}

/** Podman and Docker: one long-lived container per workspace, joined with `exec`. */
export const ociBackend: SandboxBackend = {
  persistent: true,

  images: {
    async localDigests(cli, image) {
      let raw: string;
      try {
        raw = await runCli(cli, ["image", "inspect", "--format", "{{json .RepoDigests}}", image]);
      } catch {
        return null;
      }
      // `repository@sha256:…` for each digest the image was pulled by.
      const repoDigests = (JSON.parse(raw.trim() || "null") as string[] | null) ?? [];
      return repoDigests.map((entry) => entry.slice(entry.indexOf("@") + 1));
    },
    async pull(cli, image) {
      await runCli(cli, ["pull", image], { long: true });
    },
  },

  async start(target, policy) {
    const current = await inspect(policy.cli, target.container);
    if (current.state === "running") return;
    if (current.state === "stopped") {
      await runCli(policy.cli, ["start", target.container]);
      return;
    }
    const mounts = await resolveMounts(target, policy);
    const line = await this.commandLine(target, policy, mounts, []);
    await runCli(policy.cli, commandArguments(line), { long: true });
    await prepareUser(target, policy);
  },

  async commandLine(target, policy, mounts) {
    return {
      head: ["run", "-d"],
      options: [
        "--name",
        target.container,
        "--label",
        `paseo.workspace-sandbox.${target.label}`,
        "--init",
        ...(await containerOptions(target, policy, mounts)),
      ],
      tail: [target.image, "sh", "-c", KEEPALIVE],
    };
  },

  status: (target, policy) => inspect(policy.cli, target.container),

  async stop(target, policy) {
    if ((await inspect(policy.cli, target.container)).state !== "running") return;
    await runCli(policy.cli, ["stop", target.container], { long: true });
  },

  async remove(target, policy) {
    try {
      await runCli(policy.cli, ["rm", "-f", target.container]);
    } catch (error) {
      if ((await inspect(policy.cli, target.container)).state !== "missing") throw error;
    }
  },

  async runOnce(target, policy, argv) {
    return runCli(
      policy.cli,
      [
        "run",
        "--rm",
        "--label",
        "paseo.workspace-sandbox.check=1",
        ...(await containerOptions(target, policy, await resolveMounts(target, policy))),
        target.image,
        ...argv,
      ],
      { long: true },
    );
  },

  async spec(target, policy) {
    return [
      `sandbox_cli=${shellQuote(policy.cli)}`,
      `sandbox_container=${shellQuote(target.container)}`,
      "sandbox_tracks_pid=1",
      "sandbox_ready() {",
      '  [ "$("$sandbox_cli" container inspect --format \'{{.State.Running}}\' "$sandbox_container" 2>/dev/null)" = true ]',
      "}",
      "sandbox_id() {",
      '  "$sandbox_cli" container inspect --format \'{{.Id}}\' "$sandbox_container" 2>/dev/null',
      "}",
      "# sandbox_exec ENV_FILE TTY WORKDIR -- COMMAND...",
      "sandbox_exec() {",
      "  _env=$1 _tty=$2 _dir=$3",
      "  shift 4",
      '  "$sandbox_cli" exec -i ${_tty:+-t} ${_env:+--env-file} ${_env:+"$_env"} -w "$_dir" \\',
      '    "$sandbox_container" "$@"',
      "}",
      "sandbox_signal() {",
      '  "$sandbox_cli" exec "$sandbox_container" sh -c \'kill -s "$1" "$(cat "$0")" 2>/dev/null\' "$2" "$1"',
      "}",
      "sandbox_cleanup() {",
      '  "$sandbox_cli" exec "$sandbox_container" rm -f "$1"',
      "}",
    ].join("\n");
  },
};
