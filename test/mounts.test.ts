import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { parseExtraMounts, resolveMounts, type ContainerPolicy } from "../server/container";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function policy(extraMounts: string): ContainerPolicy {
  return { engine: "bubblewrap", cli: "bwrap", network: "host", extraMounts, extraRunArgs: "" };
}

test("parses extra mounts one per line or comma separated, with ~ and :ro", () => {
  expect(parseExtraMounts("~/.local:ro, /opt/tools\n\n/srv/data:ro")).toEqual([
    { path: path.join(process.env.HOME ?? "", ".local"), readOnly: true },
    { path: "/opt/tools", readOnly: false },
    { path: "/srv/data", readOnly: true },
  ]);
});

test("keeps the workspace writable under a read-only parent, parents first", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sandbox-mounts-"));
  roots.push(root);
  const workspace = path.join(root, "projects", "app");
  await mkdir(workspace, { recursive: true });
  const target = {
    container: "test",
    label: "workspace=test",
    image: "",
    workspace,
    workdir: workspace,
    claude: { mode: "none" as const },
  };
  const mounts = await resolveMounts(target, policy(`${root}:ro\n${workspace}:ro\n${root}`));
  const own = mounts.filter((mount) => mount.path.startsWith(root));
  // The plugin's workspace mount wins over an extra one at the same path, and between extra mounts
  // at one path, read-only wins.
  expect(own).toEqual([
    { path: root, readOnly: true },
    { path: workspace, readOnly: false },
  ]);
  const depths = mounts.map((mount) => mount.path.split("/").length);
  expect(depths).toEqual(depths.toSorted((left, right) => left - right));
});

test("refuses an extra mount that does not exist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sandbox-mounts-"));
  roots.push(root);
  const target = {
    container: "test",
    label: "workspace=test",
    image: "",
    workspace: root,
    workdir: root,
    claude: { mode: "none" as const },
  };
  await expect(resolveMounts(target, policy(path.join(root, "missing")))).rejects.toThrow(
    /does not exist/,
  );
});
