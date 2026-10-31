import type { PaseoApi } from "./server/paseo";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ClaudeLoginKeeper, hostClaudeFromConfig } from "./server/claude-login";
import { ContainerProfiles } from "./server/container-profiles";
import { registerHooks } from "./server/hooks";
import { ProfileManager } from "./server/profiles";
import { SandboxService } from "./server/service";
import { SandboxStore, resolveDataDirectory } from "./server/store";
import { listTerminalProfiles } from "./server/terminals";
import { writeWrapper } from "./server/wrapper";
import {
  chooseImageRpc,
  createSandboxedWorkspaceRpc,
  deleteContainerProfileRpc,
  imageStatusRpc,
  listContainerProfilesRpc,
  listRefsRpc,
  listSandboxesRpc,
  listTerminalProfilesRpc,
  enableRelativeWorktreesRpc,
  openSandboxShellRpc,
  recreateSandboxRpc,
  restartSandboxRpc,
  sandboxDependentsRpc,
  relativeWorktreesStatusRpc,
  previewContainerCommandRpc,
  sandboxStatusRpc,
  saveContainerProfileRpc,
} from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  const store = new SandboxStore(resolveDataDirectory());
  // The plugin's own directory is not available at runtime, so the wrapper lives in the data
  // directory, where its path survives reloads, updates, and removal.
  const loaded = (async () => {
    await store.load();
    const wrapper = await writeWrapper(store.directory);
    const profiles = new ProfileManager(store, wrapper);
    const containerProfiles = new ContainerProfiles(store.directory);
    const login = new ClaudeLoginKeeper(store.authDirectory, () =>
      store.list().some((record) => record.claudeHome === "private"),
    );
    await login.start().catch((error) => console.error("Claude login keeper failed", error));
    await containerProfiles.load();
    const service = new SandboxService(store, containerProfiles, login, wrapper);
    return { service, profiles, containerProfiles, login };
  })();

  // The server entry receives no Paseo session; handlers and hooks do. The first one to run reads
  // the host's Claude login settings and reconciles sandboxes. The client entry calls an RPC on
  // load, so this happens when an app connects. Provider profiles are derived per agent, in the hook.
  let initialized: Promise<SandboxService> | null = null;
  const resolve = (paseo: PaseoApi): Promise<SandboxService> => {
    initialized ??= loaded
      .then(async ({ service, login }) => {
        await login.configure(hostClaudeFromConfig((await paseo.config.get()).config));
        service.reconcile(paseo).catch((error) => console.error("Sandbox reconcile failed", error));
        return service;
      })
      .catch((error: unknown) => {
        // Retry on the next call.
        initialized = null;
        throw error;
      });
    return initialized;
  };

  const removeHooks = registerHooks({ server, store, loaded, resolve });

  server.handle(createSandboxedWorkspaceRpc, async (input, { paseo }) =>
    (await resolve(paseo)).createWorkspace(input, paseo),
  );
  server.handle(listSandboxesRpc, async (_input, { paseo }) => (await resolve(paseo)).list());
  server.handle(listContainerProfilesRpc, async () => (await loaded).containerProfiles.snapshot());
  server.handle(saveContainerProfileRpc, async ({ profile, makeDefault }) => {
    const { containerProfiles } = await loaded;
    const saved = await containerProfiles.save(profile, makeDefault);
    return { ...containerProfiles.snapshot(), saved };
  });
  server.handle(sandboxDependentsRpc, async ({ workspaceId }, { paseo }) =>
    (await resolve(paseo)).dependents(workspaceId, paseo),
  );
  server.handle(restartSandboxRpc, async ({ workspaceId }, { paseo }) => {
    await (await resolve(paseo)).restart(workspaceId, paseo);
    return {};
  });
  server.handle(recreateSandboxRpc, async ({ workspaceId, profile }, { paseo }) => {
    await (await resolve(paseo)).recreate(workspaceId, profile, paseo);
    return {};
  });
  server.handle(relativeWorktreesStatusRpc, async ({ projectId }, { paseo }) =>
    (await resolve(paseo)).relativeWorktrees(projectId, paseo),
  );
  server.handle(enableRelativeWorktreesRpc, async ({ projectId }, { paseo }) =>
    (await resolve(paseo)).enableRelativeWorktrees(projectId, paseo),
  );
  server.handle(previewContainerCommandRpc, async ({ profile, context }, { paseo }) => ({
    command: await (await resolve(paseo)).previewCommand(profile, context, paseo),
  }));
  server.handle(deleteContainerProfileRpc, async ({ id }) => {
    const { containerProfiles } = await loaded;
    await containerProfiles.delete(id);
    return containerProfiles.snapshot();
  });
  server.handle(listRefsRpc, async (input, { paseo }) => (await resolve(paseo)).refs(input, paseo));
  server.handle(listTerminalProfilesRpc, async (_input, { paseo }) => {
    await resolve(paseo);
    return { profiles: await listTerminalProfiles(paseo) };
  });
  server.handle(sandboxStatusRpc, async ({ workspaceId }, { paseo }) =>
    (await resolve(paseo)).status(workspaceId),
  );
  server.handle(imageStatusRpc, async ({ profileId }, { paseo }) =>
    (await resolve(paseo)).imageStatus(profileId),
  );
  server.handle(chooseImageRpc, async ({ workspaceId, ...choice }, { paseo }) => {
    await (await resolve(paseo)).chooseImage(workspaceId, choice);
    return {};
  });
  server.handle(openSandboxShellRpc, async (input, { paseo }) =>
    (await resolve(paseo)).openShell(input, paseo),
  );

  return () => {
    for (const remove of removeHooks) remove();
    void loaded.then(({ login }) => login.stop()).catch(() => undefined);
  };
}
