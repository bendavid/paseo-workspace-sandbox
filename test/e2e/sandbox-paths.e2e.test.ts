// Sandbox paths: the workspace under /workspaces inside the sandbox, joined through the real
// launcher from a folder in the workspace on the host. Bubblewrap, which runs the host's Git, also
// works in a relative worktree placed as dev containers place it. Images are never downloaded.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { backendFor } from "../../server/backends/index";
import {
  shellQuote,
  workspaceLayout,
  type ContainerPolicy,
  type ContainerTarget,
} from "../../server/container";
import { supportsRelativeWorktrees } from "../../server/git";
import { writeWrapper } from "../../server/wrapper";
import type { Engine } from "../../shared/rpc";
import { engineImage } from "./images";

const run = promisify(execFile);
const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const ENGINES: Engine[] = ["bubblewrap", "podman", "apptainer", "microsandbox"];
const setups = Object.fromEntries(
  await Promise.all(ENGINES.map(async (engine) => [engine, await engineImage(engine)] as const)),
);
const hostGit = (await run("git", ["--version"])).stdout;

async function directory(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

/** Starts the workspace's sandbox, runs `script` through sandbox-run from `cwd`, and cleans up. */
async function launch(
  engine: Engine,
  workspace: string,
  cwd: string,
  script: string,
  args: string[] = [],
) {
  const setup = setups[engine]!;
  const state = await directory("sandbox-paths-state-");
  const base: ContainerTarget = {
    container: `paseo-sandbox-e2e-${randomBytes(4).toString("hex")}`,
    label: "e2e=1",
    image: setup.image,
    workspace,
    workdir: workspace,
    claude: { mode: "none" },
    sandboxFolder: "/workspaces",
  };
  const target = { ...base, workdir: (await workspaceLayout(base)).workdir };
  const policy: ContainerPolicy = {
    engine,
    cli: setup.cli,
    network: "none",
    extraMounts: "",
    extraRunArgs: "",
    user: "host",
    agentState: "off",
  };
  const backend = backendFor(engine);
  const wrapper = await writeWrapper(state);
  const specFile = path.join(state, "workspaces", "wks_e2e.sh");
  await mkdir(path.dirname(specFile), { recursive: true });
  // As the service writes it.
  await writeFile(
    specFile,
    [
      `sandbox_workdir=${shellQuote(target.workdir)}`,
      `sandbox_host_workdir=${shellQuote(workspace)}`,
      `sandbox_host_realdir=${shellQuote(await realpath(workspace))}`,
      await backend.spec(target, policy),
      "",
    ].join("\n"),
  );
  try {
    await backend.start(target, policy);
    const { stdout } = await run(wrapper, ["terminal", "sh", "-c", script, "sh", ...args], {
      cwd,
      env: { ...process.env, PASEO_WORKSPACE_ID: "wks_e2e" },
    });
    return { workdir: target.workdir, output: stdout.trim() };
  } finally {
    await backend.remove(target, policy).catch(() => undefined);
  }
}

describe.each(ENGINES)("sandbox paths with %s", (engine) => {
  test.skipIf(!setups[engine])("starts a launch at the same folder under /workspaces", async () => {
    const root = await directory("sandbox-paths-");
    const workspace = path.join(root, "project");
    await mkdir(path.join(workspace, "src", "lib"), { recursive: true });
    await writeFile(path.join(workspace, "src", "lib", "marker"), "here\n");
    const { workdir, output } = await launch(
      engine,
      workspace,
      path.join(workspace, "src", "lib"),
      'pwd; cat marker; test -e "$1" && echo host-path-visible || echo host-path-hidden',
      [workspace],
    );
    expect(workdir).toBe("/workspaces/project");
    expect(output.split("\n")).toEqual(["/workspaces/project/src/lib", "here", "host-path-hidden"]);
  });
});

test.skipIf(!setups.bubblewrap || !supportsRelativeWorktrees(hostGit))(
  "commits in a relative worktree at sandbox paths, leaving other worktrees alone",
  async () => {
    const root = await directory("sandbox-paths-git-");
    const git = (cwd: string, ...args: string[]) =>
      run("git", ["-C", cwd, "-c", "user.name=T", "-c", "user.email=t@t.test", ...args]);
    const repo = path.join(root, "code", "proj");
    await run("git", ["init", "-q", "-b", "main", repo]);
    await git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    await git(repo, "config", "worktree.useRelativePaths", "true");
    const worktree = path.join(root, "home", ".paseo", "worktrees", "h", "wt");
    await mkdir(path.dirname(worktree), { recursive: true });
    await git(repo, "worktree", "add", "-q", "-b", "wt", worktree);
    await git(repo, "worktree", "add", "-q", "-b", "sibling", path.join(root, "sibling"));
    const { workdir, output } = await launch(
      "bubblewrap",
      worktree,
      worktree,
      [
        "pwd",
        "git status --short --branch | head -n 1",
        "echo change > file && git add file",
        "git -c user.name=T -c user.email=t@t.test commit -q -m sandboxed && echo committed",
        "git worktree prune >/dev/null 2>&1; echo pruned",
      ].join("; "),
    );
    expect(workdir).toBe("/workspaces/home/.paseo/worktrees/h/wt");
    expect(output.split("\n")).toEqual([workdir, "## wt", "committed", "pruned"]);
    // On the host: the commit is on the branch, and the sibling is still registered.
    expect((await git(repo, "log", "-1", "--format=%s", "wt")).stdout.trim()).toBe("sandboxed");
    expect((await git(repo, "worktree", "list")).stdout).toContain(path.join(root, "sibling"));
  },
);
