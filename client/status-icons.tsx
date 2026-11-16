import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginButtonIconProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { ComponentType } from "react";
import { BADGE_ICONS, type BadgeState } from "./sandbox-state";

type StateName = BadgeState["state"];

/** The theme color of each state; Paseo's themes have no info color, so a start uses the accent. */
const COLORS: Record<StateName, keyof PluginTheme["colors"]> = {
  starting: "accent",
  ready: "statusSuccess",
  failed: "statusDanger",
  "sign-in": "statusWarning",
};

/**
 * The header button's icon for a state, in that state's color. The host passes its own icon
 * color; the label keeps it.
 */
function coloredIcon(state: StateName): ComponentType<PluginButtonIconProps> {
  const name = BADGE_ICONS[state];
  function SandboxStatusIcon({ size, theme }: PluginButtonIconProps) {
    return <Icon name={name} size={size} color={theme.colors[COLORS[state]]} />;
  }
  return SandboxStatusIcon;
}

/** Stable components, so an update only swaps the icon when the state changes. */
export const HEADER_ICONS: Record<StateName, ComponentType<PluginButtonIconProps>> = {
  starting: coloredIcon("starting"),
  ready: coloredIcon("ready"),
  failed: coloredIcon("failed"),
  "sign-in": coloredIcon("sign-in"),
};
