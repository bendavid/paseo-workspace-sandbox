import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import {
  Loading,
  ScrollView,
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo } from "react";
import { Text } from "react-native";
import {
  chooseImageRpc,
  describeProfile,
  openSandboxShellRpc,
  sandboxStatusRpc,
  type ClaudeLogin,
  type ContainerStatus,
  type ImageChoice,
  type ImageDownload,
} from "../shared/rpc";

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

function describeClaudeFolder(claudeHome: string, dir: string | null): string {
  if (claudeHome === "checking" || !dir) return "Being decided as the sandbox starts";
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
  const { sandbox, container, claudeLogin, claudeConfigDir } = status.data;
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
          <SettingsRow label="Network">
            <Text style={styles.value}>{sandbox.profile.network}</Text>
          </SettingsRow>
          {sandbox.profile.extraMounts ? (
            <SettingsRow label="Extra mounts">
              <Text style={styles.value}>{sandbox.profile.extraMounts}</Text>
            </SettingsRow>
          ) : null}
          <SettingsRow label="Directory">
            <Text style={styles.value}>{sandbox.cwd}</Text>
          </SettingsRow>
          <SettingsRow label="Claude folder">
            <Text style={styles.value}>
              {describeClaudeFolder(sandbox.claudeHome, claudeConfigDir)}
            </Text>
            {sandbox.claudeHomeReason ? (
              <Text style={styles.detail}>{sandbox.claudeHomeReason}</Text>
            ) : null}
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
      <Text style={styles.detail}>
        Scripts, worktree setup, and terminals opened from the tab bar run on the host. Use Open
        sandboxed terminal for commands that should stay inside the container.
      </Text>
    </ScrollView>
  );
}
