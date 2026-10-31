import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { PaseoApi } from "./paseo";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { ClaudeLoginKeeper } from "./claude-login";
import { prepareClaudeHome } from "./claude-home";
import { previewCommand, type PreviewWorkspace } from "./command-preview";
import { backendFor, resolveContainerCli, resolveEngineCli } from "./backends/index";
import type { ImageStore } from "./backends/types";
import { checkImage } from "./registry";
import {
  containerName,
  createLink,
  removeLink,
  shellQuote,
  workspaceLayout,
  workspaceTarget,
  type ClaudeHome,
  type ContainerPolicy,
  type ContainerTarget,
} from "./container";
import type { ContainerProfiles } from "./container-profiles";
import { enableRelativeWorktrees, listRefs, relativeWorktrees } from "./git";
import { resolveTerminalLaunch } from "./terminals";
import { writeFileAtomic, type SandboxStore } from "./store";
import {
  CLAUDE_HOME_FOR,
  engineReadsWorkspaceConfig,
  engineUsesImage,
  imageHint,
  isValidImage,
  profileAgentState,
  profileSandboxFolder,
  recordAgentState,
  profileUser,
  type ContainerProfile,
  type ContainerStatus,
  type ImageChoice,
  type ImageDownload,
  type PreviewContext,
  type RelativeWorktrees,
  type SandboxDependents,
  type SandboxHealth,
  type SandboxRecord,
  type createSandboxedWorkspaceRpc,
  type imageStatusRpc,
  type listRefsRpc,
  type listSandboxesRpc,
  type openSandboxShellRpc,
  type sandboxStatusRpc,
} from "../shared/rpc";

type CreateInput = RpcInput<typeof createSandboxedWorkspaceRpc>;

