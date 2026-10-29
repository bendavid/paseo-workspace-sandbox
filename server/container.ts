import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { execCommand } from "@getpaseo/plugin/server";
import type { ContainerStatus, SandboxRecord } from "../shared/rpc";

export interface ContainerPolicy {
  /** Absolute path of the docker-compatible CLI. */
  cli: string;
  network: "host" | "bridge" | "none";
  extraMounts: string;
  extraRunArgs: string;
}

interface Mount {
  /** Where the container sees it. */
  path: string;
  /** The host path, when it differs from `path`. */
  source?: string;
  readOnly: boolean;
}

/**
 * The Claude config folder a container uses. A private one belongs to the workspace and signs in
 * through `apiKeyHelper` with the token file in `authDir`; a shared one is the host's folder.
 */
export type ClaudeHome =
  /** No Claude folder: the container that checks what the user's own mounts expose. */
  | { mode: "none" }
  | { mode: "shared"; configDir: string }
  | {
      mode: "private";
      configDir: string;
      hostConfigDir: string;
      authDir: string;
    };

/**
 * The host's Claude configuration a private config folder reads, mounted read-only over the
 * matching entry. The plugin mounts nothing else from the host folder (transcripts, prompt history,
 * file history, credentials); only an extra mount the user adds can show it.
 */
export const SHARED_CLAUDE_ENTRIES = [
  { name: "CLAUDE.md", kind: "file" },
  { name: "agents", kind: "directory" },
  { name: "commands", kind: "directory" },
  { name: "skills", kind: "directory" },
  { name: "output-styles", kind: "directory" },
] as const;

// Keeps the container alive without depending on `sleep infinity`, which busybox lacks.
const KEEPALIVE = 'trap "exit 0" TERM; while :; do sleep 3600 & wait $!; done';

export function containerName(workspaceId: string): string {
  return `paseo-sandbox-${workspaceId.replace(/[^A-Za-z0-9_.-]/g, "-")}`;
}

async function which(command: string): Promise<string | null> {
  const { stdout } = await execCommand("sh", ["-c", 'command -v "$1" || true', "sh", command]);
  return stdout.trim() || null;
}

export async function resolveCli(command: string): Promise<string> {
  const resolved = path.isAbsolute(command) ? command : await which(command);
  if (!resolved) throw new Error(`Container CLI "${command}" was not found on PATH`);
  // podman-docker's `docker` prints a notice on every call, which would land in sandboxed
  // terminals. Call podman itself when that is what `docker` runs.
  if (path.basename(resolved) === "docker" && (await isPodman(resolved))) {
    return (await which("podman")) ?? resolved;
  }
  return resolved;
}

async function isPodman(cli: string): Promise<boolean> {
  const { stdout } = await execCommand(cli, ["--version"]);
  return /podman/i.test(stdout);
}

