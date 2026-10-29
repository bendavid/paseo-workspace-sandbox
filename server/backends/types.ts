import type { ContainerStatus } from "../../shared/rpc";
import type { ContainerPolicy, ContainerTarget } from "../container";

/**
 * One engine. The plugin owns every sandbox's lifecycle through this interface; `sandbox-run` only
 * sources the spec and joins the sandbox (see the contract in `server/wrapper.ts`).
 */
export interface SandboxBackend {
  /** Keeps one sandbox per workspace that launches join, rather than one per launch. */
  readonly persistent: boolean;
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
