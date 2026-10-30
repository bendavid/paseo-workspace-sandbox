import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { prepareClaudeHome } from "../server/claude-home";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const mode = async (file: string) => (await stat(file)).mode & 0o777;

/** A fake host Claude folder, with its own `.claude.json` so the real one is never read. */
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "sandbox-claude-home-"));
  roots.push(root);
  const host = path.join(root, "host-claude");
  await mkdir(path.join(host, "skills"), { recursive: true });
  await writeFile(path.join(host, ".claude.json"), JSON.stringify({ projects: { "/x": {} } }));
  await writeFile(path.join(host, "settings.json"), "{}");
  const homes = path.join(root, "homes");
  const directory = path.join(homes, "wks_1", "claude");
  const prepare = () =>
    prepareClaudeHome({ directory, hostConfigDir: host, helperCommand: "/auth/helper" });
  return { homes, directory, prepare };
}

test("a new Claude folder is 0710 inside 0700 parents", async () => {
  const { homes, directory, prepare } = await setup();
  await prepare();
  // The engine reaches the shared entries' mount points on NFS; nobody else reaches the folder.
  expect(await mode(directory)).toBe(0o710);
  expect(await mode(path.dirname(directory))).toBe(0o700);
  expect(await mode(homes)).toBe(0o700);
  expect(await mode(path.join(directory, ".claude.json"))).toBe(0o600);
  expect(await mode(path.join(directory, "settings.json"))).toBe(0o600);
});

test("an existing Claude folder becomes 0710 and its parents keep their mode", async () => {
  const { homes, directory, prepare } = await setup();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await prepare();
  expect(await mode(directory)).toBe(0o710);
  expect(await mode(path.dirname(directory))).toBe(0o700);
  expect(await mode(homes)).toBe(0o700);
});
