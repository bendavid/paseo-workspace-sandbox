import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useNewWorkspace,
  useRpc,
  useSettings,
  type PluginNewWorkspaceItemProps,
} from "@getpaseo/plugin/client";
import { Action, Select, useToast } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  describeProfile,
  enableRelativeWorktreesRpc,
  imageStatusRpc,
  listContainerProfilesRpc,
  profileSandboxFolder,
  pullImageRpc,
  relativeWorktreesStatusRpc,
  SANDBOX_METADATA_KEY,
  WorkspaceSandboxRequestSchema,
  type ContainerProfile,
  type ImageChoice,
  type WorkspaceSandboxRequest,
} from "../shared/rpc";
import { newWorkspaceSettings } from "../shared/settings";
import { ImageDownloadDialog, type ImageQuestion } from "./image-download-dialog";
import { ManageProfilesDialog } from "./manage-profiles-dialog";
import { RelativePathsDialog } from "./relative-paths-dialog";
import { StartCommandDialog } from "./start-command-dialog";

// An option value that opens the profiles dialog rather than choose a profile. Profile IDs are
// "default" or "profile-…", never this.
const NO_SANDBOX = "";
const MANAGE_PROFILES = ":manage-profiles";

/**
 * A Sandbox field on Paseo's own New workspace screen. The chosen container profile, and the
 * answer about its image, are stored on the new workspace; the server gives the workspace that
 * sandbox once it exists.
 */
export function NewWorkspaceSandboxField({ theme }: PluginNewWorkspaceItemProps) {
  const newWorkspace = useNewWorkspace();
  const { project, isolation, setMetadata } = newWorkspace;
  const listProfiles = useRpc(listContainerProfilesRpc);
  const getImageStatus = useRpc(imageStatusRpc);
  const pullImage = useRpc(pullImageRpc);
  const profiles = useQuery({ queryKey: ["container-profiles"], queryFn: () => listProfiles({}) });
  const settings = useSettings(newWorkspaceSettings);

  const request = WorkspaceSandboxRequestSchema.safeParse(
    newWorkspace.metadata[SANDBOX_METADATA_KEY],
  ).data;
  const selected =
    profiles.data?.profiles.find((profile) => profile.id === request?.profileId) ?? null;

  // A missing or outdated image downloads only after the user agrees to that exact reference.
  const [question, setQuestion] = useState<(ImageQuestion & { profileId: string }) | null>(null);
  const download = useImageDownload();
  const { watch } = download;
  const sandboxByDefault = settings.status === "ready" && settings.values.sandboxByDefault;
  // `false` records a No sandbox chosen over the default, so the default is not applied again.
  const store = useCallback(
    (sandbox: WorkspaceSandboxRequest | false | null) =>
      setMetadata({ [SANDBOX_METADATA_KEY]: sandbox }),
    [setMetadata],
  );
  const chooseProfile = useCallback(
    async (profileId: string) => {
      setQuestion(null);
      await store({ profileId });
      const { image, state } = await getImageStatus({ profileId });
      if (!image) return;
      if (state === "downloading") watch({ profileId, image });
      if (state === "missing" || state === "outdated") {
        setQuestion({ profileId, image, reason: state });
      }
    },
    [getImageStatus, store, watch],
  );
  // A download starts as soon as the user agrees, so later workspaces find the image current. The
  // answer also travels with this workspace, in case the download fails before its sandbox starts.
  const answer = useCallback(
    (action: ImageChoice["action"]) => {
      if (!question) return;
      const { profileId, image } = question;
      setQuestion(null);
      void store({ profileId, imageChoice: { image, action } });
      if (action !== "download") return;
      pullImage({ profileId, image })
        .then(() => watch({ profileId, image }))
        .catch((error: unknown) => download.failed(image, error));
    },
    [download, pullImage, question, store, watch],
  );
  const clear = useCallback(() => {
    setQuestion(null);
    void store(sandboxByDefault ? false : null);
  }, [sandboxByDefault, store]);

  // Sandbox new workspaces by default: the default profile, once, when the field opens.
  const preselected = useRef(false);
  const defaultId = profiles.data?.defaultId;
  const untouched = newWorkspace.metadata[SANDBOX_METADATA_KEY] === undefined;
  useEffect(() => {
    if (preselected.current || settings.status === "loading" || !defaultId) return;
    preselected.current = true;
    if (!sandboxByDefault || !untouched) return;
    chooseProfile(defaultId).catch((error: unknown) =>
      console.error("Choosing the default sandbox failed", error),
    );
  }, [chooseProfile, defaultId, sandboxByDefault, settings.status, untouched]);

  // Profiles change in the plugin's settings: a deleted one leaves the field, and an edited one is
  // checked again, since its image may be another.
  const selectedKey = selected ? JSON.stringify(selected) : null;
  const seenKey = useRef(selectedKey);
  const missing = profiles.data !== undefined && request !== undefined && selected === null;
  useEffect(() => {
    if (missing) {
      clear();
      return;
    }
    if (seenKey.current === selectedKey) return;
    const previous = seenKey.current;
    seenKey.current = selectedKey;
    if (!previous || !selected || JSON.parse(previous).id !== selected.id) return;
    chooseProfile(selected.id).catch((error: unknown) =>
      console.error("Checking the edited profile failed", error),
    );
  }, [chooseProfile, clear, missing, selected, selectedKey]);

  const options = useMemo(
    () => [
      {
        value: NO_SANDBOX,
        label: "No sandbox",
        description: "Agents and terminals run on the host",
      },
      ...(profiles.data?.profiles ?? []).map((profile) => ({
        value: profile.id,
        label: profile.name,
        description: describeProfile(profile),
      })),
      {
        value: MANAGE_PROFILES,
        label: "Manage profiles…",
        description: "Add, edit, or remove container profiles",
      },
    ],
    [profiles.data],
  );

  const choose = useCallback(
    async ({ value }: { value: string }) => {
      if (value === MANAGE_PROFILES) {
        setManaging(true);
        return;
      }
      if (value === NO_SANDBOX) {
        clear();
        return;
      }
      await chooseProfile(value);
    },
    [chooseProfile, clear],
  );
  const [managing, setManaging] = useState(false);
  const stopManaging = useCallback(() => setManaging(false), []);
  // A new profile is what the user made it for; an edited or deleted one is handled above.
  const profileSaved = useCallback(
    (profile: ContainerProfile | null, created: boolean) => {
      if (!profile || !created) return;
      chooseProfile(profile.id).catch((error: unknown) =>
        console.error("Choosing the new profile failed", error),
      );
    },
    [chooseProfile],
  );

  const relativePaths = useRelativePaths({
    projectId: project?.id ?? null,
    needed:
      isolation === "worktree" && selected !== null && profileSandboxFolder(selected) !== null,
  });
  const [showingCommand, setShowingCommand] = useState(false);
  const showCommand = useCallback(() => setShowingCommand(true), []);
  const hideCommand = useCallback(() => setShowingCommand(false), []);
  const previewContext = useMemo(
    () =>
      project
        ? {
            kind: "new" as const,
            projectId: project.id,
            isolation: isolation === "worktree" ? ("worktree" as const) : ("directory" as const),
          }
        : undefined,
    [isolation, project],
  );

  // One dialog at a time: the profiles, then the repository, then the image.
  const relativeQuestion = managing ? null : relativePaths.asking;
  const imageQuestion =
    !managing && !relativePaths.asking && question && question.profileId === selected?.id
      ? question
      : null;
  const downloading =
    download.current && download.current.profileId === selected?.id ? download.current : null;

  return (
    <>
      <Select
        title="Sandbox"
        icon="Box"
        value={selected?.id ?? NO_SANDBOX}
        options={options}
        disabled={!profiles.data}
        onValueChange={choose}
      />
      {downloading ? (
        <Action
          title={`Downloading ${downloading.image}…`}
          icon="Download"
          disabled
          onPress={noop}
        />
      ) : null}
      {selected ? (
        <Action title="Show sandbox command" icon="SquareTerminal" onPress={showCommand} />
      ) : null}
      <RelativePathsDialog
        theme={theme}
        status={relativeQuestion}
        repository={project?.name ?? null}
        switching={relativePaths.switching}
        confirmLabel="Switch to relative paths"
        cancelHint="Cancel takes the sandbox off the new workspace."
        error={relativePaths.error}
        onCancel={clear}
        onConfirm={relativePaths.confirm}
      />
      <ImageDownloadDialog
        theme={theme}
        question={imageQuestion}
        onAnswer={answer}
        onCancel={clear}
      />
      <StartCommandDialog
        theme={theme}
        profile={showingCommand ? selected : null}
        context={previewContext}
        onClose={hideCommand}
      />
      <ManageProfilesDialog
        theme={theme}
        open={managing}
        context={previewContext}
        onClose={stopManaging}
        onSaved={profileSaved}
      />
    </>
  );
}

