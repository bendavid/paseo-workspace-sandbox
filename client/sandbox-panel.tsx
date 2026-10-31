import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  Loading,
  Modal,
  ScrollView,
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useState } from "react";
import { Text } from "react-native";
import {
  chooseImageRpc,
  describeProfile,
  enginePersistent,
  listContainerProfilesRpc,
  restartSandboxRpc,
  type SandboxRecord,
  engineReadsWorkspaceConfig,
  profileSandboxFolder,
  recordAgentState,
  profileUser,
  USER_LABELS,
  openSandboxShellRpc,
  sandboxStatusRpc,
  type AgentState,
  type ClaudeLogin,
  type ContainerStatus,
  type ImageChoice,
  type ImageDownload,
} from "../shared/rpc";
import { ProfileEditor, type ProfileEditorTarget } from "./profile-editor";
import { RecreateAction } from "./recreate";

function describe(container: ContainerStatus): string {
  switch (container.state) {
    case "starting":
      return container.downloading ? `Downloading ${container.downloading}` : "Starting";
    case "running":
      return "Running";
    case "stopped":
      return "Stopped; starts with the next agent or sandboxed terminal";
    case "missing":
      return "Missing; recreated with the next agent or sandboxed terminal";
    case "failed":
      return "Failed to start";
  }
}

const AGENT_STATE_LABELS: Record<AgentState, string> = {
  isolated: "Isolated",
  shared: "Shared with the host",
  off: "Off",
};

function describeClaudeFolder(claudeHome: string, dir: string | null): string {
  if (claudeHome === "none") return "None: agent sign-ins and history are off";
  if (claudeHome === "checking" || !dir) return "Set as the sandbox starts";
  return claudeHome === "private" ? dir : `Shared with the host: ${dir}`;
}

function describeLogin(login: ClaudeLogin): string {
  switch (login.state) {
    case "signed-in":
      return `Your host login, refreshed automatically (token valid until ${new Date(login.expiresAt).toLocaleTimeString()})`;
    case "env-token":
      return "CLAUDE_CODE_OAUTH_TOKEN";
    case "signed-out":
    case "refresh-failed":
      return "Not available";
  }
}

/** Long errors read better above the rows than squeezed beside a label. */
function startErrors(container: ContainerStatus, login: ClaudeLogin | null): string[] {
  const errors: string[] = [];
  if (container.state === "failed") errors.push(`The container did not start: ${container.error}`);
  if (login?.state === "signed-out" || login?.state === "refresh-failed") {
    errors.push(login.message);
  }
  return errors;
}

/**
 * The user's answer for the download a sandbox waits for, naming the exact image: download it, or
 * for an outdated image, use the local copy.
 */
function ImageDownloadAction({
  download,
  onChoose,
  pending,
  error,
}: {
  download: ImageDownload;
  onChoose(choice: ImageChoice): void;
  pending: boolean;
  error: string | null;
}) {
  const { image, reason } = download;
  const fetchImage = useCallback(() => onChoose({ image, action: "download" }), [image, onChoose]);
  const keepLocal = useCallback(() => onChoose({ image, action: "local" }), [image, onChoose]);
  if (reason === "devcontainer") {
    // What the workspace's configuration does, things that reach the host first.
    return (
      <SettingsCard>
        <SettingsAction
          label="Create the dev container"
          hint={`From ${image}`}
          actionLabel="Create the dev container"
          onPress={fetchImage}
          disabled={pending}
          error={error}
        />
        {(download.details ?? []).map((detail) => (
          <SettingsRow key={detail} label={detail} />
        ))}
      </SettingsCard>
    );
  }
  return (
    <SettingsCard>
      <SettingsAction
        label={reason === "outdated" ? "Update the image" : "Download the image"}
        hint={
          reason === "outdated"
            ? `The registry has a newer ${image}`
            : `From its registry: ${image}`
        }
        actionLabel={`${reason === "outdated" ? "Update" : "Download"} ${image}`}
        onPress={fetchImage}
        disabled={pending}
        error={error}
      />
      {reason === "outdated" ? (
        <SettingsAction
          label="Use the local image"
          hint="Creates the sandbox from the image already on this machine"
          actionLabel="Use the local image"
          onPress={keepLocal}
          disabled={pending}
        />
      ) : null}
    </SettingsCard>
  );
}

