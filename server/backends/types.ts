import type { ContainerStatus, ImageDownload } from "../../shared/rpc";
import type { ContainerPolicy, ContainerTarget, Mount } from "../container";

/** The local image store of an engine that runs images. */
export interface ImageStore {
  /**
   * The registry digests the local copy is known by (index or platform manifest), empty for an
   * image built locally, or null when the image is not on this machine.
   */
  localDigests(cli: string, image: string): Promise<string[] | null>;
  /** Downloads the image. Only called after the user agreed to download that exact reference. */
  pull(cli: string, image: string): Promise<void>;
  /** False for images that cannot be downloaded, such as a local file; missing, they fail. */
  pullable?(image: string): boolean;
}

/** An engine's arguments, split so the profile editor can show one option per line. */
export interface CommandLine {
  /** The subcommand and what precedes the options, such as `run -d`. */
  head: string[];
  options: string[];
  /** The image and the command, or the command alone. */
  tail: string[];
}

export function commandArguments(line: CommandLine): string[] {
  return [...line.head, ...line.options, ...line.tail];
}

/**
 * One engine. The plugin owns every sandbox's lifecycle through this interface; `sandbox-run` only
 * sources the spec and joins the sandbox (see the contract in `server/wrapper.ts`).
 */
export interface SandboxBackend {
  /** Keeps one sandbox per workspace that launches join, rather than one per launch. */
  readonly persistent: boolean;
  /**
   * Engines that run an image. Their runs never pull (`--pull never`): an image is only
   * downloaded through `pull`, so nothing downloads without the user's say.
   */
  readonly images?: ImageStore;
  /**
   * What starting the sandbox runs, with the given mounts: the command that creates a persistent
   * sandbox, where `launch` is unused, or the command that runs `launch` in a fresh one. The
   * profile editor shows it with placeholder paths.
   */
  commandLine(
    target: ContainerTarget,
    policy: ContainerPolicy,
    mounts: Mount[],
    launch: string[],
  ): Promise<CommandLine>;
  /**
   * Engines whose configuration comes from the workspace: what creating the sandbox would do, for
   * the user to agree to first, or null when the sandbox exists and nothing needs creating.
   */
  creationConsent?(target: ContainerTarget, policy: ContainerPolicy): Promise<ImageDownload | null>;
  /** Engines that place the workspace themselves: its directory inside, once known. */
  workspaceFolder?(target: ContainerTarget): Promise<string | null>;
  /** Makes the sandbox ready: starts or recreates a persistent one. */
  start(target: ContainerTarget, policy: ContainerPolicy): Promise<void>;
  status(target: ContainerTarget, policy: ContainerPolicy): Promise<ContainerStatus>;
  remove(target: ContainerTarget, policy: ContainerPolicy): Promise<void>;
  /** Runs `argv` in a throwaway sandbox with the target's configuration and returns its stdout. */
  runOnce(target: ContainerTarget, policy: ContainerPolicy, argv: string[]): Promise<string>;
  /** The shell `sandbox-run` sources: the variables and functions of its contract. */
  spec(target: ContainerTarget, policy: ContainerPolicy): Promise<string>;
}

// Keeps a container alive without depending on `sleep infinity`, which busybox lacks.
export const KEEPALIVE = 'trap "exit 0" TERM; while :; do sleep 3600 & wait $!; done';
