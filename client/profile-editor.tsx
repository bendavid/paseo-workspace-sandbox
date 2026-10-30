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
  DEFAULT_IMAGE,
  ENGINE_NETWORKS,
  defaultNetwork,
  deleteContainerProfileRpc,
  engineUsesImage,
  engineHasUserChoice,
  imageHint,
  isValidImage,
  saveContainerProfileRpc,
  type ContainerProfile,
  type Engine,
  type Network,
} from "../shared/rpc";

const ENGINE_OPTIONS = [
  { label: "Podman", value: "podman" },
  { label: "Docker", value: "docker" },
  { label: "Bubblewrap (host system, no image)", value: "bubblewrap" },
  { label: "microsandbox (microVM)", value: "microsandbox" },
  { label: "Apptainer", value: "apptainer" },
  { label: "Singularity", value: "singularity" },
] as const;

const DEFAULT_COMMANDS: Record<Engine, string> = {
  podman: "podman",
  docker: "docker",
  bubblewrap: "bwrap",
  microsandbox: "msb",
  apptainer: "apptainer",
  singularity: "singularity",
};

/** What each engine's run command is called, for the extra arguments hint. */
const RUN_COMMANDS: Record<Engine, string> = {
  podman: "podman run",
  docker: "docker run",
  bubblewrap: "bwrap",
  microsandbox: "msb create",
  apptainer: "apptainer exec",
  singularity: "singularity exec",
};

const LOOPBACK_WARNING =
  "Host shares the host's network, including services on its loopback such as the Paseo daemon";

const NETWORK_HINTS: Record<Engine, string> = {
  podman: `Separate has its own network with internet access. ${LOOPBACK_WARNING}`,
  docker: `Separate has its own network with internet access. ${LOOPBACK_WARNING}`,
  microsandbox: `Separate allows the internet only. ${LOOPBACK_WARNING}`,
  bubblewrap: `${LOOPBACK_WARNING}; there is no separate network without root`,
  apptainer: `${LOOPBACK_WARNING}; there is no separate network without root`,
  singularity: `${LOOPBACK_WARNING}; there is no separate network without root`,
};

const NETWORK_LABELS: Record<Network, string> = {
  host: "Host",
  bridge: "Separate",
  none: "None",
};

/** The engine's networks; a choice it lacks, from a profile saved before, shows as Host. */
function networkOptions(engine: Engine) {
  return ENGINE_NETWORKS[engine].map((value) => ({ label: NETWORK_LABELS[value], value }));
}

function supportedNetwork(engine: Engine, network: Network): Network {
  return ENGINE_NETWORKS[engine].includes(network) ? network : "host";
}

const BLANK: Omit<ContainerProfile, "id"> = {
  name: "",
  engine: "podman",
  cli: "",
  image: DEFAULT_IMAGE,
  network: defaultNetwork("podman"),
  extraMounts: "",
  extraRunArgs: "",
  runAsHostUser: true,
  shareAgentState: true,
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
    engine: profile.engine,
    cli: profile.cli ?? "",
    image: profile.image,
    network: supportedNetwork(profile.engine, profile.network),
    extraMounts: profile.extraMounts,
    extraRunArgs: profile.extraRunArgs,
    runAsHostUser: profile.runAsHostUser !== false,
    shareAgentState: profile.shareAgentState !== false,
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
  const selectEngine = useCallback((value: string) => {
    const choice = ENGINE_OPTIONS.find((option) => option.value === value);
    if (choice) {
      // A network left at the old engine's default follows to the new engine's.
      setDraft((current) => ({
        ...current,
        engine: choice.value,
        network:
          current.network === defaultNetwork(current.engine)
            ? defaultNetwork(choice.value)
            : supportedNetwork(choice.value, current.network),
      }));
    }
  }, []);
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
  const { engine } = draft;
  const needsImage = engineUsesImage(engine);
  return (
    <>
      <SettingsCard>
        <SettingsInput
          label="Name"
          initialValue={draft.name}
          onChangeText={field("name")}
          disabled={busy}
        />
        <SettingsSelect
          label="Engine"
          value={engine}
          options={ENGINE_OPTIONS}
          onValueChange={selectEngine}
          disabled={busy}
        />
        <SettingsInput
          label="Command"
          hint={`Leave empty for ${DEFAULT_COMMANDS[engine]} on PATH`}
          initialValue={draft.cli ?? ""}
          onChangeText={field("cli")}
          disabled={busy}
        />
        {needsImage ? (
          <SettingsInput
            label="Image"
            hint={`${imageHint(engine)}. It must provide the agent CLIs, or mount them below`}
            initialValue={draft.image}
            onChangeText={field("image")}
            disabled={busy}
          />
        ) : null}
        <SettingsSwitch
          label="Share agent sign-ins and history"
          hint={
            draft.shareAgentState !== false
              ? "Mounts ~/.codex and the other agents' folders, and gives Claude a private folder signed in with your host login"
              : "Agents start signed out unless the image or an extra mount provides credentials, and Paseo may not show their history"
          }
          value={draft.shareAgentState !== false}
          onValueChange={field("shareAgentState")}
          disabled={busy}
        />
        {engineHasUserChoice(engine) ? (
          <SettingsSwitch
            label="Run as host user"
            hint={
              draft.runAsHostUser !== false
                ? "Your uid and gid, with your home path as HOME and an account for you in the image"
                : "The image's default user and home; files it writes to mounts may belong to that user"
            }
            value={draft.runAsHostUser !== false}
            onValueChange={field("runAsHostUser")}
            disabled={busy}
          />
        ) : null}
        <SettingsSelect
          label="Network"
          hint={NETWORK_HINTS[engine]}
          value={draft.network}
          options={networkOptions(engine)}
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
          hint={`Added to ${RUN_COMMANDS[engine]}; quote values with spaces`}
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
          disabled={
            busy || !draft.name.trim() || (needsImage && !isValidImage(engine, draft.image.trim()))
          }
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
