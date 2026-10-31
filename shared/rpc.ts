import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * What runs a workspace's sandbox. Podman, Docker, and microsandbox keep one long-lived sandbox per
 * workspace from an image; Bubblewrap starts a fresh one for each launch from the host's
 * own system, read-only. A dev container is built from the workspace's own devcontainer.json.
 */
export const ENGINES = [
  "podman",
  "docker",
  "bubblewrap",
  "microsandbox",
  "apptainer",
  "singularity",
  "devcontainer",
] as const;
export const EngineSchema = z.enum(ENGINES);
export type Engine = z.infer<typeof EngineSchema>;

const ENGINE_LABELS: Record<Engine, string> = {
  podman: "Podman",
  docker: "Docker",
  bubblewrap: "Bubblewrap",
  microsandbox: "microsandbox",
  apptainer: "Apptainer",
  singularity: "Singularity",
  devcontainer: "Dev container",
};

export type Network = "host" | "bridge" | "none";

/**
 * The networks each engine can give a sandbox. Bubblewrap and Apptainer can share the host's
 * network or have none, but have no separate one without root.
 */
export const ENGINE_NETWORKS: Record<Engine, readonly Network[]> = {
  podman: ["host", "bridge", "none"],
  docker: ["host", "bridge", "none"],
  microsandbox: ["host", "bridge", "none"],
  bubblewrap: ["host", "none"],
  apptainer: ["host", "none"],
  singularity: ["host", "none"],
  // The workspace's devcontainer.json decides; the profile's network is not used.
  devcontainer: ["host", "bridge", "none"],
};

/**
 * A new profile's network: a separate one where the engine has it, so the sandbox can't reach
 * services on the host's loopback, such as the Paseo daemon; otherwise the host's.
 */
export function defaultNetwork(engine: Engine): Network {
  return ENGINE_NETWORKS[engine].includes("bridge") ? "bridge" : "host";
}

/**
 * How the agents' own folders reach the sandbox:
 * - `off`: not at all; agents need credentials from the image, a mount, or a forwarded API key.
 * - `shared`: your Claude folder and the other agents' folders, read-write at their host paths.
 * - `isolated`: Claude gets a private folder per workspace, signed in with a copy of your host's
 *   current access token, with your settings and skills read-only. Other agents have no isolated
 *   form yet, so their folders are not mounted.
 */