async function gitCommonDirectory(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execCommand("git", [
      "-C",
      cwd,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export function parseExtraMounts(value: string): Mount[] {
  return value
    .split(/\r?\n|,/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const readOnly = line.endsWith(":ro");
      const raw = readOnly ? line.slice(0, -3) : line;
      const expanded =
        raw === "~" || raw.startsWith("~/") ? path.join(homedir(), raw.slice(1)) : raw;
      return { path: path.resolve(expanded), readOnly };
    });
}

/** A workspace's sandbox container. */
export interface ContainerTarget {
  container: string;
  /** `paseo.workspace-sandbox.<key>=<value>`, so every plugin container can be found. */
  label: string;
  image: string;
  /** Mounted read-write with its git metadata. */
  workspace: string;
  workdir: string;
  claude: ClaudeHome;
}

export function workspaceTarget(record: SandboxRecord, claude: ClaudeHome): ContainerTarget {
  return {
    container: record.container,
    label: `workspace=${record.workspaceId}`,
    image: record.image,
    workspace: record.cwd,
    workdir: record.cwd,
    claude,
  };
}

/**
 * Earlier versions answered model discovery from this container, one per data directory. It is
 * removed when the plugin starts.
 */
export function legacyProbeContainerName(dataDirectory: string): string {
  const digest = createHash("sha256").update(dataDirectory).digest("hex").slice(0, 10);
  return `paseo-sandbox-probe-${digest}`;
}

async function workspaceMounts(cwd: string): Promise<Mount[]> {
  const mounts: Mount[] = [{ path: cwd, readOnly: false }];
  const commonDir = await gitCommonDirectory(cwd);
  if (commonDir) {
    // A worktree's objects and refs live in the source checkout's .git, so commits need it
    // writable. Hooks and config run on the host whenever git runs there, so keep them read-only.
    if (!commonDir.startsWith(`${cwd}${path.sep}`))
      mounts.push({ path: commonDir, readOnly: false });
    const hooks = path.join(commonDir, "hooks");
    await mkdir(hooks, { recursive: true });
    mounts.push({ path: hooks, readOnly: true });
    const config = path.join(commonDir, "config");
    if (existsSync(config)) mounts.push({ path: config, readOnly: true });
  }
  return mounts;
}

/**
 * The CLI refuses two mounts at one destination, but it mounts parents before children whatever
 * the order, so extra mounts may contain the plugin's: `~:ro` keeps the workspace read-write.
 * At the same path the plugin's mount wins, keeping the workspace writable and git hooks and
 * config read-only; between extra mounts, read-only wins.
 */
function addExtraMounts(mounts: Mount[], extra: readonly Mount[]): Mount[] {
  const owned = new Set(mounts.map((mount) => mount.path));
  const merged = new Map<string, Mount>();
  for (const mount of extra) {
    if (owned.has(mount.path)) continue;
    const previous = merged.get(mount.path);
    merged.set(mount.path, { path: mount.path, readOnly: mount.readOnly || !!previous?.readOnly });
  }
  return [...mounts, ...merged.values()];
}

/**
 * A private folder gets the host's shared Claude configuration read-only, the token file, and the
 * host's plugins as a read-only seed. An extra mount that shows the host folder read-only stays as
 * the user set it.
 */
function claudeMounts(claude: ClaudeHome): Mount[] {
  if (claude.mode === "none") return [];
  if (claude.mode === "shared") {
    return existsSync(claude.configDir) ? [{ path: claude.configDir, readOnly: false }] : [];
  }
  const mounts: Mount[] = [
    { path: claude.configDir, readOnly: false },
    { path: claude.authDir, readOnly: true },
  ];
  for (const entry of SHARED_CLAUDE_ENTRIES) {
    const source = path.join(claude.hostConfigDir, entry.name);
    const target = path.join(claude.configDir, entry.name);
    if (existsSync(source) && existsSync(target)) {
      mounts.push({ path: target, source, readOnly: true });
    }
  }
  const plugins = path.join(claude.hostConfigDir, "plugins");
  if (existsSync(plugins)) mounts.push({ path: plugins, readOnly: true });
  return mounts;
}

async function resolveMounts(target: ContainerTarget, policy: ContainerPolicy): Promise<Mount[]> {
  const extra = parseExtraMounts(policy.extraMounts);
  const mounts = await workspaceMounts(target.workspace);
  mounts.push(...claudeMounts(target.claude));
  // Agent credentials and session state for the providers the wrapper can launch. The daemon reads
  // history from these directories on the host, so sessions must be written to the same place.
  // Custom ACP agents keep state elsewhere; add it under extra mounts.
  for (const owned of [".codex", ".copilot", ".pi", ".omp"]) {
    const directory = path.join(homedir(), owned);
    if (existsSync(directory)) mounts.push({ path: directory, readOnly: false });
  }
  for (const mount of extra) {
    if (!existsSync(mount.path)) throw new Error(`Extra mount ${mount.path} does not exist`);
  }
  return addExtraMounts(mounts, extra);
}

/** Everything between `run` and the image, shared by the sandbox and its Claude folder check. */
async function containerOptions(
  target: ContainerTarget,
  policy: ContainerPolicy,
): Promise<string[]> {
  const home = homedir();
  const user = userInfo();
  const identity = (await isPodman(policy.cli))
    ? ["--userns=keep-id"]
    : ["--user", `${user.uid}:${user.gid}`];
  const mounts = (await resolveMounts(target, policy)).flatMap((mount) => [
    "-v",
    `${mount.source ?? mount.path}:${mount.path}${mount.readOnly ? ":ro" : ""}`,
  ]);
  const { claude } = target;
  const plugins = claude.mode === "private" ? path.join(claude.hostConfigDir, "plugins") : null;
  return [
    "--network",
    policy.network,
    ...identity,
    "--workdir",
    target.workdir,
    // HOME keeps the host path so mounted credentials resolve. Unless an extra mount covers it, the
    // engine creates it root-owned as the parent of those mounts, so only they are writable.
    "-e",
    `HOME=${home}`,
    "-e",
    `USER=${user.username}`,
    // Keeps Claude's .claude.json inside the mounted directory instead of a bind-mounted file,
    // which Claude replaces by rename.
    ...(claude.mode === "none" ? [] : ["-e", `CLAUDE_CONFIG_DIR=${claude.configDir}`]),
    // A private folder installs nothing itself: Claude Code reads the host's plugins as a seed.
    ...(plugins && existsSync(plugins) ? ["-e", `CLAUDE_CODE_PLUGIN_SEED_DIR=${plugins}`] : []),
    ...mounts,
    ...policy.extraRunArgs.split(/\s+/).filter(Boolean),
  ];
}

export async function buildRunArgs(
  target: ContainerTarget,
  policy: ContainerPolicy,
): Promise<string[]> {
  return [
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
  ];
}

// Prints how the host's Claude folder appears in the container. The device and inode tell the
// host folder apart from one the image, a named volume, or a tmpfs puts at the same path; creating
// a file tests writes through read-only mounts, permissions, and user-namespace mapping alike.
const CLAUDE_FOLDER_CHECK = [
  "dir=$1; expected=$2",
  '[ -d "$dir" ] || { echo absent; exit 0; }',
  'id=$(stat -c %d:%i "$dir" 2>/dev/null) || { echo unknown; exit 0; }',
  '[ "$id" = "$expected" ] || { echo other; exit 0; }',
  'probe="$dir/.paseo-sandbox-write-check-$$"',
  'if (umask 077; : > "$probe") 2>/dev/null; then rm -f "$probe"; echo writable; else echo read-only; fi',
].join("\n");

export type ClaudeFolderAccess = "writable" | "read-only" | "other" | "absent" | "unknown";

/**
 * Runs the sandbox's configuration (image, user mapping, workspace and extra mounts, extra run
 * arguments) without any Claude folder of the plugin's, and reports how the host's Claude folder
 * shows. The first run pulls the image, which the sandbox then reuses.
 */
export async function checkClaudeFolder(
  target: ContainerTarget,
  policy: ContainerPolicy,
  hostConfigDir: string,
): Promise<ClaudeFolderAccess> {
  const info = await stat(hostConfigDir);
  const args = [
    "run",
    "--rm",
    "--label",
    "paseo.workspace-sandbox.check=1",
    ...(await containerOptions({ ...target, claude: { mode: "none" } }, policy)),
    target.image,
    "sh",
    "-c",
    CLAUDE_FOLDER_CHECK,
    "sh",
    hostConfigDir,
    `${info.dev}:${info.ino}`,
  ];
  let stdout: string;
  try {
    ({ stdout } = await execCommand(policy.cli, args, {
      timeout: 15 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (error) {
    throw cliError(error);
  }
  const answer = stdout.trim().split("\n").pop()?.trim();
  return answer === "writable" ||
    answer === "read-only" ||
    answer === "other" ||
    answer === "absent"
    ? answer
    : "unknown";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Sourced by sandbox-run, which only joins a running container: the plugin starts and recreates
 * containers, and waits for them before every agent and terminal launch.
 */
export function renderSpec(input: { cli: string; container: string; workdir: string }): string {
  return [
    `# Generated by the workspace-sandbox plugin.`,
    `sandbox_cli=${shellQuote(input.cli)}`,
    `sandbox_container=${shellQuote(input.container)}`,
    `sandbox_workdir=${shellQuote(input.workdir)}`,
    "",
  ].join("\n");
}

export async function inspectContainer(cli: string, name: string): Promise<ContainerStatus> {
  try {
    const { stdout } = await execCommand(cli, [
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
 * The CLI's last error line, such as an image that cannot be pulled. The full message repeats the
 * whole run command and the pull's retries; it stays available as `cause`.
 */
function cliError(error: unknown): Error {
  const stderr =
    typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : "";
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return error instanceof Error ? error : new Error(String(error));
  return new Error(last.replace(/^Error:\s*/i, ""), { cause: error });
}

export async function startContainer(
  cli: string,
  name: string,
  runArgs: string[],
): Promise<ContainerStatus> {
  const current = await inspectContainer(cli, name);
  if (current.state === "running") return current;
  try {
    if (current.state === "stopped") await execCommand(cli, ["start", name]);
    // The first run may pull the image, so allow far longer than the default exec timeout.
    else await execCommand(cli, runArgs, { timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    throw cliError(error);
  }
  return inspectContainer(cli, name);
}

export async function removeContainer(cli: string, name: string): Promise<void> {
  try {
    await execCommand(cli, ["rm", "-f", name]);
  } catch (error) {
    if ((await inspectContainer(cli, name)).state !== "missing") throw error;
  }
}
