import { existsSync } from "node:fs";
import type { PaseoApi } from "./paseo";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  AgentSandboxMarkerSchema,
  SANDBOX_METADATA_KEY,
  WorkspaceSandboxRequestSchema,
  type AgentSandboxMarker,
  type WorkspaceSandboxRequest,
} from "../shared/rpc";
import type { ClaudeLoginKeeper } from "./claude-login";
import { CONTAINED_ACP_CAPABILITIES, type ProfileManager } from "./profiles";
import type { SandboxService } from "./service";
import { agentWorkspaceId, routeSession } from "./session-route";
import type { SandboxStore } from "./store";

type Metadata = Readonly<Record<string, unknown>> | undefined;

function sandboxMarker(metadata: Metadata): AgentSandboxMarker | null {
  const parsed = AgentSandboxMarkerSchema.safeParse(metadata?.[SANDBOX_METADATA_KEY]);
  return parsed.success ? parsed.data : null;
}

function sandboxRequest(metadata: Metadata): WorkspaceSandboxRequest | null {
  const parsed = WorkspaceSandboxRequestSchema.safeParse(metadata?.[SANDBOX_METADATA_KEY]);
  return parsed.success ? parsed.data : null;
}

/**
 * Records on the agent the sandbox it runs in, so it never reopens outside it: not when the
 * daemon opens it without its workspace, and not when the plugin's own records are gone.
 */
function markSandboxed(paseo: PaseoApi, agentId: string, workspaceId: string): void {
  const marker: AgentSandboxMarker = { workspaceId };
  void paseo.agents
    .ref(agentId)
    .setMetadata({ [SANDBOX_METADATA_KEY]: marker })
    .catch((error: unknown) =>
      console.error(`Marking agent ${agentId} as sandboxed failed`, error),
    );
}

