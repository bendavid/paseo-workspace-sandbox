import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** A saved container configuration. Each workspace keeps a copy of the one it was created with. */
export const ContainerProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1, "Enter a name"),
  // Must contain the agent CLIs (claude, codex), or receive them through extraMounts.
  image: z.string().trim().min(1, "Enter an image"),
  // Agents reach the daemon's MCP endpoint on loopback, so "host" keeps Paseo tools working.
  network: z.enum(["host", "bridge", "none"]),
  // Host paths, one per line or comma separated, mounted at the same path. ":ro" for read-only.
  extraMounts: z.string(),
  // Whitespace-separated arguments added to `run`, such as `--memory 4g -e PATH=/opt/bin:/usr/bin`.
  extraRunArgs: z.string(),
});

export type ContainerProfile = z.infer<typeof ContainerProfileSchema>;

export const SandboxRecordSchema = z.object({
  workspaceId: z.string(),
  projectId: z.string(),
  cwd: z.string(),
  container: z.string(),
  image: z.string(),
  createdAt: z.string(),
  /** The workspace's container configuration, copied from a profile when it was created. */
  profile: ContainerProfileSchema.optional(),
  /**
   * Registered under the workspace ID the plugin chose, before the workspace exists, so clients
   * that see the new workspace already find its sandbox. `cwd` is empty until creation returns.
   */
  pending: z.boolean().optional(),
  /**
   * `private`: the container gets its own Claude config folder and signs in with the host's
   * current access token. `shared`: the container's own configuration already makes the host's
   * folder writable, so it uses that. `checking`: being decided as the sandbox starts. Sandboxes
   * from before this field share the host's folder.
   */
  claudeHome: z.enum(["private", "shared", "checking"]).optional(),
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

export const ContainerStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("starting") }),
  z.object({ state: z.literal("running") }),
  z.object({ state: z.literal("stopped") }),
  z.object({ state: z.literal("missing") }),
  z.object({ state: z.literal("failed"), error: z.string() }),
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
     * Names the workspace and branch, as New workspace's prompt does: the launch terminal's command
     * or prompt. Agents start from the workspace's own composer once the sandbox is ready.
     */
    prompt: z.string().trim().min(1).optional(),
  }),
  /** Returns as soon as the workspace exists; the sandbox is ready when its status says so. */
  output: z.object({ workspaceId: z.string() }),
});

export const SandboxTerminalProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Whether the composer text goes into the profile's command as a prompt. */
  takesPrompt: z.boolean(),
  /** The command it runs with no prompt, shown in the launch menu. */
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
  /** The container, or the form's first agent, is still starting. */
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
  /**
   * Without a profile, a login shell, with `prompt` typed at it as a command; with one, the
   * profile's command with `prompt` substituted.
   */
  input: z.object({
    workspaceId: z.string(),
    profileId: z.string().optional(),
    prompt: z.string().optional(),
  }),
  output: z.object({ terminalId: z.string() }),
});
