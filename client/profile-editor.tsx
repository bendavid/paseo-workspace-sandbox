import type { PluginTheme } from "@getpaseo/plugin";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import {
  Modal,
  ScrollView,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { FONT } from "./standard-ui";
import {
  DEFAULT_IMAGE,
  DEFAULT_SANDBOX_FOLDER,
  ENGINE_NETWORKS,
  ENGINE_USER_MODES,
  defaultNetwork,
  deleteContainerProfileRpc,
  engineReadsWorkspaceConfig,
  engineUsesImage,
  imageHint,
  isValidImage,
  previewContainerCommandRpc,
  profileAgentState,
  profileUser,
  saveContainerProfileRpc,
  type AgentState,
  type ContainerProfile,
  type Engine,
  type Network,
  USER_LABELS,
  type UserMode,
  type WorkspacePaths,
} from "../shared/rpc";

const ENGINE_OPTIONS = [
  { label: "Podman", value: "podman" },
  { label: "Docker", value: "docker" },
  { label: "Bubblewrap (host system, no image)", value: "bubblewrap" },
  { label: "microsandbox (microVM)", value: "microsandbox" },
  { label: "Apptainer", value: "apptainer" },
  { label: "Singularity", value: "singularity" },
  { label: "Dev container (workspace devcontainer.json)", value: "devcontainer" },
] as const;

const DEFAULT_COMMANDS: Record<Engine, string> = {
  podman: "podman",
  docker: "docker",
  bubblewrap: "bwrap",
  microsandbox: "msb",
  apptainer: "apptainer",
  singularity: "singularity",
  devcontainer: "devcontainer",
};

/** What each engine's run command is called, for the extra arguments hint. */
const RUN_COMMANDS: Record<Engine, string> = {
  podman: "podman run",
  docker: "docker run",
  bubblewrap: "bwrap",
  microsandbox: "msb create",
  apptainer: "apptainer exec",
  singularity: "singularity exec",
  devcontainer: "devcontainer up",
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
  devcontainer: "Set by the workspace's devcontainer.json",
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

const USER_HINTS: Record<UserMode, string> = {
  host: "Your uid and gid, with your home path as HOME and an account for you in the image",
  squashed:
    "As Host user, but only your uid and gid exist inside, so the engine mounts as you, as NFS needs. The image's files appear as yours and nothing runs as root",
  image: "The image's default user and home; files it writes to mounts may belong to that user",
};

const AGENT_STATE_OPTIONS = [
  { label: "Isolated", value: "isolated" },
  { label: "Shared", value: "shared" },
  { label: "Off", value: "off" },
] as const;

const AGENT_STATE_HINTS: Record<AgentState, string> = {
  isolated:
    "Claude gets a private folder per workspace, signed in with your host login through a copy of its current token, with your settings and skills read-only. Other agents' folders aren't mounted",
  shared:
    "Your Claude folder and ~/.codex, ~/.copilot, ~/.pi, and ~/.omp are mounted read-write: agents use your host sign-ins, settings, and history, and can change them",
  off: "Agents start signed out unless the image, a mount, or a forwarded API key provides credentials, and Paseo may not show their history",
};

const PATH_OPTIONS = [
  { label: "Host paths", value: "host" },
  { label: "Sandbox paths", value: "sandbox" },
] as const;

const PATH_HINTS: Record<WorkspacePaths, string> = {
  host: "The workspace and its git metadata keep their host paths inside the sandbox",
  sandbox:
    "The workspace is at <folder>/<name> inside the sandbox, as in dev containers. This may break some agents: Codex and ACP agents are told the host path, which the sandbox doesn't have. Worktrees need the repository to use relative worktree paths (Git 2.48 or newer)",
};

function userOptions(engine: Engine) {
  return ENGINE_USER_MODES[engine].map((value) => ({ label: USER_LABELS[value], value }));
}

const BLANK: Omit<ContainerProfile, "id"> = {
  name: "",
  engine: "podman",
  cli: "",
  image: DEFAULT_IMAGE,
  network: defaultNetwork("podman"),
  extraMounts: "",
  extraRunArgs: "",
  user: "host",
  agentState: "isolated",
  loginEnvironment: true,
  paths: "host",
  sandboxFolder: "",
  containerCli: "",
};

export type ProfileEditorTarget =
  | { mode: "new"; from?: ContainerProfile }
  | { mode: "edit"; profile: ContainerProfile; isDefault: boolean; canDelete: boolean };

interface ProfileEditorProps {
  target: ProfileEditorTarget | null;
  theme: PluginTheme;
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
    user: profileUser(profile),
    agentState: profileAgentState(profile),
    loginEnvironment: profile.loginEnvironment !== false,
    paths: profile.paths ?? "host",
    sandboxFolder: profile.sandboxFolder ?? "",
    containerCli: profile.containerCli ?? "",
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
export function ProfileEditor({ target, theme, onClose, onSaved }: ProfileEditorProps) {
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
        {target ? (
          <EditorForm key={targetKey(target)} target={target} theme={theme} onSaved={onSaved} />
        ) : null}
      </Modal.Content>
    </Modal>
  );
}

/**
 * What starting a sandbox from the draft runs, built by the engine code itself on the host, with
 * placeholders for the paths each workspace fills in.
 */
function CommandPreview({ draft, theme }: { draft: Draft; theme: PluginTheme }) {
  const preview = useRpc(previewContainerCommandRpc);
  const query = useQuery({
    queryKey: ["command-preview", draft],
    queryFn: () => preview({ profile: draft }),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const styles = useMemo(
    () => ({
      box: {
        marginHorizontal: 16,
        marginBottom: 16,
        padding: 12,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
      },
      command: { fontFamily: "monospace", fontSize: FONT.sm, color: theme.colors.foreground },
      error: { fontSize: FONT.sm, color: theme.colors.statusDanger },
    }),
    [theme],
  );
  return (
    <SettingsCard>
      <SettingsRow
        label="Start command"
        hint="What starting a sandbox from this profile runs. Each workspace fills in the <placeholders>; an engine that starts a sandbox per launch runs each launch's <command>"
      />
      <View style={styles.box}>
        {query.error ? (
          <Text style={styles.error}>{query.error.message}</Text>
        ) : (
          // Scrolls sideways rather than wrapping, so each option stays on its line.
          <ScrollView horizontal>
            <Text selectable style={styles.command}>
              {query.data?.command ?? "…"}
            </Text>
          </ScrollView>
        )}
      </View>
    </SettingsCard>
  );
}

function EditorForm({
  target,
  theme,
  onSaved,
}: {
  target: ProfileEditorTarget;
  theme: PluginTheme;
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
        user: profileUser({ engine: choice.value, user: current.user }),
      }));
    }
  }, []);
  const selectUser = useCallback((user: UserMode) => {
    setDraft((current) => ({ ...current, user }));
  }, []);
  const selectAgentState = useCallback((agentState: AgentState) => {
    setDraft((current) => ({ ...current, agentState }));
  }, []);
  const selectPaths = useCallback((paths: WorkspacePaths) => {
    setDraft((current) => ({ ...current, paths }));
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
  // A dev container's image, user, network, mounts, and run arguments are in its devcontainer.json.
  const fromWorkspace = engineReadsWorkspaceConfig(engine);
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
        {fromWorkspace ? (
          <>
            <SettingsInput
              label="Container command"
              hint="Docker or Podman, for the devcontainer CLI; leave empty for docker, or podman without it"
              initialValue={draft.containerCli ?? ""}
              onChangeText={field("containerCli")}
              disabled={busy}
            />
            <SettingsRow
              label="Configuration"
              hint="Read from each workspace's .devcontainer/devcontainer.json or .devcontainer.json, which sets the image, user, network, mounts, remoteEnv, and userEnvProbe. The plugin adds the agents' folders and keeps Git hooks read-only. Creating a container asks first, showing what it runs on this host and downloads. Agents other than Claude may not start in the right folder"
            />
          </>
        ) : null}
        {needsImage ? (
          <SettingsInput
            label="Image"
            hint={`${imageHint(engine)}. It must provide the agent CLIs, or mount them below`}
            initialValue={draft.image}
            onChangeText={field("image")}
            disabled={busy}
          />
        ) : null}
        <SettingsSelect
          label="Agent sign-ins and history"
          hint={AGENT_STATE_HINTS[profileAgentState(draft)]}
          value={profileAgentState(draft)}
          options={AGENT_STATE_OPTIONS}
          onValueChange={selectAgentState}
          disabled={busy}
        />
        {ENGINE_USER_MODES[engine].length > 1 ? (
          <SettingsSelect
            label="User"
            hint={USER_HINTS[profileUser(draft)]}
            value={profileUser(draft)}
            options={userOptions(engine)}
            onValueChange={selectUser}
            disabled={busy}
          />
        ) : null}
        {fromWorkspace ? null : (
          <>
            <SettingsSwitch
              label="Read the login shell environment"
              hint={
                draft.loginEnvironment !== false
                  ? "Agents and terminal profiles get what the sandbox's shell startup files set, such as PATH, read once per sandbox"
                  : "Agents and terminal profiles get only the sandbox's own environment and Paseo's variables"
              }
              value={draft.loginEnvironment !== false}
              onValueChange={field("loginEnvironment")}
              disabled={busy}
            />
            <SettingsSelect
              label="Workspace paths"
              hint={PATH_HINTS[draft.paths ?? "host"]}
              value={draft.paths ?? "host"}
              options={PATH_OPTIONS}
              onValueChange={selectPaths}
              disabled={busy}
            />
            {draft.paths === "sandbox" ? (
              <SettingsInput
                label="Sandbox folder"
                hint="Where workspaces go inside the sandbox"
                initialValue={draft.sandboxFolder ?? ""}
                placeholder={DEFAULT_SANDBOX_FOLDER}
                onChangeText={field("sandboxFolder")}
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
          </>
        )}
        <SettingsSwitch
          label="Default profile"
          hint="Preselected for new sandboxed workspaces"
          value={makeDefault}
          onValueChange={setMakeDefault}
          disabled={busy || (editing && target.isDefault)}
        />
      </SettingsCard>
      <CommandPreview draft={draft} theme={theme} />
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
