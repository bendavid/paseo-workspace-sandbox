import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeWrapper } from "../server/wrapper";

describe("sandbox-run in agent mode", () => {
  let root: string;
  let wrapper: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "sandbox-wrapper-"));
    wrapper = await writeWrapper(root);
    // A sandbox that is down: a launch that gets past the routing checks stops here.
    await mkdir(path.join(root, "workspaces"), { recursive: true });
    await writeFile(path.join(root, "workspaces", "wks_a.sh"), "sandbox_ready() { false; }\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function launch(env: Record<string, string>) {
    // Only the variables under test: this suite may itself run inside a Paseo agent.
    return spawnSync(wrapper, ["agent", "true"], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PASEO_AGENT_ID: "agent-1", ...env },
      encoding: "utf8",
    });
  }

  it("refuses a sandbox other than the agent's workspace", () => {
    const result = launch({ PASEO_WORKSPACE_ID: "wks_b", PASEO_SANDBOX_WORKSPACE_ID: "wks_a" });
    expect(result.status).toBe(126);
    expect(result.stderr).toContain("agent of workspace wks_b routed to the sandbox of wks_a");
  });

  it("launches in the agent's own workspace's sandbox", () => {
    const result = launch({ PASEO_WORKSPACE_ID: "wks_a", PASEO_SANDBOX_WORKSPACE_ID: "wks_a" });
    expect(result.stderr).toContain("the sandbox is not running");
  });

  it("launches when Paseo does not name the workspace", () => {
    const result = launch({ PASEO_SANDBOX_WORKSPACE_ID: "wks_a" });
    expect(result.stderr).toContain("the sandbox is not running");
  });
});
