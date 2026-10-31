import { realpath } from "node:fs/promises";
import path from "node:path";
import { backendFor } from "./backends";
import type { CommandLine } from "./backends/types";
import {
  claudeMounts,
  combineMounts,
  parseExtraMounts,
  sharedProviderDirectories,
  shellQuote,
  type ClaudeHome,
  type ContainerPolicy,
  type ContainerTarget,
  type Mount,
  gitDirectories,
  workspaceLayout,
} from "./container";
import type { SandboxRecord } from "../shared/rpc";

// What a workspace fills in when the preview has no real path or name for it.
const WORKSPACE = "<workspace>";
const WORKSPACE_ID = "<workspace-id>";
const WORKTREE = "<worktree>";

/** The workspace the preview is for, as far as it is known. */
export type PreviewWorkspace =
  /** Settings: no workspace in view, so a plain checkout at a placeholder path. */
  | { kind: "generic" }
  /** The New sandboxed workspace form: the project and the worktree or directory choice. */
  | { kind: "new"; projectRoot: string; isolation: "worktree" | "directory" }
  /** The Sandbox panel: an existing sandbox, with its real paths and name. */
  | { kind: "sandbox"; record: SandboxRecord };

/** Where the plugin keeps a workspace's own folders, real paths with the workspace ID in them. */
export interface PreviewPaths {
  hostConfigDir: string;
  signInDir: string;
  claudeHomeDir(workspaceId: string): string;
  linkPath(workspaceId: string): string;
}

/**
 * The command a sandbox from a profile starts with, as the engine builds it, with the real paths
 * and names the workspace has and placeholders for the rest; per-launch engines show `<command>`
 * for what each launch runs.
 */
export async function previewCommand(input: {
  policy: ContainerPolicy;
  image: string;
  /** With sandbox paths, the folder workspaces go under. */
  sandboxFolder: string | null;
  workspace: PreviewWorkspace;
  paths: PreviewPaths;
}): Promise<string> {
  const { policy, sandboxFolder, workspace, paths } = input;
  const record = workspace.kind === "sandbox" ? workspace.record : null;
  const workspaceId = record?.workspaceId ?? WORKSPACE_ID;
  const layout = await previewLayout(workspace, sandboxFolder, paths);
  const target: ContainerTarget = {
    container: record?.container ?? "<sandbox>",
    label: `workspace=${workspaceId}`,
    image: input.image || "<image>",
    workspace: layout.workspace,
    workdir: layout.workdir,
    claude: previewClaude(policy, paths, workspaceId),
    ...(layout.linkedDirectory ? { linkedDirectory: layout.linkedDirectory } : {}),
    ...(sandboxFolder ? { sandboxFolder } : {}),
  };
  const mounts: Mount[] = [
    ...layout.mounts,
    ...claudeMounts(target.claude, () => true),
    ...sharedProviderDirectories(policy).map((directory) => ({ path: directory, readOnly: false })),
  ];
  const combined = combineMounts(mounts, parseExtraMounts(policy.extraMounts));
  const line = await backendFor(policy.engine).commandLine(target, policy, combined, ["<command>"]);
  return formatCommand(policy.cli, line);
}

interface PreviewLayout {
  workspace: string;
  workdir: string;
  mounts: Mount[];
  linkedDirectory?: string;
}

async function previewLayout(
  workspace: PreviewWorkspace,
  sandboxFolder: string | null,
  paths: PreviewPaths,
): Promise<PreviewLayout> {
  const folder = sandboxFolder ?? undefined;
  if (workspace.kind === "sandbox") {
    const { record } = workspace;
    return layoutOf({
      workspace: record.cwd,
      ...(record.linkedDirectory ? { linkedDirectory: record.linkedDirectory } : {}),
      ...(folder ? { sandboxFolder: folder } : {}),
    });
  }
  if (workspace.kind === "new" && workspace.isolation === "directory") {
    // A sandboxed directory's link, which gets its name from the new workspace's ID.
    return layoutOf({
      workspace: paths.linkPath(WORKSPACE_ID),
      linkedDirectory: workspace.projectRoot,
      ...(folder ? { sandboxFolder: folder } : {}),
    });
  }
  if (workspace.kind === "new") return newWorktreeLayout(workspace.projectRoot, sandboxFolder);
  return plainCheckoutLayout(sandboxFolder);
}

