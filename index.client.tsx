import type {
  PluginClientContext,
  PluginWorkspaceRowBadgeItemProps,
} from "@getpaseo/plugin/client";
import { contributeHeaderBadges } from "./client/header-badges";
import { NewWorkspaceSandboxField } from "./client/new-workspace-field";
import { SandboxPanel } from "./client/sandbox-panel";
import { SandboxBadges } from "./client/sandbox-state";
import { SandboxSettingsScreen } from "./client/settings-screen";
import { SandboxRowBadge } from "./client/workspace-row-badge";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "sandbox",
    title: "Sandbox",
    icon: "Box",
    context: "workspace",
    Component: SandboxPanel,
  });
  client.addCommandCenterItem({
    id: "status",
    title: "Sandbox status",
    icon: "Box",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("sandbox");
    },
  });
  client.addSettingsScreen({
    id: "sandbox",
    title: "Sandbox",
    icon: "Box",
    Component: SandboxSettingsScreen,
  });
  // Sandboxed workspaces are made on Paseo's own New workspace screen, with this field.
  const removeField = client.addNewWorkspaceItem({
    id: "sandbox",
    Component: NewWorkspaceSandboxField,
  });
  // One list per host feeds both the header buttons and the sidebar rows.
  const badges = new SandboxBadges();
  const removeRowBadge = client.addWorkspaceRowBadgeItem({
    id: "sandbox",
    title: "Sandbox",
    icon: "Box",
    Component: function RowBadge(props: PluginWorkspaceRowBadgeItemProps) {
      return <SandboxRowBadge {...props} badges={badges} />;
    },
  });
  const removeHeaderBadges = contributeHeaderBadges(client, badges);
  return () => {
    removeField();
    removeRowBadge();
    removeHeaderBadges();
  };
}
