import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { AbsoluteWorktreeError, workspaceLayout, type ContainerTarget } from "../server/container";
import {
  enableRelativeWorktrees,
  relativeWorktrees,
  supportsRelativeWorktrees,
} from "../server/git";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function directory(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "sandbox-paths-")));
  roots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]) {
  return run("git", ["-C", cwd, "-c", "user.name=T", "-c", "user.email=t@t.test", ...args]);
}

/** A repository at code/proj with a worktree far from it, as Paseo's worktrees are. */
async function repository(relative: boolean) {
  const root = await directory();
  const repo = path.join(root, "code", "proj");
  await run("git", ["init", "-q", "-b", "main", repo]);
  await git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  if (relative) await git(repo, "config", "worktree.useRelativePaths", "true");
  const worktree = path.join(root, "home", ".paseo", "worktrees", "h", "wt");
  await mkdir(path.dirname(worktree), { recursive: true });
  await git(repo, "worktree", "add", "-q", "-b", "wt", worktree);
  return { root, repo, worktree };
}

function target(workspace: string, extra: Partial<ContainerTarget> = {}): ContainerTarget {
  return {
    container: "test",
    label: "workspace=test",
    image: "",
    workspace,
    workdir: workspace,
    claude: { mode: "none" },
    sandboxFolder: "/workspaces",
    ...extra,
  };
}

test("places a relative worktree as dev containers do, so both git links resolve", async () => {
  const { repo, worktree } = await repository(true);
  const layout = await workspaceLayout(target(worktree));
  // The folders below the closest one holding both the worktree and the repository.
  expect(layout.workdir).toBe("/workspaces/home/.paseo/worktrees/h/wt");
  const common = "/workspaces/code/proj/.git";
  const gitDir = path.join(repo, ".git");
  const expected = [
    { path: layout.workdir, source: worktree, readOnly: false },
    { path: common, source: gitDir, readOnly: false },
    { path: `${common}/worktrees`, source: path.join(gitDir, "worktrees"), readOnly: true },
    {
      path: `${common}/worktrees/wt`,
      source: path.join(gitDir, "worktrees", "wt"),
      readOnly: false,
    },
    { path: `${common}/hooks`, source: path.join(gitDir, "hooks"), readOnly: true },
    { path: `${common}/config`, source: path.join(gitDir, "config"), readOnly: true },
  ];
  expect(layout.mounts).toHaveLength(expected.length);
  expect(layout.mounts).toEqual(expect.arrayContaining(expected));
  // The worktree's link, and the repository's link back, resolve to the sandbox paths.
  const link = (await readFile(path.join(worktree, ".git"), "utf8")).replace("gitdir:", "").trim();
  expect(path.posix.resolve(layout.workdir, link)).toBe(`${common}/worktrees/wt`);
  const back = (await readFile(path.join(gitDir, "worktrees", "wt", "gitdir"), "utf8")).trim();
  expect(path.posix.resolve(`${common}/worktrees/wt`, back)).toBe(`${layout.workdir}/.git`);
});

test("refuses a worktree whose git links are absolute", async () => {
  const { worktree } = await repository(false);
  await expect(workspaceLayout(target(worktree))).rejects.toBeInstanceOf(AbsoluteWorktreeError);
});

test("keeps host paths without a sandbox folder", async () => {
  const { worktree } = await repository(false);
  const layout = await workspaceLayout(target(worktree, { sandboxFolder: undefined }));
  expect(layout.workdir).toBe(worktree);
  expect(layout.mounts[0]).toEqual({ path: worktree, readOnly: false });
});

test("places a sandboxed directory at <folder>/<name>, without the link handling", async () => {
  const root = await directory();
  const project = path.join(root, "proj");
  await mkdir(project);
  const link = path.join(root, "links", "wks_1");
  const layout = await workspaceLayout(target(link, { linkedDirectory: project }));
  expect(layout).toEqual({
    workdir: "/workspaces/proj",
    mounts: [{ path: "/workspaces/proj", source: project, readOnly: false }],
  });
  // The link Paseo knows the workspace by is still made.
  expect(await realpath(link)).toBe(project);
});

test("switches a repository and its existing worktrees to relative paths", async () => {
  const { repo, worktree } = await repository(false);
  expect((await relativeWorktrees(repo)).state).toBe("absolute");
  expect((await enableRelativeWorktrees(repo)).state).toBe("relative");
  expect(await readFile(path.join(worktree, ".git"), "utf8")).toMatch(/^gitdir: \.\.\//);
  // New worktrees, as Paseo adds them with plain `git worktree add`, are relative too.
  const second = path.join(path.dirname(worktree), "second");
  await git(repo, "worktree", "add", "-q", "-b", "second", second);
  expect(await readFile(path.join(second, ".git"), "utf8")).toMatch(/^gitdir: \.\.\//);
  await expect(workspaceLayout(target(worktree))).resolves.toBeTruthy();
});

test("relative worktree links need Git 2.48", () => {
  expect(supportsRelativeWorktrees("git version 2.47.3")).toBe(false);
  expect(supportsRelativeWorktrees("git version 2.48.0")).toBe(true);
  expect(supportsRelativeWorktrees("git version 3.0.1")).toBe(true);
});
