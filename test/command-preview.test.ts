import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import {
  formatCommand,
  previewCommand,
  type PreviewPaths,
  type PreviewWorkspace,
} from "../server/command-preview";
import type { ContainerPolicy } from "../server/container";
import type { SandboxRecord } from "../shared/rpc";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function directory(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "sandbox-preview-")));
  roots.push(root);
  return root;
}

const policy: ContainerPolicy = {
  engine: "bubblewrap",
  cli: "/usr/bin/bwrap",
  network: "none",
  extraMounts: "",
  extraRunArgs: "",
  user: "host",
  agentState: "off",
};

const DATA = "/data/plugin";
const paths: PreviewPaths = {
  hostConfigDir: "/home/me/.claude",
  signInDir: `${DATA}/auth`,
  claudeHomeDir: (id) => `${DATA}/homes/${id}/claude`,
  linkPath: (id) => `${DATA}/links/${id}`,
};

function preview(options: {
  policy?: Partial<ContainerPolicy>;
  sandboxFolder?: string;
  workspace?: PreviewWorkspace;
  paths?: Partial<PreviewPaths>;
}) {
  return previewCommand({
    policy: { ...policy, ...options.policy },
    image: "docker.io/library/node:22",
    sandboxFolder: options.sandboxFolder ?? null,
    workspace: options.workspace ?? { kind: "generic" },
    paths: { ...paths, ...options.paths },
  });
}

test("puts each option on its own line and quotes only what needs it", () => {
  expect(
    formatCommand("podman", {
      head: ["run", "-d"],
      options: ["--name", "<sandbox>", "--init", "-e", "A=two words"],
      tail: ["docker.io/library/node:22", "sh", "-c", "echo $HOME"],
    }),
  ).toBe(
    [
      "podman run -d \\",
      "  --name <sandbox> \\",
      "  --init \\",
      "  -e 'A=two words' \\",
      "  docker.io/library/node:22 sh -c 'echo $HOME'",
    ].join("\n"),
  );
});

test("without a workspace, shows a plain checkout with the extra mounts and arguments", async () => {
  const command = await preview({
    policy: { extraMounts: "/srv:ro", extraRunArgs: `--setenv NOTE "two words"` },
  });
  expect(command).toContain("--bind <workspace> <workspace>");
  expect(command).toContain("--ro-bind <workspace>/.git/hooks <workspace>/.git/hooks");
  expect(command).toContain("--ro-bind /srv /srv");
  expect(command).toContain("--setenv NOTE 'two words'");
  expect(command).toContain("--chdir <workspace> \\\n  -- <command>");
  expect(command).not.toContain(`${DATA}/homes`);
});

test("shows the private Claude folder and sign-in folder at their real paths when isolated", async () => {
  const command = await preview({ policy: { agentState: "isolated" } });
  expect(command).toContain(`--bind ${DATA}/homes/<workspace-id>/claude`);
  expect(command).toContain(`--ro-bind ${DATA}/auth ${DATA}/auth`);
  expect(command).toContain(`--setenv CLAUDE_CONFIG_DIR ${DATA}/homes/<workspace-id>/claude`);
});

test("shares the host's Claude folder with shared agent state, with no private folder", async () => {
  const claude = await directory();
  const command = await preview({
    policy: { agentState: "shared" },
    paths: { hostConfigDir: claude },
  });
  expect(command).toContain(`--bind ${claude} ${claude}`);
  expect(command).toContain(`--setenv CLAUDE_CONFIG_DIR ${claude}`);
  expect(command).not.toContain(`${DATA}/homes`);
  expect(command).not.toContain(`${DATA}/auth`);
});

