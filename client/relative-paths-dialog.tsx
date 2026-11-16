import type { PluginTheme } from "@getpaseo/plugin";
import { Modal } from "@getpaseo/plugin/client/ui";
import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import type { RelativeWorktrees } from "../shared/rpc";
import { useDialogStyles } from "./dialog-styles";

/**
 * Asks to switch a repository to relative worktree paths, which a worktree at sandbox paths
 * needs. Open while `status` is set.
 */
export function RelativePathsDialog({
  theme,
  status,
  repository,
  switching,
  confirmLabel,
  cancelHint,
  error,
  onCancel,
  onConfirm,
}: {
  theme: PluginTheme;
  status: RelativeWorktrees | null;
  repository: string | null;
  switching: boolean;
  confirmLabel: string;
  /** What Cancel leaves behind. */
  cancelHint: string;
  /** Why the last switch failed. */
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const openChange = useCallback(
    (open: boolean) => {
      if (!open) onCancel();
    },
    [onCancel],
  );
  const styles = useDialogStyles(theme);
  const unsupported = status?.state === "unsupported";
  return (
    <Modal
      title={unsupported ? "Git too old for sandbox paths" : "Switch to relative worktree paths?"}
      open={status !== null}
      onOpenChange={openChange}
    >
      <Modal.Content>
        <Text style={styles.text}>
          With sandbox paths, the new worktree is placed under the sandbox folder, so its links to
          the repository must be relative. This repository links its worktrees by absolute path:
        </Text>
        <Text style={styles.image} selectable>
          {repository}
        </Text>
        {unsupported ? (
          <Text style={styles.text}>
            Relative worktree paths need Git 2.48 or newer, and this host has {status?.gitVersion}.
            Use a profile with host paths, or a sandboxed directory.
          </Text>
        ) : (
          <>
            <Text style={styles.text}>
              Switching sets worktree.useRelativePaths and rewrites the links of the repository’s
              existing worktrees. Git also marks the repository with extensions.relativeWorktrees:
              Git older than 2.48, in images, on other machines, or in tools with their own Git,
              then refuses the repository and all its worktrees.
            </Text>
            <Text style={styles.muted}>{cancelHint}</Text>
          </>
        )}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.row}>
          <Pressable
            accessibilityRole="button"
            onPress={onCancel}
            style={styles.cancel}
            testID="sandbox-relative-cancel"
          >
            <Text style={styles.cancelLabel}>Cancel</Text>
          </Pressable>
          {unsupported ? null : (
            <Pressable
              accessibilityRole="button"
              onPress={onConfirm}
              disabled={switching}
              style={styles.confirm}
              testID="sandbox-relative-confirm"
            >
              <Text style={styles.confirmLabel}>{switching ? "Switching…" : confirmLabel}</Text>
            </Pressable>
          )}
        </View>
      </Modal.Content>
    </Modal>
  );
}
