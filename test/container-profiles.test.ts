import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { ContainerProfiles } from "../server/container-profiles";
import { DEFAULT_IMAGE } from "../shared/rpc";

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
