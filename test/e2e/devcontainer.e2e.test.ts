// Dev containers through the devcontainer CLI and Podman: a relative worktree with its own
// devcontainer.json, the consent details, the plugin's read-only git mounts, and a launch through
// the real launcher. Uses the local IMAGE; nothing is downloaded.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { backendFor, resolveEngineCli } from "../../server/backends/index";
import { shellQuote, type ContainerPolicy, type ContainerTarget } from "../../server/container";
import { supportsRelativeWorktrees } from "../../server/git";
import { writeWrapper } from "../../server/wrapper";
import { IMAGE } from "./images";

const run = promisify(execFile);
const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const devcontainer = await resolveEngineCli("devcontainer").catch(() => null);
const podman = await resolveEngineCli("podman").catch(() => null);
const imageHere =
  podman &&
  (await run(podman, ["image", "exists", IMAGE]).then(
    () => true,
    () => false,
  ));
const hostGit = (await run("git", ["--version"])).stdout;

test.skipIf(!devcontainer || !imageHere || !supportsRelativeWorktrees(hostGit))(
  "creates a worktree's dev container after showing what it does, and joins it",
  async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "sandbox-devcontainer-")));
    roots.push(root);
    process.env.PASEO_HOME = path.join(root, "paseo");
    const git = (cwd: string, ...args: string[]) =>
      run("git", ["-C", cwd, "-c", "user.name=T", "-c", "user.email=t@t.test", ...args]);
    const repo = path.join(root, "code", "proj");
    const marker = path.join(root, "initialize-ran");
    await mkdir(path.join(repo, ".devcontainer"), { recursive: true });
    await run("git", ["init", "-q", "-b", "main", repo]);
    await writeFile(
      path.join(repo, ".devcontainer", "devcontainer.json"),
      `{\n  // The repository's own configuration.\n  "image": "${IMAGE}",\n  "remoteUser": "node",\n  "initializeCommand": "touch ${marker}",\n  "remoteEnv": { "PASEO_E2E_REMOTE": "from config", "PATH": "\${containerEnv:PATH}:/opt/extra", "NODE_VERSION": null },\n  "userEnvProbe": "none",\n  "postCreateCommand": "echo export PASEO_E2E_PROFILE=1 >> ~/.profile",\n}\n`,
    );
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "init");
    await git(repo, "config", "worktree.useRelativePaths", "true");
    const worktree = path.join(root, "home", ".paseo", "worktrees", "h", "wt");
    await mkdir(path.join(worktree, ".."), { recursive: true });
    await git(repo, "worktree", "add", "-q", "-b", "wt", worktree);
    await mkdir(path.join(worktree, "src"));

    const target: ContainerTarget = {
      container: `paseo-sandbox-e2e-${randomBytes(4).toString("hex")}`,
      label: `workspace=e2e-${randomBytes(4).toString("hex")}`,
      image: "",
      workspace: worktree,
      workdir: worktree,
      claude: { mode: "none" },
      sandboxFolder: "/workspaces",
    };
    const policy: ContainerPolicy = {
      engine: "devcontainer",
      cli: devcontainer!,
      network: "bridge",
      extraMounts: "",
      extraRunArgs: "",
      user: "image",
      agentState: "off",
      containerCli: podman!,
    };
    const backend = backendFor("devcontainer");
    // The CLI builds an image per workspace folder, which would pile up run after run.
    let built: string | null = null;
    try {
      // Before anything runs: what creating it does, the host command first.
      const consent = await backend.creationConsent!(target, policy);
      expect(consent?.reason).toBe("devcontainer");
      expect(consent?.image).toBe(path.join(worktree, ".devcontainer", "devcontainer.json"));
      expect(consent?.details?.[0]).toBe(`Runs on this host, outside any sandbox: touch ${marker}`);
      expect(existsSync(marker)).toBe(false);

      await backend.start(target, policy);
      built = (
        await run(podman!, [
          "ps",
          "--filter",
          `label=paseo.workspace-sandbox.${target.label}`,
          "--format",
          "{{.Image}}",
        ])
      ).stdout.trim();
      expect(existsSync(marker)).toBe(true);
      const workdir = await backend.workspaceFolder!(target);
      expect(workdir).toBe("/workspaces/home/.paseo/worktrees/h/wt");
      expect(await backend.status(target, policy)).toEqual({ state: "running" });
      // Created now: nothing left to agree to.
      expect(await backend.creationConsent!(target, policy)).toBeNull();

      const state = path.join(root, "state");
      const wrapper = await writeWrapper(state);
      const specFile = path.join(state, "workspaces", "wks_e2e.sh");
      await mkdir(path.dirname(specFile), { recursive: true });
      await writeFile(
        specFile,
        [
          `sandbox_workdir=${shellQuote(workdir!)}`,
          `sandbox_host_workdir=${shellQuote(worktree)}`,
          `sandbox_host_realdir=${shellQuote(worktree)}`,
          await backend.spec(target, policy),
          "",
        ].join("\n"),
      );
      const common = "/workspaces/code/proj/.git";
      const { stdout } = await run(
        wrapper,
        [
          "terminal",
          "sh",
          "-c",
          [
            "pwd",
            "whoami",
            "cat ../.devcontainer/devcontainer.json >/dev/null && echo config-visible",
            `touch ${common}/hooks/injected 2>/dev/null && echo hooks-writable || echo hooks-read-only`,
            `touch ${common}/worktrees/injected 2>/dev/null && echo worktrees-writable || echo worktrees-read-only`,
            `touch ${common}/worktrees/wt/own 2>/dev/null && echo own-writable || echo own-read-only`,
            // remoteEnv over the captured login shell environment.
            'echo "remote=$PASEO_E2E_REMOTE"',
            'case $PATH in *:/opt/extra) echo path-extended ;; *) echo "path=$PATH" ;; esac',
            'echo "node_version=${NODE_VERSION-unset}"',
            // userEnvProbe "none": the login shell's environment is not read.
            'echo "profile=${PASEO_E2E_PROFILE-unset}"',
          ].join("; "),
        ],
        { cwd: path.join(worktree, "src"), env: { ...process.env, PASEO_WORKSPACE_ID: "wks_e2e" } },
      );
      expect(stdout.trim().split("\n")).toEqual([
        `${workdir}/src`,
        "node",
        "config-visible",
        "hooks-read-only",
        "worktrees-read-only",
        "own-writable",
        "remote=from config",
        "path-extended",
        "node_version=unset",
        "profile=unset",
      ]);
      // The same launch reading the login shell environment, as the default userEnvProbe does,
      // gets what ~/.profile exports.
      await writeFile(
        specFile,
        `${await readFile(specFile, "utf8")}sandbox_env_probe=loginInteractiveShell\n`,
      );
      const probed = await run(
        wrapper,
        ["terminal", "sh", "-c", 'echo "profile=${PASEO_E2E_PROFILE-unset}"'],
        { cwd: worktree, env: { ...process.env, PASEO_WORKSPACE_ID: "wks_e2e" } },
      );
      expect(probed.stdout.trim()).toBe("profile=1");
    } finally {
      await backend.remove(target, policy).catch(() => undefined);
      if (built?.includes("vsc-")) await run(podman!, ["rmi", built]).catch(() => undefined);
    }
    expect(await backend.status(target, policy)).toEqual({ state: "missing" });
  },
  300_000,
);
