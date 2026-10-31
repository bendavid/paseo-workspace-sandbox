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
  restartSandboxRpc,
  sandboxDependentsRpc,
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
  restart = false,
  onDone,
}: {
  sandbox: SandboxRecord;
  next?: SandboxSettings;
  /** Restart the sandbox as it is rather than recreate it. */
  restart?: boolean;
  onDone(): void;
}) {
  const recreate = useRpc(recreateSandboxRpc);
  const restartSandbox = useRpc(restartSandboxRpc);
  const getDependents = useRpc(sandboxDependentsRpc);
  // What already runs with the current settings, restarted afterwards with the new ones.
  const dependents = useQuery({
    queryKey: ["sandbox-dependents", sandbox.workspaceId],
    queryFn: () => getDependents({ workspaceId: sandbox.workspaceId }),
  });
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
      if (restart) {
        await restartSandbox({ workspaceId: sandbox.workspaceId });
        return;
      }
      if (switchPaths) await switchRelative({ projectId: sandbox.projectId });
      await recreate({ workspaceId: sandbox.workspaceId, ...(next ? { profile: next } : {}) });
    },
    onSuccess: onDone,
  });
  const start = useCallback(() => run.mutate(), [run]);
  const agents = dependents.data?.agents ?? [];
  const terminals = dependents.data?.terminals ?? [];
  const restarting = agents.length > 0 || terminals.length > 0;
  const warnings = [
    ...(agents.length > 0
      ? [
          `${agents.length === 1 ? "This agent restarts" : `These ${agents.length} agents restart`}, resuming ${agents.length === 1 ? "its session" : "their sessions"} with the new settings; a running turn is interrupted: ${agents.map((agent) => agent.title ?? agent.id).join(", ")}`,
        ]
      : []),
    ...(terminals.length > 0
      ? [
          `${terminals.length === 1 ? "This terminal in the workspace closes" : `All ${terminals.length} terminals in the workspace close`}, including ones on the host such as scripts and services, stopping what runs in them: ${terminals.map((terminal) => terminal.name).join(", ")}`,
        ]
      : []),
    ...(persistent && !restart
      ? ["Anything installed in the sandbox outside its mounts is lost"]
      : []),
    ...(!persistent && !restarting ? ["New launches use the settings"] : []),
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
  const verb = restart ? "Restart" : persistent ? "Recreate" : "Apply";
  const busyVerb = restart ? "Restarting" : persistent ? "Recreating" : "Applying";
  // Says what else happens, so going ahead is agreeing to it.
  const consequences = [
    agents.length > 0 ? `restart ${agents.length === 1 ? "the agent" : "agents"}` : "",
    terminals.length > 0 ? `close ${terminals.length === 1 ? "the terminal" : "terminals"}` : "",
  ].filter(Boolean);
  const action = [
    switchPaths ? `Switch to relative paths and ${verb.toLowerCase()}` : verb,
    consequences.length > 0 ? `, ${consequences.join(" and ")}` : "",
  ].join("");
  return (
    <SettingsCard>
      {warnings.map((warning) => (
        <SettingsRow key={warning} label={warning} />
      ))}
      <SettingsAction
        label={next ? `${verb} the sandbox with these settings` : `${verb} the sandbox`}
        actionLabel={run.isPending ? `${busyVerb}…` : action}
        onPress={start}
        disabled={run.isPending || blocked || dependents.isPending}
        error={run.error?.message ?? dependents.error?.message ?? null}
      />
    </SettingsCard>
  );
}
