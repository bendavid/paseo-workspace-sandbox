import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { ContainerProfiles } from "../server/container-profiles";
import {
  DEFAULT_IMAGE,
  profileAgentState,
  profileChangeWarnings,
  profileSandboxFolder,
  profileUser,
  recordAgentState,
} from "../shared/rpc";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function directory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sandbox-profiles-"));
  roots.push(root);
  return root;
}

test("creates a Default profile on first start and keeps at least one", async () => {
  const dir = await directory();
  const store = new ContainerProfiles(dir);
  await store.load();
  const { profiles, defaultId } = store.snapshot();
  expect(defaultId).toBe("default");
  expect(profiles).toEqual([
    expect.objectContaining({ id: "default", name: "Default", image: DEFAULT_IMAGE }),
  ]);
  expect(["podman", "docker"]).toContain(profiles[0]?.engine);
  // A separate network keeps the sandbox off the host's loopback, where the daemon listens.
  expect(profiles[0]?.network).toBe("bridge");

  const large = await store.save(
    {
      name: "Large",
      engine: "podman",
      image: "docker.io/library/img:big",
      network: "bridge",
      extraMounts: "",
      extraRunArgs: "--memory 8g",
    },
    true,
  );
  expect(store.snapshot().defaultId).toBe(large.id);
  await store.save({ ...large, name: "Larger" }, false);
  expect(store.get(large.id).name).toBe("Larger");
  expect(store.snapshot().profiles).toHaveLength(2);

  await store.delete(large.id);
  expect(store.snapshot().defaultId).toBe("default");
  await expect(store.delete("default")).rejects.toThrow(/at least one/);

  const reloaded = new ContainerProfiles(dir);
  await reloaded.load();
  expect(reloaded.snapshot()).toEqual(store.snapshot());
});

test("requires a full image reference for engines that run one", async () => {
  const store = new ContainerProfiles(await directory());
  await store.load();
  const values = { network: "host", extraMounts: "", extraRunArgs: "" } as const;
  await expect(
    store.save({ name: "No image", engine: "docker", image: "", ...values }, false),
  ).rejects.toThrow(/needs an image/);
  await expect(
    store.save({ name: "Short", engine: "podman", image: "node:22", ...values }, false),
  ).rejects.toThrow(/full image reference/);
  const bubblewrap = await store.save(
    { name: "Host system", engine: "bubblewrap", image: "", ...values },
    false,
  );
  expect(store.get(bubblewrap.id).engine).toBe("bubblewrap");
});

test("refuses a network the engine does not have", async () => {
  const store = new ContainerProfiles(await directory());
  await store.load();
  const values = { image: "", extraMounts: "", extraRunArgs: "" };
  await expect(
    store.save({ name: "Separate", engine: "bubblewrap", network: "bridge", ...values }, false),
  ).rejects.toThrow(/no bridge network/);
  await expect(
    store.save(
      { name: "Apptainer", engine: "apptainer", network: "bridge", ...values, image: "/a.sif" },
      false,
    ),
  ).rejects.toThrow(/no bridge network/);
  const none = await store.save(
    { name: "Offline", engine: "apptainer", network: "none", ...values, image: "/a.sif" },
    false,
  );
  expect(store.get(none.id).network).toBe("none");
});

