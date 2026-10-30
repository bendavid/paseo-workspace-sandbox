import { randomBytes } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { ClaudeLoginKeeper } from "./claude-login";
import { prepareClaudeHome } from "./claude-home";
import {
  backendFor,
  checkClaudeFolder,
  resolveEngineCli,
  type ClaudeFolderAccess,
} from "./backends/index";
import type { ImageStore } from "./backends/types";
import {
  containerName,
  shellQuote,
  workspaceTarget,
  type ClaudeHome,
  type ContainerPolicy,
  type ContainerTarget,
} from "./container";
import type { ContainerProfiles } from "./container-profiles";
import { listRefs } from "./git";
import { resolveTerminalLaunch } from "./terminals";
import { writeFileAtomic, type SandboxStore } from "./store";
import {
  IMAGE_REFERENCE_HINT,
  engineUsesImage,
  isFullImageReference,
  type ContainerProfile,
  type ContainerStatus,
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

// Why a sandbox whose configuration could show the host's Claude folder still gets a private one.
const PRIVATE_REASONS: Record<Exclude<ClaudeFolderAccess, "writable">, string> = {
  "read-only": "The sandbox's mounts show the host's Claude folder read-only",
  other: "Another folder sits at the host Claude folder's path in the sandbox",
  absent: "The sandbox's mounts don't show the host's Claude folder",
  unknown: "The check could not tell how the host's Claude folder shows",
};

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
 * A worktree sandbox gets a directory of its own. A directory sandbox is a new workspace on the
 * project directory, shared with the project's other workspaces, so it gets a title that tells
 * the two apart.
 */
function buildWorkspaceRequest(
  input: CreateInput,
  plan: {
    isolation: "worktree" | "directory";
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
      : {
          kind: "directory" as const,
          path: plan.project.projectRootPath,
          projectId: input.projectId,
        };
  const defaultTitle =
    plan.isolation === "directory"
      ? `${plan.project.projectCustomName ?? plan.project.projectDisplayName} (sandboxed)`
      : undefined;
  const title = input.title ?? defaultTitle;
  return { source, ...(title ? { title } : {}) };
}

/** The sandbox needs an image that is not on this machine, and nobody agreed to download it. */
class ImageMissingError extends Error {
  constructor(readonly image: string) {
    super(`The image ${image} is not on this machine. Download it from the Sandbox panel.`);
    this.name = "ImageMissingError";
  }
}

interface StartFailure {
  message: string;
  missingImage?: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SandboxService {
  // In-flight ensureRunning attempts by workspace ID; each resolves to null or why it failed.
  private readonly starting = new Map<string, Promise<string | null>>();
  private readonly failures = new Map<string, StartFailure>();
  /**
   * The image the user agreed to download, by workspace ID: from the form at creation, or the
   * panel's Download button. It covers the next start attempt only and is never stored, so retries,
   * restarts, and recreated containers download nothing.
   */
  private readonly approvedDownloads = new Map<string, string>();
  /** Workspaces whose image is downloading. */
  private readonly downloading = new Set<string>();
  /** Workspaces this process is creating; their pending records are not leftovers. */
  private readonly creating = new Set<string>();

  constructor(
    private readonly store: SandboxStore,
    private readonly containerProfiles: ContainerProfiles,
    private readonly login: ClaudeLoginKeeper,
    readonly wrapper: string,
  ) {}

  private claudeHome(record: SandboxRecord): ClaudeHome {
    if (record.claudeHome === "checking") return { mode: "none" };
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
    return workspaceTarget(record, claude);
  }

  /** A profile's engine and its command, plus the network, mounts, and run arguments. */
  private async policy(profile: ContainerProfile): Promise<ContainerPolicy> {
    return {
      engine: profile.engine,
      cli: await resolveEngineCli(profile.engine, profile.cli),
      network: profile.network,
      extraMounts: profile.extraMounts,
      extraRunArgs: profile.extraRunArgs,
    };
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
        `sandbox_workdir=${shellQuote(record.cwd)}`,
        await backendFor(policy.engine).spec(target, policy),
        "",
      ].join("\n"),
    );
  }

  /** Decides the Claude folder if that is still open, then starts or recreates the container. */
  private async runContainer(record: SandboxRecord): Promise<void> {
    const policy = await this.policy(record.profile);
    const backend = backendFor(policy.engine);
    // Only the Claude folder check and creating the sandbox run the image; resuming an existing
    // container or microVM needs nothing new.
    const runsImage =
      record.claudeHome === "checking" ||
      (await backend.status(workspaceTarget(record, { mode: "none" }), policy)).state === "missing";
    if (backend.images && runsImage) await this.ensureImage(record, policy, backend.images);
    const decided =
      record.claudeHome === "checking" ? await this.decideClaudeHome(record, policy) : record;
    const target = await this.prepareTarget(decided);
    await this.writeSpec(decided, target, policy);
    await backend.start(target, policy);
  }

  /** Downloads the image only when it is missing and the user agreed to download exactly it. */
  private async ensureImage(
    record: SandboxRecord,
    policy: ContainerPolicy,
    images: ImageStore,
  ): Promise<void> {
    const { image } = record.profile;
    if (await images.exists(policy.cli, image)) return;
    if (this.approvedDownloads.get(record.workspaceId) !== image) {
      throw new ImageMissingError(image);
    }
    this.downloading.add(record.workspaceId);
    try {
      await images.pull(policy.cli, image);
    } finally {
      this.downloading.delete(record.workspaceId);
    }
  }

  /**
   * A sandbox shares the host's Claude folder only when its own configuration already makes that
   * folder writable, which a container with the same configuration finds out. Anything else, a
   * failed check included, gets a private folder: wrongly sharing would grant writes the mounts
   * withheld, while wrongly keeping it private only stops sharing transcripts.
   */
  private async decideClaudeHome(
    record: SandboxRecord,
    policy: ContainerPolicy,
  ): Promise<SandboxRecord> {
    let claudeHome: "private" | "shared" = "private";
    let reason: string;
    try {
      const access = await checkClaudeFolder(
        backendFor(policy.engine),
        workspaceTarget(record, { mode: "none" }),
        policy,
        this.login.hostConfigDir,
      );
      if (access === "writable") {
        claudeHome = "shared";
        reason = "The sandbox's mounts make the host's Claude folder writable";
      } else {
        reason = PRIVATE_REASONS[access];
      }
    } catch (error) {
      reason = `The check could not run (${describeError(error)})`;
    }
    if (!this.store.get(record.workspaceId)) throw new Error("The sandbox was removed");
    const decided: SandboxRecord = { ...record, claudeHome, claudeHomeReason: reason };
    await this.store.put(decided);
    return decided;
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
      .then(() => null)
      .catch((error: unknown) => {
        const message = describeError(error);
        this.failures.set(workspaceId, {
          message,
          ...(error instanceof ImageMissingError ? { missingImage: error.image } : {}),
        });
        const detail = error instanceof Error && error.cause ? error.cause : error;
        console.error(`Sandbox ${record.container} failed to start`, describeError(detail));
        return message;
      })
      .finally(() => {
        this.starting.delete(workspaceId);
        this.approvedDownloads.delete(workspaceId);
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
    if (engineUsesImage(policy.engine) && !isFullImageReference(profile.image)) {
      throw new Error(`${IMAGE_REFERENCE_HINT}, in the container profile "${profile.name}"`);
    }
    if (input.downloadImage !== undefined && input.downloadImage !== profile.image) {
      throw new Error(
        `The image to download, ${input.downloadImage}, is not the profile's (${profile.image})`,
      );
    }
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
    const pending: SandboxRecord = {
      workspaceId,
      projectId: input.projectId,
      cwd: "",
      container: containerName(workspaceId),
      createdAt: new Date().toISOString(),
      profile: plan.profile,
      pending: true,
      claudeHome: "checking",
    };
    this.creating.add(workspaceId);
    await this.store.put(pending);
    const workspace = await paseo.workspaces
      .create({ workspaceId, ...buildWorkspaceRequest(input, plan) })
      .catch(async (error: unknown) => {
        await this.store.remove(workspaceId);
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
    if (input.downloadImage) this.approvedDownloads.set(record.workspaceId, input.downloadImage);
    // The workspace opens at once; agents and terminals wait for the sandbox when they launch.
    void this.ensureRunning(record.workspaceId);
    return { workspaceId: record.workspaceId };
  }

  /** A profile's image and whether it is on this machine; null for engines without images. */
  async imageStatus(profileId: string | undefined): Promise<RpcOutput<typeof imageStatusRpc>> {
    const profile = this.containerProfiles.get(profileId);
    const { images } = backendFor(profile.engine);
    if (!images) return { image: null, present: true };
    const policy = await this.policy(profile);
    return { image: profile.image, present: await images.exists(policy.cli, profile.image) };
  }

  /** Downloads a workspace's image, which the user named, and starts its sandbox. */
  async downloadImage(workspaceId: string, image: string): Promise<void> {
    const record = this.store.get(workspaceId);
    if (!record) throw new Error("This workspace is not sandboxed");
    if (image !== record.profile.image) {
      throw new Error(`The image to download, ${image}, is not the sandbox's`);
    }
    // Let a running attempt finish, so the approval belongs to a fresh one.
    await this.starting.get(workspaceId);
    this.approvedDownloads.set(workspaceId, image);
    // A download outlasts an RPC; the status reports its progress.
    void this.ensureRunning(workspaceId);
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
    };
  }

  /** A failed start stays reported until a later attempt runs the container. */
  private async inspectAfterFailure(sandbox: SandboxRecord): Promise<ContainerStatus> {
    const policy = await this.policy(sandbox.profile);
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
        ...(failure.missingImage ? { missingImage: failure.missingImage } : {}),
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
    const policy = await this.policy(record.profile);
    await backendFor(policy.engine).remove(workspaceTarget(record, { mode: "none" }), policy);
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
      // A sandbox the daemon stopped preparing is decided and started now; others start on use.
      if (record.claudeHome === "checking") {
        void this.ensureRunning(record.workspaceId);
        continue;
      }
      await this.refreshSpec(record).catch((error: unknown) =>
        console.error(`Sandbox ${record.workspaceId} could not be prepared`, describeError(error)),
      );
    }
  }

  /** Rewrites a sandbox's spec and private Claude folder for the current plugin and settings. */
  private async refreshSpec(record: SandboxRecord): Promise<void> {
    const policy = await this.policy(record.profile);
    await this.writeSpec(record, await this.prepareTarget(record), policy);
  }
}
