import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useRpc,
  useSettings,
  type PluginSurfaceProps,
  type SettingsState,
} from "@getpaseo/plugin/client";
import {
  Loading,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useState } from "react";
import { Text } from "react-native";
import { listContainerProfilesRpc, type ContainerProfile } from "../shared/rpc";
import { sandboxSettings } from "../shared/settings";
import { ProfileEditor, type ProfileEditorTarget } from "./profile-editor";

type Ready = Extract<SettingsState<typeof sandboxSettings.schema>, { status: "ready" }>;

function ContainerCli({ settings }: { settings: Ready }) {
  // Keep the draft's revision so another client's save produces a conflict.
  const [draft, setDraft] = useState(() => ({
    values: settings.values,
    revision: settings.revision,
  }));
  const change = useCallback(
    (containerCli: string) =>
      setDraft((current) => ({ ...current, values: { ...current.values, containerCli } })),
    [],
  );
  const save = useCallback(async () => {
    if (await settings.save(draft.values, draft.revision)) await settings.reload();
  }, [settings, draft]);
  return (
    <SettingsSection title="Containers">
      <SettingsCard>
        <SettingsInput
          label="Container CLI"
          hint="docker or podman, or an absolute path; used by every sandbox"
          initialValue={draft.values.containerCli}
          onChangeText={change}
          disabled={settings.saving}
        />
        <SettingsAction
          label="Changes apply to containers started from now on"
          actionLabel={settings.saving ? "Saving…" : "Save"}
          onPress={save}
          disabled={settings.saving}
          error={settings.saveError}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function ProfileRow({
  profile,
  isDefault,
  onEdit,
}: {
  profile: ContainerProfile;
  isDefault: boolean;
  onEdit(profile: ContainerProfile): void;
}) {
  const edit = useCallback(() => onEdit(profile), [onEdit, profile]);
  return (
    <SettingsAction
      label={isDefault ? `${profile.name} (default)` : profile.name}
      hint={profile.image}
      actionLabel="Edit"
      onPress={edit}
    />
  );
}

/** Saved container profiles. Each workspace keeps a copy of the profile it was created with. */
function ContainerProfiles() {
  const listProfiles = useRpc(listContainerProfilesRpc);
  const queryClient = useQueryClient();
  const profiles = useQuery({ queryKey: ["container-profiles"], queryFn: () => listProfiles({}) });
  const [target, setTarget] = useState<ProfileEditorTarget | null>(null);
  const data = profiles.data;
  const edit = useCallback(
    (profile: ContainerProfile) => {
      if (!data) return;
      setTarget({
        mode: "edit",
        profile,
        isDefault: profile.id === data.defaultId,
        canDelete: data.profiles.length > 1,
      });
    },
    [data],
  );
  const create = useCallback(() => setTarget({ mode: "new" }), []);
  const close = useCallback(() => setTarget(null), []);
  const saved = useCallback(() => {
    setTarget(null);
    void queryClient.invalidateQueries({ queryKey: ["container-profiles"] });
  }, [queryClient]);
  if (!data) return <Loading />;
  return (
    <SettingsSection title="Container profiles">
      <SettingsCard>
        {data.profiles.map((profile) => (
          <ProfileRow
            key={profile.id}
            profile={profile}
            isDefault={profile.id === data.defaultId}
            onEdit={edit}
          />
        ))}
        <SettingsAction
          label="Add a profile for another image or network"
          actionLabel="New profile"
          onPress={create}
        />
      </SettingsCard>
      <ProfileEditor target={target} onClose={close} onSaved={saved} />
    </SettingsSection>
  );
}

export function SandboxSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(sandboxSettings);
  const error = useMemo(() => ({ color: theme.colors.statusDanger }), [theme]);
  if (settings.status === "loading") return <Loading />;
  if (settings.status !== "ready") return <Text style={error}>{settings.error}</Text>;
  return (
    <>
      <ContainerCli settings={settings} />
      <ContainerProfiles />
    </>
  );
}
