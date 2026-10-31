// Changing a sandbox's settings stops what runs with the old ones: all of the workspace's terminals
// are closed, and its live agents resumed once the sandbox runs again. A real Bubblewrap sandbox
// behind the service; Paseo is a recording stand-in.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { resolveEngineCli } from "../../server/backends/index";
import type { ClaudeLoginKeeper } from "../../server/claude-login";
import { ContainerProfiles } from "../../server/container-profiles";
import type { PaseoApi } from "../../server/paseo";
import { SandboxService } from "../../server/service";
import { SandboxStore } from "../../server/store";
import { writeWrapper } from "../../server/wrapper";
import type { ContainerProfile, SandboxRecord } from "../../shared/rpc";

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const bwrap = await resolveEngineCli("bubblewrap").catch(() => null);

test.skipIf(!bwrap)(
  "recreating with other settings closes the workspace's terminals and resumes its agents",
  async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "sandbox-dependents-")));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    await rm(workspace, { force: true });
    await import("node:fs/promises").then((fs) => fs.mkdir(workspace));
    const store = new SandboxStore(path.join(root, "data"));
    await store.load();
    const profiles = new ContainerProfiles(path.join(root, "data"));
    await profiles.load();
    const login = {
      hostConfigDir: path.join(root, "claude"),
      directory: path.join(root, "auth"),
      helperCommand: "true",
      state: () => ({ state: "signed-out", message: "" }),
    } as unknown as ClaudeLoginKeeper;
    const wrapper = await writeWrapper(path.join(root, "data"));
    const service = new SandboxService(store, profiles, login, wrapper);

    const profile: ContainerProfile = {
      id: "p",
      name: "Bubblewrap",
      engine: "bubblewrap",
      image: "",
      network: "none",
      extraMounts: "",
      extraRunArgs: "",
      agentState: "off",
    };
    const record: SandboxRecord = {
      workspaceId: "wks_e2e",
      projectId: "proj",
      cwd: workspace,
      container: "paseo-sandbox-wks_e2e",
      createdAt: new Date().toISOString(),
      profile,
      claudeHome: "none",
    };
    await store.put(record);

    const calls: string[] = [];
    const paseo = {
      agents: {
        list: async () => ({
          entries: [
            { agent: { id: "a1", workspaceId: "wks_e2e", title: "Agent", status: "idle" } },
            { agent: { id: "a2", workspaceId: "wks_other", title: "Elsewhere", status: "idle" } },
          ],
          pageInfo: { nextCursor: null },
        }),
        ref: (id: string) => ({
          reload: async () => {
            calls.push(`reload ${id}`);
            return null;
          },
        }),
      },
      terminals: {
        // A sandboxed terminal and one on the host, such as a script's.
        list: async () => ({
          entries: [
            { id: "t1", workspaceId: "wks_e2e", cwd: workspace, name: "Sandboxed terminal" },
            { id: "t2", workspaceId: "wks_e2e", cwd: workspace, name: "dev" },
          ],
        }),
        ref: (id: string) => ({
          kill: async () => {
            calls.push(`kill ${id}`);
          },
        }),
        create: async (options: { name: string }) => {
          calls.push(`create ${options.name}`);
          return { current: () => ({ id: "t3" }) };
        },
      },
    } as unknown as PaseoApi;

    // What the panel warns about.
    expect(await service.dependents("wks_e2e", paseo)).toEqual({
      agents: [{ id: "a1", title: "Agent", status: "idle" }],
      terminals: [
        { id: "t1", name: "Sandboxed terminal" },
        { id: "t2", name: "dev" },
      ],
    });

    await service.recreate("wks_e2e", { ...profile, loginEnvironment: false }, paseo);
    await expect.poll(() => calls.length, { timeout: 30_000 }).toBe(3);
    // All terminals closed before the sandbox changes, none reopened; the agent resumed after it
    // runs again.
    expect(calls).toEqual(["kill t1", "kill t2", "reload a1"]);
    expect(store.get("wks_e2e")).toMatchObject({ profile: { loginEnvironment: false } });
    // Bubblewrap keeps no sandbox to restart.
    await expect(service.restart("wks_e2e", paseo)).rejects.toThrow(/nothing to restart/);
  },
);
