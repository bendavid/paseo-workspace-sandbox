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
import { KEEPALIVE, type SandboxBackend } from "./types";

/**
 * microsandbox and BoxLite: libkrun microVMs with Docker-like command lines. Each keeps one VM per
 * workspace, created from an image and joined with `exec`. Host folders are shared over virtio-fs at
 * the same paths. They differ in a few flags, described by a dialect.
 */
interface Dialect {
  /** Creates and boots a named VM that stays up. */
  createArgs(name: string, image: string, options: string[]): string[];
  /** Runs a command in a throwaway VM. */
  runOnceArgs(image: string, options: string[], argv: string[]): string[];
  startArgs(name: string): string[];
  removeArgs(name: string): string[];
  network(policy: ContainerPolicy): string[];
  /** Parses `inspect` output; null when the VM does not exist. */
  status(cli: string, name: string): Promise<ContainerStatus>;
  /** Shell functions `sandbox_ready` and `sandbox_id`, reading the same `inspect`. */
  inspectShell: string[];
  /** The `exec` flags for a TTY, or for none. */
  ttyShell: string;
  /** Assignments prefixed to the client's `exec`, such as quieter logging. */
  clientEnv: string;
}

async function options(
  target: ContainerTarget,
  policy: ContainerPolicy,
  dialect: Dialect,
): Promise<string[]> {
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
    ...dialect.network(policy),
    ...extraArguments(policy),
  ];
}

function microvmBackend(dialect: Dialect): SandboxBackend {
  return {
    persistent: true,

    async start(target, policy) {
      const current = await dialect.status(policy.cli, target.container);
      if (current.state === "running") return;
      if (current.state === "stopped") {
        await runCli(policy.cli, dialect.startArgs(target.container), { long: true });
        return;
      }
      await runCli(
        policy.cli,
        dialect.createArgs(target.container, target.image, await options(target, policy, dialect)),
        { long: true },
      );
    },

    status: (target, policy) => dialect.status(policy.cli, target.container),

    async remove(target, policy) {
      if ((await dialect.status(policy.cli, target.container)).state === "missing") return;
      await runCli(policy.cli, dialect.removeArgs(target.container));
    },

    async runOnce(target, policy, argv) {
      return runCli(
        policy.cli,
        dialect.runOnceArgs(target.image, await options(target, policy, dialect), argv),
        { long: true },
      );
    },

    async spec(target, policy) {
      return [
        `sandbox_cli=${shellQuote(policy.cli)}`,
        `sandbox_container=${shellQuote(target.container)}`,
        "sandbox_tracks_pid=1",
        ...dialect.inspectShell,
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
        `  ${dialect.ttyShell}`,
        `  ${dialect.clientEnv}"$sandbox_cli" exec $_tty_flags "$@"`,
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
}

function stateFrom(raw: string): ContainerStatus {
  return /running/i.test(raw) ? { state: "running" } : { state: "stopped" };
}

/** microsandbox (`msb`): https://docs.microsandbox.dev/cli/sandbox-commands */
export const microsandboxBackend = microvmBackend({
  createArgs: (name, image, opts) => ["create", image, "--name", name, ...opts],
  runOnceArgs: (image, opts, argv) => ["run", image, "--no-stdin", ...opts, "--", ...argv],
  startArgs: (name) => ["start", name],
  removeArgs: (name) => ["rm", "--force", name],
  // `all` includes the host's loopback, which agents use for the daemon's MCP endpoint.
  network: (policy) => {
    if (policy.network === "none") return ["--no-net"];
    return ["--net", policy.network === "host" ? "all" : "public"];
  },
  // `inspect --format json` has a top-level "status" ("Running", "Stopped") and no ID; the creation
  // time changes whenever the sandbox is recreated.
  async status(cli, name) {
    let raw: string;
    try {
      raw = await runCli(cli, ["inspect", name, "--format", "json"]);
    } catch {
      return { state: "missing" };
    }
    const parsed: unknown = JSON.parse(raw);
    const status =
      parsed !== null && typeof parsed === "object" ? (parsed as { status?: unknown }).status : "";
    return stateFrom(typeof status === "string" ? status : "");
  },
  inspectShell: [
    "sandbox_ready() {",
    '  "$sandbox_cli" inspect "$sandbox_container" --format json 2>/dev/null |',
    '    grep -q -i -E \'^  "status": *"running"\'',
    "}",
    "sandbox_id() {",
    '  "$sandbox_cli" inspect "$sandbox_container" --format json 2>/dev/null |',
    "    grep -E '^  \"created_at\":' | head -n 1",
    "}",
  ],
  ttyShell: 'if [ -n "$_tty" ]; then _tty_flags=-t; else _tty_flags=--no-tty; fi',
  clientEnv: "",
});

/** BoxLite: https://docs.boxlite.ai/reference/cli.md */
export const boxliteBackend = microvmBackend({
  createArgs: (name, image, opts) => [
    "run",
    "-d",
    "--name",
    name,
    ...opts,
    image,
    "sh",
    "-c",
    KEEPALIVE,
  ],
  runOnceArgs: (image, opts, argv) => ["run", "--rm", ...opts, image, ...argv],
  startArgs: (name) => ["start", name],
  removeArgs: (name) => ["rm", "-f", name],
  // BoxLite always uses its user-mode network; the host's loopback is host.boxlite.internal.
  network: (policy) => (policy.network === "none" ? ["--network", "disabled"] : []),
  async status(cli, name) {
    try {
      return stateFrom(await runCli(cli, ["inspect", "--format", "{{.State.Status}}", name]));
    } catch {
      return { state: "missing" };
    }
  },
  inspectShell: [
    "sandbox_ready() {",
    '  "$sandbox_cli" inspect --format \'{{.State.Status}}\' "$sandbox_container" 2>/dev/null |',
    "    grep -q -i running",
    "}",
    "sandbox_id() {",
    '  "$sandbox_cli" inspect --format \'{{.Id}}\' "$sandbox_container" 2>/dev/null',
    "}",
  ],
  ttyShell: 'if [ -n "$_tty" ]; then _tty_flags="-i -t"; else _tty_flags=-i; fi',
  // Its client logs a warning to stderr whenever a command exits while input is still attached.
  clientEnv: "RUST_LOG=error ",
});
