import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useCallback } from "react";
import { contributeHeaderBadges } from "./client/header-badges";
import { NewSandboxedWorkspaceScreen } from "./client/new-workspace-screen";
import { SandboxPanel } from "./client/sandbox-panel";
import { SandboxSettingsScreen } from "./client/settings-screen";

function NewSandboxedWorkspaceItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const open = useCallback(() => openScreen({ screenId: "new-workspace" }), [openScreen]);
  return (
    <SidebarRow icon="Box" active={currentScreen?.screenId === "new-workspace"} onPress={open} />
  );
}

export default function contribute(client: PluginClientContext) {
  // The body carries "New sandboxed workspace" as New workspace does; the host header names the
  // plugin so the two titles do not repeat.
  client.addScreen({
    id: "new-workspace",
    title: "Workspace sandbox",
    Component: NewSandboxedWorkspaceScreen,
  });
  // Project rows have no plugin slot, so the entry points are the sidebar header, the Command
  // Center, and a workspace-context command that preselects the current project.
  client.addSidebarHeaderItem({
    id: "new-workspace",
    title: "New sandboxed workspace",
    Component: NewSandboxedWorkspaceItem,
  });
  client.addCommandCenterItem({
    id: "new-workspace",
    title: "New sandboxed workspace",
    icon: "Box",
    keywords: ["sandbox", "container"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "new-workspace" });
    },
  });
  client.addCommandCenterItem({
    id: "new-workspace-in-project",
    title: "New sandboxed workspace in this project",
    icon: "Box",
    keywords: ["sandbox", "container"],
    context: "workspace",
    onSelect({ openScreen, workspace }) {
      openScreen({ screenId: "new-workspace", params: { projectId: workspace.projectId } });
    },
  });
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
  return contributeHeaderBadges(client);
}
