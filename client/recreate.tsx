import { useMutation, useQuery } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow } from "@getpaseo/plugin/client/ui";
import { useCallback } from "react";
import {
  enableRelativeWorktreesRpc,
  enginePersistent,
  profileChangeWarnings,
  profileSandboxFolder,
  recreateSandboxRpc,
  relativeWorktreesStatusRpc,
  type ContainerProfile,
  type SandboxRecord,
} from "../shared/rpc";

export type SandboxSettings = Omit<ContainerProfile, "id"> & { id?: string };

/**
 * What recreating a sandbox does to what already runs and ran in it, and the go-ahead: as it is,
 * or with `next` settings, which become the sandbox's copy. At sandbox paths a worktree needs the
 * repository's relative links, which the go-ahead switches to after saying so.
 */
export function RecreateAction({
  sandbox,
  next,
  onDone,
}: {
  sandbox: SandboxRecord;
  next?: SandboxSettings;
  onDone(): void;
}) {
  const recreate = useRpc(recreateSandboxRpc);
  const getRelative = useRpc(relativeWorktreesStatusRpc);
  const switchRelative = useRpc(enableRelativeWorktreesRpc);
  // A new engine decides what recreating removes.
  const persistent =
    enginePersistent(sandbox.profile.engine) || (!!next && enginePersistent(next.engine));
  const settings = next ?? sandbox.profile;
  const needsRelative = !sandbox.linkedDirectory && profileSandboxFolder(settings) !== null;
  const relative = useQuery({
    queryKey: ["relative-worktrees", sandbox.projectId],
    queryFn: () => getRelative({ projectId: sandbox.projectId }),
    enabled: needsRelative,
  });
  const switchPaths = needsRelative && relative.data?.state === "absolute";
  const blocked = needsRelative && (relative.isPending || relative.data?.state === "unsupported");
  const run = useMutation({
    mutationFn: async () => {
      if (switchPaths) await switchRelative({ projectId: sandbox.projectId });
      await recreate({ workspaceId: sandbox.workspaceId, ...(next ? { profile: next } : {}) });
    },
    onSuccess: onDone,
  });
  const start = useCallback(() => run.mutate(), [run]);
  const warnings = [
    persistent
      ? "Running agents and terminals in the sandbox stop, and anything installed in it outside its mounts is lost"
      : "New launches use the settings; running agents and terminals keep the old ones until they exit",
    ...(next ? profileChangeWarnings(sandbox, next) : []),
    ...(switchPaths
      ? [
          "The repository links its worktrees by absolute path, so this switches it to relative paths (worktree.useRelativePaths, git worktree repair): Git older than 2.48 then refuses the repository and all its worktrees",
        ]
      : []),
    ...(relative.data?.state === "unsupported"
      ? [
          `Sandbox paths for worktrees need Git 2.48 or newer; this host has ${relative.data.gitVersion}`,
        ]
      : []),
  ];
  const verb = persistent ? "Recreate" : "Apply";
  return (
    <SettingsCard>
      {warnings.map((warning) => (
        <SettingsRow key={warning} label={warning} />
      ))}
      <SettingsAction
        label={next ? `${verb} the sandbox with these settings` : `${verb} the sandbox`}
        actionLabel={
          run.isPending
            ? `${verb === "Recreate" ? "Recreating" : "Applying"}…`
            : switchPaths
              ? `Switch to relative paths and ${verb.toLowerCase()}`
              : verb
        }
        onPress={start}
        disabled={run.isPending || blocked}
        error={run.error?.message ?? null}
      />
    </SettingsCard>
  );
}
