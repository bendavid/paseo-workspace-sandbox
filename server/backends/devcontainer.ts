import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ContainerStatus, ImageDownload } from "../../shared/rpc";
import {
  PROVIDER_LINKS_SCRIPT,
  agentStateMounts,
  baseEnvironment,
  sharedProviderDirectories,
  runCli,
  shellQuote,
  workspaceLayout,
  type ContainerPolicy,
  type ContainerTarget,
  type Mount,
} from "../container";
import { resolveDataDirectory } from "../store";
import { commandArguments, type SandboxBackend } from "./types";

/**
 * Dev containers, through the devcontainer CLI: the workspace's own devcontainer.json describes the
 * sandbox, and `devcontainer up` builds and starts it with Docker or Podman. The plugin adds its
 * mounts and environment through an override copy of that configuration, since the CLI's own
 * `--mount` has no read-only form; launches join the container with `exec`, as for Podman.
 */

/** What `read-configuration` reports: the parsed configuration, variables substituted. */
interface DevcontainerConfiguration {
  configuration: Record<string, unknown> & { configFilePath?: { fsPath?: string } };
  workspace?: { workspaceFolder?: string; workspaceMount?: string };
}

/**
 * What `devcontainer up` reported, for launches: whom to run as, where, and the configuration's
 * remoteEnv, its container references resolved; null unsets a variable.
 */
interface UpState {
  remoteUser: string;
  remoteWorkspaceFolder: string;
  remoteEnv?: Record<string, string | null>;
  /** How the launcher captures the environment, as userEnvProbe says. */
  userEnvProbe?: string;
}

const ENV_PROBES = ["none", "loginShell", "loginInteractiveShell", "interactiveShell"];

function stateDirectory(target: ContainerTarget): string {
  return path.join(resolveDataDirectory(), "devcontainers", target.container);
}

function overrideFile(target: ContainerTarget): string {
  return path.join(stateDirectory(target), "config", "devcontainer.json");
}

function stateFile(target: ContainerTarget): string {
  return path.join(stateDirectory(target), "up.json");
}

function remoteEnvFile(target: ContainerTarget): string {
  return path.join(stateDirectory(target), "remote.env");
}

/** remoteEnv's values, one NAME=VALUE line each; a value spanning lines can't be passed. */
async function writeRemoteEnv(
  target: ContainerTarget,
  remoteEnv: Record<string, string | null>,
): Promise<void> {
  const lines = Object.entries(remoteEnv)
    .filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0]) &&
        !entry[1].includes("\n"),
    )
    .map(([name, value]) => `${name}=${value}\n`);
  await writeFile(remoteEnvFile(target), lines.join(""), { mode: 0o600 });
}

/** The folder the CLI reads the configuration from: a sandboxed directory's project itself. */
function workspaceFolder(target: ContainerTarget): string {
  return target.linkedDirectory ?? target.workspace;
}

function containerCli(policy: ContainerPolicy): string {
  if (!policy.containerCli) throw new Error("Dev containers need a Docker or Podman command");
  return policy.containerCli;
}

/** The CLI prints log lines, then its result as the last JSON line. */
function lastJson(output: string): Record<string, unknown> {
  const line = output.trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new Error(`The devcontainer CLI printed no result: ${line.slice(0, 200)}`);
  }
}

async function readConfiguration(
  target: ContainerTarget,
  policy: ContainerPolicy,
): Promise<DevcontainerConfiguration> {
  const output = await runCli(policy.cli, [
    "read-configuration",
    "--workspace-folder",
    workspaceFolder(target),
    "--docker-path",
    containerCli(policy),
    "--mount-git-worktree-common-dir",
    "--log-format",
    "json",
  ]);
  const result = lastJson(output) as unknown as DevcontainerConfiguration;
  if (!result.configuration) throw new Error("The devcontainer CLI returned no configuration");
  // Compose projects start several containers and networks the plugin would not track.
  if ("dockerComposeFile" in result.configuration) {
    throw new Error("Docker Compose dev containers are not supported");
  }
  return result;
}

