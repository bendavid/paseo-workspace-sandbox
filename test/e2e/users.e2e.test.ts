// The sandbox's user with each engine that keeps a sandbox, as you or as the image's default user.
// The image already has an account (node) for uid 1000, which running as you replaces. Images are
// never downloaded: an engine without IMAGE is skipped.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { backendFor, resolveEngineCli } from "../../server/backends/index";
import {
  providerDirectories,
  runCli,
  type ContainerPolicy,
  type ContainerTarget,
} from "../../server/container";
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

const ENGINES: Engine[] = ["podman", "microsandbox"];
const clis = Object.fromEntries(
  await Promise.all(ENGINES.map(async (engine) => [engine, await available(engine)] as const)),
);

const REPORT = [
  'echo "uid=$(id -u)"',
  'echo "whoami=$(whoami 2>/dev/null)"',
  'echo "passwd=$(getent passwd "$(id -u)")"',
  'echo "group=$(getent group "$(id -g)" | cut -d: -f1)"',
  'echo "home=$HOME"',
  'echo "codex=$(readlink "$HOME/.codex" 2>/dev/null)"',
  'echo "safe=${GIT_CONFIG_VALUE_0:-}"',
].join("\n");

function exec(engine: Engine, cli: string, container: string): Promise<string> {
  return engine === "microsandbox"
    ? runCli(cli, ["exec", container, "--", "sh", "-c", REPORT])
    : runCli(cli, ["exec", container, "sh", "-c", REPORT]);
}

describe.each(ENGINES)("the user in a %s sandbox", (engine) => {
  const cli = clis[engine];
  test.skipIf(!cli).each([
    ["as you", true],
    ["as the image's default user", false],
  ])("runs %s", async (_label, runAsHostUser) => {
    const root = await mkdtemp(path.join(tmpdir(), "sandbox-users-e2e-"));
    roots.push(root);
    const target: ContainerTarget = {
      container: `paseo-sandbox-e2e-${randomBytes(4).toString("hex")}`,
      label: "e2e=1",
      image: IMAGE,
      workspace: root,
      workdir: root,
      claude: { mode: "none" },
    };
    const policy: ContainerPolicy = {
      engine,
      cli: cli!,
      network: "none",
      extraMounts: "",
      extraRunArgs: "",
      runAsHostUser,
    };
    const backend = backendFor(engine);
    try {
      await backend.start(target, policy);
      const report = Object.fromEntries(
        (await exec(engine, cli!, target.container))
          .trim()
          .split("\n")
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      );
      const user = userInfo();
      const group = (await run("id", ["-gn"])).stdout.trim();
      if (runAsHostUser) {
        expect(report).toMatchObject({
          uid: String(user.uid),
          whoami: user.username,
          passwd: `${user.username}:x:${user.uid}:${user.gid}::${homedir()}:/bin/sh`,
          group,
          home: homedir(),
          safe: "",
        });
      } else {
        // The node image's default user is root, with /root as its home.
        expect(report).toMatchObject({ uid: "0", whoami: "root", home: "/root", safe: "*" });
        const codex = providerDirectories().find((directory) => directory.endsWith("/.codex"));
        if (codex) expect(report.codex).toBe(codex);
      }
    } finally {
      await backend.remove(target, policy).catch(() => undefined);
    }
  });
});
