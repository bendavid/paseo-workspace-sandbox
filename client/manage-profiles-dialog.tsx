import type { PluginTheme } from "@getpaseo/plugin";
import { Loading, Modal, SettingsAction, SettingsCard } from "@getpaseo/plugin/client/ui";
import { useCallback } from "react";
import type { ContainerProfile, PreviewContext } from "../shared/rpc";
import { EditorForm, targetKey } from "./profile-editor";
import { ProfileList, useProfileList } from "./profile-list";

/**
 * The plugin's container profiles in one dialog over the New workspace screen: the list, and the
 * editor in its place while a profile is open, so the screen and its choices stay as they were.
 */
export function ManageProfilesDialog({
  theme,
  open,
  context,
  onClose,
  onSaved,
}: {
  theme: PluginTheme;
  open: boolean;
  /** The new workspace, so the editor's start command shows its paths. */
  context: PreviewContext | undefined;
  onClose: () => void;
  /** A profile was added or changed (`created` for a new one), or deleted (null). */
  onSaved: (profile: ContainerProfile | null, created: boolean) => void;
}) {
  const list = useProfileList();
  const { target, close: closeEditor, saved: listSaved } = list;
  const openChange = useCallback(
    (next: boolean) => {
      if (next) return;
      closeEditor();
      onClose();
    },
    [closeEditor, onClose],
  );
  const saved = useCallback(
    (profile: ContainerProfile | null) => {
      const created = target?.mode === "new";
      listSaved();
      onSaved(profile, created);
    },
    [listSaved, onSaved, target],
  );
  const title =
    target?.mode === "edit"
      ? "Edit container profile"
      : target
        ? "New container profile"
        : "Container profiles";
  return (
    <Modal title={title} open={open} onOpenChange={openChange}>
      <Modal.Content>
        {target ? (
          <>
            <SettingsCard>
              <SettingsAction
                label="Changes not saved are dropped"
                actionLabel="Back to profiles"
                onPress={closeEditor}
              />
            </SettingsCard>
            {/* Settings inputs read their initial value once, so each target mounts a fresh form. */}
            <EditorForm
              key={targetKey(target)}
              target={target}
              theme={theme}
              context={context}
              onSaved={saved}
            />
          </>
        ) : list.data ? (
          <ProfileList data={list.data} onEdit={list.edit} onCreate={list.create} />
        ) : (
          <Loading />
        )}
      </Modal.Content>
    </Modal>
  );
}
