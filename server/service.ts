import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginSettings } from "@getpaseo/plugin/server";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { ClaudeLoginKeeper } from "./claude-login";
import { prepareClaudeHome } from "./claude-home";
import {
  backendFor,
  checkClaudeFolder,
  resolveEngineCli,
  type ClaudeFolderAccess,
} from "./backends/index";
import {
  containerName,
  isPodman,
  legacyProbeContainerName,
  runCli,
  shellQuote,
  workspaceTarget,
  type ClaudeHome,
  type ContainerPolicy,
  type ContainerTarget,
} from "./container";
import type { ContainerProfiles } from "./container-profiles";
import { listRefs } from "./git";
import { resolveTerminalLaunch, type TerminalLaunch } from "./terminals";
import { environmentFile, writeFileAtomic, type SandboxStore } from "./store";
import {
  engineUsesImage,
  type ContainerProfile,
  type ContainerStatus,
  type Engine,
  type SandboxHealth,
  type SandboxRecord,
  type createSandboxedWorkspaceRpc,
  type listRefsRpc,
  type listSandboxesRpc,
  type openSandboxShellRpc,
  type sandboxStatusRpc,
} from "../shared/rpc";
import type { sandboxSettings } from "../shared/settings";

type Settings = PluginSettings<typeof sandboxSettings.schema>;
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
 * the two apart. The prompt names the workspace and branch the way New workspace does.
 */