export const AGENT_STATES = ["off", "shared", "isolated"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/**
 * A profile's agent state. Profiles from before the choice have `shareAgentState`, where false
 * meant off and true a private Claude folder.
 */
export function profileAgentState(profile: {
  agentState?: AgentState | undefined;
  shareAgentState?: boolean | undefined;
}): AgentState {
  return profile.agentState ?? (profile.shareAgentState === false ? "off" : "isolated");
}

/**
 * A sandbox's agent state. One from before the choice follows the Claude folder its check settled
 * on: shared when its own mounts made the host's folder writable, isolated otherwise.
 */
export function recordAgentState(record: {
  claudeHome: "private" | "shared" | "checking" | "none";
  profile: { agentState?: AgentState | undefined; shareAgentState?: boolean | undefined };
}): AgentState {
  if (record.profile.agentState) return record.profile.agentState;
  if (record.claudeHome === "none") return "off";
  if (record.claudeHome === "shared") return "shared";
  return profileAgentState(record.profile);
}

/** The Claude folder a new sandbox gets for each agent state. */
export const CLAUDE_HOME_FOR: Record<AgentState, "none" | "shared" | "private"> = {
  off: "none",
  shared: "shared",
  isolated: "private",
};

export const WORKSPACE_PATHS = ["host", "sandbox"] as const;
export type WorkspacePaths = (typeof WORKSPACE_PATHS)[number];

/** Where dev containers put a workspace: /workspaces/<folder name>. */
export const DEFAULT_SANDBOX_FOLDER = "/workspaces";

/** The folder a profile places workspaces under inside the sandbox, or null for host paths. */
export function profileSandboxFolder(profile: {
  engine: Engine;
  paths?: WorkspacePaths | undefined;
  sandboxFolder?: string | undefined;
}): string | null {
  // The devcontainer CLI places workspaces under /workspaces itself.
  if (profile.engine === "devcontainer") return DEFAULT_SANDBOX_FOLDER;
  if (profile.paths !== "sandbox") return null;
  return profile.sandboxFolder?.trim() || DEFAULT_SANDBOX_FOLDER;
}

/** An absolute folder other than /, without `..`, to put workspaces under. */
export function isValidSandboxFolder(folder: string): boolean {
  return /^\/./.test(folder) && !folder.split("/").includes("..");
}

/**
 * Who runs in the sandbox:
 * - `host`: your uid and gid, with your home path as HOME and an account for you in the image.
 * - `squashed`: the same, in a user namespace that maps only your uid and gid, so the engine sets
 *   up mounts as you rather than as a subordinate uid. NFS needs that for mounts inside folders
 *   only you can enter. The image's files appear as yours, and nothing can act as root.
 * - `image`: the image's own default user and home.
 */
export const USER_MODES = ["host", "squashed", "image"] as const;
export type UserMode = (typeof USER_MODES)[number];

/** The user modes each engine has; Bubblewrap, Apptainer, and Singularity always run as you. */
export const ENGINE_USER_MODES: Record<Engine, readonly UserMode[]> = {
  podman: ["host", "squashed", "image"],
  docker: ["host", "image"],
  microsandbox: ["host", "image"],
  bubblewrap: ["host"],
  apptainer: ["host"],
  singularity: ["host"],
  // devcontainer.json names the user (remoteUser), with its own home.
  devcontainer: ["image"],
};

export const USER_LABELS: Record<UserMode, string> = {
  host: "Host user",
  squashed: "Host user, squashed",
  image: "Image default user",
};

/**
 * A profile's user mode. Profiles from before the choice have `runAsHostUser`, where false meant
 * the image's user; a mode the engine lacks runs as you.
 */
export function profileUser(profile: {
  engine: Engine;
  user?: UserMode | undefined;
  runAsHostUser?: boolean | undefined;
}): UserMode {
  const user = profile.user ?? (profile.runAsHostUser === false ? "image" : "host");
  const modes = ENGINE_USER_MODES[profile.engine];
  return modes.includes(user) ? user : modes[0]!;
}

/** "Podman · node:22", or "Bubblewrap · host system". */
export function describeProfile(profile: { engine: Engine; image: string }): string {
  const what = engineReadsWorkspaceConfig(profile.engine)
    ? "workspace devcontainer.json"
    : engineUsesImage(profile.engine)
      ? profile.image
      : "host system";
  return `${ENGINE_LABELS[profile.engine]} · ${what}`;
}

/** Engines that run an image. */
export function engineUsesImage(engine: Engine): boolean {
  return engine !== "bubblewrap" && engine !== "devcontainer";
}

/**
 * Engines that keep a sandbox per workspace between launches, which can be restarted and
 * recreated. Bubblewrap, Apptainer, and Singularity start a fresh one for every launch.
 */
export function enginePersistent(engine: Engine): boolean {
  return engine !== "bubblewrap" && engine !== "apptainer" && engine !== "singularity";
}

/** Engines whose sandbox the workspace's own configuration describes, not the profile. */
export function engineReadsWorkspaceConfig(engine: Engine): boolean {
  return engine === "devcontainer";
}

/** The image new profiles start with: Node.js for the npm-installed agent CLIs, on Debian. */
export const DEFAULT_IMAGE = "docker.io/library/node:22-bookworm-slim";

/**
 * Whether an image names its registry, such as `docker.io/library/node:22` or `localhost/tools`.
 * The download confirmation shows exactly what will be fetched, and engines resolve short names
 * differently.
 */
export function isFullImageReference(image: string): boolean {
  const slash = image.indexOf("/");
  if (slash <= 0 || /\s/.test(image)) return false;
  const registry = image.slice(0, slash);
  return registry === "localhost" || registry.includes(".") || registry.includes(":");
}

/**
 * Splits extra run arguments into words as a POSIX shell would, without expanding anything:
 * whitespace separates words, single quotes keep everything, double quotes keep everything but
 * backslash before `"`, `\`, `$`, and backtick, and an unquoted backslash keeps the next character.
 * Throws on an unclosed quote or a trailing backslash.
 */
export function splitArguments(value: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else if (char === "'") {
      const end = value.indexOf("'", index + 1);
      if (end === -1) throw new Error("Extra run arguments have an unclosed '");
      word = (word ?? "") + value.slice(index + 1, end);
      index = end;
    } else if (char === '"') {
      word ??= "";
      for (index++; value[index] !== '"'; index++) {
        if (index >= value.length) throw new Error('Extra run arguments have an unclosed "');
        if (value[index] === "\\" && /["\\$`]/.test(value[index + 1] ?? "")) index++;
        word += value[index];
      }
    } else if (char === "\\") {
      if (index + 1 >= value.length) throw new Error("Extra run arguments end in a backslash");
      word = (word ?? "") + value[++index];
    } else {
      word = (word ?? "") + char;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

export const IMAGE_REFERENCE_HINT =
  "Use the full image reference, with its registry, such as docker.io/library/node:22";

const SIF_ENGINES: readonly Engine[] = ["apptainer", "singularity"];

/** A full image reference, or for Apptainer and Singularity also the absolute path of a SIF file. */
export function isValidImage(engine: Engine, image: string): boolean {
  if (SIF_ENGINES.includes(engine) && image.startsWith("/")) return true;
  return isFullImageReference(image);
}

export function imageHint(engine: Engine): string {
  return SIF_ENGINES.includes(engine)
    ? `${IMAGE_REFERENCE_HINT}, or the absolute path of a .sif file`
    : IMAGE_REFERENCE_HINT;
}

/** A saved sandbox configuration. Each workspace keeps a copy of the one it was created with. */
export const ContainerProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1, "Enter a name"),
  engine: EngineSchema,
  /** The engine's command, when not the default on PATH (`podman`, `docker`, `bwrap`, `msb`). */
  cli: z.string().trim().optional(),
  // Must contain the agent CLIs (claude, codex), or receive them through extraMounts. Bubblewrap
  // uses the host's system instead and ignores it.
  image: z.string().trim(),
  // Each engine maps these to its own options; see the README. "host" lets agents reach the
  // daemon's MCP endpoint on loopback.
  network: z.enum(["host", "bridge", "none"]),
  // Host paths, one per line or comma separated, mounted at the same path. ":ro" for read-only.
  extraMounts: z.string(),
  // Arguments added to `run`, split with shell quoting, such as `--memory 4g -e PATH=/opt/bin:/usr/bin`.
  extraRunArgs: z.string(),
  /** Who runs in the sandbox; read it with profileUser. Profiles from before it run as you. */
  user: z.enum(USER_MODES).optional(),
  /** Replaced by `user`: false meant the image's default user. Dropped when the profile is saved. */
  runAsHostUser: z.boolean().optional(),
  /** How the agents' own folders reach the sandbox; read it with profileAgentState. */
  agentState: z.enum(AGENT_STATES).optional(),
  /** Replaced by `agentState`: false meant off. Dropped when the profile is saved. */
  shareAgentState: z.boolean().optional(),
  /**
   * Where the workspace is inside the sandbox: at its host path, or under `sandboxFolder` as dev
   * containers place it. Profiles from before this setting use host paths.
   */
  paths: z.enum(WORKSPACE_PATHS).optional(),
  /** With sandbox paths, the folder workspaces go under; /workspaces when empty. */
  sandboxFolder: z.string().optional(),
  /** Dev containers: the Docker or Podman command; empty means docker, else podman, on PATH. */
  containerCli: z.string().optional(),
  /**
   * Give agents and terminal profiles the environment the sandbox's login shell sets up, read once
   * per sandbox. Dev containers follow their devcontainer.json's userEnvProbe instead. Profiles
   * from before this setting read it.
   */
  loginEnvironment: z.boolean().optional(),
});

export type ContainerProfile = z.infer<typeof ContainerProfileSchema>;

export const SandboxRecordSchema = z.object({
  workspaceId: z.string(),
  projectId: z.string(),
  cwd: z.string(),
  container: z.string(),
  createdAt: z.string(),
  /** The workspace's container configuration, copied from a profile when it was created. */
  profile: ContainerProfileSchema,
  /**
   * A sandboxed directory's project directory. The workspace lives at a link to it in the plugin's
   * data folder (`cwd`), so its agents and helpers are told apart from the project's other
   * workspaces by directory. Sandboxed directories from before links use the project directory.
   */
  linkedDirectory: z.string().optional(),
  /**
   * Registered under the workspace ID the plugin chose, before the workspace exists, so clients
   * that see the new workspace already find its sandbox. `cwd` is empty until creation returns.
   */
  pending: z.boolean().optional(),
  /**
   * The sandbox's Claude folder, from the profile's agent state when it was created: `private`
   * (isolated), `shared` (the host's), or `none` (off). `checking` is from before the choice, when
   * a check at the first start decided; such a sandbox follows its profile now.
   */
  claudeHome: z.enum(["private", "shared", "checking", "none"]),
  /** From before the choice: why the check decided as it did. No longer shown or written. */
  claudeHomeReason: z.string().optional(),
});

export type SandboxRecord = z.infer<typeof SandboxRecordSchema>;

/** How private Claude config folders sign in: through the host's login, kept current. */
export const ClaudeLoginSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("signed-in"), expiresAt: z.number() }),
  /** CLAUDE_CODE_OAUTH_TOKEN is configured, and sandboxes use it instead of the host's login. */
  z.object({ state: z.literal("env-token") }),
  z.object({ state: z.literal("signed-out"), message: z.string() }),
  z.object({ state: z.literal("refresh-failed"), message: z.string() }),
]);