/** The same layout the sandbox gets, without creating anything. */
async function layoutOf(
  where: Pick<ContainerTarget, "workspace" | "linkedDirectory" | "sandboxFolder">,
): Promise<PreviewLayout> {
  const target: ContainerTarget = {
    container: "<sandbox>",
    label: "",
    image: "",
    workdir: where.workspace,
    claude: { mode: "none" },
    ...where,
  };
  const layout = await workspaceLayout(target, { preview: true });
  return {
    workspace: where.workspace,
    workdir: layout.workdir,
    mounts: layout.mounts,
    ...(where.linkedDirectory ? { linkedDirectory: where.linkedDirectory } : {}),
  };
}

/**
 * A worktree Paseo has yet to create, of a real repository: its path and name are placeholders,
 * the repository's git metadata real. At sandbox paths its place depends on where Paseo puts it.
 */
async function newWorktreeLayout(
  projectRoot: string,
  sandboxFolder: string | null,
): Promise<PreviewLayout> {
  const git = await gitDirectories(projectRoot);
  const common = git
    ? await realpath(git.common).catch(() => git.common)
    : path.join(projectRoot, ".git");
  const worktrees = path.join(common, "worktrees");
  const host: Mount[] = [
    { path: WORKTREE, readOnly: false },
    { path: common, readOnly: false },
    { path: worktrees, readOnly: true },
    { path: path.join(worktrees, "<worktree-name>"), readOnly: false },
    { path: path.join(common, "hooks"), readOnly: true },
    { path: path.join(common, "config"), readOnly: true },
  ];
  if (!sandboxFolder) return { workspace: WORKTREE, workdir: WORKTREE, mounts: host };
  const workdir = path.posix.join(sandboxFolder, "<worktree-path>");
  const commonInside = path.posix.join(sandboxFolder, "<repository-path>", ".git");
  const inside = (hostPath: string) =>
    hostPath === WORKTREE
      ? workdir
      : hostPath.startsWith(common)
        ? commonInside + hostPath.slice(common.length)
        : hostPath;
  return {
    workspace: WORKTREE,
    workdir,
    mounts: host.map((mount) => ({ ...mount, source: mount.path, path: inside(mount.path) })),
  };
}

/** Settings' preview: a plain checkout, at a placeholder path. */
function plainCheckoutLayout(sandboxFolder: string | null): PreviewLayout {
  const workdir = sandboxFolder ? path.posix.join(sandboxFolder, "<name>") : WORKSPACE;
  const git = path.join(WORKSPACE, ".git");
  return {
    workspace: WORKSPACE,
    workdir,
    mounts: [
      { path: WORKSPACE, readOnly: false },
      { path: path.join(git, "hooks"), readOnly: true },
      { path: path.join(git, "config"), readOnly: true },
    ].map((mount) =>
      sandboxFolder
        ? { ...mount, source: mount.path, path: mount.path.replace(WORKSPACE, workdir) }
        : mount,
    ),
  };
}

function previewClaude(
  policy: ContainerPolicy,
  paths: PreviewPaths,
  workspaceId: string,
): ClaudeHome {
  switch (policy.agentState) {
    case "isolated":
      return {
        mode: "private",
        configDir: paths.claudeHomeDir(workspaceId),
        hostConfigDir: paths.hostConfigDir,
        authDir: paths.signInDir,
      };
    case "shared":
      return { mode: "shared", configDir: paths.hostConfigDir };
    case "off":
      return { mode: "none" };
  }
}

/** Placeholders and plain words stay as they are; anything else is shell-quoted. */
function displayWord(word: string): string {
  return /^[\w@%+=:,./<>~-]+$/.test(word) ? word : shellQuote(word);
}

/** One line for the command, one per option and its values, and one for the image and command. */
export function formatCommand(cli: string, line: CommandLine): string {
  const options: string[][] = [];
  for (const word of line.options) {
    if (word.startsWith("-") || options.length === 0) options.push([word]);
    else options.at(-1)!.push(word);
  }
  return [[cli, ...line.head], ...options, line.tail]
    .filter((words) => words.length > 0)
    .map((words) => words.map(displayWord).join(" "))
    .join(" \\\n  ");
}