function noop() {}

/**
 * The image download the field started or found running, followed until it ends; a toast says
 * how it ended.
 */
function useImageDownload() {
  const getImageStatus = useRpc(imageStatusRpc);
  const toast = useToast();
  const [current, setCurrent] = useState<{ profileId: string; image: string } | null>(null);
  const status = useQuery({
    queryKey: ["image-download", current?.profileId, current?.image],
    queryFn: () => getImageStatus({ profileId: current?.profileId ?? "" }),
    enabled: current !== null,
    refetchInterval: 2_000,
    gcTime: 0,
  });
  const failed = useCallback(
    (image: string, error: unknown) => {
      setCurrent(null);
      toast.error(
        `Downloading ${image} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
    [toast],
  );
  const { data } = status;
  useEffect(() => {
    if (!current || !data || data.state === "downloading") return;
    setCurrent(null);
    if (data.state === "current" || data.state === "unverified") {
      toast.show(`Downloaded ${current.image}`, { variant: "success" });
    } else if (data.error) {
      toast.error(`Downloading ${current.image} failed: ${data.error}`);
    } else {
      // The plugin restarted mid-download: nothing reports how it ended, and the image is not here.
      toast.show(`The download of ${current.image} stopped before it finished`, {
        variant: "warning",
      });
    }
  }, [current, data, toast]);
  const watch = useCallback((next: { profileId: string; image: string }) => setCurrent(next), []);
  return { current, watch, failed };
}

/**
 * At sandbox paths, the worktree Paseo creates needs relative git links; switching the
 * repository is the user's call. The server refuses the workspace without them.
 */
function useRelativePaths({ projectId, needed }: { projectId: string | null; needed: boolean }) {
  const getRelativeWorktrees = useRpc(relativeWorktreesStatusRpc);
  const switchToRelativeWorktrees = useRpc(enableRelativeWorktreesRpc);
  const queryClient = useQueryClient();
  const key = ["relative-worktrees", projectId];
  const status = useQuery({
    queryKey: key,
    queryFn: () => getRelativeWorktrees({ projectId: projectId ?? "" }),
    enabled: needed && projectId !== null,
  });
  const change = useMutation({
    mutationFn: () => switchToRelativeWorktrees({ projectId: projectId ?? "" }),
    onSuccess: (next) => queryClient.setQueryData(key, next),
  });
  const confirm = useCallback(() => change.mutate(), [change]);
  return {
    asking: needed && status.data && status.data.state !== "relative" ? status.data : null,
    switching: change.isPending,
    error: change.error ? change.error.message : null,
    confirm,
  };
}
