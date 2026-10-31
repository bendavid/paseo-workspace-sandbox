import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Engine } from "../../shared/rpc";
import { isPodman, which, type ContainerPolicy, type ContainerTarget } from "../container";
import { apptainerBackend } from "./apptainer";
import { devcontainerBackend } from "./devcontainer";
import { bubblewrapBackend } from "./bubblewrap";
import { microsandboxBackend } from "./microsandbox";
import { ociBackend } from "./oci";
import type { SandboxBackend } from "./types";

export type { SandboxBackend } from "./types";

const BACKENDS: Record<Engine, SandboxBackend> = {
  podman: ociBackend,
  docker: ociBackend,
  bubblewrap: bubblewrapBackend,
  microsandbox: microsandboxBackend,
  apptainer: apptainerBackend,
  singularity: apptainerBackend,
  devcontainer: devcontainerBackend,
};

export const DEFAULT_COMMANDS: Record<Engine, string> = {
  podman: "podman",
  docker: "docker",
  bubblewrap: "bwrap",
  microsandbox: "msb",
  apptainer: "apptainer",
  singularity: "singularity",
  devcontainer: "devcontainer",
};

// Where the installers put these; a daemon started from a desktop session may not have them on
// its PATH.
const INSTALL_LOCATIONS: Partial<Record<Engine, string[]>> = {
  microsandbox: [".microsandbox/bin/msb"],
};

export function backendFor(engine: Engine): SandboxBackend {
  return BACKENDS[engine];
}

/** The engine's command: the profile's, or the default found on PATH or where its installer puts it. */
export async function resolveEngineCli(engine: Engine, configured?: string): Promise<string> {
  const command = configured?.trim() || DEFAULT_COMMANDS[engine];
  const resolved = path.isAbsolute(command)
    ? command
    : ((await which(command)) ??
      (configured
        ? null
        : ((INSTALL_LOCATIONS[engine] ?? [])
            .map((relative) => path.join(homedir(), relative))
            .find((candidate) => existsSync(candidate)) ?? null)));
  if (!resolved || !existsSync(resolved)) {
    throw new Error(`The ${engine} command "${command}" was not found`);
  }
  // podman-docker's `docker` prints a notice on every call, which would land in sandboxed
  // terminals. Call podman itself when that is what `docker` runs.
  if (engine === "docker" && path.basename(resolved) === "docker" && (await isPodman(resolved))) {
    return (await which("podman")) ?? resolved;
  }
  return resolved;
}

/**
 * The Docker or Podman command a dev container runs on: the profile's, or docker, or podman. Like
 * resolveEngineCli, podman-docker's `docker` resolves to podman itself.
 */
export async function resolveContainerCli(configured?: string): Promise<string> {
  if (configured?.trim()) return resolveEngineCli("docker", configured);
  return resolveEngineCli("docker").catch(() => resolveEngineCli("podman"));
}