/** Choosing a saved profile to recreate the sandbox with, then the go-ahead. */
function SavedProfileRecreate({ sandbox, onDone }: { sandbox: SandboxRecord; onDone(): void }) {
  const listProfiles = useRpc(listContainerProfilesRpc);
  const profiles = useQuery({ queryKey: ["container-profiles"], queryFn: () => listProfiles({}) });
  const [chosen, setChosen] = useState<string | null>(null);
  if (!profiles.data) return <Loading />;
  const options = profiles.data.profiles.map((profile) => ({
    label: profile.name,
    value: profile.id,
  }));
  const profile =
    profiles.data.profiles.find((candidate) => candidate.id === chosen) ??
    profiles.data.profiles.find((candidate) => candidate.id === profiles.data.defaultId);
  return (
    <>
      <SettingsCard>
        <SettingsSelect
          label="Profile"
          hint={profile ? describeProfile(profile) : undefined}
          value={profile?.id ?? ""}
          options={options}
          onValueChange={setChosen}
        />
      </SettingsCard>
      {profile ? (
        <RecreateAction key={profile.id} sandbox={sandbox} next={profile} onDone={onDone} />
      ) : null}
    </>
  );
}

type ManageDialog = "recreate" | "profile" | null;

/** Restart, recreate, and changing the sandbox's settings, as its engine allows. */
function ManageSandbox({ sandbox, theme }: { sandbox: SandboxRecord; theme: PluginTheme }) {
  const queryClient = useQueryClient();
  const restartSandbox = useRpc(restartSandboxRpc);
  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["status", sandbox.workspaceId] }),
    [queryClient, sandbox.workspaceId],
  );
  const restart = useMutation({ mutationFn: restartSandbox, onSettled: refresh });
  const [dialog, setDialog] = useState<ManageDialog>(null);
  const [editing, setEditing] = useState<ProfileEditorTarget | null>(null);
  const close = useCallback(() => {
    setDialog(null);
    setEditing(null);
    void refresh();
  }, [refresh]);
  const openChange = useCallback((open: boolean) => {
    if (!open) setDialog(null);
  }, []);
  const persistent = enginePersistent(sandbox.profile.engine);
  return (
    <SettingsSection title="Manage">
      <SettingsCard>
        {persistent ? (
          <SettingsAction
            label="Restart"
            hint="Stops the container and starts it again as it is; running agents and terminals in it stop"
            actionLabel={restart.isPending ? "Restarting…" : "Restart"}
            onPress={() => restart.mutate({ workspaceId: sandbox.workspaceId })}
            disabled={restart.isPending}
            error={restart.error?.message ?? null}
          />
        ) : null}
        {persistent ? (
          <SettingsAction
            label="Recreate"
            hint="Removes the container and creates it again from the sandbox's settings"
            actionLabel="Recreate…"
            onPress={() => setDialog("recreate")}
          />
        ) : null}
        <SettingsAction
          label="Change settings"
          hint="Edit the sandbox's own copy of its profile, then recreate it with the changes"
          actionLabel="Edit…"
          onPress={() => setEditing({ mode: "sandbox", sandbox })}
        />
        <SettingsAction
          label="Use another profile"
          hint="Recreate the sandbox with a copy of a saved profile"
          actionLabel="Choose…"
          onPress={() => setDialog("profile")}
        />
      </SettingsCard>
      <Modal
        title={dialog === "profile" ? "Use another profile" : "Recreate the sandbox?"}
        open={dialog !== null}
        onOpenChange={openChange}
      >
        <Modal.Content>
          {dialog === "recreate" ? <RecreateAction sandbox={sandbox} onDone={close} /> : null}
          {dialog === "profile" ? <SavedProfileRecreate sandbox={sandbox} onDone={close} /> : null}
        </Modal.Content>
      </Modal>
      <ProfileEditor target={editing} theme={theme} onClose={close} onSaved={close} />
    </SettingsSection>
  );
}

