// The sandbox's user with each engine that keeps a sandbox: as you, squashed, or as the image's
// default user. The image already has an account (node) for uid 1000, which running as you
// replaces; a squashed sandbox uses a local copy without an account for your uid, since Podman only
// adds one. Images are never downloaded: an engine without IMAGE is skipped.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { backendFor, resolveEngineCli } from "../../server/backends/index";
import { podmanResolver, resolveImageReference } from "../../server/image-reference";
import {
  providerDirectories,
  runCli,
  type ContainerPolicy,
  type ContainerTarget,
} from "../../server/container";
import { ENGINE_USER_MODES, type AgentState, type Engine, type UserMode } from "../../shared/rpc";
import { imageWithoutAccount } from "./images";

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
const squashedImage = clis.podman ? await imageWithoutAccount(clis.podman) : null;

const REPORT = [
  'echo "uid=$(id -u)"',
  'echo "whoami=$(whoami 2>/dev/null)"',
  'echo "passwd=$(getent passwd "$(id -u)")"',
  'echo "group=$(getent group "$(id -g)" | cut -d: -f1)"',
  'echo "home=$HOME"',
  'echo "codex=$(readlink "$HOME/.codex" 2>/dev/null)"',
  'echo "safe=${GIT_CONFIG_VALUE_0:-}"',
  'echo "ids=$(wc -l </proc/self/uid_map)"',
  'echo "passwdOwner=$(stat -c %u /etc/passwd)"',
  'echo "rootWritable=$(touch /usr/.paseo-probe 2>/dev/null && echo yes || echo no)"',
  'echo "homeWritable=$(touch "$HOME/.paseo-probe" 2>/dev/null && echo yes || echo no)"',
  'echo "memoryWritable=$(touch /tmp/p /var/tmp/p /run/p /dev/shm/p 2>/dev/null && echo yes || echo no)"',
].join("\n");

const CASES: Array<[string, UserMode, AgentState]> = [
  ["as you", "host", "shared"],
  ["as you, squashed", "squashed", "shared"],
  ["as the image's default user", "image", "shared"],
  ["as the image's default user, sharing no agent state", "image", "off"],
];

function exec(engine: Engine, cli: string, container: string): Promise<string> {
  return engine === "microsandbox"
    ? runCli(cli, ["exec", container, "--", "sh", "-c", REPORT])
    : runCli(cli, ["exec", container, "sh", "-c", REPORT]);
}

describe.each(ENGINES)("the user in a %s sandbox", (engine) => {
  const cli = clis[engine];
  test.skipIf(!cli).each(CASES.filter(([, user]) => ENGINE_USER_MODES[engine].includes(user)))(
    "runs %s",
    async (_label, user, agentState) => {
      const asHostUser = user !== "image";
      const root = await mkdtemp(path.join(tmpdir(), "sandbox-users-e2e-"));
      roots.push(root);
      const target: ContainerTarget = {
        container: `paseo-sandbox-e2e-${randomBytes(4).toString("hex")}`,
        label: "e2e=1",
        image: user === "squashed" ? squashedImage! : IMAGE,
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
        user,
        agentState,
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
        const account = userInfo();
        const group = (await run("id", ["-gn"])).stdout.trim();
        if (asHostUser && engine === "podman") {
          // Your supplementary groups too, as the kernel sees the container's process.
          const pid = (
            await runCli(cli!, ["inspect", "--format", "{{.State.Pid}}", target.container])
          ).trim();
          const status = await readFile(`/proc/${pid}/status`, "utf8");
          const groups = /^Groups:(.*)$/m.exec(status)?.[1]?.trim().split(/\s+/).map(Number) ?? [];
          expect(groups.toSorted()).toEqual([...new Set(process.getgroups?.() ?? [])].toSorted());
        }
        if (user === "squashed") {
          // Only your uid exists inside; the root is read-only and HOME is writable memory.
          expect(report).toMatchObject({
            ids: "1",
            passwdOwner: String(account.uid),
            rootWritable: "no",
            homeWritable: "yes",
            memoryWritable: "yes",
          });
        }
        if (asHostUser) {
          expect(report).toMatchObject({
            uid: String(account.uid),
            whoami: account.username,
            passwd: `${account.username}:x:${account.uid}:${account.gid}::${homedir()}:/bin/sh`,
            group,
            home: homedir(),
            safe: "",
          });
        } else {
          // The node image's default user is root, with /root as its home.
          expect(report).toMatchObject({ uid: "0", whoami: "root", home: "/root", safe: "*" });
          const codex = providerDirectories().find((directory) => directory.endsWith("/.codex"));
          if (codex) expect(report.codex).toBe(agentState === "shared" ? codex : "");
        }
        // A restart stops the sandbox and starts the same one again.
        await backend.stop!(target, policy);
        expect(await backend.status(target, policy)).toEqual({ state: "stopped" });
        await backend.start(target, policy);
        expect(await backend.status(target, policy)).toEqual({ state: "running" });
      } finally {
        await backend.remove(target, policy).catch(() => undefined);
      }
    },
  );
});

test.skipIf(!clis.podman)("resolves a short name to a local image's full name", async () => {
  // Podman named the local image itself; a short name finds it before any registry.
  expect(
    await resolveImageReference("podman", "node:22-bookworm-slim", podmanResolver(clis.podman)),
  ).toBe(IMAGE);
});
