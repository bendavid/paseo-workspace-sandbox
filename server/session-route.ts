import type { SandboxRecord } from "../shared/rpc";

/** Where an agent session runs, decided in `agent.session_open`. */
export type SessionRoute =
  /** A host provider on the host: the request goes through unchanged. */
  | { kind: "pass" }
  | { kind: "refuse"; message: string }
  /** A sandboxed provider in this workspace's sandbox. */
  | { kind: "sandbox"; sandbox: SandboxRecord }
  /**
   * A sandboxed provider whose command `sandbox-run` runs on the host: history of an agent whose
   * sandbox is gone, or an agent of an unsandboxed workspace that shares a sandbox's directory.
   */
  | { kind: "host" };

export interface SessionRouteInput {
  provider: string;
  /** Whether the session's provider is one of the plugin's sandboxed profiles. */
  sandboxedProvider: boolean;
  purpose: "interactive" | "history";
  /**
   * The agent's own workspace, as the daemon passes it. Null for agents saved without one, and
   * for sessions resumed through the SDK's `resumeAgent`.
   */
  workspaceId: string | null;
  /** That workspace's sandbox. */
  ownSandbox: SandboxRecord | null;
  /** Whether that workspace had a sandbox that is gone. */
  wasSandboxed: boolean;
  /** The sandbox whose directory contains the agent's, for agents of unknown workspace. */
  directorySandbox: SandboxRecord | null;
}

/**
 * `agent.create` only sees the agent's directory, so an unsandboxed workspace that shares a
 * sandbox's directory still gets sandboxed providers for its new agents. Here the agent's own
 * workspace decides: its own sandbox, else the host. Only when the workspace is unknown does the
 * directory decide, keeping such agents sandboxed.
 */
export function routeSession(input: SessionRouteInput): SessionRoute {
  const known = input.workspaceId !== null;
  const sandbox = known ? input.ownSandbox : input.directorySandbox;
  if (!input.sandboxedProvider) {
    if (sandbox && input.purpose === "interactive") {
      return {
        kind: "refuse",
        message: `This workspace is sandboxed; ${input.provider} would run on the host. Start a new agent instead.`,
      };
    }
    return { kind: "pass" };
  }
  if (sandbox) return { kind: "sandbox", sandbox };
  // A workspace that never had a sandbox shares a sandbox's directory: its agents run on the host.
  if (known && !input.wasSandboxed) return { kind: "host" };
  // The sandbox is gone. History still shows on the host; running again would leave the sandbox.
  if (input.purpose === "history") return { kind: "host" };
  return { kind: "refuse", message: "This agent's workspace is no longer sandboxed." };
}
