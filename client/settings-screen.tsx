import type { PluginTheme } from "@getpaseo/plugin";
import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Loading, SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useCallback } from "react";
import { newWorkspaceSettings } from "../shared/settings";
import { ProfileEditor } from "./profile-editor";
import { ProfileList, useProfileList } from "./profile-list";

/** Saved container profiles. Each workspace keeps a copy of the profile it was created with. */
function ContainerProfiles({ theme }: { theme: PluginTheme }) {
  const list = useProfileList();
  if (!list.data) return <Loading />;
  return (
    <>
      <ProfileList data={list.data} onEdit={list.edit} onCreate={list.create} />
      <ProfileEditor target={list.target} theme={theme} onClose={list.close} onSaved={list.saved} />
    </>
  );
}

/** How the Sandbox field on Paseo's New workspace screen starts out. */
function NewWorkspaces() {
  const settings = useSettings(newWorkspaceSettings);
  const change = useCallback(
    (sandboxByDefault: boolean) => {
      if (settings.status !== "ready") return;
      void settings.save({ ...settings.values, sandboxByDefault }, settings.revision);
    },
    [settings],
  );
  return (
    <SettingsSection title="New workspaces">
      <SettingsCard>
        <SettingsSwitch
          label="Sandbox new workspaces by default"
          hint="The Sandbox field in New workspace starts with the default container profile instead of No sandbox."
          value={settings.status === "ready" && settings.values.sandboxByDefault}
          disabled={settings.status !== "ready" || settings.saving}
          error={
            settings.status === "error" || settings.status === "invalid"
              ? settings.error
              : settings.saveError
          }
          onValueChange={change}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

/** The plugin's settings: how new workspaces start, and the saved container profiles. */
export function SandboxSettingsScreen({ theme }: PluginSurfaceProps) {
  return (
    <>
      <NewWorkspaces />
      <ContainerProfiles theme={theme} />
    </>
  );
}
