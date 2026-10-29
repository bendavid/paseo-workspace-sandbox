import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { execCommand } from "@getpaseo/plugin/server";
import type { Engine, SandboxRecord } from "../shared/rpc";

/** An engine, its command, and the parts of a sandbox's profile every engine reads. */
export interface ContainerPolicy {
  engine: Engine;
  /** Absolute path of the engine's command. */
  cli: string;
  network: "host" | "bridge" | "none";
  extraMounts: string;
  extraRunArgs: string;
}

export interface Mount {
  /** Where the sandbox sees it. */
  path: string;
  /** The host path, when it differs from `path`. */
  source?: string;
  readOnly: boolean;
}

/**
 * The Claude config folder a sandbox uses. A private one belongs to the workspace and signs in
 * through `apiKeyHelper` with the token file in `authDir`; a shared one is the host's folder.
 */
export type ClaudeHome =
  /** No Claude folder: the sandbox that checks what the user's own mounts expose. */
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

/** A workspace's sandbox. */
export interface ContainerTarget {
  /** The engine's name for it; Bubblewrap, which keeps no sandbox between launches, ignores it. */
  container: string;
  /** `paseo.workspace-sandbox.<key>=<value>`, so every plugin sandbox can be found. */
  label: string;
  image: string;
  /** Mounted read-write with its git metadata. */
  workspace: string;
  workdir: string;
  claude: ClaudeHome;
}

export function containerName(workspaceId: string): string {
  return `paseo-sandbox-${workspaceId.replace(/[^A-Za-z0-9_.-]/g, "-")}`;
}

export function workspaceTarget(record: SandboxRecord, claude: ClaudeHome): ContainerTarget {
  return {
    container: record.container,
    label: `workspace=${record.workspaceId}`,
    image: record.profile.image,
    workspace: record.cwd,
    workdir: record.cwd,
    claude,
  };
}

export async function which(command: string): Promise<string | null> {
  const { stdout } = await execCommand("sh", ["-c", 'command -v "$1" || true', "sh", command]);
  return stdout.trim() || null;
}

export async function isPodman(cli: string): Promise<boolean> {
  const { stdout } = await execCommand(cli, ["--version"]);
  return /podman/i.test(stdout);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The CLI's last error line, such as an image that cannot be pulled. The full message repeats the
 * whole command and any retries; it stays available as `cause`.
 */
export function cliError(error: unknown): Error {
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

/** Runs an engine command, reporting a failure by the CLI's last error line. */
export async function runCli(
  cli: string,
  args: string[],
  options: { long?: boolean } = {},
): Promise<string> {
  try {
    const { stdout } = await execCommand(cli, args, {
      // A first run may pull an image, so allow far longer than the default exec timeout.
      ...(options.long ? { timeout: 15 * 60_000 } : {}),
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    throw cliError(error);
  }
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
 * Engines refuse two mounts at one destination, and get mounts sorted parents first, so extra
 * mounts may contain the plugin's: `~:ro` keeps the workspace read-write. At the same path the
 * plugin's mount wins, keeping the workspace writable and git hooks and config read-only; between
 * extra mounts, read-only wins.
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

/** Everything a workspace's sandbox mounts, at the same absolute paths as on the host. */
export async function resolveMounts(
  target: ContainerTarget,
  policy: ContainerPolicy,
): Promise<Mount[]> {
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
  // Parents first: Bubblewrap applies mounts in the order given, so a parent listed
  // later would hide its child.
  return addExtraMounts(mounts, extra).toSorted(
    (left, right) => left.path.split("/").length - right.path.split("/").length,
  );
}

/** The environment every engine gives its sandbox, besides what each launch forwards. */
export function baseEnvironment(target: ContainerTarget): Array<[string, string]> {
  const { claude } = target;
  const plugins = claude.mode === "private" ? path.join(claude.hostConfigDir, "plugins") : null;
  return [
    // HOME keeps the host path so mounted credentials resolve.
    ["HOME", homedir()],
    ["USER", userInfo().username],
    // Keeps Claude's .claude.json inside the mounted directory instead of a bind-mounted file,
    // which Claude replaces by rename.
    ...(claude.mode === "none"
      ? []
      : [["CLAUDE_CONFIG_DIR", claude.configDir] as [string, string]]),
    // A private folder installs nothing itself: Claude Code reads the host's plugins as a seed.
    ...(plugins && existsSync(plugins)
      ? [["CLAUDE_CODE_PLUGIN_SEED_DIR", plugins] as [string, string]]
      : []),
  ];
}

/** Extra run arguments split on whitespace, as each engine receives them. */
export function extraArguments(policy: ContainerPolicy): string[] {
  return policy.extraRunArgs.split(/\s+/).filter(Boolean);
}
