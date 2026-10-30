import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * What runs a workspace's sandbox. Podman, Docker, and microsandbox keep one long-lived sandbox per
 * workspace from an image; Bubblewrap starts a fresh one for each launch from the host's
 * own system, read-only.
 */
export const ENGINES = ["podman", "docker", "bubblewrap", "microsandbox"] as const;
export const EngineSchema = z.enum(ENGINES);
export type Engine = z.infer<typeof EngineSchema>;

const ENGINE_LABELS: Record<Engine, string> = {
  podman: "Podman",
  docker: "Docker",
  bubblewrap: "Bubblewrap",
  microsandbox: "microsandbox",
};

/** "Podman · node:22", or "Bubblewrap · host system". */
export function describeProfile(profile: { engine: Engine; image: string }): string {
  const what = engineUsesImage(profile.engine) ? profile.image : "host system";
  return `${ENGINE_LABELS[profile.engine]} · ${what}`;
}

/** Engines that run an image. */
export function engineUsesImage(engine: Engine): boolean {
  return engine !== "bubblewrap";
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

export const IMAGE_REFERENCE_HINT =
  "Use the full image reference, with its registry, such as docker.io/library/node:22";

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
  // Whitespace-separated arguments added to `run`, such as `--memory 4g -e PATH=/opt/bin:/usr/bin`.
  extraRunArgs: z.string(),
  /**
   * Podman, Docker, and microsandbox: run as your uid and gid with your home path as HOME and an
   * account for you in the image, or, when false, as the image's own default user and home.
   * Bubblewrap always runs as you. Profiles from before this setting run as you.
   */
  runAsHostUser: z.boolean().optional(),
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
   * `private`: the container gets its own Claude config folder and signs in with the host's
   * current access token. `shared`: the container's own configuration already makes the host's
   * folder writable, so it uses that. `checking`: being decided as the sandbox starts.
   */
  claudeHome: z.enum(["private", "shared", "checking"]),
  /** Why `claudeHome` was chosen, for the Sandbox panel. */
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
  image: z.string(),
  reason: z.enum(["missing", "outdated"]),
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