export type ClaudeLogin = z.infer<typeof ClaudeLoginSchema>;

/** An image download the sandbox needs the user's go-ahead for: missing, or older than its tag's. */
export const ImageDownloadSchema = z.object({
  /** The image, or for a dev container, its devcontainer.json. */
  image: z.string(),
  /** `devcontainer`: a dev container is about to be created, which may download and build. */
  reason: z.enum(["missing", "outdated", "devcontainer"]),
  /** For a dev container: what creating it does, including what reaches the host. */
  details: z.array(z.string()).optional(),
});

export type ImageDownload = z.infer<typeof ImageDownloadSchema>;

/**
 * The user's answer for an image that needs downloading: `download` it, or for an outdated image,
 * use the `local` copy as it is. It names the image, so it can't apply to another.
 */
export const ImageChoiceSchema = z.object({
  image: z.string().min(1),
  action: z.enum(["download", "local"]),
});

export type ImageChoice = z.infer<typeof ImageChoiceSchema>;

export const ContainerStatusSchema = z.discriminatedUnion("state", [
  /** `downloading` names the image being pulled. */
  z.object({ state: z.literal("starting"), downloading: z.string().optional() }),
  z.object({ state: z.literal("running") }),
  z.object({ state: z.literal("stopped") }),
  z.object({ state: z.literal("missing") }),
  /** `download`: the image needs downloading, which waits for the user's go-ahead. */
  z.object({
    state: z.literal("failed"),
    error: z.string(),
    download: ImageDownloadSchema.optional(),
  }),
]);

