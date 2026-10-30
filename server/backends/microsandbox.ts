import { userInfo } from "node:os";
import type { ContainerStatus } from "../../shared/rpc";
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

/** Everything after the image, shared by the sandbox and its throwaway runs. */
async function sandboxOptions(target: ContainerTarget, policy: ContainerPolicy): Promise<string[]> {
  const user = userInfo();
  const mounts = (await resolveMounts(target, policy)).flatMap((mount) => [
    "-v",
    `${mount.source ?? mount.path}:${mount.path}${mount.readOnly ? ":ro" : ""}`,
  ]);
  return [
    "-w",
    target.workdir,
    // Commands run as your uid, as in the container engines.
    "-u",
    `${user.uid}:${user.gid}`,
    ...baseEnvironment(target).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
    ...mounts,
    ...network(policy),
    // Images download only through `pull`, after the user agreed; see ImageStore.
    "--pull",
    "never",
    ...extraArguments(policy),
  ];
}

// `all` includes the host's loopback, which agents use for the daemon's MCP endpoint.
function network(policy: ContainerPolicy): string[] {
  if (policy.network === "none") return ["--no-net"];
  return ["--net", policy.network === "host" ? "all" : "public"];
}

// `inspect --format json` has a top-level "status" ("Running", "Stopped") and no ID; the creation
// time changes whenever the sandbox is recreated.
async function inspect(cli: string, name: string): Promise<ContainerStatus> {
  let raw: string;
  try {
    raw = await runCli(cli, ["inspect", name, "--format", "json"]);
  } catch {
    return { state: "missing" };
  }
  const parsed: unknown = JSON.parse(raw);
  const status =
    parsed !== null && typeof parsed === "object" ? (parsed as { status?: unknown }).status : "";
  return typeof status === "string" && /running/i.test(status)
    ? { state: "running" }
    : { state: "stopped" };
}

/**
 * microsandbox (`msb`, https://docs.microsandbox.dev/cli/sandbox-commands): one libkrun microVM per
 * workspace, created from an image and joined with `exec`. Host folders are shared over virtio-fs
 * at the same paths.
 */
export const microsandboxBackend: SandboxBackend = {
  persistent: true,

  images: {
    async localDigests(cli, image) {
      let raw: string;
      try {
        raw = await runCli(cli, ["image", "inspect", image, "--format", "json"]);
      } catch {
        return null;
      }
      // This platform's manifest digest.
      const { digest } = JSON.parse(raw) as { digest?: unknown };
      return typeof digest === "string" ? [digest] : [];
    },
    async pull(cli, image) {
      await runCli(cli, ["pull", "--quiet", image], { long: true });
    },
  },

  async start(target, policy) {
    const current = await inspect(policy.cli, target.container);
    if (current.state === "running") return;
    if (current.state === "stopped") {
      await runCli(policy.cli, ["start", target.container], { long: true });
      return;
    }
    await runCli(
      policy.cli,
      [
        "create",
        target.image,
        "--name",
        target.container,
        ...(await sandboxOptions(target, policy)),
      ],
      { long: true },
    );
  },

  status: (target, policy) => inspect(policy.cli, target.container),

  async remove(target, policy) {
    if ((await inspect(policy.cli, target.container)).state === "missing") return;
    await runCli(policy.cli, ["rm", "--force", target.container]);
  },

  async runOnce(target, policy, argv) {
    return runCli(
      policy.cli,
      ["run", target.image, "--no-stdin", ...(await sandboxOptions(target, policy)), "--", ...argv],
      { long: true },
    );
  },

  async spec(target, policy) {
    return [
      `sandbox_cli=${shellQuote(policy.cli)}`,
      `sandbox_container=${shellQuote(target.container)}`,
      "sandbox_tracks_pid=1",
      "sandbox_ready() {",
      '  "$sandbox_cli" inspect "$sandbox_container" --format json 2>/dev/null |',
      '    grep -q -i -E \'^  "status": *"running"\'',
      "}",
      "sandbox_id() {",
      '  "$sandbox_cli" inspect "$sandbox_container" --format json 2>/dev/null |',
      "    grep -E '^  \"created_at\":' | head -n 1",
      "}",
      "# sandbox_exec ENV_FILE TTY WORKDIR -- COMMAND...",
      "sandbox_exec() {",
      "  _env=$1 _tty=$2 _dir=$3",
      "  shift 4",
      '  set -- -w "$_dir" "$sandbox_container" -- "$@"',
      "  # `-e NAME` takes the value from the client's environment, which keeps values off its",
      "  # command line. Callers run this in a subshell, so the exports stay there; a later line",
      "  # for the same name wins.",
      '  if [ -n "$_env" ]; then',
      "    while IFS= read -r _line; do",
      "      case $_line in '' | '#'*) continue ;; esac",
      '      export "$_line"',
      '      set -- -e "${_line%%=*}" "$@"',
      '    done <"$_env"',
      "  fi",
      '  if [ -n "$_tty" ]; then _tty_flags=-t; else _tty_flags=--no-tty; fi',
      '  "$sandbox_cli" exec $_tty_flags "$@"',
      "}",
      "sandbox_signal() {",
      '  "$sandbox_cli" exec "$sandbox_container" -- sh -c \'kill -s "$1" "$(cat "$0")" 2>/dev/null\' "$2" "$1"',
      "}",
      "sandbox_cleanup() {",
      '  "$sandbox_cli" exec "$sandbox_container" -- rm -f "$1"',
      "}",
    ].join("\n");
  },
};
