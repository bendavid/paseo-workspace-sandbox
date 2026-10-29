import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ClaudeLoginKeeper, hostClaudeFromConfig } from "./server/claude-login";
import { ContainerProfiles } from "./server/container-profiles";
import { registerHooks } from "./server/hooks";
import { ProfileManager } from "./server/profiles";
import { SandboxService } from "./server/service";
import { SandboxStore, resolveDataDirectory } from "./server/store";
import { listTerminalProfiles, removeLegacyTerminalProfile } from "./server/terminals";
import { writeWrapper } from "./server/wrapper";
import {
  createSandboxedWorkspaceRpc,
  deleteContainerProfileRpc,
  listContainerProfilesRpc,
  listRefsRpc,
  listSandboxesRpc,
  listTerminalProfilesRpc,
  openSandboxShellRpc,
  sandboxStatusRpc,
  saveContainerProfileRpc,
} from "./shared/rpc";
import { sandboxSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(sandboxSettings);
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
    const service = new SandboxService(store, settings, containerProfiles, login, wrapper);
    await containerProfiles.load(() => service.profileSeed());
    // Model discovery and version checks for sandboxed providers run the host's CLI, assumed to
    // match the sandboxes'. Earlier versions ran them in a probe container.
    service
      .removeLegacyProbe()
      .catch((error: unknown) => console.error("Removing the probe container failed", error));
    return { service, profiles, containerProfiles, login };
  })();

  // The server entry receives no Paseo session; handlers and hooks do. The first one to run
  // removes the terminal profile earlier versions added and reconciles sandboxes. The client entry calls an RPC on load,
  // so this happens when an app connects. Provider profiles are derived per agent, in the hook.
  let initialized: Promise<SandboxService> | null = null;
  const resolve = (paseo: PaseoApi): Promise<SandboxService> => {
    initialized ??= loaded
      .then(async ({ service, login }) => {
        await removeLegacyTerminalProfile(paseo);
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
  server.handle(openSandboxShellRpc, async (input, { paseo }) =>
    (await resolve(paseo)).openShell(input, paseo),
  );

  return () => {
    for (const remove of removeHooks) remove();
    void loaded.then(({ login }) => login.stop()).catch(() => undefined);
  };
}