export type ContainerStatus = z.infer<typeof ContainerStatusSchema>;

export const createSandboxedWorkspaceRpc = defineRpc({
  name: "sandbox.workspace.create",
  input: z.object({
    projectId: z.string().min(1),
    /** The container profile to copy; the default profile when omitted. */
    profileId: z.string().min(1).optional(),
    /**
     * `worktree` (Git projects only) gives the sandbox its own worktree; `directory` uses the
     * project directory, which the project's other workspaces share. Defaults to `worktree` for
     * Git projects and `directory` otherwise.
     */
    isolation: z.enum(["worktree", "directory"]).optional(),
    /** Starting ref for a Git project's worktree; the project's current branch when omitted. */
    baseRef: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1).optional(),
    /**
     * What to do when the profile's image is missing or outdated. Without it, nothing is
     * downloaded and such an image fails the sandbox's start.
     */
    imageChoice: ImageChoiceSchema.optional(),
  }),
  /** Returns as soon as the workspace exists; the sandbox is ready when its status says so. */
  output: z.object({ workspaceId: z.string() }),
});

export const SandboxTerminalProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The command it runs, shown in the launch menu. */
  command: z.string(),
});

export type SandboxTerminalProfile = z.infer<typeof SandboxTerminalProfileSchema>;

export const listTerminalProfilesRpc = defineRpc({
  name: "sandbox.terminal-profiles.list",
  input: z.object({}),
  output: z.object({ profiles: z.array(SandboxTerminalProfileSchema) }),
});

export const listRefsRpc = defineRpc({
  name: "sandbox.refs.list",
  input: z.object({ projectId: z.string().min(1) }),
  output: z.object({
    current: z.string().nullable(),
    refs: z.array(z.object({ name: z.string(), remote: z.boolean() })),
  }),
});

