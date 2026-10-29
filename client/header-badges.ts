import type {
  PluginButtonBehavior,
  PluginButtonMenuEntry,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import {
  listSandboxesRpc,
  listTerminalProfilesRpc,
  openSandboxShellRpc,
  type ClaudeLogin,
  type SandboxHealth,
  type SandboxRecord,
  type SandboxTerminalProfile,
} from "../shared/rpc";

const TERMINAL_ICON = "SquareTerminal";
// Nothing pushes state to the app, so the list is polled: quickly while a sandbox starts, and
// once a minute while a sandbox depends on the host's Claude login, which /logout ends at once.
const STARTING_POLL_MS = 2_000;
const LOGIN_POLL_MS = 60_000;

interface HeaderButtons {
  badge: PluginButtonRegistration;
  terminal: PluginButtonRegistration;
  look: string;
}

type BadgeState = SandboxHealth | { state: "sign-in"; message: string };

/** A running sandbox with a private Claude folder can't sign in while the host is signed out. */
function badgeStateOf(
  sandbox: SandboxRecord & { health: SandboxHealth },
  login: ClaudeLogin,
): BadgeState {
  if (sandbox.health.state !== "ready" || sandbox.claudeHome !== "private") return sandbox.health;
  if (login.state === "signed-out" || login.state === "refresh-failed") {
    return { state: "sign-in", message: login.message };
  }
  return sandbox.health;
}

function badgeLook(badge: BadgeState): { label: string; icon: string; title: string } {
  switch (badge.state) {
    case "starting":
      return { label: "Sandbox starting", icon: "Hourglass", title: "Sandbox status" };
    case "ready":
      return { label: "Sandboxed", icon: "Box", title: "Sandbox status" };
    case "failed":
      return { label: "Sandbox failed", icon: "TriangleAlert", title: badge.error };
    case "sign-in":
      return { label: "Sign in on host", icon: "KeyRound", title: badge.message };
  }
}

/** The terminal button's menu: a login shell, then each terminal profile, run in the container. */
function terminalMenu(
  client: PluginClientContext,
  workspaceId: string,
  profiles: readonly SandboxTerminalProfile[],
): PluginButtonBehavior {
  const open = (profileId?: string) => async () => {
    await client.rpc(openSandboxShellRpc, { workspaceId, ...(profileId ? { profileId } : {}) });
  };
  const items: PluginButtonMenuEntry[] = [
    {
      kind: "item",
      id: "terminal",
      title: "Terminal",
      icon: TERMINAL_ICON,
      behavior: { kind: "action", onPress: open() },
    },
  ];
  if (profiles.length > 0) items.push({ kind: "separator", id: "profiles" });
  // Menu item IDs allow only lowercase letters, digits, and dashes; profile IDs are free-form.
  for (const [index, profile] of profiles.entries()) {
    items.push({
      kind: "item",
      id: `profile-${index}`,
      title: profile.name,
      icon: TERMINAL_ICON,
      behavior: { kind: "action", onPress: open(profile.id) },
    });
  }
  return { kind: "menu", items };
}

/**
 * Shows a "Sandboxed" header button on every sandboxed workspace, and beside it a terminal button
 * whose menu opens a terminal or a terminal profile inside the container.
 */
export function contributeHeaderBadges(client: PluginClientContext): () => void {
  const buttons = new Map<string, HeaderButtons>();
  let stopped = false;
  let release: (() => Promise<void>) | null = null;
  let profilesKey = "";
  let poll: { timer: ReturnType<typeof setTimeout>; at: number } | null = null;

  const add = (
    workspaceId: string,
    badgeState: BadgeState,
    profiles: readonly SandboxTerminalProfile[],
  ) => {
    const look = badgeLook(badgeState);
    const badge = client.addHeaderButton({
      id: "sandbox",
      workspaceId,
      button: {
        ...look,
        behavior: {
          kind: "action",
          onPress() {
            client.openPanel("sandbox", { workspaceId });
          },
        },
      },
    });
    const terminal = client.addHeaderButton({
      id: "sandbox-terminal",
      workspaceId,
      button: {
        title: "Open sandboxed terminal",
        icon: TERMINAL_ICON,
        behavior: terminalMenu(client, workspaceId, profiles),
      },
    });
    buttons.set(workspaceId, {
      badge,
      terminal,
      look: JSON.stringify(look),
    });
  };

  /** Updates the badge. The New sandboxed workspace form reports its own sandbox's failures. */
  const showBadge = (workspaceId: string, badgeState: BadgeState) => {
    const registered = buttons.get(workspaceId);
    const look = badgeLook(badgeState);
    if (registered && registered.look !== JSON.stringify(look)) {
      registered.look = JSON.stringify(look);
      registered.badge.update(look);
    }
  };

  const refresh = async () => {
    const [{ sandboxes, claudeLogin }, { profiles }] = await Promise.all([
      client.rpc(listSandboxesRpc, {}),
      client.rpc(listTerminalProfilesRpc, {}),
    ]);
    if (stopped) return;
    const ids = new Set(sandboxes.map((sandbox) => sandbox.workspaceId));
    for (const [workspaceId, registered] of buttons) {
      if (ids.has(workspaceId)) continue;
      registered.badge.remove();
      registered.terminal.remove();
      buttons.delete(workspaceId);
    }
    // Menus are fixed when registered, so rebuild them when the profiles change.
    const nextKey = JSON.stringify(profiles.map((profile) => [profile.id, profile.name]));
    if (nextKey !== profilesKey) {
      profilesKey = nextKey;
      for (const [workspaceId, registered] of buttons) {
        registered.terminal.update({ behavior: terminalMenu(client, workspaceId, profiles) });
      }
    }
    for (const sandbox of sandboxes) {
      const state = badgeStateOf(sandbox, claudeLogin);
      if (!buttons.has(sandbox.workspaceId)) add(sandbox.workspaceId, state, profiles);
      showBadge(sandbox.workspaceId, state);
    }
    if (sandboxes.some((sandbox) => sandbox.health.state === "starting")) {
      schedulePoll(STARTING_POLL_MS);
    } else if (sandboxes.some((sandbox) => sandbox.claudeHome === "private")) {
      schedulePoll(LOGIN_POLL_MS);
    }
  };
  const refreshLogged = () => {
    refresh().catch((error) => {
      if (!stopped) console.error("Sandbox list failed", error);
    });
  };
  const schedulePoll = (delayMs: number) => {
    if (stopped) return;
    const at = Date.now() + delayMs;
    if (poll && poll.at <= at) return;
    if (poll) clearTimeout(poll.timer);
    poll = {
      at,
      timer: setTimeout(() => {
        poll = null;
        refreshLogged();
      }, delayMs),
    };
  };

  // Workspace changes are when a sandbox can appear or disappear. The server registers a sandbox
  // under its workspace ID before creating the workspace, so the list is already current.
  void client.paseo.workspaces
    .list({ subscribe: {} })
    .then(({ subscription }) => {
      if (stopped) return subscription.release();
      release = () => subscription.release();
      subscription.subscribe({ snapshot: refreshLogged, update: refreshLogged });
      return undefined;
    })
    .catch((error) => {
      if (!stopped) console.error("Workspace observation failed", error);
    });

  return () => {
    stopped = true;
    if (poll) clearTimeout(poll.timer);
    void release?.();
    for (const registered of buttons.values()) {
      registered.badge.remove();
      registered.terminal.remove();
    }
    buttons.clear();
  };
}
