import type { PluginWorkspaceRowBadgeItemProps } from "@getpaseo/plugin/client";
import { WorkspaceRowBadge, type WorkspaceRowBadgeTone } from "@getpaseo/plugin/client/ui";
import { useCallback, useSyncExternalStore } from "react";
import { badgeLook, type BadgeState, type SandboxBadges } from "./sandbox-state";

const TONES: Record<BadgeState["state"], WorkspaceRowBadgeTone> = {
  starting: "info",
  ready: "success",
  failed: "danger",
  "sign-in": "warning",
};

/** The sandbox's state on a sandboxed workspace's sidebar row; nothing on other workspaces. */
export function SandboxRowBadge({
  badges,
  workspaceId,
}: PluginWorkspaceRowBadgeItemProps & { badges: SandboxBadges }) {
  const read = useCallback(() => badges.get(workspaceId), [badges, workspaceId]);
  const state = useSyncExternalStore(badges.subscribe, read);
  if (!state) return null;
  const look = badgeLook(state);
  return (
    <WorkspaceRowBadge
      icon={look.icon}
      label={look.label}
      tone={TONES[state.state]}
      accessibilityLabel={state.state === "ready" ? look.label : `${look.label}: ${look.title}`}
    />
  );
}
