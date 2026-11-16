import type { PluginTheme } from "@getpaseo/plugin";
import { Modal } from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo } from "react";
import type { ContainerProfile, PreviewContext } from "../shared/rpc";
import { CommandPreview, fields } from "./profile-editor";

/** What starting the new workspace's sandbox will run, for the profile chosen in the field. */
export function StartCommandDialog({
  theme,
  profile,
  context,
  onClose,
}: {
  theme: PluginTheme;
  /** Open while set. */
  profile: ContainerProfile | null;
  context: PreviewContext | undefined;
  onClose: () => void;
}) {
  const openChange = useCallback(
    (open: boolean) => {
      if (!open) onClose();
    },
    [onClose],
  );
  const draft = useMemo(() => (profile ? fields(profile) : null), [profile]);
  return (
    <Modal
      title={profile ? `Start command: ${profile.name}` : "Start command"}
      open={profile !== null}
      onOpenChange={openChange}
    >
      <Modal.Content>
        {draft ? <CommandPreview draft={draft} theme={theme} context={context} /> : null}
      </Modal.Content>
    </Modal>
  );
}
