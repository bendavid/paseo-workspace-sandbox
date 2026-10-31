import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { formatCommand, previewCommand } from "../server/command-preview";
import type { ContainerPolicy } from "../server/container";

const policy: ContainerPolicy = {
  engine: "bubblewrap",
  cli: "/usr/bin/bwrap",
  network: "none",
  extraMounts: "",
  extraRunArgs: "",
  user: "host",
  agentState: "off",
};
const hostConfigDir = path.join(homedir(), ".claude");

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

test("shows the workspace's mounts as placeholders, with the extra mounts and arguments", async () => {
  const command = await previewCommand({
    policy: { ...policy, extraMounts: "/srv:ro", extraRunArgs: `--setenv NOTE "two words"` },
    image: "",
    hostConfigDir,
    sandboxFolder: null,
  });
  expect(command).toContain("--bind <workspace> <workspace>");
  expect(command).toContain("--ro-bind <workspace>/.git/hooks <workspace>/.git/hooks");
  expect(command).toContain("--ro-bind /srv /srv");
  expect(command).toContain("--setenv NOTE 'two words'");
  expect(command).toContain("--chdir <workspace> \\\n  -- <command>");
  // Without shared agent state there is no Claude folder.
  expect(command).not.toContain("<claude-folder>");
});

test("shows the private Claude folder when agent state is shared", async () => {
  const command = await previewCommand({
    policy: { ...policy, agentState: "isolated" },
    image: "",
    hostConfigDir,
    sandboxFolder: null,
  });
  expect(command).toContain("--bind <claude-folder> <claude-folder>");
  expect(command).toContain("--ro-bind <claude-sign-in> <claude-sign-in>");
  expect(command).toContain("--setenv CLAUDE_CONFIG_DIR <claude-folder>");
});

test("shows a squashed Podman sandbox's identity and read-only root", async () => {
  const { uid, gid } = userInfo();
  const command = await previewCommand({
    policy: { ...policy, engine: "podman", cli: "podman", network: "bridge", user: "squashed" },
    image: "docker.io/library/node:22",
    hostConfigDir,
    sandboxFolder: null,
  });
  expect(command.split("\n")[0]).toBe("podman run -d \\");
  expect(command).toContain(`--uidmap ${uid}:0:1`);
  expect(command).toContain(`--sysctl 'net.ipv4.ping_group_range=${gid} ${gid}'`);
  expect(command).toContain("--read-only \\");
  expect(command).toContain("--label paseo.workspace-sandbox.workspace=<workspace-id>");
  expect(command).toMatch(/docker\.io\/library\/node:22 sh -c '[^\n]+'$/);
});

test("shows the workspace under the sandbox folder with sandbox paths", async () => {
  const command = await previewCommand({
    policy: { ...policy, engine: "podman", cli: "podman", network: "bridge" },
    image: "docker.io/library/node:22",
    hostConfigDir,
    sandboxFolder: "/workspaces",
  });
  expect(command).toContain("--workdir /workspaces/<name>");
  expect(command).toContain("-v <workspace>:/workspaces/<name> \\");
  expect(command).toContain("-v <workspace>/.git/hooks:/workspaces/<name>/.git/hooks:ro");
});

test("shares the host's Claude folder and the agents' folders with shared agent state", async () => {
  const claude = await mkdtemp(path.join(tmpdir(), "sandbox-preview-claude-"));
  const command = await previewCommand({
    policy: { ...policy, agentState: "shared" },
    image: "",
    hostConfigDir: claude,
    sandboxFolder: null,
  }).finally(() => rm(claude, { recursive: true, force: true }));
  expect(command).toContain(`--bind ${claude} ${claude}`);
  expect(command).toContain(`--setenv CLAUDE_CONFIG_DIR ${claude}`);
  // No private folder, and so no sign-in copy.
  expect(command).not.toContain("<claude-folder>");
  expect(command).not.toContain("<claude-sign-in>");
});
