import type { PluginTheme } from "@getpaseo/plugin";
import { Modal } from "@getpaseo/plugin/client/ui";
import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import type { ImageChoice } from "../shared/rpc";
import { useDialogStyles } from "./dialog-styles";

export interface ImageQuestion {
  image: string;
  reason: "missing" | "outdated";
}

/**
 * Asks whether a profile's missing image may be downloaded, or an outdated one updated, now. A
 * download names the exact image reference. Open while `question` is set.
 */
export function ImageDownloadDialog({
  theme,
  question,
  onAnswer,
  onCancel,
}: {
  theme: PluginTheme;
  question: ImageQuestion | null;
  onAnswer: (action: ImageChoice["action"]) => void;
  /** Takes the sandbox off the new workspace. */
  onCancel: () => void;
}) {
  const openChange = useCallback(
    (open: boolean) => {
      if (!open) onCancel();
    },
    [onCancel],
  );
  const download = useCallback(() => onAnswer("download"), [onAnswer]);
  const useLocal = useCallback(() => onAnswer("local"), [onAnswer]);
  const styles = useDialogStyles(theme);
  const outdated = question?.reason === "outdated";
  return (
    <Modal
      title={outdated ? "Update image?" : "Download image?"}
      open={question !== null}
      onOpenChange={openChange}
    >
      <Modal.Content>
        <Text style={styles.text}>
          {outdated
            ? "The registry has a newer version of the container profile’s image than this machine. Update it now, or use the image already here for this workspace:"
            : "The container profile’s image is not on this machine. Download it from its registry now:"}
        </Text>
        <Text style={styles.image} selectable>
          {question?.image}
        </Text>
        <Text style={styles.muted}>
          Cancel takes the sandbox off the new workspace and downloads nothing.
        </Text>
        <View style={styles.row}>
          <Pressable
            accessibilityRole="button"
            onPress={onCancel}
            style={styles.cancel}
            testID="sandbox-download-cancel"
          >
            <Text style={styles.cancelLabel}>Cancel</Text>
          </Pressable>
          {outdated ? (
            <Pressable
              accessibilityRole="button"
              onPress={useLocal}
              style={styles.cancel}
              testID="sandbox-download-local"
            >
              <Text style={styles.cancelLabel}>Use the local image</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            onPress={download}
            style={styles.confirm}
            testID="sandbox-download-confirm"
          >
            <Text style={styles.confirmLabel}>
              {outdated ? "Update" : "Download"} {question?.image}
            </Text>
          </Pressable>
        </View>
      </Modal.Content>
    </Modal>
  );
}