/** Reads every page: a sandbox missing from a partial listing would be destroyed. */
async function listActiveWorkspaceIds(paseo: PaseoApi): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const { entries, pageInfo } = await paseo.workspaces.list({
      includeBackground: true,
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    for (const workspace of entries) ids.add(workspace.id);
    cursor = pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return ids;
}

/**
 * A worktree sandbox gets a directory of its own. A directory sandbox is a new workspace at its
 * link to the project directory, which the project's other workspaces share, so it gets a title
 * that tells them apart.
 */
function buildWorkspaceRequest(
  input: CreateInput,
  plan: {
    isolation: "worktree" | "directory";
    link: string;
    project: {
      projectRootPath: string;
      projectCustomName?: string | null;
      projectDisplayName: string;
    };
  },
) {
  const source =
    plan.isolation === "worktree"
      ? {
          kind: "worktree" as const,
          projectId: input.projectId,
          action: "branch-off" as const,
          ...(input.baseRef ? { baseBranch: input.baseRef } : {}),
        }
      : { kind: "directory" as const, path: plan.link, projectId: input.projectId };
  const defaultTitle =
    plan.isolation === "directory"
      ? `${plan.project.projectCustomName ?? plan.project.projectDisplayName} (sandboxed)`
      : undefined;
  const title = input.title ?? defaultTitle;
  return { source, ...(title ? { title } : {}) };
}

/** The sandbox needs to download its image, missing or outdated, and nobody agreed to it. */
class ImageDownloadError extends Error {
  constructor(readonly download: ImageDownload) {
    super(
      download.reason === "devcontainer"
        ? "Creating the dev container waits for your go-ahead. Review what it does in the Sandbox panel."
        : download.reason === "missing"
          ? `The image ${download.image} is not on this machine. Download it from the Sandbox panel.`
          : `The registry has a newer ${download.image} than this machine. Update it or use the local image from the Sandbox panel.`,
    );
    this.name = "ImageDownloadError";
  }
}

interface StartFailure {
  message: string;
  download?: ImageDownload;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** At sandbox paths, a worktree's git links must be relative to resolve inside. */
async function requireRelativeWorktrees(
  profile: Omit<ContainerProfile, "id">,
  repositoryRoot: string,
): Promise<void> {
  if (!profileSandboxFolder(profile)) return;
  const { state, gitVersion } = await relativeWorktrees(repositoryRoot);
  if (state === "unsupported") {
    throw new Error(
      `Sandbox paths for worktrees need Git 2.48 or newer; this host has ${gitVersion}`,
    );
  }
  if (state === "absolute") {
    throw new Error(
      "Sandbox paths for worktrees need the repository's worktrees to use relative paths",
    );
  }
}

interface PendingRestart {
  paseo: PaseoApi;
  agents: string[];
}

/** Agents with a live session; a closed agent opens with the current settings when next used. */
const LIVE_AGENT_STATUSES = ["initializing", "idle", "running", "error"] as const;

export class SandboxService {
  // In-flight ensureRunning attempts by workspace ID; each resolves to null or why it failed.
  private readonly starting = new Map<string, Promise<string | null>>();
  private readonly failures = new Map<string, StartFailure>();
  /**
   * The user's answer for an image that needs downloading, by workspace ID: from the form at
   * creation, or the Sandbox panel. It covers the next start attempt only and is never stored, so
   * retries, restarts, and recreated containers download nothing and ask again.
   */
  private readonly imageChoices = new Map<string, ImageChoice>();
  /** Workspaces whose image is downloading. */
  private readonly downloading = new Set<string>();
  /** Workspaces this process is creating; their pending records are not leftovers. */
  private readonly creating = new Set<string>();
  /**
   * Agents to resume once a changed sandbox runs again, by workspace ID: the next start that
   * succeeds resumes them, so a start waiting for a download still does.
   */
  private readonly pendingRestarts = new Map<string, PendingRestart>();

  constructor(
    private readonly store: SandboxStore,
    private readonly containerProfiles: ContainerProfiles,
    private readonly login: ClaudeLoginKeeper,
    readonly wrapper: string,
  ) {}

  private claudeHome(record: SandboxRecord): ClaudeHome {
    if (record.claudeHome === "checking" || record.claudeHome === "none") return { mode: "none" };
    if (record.claudeHome === "shared") {
      return { mode: "shared", configDir: this.login.hostConfigDir };
    }
    return {
      mode: "private",
      configDir: this.store.claudeHomeDir(record.workspaceId),
      hostConfigDir: this.login.hostConfigDir,
      authDir: this.login.directory,
    };
  }

  /** A workspace's container target, with its private Claude folder prepared. */
  private async prepareTarget(record: SandboxRecord): Promise<ContainerTarget> {
    const claude = this.claudeHome(record);
    if (claude.mode === "private") {
      await prepareClaudeHome({
        directory: claude.configDir,
        hostConfigDir: claude.hostConfigDir,
        helperCommand: this.login.helperCommand,
      });
    }
    return this.layoutTarget(record, claude);
  }

  /** A workspace's container target, with its working directory inside the sandbox. */
  private async layoutTarget(record: SandboxRecord, claude: ClaudeHome): Promise<ContainerTarget> {
    const target = workspaceTarget(record, claude);
    if (!target.sandboxFolder) return target;
    // An engine that places the workspace itself knows where, once the sandbox exists.
    const placed = await backendFor(record.profile.engine).workspaceFolder?.(target);
    return { ...target, workdir: placed || (await workspaceLayout(target)).workdir };
  }

  /** A sandbox's policy, with the agent state its Claude folder was settled with. */
  private async recordPolicy(record: SandboxRecord): Promise<ContainerPolicy> {
    return { ...(await this.policy(record.profile)), agentState: recordAgentState(record) };
  }

  /** A profile's engine and its command, plus the network, mounts, and run arguments. */
  private async policy(profile: Omit<ContainerProfile, "id">): Promise<ContainerPolicy> {
    return {
      engine: profile.engine,
      cli: await resolveEngineCli(profile.engine, profile.cli),
      network: profile.network,
      extraMounts: profile.extraMounts,
      extraRunArgs: profile.extraRunArgs,
      // Engines without the choice always run as you; profiles from before the setting do too.
      user: profileUser(profile),
      agentState: profileAgentState(profile),
      ...(engineReadsWorkspaceConfig(profile.engine)
        ? { containerCli: await resolveContainerCli(profile.containerCli) }
        : {}),
    };
  }

  /** The command a sandbox from this profile starts with; see previewCommand. */
  async previewCommand(
    profile: Omit<ContainerProfile, "id">,
    context: PreviewContext | undefined,
    paseo: PaseoApi,
  ): Promise<string> {
    return previewCommand({
      policy: await this.policy(profile),
      image: profile.image,
      sandboxFolder: profileSandboxFolder(profile),
      workspace: await this.previewWorkspace(context, paseo),
      paths: {
        hostConfigDir: this.login.hostConfigDir,
        signInDir: this.login.directory,
        claudeHomeDir: (workspaceId) => this.store.claudeHomeDir(workspaceId),
        linkPath: (workspaceId) => this.store.linkPath(workspaceId),
      },
    });
  }

  private async previewWorkspace(
    context: PreviewContext | undefined,
    paseo: PaseoApi,
  ): Promise<PreviewWorkspace> {
    if (context?.kind === "sandbox") {
      const record = this.store.get(context.workspaceId);
      return record && !record.pending ? { kind: "sandbox", record } : { kind: "generic" };
    }
    if (context?.kind === "new") {
      const project = await this.project(context.projectId, paseo);
      return {
        kind: "new",
        projectRoot: project.projectRootPath,
        // A project without Git gets a sandboxed directory, whatever the form held.
        isolation: project.projectKind === "git" ? context.isolation : "directory",
      };
    }
    return { kind: "generic" };
  }

  /** What `sandbox-run` sources to join a workspace's sandbox; see its contract in wrapper.ts. */
  private async writeSpec(
    record: SandboxRecord,
    target: ContainerTarget,
    policy: ContainerPolicy,
  ): Promise<void> {
    await writeFileAtomic(
      this.store.specFile(record.workspaceId),
      [
        `# Generated by the workspace-sandbox plugin: ${policy.engine}.`,
        `sandbox_workdir=${shellQuote(target.workdir)}`,
        // Where launches start on the host, by the path Paseo knows and by its real path.
        `sandbox_host_workdir=${shellQuote(record.cwd)}`,
        `sandbox_host_realdir=${shellQuote(await realpath(record.cwd).catch(() => record.cwd))}`,
        // A dev container's spec says how, from its devcontainer.json.
        ...(engineReadsWorkspaceConfig(policy.engine)
          ? []
          : [
              `sandbox_env_probe=${record.profile.loginEnvironment === false ? "none" : "loginInteractiveShell"}`,
            ]),
        await backendFor(policy.engine).spec(target, policy),
        "",
      ].join("\n"),
    );
  }

  /** Starts or recreates the container. */
  private async runContainer(listed: SandboxRecord): Promise<void> {
    const record = await this.settleClaudeHome(listed);
    const policy = await this.recordPolicy(record);
    const backend = backendFor(policy.engine);
    // Creating the sandbox, retries included, runs the image, so it is checked against its
    // registry first. Restarting an existing container or microVM is not.
    const runsImage =
      (await backend.status(workspaceTarget(record, { mode: "none" }), policy)).state === "missing";
    if (backend.images && runsImage) await this.ensureImage(record, policy, backend.images);
    if (backend.creationConsent) await this.ensureConsent(record, policy);
    const target = await this.prepareTarget(record);
    await this.writeSpec(record, target, policy);
    await backend.start(target, policy);
    // An engine that places the workspace itself has said where only now.
    if (backend.workspaceFolder) {
      await this.writeSpec(record, await this.layoutTarget(record, target.claude), policy);
    }
  }

  /**
   * A sandbox described by the workspace's own configuration is created only when the user agreed
   * to what creating it does, which can run commands on the host and download; like an image
   * choice, the answer covers the next attempt only.
   */
  private async ensureConsent(record: SandboxRecord, policy: ContainerPolicy): Promise<void> {
    const backend = backendFor(policy.engine);
    const needed = await backend.creationConsent?.(
      workspaceTarget(record, { mode: "none" }),
      policy,
    );
    if (!needed) return;
    const choice = this.imageChoices.get(record.workspaceId);
    if (choice?.image !== needed.image || choice.action !== "download") {
      throw new ImageDownloadError(needed);
    }
  }

  /**
   * Makes sure the local image is the registry's current one for its tag. A missing or outdated
   * image downloads only when the user agreed to download exactly it, and an outdated one is used
   * as it is when the user chose so; one the registry can't confirm is used as it is.
   */
  private async ensureImage(
    record: SandboxRecord,
    policy: ContainerPolicy,
    images: ImageStore,
  ): Promise<void> {
    const { image } = record.profile;
    const state = await checkImage(image, await images.localDigests(policy.cli, image));
    if (state === "current" || state === "unverified") return;
    if (images.pullable?.(image) === false)
      throw new Error(`The image file ${image} does not exist`);
    const choice = this.imageChoices.get(record.workspaceId);
    if (choice?.image === image && choice.action === "local" && state === "outdated") return;
    if (choice?.image !== image || choice.action !== "download") {
      throw new ImageDownloadError({ image, reason: state });
    }
    this.downloading.add(record.workspaceId);
    try {
      await images.pull(policy.cli, image);
    } finally {
      this.downloading.delete(record.workspaceId);
    }
  }

  /**
   * A sandbox from before the agent state choice whose Claude folder a check was still to decide
   * gets the folder its profile's agent state gives.
   */
  private async settleClaudeHome(record: SandboxRecord): Promise<SandboxRecord> {
    if (record.claudeHome !== "checking") return record;
    const settled: SandboxRecord = {
      ...record,
      claudeHome: CLAUDE_HOME_FOR[profileAgentState(record.profile)],
    };
    if (this.store.get(record.workspaceId)) await this.store.put(settled);
    return settled;
  }

  /**
   * Makes sure a workspace's container runs. The plugin is its only owner: workspace creation,
   * agent launches, and terminals all come through here, so concurrent callers share one attempt.
   * Resolves to null, or to why the container did not start, which the badge and panel show; the
   * next caller tries again.
   */
  ensureRunning(workspaceId: string): Promise<string | null> {
    const inFlight = this.starting.get(workspaceId);
    if (inFlight) return inFlight;
    const record = this.store.get(workspaceId);
    if (!record) return Promise.resolve("This workspace is not sandboxed");
    this.failures.delete(workspaceId);
    const task = this.runContainer(record)
      .then(() => {
        void this.runPendingRestarts(workspaceId);
        return null;
      })
      .catch((error: unknown) => {
        const message = describeError(error);
        this.failures.set(workspaceId, {
          message,
          ...(error instanceof ImageDownloadError ? { download: error.download } : {}),
        });
        const detail = error instanceof Error && error.cause ? error.cause : error;
        console.error(`Sandbox ${record.container} failed to start`, describeError(detail));
        return message;
      })
      .finally(() => {
        this.starting.delete(workspaceId);
        this.imageChoices.delete(workspaceId);
      });
    this.starting.set(workspaceId, task);
    return task;
  }

  /**
   * Waits for the container before a launch, within the caller's own time limit (a plugin hook
   * gets 30 seconds, an RPC 60). Starting a stopped container or deciding the Claude folder takes a
   * second or two; only an image's first pull runs longer, and goes on in the background.
   */
  async readyWithin(workspaceId: string, timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      const outcome = await Promise.race([this.ensureRunning(workspaceId), timeout]);
      if (outcome === "timeout") {
        throw new Error(
          this.downloading.has(workspaceId)
            ? "The sandbox is still downloading its image. Try again in a moment."
            : "The sandbox is still starting. Try again in a moment.",
        );
      }
      if (outcome !== null) throw new Error(`The sandbox did not start: ${outcome}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Whether a project's new worktrees link to the repository relatively; see relativeWorktrees. */
  async relativeWorktrees(projectId: string, paseo: PaseoApi): Promise<RelativeWorktrees> {
    return relativeWorktrees((await this.gitProject(projectId, paseo)).projectRootPath);
  }

  /** Switches a project's repository to relative worktree paths, existing worktrees included. */
  async enableRelativeWorktrees(projectId: string, paseo: PaseoApi): Promise<RelativeWorktrees> {
    return enableRelativeWorktrees((await this.gitProject(projectId, paseo)).projectRootPath);
  }

  private async gitProject(projectId: string, paseo: PaseoApi) {
    const project = await this.project(projectId, paseo);
    if (project.projectKind !== "git")
      throw new Error(`${project.projectDisplayName} is not a Git project`);
    return project;
  }

  async refs(input: RpcInput<typeof listRefsRpc>, paseo: PaseoApi) {
    const project = await this.project(input.projectId, paseo);
    if (project.projectKind !== "git") return { current: null, refs: [] };
    return listRefs(project.projectRootPath);
  }

  private async project(projectId: string, paseo: PaseoApi) {
    const { projects } = await paseo.projects.list();
    const project = projects.find((candidate) => candidate.projectId === projectId);
    if (!project) throw new Error(`Project ${projectId} was not found`);
    return project;
  }

  /** Validates the request and resolves everything creation needs, before anything exists. */
  private async planCreation(input: CreateInput, paseo: PaseoApi) {
    const profile = this.containerProfiles.get(input.profileId);
    const project = await this.project(input.projectId, paseo);
    const isGit = project.projectKind === "git";
    const isolation = input.isolation ?? (isGit ? "worktree" : "directory");
    if (isolation === "worktree" && !isGit) {
      throw new Error("A sandboxed worktree needs a Git project");
    }
    const policy = await this.policy(profile);
    if (engineUsesImage(policy.engine) && !isValidImage(policy.engine, profile.image)) {
      throw new Error(`${imageHint(policy.engine)}, in the container profile "${profile.name}"`);
    }
    if (input.imageChoice && input.imageChoice.image !== profile.image) {
      throw new Error(
        `The image ${input.imageChoice.image} is not the profile's (${profile.image})`,
      );
    }
    // Paseo creates the worktree; at sandbox paths its git links must be relative to resolve.
    if (isolation === "worktree") await requireRelativeWorktrees(profile, project.projectRootPath);
    return { profile, project, isolation, policy };
  }

  /**
   * Registers the sandbox under a workspace ID chosen here, then creates the workspace with it:
   * every client that sees the new workspace already finds its sandbox.
   */
  private async createRegistered(
    input: CreateInput,
    plan: Awaited<ReturnType<SandboxService["planCreation"]>>,
    paseo: PaseoApi,
  ): Promise<SandboxRecord> {
    const workspaceId = `wks_${randomBytes(8).toString("hex")}`;
    const directory = plan.isolation === "directory";
    const link = this.store.linkPath(workspaceId);
    const pending: SandboxRecord = {
      workspaceId,
      projectId: input.projectId,
      cwd: "",
      container: containerName(workspaceId),
      createdAt: new Date().toISOString(),
      profile: plan.profile,
      pending: true,
      claudeHome: CLAUDE_HOME_FOR[profileAgentState(plan.profile)],
      ...(directory ? { linkedDirectory: plan.project.projectRootPath } : {}),
    };
    this.creating.add(workspaceId);
    await this.store.put(pending);
    if (directory) await createLink(link, plan.project.projectRootPath);
    const workspace = await paseo.workspaces
      .create({ workspaceId, ...buildWorkspaceRequest(input, { ...plan, link }) })
      .catch(async (error: unknown) => {
        await this.store.remove(workspaceId);
        if (directory) await removeLink(link);
        throw error;
      })
      .finally(() => this.creating.delete(workspaceId));
    const cwd = workspace.directory ?? (await workspace.refresh())?.workspaceDirectory;
    if (!cwd) throw new Error(`Workspace ${workspace.id} has no directory`);
    // Complete the record before any agent can be created in it, so the hooks see it.
    const { pending: _pending, ...settled } = pending;
    const record: SandboxRecord = { ...settled, cwd };
    await this.store.put(record);
    return record;
  }

  async createWorkspace(
    input: CreateInput,
    paseo: PaseoApi,
  ): Promise<RpcOutput<typeof createSandboxedWorkspaceRpc>> {
    const plan = await this.planCreation(input, paseo);
    const record = await this.createRegistered(input, plan, paseo);
    if (input.imageChoice) this.imageChoices.set(record.workspaceId, input.imageChoice);
    // The workspace opens at once; agents and terminals wait for the sandbox when they launch.
    void this.ensureRunning(record.workspaceId);
    return { workspaceId: record.workspaceId };
  }

  /** A profile's image and how it compares with its registry; null for engines without images. */
  async imageStatus(profileId: string | undefined): Promise<RpcOutput<typeof imageStatusRpc>> {
    const profile = this.containerProfiles.get(profileId);
    const { images } = backendFor(profile.engine);
    // A local image file is never downloaded; a missing one fails when the sandbox starts.
    if (!images || images.pullable?.(profile.image) === false) {
      return { image: null, state: "current" };
    }
    const policy = await this.policy(profile);
    const local = await images.localDigests(policy.cli, profile.image);
    return { image: profile.image, state: await checkImage(profile.image, local) };
  }

  /** Starts a sandbox with the user's answer for its image, which names the sandbox's image. */
  async chooseImage(workspaceId: string, choice: ImageChoice): Promise<void> {
    const record = this.store.get(workspaceId);
    if (!record) throw new Error("This workspace is not sandboxed");
    // A dev container's go-ahead names the configuration the last attempt asked about.
    const expected = engineReadsWorkspaceConfig(record.profile.engine)
      ? this.failures.get(workspaceId)?.download?.image
      : record.profile.image;
    if (choice.image !== expected) {
      throw new Error(`The image ${choice.image} is not the sandbox's`);
    }
    // Let a running attempt finish, so the choice belongs to a fresh one.
    await this.starting.get(workspaceId);
    this.imageChoices.set(workspaceId, choice);
    // A download outlasts an RPC; the status reports its progress.
    void this.ensureRunning(workspaceId);
  }

  /**
   * Stops a persistent sandbox and starts it again, as it is. Running agents and terminals in it
   * stop.
   */
  async restart(workspaceId: string, paseo: PaseoApi): Promise<void> {
    const record = this.settled(workspaceId);
    await this.starting.get(workspaceId);
    const policy = await this.recordPolicy(record);
    const backend = backendFor(policy.engine);
    if (!backend.stop) {
      throw new Error(
        "This engine starts a fresh sandbox for every launch; there is nothing to restart",
      );
    }
    await this.prepareRestarts(record, paseo);
    await backend.stop(workspaceTarget(record, { mode: "none" }), policy);
    this.failures.delete(workspaceId);
    void this.ensureRunning(workspaceId);
  }

  /**
   * Removes a sandbox and creates it again, from its own copy of a profile, or from other settings,
   * which become its copy. The captured login shell environment is read again. An engine that
   * starts a fresh sandbox per launch has nothing to remove: new launches use the settings.
   */
  async recreate(
    workspaceId: string,
    input: (Omit<ContainerProfile, "id"> & { id?: string }) | undefined,
    paseo: PaseoApi,
  ): Promise<void> {
    const record = this.settled(workspaceId);
    await this.starting.get(workspaceId);
    const profile = input
      ? this.containerProfiles.normalize({ ...input, id: input.id ?? record.profile.id })
      : record.profile;
    if (input && !record.linkedDirectory && profileSandboxFolder(profile)) {
      await requireRelativeWorktrees(
        profile,
        (await this.gitProject(record.projectId, paseo)).projectRootPath,
      );
    }
    const policy = await this.recordPolicy(record);
    await this.prepareRestarts(record, paseo);
    await backendFor(policy.engine).remove(workspaceTarget(record, { mode: "none" }), policy);
    await this.store.forgetEnvironment(workspaceId);
    const agentState = profileAgentState(profile);
    const { claudeHomeReason: _reason, ...rest } = record;
    const updated: SandboxRecord = {
      ...rest,
      profile,
      // Same agent state, same folder: a sandbox from before the choice keeps what it had.
      claudeHome:
        agentState === recordAgentState(record) ? record.claudeHome : CLAUDE_HOME_FOR[agentState],
    };
    await this.store.put(updated);
    this.failures.delete(workspaceId);
    void this.ensureRunning(workspaceId);
  }

  /** The workspace's agents with a live session, and its open terminals. */
  async dependents(workspaceId: string, paseo: PaseoApi): Promise<SandboxDependents> {
    const record = this.store.get(workspaceId);
    if (!record) return { agents: [], terminals: [] };
    const agents: SandboxDependents["agents"] = [];
    let cursor: string | undefined;
    do {
      const { entries, pageInfo } = await paseo.agents.list({
        includeBackground: true,
        filter: { statuses: [...LIVE_AGENT_STATUSES], includeBackground: true },
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      for (const { agent } of entries) {
        if (agent.workspaceId === workspaceId) {
          agents.push({ id: agent.id, title: agent.title ?? null, status: agent.status });
        }
      }
      cursor = pageInfo.nextCursor ?? undefined;
    } while (cursor);
    const { entries } = await paseo.terminals.list({ workspaceId });
    const terminals = entries.map(({ id, name }) => ({ id, name }));
    return { agents, terminals };
  }

  /**
   * Before the sandbox changes: closes all of the workspace's terminals, the sandboxed ones running
   * with the old settings and the host's alike, and notes the live agents to resume once it runs
   * again.
   */
  private async prepareRestarts(record: SandboxRecord, paseo: PaseoApi): Promise<void> {
    const { agents, terminals } = await this.dependents(record.workspaceId, paseo);
    for (const terminal of terminals) {
      await paseo.terminals
        .ref(terminal.id)
        .kill()
        .catch((error: unknown) =>
          console.error(`Closing terminal ${terminal.id} failed`, describeError(error)),
        );
    }
    this.pendingRestarts.set(record.workspaceId, {
      paseo,
      agents: agents.map((agent) => agent.id),
    });
  }

  /**
   * After a changed sandbox runs: resumes its agents, whose session hook then gives them the new
   * settings. A running turn is interrupted.
   */
  private async runPendingRestarts(workspaceId: string): Promise<void> {
    const pending = this.pendingRestarts.get(workspaceId);
    if (!pending) return;
    this.pendingRestarts.delete(workspaceId);
    for (const agentId of pending.agents) {
      const agent = pending.paseo.agents.ref(agentId);
      // Paseo 0.14 added reload; on an older daemon the agents open with the new settings when
      // next started.
      if (typeof agent.reload !== "function") {
        console.error(`Agent ${agentId} was not resumed: reopening sessions needs Paseo 0.14`);
        continue;
      }
      await agent
        .reload()
        .catch((error: unknown) =>
          console.error(`Resuming agent ${agentId} failed`, describeError(error)),
        );
    }
  }

  /** A sandbox that exists and has finished being created. */
  private settled(workspaceId: string): SandboxRecord {
    const record = this.store.get(workspaceId);
    if (!record) throw new Error("This workspace is not sandboxed");
    if (record.pending) throw new Error("The sandbox is still being created");
    return record;
  }

  /** Every sandbox with its health, from what this process knows: no container is inspected. */
  list(): RpcOutput<typeof listSandboxesRpc> {
    return {
      sandboxes: this.store
        .list()
        .map((sandbox) => Object.assign({}, sandbox, { health: this.health(sandbox) })),
      claudeLogin: this.login.state(),
    };
  }

  private health(sandbox: SandboxRecord): SandboxHealth {
    const { workspaceId } = sandbox;
    if (sandbox.pending || this.starting.has(workspaceId)) return { state: "starting" };
    const failure = this.failures.get(workspaceId);
    if (failure) {
      return { state: "failed", error: `The container did not start: ${failure.message}` };
    }
    return { state: "ready" };
  }

  async status(workspaceId: string): Promise<RpcOutput<typeof sandboxStatusRpc>> {
    const sandbox = this.store.get(workspaceId);
    const claudeLogin = this.login.state();
    if (!sandbox) {
      return {
        sandbox: null,
        container: null,
        claudeLogin,
        claudeConfigDir: null,
        sandboxDirectory: null,
      };
    }
    const claude = this.claudeHome(sandbox);
    const container: ContainerStatus =
      sandbox.pending || this.starting.has(workspaceId)
        ? {
            state: "starting",
            ...(this.downloading.has(workspaceId) ? { downloading: sandbox.profile.image } : {}),
          }
        : await this.inspectAfterFailure(sandbox);
    return {
      sandbox,
      container,
      claudeLogin,
      claudeConfigDir: claude.mode === "none" ? null : claude.configDir,
      sandboxDirectory: await this.sandboxDirectory(sandbox),
    };
  }

  /** With sandbox paths, where the workspace is inside; null if its layout can't be made. */
  private async sandboxDirectory(sandbox: SandboxRecord): Promise<string | null> {
    if (sandbox.pending || !profileSandboxFolder(sandbox.profile)) return null;
    return this.layoutTarget(sandbox, { mode: "none" })
      .then((target) => target.workdir)
      .catch(() => null);
  }

  /** A failed start stays reported until a later attempt runs the container. */
  private async inspectAfterFailure(sandbox: SandboxRecord): Promise<ContainerStatus> {
    const policy = await this.recordPolicy(sandbox);
    const inspected = await backendFor(policy.engine).status(
      workspaceTarget(sandbox, { mode: "none" }),
      policy,
    );
    const failure = this.failures.get(sandbox.workspaceId);
    if (!failure) return inspected;
    if (inspected.state !== "running") {
      return {
        state: "failed",
        error: failure.message,
        ...(failure.download ? { download: failure.download } : {}),
      };
    }
    this.failures.delete(sandbox.workspaceId);
    return inspected;
  }

  /**
   * Opens a login shell, or a terminal profile's command, in the sandbox. The terminal runs
   * `sandbox-run`, which joins the sandbox the plugin started.
   */
  async openShell(
    input: RpcInput<typeof openSandboxShellRpc>,
    paseo: PaseoApi,
  ): Promise<{ terminalId: string }> {
    const record = this.store.get(input.workspaceId);
    if (!record) throw new Error("This workspace is not sandboxed");
    // Within the client's 60-second RPC timeout; a failure reaches the user as the call's error.
    await this.readyWithin(record.workspaceId, 45_000);
    const launch = await resolveTerminalLaunch(paseo, input.profileId);
    const handle = await paseo.terminals.create({
      workspaceId: record.workspaceId,
      name: launch.name,
      command: this.wrapper,
      args: ["terminal", "--title", launch.name, ...launch.argv],
    });
    const terminalId = handle.current()?.id;
    if (!terminalId) throw new Error("The terminal was not created");
    return { terminalId };
  }

  async destroy(workspaceId: string): Promise<void> {
    const record = await this.store.remove(workspaceId);
    if (!record) return;
    await this.starting.get(workspaceId);
    this.failures.delete(workspaceId);
    const policy = await this.recordPolicy(record);
    await backendFor(policy.engine).remove(workspaceTarget(record, { mode: "none" }), policy);
    if (record.linkedDirectory) await removeLink(this.store.linkPath(workspaceId));
  }

  /** Finishes a record left pending when the daemon stopped while creating its workspace. */
  private async completePending(record: SandboxRecord, paseo: PaseoApi) {
    const workspace = await paseo.workspaces.ref(record.workspaceId).refresh();
    if (!workspace?.workspaceDirectory) {
      await this.destroy(record.workspaceId);
      return null;
    }
    const { pending: _pending, ...settled } = record;
    const completed: SandboxRecord = { ...settled, cwd: workspace.workspaceDirectory };
    await this.store.put(completed);
    return completed;
  }

  /**
   * Rewrites every spec with the current CLI and the workspace's own container configuration, and
   * removes sandboxes whose workspace was archived while the plugin was not running.
   */
  async reconcile(paseo: PaseoApi): Promise<void> {
    const active = await listActiveWorkspaceIds(paseo);
    for (const listed of this.store.list()) {
      if (this.creating.has(listed.workspaceId)) continue;
      if (!active.has(listed.workspaceId)) {
        await this.destroy(listed.workspaceId);
        continue;
      }
      const record = listed.pending ? await this.completePending(listed, paseo) : listed;
      if (!record) continue;
      await this.refreshSpec(await this.settleClaudeHome(record)).catch((error: unknown) =>
        console.error(`Sandbox ${record.workspaceId} could not be prepared`, describeError(error)),
      );
    }
  }

  /** Rewrites a sandbox's spec and private Claude folder for the current plugin and settings. */
  private async refreshSpec(record: SandboxRecord): Promise<void> {
    const policy = await this.recordPolicy(record);
    await this.writeSpec(record, await this.prepareTarget(record), policy);
  }
}
