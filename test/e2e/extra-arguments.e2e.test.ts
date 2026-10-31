// Extra run arguments reach the engine split like a shell command: a quoted value with spaces stays
// one argument. Images are never downloaded: without IMAGE the test is skipped.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { backendFor, resolveEngineCli } from "../../server/backends/index";
import { runCli, type ContainerPolicy, type ContainerTarget } from "../../server/container";

const IMAGE = "docker.io/library/node:22-bookworm-slim";
const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const backend = backendFor("podman");
const cli = await resolveEngineCli("podman").catch(() => null);
const available = cli && (await backend.images!.localDigests(cli, IMAGE));

test.skipIf(!available)("passes a quoted value with spaces as one argument", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sandbox-arguments-e2e-"));
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
    engine: "podman",
    cli: cli!,
    // A separate network, Podman's private one: the sysctl needs a namespace of its own.
    network: "bridge",
    extraMounts: "",
    extraRunArgs: `--sysctl "net.ipv4.ping_group_range=1000 1000" --label 'e2e.note=two words'`,
    user: "host",
    agentState: "off",
  };
  try {
    await backend.start(target, policy);
    const range = await runCli(cli!, [
      "exec",
      target.container,
      "cat",
      "/proc/sys/net/ipv4/ping_group_range",
    ]);
    expect(range.trim().split(/\s+/)).toEqual(["1000", "1000"]);
    const note = await runCli(cli!, [
      "inspect",
      "--format",
      '{{index .Config.Labels "e2e.note"}}',
      target.container,
    ]);
    expect(note.trim()).toBe("two words");
  } finally {
    await backend.remove(target, policy).catch(() => undefined);
  }
});
