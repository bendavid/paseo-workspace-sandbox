import type { ClaudeLogin, SandboxHealth, SandboxRecord } from "../shared/rpc";

// Nothing pushes state to the app, so the list is polled: quickly while a sandbox starts, often
// while one has failed, since the Sandbox panel's download or go-ahead starts it again, and once a
// minute while a sandbox depends on the host's Claude login, which /logout ends at once.
export const STARTING_POLL_MS = 2_000;
export const FAILED_POLL_MS = 5_000;
export const LOGIN_POLL_MS = 60_000;

export type BadgeState = SandboxHealth | { state: "sign-in"; message: string };

/** A running sandbox with a private Claude folder can't sign in while the host is signed out. */
export function badgeStateOf(
  sandbox: SandboxRecord & { health: SandboxHealth },
  login: ClaudeLogin,
): BadgeState {
  if (sandbox.health.state !== "ready" || sandbox.claudeHome !== "private") return sandbox.health;
  if (login.state === "signed-out" || login.state === "refresh-failed") {
    return { state: "sign-in", message: login.message };
  }
  return sandbox.health;
}

/** The Lucide icon of each state, in the header and the sidebar. */
export const BADGE_ICONS: Record<BadgeState["state"], string> = {
  starting: "Hourglass",
  ready: "Box",
  failed: "TriangleAlert",
  "sign-in": "KeyRound",
};

export function badgeLook(badge: BadgeState): { label: string; icon: string; title: string } {
  const icon = BADGE_ICONS[badge.state];
  switch (badge.state) {
    case "starting":
      return { label: "Sandbox starting", icon, title: "Sandbox status" };
    case "ready":
      return { label: "Sandboxed", icon, title: "Sandbox status" };
    case "failed":
      return { label: "Sandbox failed", icon, title: badge.error };
    case "sign-in":
      return { label: "Sign in on host", icon, title: badge.message };
  }
}

/** The badge state of each sandboxed workspace on one host, as last listed. */
export class SandboxBadges {
  private states = new Map<string, BadgeState>();
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get(workspaceId: string): BadgeState | null {
    return this.states.get(workspaceId) ?? null;
  }

  /** Replaces the states; listeners hear of it only when one changed. */
  set(states: Map<string, BadgeState>): void {
    const key = (map: Map<string, BadgeState>) => JSON.stringify([...map].sort());
    if (key(states) === key(this.states)) return;
    this.states = states;
    for (const listener of this.listeners) listener();
  }
}
