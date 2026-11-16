import { expect, test } from "vitest";
import { agentWorkspaceId, routeSession, type SessionRouteInput } from "../server/session-route";
import type { SandboxRecord } from "../shared/rpc";

function sandbox(workspaceId: string): SandboxRecord {
  return {
    workspaceId,
    projectId: "prj_1",
    cwd: "/projects/app",
    container: `paseo-sandbox-${workspaceId}`,
    createdAt: "2026-10-30T00:00:00Z",
    claudeHome: "private",
    profile: {
      id: "default",
      name: "Default",
      engine: "podman",
      image: "docker.io/library/node:22",
      network: "host",
      extraMounts: "",
      extraRunArgs: "",
    },
  };
}

const SANDBOXED = sandbox("wks_sandboxed");
const OTHER = sandbox("wks_other");

function route(overrides: Partial<SessionRouteInput>) {
  return routeSession({
    provider: "claude",
    sandboxedProvider: true,
    purpose: "interactive",
    workspaceId: null,
    ownSandbox: null,
    wasSandboxed: false,
    marker: null,
    directorySandbox: null,
    ...overrides,
  });
}

test("a sandboxed workspace's agents run in its own sandbox, even with another on the directory", () => {
  expect(
    route({ workspaceId: SANDBOXED.workspaceId, ownSandbox: SANDBOXED, directorySandbox: OTHER }),
  ).toEqual({ kind: "sandbox", sandbox: SANDBOXED });
});

test("an unsandboxed workspace sharing a sandbox's directory runs its agents on the host", () => {
  const unsandboxed = { workspaceId: "wks_main", directorySandbox: SANDBOXED };
  // A new agent got the sandboxed provider from agent.create, which only sees the directory.
  expect(route(unsandboxed)).toEqual({ kind: "host" });
  expect(route({ ...unsandboxed, purpose: "history" })).toEqual({ kind: "host" });
  // Its host agents keep resuming on the host.
  expect(route({ ...unsandboxed, sandboxedProvider: false })).toEqual({ kind: "pass" });
});

test("a sandboxed workspace refuses host providers", () => {
  expect(
    route({ sandboxedProvider: false, workspaceId: SANDBOXED.workspaceId, ownSandbox: SANDBOXED }),
  ).toMatchObject({
    kind: "refuse",
    message: expect.stringMatching(/claude would run on the host/),
  });
  // History of a host agent never runs anything.
  expect(
    route({
      sandboxedProvider: false,
      purpose: "history",
      workspaceId: SANDBOXED.workspaceId,
      ownSandbox: SANDBOXED,
    }),
  ).toEqual({ kind: "pass" });
});

test("an agent whose sandbox is gone shows its history but does not run on the host", () => {
  const retired = { workspaceId: SANDBOXED.workspaceId, wasSandboxed: true };
  expect(route({ ...retired, purpose: "history" })).toEqual({ kind: "host" });
  expect(route(retired)).toEqual({
    kind: "refuse",
    message: "This agent's workspace is no longer sandboxed.",
  });
});

test("without a known workspace, the directory keeps agents sandboxed", () => {
  expect(route({ directorySandbox: SANDBOXED })).toEqual({ kind: "sandbox", sandbox: SANDBOXED });
  expect(route({ sandboxedProvider: false, directorySandbox: SANDBOXED })).toMatchObject({
    kind: "refuse",
  });
  expect(route({})).toMatchObject({ kind: "refuse" });
  expect(route({ purpose: "history" })).toEqual({ kind: "host" });
  expect(route({ sandboxedProvider: false })).toEqual({ kind: "pass" });
});

test("an agent marked as sandboxed never reopens on the host, even when the records are gone", () => {
  const marker = { workspaceId: SANDBOXED.workspaceId };
  const forgotten = { workspaceId: SANDBOXED.workspaceId, wasSandboxed: false, marker };
  expect(route(forgotten)).toEqual({
    kind: "refuse",
    message: "This agent's workspace is no longer sandboxed.",
  });
  expect(route({ ...forgotten, purpose: "history" })).toEqual({ kind: "host" });
  // Another workspace's marker says nothing about this one.
  expect(route({ ...forgotten, workspaceId: "wks_main" })).toEqual({ kind: "host" });
});

test("an agent opened without its workspace takes it from its marker", () => {
  const marker = { workspaceId: SANDBOXED.workspaceId };
  expect(agentWorkspaceId(null, marker)).toBe(SANDBOXED.workspaceId);
  expect(agentWorkspaceId("wks_main", marker)).toBe("wks_main");
  expect(agentWorkspaceId(null, null)).toBeNull();
  // Its own sandbox, not the one at its directory.
  expect(
    route({
      workspaceId: agentWorkspaceId(null, marker),
      ownSandbox: SANDBOXED,
      directorySandbox: OTHER,
      marker,
    }),
  ).toEqual({ kind: "sandbox", sandbox: SANDBOXED });
});
