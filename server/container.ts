import { existsSync } from "node:fs";
import { lstat, mkdir, rm, symlink } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { execCommand } from "@getpaseo/plugin/server";
import { type Engine, type SandboxRecord, splitArguments } from "../shared/rpc";

/** An engine, its command, and the parts of a sandbox's profile every engine reads. */
export interface ContainerPolicy {
  engine: Engine;
  /** Absolute path of the engine's command. */
  cli: string;
  network: "host" | "bridge" | "none";
  extraMounts: string;
  extraRunArgs: string;
  /** Your uid, gid, and home inside, or the image's default user and home. */
  runAsHostUser: boolean;
  /** Mount the agents' own folders; see shareAgentState in the profile. */
  shareAgentState: boolean;
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
  /** For a sandboxed directory, the project directory `workspace` links to. */
  linkedDirectory?: string;
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
    ...(record.linkedDirectory ? { linkedDirectory: record.linkedDirectory } : {}),
  };
}

/**
 * A sandboxed directory's folder of mount points, mounted over the folder of links: it holds only
 * this sandbox's own, empty, so the link path is a plain mount point inside the sandbox.
 */
export function linkMountPoints(link: string): string {
  return path.join(path.dirname(path.dirname(link)), "link-mounts", path.basename(link));
}

/** Creates a sandboxed directory's link, replacing a stale one. */
export async function createLink(link: string, directory: string): Promise<void> {
  await mkdir(path.dirname(link), { recursive: true });
  await rm(link, { force: true });
  await symlink(directory, link);
}

