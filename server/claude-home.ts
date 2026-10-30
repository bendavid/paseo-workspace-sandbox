import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { SHARED_CLAUDE_ENTRIES } from "./container";
import { writeFileAtomic } from "./store";

async function readJsonObject(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Claude Code keeps `.claude.json` in the config folder when CLAUDE_CONFIG_DIR is set and in the
 * home directory otherwise; newer versions also keep it in `~/.claude`.
 */
async function hostClaudeJson(hostConfigDir: string): Promise<Record<string, unknown> | null> {
  return (
    (await readJsonObject(path.join(hostConfigDir, ".claude.json"))) ??
    (await readJsonObject(path.join(homedir(), ".claude.json")))
  );
}

async function isDirectory(file: string): Promise<boolean> {
  return stat(file)
    .then((info) => info.isDirectory())
    .catch(() => false);
}

/**
 * The container engine mounts the shared entries inside a workspace's Claude folder. On NFS it may
 * not act as you, and then needs group search permission on that folder. Its parents stay 0700,
 * so nobody else reaches it.
 */
const FOLDER_MODE = 0o710;

/**
 * Creates or updates a workspace's private Claude config folder.
 *
 * - `.claude.json` is copied once, without its map of every project, so onboarding is done.
 * - `settings.json` is the host's, rewritten on every reconcile, with `apiKeyHelper` added unless
 *   the host sets its own.
 * - Mount points for the shared entries are created here, as you: the container engine would
 *   create missing ones owned by another user.
 */
export async function prepareClaudeHome(input: {
  directory: string;
  hostConfigDir: string;
  helperCommand: string;
}): Promise<void> {
  const { directory, hostConfigDir } = input;
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { recursive: true });
  // Also fixes folders created before with another mode.
  await chmod(directory, FOLDER_MODE);

  const claudeJson = path.join(directory, ".claude.json");
  if (!existsSync(claudeJson)) {
    const { projects: _projects, ...global } = (await hostClaudeJson(hostConfigDir)) ?? {};
    await writeFileAtomic(claudeJson, `${JSON.stringify(global, null, 2)}\n`, 0o600);
  }

  const settings = (await readJsonObject(path.join(hostConfigDir, "settings.json"))) ?? {};
  const env = settings.env;
  if (env !== null && typeof env === "object" && !Array.isArray(env)) {
    const { CLAUDE_CONFIG_DIR: _configDir, ...rest } = env as Record<string, unknown>;
    settings.env = rest;
  }
  if (typeof settings.apiKeyHelper !== "string") settings.apiKeyHelper = input.helperCommand;
  await writeFileAtomic(
    path.join(directory, "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
    0o600,
  );

  for (const entry of SHARED_CLAUDE_ENTRIES) {
    const source = path.join(hostConfigDir, entry.name);
    if (!existsSync(source)) continue;
    const target = path.join(directory, entry.name);
    if (entry.kind === "directory") {
      if (await isDirectory(source)) await mkdir(target, { recursive: true });
    } else if (!existsSync(target)) {
      await writeFile(target, "", { mode: 0o600 });
    }
  }
}
