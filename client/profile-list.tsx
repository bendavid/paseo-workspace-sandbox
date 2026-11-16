import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useCallback, useState } from "react";
import { describeProfile, listContainerProfilesRpc, type ContainerProfile } from "../shared/rpc";
import type { ProfileEditorTarget } from "./profile-editor";

type ProfileListData = { profiles: ContainerProfile[]; defaultId: string };

/** The saved profiles and which one the editor has open, if any. */
export function useProfileList() {
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
  return { data, target, edit, create, close, saved };
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
      hint={describeProfile(profile)}
      actionLabel="Edit"
      onPress={edit}
    />
  );
}

/** Saved container profiles. Each workspace keeps a copy of the profile it was created with. */
export function ProfileList({
  data,
  onEdit,
  onCreate,
}: {
  data: ProfileListData;
  onEdit(profile: ContainerProfile): void;
  onCreate(): void;
}) {
  return (
    <SettingsSection title="Container profiles">
      <SettingsCard>
        {data.profiles.map((profile) => (
          <ProfileRow
            key={profile.id}
            profile={profile}
            isDefault={profile.id === data.defaultId}
            onEdit={onEdit}
          />
        ))}
        <SettingsAction
          label="Add a profile for another engine, image, or network"
          actionLabel="New profile"
          onPress={onCreate}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
