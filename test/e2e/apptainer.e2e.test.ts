// Apptainer and Singularity sandboxes: your account, each launch's environment, the network, and
// (only with SANDBOX_E2E_ALLOW_DOWNLOADS=1) pulling a registry image.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { backendFor } from "../../server/backends/index";
import type { ContainerPolicy, ContainerTarget } from "../../server/container";
import { checkImage } from "../../server/registry";
import type { Engine } from "../../shared/rpc";
import { engineImage } from "./images";

const run = promisify(execFile);
const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const ENGINES: Engine[] = ["apptainer", "singularity"];
const setups = Object.fromEntries(
  await Promise.all(ENGINES.map(async (engine) => [engine, await engineImage(engine)] as const)),
);

async function sandbox(engine: Engine, network: ContainerPolicy["network"] = "host") {
  const setup = setups[engine]!;
  const root = await mkdtemp(path.join(tmpdir(), "sandbox-apptainer-e2e-"));
  roots.push(root);
  const target: ContainerTarget = {
    container: "unused",
    label: "e2e=1",
    image: setup.image,
    workspace: root,
    workdir: root,
    claude: { mode: "none" },
  };
  const policy: ContainerPolicy = {
    engine,
    cli: setup.cli,
    network,
    extraMounts: "",
    extraRunArgs: "",
    user: "host",
    agentState: "shared",
  };
  return { root, target, policy, backend: backendFor(engine) };
}

describe.each(ENGINES)("%s", (engine) => {
  test.skipIf(!setups[engine])("runs as you, with your home path", async () => {
    const { target, policy, backend } = await sandbox(engine);
    const output = await backend.runOnce(target, policy, [
      "sh",
      "-c",
      'echo "$(id -u) $(whoami) $HOME $(getent passwd "$(id -u)" | cut -d: -f6)"',
    ]);
    const user = userInfo();
    expect(output.trim()).toBe(`${user.uid} ${user.username} ${homedir()} ${homedir()}`);
  });

  test.skipIf(!setups[engine])(
    "passes each launch's variables exactly and deletes their file",
    async () => {
      const { root, target, policy, backend } = await sandbox(engine);
      const spec = path.join(root, "spec.sh");
      await writeFile(spec, await backend.spec(target, policy));
      const tricky = `two $words "q" 'single' \\back \`cmd\` $(cmd) multi=eq`;
      const envFile = path.join(root, "launch.env");
      await writeFile(
        envFile,
        `TRICKY=${tricky}\nEMPTY=\nPATH=/opt/x:/usr/local/bin:/usr/bin:/bin\n`,
      );
      const { stdout } = await run("sh", [
        "-c",
        '. "$1"; sandbox_exec "$2" "" "$3" -- sh -c \'printf "%s|%s|%s|%s" "$TRICKY" "$EMPTY" "$PATH" "$(pwd)"\'',
        "sh",
        spec,
        envFile,
        root,
      ]);
      expect(stdout).toBe(`${tricky}||/opt/x:/usr/local/bin:/usr/bin:/bin|${root}`);
      // The values never stay on disk.
      expect(existsSync(envFile)).toBe(false);
    },
  );

  test.skipIf(!setups[engine])("has only loopback with no network", async () => {
    const { target, policy, backend } = await sandbox(engine, "none");
    const output = await backend.runOnce(target, policy, [
      "sh",
      "-c",
      "tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' '",
    ]);
    expect(output.trim()).toBe("lo");
  });
});

// Downloads busybox (about 2 MB) into a temporary Paseo home and Apptainer cache.
const downloads = process.env.SANDBOX_E2E_ALLOW_DOWNLOADS === "1" && setups.apptainer;
test.skipIf(!downloads)("pulls a registry image and records its digests", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sandbox-apptainer-pull-"));
  roots.push(root);
  process.env.PASEO_HOME = path.join(root, "paseo");
  process.env.APPTAINER_CACHEDIR = path.join(root, "cache");
  const image = "docker.io/library/busybox:latest";
  const { images } = backendFor("apptainer");
  const cli = setups.apptainer!.cli;
  expect(await images!.localDigests(cli, image)).toBeNull();
  expect(await checkImage(image, null)).toBe("missing");
  await images!.pull(cli, image);
  const digests = await images!.localDigests(cli, image);
  expect(digests?.length).toBeGreaterThan(0);
  expect(await checkImage(image, digests)).toBe("current");
  // A copy recorded at other digests counts as outdated.
  expect(await checkImage(image, ["sha256:old"])).toBe("outdated");
  const sif = path.join(root, "paseo", "plugin-data", "workspace-sandbox", "images");
  expect(
    (await readFile(path.join(sif, "docker.io_library_busybox_latest.digests.json"), "utf8"))
      .length,
  ).toBeGreaterThan(2);
});