/** Removes a sandboxed directory's link and mount points; never what the link points to. */
export async function removeLink(link: string): Promise<void> {
  await rm(link, { force: true });
  await rm(linkMountPoints(link), { recursive: true, force: true });
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

/** The repository's shared git directory and this checkout's own, or null outside git. */
async function gitDirectories(cwd: string): Promise<{ common: string; own: string } | null> {
  try {
    const { stdout } = await execCommand("git", [
      "-C",
      cwd,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
      "--git-dir",
    ]);
    const [common, own] = stdout.trim().split("\n");
    return common && own ? { common, own } : null;
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

/**
 * A sandboxed directory shares the project directory with the host's workspaces by design, so
 * there is no git handling. The agent runs at the link path the daemon knows the workspace by, so
 * the project is mounted there as a directory, and at its real path too, for files that hold it:
 * virtual environments, absolute symlinks, build caches. An extra mount covering the folder of
 * links would show the link there as a symlink, which engines follow at a mount's destination; the
 * sandbox's own folder of mount points, mounted over it, prevents that.
 */
async function linkedDirectoryMounts(link: string, directory: string): Promise<Mount[]> {
  const mountPoints = linkMountPoints(link);
  await mkdir(path.join(mountPoints, path.basename(link)), { recursive: true });
  // Paseo archives a workspace whose directory is gone, but recreate a link removed meanwhile.
  if (!(await lstat(link).catch(() => null))) await createLink(link, directory);
  return [
    { path: path.dirname(link), source: mountPoints, readOnly: true },
    { path: link, source: directory, readOnly: false },
    { path: directory, readOnly: false },
  ];
}

async function workspaceMounts(cwd: string): Promise<Mount[]> {
  const mounts: Mount[] = [{ path: cwd, readOnly: false }];
  const git = await gitDirectories(cwd);
  if (git) {
    const { common: commonDir, own } = git;
    // A worktree's objects and refs live in the source checkout's .git, so commits need it
    // writable. Hooks and config run on the host whenever git runs there, so keep them read-only.
    if (!commonDir.startsWith(`${cwd}${path.sep}`)) {
      mounts.push({ path: commonDir, readOnly: false });
      // The repository's other worktrees are not mounted, so git here sees them as missing and
      // `git worktree prune` would remove them, on the host too. Their entries stay read-only;
      // this worktree's own (HEAD, index, logs) stays writable.
      const worktrees = path.join(commonDir, "worktrees");
      if (own.startsWith(`${worktrees}${path.sep}`)) {
        mounts.push({ path: worktrees, readOnly: true }, { path: own, readOnly: false });
      }
    }
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
  const mounts = target.linkedDirectory
    ? await linkedDirectoryMounts(target.workspace, target.linkedDirectory)
    : await workspaceMounts(target.workspace);
  mounts.push(...claudeMounts(target.claude));
  if (policy.shareAgentState) {
    for (const directory of providerDirectories())
      mounts.push({ path: directory, readOnly: false });
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

/**
 * Agent credentials and session state for the providers the wrapper can launch, mounted at their
 * host paths. The daemon reads history from these directories on the host, so sessions must be
 * written to the same place. Custom ACP agents keep state elsewhere; add it under extra mounts.
 */
export function providerDirectories(): string[] {
  return [".codex", ".copilot", ".pi", ".omp"]
    .map((owned) => path.join(homedir(), owned))
    .filter((directory) => existsSync(directory));
}

/** The environment every engine gives its sandbox, besides what each launch forwards. */
export function baseEnvironment(
  target: ContainerTarget,
  runAsHostUser: boolean,
): Array<[string, string]> {
  const { claude } = target;
  const plugins = claude.mode === "private" ? path.join(claude.hostConfigDir, "plugins") : null;
  return [
    ...(runAsHostUser
      ? [
          // HOME keeps the host path so mounted credentials resolve.
          ["HOME", homedir()] as [string, string],
          ["USER", userInfo().username] as [string, string],
        ]
      : [
          // The image's own user may not own the mounted files, which git otherwise refuses.
          ["GIT_CONFIG_COUNT", "1"] as [string, string],
          ["GIT_CONFIG_KEY_0", "safe.directory"] as [string, string],
          ["GIT_CONFIG_VALUE_0", "*"] as [string, string],
        ]),
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

/** Extra run arguments split into words with shell quoting, as each engine receives them. */
export function extraArguments(policy: ContainerPolicy): string[] {
  return splitArguments(policy.extraRunArgs);
}

/**
 * Run as root inside a sandbox just created to run as you: your uid and gid get your name, group,
 * and home, replacing whatever the image had for them or for those names, so tools that read the
 * account (OpenSSH looks for ~/.ssh there, `whoami`, prompts) agree with HOME. The shell is
 * /bin/sh, which every image has; sandboxed terminals start bash when there is one.
 */
export const HOST_ACCOUNT_SCRIPT = [
  "name=$1 uid=$2 gid=$3 group=$4 home=$5",
  "replace() {",
  "  file=$1 id=$2 key=$3 line=$4",
  '  [ -f "$file" ] || : >"$file"',
  '  awk -F: -v id="$id" -v key="$key" \'$3 != id && $1 != key\' "$file" >"$file.paseo-new"',
  '  printf \'%s\\n\' "$line" >>"$file.paseo-new"',
  '  cat "$file.paseo-new" >"$file" && rm -f "$file.paseo-new"',
  "}",
  'replace /etc/passwd "$uid" "$name" "$name:x:$uid:$gid::$home:/bin/sh"',
  'replace /etc/group "$gid" "$group" "$group:x:$gid:"',
].join("\n");

/**
 * Run as the image's default user inside a sandbox just created to run as that user: links its
 * home's provider folders to the mounted host ones, so the agents find their credentials.
 */
export const PROVIDER_LINKS_SCRIPT = [
  "for directory; do",
  "  link=$HOME/${directory##*/}",
  '  [ -e "$link" ] || [ -L "$link" ] || ln -s "$directory" "$link" 2>/dev/null || true',
  "done",
].join("\n");

/** The host account the host-account script writes: your name, uid, gid, group, and home. */
export async function hostAccount(): Promise<string[]> {
  const user = userInfo();
  const { stdout } = await execCommand("id", ["-gn"]);
  return [
    user.username,
    String(user.uid),
    String(user.gid),
    stdout.trim() || user.username,
    homedir(),
  ];
}