export function registerHooks(input: {
  server: PluginServerContext;
  store: SandboxStore;
  loaded: Promise<{ profiles: ProfileManager; login: ClaudeLoginKeeper }>;
  resolve: (paseo: PaseoApi) => Promise<SandboxService>;
}): Array<() => void> {
  const { server, store, loaded, resolve } = input;
  return [
    // A sandbox chosen on Paseo's New workspace screen: refuse the workspace now if the sandbox
    // could not run it, rather than after it exists.
    server.addHook("workspace.create.before", async ({ request }, { paseo }) => {
      const sandbox = sandboxRequest(request.metadata);
      if (!sandbox) return undefined;
      return (await resolve(paseo)).prepareWorkspaceRequest(request, sandbox, paseo);
    }),

    server.addHook("workspace.create.after", async ({ workspace }, { paseo }) => {
      const sandbox = sandboxRequest(workspace.metadata);
      if (!sandbox) return;
      await (await resolve(paseo)).adoptWorkspace(workspace, sandbox);
    }),

    // Route every new agent in a sandboxed workspace to a sandboxed profile of the provider it
    // asked for, derived from that provider's current configuration.
    server.addHook("agent.create.before", async ({ request }, { paseo }) => {
      const { profiles } = await loaded;
      // The first agent of a workspace from the New workspace screen can arrive before the
      // notification that gives the workspace its sandbox.
      await (await resolve(paseo)).adoptionsAt(request.config.cwd, paseo);
      const sandbox = store.findByCwd(request.config.cwd);
      const provider = request.config.provider;
      if (!sandbox) {
        if (profiles.isDerived(provider)) {
          throw new Error(
            "Sandboxed providers run only in sandboxed workspaces. Choose a container profile in New workspace's Sandbox field.",
          );
        }
        return undefined;
      }
      const derived = await profiles.ensure(paseo, provider);
      return {
        ...request,
        config: {
          ...request.config,
          provider: derived.id,
          // Per-agent options override the profile's, so ACP capabilities are pinned here too.
          ...(derived.acp
            ? {
                providerOptions: {
                  ...request.config.providerOptions,
                  clientCapabilities: CONTAINED_ACP_CAPABILITIES,
                },
              }
            : {}),
        },
      };
    }),

    // The agent's own workspace is known only once it exists.
    server.addHook("agent.create.after", async ({ agent }, { paseo }) => {
      const { profiles } = await loaded;
      if (!agent.workspaceId || !profiles.isDerived(agent.provider)) return;
      if (!store.get(agent.workspaceId)) return;
      markSandboxed(paseo, agent.id, agent.workspaceId);
    }),

    // Tell the wrapper where a session runs. Resume, refresh, and import pass through here too,
    // so an agent saved with a host provider cannot reopen inside a sandbox.
    server.addHook("agent.open.before", async ({ request }, { paseo }) => {
      const { profiles, login } = await loaded;
      const marker = sandboxMarker(request.metadata);
      const workspaceId = agentWorkspaceId(request.workspaceId, marker);
      // A workspace that asks for a sandbox it lacks gets it here, or its agents don't start.
      const ownSandbox = workspaceId
        ? await (
            await resolve(paseo)
          )
            .ensureRequestedSandbox(workspaceId, paseo)
            .catch((error: unknown) => {
              if (request.purpose === "history") return null;
              throw error;
            })
        : null;
      const route = routeSession({
        provider: request.provider,
        sandboxedProvider: profiles.isDerived(request.provider),
        purpose: request.purpose,
        workspaceId,
        ownSandbox,
        wasSandboxed: workspaceId ? store.wasSandboxed(workspaceId) : false,
        marker,
        directorySandbox: store.findByCwd(request.cwd),
      });
      switch (route.kind) {
        case "pass":
          return undefined;
        case "refuse":
          throw new Error(route.message);
        case "host": {
          // Providers that read history through their CLI (Codex) do so on the host, and the
          // daemon reads Claude's transcripts from the workspace's private folder, which outlives
          // the sandbox. An unsandboxed workspace has no such folder and uses the host's.
          const claudeHome = workspaceId ? store.claudeHomeDir(workspaceId) : null;
          return {
            ...request,
            env: {
              ...request.env,
              PASEO_SANDBOX_ROUTE: "host",
              ...(claudeHome && existsSync(claudeHome) ? { CLAUDE_CONFIG_DIR: claudeHome } : {}),
            },
          };
        }
        case "sandbox":
          break;
      }
      const { sandbox } = route;
      // Agents from before the plugin marked them; a new agent is marked once it exists.
      if (
        request.reason !== "create" &&
        request.purpose === "interactive" &&
        marker?.workspaceId !== sandbox.workspaceId
      ) {
        markSandboxed(paseo, request.agentId, sandbox.workspaceId);
      }
      // The container runs, and the Claude folder is decided, before the session starts: the
      // daemon needs CLAUDE_CONFIG_DIR now, and an agent waits only so long for its CLI. Within the
      // hook's 30 seconds; a first image pull goes on in the background.
      await (await resolve(paseo)).readyWithin(sandbox.workspaceId, 25_000);
      const ready = store.get(sandbox.workspaceId) ?? sandbox;
      // A launch is when the token matters; picks up a host /login or /logout made since the
      // last minute's check.
      if (ready.claudeHome === "private") await login.sync().catch(() => undefined);
      return {
        ...request,
        env: {
          ...request.env,
          PASEO_SANDBOX_WORKSPACE_ID: ready.workspaceId,
          // The daemon finds the session's transcripts here too: it reads CLAUDE_CONFIG_DIR from
          // the launch environment, and the hook's env is applied over the provider's.
          ...(ready.claudeHome === "private"
            ? { CLAUDE_CONFIG_DIR: store.claudeHomeDir(ready.workspaceId) }
            : {}),
        },
      };
    }),

    server.addHook("workspace.archive.after", async ({ workspace }, { paseo }) => {
      await (await resolve(paseo)).destroy(workspace.id);
    }),
  ];
}
