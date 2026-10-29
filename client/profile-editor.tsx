import { useMutation } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import {
  Modal,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useState } from "react";
import {
  deleteContainerProfileRpc,
  saveContainerProfileRpc,
  type ContainerProfile,
} from "../shared/rpc";

const NETWORKS = [
  { label: "Host (Paseo tools reach the daemon)", value: "host" },
  { label: "Bridge", value: "bridge" },
  { label: "None", value: "none" },
] as const;

const BLANK: Omit<ContainerProfile, "id"> = {
  name: "",
  image: "docker.io/library/node:22-bookworm-slim",
  network: "host",
  extraMounts: "",
  extraRunArgs: "",
};

export type ProfileEditorTarget =
  | { mode: "new"; from?: ContainerProfile }
  | { mode: "edit"; profile: ContainerProfile; isDefault: boolean; canDelete: boolean };

interface ProfileEditorProps {
  target: ProfileEditorTarget | null;
  onClose(): void;
  /** Called with the saved profile, or null after a delete. */
  onSaved(profile: ContainerProfile | null): void;
}

type Draft = Omit<ContainerProfile, "id">;

/** The editable fields only: the ID comes from the target on save, so a copy never reuses it. */
function fields(profile: ContainerProfile): Draft {
  return {
    name: profile.name,
    image: profile.image,
    network: profile.network,
    extraMounts: profile.extraMounts,
    extraRunArgs: profile.extraRunArgs,
  };
}

function initialDraft(target: ProfileEditorTarget | null): Draft {
  if (!target) return BLANK;
  if (target.mode === "edit") return fields(target.profile);
  return target.from ? { ...fields(target.from), name: `${target.from.name} copy` } : BLANK;
}

function targetKey(target: ProfileEditorTarget): string {
  return target.mode === "edit" ? `edit:${target.profile.id}` : `new:${target.from?.id ?? ""}`;
}

/**
 * Adds or edits a saved container profile. Workspaces copy a profile when they are created, so
 * saving here never changes an existing workspace's container.
 */
export function ProfileEditor({ target, onClose, onSaved }: ProfileEditorProps) {
  const openChange = useCallback(
    (open: boolean) => {
      if (!open) onClose();
    },
    [onClose],
  );
  return (
    <Modal
      title={target?.mode === "edit" ? "Edit container profile" : "New container profile"}
      open={target !== null}
      onOpenChange={openChange}
    >
      <Modal.Content>
        {/* Settings inputs read their initial value once, so each target mounts a fresh form. */}
        {target ? <EditorForm key={targetKey(target)} target={target} onSaved={onSaved} /> : null}
      </Modal.Content>
    </Modal>
  );
}

function EditorForm({
  target,
  onSaved,
}: {
  target: ProfileEditorTarget;
  onSaved(profile: ContainerProfile | null): void;
}) {
  const save = useRpc(saveContainerProfileRpc);
  const remove = useRpc(deleteContainerProfileRpc);
  const [draft, setDraft] = useState<Draft>(() => initialDraft(target));
  const [makeDefault, setMakeDefault] = useState(target.mode === "edit" && target.isDefault);
  const saving = useMutation({
    mutationFn: save,
    onSuccess: ({ saved }) => onSaved(saved),
  });
  const deleting = useMutation({
    mutationFn: remove,
    onSuccess: () => onSaved(null),
  });
  const busy = saving.isPending || deleting.isPending;
  const field = useCallback(
    <Key extends keyof Draft>(key: Key) =>
      (value: Draft[Key]) =>
        setDraft((current) => ({ ...current, [key]: value })),
    [],
  );
  const submit = useCallback(() => {
    saving.mutate({
      profile: { ...draft, ...(target.mode === "edit" ? { id: target.profile.id } : {}) },
      makeDefault,
    });
  }, [draft, makeDefault, saving, target]);
  const destroy = useCallback(() => {
    if (target.mode === "edit") deleting.mutate({ id: target.profile.id });
  }, [deleting, target]);
  const error = saving.error?.message ?? deleting.error?.message ?? null;
  const editing = target.mode === "edit";
  return (
    <>
      <SettingsCard>
        <SettingsInput
          label="Name"
          initialValue={draft.name}
          onChangeText={field("name")}
          disabled={busy}
        />
        <SettingsInput
          label="Image"
          hint="Must provide the agent CLIs, or mount them below"
          initialValue={draft.image}
          onChangeText={field("image")}
          disabled={busy}
        />
        <SettingsSelect
          label="Network"
          value={draft.network}
          options={NETWORKS}
          onValueChange={field("network")}
          disabled={busy}
        />
        <SettingsInput
          label="Extra mounts"
          hint="Host paths mounted at the same path, comma separated; append :ro for read-only"
          initialValue={draft.extraMounts}
          onChangeText={field("extraMounts")}
          disabled={busy}
        />
        <SettingsInput
          label="Extra run arguments"
          hint="Added to the container's run command, such as --memory 4g"
          initialValue={draft.extraRunArgs}
          onChangeText={field("extraRunArgs")}
          disabled={busy}
        />
        <SettingsSwitch
          label="Default profile"
          hint="Preselected for new sandboxed workspaces"
          value={makeDefault}
          onValueChange={setMakeDefault}
          disabled={busy || (editing && target.isDefault)}
        />
      </SettingsCard>
      <SettingsCard>
        <SettingsAction
          label={editing ? "Existing workspaces keep their copy" : "Saved for new workspaces"}
          actionLabel={saving.isPending ? "Saving…" : "Save"}
          onPress={submit}
          disabled={busy || !draft.name.trim() || !draft.image.trim()}
          error={error}
        />
        {editing && target.canDelete ? (
          <SettingsAction
            label="Delete this profile"
            actionLabel={deleting.isPending ? "Deleting…" : "Delete"}
            onPress={destroy}
            disabled={busy}
          />
        ) : null}
      </SettingsCard>
    </>
  );
}
