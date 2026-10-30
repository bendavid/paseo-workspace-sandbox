import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { SandboxRecordSchema, type SandboxRecord } from "../shared/rpc";

const StateFileSchema = z.object({
  version: z.literal(1),
  sandboxes: z.array(SandboxRecordSchema),
  // Sandboxed provider profile ID -> the provider it was derived from.
  profiles: z.record(z.string(), z.string()).default({}),
  // Workspaces whose sandbox was removed, so their sandboxed agents never fall back to the host.
  retired: z.array(z.string()).default([]),
});

// $PASEO_HOME/plugin-data/<plugin id>/ is where Paseo plugins keep their own data; Paseo never
// touches plugin-data/. Following the daemon's PASEO_HOME resolution keeps dev and production
// daemons apart. The plugin cannot read its runtime ID, so the directory uses the manifest ID.
export function resolveDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PASEO_HOME?.trim() || "~/.paseo";
  const expanded = raw === "~" || raw.startsWith("~/") ? path.join(homedir(), raw.slice(1)) : raw;
  return path.join(path.resolve(expanded), "plugin-data", "workspace-sandbox");
}

/** The environment `sandbox-run` captures from the container's login shell; it derives the same path. */
export function environmentFile(specFile: string): string {
  return specFile.replace(/\.sh$/, ".env");
}

export async function writeFileAtomic(file: string, content: string, mode = 0o644): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { mode });
  await rename(temporary, file);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export class SandboxStore {
  private readonly records = new Map<string, SandboxRecord>();
  private readonly profiles = new Map<string, string>();
  private readonly retired = new Set<string>();
  private readonly file: string;

  constructor(readonly directory: string) {
    this.file = path.join(directory, "state.json");
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const state = StateFileSchema.parse(JSON.parse(raw));
    this.records.clear();
    for (const record of state.sandboxes) this.records.set(record.workspaceId, record);
    this.profiles.clear();
    for (const [profile, base] of Object.entries(state.profiles)) this.profiles.set(profile, base);
    this.retired.clear();
    for (const workspaceId of state.retired) this.retired.add(workspaceId);
  }

  list(): SandboxRecord[] {
    return [...this.records.values()];
  }

  get(workspaceId: string): SandboxRecord | null {
    return this.records.get(workspaceId) ?? null;
  }

  /** The sandbox whose workspace directory contains `cwd`, preferring the deepest match. */
  findByCwd(cwd: string): SandboxRecord | null {
    let best: SandboxRecord | null = null;
    for (const record of this.records.values()) {
      if (record.pending || !isWithin(record.cwd, path.resolve(cwd))) continue;
      if (!best || record.cwd.length > best.cwd.length) best = record;
    }
    return best;
  }

  async put(record: SandboxRecord): Promise<void> {
    this.records.set(record.workspaceId, record);
    await this.save();
  }

  async remove(workspaceId: string): Promise<SandboxRecord | null> {
    const record = this.records.get(workspaceId) ?? null;
    if (!record) return null;
    this.records.delete(workspaceId);
    // A pending record's workspace was never created.
    if (!record.pending) this.retired.add(workspaceId);
    await this.save();
    await rm(this.specFile(workspaceId), { force: true });
    await rm(environmentFile(this.specFile(workspaceId)), { force: true });
    return record;
  }

  /**
   * Whether the workspace had a sandbox that is gone, such as an archived workspace. Its private
   * Claude folder outlives the sandbox and counts too, for sandboxes removed before the plugin
   * recorded removals.
   */
  wasSandboxed(workspaceId: string): boolean {
    return this.retired.has(workspaceId) || existsSync(this.claudeHomeDir(workspaceId));
  }

  /** The provider a sandboxed profile was derived from, or null when the plugin does not own it. */
  profileBase(profile: string): string | null {
    return this.profiles.get(profile) ?? null;
  }

  async putProfile(profile: string, base: string): Promise<void> {
    if (this.profiles.get(profile) === base) return;
    this.profiles.set(profile, base);
    await this.save();
  }

  specFile(workspaceId: string): string {
    return path.join(this.directory, "workspaces", `${workspaceId}.sh`);
  }

  /**
   * A workspace's private Claude config folder. It outlives the sandbox: the daemon reads an
   * archived workspace's transcripts from it.
   */
  claudeHomeDir(workspaceId: string): string {
    return path.join(this.directory, "homes", workspaceId, "claude");
  }

  /** The host's current Claude access token and the helper that prints it. */
  get authDirectory(): string {
    return path.join(this.directory, "auth");
  }

  private async save(): Promise<void> {
    const state = {
      version: 1 as const,
      sandboxes: this.list(),
      profiles: Object.fromEntries(this.profiles),
      retired: [...this.retired],
    };
    await writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`);
  }
}
