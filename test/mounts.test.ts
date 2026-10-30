import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import {
  createLink,
  linkMountPoints,
  parseExtraMounts,
  providerDirectories,
  removeLink,
  resolveMounts,
  type ContainerPolicy,
} from "../server/container";

const execFileAsync = promisify(execFile);

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function policy(extraMounts: string): ContainerPolicy {
  return {
    engine: "bubblewrap",
    cli: "bwrap",
    network: "host",
    extraMounts,
    extraRunArgs: "",
    runAsHostUser: true,
    shareAgentState: true,
  };
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

async function sandboxedDirectory() {
  const root = await mkdtemp(path.join(tmpdir(), "sandbox-linked-"));
  roots.push(root);
  const project = path.join(root, "project");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "README.md"), "hi\n");
  await execFileAsync("git", ["init", "-q", project]);
  const link = path.join(root, "data", "links", "wks_1");
  await createLink(link, project);
  const target = {
    container: "test",
    label: "workspace=wks_1",
    image: "",
    workspace: link,
    workdir: link,
    claude: { mode: "none" as const },
    linkedDirectory: project,
  };
  return { root, project, link, target };
}

test("a sandboxed directory is mounted at its link and its real path, with no git mounts", async () => {
  const { root, project, link, target } = await sandboxedDirectory();
  const mounts = (await resolveMounts(target, policy(""))).filter((mount) =>
    mount.path.startsWith(root),
  );
  expect(mounts).toEqual([
    { path: project, readOnly: false },
    { path: path.dirname(link), source: linkMountPoints(link), readOnly: true },
    { path: link, source: project, readOnly: false },
  ]);
  // The mount point exists before the engine needs it.
  expect((await lstat(path.join(linkMountPoints(link), "wks_1"))).isDirectory()).toBe(true);
});

test("a sandboxed directory's link is recreated when missing", async () => {
  const { project, link, target } = await sandboxedDirectory();
  await rm(link);
  await resolveMounts(target, policy(""));
  expect(await readlink(link)).toBe(project);
});

test("removing a link leaves the project directory alone", async () => {
  const { project, link } = await sandboxedDirectory();
  await removeLink(link);
  expect(await lstat(link).catch(() => null)).toBeNull();
  expect(await lstat(linkMountPoints(link)).catch(() => null)).toBeNull();
  expect(await readFile(path.join(project, "README.md"), "utf8")).toBe("hi\n");
});

test("a worktree keeps the other worktrees' entries read-only and its own writable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sandbox-worktree-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  const git = (cwd: string, ...args: string[]) =>
    execFileAsync("git", ["-C", cwd, "-c", "user.name=T", "-c", "user.email=t@t.test", ...args]);
  await execFileAsync("git", ["init", "-q", "-b", "main", repo]);
  await git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const worktree = path.join(root, "wt");
  await git(repo, "worktree", "add", "-q", "-b", "wt", worktree);
  const target = {
    container: "test",
    label: "workspace=test",
    image: "",
    workspace: worktree,
    workdir: worktree,
    claude: { mode: "none" as const },
  };
  const gitDir = path.join(repo, ".git");
  const mounts = (await resolveMounts(target, policy(""))).filter((mount) =>
    mount.path.startsWith(root),
  );
  expect(mounts).toEqual([
    { path: worktree, readOnly: false },
    { path: gitDir, readOnly: false },
    { path: path.join(gitDir, "worktrees"), readOnly: true },
    { path: path.join(gitDir, "hooks"), readOnly: true },
    { path: path.join(gitDir, "config"), readOnly: true },
    { path: path.join(gitDir, "worktrees", "wt"), readOnly: false },
  ]);
});

test("shares the agents' folders only when the profile does", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sandbox-agents-"));
  roots.push(root);
  const target = {
    container: "test",
    label: "workspace=test",
    image: "",
    workspace: root,
    workdir: root,
    claude: { mode: "none" as const },
  };
  const agentFolders = (mounts: Array<{ path: string }>) =>
    mounts.map((mount) => mount.path).filter((p) => providerDirectories().includes(p));
  const shared = await resolveMounts(target, policy(""));
  expect(agentFolders(shared)).toEqual(providerDirectories());
  const unshared = await resolveMounts(target, { ...policy(""), shareAgentState: false });
  expect(agentFolders(unshared)).toEqual([]);
});