test("rejects extra run arguments with an unclosed quote", async () => {
  const store = new ContainerProfiles(await directory());
  await store.load();
  const profile = {
    name: "Ping",
    engine: "podman",
    image: DEFAULT_IMAGE,
    network: "bridge",
    extraMounts: "",
  } as const;
  await expect(
    store.save({ ...profile, extraRunArgs: '--sysctl "net.ipv4.ping_group_range=0 0' }, false),
  ).rejects.toThrow(/unclosed "/);
  const saved = await store.save(
    { ...profile, extraRunArgs: '--sysctl "net.ipv4.ping_group_range=0 0"' },
    false,
  );
  expect(store.get(saved.id).extraRunArgs).toBe('--sysctl "net.ipv4.ping_group_range=0 0"');
});

test("saves a user mode the engine has, replacing the old Run as host user setting", async () => {
  const store = new ContainerProfiles(await directory());
  await store.load();
  const profile = {
    name: "Squashed",
    engine: "podman",
    image: DEFAULT_IMAGE,
    network: "bridge",
    extraMounts: "",
    extraRunArgs: "",
  } as const;
  expect((await store.save({ ...profile, user: "squashed" }, false)).user).toBe("squashed");
  // A profile from before the choice: false meant the image's default user.
  const legacy = await store.save({ ...profile, runAsHostUser: false }, false);
  expect(legacy).toMatchObject({ user: "image" });
  expect(legacy).not.toHaveProperty("runAsHostUser");
  expect((await store.save({ ...profile }, false)).user).toBe("host");
  await expect(
    store.save({ ...profile, engine: "docker", user: "squashed" }, false),
  ).rejects.toThrow(/docker has no squashed user/);
});

test("reads a sandbox's user mode, including records saved before the choice", () => {
  expect(profileUser({ engine: "podman" })).toBe("host");
  expect(profileUser({ engine: "podman", runAsHostUser: false })).toBe("image");
  expect(profileUser({ engine: "podman", user: "squashed" })).toBe("squashed");
  // Engines without a choice run as you, whatever the record says.
  expect(profileUser({ engine: "bubblewrap", runAsHostUser: false })).toBe("host");
  expect(profileUser({ engine: "docker", user: "squashed" })).toBe("host");
});

test("a dev container profile needs no image, and its devcontainer.json decides the rest", async () => {
  const store = new ContainerProfiles(await directory());
  await store.load();
  const saved = await store.save(
    {
      name: "Dev container",
      engine: "devcontainer",
      image: "",
      network: "bridge",
      extraMounts: "",
      extraRunArgs: "",
      containerCli: "podman",
    },
    false,
  );
  expect(saved).toMatchObject({ engine: "devcontainer", containerCli: "podman", user: "image" });
  // The CLI places the workspace under /workspaces and runs as the configuration's user.
  expect(profileSandboxFolder(saved)).toBe("/workspaces");
  expect(profileUser({ engine: "devcontainer", user: "host" })).toBe("image");
});

test("reads the agent state, including profiles and sandboxes from before the choice", async () => {
  expect(profileAgentState({})).toBe("isolated");
  expect(profileAgentState({ shareAgentState: false })).toBe("off");
  expect(profileAgentState({ agentState: "shared", shareAgentState: false })).toBe("shared");
  // A sandbox whose check found the host's Claude folder writable keeps sharing it.
  expect(recordAgentState({ claudeHome: "shared", profile: {} })).toBe("shared");
  expect(recordAgentState({ claudeHome: "private", profile: {} })).toBe("isolated");
  expect(recordAgentState({ claudeHome: "none", profile: { shareAgentState: false } })).toBe("off");

  const store = new ContainerProfiles(await directory());
  await store.load();
  const saved = await store.save(
    {
      name: "Old",
      engine: "podman",
      image: DEFAULT_IMAGE,
      network: "bridge",
      extraMounts: "",
      extraRunArgs: "",
      shareAgentState: false,
    },
    false,
  );
  expect(saved).toMatchObject({ agentState: "off" });
  expect(saved).not.toHaveProperty("shareAgentState");
});

test("warns what recreating with other settings changes for what already ran", () => {
  const profile = {
    id: "p",
    name: "P",
    engine: "podman",
    image: DEFAULT_IMAGE,
    network: "bridge",
    extraMounts: "",
    extraRunArgs: "",
    agentState: "shared",
  } as const;
  const sandbox = { profile, claudeHome: "shared" } as const;
  expect(profileChangeWarnings(sandbox, { ...profile, network: "none" })).toEqual([]);
  const warnings = profileChangeWarnings(sandbox, {
    ...profile,
    paths: "sandbox",
    agentState: "isolated",
    user: "image",
  });
  expect(warnings).toHaveLength(4);
  expect(warnings[0]).toMatch(
    /^The workspace's path inside the sandbox changes from its host path to a place under \/workspaces:/,
  );
  expect(warnings[1]).toMatch(
    /^Claude moves from your host Claude folder to its private Claude folder/,
  );
  expect(warnings[2]).toMatch(/other agents' folders are no longer mounted/);
  expect(warnings[3]).toMatch(/^The user changes from Host user to Image default user/);
  expect(profileChangeWarnings(sandbox, { ...profile, engine: "bubblewrap" })[0]).toBe(
    "The engine changes from Podman to Bubblewrap",
  );
});
