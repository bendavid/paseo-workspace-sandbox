// The real launcher, sandbox-run, joining a workspace's sandbox from its spec, as a sandboxed
// terminal does: the login shell environment is captured, PASEO_* variables are forwarded, and
// the command runs in the workspace. Engines that start a sandbox per launch; images are never
// downloaded.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { backendFor } from "../../server/backends/index";
import { shellQuote, type ContainerPolicy, type ContainerTarget } from "../../server/container";
import { writeWrapper } from "../../server/wrapper";
import type { Engine } from "../../shared/rpc";
import { engineImage } from "./images";

const run = promisify(execFile);
const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const ENGINES: Engine[] = ["bubblewrap", "apptainer"];
const setups = Object.fromEntries(
  await Promise.all(ENGINES.map(async (engine) => [engine, await engineImage(engine)] as const)),
);

describe.each(ENGINES)("sandbox-run with %s", (engine) => {
  test.skipIf(!setups[engine])("runs a terminal command in the workspace's sandbox", async () => {
    const setup = setups[engine]!;
    const root = await mkdtemp(path.join(tmpdir(), "sandbox-run-e2e-"));
    roots.push(root);
    const state = path.join(root, "state");
    const workspace = path.join(root, "workspace");
    await run("mkdir", ["-p", workspace]);
    const target: ContainerTarget = {
      container: "unused",
      label: "e2e=1",
      image: setup.image,
      workspace,
      workdir: workspace,
      claude: { mode: "none" },
    };
    const policy: ContainerPolicy = {
      engine,
      cli: setup.cli,
      network: "host",
      extraMounts: "",
      extraRunArgs: "",
      user: "host",
      agentState: "shared",
    };
    const wrapper = await writeWrapper(state);
    const specFile = path.join(state, "workspaces", "wks_e2e.sh");
    await run("mkdir", ["-p", path.dirname(specFile)]);
    await writeFile(
      specFile,
      [
        `sandbox_workdir=${shellQuote(workspace)}`,
        await backendFor(engine).spec(target, policy),
        "",
      ].join("\n"),
    );
    const started = Date.now();
    const { stdout, stderr } = await run(
      wrapper,
      ["terminal", "--title", "e2e", "sh", "-c", 'printf "%s|%s|%s" "$(pwd)" "$PASEO_E2E" "$HOME"'],
      {
        cwd: workspace,
        env: { ...process.env, PASEO_WORKSPACE_ID: "wks_e2e", PASEO_E2E: "it $works" },
      },
    );
    expect(stdout.replace(/^\u001b\]0;[^\u0007]*\u0007/, "")).toBe(
      `${workspace}|it $works|${process.env.HOME}`,
    );
    // The capture's 60-second watchdog once kept the launch's output open until it ran out.
    expect(Date.now() - started).toBeLessThan(20_000);
    // The login shell environment was captured for later launches, readable only by you.
    const captured = path.join(state, "workspaces", "wks_e2e.env");
    expect(existsSync(captured), stderr).toBe(true);
    expect((await readFile(captured, "utf8")).split("\n")[0]).toMatch(/^#sandbox=/);

    // A profile that doesn't read the login shell environment captures nothing.
    await rm(captured);
    await writeFile(specFile, `${await readFile(specFile, "utf8")}sandbox_env_probe=none\n`);
    const off = await run(wrapper, ["terminal", "sh", "-c", 'printf "%s" "$PASEO_E2E"'], {
      cwd: workspace,
      env: { ...process.env, PASEO_WORKSPACE_ID: "wks_e2e", PASEO_E2E: "forwarded" },
    });
    expect(off.stdout).toBe("forwarded");
    expect(existsSync(captured)).toBe(false);
  });
});