const ProfileListSchema = z.object({
  profiles: z.array(ContainerProfileSchema),
  defaultId: z.string(),
});

export const listContainerProfilesRpc = defineRpc({
  name: "sandbox.container-profiles.list",
  input: z.object({}),
  output: ProfileListSchema,
});

export const saveContainerProfileRpc = defineRpc({
  name: "sandbox.container-profiles.save",
  input: z.object({
    /** Without an ID, a new profile is added. */
    profile: ContainerProfileSchema.extend({ id: z.string().min(1).optional() }),
    makeDefault: z.boolean(),
  }),
  output: ProfileListSchema.extend({ saved: ContainerProfileSchema }),
});

export const deleteContainerProfileRpc = defineRpc({
  name: "sandbox.container-profiles.delete",
  input: z.object({ id: z.string().min(1) }),
  output: ProfileListSchema,
});

/** The workspace a start command preview is for: a new one from the form, or an existing one. */
export const PreviewContextSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("new"),
    projectId: z.string().min(1),
    isolation: z.enum(["worktree", "directory"]),
  }),
  z.object({ kind: z.literal("sandbox"), workspaceId: z.string().min(1) }),
]);

export type PreviewContext = z.infer<typeof PreviewContextSchema>;

export const previewContainerCommandRpc = defineRpc({
  name: "sandbox.container-profiles.preview-command",
  input: z.object({
    profile: ContainerProfileSchema.omit({ id: true }),
    /** Without one, a plain checkout at a placeholder path. */
    context: PreviewContextSchema.optional(),
  }),
  output: z.object({ command: z.string() }),
});

/**
 * Whether new worktrees of a project link to their repository by relative path, which sandbox paths
 * need: `relative` when the repository is set to, `absolute` when not, `unsupported` when the host's
 * Git is older than 2.48 and cannot.
 */
export const RelativeWorktreesSchema = z.object({
  state: z.enum(["relative", "absolute", "unsupported"]),
  gitVersion: z.string(),
});

export type RelativeWorktrees = z.infer<typeof RelativeWorktreesSchema>;

export const relativeWorktreesStatusRpc = defineRpc({
  name: "sandbox.git.relative-worktrees.status",
  input: z.object({ projectId: z.string().min(1) }),
  output: RelativeWorktreesSchema,
});

/** Switches a project's repository and its existing worktrees to relative paths. */
export const enableRelativeWorktreesRpc = defineRpc({
  name: "sandbox.git.relative-worktrees.enable",
  input: z.object({ projectId: z.string().min(1) }),
  output: RelativeWorktreesSchema,
});

const PATH_DESCRIPTION = (folder: string | null) =>
  folder ? `a place under ${folder}` : "its host path";

const CLAUDE_FOLDER_DESCRIPTION: Record<"none" | "shared" | "private", string> = {
  none: "no Claude folder",
  shared: "your host Claude folder",
  private: "its private Claude folder",
};

/**
 * What recreating a sandbox with other settings changes for what already ran in it, for the
 * Sandbox panel to show before the user goes ahead.
 */
export function profileChangeWarnings(
  sandbox: Pick<SandboxRecord, "profile" | "claudeHome">,
  next: Omit<ContainerProfile, "id">,
): string[] {
  const current = sandbox.profile;
  const warnings: string[] = [];
  if (current.engine !== next.engine) {
    warnings.push(
      `The engine changes from ${ENGINE_LABELS[current.engine]} to ${ENGINE_LABELS[next.engine]}`,
    );
  } else if (engineUsesImage(next.engine) && current.image !== next.image) {
    warnings.push(`The image changes to ${next.image}`);
  }
  const before = profileSandboxFolder(current);
  const after = profileSandboxFolder(next);
  if (before !== after) {
    warnings.push(
      `The workspace's path inside the sandbox changes from ${PATH_DESCRIPTION(before)} to ${PATH_DESCRIPTION(after)}: agents' sessions and the paths they recorded refer to the old one, so resuming them may fail`,
    );
  }
  const claudeBefore = sandbox.claudeHome === "checking" ? "private" : sandbox.claudeHome;
  const claudeAfter = CLAUDE_HOME_FOR[profileAgentState(next)];
  if (claudeBefore !== claudeAfter) {
    warnings.push(
      `Claude moves from ${CLAUDE_FOLDER_DESCRIPTION[claudeBefore]} to ${CLAUDE_FOLDER_DESCRIPTION[claudeAfter]}: Claude agents started before won't find their sessions to resume, and Paseo may not show their history`,
    );
  }
  if (profileAgentState(current) === "shared" && profileAgentState(next) !== "shared") {
    warnings.push("The other agents' folders are no longer mounted, so they start signed out");
  }
  if (profileUser(current) !== profileUser(next)) {
    warnings.push(
      `The user changes from ${USER_LABELS[profileUser(current)]} to ${USER_LABELS[profileUser(next)]}: files the sandbox writes from now on may belong to someone else`,
    );
  }
  return warnings;
}