function buildWorkspaceRequest(
  input: CreateInput,
  plan: {
    isolation: "worktree" | "directory";
    namingPrompt: string;
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
  return {
    source,
    ...(title ? { title } : {}),
    ...(plan.namingPrompt ? { firstAgentContext: { prompt: plan.namingPrompt } } : {}),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SandboxService {
  // In-flight ensureRunning attempts by workspace ID; each resolves to null or why it failed.
  private readonly starting = new Map<string, Promise<string | null>>();
  private readonly failures = new Map<string, string>();
  /** Workspaces this process is creating; their pending records are not leftovers. */
  private readonly creating = new Set<string>();

  constructor(
    private readonly store: SandboxStore,
    private readonly settings: Settings,
    private readonly containerProfiles: ContainerProfiles,
    private readonly login: ClaudeLoginKeeper,
    readonly wrapper: string,
  ) {}

  /** Sandboxes from before private config folders keep the host's, which they already mount. */
  private claudeHome(record: SandboxRecord): ClaudeHome {
    if (record.claudeHome === "checking") return { mode: "none" };
    if (record.claudeHome !== "private") {
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
  private async prepareTarget(
    record: SandboxRecord,
    image = record.image,
  ): Promise<ContainerTarget> {
    const claude = this.claudeHome(record);
    if (claude.mode === "private") {
      await prepareClaudeHome({
        directory: claude.configDir,
        hostConfigDir: claude.hostConfigDir,
        helperCommand: this.login.helperCommand,
      });
    }
    return { ...workspaceTarget(record, claude), image };
  }

  /** Seeds the "Default" container profile from the settings that predate profiles. */
  async profileSeed() {
    const values = await this.settingsValues();
    const { engine, cli } = await this.profileEngineFromSettings();
    return {
      engine,
      ...(cli ? { cli } : {}),
      image: values.image,
      network: values.network,
      extraMounts: values.extraMounts,
      extraRunArgs: values.extraRunArgs,
    };
  }

  private async settingsValues() {
    const state = await this.settings.read();
    if (state.status !== "ready") throw new Error(`Sandbox settings are invalid: ${state.error}`);
    return state.values;
  }

  /**
   * The engine the old global container CLI setting stands for, for profiles saved before engines.
   * The command is kept only when it isn't plain `docker` or `podman`. Without either installed,
   * Podman.
   */
  async profileEngineFromSettings(): Promise<{ engine: Engine; cli?: string }> {
    const configured = (await this.settingsValues()).containerCli.trim();
    const engine = await this.legacyEngine().then(
      (legacy) => legacy.engine,
      () => "podman" as const,
    );
    return ["docker", "podman"].includes(configured) ? { engine } : { engine, cli: configured };
  }

  /**
   * Profiles saved before engines use the old global container CLI setting: Podman when that is
   * what it runs, Docker otherwise.
   */
  private async legacyEngine(): Promise<{ engine: Engine; cli: string }> {
    const cli = await resolveEngineCli("docker", (await this.settingsValues()).containerCli);
    return { engine: (await isPodman(cli)) ? "podman" : "docker", cli };
  }

  /** A profile's engine and its command, plus the network, mounts, and run arguments. */
  private async policy(profile: ContainerProfile): Promise<ContainerPolicy> {
    const { engine, cli } = profile.engine
      ? { engine: profile.engine, cli: await resolveEngineCli(profile.engine, profile.cli) }
      : await this.legacyEngine();
    return {
      engine,
      cli,
      network: profile.network,
      extraMounts: profile.extraMounts,
      extraRunArgs: profile.extraRunArgs,
    };
  }

  /** A workspace's own configuration; sandboxes from before profiles fall back to "Default". */
  private recordProfile(record: SandboxRecord): ContainerProfile {
    return record.profile ?? { ...this.containerProfiles.get(undefined), image: record.image };
  }

  /** Writes the wrapper's spec for one container and returns its run arguments. */
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
    const profile = this.recordProfile(record);
    const policy = await this.policy(profile);
    const decided =
      record.claudeHome === "checking" ? await this.decideClaudeHome(record, policy) : record;
    const target = await this.prepareTarget(decided, profile.image);
    await this.writeSpec(decided, target, policy);
    await backendFor(policy.engine).start(target, policy);
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
        this.failures.set(workspaceId, message);
        const detail = error instanceof Error && error.cause ? error.cause : error;
        console.error(`Sandbox ${record.container} failed to start`, describeError(detail));
        return message;
      })
      .finally(() => this.starting.delete(workspaceId));
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
          "The sandbox is still starting; its first start pulls the image. Try again in a moment.",
        );
      }
      if (outcome !== null) throw new Error(`The sandbox did not start: ${outcome}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Earlier versions kept a probe container for model discovery. Runs without a session now use
   * the host's CLI, so the probe and its files go.
   */
  async removeLegacyProbe(): Promise<void> {
    const specFile = path.join(this.store.directory, "probe.sh");
    const { cli } = await this.legacyEngine();
    await runCli(cli, ["rm", "-f", legacyProbeContainerName(this.store.directory)]).catch(
      () => undefined,
    );
    for (const file of [
      specFile,
      specFile.replace(/\.sh$/, ".failed"),
      environmentFile(specFile),
    ]) {
      await rm(file, { force: true });
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
    if (engineUsesImage(policy.engine) && !profile.image) {
      throw new Error(
        `The container profile "${profile.name}" needs an image for ${policy.engine}`,
      );
    }
    return {
      profile,
      project,
      isolation,
      policy,
      namingPrompt: input.prompt ?? "",
    };
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
      image: plan.profile.image,
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

  /**
   * The wrapper waits for the container, so the terminal opens at once and its shell appears when
   * the container is up. A blank terminal's command is typed at the prompt, which the terminal
   * buffers until then.
   */
  private async openLaunchTerminal(
    record: SandboxRecord,
    terminal: TerminalLaunch,
    paseo: PaseoApi,
  ): Promise<string | null> {
    const handle = await paseo.terminals.create({
      workspaceId: record.workspaceId,
      name: terminal.name,
      command: this.wrapper,
      args: ["terminal", "--title", terminal.name, ...terminal.argv],
    });
    if (terminal.input) handle.write(`${terminal.input}\r`);
    return handle.current()?.id ?? null;
  }

  async createWorkspace(
    input: CreateInput,
    paseo: PaseoApi,
  ): Promise<RpcOutput<typeof createSandboxedWorkspaceRpc>> {
    const plan = await this.planCreation(input, paseo);
    const record = await this.createRegistered(input, plan, paseo);
    // The workspace opens at once; agents and terminals wait for the sandbox when they launch.
    void this.ensureRunning(record.workspaceId);
    return { workspaceId: record.workspaceId };
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
    if (failure) return { state: "failed", error: `The container did not start: ${failure}` };
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
        ? { state: "starting" }
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
    const profile = this.recordProfile(sandbox);
    const policy = await this.policy(profile);
    const inspected = await backendFor(policy.engine).status(
      workspaceTarget(sandbox, { mode: "none" }),
      policy,
    );
    const failure = this.failures.get(sandbox.workspaceId);
    if (!failure) return inspected;
    if (inspected.state !== "running") return { state: "failed", error: failure };
    this.failures.delete(sandbox.workspaceId);
    return inspected;
  }

  /** Opens a login shell, or a terminal profile's command with its prompt, in the container. */
  async openShell(
    input: RpcInput<typeof openSandboxShellRpc>,
    paseo: PaseoApi,
  ): Promise<{ terminalId: string }> {
    const record = this.store.get(input.workspaceId);
    if (!record) throw new Error("This workspace is not sandboxed");
    // Within the client's 60-second RPC timeout; a failure reaches the user as the call's error.
    await this.readyWithin(record.workspaceId, 45_000);
    const launch = await resolveTerminalLaunch(paseo, {
      ...(input.profileId ? { profileId: input.profileId } : {}),
      prompt: input.prompt ?? "",
    });
    const terminalId = await this.openLaunchTerminal(record, launch, paseo);
    if (!terminalId) throw new Error("The terminal was not created");
    return { terminalId };
  }

  async destroy(workspaceId: string): Promise<void> {
    const record = await this.store.remove(workspaceId);
    if (!record) return;
    await this.starting.get(workspaceId);
    this.failures.delete(workspaceId);
    const policy = await this.policy(this.recordProfile(record));
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
    const profile = this.recordProfile(record);
    const policy = await this.policy(profile);
    await this.writeSpec(record, await this.prepareTarget(record, profile.image), policy);
  }
}
