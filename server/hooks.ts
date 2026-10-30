import { existsSync } from "node:fs";
import type { PaseoApi } from "./paseo";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { ClaudeLoginKeeper } from "./claude-login";
import { CONTAINED_ACP_CAPABILITIES, type ProfileManager } from "./profiles";
import type { SandboxService } from "./service";
import type { SandboxStore } from "./store";

export function registerHooks(input: {
  server: PluginServerContext;
  store: SandboxStore;
  loaded: Promise<{ profiles: ProfileManager; login: ClaudeLoginKeeper }>;
  resolve: (paseo: PaseoApi) => Promise<SandboxService>;
}): Array<() => void> {
  const { server, store, loaded, resolve } = input;
  return [
    // Route every new agent in a sandboxed workspace to a sandboxed profile of the provider it
    // asked for, derived from that provider's current configuration.
    server.before("agent.create", async ({ request }, { paseo }) => {
      const { profiles } = await loaded;
      const sandbox = store.findByCwd(request.config.cwd);
      const provider = request.config.provider;
      if (!sandbox) {
        if (profiles.isDerived(provider)) {
          throw new Error(
            "Sandboxed providers run only in sandboxed workspaces. Create one with New sandboxed workspace.",
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

    // Tell the wrapper which container a session belongs to. Resume, refresh, and import pass
    // through here too, so an agent saved with a host provider cannot reopen inside a sandbox.
    server.before("agent.session_open", async ({ request }, { paseo }) => {
      const { profiles, login } = await loaded;
      // agent.create only sees the agent's directory, so a sandbox on a directory that other
      // workspaces share also takes their new agents. Agents already running in those workspaces
      // keep their host provider: only the sandboxed workspace itself refuses one.
      const ownSandbox = request.workspaceId
        ? store.get(request.workspaceId)
        : store.findByCwd(request.cwd);
      if (!profiles.isDerived(request.provider)) {
        if (ownSandbox && request.purpose === "interactive") {
          throw new Error(
            `This workspace is sandboxed; ${request.provider} would run on the host. Start a new agent instead.`,
          );
        }
        return undefined;
      }
      const sandbox = ownSandbox ?? store.findByCwd(request.cwd);
      if (!sandbox) {
        // An archived workspace's agents still show their history; providers that read it
        // through their CLI (Codex) do so on the host, and the daemon reads Claude's transcripts
        // from the workspace's private folder, which outlives the sandbox. They cannot run again.
        if (request.purpose === "history") {
          const claudeHome = request.workspaceId ? store.claudeHomeDir(request.workspaceId) : null;
          return {
            ...request,
            env: {
              ...request.env,
              PASEO_SANDBOX_ROUTE: "host",
              ...(claudeHome && existsSync(claudeHome) ? { CLAUDE_CONFIG_DIR: claudeHome } : {}),
            },
          };
        }
        throw new Error("This agent's workspace is no longer sandboxed.");
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

    server.on("workspace.archived", async ({ workspace }, { paseo }) => {
      await (await resolve(paseo)).destroy(workspace.id);
    }),
  ];
}
