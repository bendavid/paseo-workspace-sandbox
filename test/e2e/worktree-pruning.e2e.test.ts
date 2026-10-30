// A sandboxed worktree must not remove the repository's other worktrees: they are not mounted, so
// git inside sees them as missing. Runs real sandboxes; images are never downloaded.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { backendFor, resolveEngineCli } from "../../server/backends/index";
import type { ContainerPolicy, ContainerTarget } from "../../server/container";
import type { Engine } from "../../shared/rpc";

const run = promisify(execFile);
const IMAGE = "docker.io/library/node:22-bookworm-slim";
const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function available(engine: Engine): Promise<string | null> {
  const cli = await resolveEngineCli(engine).catch(() => null);
  if (!cli) return null;
  const { images } = backendFor(engine);
  if (images && !(await images.localDigests(cli, IMAGE))) return null;
  return cli;
}

// The node image has no git, so only engines that run the host's system can run git inside.
const ENGINES: Engine[] = ["bubblewrap"];
const clis = Object.fromEntries(
  await Promise.all(ENGINES.map(async (engine) => [engine, await available(engine)] as const)),
);

const git = (cwd: string, ...args: string[]) =>
  run("git", ["-C", cwd, "-c", "user.name=T", "-c", "user.email=t@t.test", ...args]);

describe.each(ENGINES)("a sandboxed worktree with %s", (engine) => {
  test.skipIf(!clis[engine])("keeps working and cannot prune other worktrees", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sandbox-worktree-e2e-"));
    roots.push(root);
    const repo = path.join(root, "repo");
    await run("git", ["init", "-q", "-b", "main", repo]);
    await git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    const sandboxed = path.join(root, "worktrees", "sandboxed");
    const other = path.join(root, "worktrees", "other");
    await git(repo, "worktree", "add", "-q", "-b", "sandboxed", sandboxed);
    await git(repo, "worktree", "add", "-q", "-b", "other", other);
    const target: ContainerTarget = {
      container: `paseo-sandbox-e2e-${randomBytes(4).toString("hex")}`,
      label: "e2e=1",
      image: IMAGE,
      workspace: sandboxed,
      workdir: sandboxed,
      claude: { mode: "none" },
    };
    const policy: ContainerPolicy = {
      engine,
      cli: clis[engine]!,
      network: "none",
      extraMounts: "",
      extraRunArgs: "",
    };
    const output = await backendFor(engine).runOnce(target, policy, [
      "sh",
      "-c",
      [
        "export GIT_AUTHOR_NAME=T GIT_AUTHOR_EMAIL=t@t.test GIT_COMMITTER_NAME=T GIT_COMMITTER_EMAIL=t@t.test",
        "git commit -q --allow-empty -m in-sandbox && echo committed",
        "git switch -q -c sandboxed-2 && git switch -q sandboxed && echo switched",
        "git worktree prune 2>/dev/null; echo pruned=$?",
        "git gc --prune=now -q 2>/dev/null; echo gc=$?",
        "true",
      ].join("\n"),
    ]);
    expect(output).toContain("committed");
    expect(output).toContain("switched");
    // On the host, every worktree is still registered and usable.
    const list = (await git(repo, "worktree", "list", "--porcelain")).stdout;
    expect(list).toContain(`worktree ${other}`);
    expect(list).toContain(`worktree ${sandboxed}`);
    expect((await stat(path.join(repo, ".git", "worktrees", "other"))).isDirectory()).toBe(true);
    expect((await git(other, "status", "--short")).stdout).toBe("");
    expect((await git(repo, "log", "-1", "--format=%s", "sandboxed")).stdout.trim()).toBe(
      "in-sandbox",
    );
  });
});
