import type { ContainerStatus } from "../../shared/rpc";
import type { ContainerPolicy, ContainerTarget } from "../container";

/** The local image store of an engine that runs images. */
export interface ImageStore {
  exists(cli: string, image: string): Promise<boolean>;
  /** Downloads the image. Only called after the user agreed to download that exact reference. */
  pull(cli: string, image: string): Promise<void>;
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
