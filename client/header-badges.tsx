import type {
  PluginButtonBehavior,
  PluginButtonMenuEntry,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { z } from "zod";
import {
  listSandboxesRpc,
  listTerminalProfilesRpc,
  openSandboxShellRpc,
  SANDBOX_METADATA_KEY,
  WorkspaceSandboxRequestSchema,
  type SandboxTerminalProfile,
} from "../shared/rpc";
import {
  badgeLook,
  badgeStateOf,
  FAILED_POLL_MS,
  LOGIN_POLL_MS,
  STARTING_POLL_MS,
  type BadgeState,
  type SandboxBadges,
} from "./sandbox-state";
import { HEADER_ICONS } from "./status-icons";

const TERMINAL_ICON = "SquareTerminal";

interface HeaderButtons {
  badge: PluginButtonRegistration;
  terminal: PluginButtonRegistration;
  look: string;
}

const WorkspaceUpsertSchema = z.object({
  type: z.literal("workspace_update"),
  payload: z.object({
    kind: z.literal("upsert"),
    workspace: z.object({ id: z.string(), metadata: z.record(z.string(), z.unknown()).optional() }),
  }),
});

/** Whether a workspace update is for a workspace whose sandbox the server is still adding. */
function awaitsSandbox(message: unknown, known: (id: string) => boolean): boolean {
  const update = WorkspaceUpsertSchema.safeParse(message);
  if (!update.success) return false;
  const { workspace } = update.data.payload;
  return (
    !known(workspace.id) &&
    WorkspaceSandboxRequestSchema.safeParse(workspace.metadata?.[SANDBOX_METADATA_KEY]).success
  );
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
export function contributeHeaderBadges(
  client: PluginClientContext,
  badges: SandboxBadges,
): () => void {
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
        icon: HEADER_ICONS[badgeState.state],
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

  /** Updates the badge's label, tooltip, and colored icon when the sandbox's state changes. */
  const showBadge = (workspaceId: string, badgeState: BadgeState) => {
    const registered = buttons.get(workspaceId);
    const look = badgeLook(badgeState);
    if (registered && registered.look !== JSON.stringify(look)) {
      registered.look = JSON.stringify(look);
      registered.badge.update({ ...look, icon: HEADER_ICONS[badgeState.state] });
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
    const states = new Map<string, BadgeState>();
    for (const sandbox of sandboxes) {
      const state = badgeStateOf(sandbox, claudeLogin);
      states.set(sandbox.workspaceId, state);
      if (!buttons.has(sandbox.workspaceId)) add(sandbox.workspaceId, state, profiles);
      showBadge(sandbox.workspaceId, state);
    }
    badges.set(states);
    if (sandboxes.some((sandbox) => sandbox.health.state === "starting")) {
      schedulePoll(STARTING_POLL_MS);
    } else if (sandboxes.some((sandbox) => sandbox.health.state === "failed")) {
      schedulePoll(FAILED_POLL_MS);
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

  // Workspace changes are when a sandbox can appear or disappear. New sandboxed workspace registers
  // a sandbox before it creates the workspace; one from Paseo's New workspace screen gets its
  // sandbox just after, so the list is asked again shortly.
  void client.paseo.workspaces
    .list({ subscribe: {} })
    .then(({ subscription }) => {
      if (stopped) return subscription.release();
      release = () => subscription.release();
      subscription.subscribe({
        snapshot: refreshLogged,
        update(message) {
          refreshLogged();
          if (awaitsSandbox(message, (id) => buttons.has(id))) schedulePoll(STARTING_POLL_MS);
        },
      });
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
