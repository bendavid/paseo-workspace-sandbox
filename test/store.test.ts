import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { SandboxStore } from "../server/store";
import type { SandboxRecord } from "../shared/rpc";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function record(workspaceId: string, pending = false): SandboxRecord {
  return {
    workspaceId,
    projectId: "prj_1",
    cwd: "/projects/app",
    container: `paseo-sandbox-${workspaceId}`,
    createdAt: "2026-10-30T00:00:00Z",
    claudeHome: "checking",
    ...(pending ? { pending: true } : {}),
    profile: {
      id: "default",
      name: "Default",
      engine: "bubblewrap",
      image: "",
      network: "host",
      extraMounts: "",
      extraRunArgs: "",
    },
  };
}

test("remembers removed sandboxes across restarts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sandbox-store-"));
  roots.push(root);
  const store = new SandboxStore(root);
  await store.load();
  await store.put(record("wks_archived"));
  await store.put(record("wks_never_created", true));
  expect(store.wasSandboxed("wks_archived")).toBe(false);

  await store.remove("wks_archived");
  await store.remove("wks_never_created");
  expect(store.wasSandboxed("wks_archived")).toBe(true);
  // A pending record's workspace never existed.
  expect(store.wasSandboxed("wks_never_created")).toBe(false);

  const reloaded = new SandboxStore(root);
  await reloaded.load();
  expect(reloaded.wasSandboxed("wks_archived")).toBe(true);
  expect(reloaded.wasSandboxed("wks_unrelated")).toBe(false);
});

test("a private Claude folder shows a workspace was sandboxed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sandbox-store-"));
  roots.push(root);
  const store = new SandboxStore(root);
  await store.load();
  await mkdir(store.claudeHomeDir("wks_older"), { recursive: true });
  expect(store.wasSandboxed("wks_older")).toBe(true);
});