test("shows a squashed Podman sandbox's identity, read-only root, and private network", async () => {
  const { uid, gid } = userInfo();
  const command = await preview({
    policy: { engine: "podman", cli: "podman", network: "bridge", user: "squashed" },
  });
  expect(command.split("\n")[0]).toBe("podman run -d \\");
  expect(command).toContain("--network private \\");
  expect(command).toContain(`--uidmap ${uid}:0:1`);
  expect(command).toContain(`--sysctl 'net.ipv4.ping_group_range=${gid} ${gid}'`);
  expect(command).toContain("--read-only \\");
  expect(command).toContain("-v /tmp \\");
  expect(command).toContain("-v /run \\");
  expect(command).toContain("--label paseo.workspace-sandbox.workspace=<workspace-id>");
});

test("a new sandboxed directory shows the project and the link it gets", async () => {
  const project = path.join(await directory(), "proj");
  await mkdir(project);
  const workspace = { kind: "new", projectRoot: project, isolation: "directory" } as const;
  const atHost = await preview({ workspace });
  expect(atHost).toContain(`--ro-bind ${DATA}/link-mounts/<workspace-id> ${DATA}/links`);
  expect(atHost).toContain(`--bind ${project} ${DATA}/links/<workspace-id>`);
  expect(atHost).toContain(`--bind ${project} ${project}`);
  expect(atHost).not.toContain(".git/hooks");
  const inside = await preview({ workspace, sandboxFolder: "/workspaces" });
  expect(inside).toContain(`--bind ${project} /workspaces/proj`);
  expect(inside).toContain("--chdir /workspaces/proj");
});

test("a new worktree shows the repository's real git metadata and placeholders for itself", async () => {
  const repo = path.join(await directory(), "proj");
  await run("git", ["init", "-q", "-b", "main", repo]);
  const git = path.join(repo, ".git");
  const workspace = { kind: "new", projectRoot: repo, isolation: "worktree" } as const;
  const atHost = await preview({ workspace });
  expect(atHost).toContain("--bind <worktree> <worktree>");
  expect(atHost).toContain(`--bind ${git} ${git}`);
  expect(atHost).toContain(`--ro-bind ${git}/worktrees ${git}/worktrees`);
  expect(atHost).toContain(
    `--bind ${git}/worktrees/<worktree-name> ${git}/worktrees/<worktree-name>`,
  );
  expect(atHost).toContain(`--ro-bind ${git}/hooks ${git}/hooks`);
  const inside = await preview({ workspace, sandboxFolder: "/workspaces" });
  expect(inside).toContain("--bind <worktree> /workspaces/<worktree-path>");
  expect(inside).toContain(`--bind ${git} /workspaces/<repository-path>/.git`);
  expect(inside).toContain("--chdir /workspaces/<worktree-path>");
});

test("an existing sandbox shows its own name, workspace, and folders", async () => {
  const repo = path.join(await directory(), "proj");
  await run("git", ["init", "-q", "-b", "main", repo]);
  await run("git", [
    "-C",
    repo,
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "i",
  ]);
  const worktree = path.join(path.dirname(repo), "wt");
  // Absolute links, as before a switch: the preview places it as it will be once relative.
  await run("git", ["-C", repo, "worktree", "add", "-q", "-b", "wt", worktree]);
  const record = {
    workspaceId: "wks_1",
    container: "paseo-sandbox-wks_1",
    cwd: worktree,
    claudeHome: "private",
  } as SandboxRecord;
  const workspace = { kind: "sandbox", record } as const;
  const command = await preview({
    policy: { engine: "podman", cli: "podman", agentState: "isolated" },
    workspace,
  });
  expect(command).toContain("--name paseo-sandbox-wks_1");
  expect(command).toContain("--label paseo.workspace-sandbox.workspace=wks_1");
  expect(command).toContain(`--workdir ${worktree}`);
  expect(command).toContain(`-v ${worktree}:${worktree}`);
  expect(command).toContain(`-v ${DATA}/homes/wks_1/claude:${DATA}/homes/wks_1/claude`);
  const inside = await preview({ workspace, sandboxFolder: "/workspaces" });
  expect(inside).toContain("--chdir /workspaces/wt");
  expect(inside).toContain(`--bind ${repo}/.git /workspaces/proj/.git`);
});
