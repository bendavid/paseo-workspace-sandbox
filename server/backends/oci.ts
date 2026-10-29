import { userInfo } from "node:os";
import type { ContainerStatus } from "../../shared/rpc";
import {
  baseEnvironment,
  extraArguments,
  isPodman,
  resolveMounts,
  runCli,
  shellQuote,
  type ContainerPolicy,
  type ContainerTarget,
} from "../container";
import { KEEPALIVE, type SandboxBackend } from "./types";

/** Everything between `run` and the image, shared by the sandbox and its throwaway runs. */
async function containerOptions(
  target: ContainerTarget,
  policy: ContainerPolicy,
): Promise<string[]> {
  const user = userInfo();
  // Files the container writes keep your ownership: Podman maps your uid into its namespace,
  // Docker runs the process as your uid.
  const identity = (await isPodman(policy.cli))
    ? ["--userns=keep-id"]
    : ["--user", `${user.uid}:${user.gid}`];
  const mounts = (await resolveMounts(target, policy)).flatMap((mount) => [
    "-v",
    `${mount.source ?? mount.path}:${mount.path}${mount.readOnly ? ":ro" : ""}`,
  ]);
  return [
    "--network",
    policy.network,
    ...identity,
    "--workdir",
    target.workdir,
    ...baseEnvironment(target).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
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

/** Podman and Docker: one long-lived container per workspace, joined with `exec`. */
export const ociBackend: SandboxBackend = {
  persistent: true,

  async start(target, policy) {
    const current = await inspect(policy.cli, target.container);
    if (current.state === "running") return;
    if (current.state === "stopped") {
      await runCli(policy.cli, ["start", target.container]);
      return;
    }
    await runCli(
      policy.cli,
      [
        "run",
        "-d",
        "--name",
        target.container,
        "--label",
        `paseo.workspace-sandbox.${target.label}`,
        "--init",
        ...(await containerOptions(target, policy)),
        target.image,
        "sh",
        "-c",
        KEEPALIVE,
      ],
      { long: true },
    );
  },

  status: (target, policy) => inspect(policy.cli, target.container),

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
        ...(await containerOptions(target, policy)),
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