export function SandboxPanel({ workspaceId, theme, layout }: PluginWorkspacePanelProps) {
  const getStatus = useRpc(sandboxStatusRpc);
  const openShell = useRpc(openSandboxShellRpc);
  const status = useQuery({
    queryKey: ["status", workspaceId],
    queryFn: () => getStatus({ workspaceId }),
    refetchInterval: 3_000,
  });
  const shell = useMutation({ mutationFn: openShell });
  const open = useCallback(() => shell.mutate({ workspaceId }), [shell, workspaceId]);
  const queryClient = useQueryClient();
  const sendImageChoice = useRpc(chooseImageRpc);
  const download = useMutation({
    mutationFn: sendImageChoice,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["status", workspaceId] }),
  });
  const chooseImage = useCallback(
    (choice: ImageChoice) => download.mutate({ workspaceId, ...choice }),
    [download, workspaceId],
  );
  const styles = useMemo(
    () => ({
      content: { padding: layout.compact ? 16 : 24, gap: 16 },
      value: { color: theme.colors.foreground },
      detail: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
    }),
    [theme, layout.compact],
  );

  if (status.isPending) return <Loading />;
  if (status.error) {
    return (
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.error}>{status.error.message}</Text>
      </ScrollView>
    );
  }
  const { sandbox, container, claudeLogin, claudeConfigDir, sandboxDirectory } = status.data;
  if (!sandbox || !container) {
    return (
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.detail}>
          This workspace is not sandboxed. Agents and terminals run on the host.
        </Text>
      </ScrollView>
    );
  }
  const privateClaude = sandbox.claudeHome === "private";
  const errors = startErrors(container, privateClaude ? claudeLogin : null);
  return (
    <ScrollView contentContainerStyle={styles.content}>
      {errors.map((error) => (
        <Text key={error} style={styles.error} selectable>
          {error}
        </Text>
      ))}
      {container.state === "failed" && container.download ? (
        <ImageDownloadAction
          download={container.download}
          onChoose={chooseImage}
          pending={download.isPending}
          error={download.error?.message ?? null}
        />
      ) : null}
      {container.state === "failed" && !container.download ? (
        <Text style={styles.detail}>
          Starting an agent or opening a sandboxed terminal tries again. The daemon log has the full
          output.
        </Text>
      ) : null}
      <SettingsSection title="Sandbox">
        <SettingsCard>
          <SettingsRow label="Container">
            <Text style={styles.value}>{describe(container)}</Text>
          </SettingsRow>
          <SettingsRow label="Name">
            <Text style={styles.value}>{sandbox.container}</Text>
          </SettingsRow>
          <SettingsRow label="Profile">
            <Text style={styles.value}>{sandbox.profile.name}</Text>
          </SettingsRow>
          <SettingsRow label="Engine">
            <Text style={styles.value}>{describeProfile(sandbox.profile)}</Text>
          </SettingsRow>
          {engineReadsWorkspaceConfig(sandbox.profile.engine) ? null : (
            <SettingsRow label="Network">
              <Text style={styles.value}>{sandbox.profile.network}</Text>
            </SettingsRow>
          )}
          <SettingsRow label="Workspace paths">
            <Text style={styles.value}>
              {profileSandboxFolder(sandbox.profile)
                ? `Sandbox paths, under ${profileSandboxFolder(sandbox.profile)}`
                : "Host paths"}
            </Text>
          </SettingsRow>
          <SettingsRow label="Login shell environment">
            <Text style={styles.value}>
              {engineReadsWorkspaceConfig(sandbox.profile.engine)
                ? "As devcontainer.json's userEnvProbe says"
                : sandbox.profile.loginEnvironment === false
                  ? "Not read"
                  : "Read once per sandbox"}
            </Text>
          </SettingsRow>
          <SettingsRow label="User">
            <Text style={styles.value}>
              {engineReadsWorkspaceConfig(sandbox.profile.engine)
                ? "The dev container's user"
                : USER_LABELS[profileUser(sandbox.profile)]}
            </Text>
          </SettingsRow>
          {sandbox.profile.extraMounts ? (
            <SettingsRow label="Extra mounts">
              <Text style={styles.value}>{sandbox.profile.extraMounts}</Text>
            </SettingsRow>
          ) : null}
          <SettingsRow label="Directory">
            <Text style={styles.value}>{sandbox.cwd}</Text>
          </SettingsRow>
          {sandboxDirectory ? (
            <SettingsRow label="Directory in the sandbox">
              <Text style={styles.value}>{sandboxDirectory}</Text>
            </SettingsRow>
          ) : null}
          <SettingsRow label="Agent sign-ins and history">
            <Text style={styles.value}>{AGENT_STATE_LABELS[recordAgentState(sandbox)]}</Text>
          </SettingsRow>
          <SettingsRow label="Claude folder">
            <Text style={styles.value}>
              {describeClaudeFolder(sandbox.claudeHome, claudeConfigDir)}
            </Text>
          </SettingsRow>
          {privateClaude ? (
            <SettingsRow label="Claude sign-in">
              <Text style={styles.value}>{describeLogin(claudeLogin)}</Text>
            </SettingsRow>
          ) : null}
          <SettingsAction
            label="Terminal"
            hint="Opens a terminal inside the container"
            actionLabel="Open sandboxed terminal"
            onPress={open}
            disabled={shell.isPending}
            error={shell.error?.message ?? null}
          />
        </SettingsCard>
      </SettingsSection>
      <ManageSandbox sandbox={sandbox} theme={theme} />
      <Text style={styles.detail}>
        Scripts, worktree setup, and terminals opened from the tab bar run on the host. Use Open
        sandboxed terminal for commands that should stay inside the container.
      </Text>
    </ScrollView>
  );
}