/**
 * What restarting or recreating a sandbox affects: the workspace's agents with a live session,
 * resumed afterwards, and all of its terminals, closed.
 */
export const SandboxDependentsSchema = z.object({
  agents: z.array(z.object({ id: z.string(), title: z.string().nullable(), status: z.string() })),
  terminals: z.array(z.object({ id: z.string(), name: z.string() })),
});

export type SandboxDependents = z.infer<typeof SandboxDependentsSchema>;

export const sandboxDependentsRpc = defineRpc({
  name: "sandbox.dependents",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: SandboxDependentsSchema,
});

/** Stops and starts a workspace's sandbox, for engines that keep one. */
export const restartSandboxRpc = defineRpc({
  name: "sandbox.restart",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.object({}),
});

/**
 * Removes a workspace's sandbox and creates it again, from its own copy of a profile or, when
 * given, from other settings, which become the sandbox's copy.
 */
export const recreateSandboxRpc = defineRpc({
  name: "sandbox.recreate",
  input: z.object({
    workspaceId: z.string().min(1),
    profile: ContainerProfileSchema.extend({ id: z.string().min(1).optional() }).optional(),
  }),
  output: z.object({}),
});

/** What the header badge shows: known without inspecting the container. */
export const SandboxHealthSchema = z.discriminatedUnion("state", [
  /** The sandbox is still starting. */
  z.object({ state: z.literal("starting") }),
  z.object({ state: z.literal("ready") }),
  z.object({ state: z.literal("failed"), error: z.string() }),
]);

export type SandboxHealth = z.infer<typeof SandboxHealthSchema>;

export const listSandboxesRpc = defineRpc({
  name: "sandbox.list",
  input: z.object({}),
  output: z.object({
    sandboxes: z.array(SandboxRecordSchema.extend({ health: SandboxHealthSchema })),
    claudeLogin: ClaudeLoginSchema,
  }),
});

export const sandboxStatusRpc = defineRpc({
  name: "sandbox.status",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({
    sandbox: SandboxRecordSchema.nullable(),
    container: ContainerStatusSchema.nullable(),
    claudeLogin: ClaudeLoginSchema,
    /** The Claude config folder the container uses. */
    claudeConfigDir: z.string().nullable(),
    /** With sandbox paths, the workspace directory inside the sandbox. */
    sandboxDirectory: z.string().nullable(),
  }),
});

export const openSandboxShellRpc = defineRpc({
  name: "sandbox.shell.open",
  /** Without a profile, a login shell; with one, the profile's command. */
  input: z.object({
    workspaceId: z.string(),
    profileId: z.string().optional(),
  }),
  output: z.object({ terminalId: z.string() }),
});

/**
 * Whether a profile's image is on this machine and current with its registry, so the form can ask
 * before downloading it. `unverified`: present, but the registry could not be asked.
 */
export const imageStatusRpc = defineRpc({
  name: "sandbox.image.status",
  input: z.object({ profileId: z.string().min(1).optional() }),
  /** `image` is null for engines that run the host's system. */
  output: z.object({
    image: z.string().nullable(),
    state: z.enum(["current", "missing", "outdated", "unverified"]),
  }),
});

/**
 * Starts a sandbox whose image needs downloading: downloads the image the user named, or uses the
 * local copy of an outdated one.
 */
export const chooseImageRpc = defineRpc({
  name: "sandbox.image.choose",
  input: ImageChoiceSchema.extend({ workspaceId: z.string() }),
  output: z.object({}),
});