async function findContainer(
  target: ContainerTarget,
  policy: ContainerPolicy,
): Promise<{ id: string; running: boolean } | null> {
  const output = await runCli(containerCli(policy), [
    "ps",
    "-a",
    "--filter",
    `label=paseo.workspace-sandbox.${target.label}`,
    "--format",
    "{{.ID}} {{.State}}",
  ]);
  const [line] = output.trim().split("\n").filter(Boolean);
  if (!line) return null;
  const [id = "", state = ""] = line.split(" ");
  return { id, running: /running/i.test(state) };
}

function describe(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * The git metadata mounts that keep hooks, config, and the other worktrees' entries read-only, at
 * the paths the CLI gives a worktree with `--mount-git-worktree-common-dir`. The CLI mounts the
 * worktree and the git directory itself. None when the configuration places the workspace
 * elsewhere.
 */
async function gitMounts(
  target: ContainerTarget,
  config: DevcontainerConfiguration,
): Promise<Mount[] | null> {
  if (target.linkedDirectory) return [];
  const layout = await workspaceLayout({ ...target, sandboxFolder: "/workspaces" });
  if (config.workspace?.workspaceFolder !== layout.workdir) return null;
  return layout.mounts.filter(
    (mount) => mount.path !== layout.workdir && mount.path !== layout.gitCommon,
  );
}

/** What creating the container does, in the order it happens, for the user to agree to. */
function consentDetails(config: DevcontainerConfiguration, git: Mount[] | null): string[] {
  const c = config.configuration;
  const details: string[] = [];
  if (c.initializeCommand !== undefined) {
    details.push(`Runs on this host, outside any sandbox: ${describe(c.initializeCommand)}`);
  }
  if (typeof c.image === "string")
    details.push(`Uses the image ${c.image}, downloading it if needed`);
  const build = (c.build ?? (c.dockerFile ? { dockerfile: c.dockerFile } : null)) as {
    dockerfile?: string;
  } | null;
  if (build?.dockerfile) details.push(`Builds ${build.dockerfile}, which can download`);
  const features = c.features && typeof c.features === "object" ? Object.keys(c.features) : [];
  if (features.length > 0) details.push(`Downloads and adds features: ${features.join(", ")}`);
  for (const mount of Array.isArray(c.mounts) ? c.mounts : []) {
    details.push(`Mounts ${describe(mount)}`);
  }
  if (Array.isArray(c.runArgs) && c.runArgs.length > 0) {
    details.push(`Passes ${c.runArgs.map(describe).join(" ")} to the container engine`);
  }
  if (c.privileged === true) details.push("Runs the container privileged");
  if (Array.isArray(c.capAdd) && c.capAdd.length > 0) {
    details.push(`Adds capabilities: ${c.capAdd.map(describe).join(", ")}`);
  }
  if (Array.isArray(c.securityOpt) && c.securityOpt.length > 0) {
    details.push(`Sets security options: ${c.securityOpt.map(describe).join(", ")}`);
  }
  if (c.appPort !== undefined) details.push(`Publishes ports: ${describe(c.appPort)}`);
  if (git === null) {
    details.push(
      "Places the workspace itself, so its Git hooks and config are writable in the container",
    );
  }
  return details;
}

/**
 * The workspace's configuration with the plugin's mounts and environment added. A `.devcontainer`
 * folder is copied whole, so files beside devcontainer.json (Dockerfile, local features, lock
 * file) resolve as they do there; the build context stays the workspace's.
 */
async function writeOverride(
  target: ContainerTarget,
  config: DevcontainerConfiguration,
  mounts: Mount[],
  environment: Array<[string, string]>,
): Promise<void> {
  const configFile = config.configuration.configFilePath?.fsPath;
  if (!configFile) throw new Error("The devcontainer CLI did not say where the configuration is");
  const configDirectory = path.dirname(configFile);
  const copy = path.dirname(overrideFile(target));
  await rm(copy, { recursive: true, force: true });
  if (configDirectory.split(path.sep).includes(".devcontainer")) {
    await cp(configDirectory, copy, { recursive: true });
  } else {
    await mkdir(copy, { recursive: true });
  }
  const { configFilePath: _path, ...configuration } = config.configuration;
  const override: Record<string, unknown> = { ...configuration };
  const build = configuration.build as { dockerfile?: string; context?: string } | undefined;
  if (build && typeof build === "object") {
    override.build = {
      ...build,
      ...(build.dockerfile ? { dockerfile: path.resolve(configDirectory, build.dockerfile) } : {}),
      context: path.resolve(configDirectory, build.context ?? "."),
    };
  }
  if (typeof configuration.dockerFile === "string") {
    override.dockerFile = path.resolve(configDirectory, configuration.dockerFile);
    override.context = path.resolve(
      configDirectory,
      typeof configuration.context === "string" ? configuration.context : ".",
    );
  }
  override.mounts = [
    ...(Array.isArray(configuration.mounts) ? configuration.mounts : []),
    ...mounts.map(
      (mount) =>
        `type=bind,source=${mount.source ?? mount.path},target=${mount.path}${mount.readOnly ? ",readonly" : ""}`,
    ),
  ];
  override.containerEnv = {
    ...(configuration.containerEnv && typeof configuration.containerEnv === "object"
      ? configuration.containerEnv
      : {}),
    ...Object.fromEntries(environment),
  };
  await writeFile(overrideFile(target), `${JSON.stringify(override, null, 2)}\n`);
}

async function readState(target: ContainerTarget): Promise<UpState | null> {
  try {
    return JSON.parse(await readFile(stateFile(target), "utf8")) as UpState;
  } catch {
    return null;
  }
}

export const devcontainerBackend: SandboxBackend = {
  persistent: true,

  async creationConsent(target, policy): Promise<ImageDownload | null> {
    if (await findContainer(target, policy)) return null;
    const config = await readConfiguration(target, policy);
    return {
      image: config.configuration.configFilePath?.fsPath ?? workspaceFolder(target),
      reason: "devcontainer",
      details: consentDetails(config, await gitMounts(target, config)),
    };
  },

  async workspaceFolder(target) {
    return (await readState(target))?.remoteWorkspaceFolder ?? null;
  },

  // An existing container restarts as it is: `devcontainer up` would run initializeCommand on the
  // host again, which the user agreed to only when the container was created.
  async start(target, policy) {
    const existing = await findContainer(target, policy);
    if (existing?.running) return;
    if (existing) {
      await runCli(containerCli(policy), ["start", existing.id]);
      return;
    }
    const config = await readConfiguration(target, policy);
    const mounts = [
      ...agentStateMounts(target, policy),
      ...((await gitMounts(target, config)) ?? []),
    ];
    await writeOverride(target, config, mounts, baseEnvironment(target, false));
    const line = await this.commandLine(target, policy, [], []);
    const result = lastJson(await runCli(policy.cli, commandArguments(line), { long: true }));
    if (result.outcome !== "success") {
      throw new Error(describe(result.message ?? result.description ?? "devcontainer up failed"));
    }
    const merged = result.mergedConfiguration as
      { remoteEnv?: unknown; userEnvProbe?: unknown } | undefined;
    const remoteEnv =
      merged?.remoteEnv && typeof merged.remoteEnv === "object"
        ? (merged.remoteEnv as Record<string, string | null>)
        : {};
    const state: UpState = {
      remoteUser: String(result.remoteUser ?? ""),
      remoteWorkspaceFolder: String(result.remoteWorkspaceFolder ?? ""),
      remoteEnv,
      // The CLI's own default when the configuration names none.
      userEnvProbe:
        typeof merged?.userEnvProbe === "string" && ENV_PROBES.includes(merged.userEnvProbe)
          ? merged.userEnvProbe
          : "loginInteractiveShell",
    };
    await writeFile(stateFile(target), `${JSON.stringify(state)}\n`);
    await writeRemoteEnv(target, remoteEnv);
    // The configuration's user has its own home; link the agents' folders there.
    const directories = sharedProviderDirectories(policy);
    if (directories.length > 0 && result.containerId) {
      await runCli(containerCli(policy), [
        "exec",
        ...(state.remoteUser ? ["-u", state.remoteUser] : []),
        String(result.containerId),
        "sh",
        "-c",
        PROVIDER_LINKS_SCRIPT,
        "sh",
        ...directories,
      ]).catch((error: unknown) =>
        console.error(`Linking the agents' folders in ${target.container} failed`, error),
      );
    }
  },

  async commandLine(target, policy) {
    return {
      head: ["up"],
      options: [
        "--workspace-folder",
        workspaceFolder(target),
        "--docker-path",
        containerCli(policy),
        "--id-label",
        `paseo.workspace-sandbox.${target.label}`,
        "--override-config",
        overrideFile(target),
        "--mount-git-worktree-common-dir",
        // For remoteEnv, with its references to the container's variables resolved.
        "--include-merged-configuration",
        "--log-format",
        "json",
      ],
      tail: [],
    };
  },

  async status(target, policy): Promise<ContainerStatus> {
    const existing = await findContainer(target, policy).catch(() => null);
    if (!existing) return { state: "missing" };
    return existing.running ? { state: "running" } : { state: "stopped" };
  },

  async stop(target, policy) {
    const existing = await findContainer(target, policy);
    if (existing?.running)
      await runCli(containerCli(policy), ["stop", existing.id], { long: true });
  },

  async remove(target, policy) {
    const existing = await findContainer(target, policy);
    if (existing) await runCli(containerCli(policy), ["rm", "-f", existing.id]);
    await rm(stateDirectory(target), { recursive: true, force: true });
  },

  async runOnce() {
    throw new Error("Dev containers run commands only in the workspace's own container");
  },

  async spec(target, policy) {
    const state = await readState(target);
    const unset = Object.entries(state?.remoteEnv ?? {})
      .filter(([name, value]) => value === null && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      .map(([name]) => name);
    return [
      `sandbox_cli=${shellQuote(containerCli(policy))}`,
      // remoteEnv, applied over the captured login shell environment; see the launcher.
      ...(state ? [`sandbox_env_file=${shellQuote(remoteEnvFile(target))}`] : []),
      ...(unset.length > 0 ? [`sandbox_env_unset=${shellQuote(unset.join("|"))}`] : []),
      `sandbox_env_probe=${state?.userEnvProbe ?? "loginInteractiveShell"}`,
      `sandbox_label=${shellQuote(`label=paseo.workspace-sandbox.${target.label}`)}`,
      `sandbox_user=${shellQuote(state?.remoteUser ?? "")}`,
      "sandbox_tracks_pid=1",
      "sandbox_container() {",
      '  "$sandbox_cli" ps -q --filter "$sandbox_label" --filter status=running 2>/dev/null | head -n 1',
      "}",
      'sandbox_ready() { [ -n "$(sandbox_container)" ]; }',
      "sandbox_id() { sandbox_container; }",
      "# sandbox_exec ENV_FILE TTY WORKDIR -- COMMAND...",
      "sandbox_exec() {",
      "  _env=$1 _tty=$2 _dir=$3",
      "  shift 4",
      '  "$sandbox_cli" exec -i ${_tty:+-t} ${_env:+--env-file} ${_env:+"$_env"} \\',
      '    ${sandbox_user:+-u} ${sandbox_user:+"$sandbox_user"} -w "$_dir" "$(sandbox_container)" "$@"',
      "}",
      "sandbox_signal() {",
      '  "$sandbox_cli" exec "$(sandbox_container)" sh -c \'kill -s "$1" "$(cat "$0")" 2>/dev/null\' "$2" "$1"',
      "}",
      "sandbox_cleanup() {",
      '  "$sandbox_cli" exec "$(sandbox_container)" rm -f "$1"',
      "}",
    ].join("\n");
  },
};
