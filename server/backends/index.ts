import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Engine } from "../../shared/rpc";
import { isPodman, which, type ContainerPolicy, type ContainerTarget } from "../container";
import { apptainerBackend } from "./apptainer";
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
};

export const DEFAULT_COMMANDS: Record<Engine, string> = {
  podman: "podman",
  docker: "docker",
  bubblewrap: "bwrap",
  microsandbox: "msb",
  apptainer: "apptainer",
  singularity: "singularity",
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

export type ClaudeFolderAccess = "writable" | "read-only" | "other" | "absent" | "unknown";

// Prints how the host's Claude folder appears in the sandbox. A marker the host just created tells
// the host folder apart from one the image, a volume, or a tmpfs puts at the same path; device and
// inode numbers would not survive a microVM's virtio-fs. Creating a file tests writes through
// read-only mounts, permissions, and user-namespace mapping alike.
const CLAUDE_FOLDER_CHECK = [
  "dir=$1; marker=$2",
  '[ -d "$dir" ] || { echo absent; exit 0; }',
  '[ -e "$dir/$marker" ] || { echo other; exit 0; }',
  'probe="$dir/.paseo-sandbox-write-check-$$"',
  'if (umask 077; : > "$probe") 2>/dev/null; then rm -f "$probe"; echo writable; else echo read-only; fi',
].join("\n");

/**
 * Runs the sandbox's configuration (image, engine, workspace and extra mounts, extra run
 * arguments) without any Claude folder of the plugin's, and reports how the host's Claude folder
 * shows. The first run pulls the image, which the sandbox then reuses.
 */
export async function checkClaudeFolder(
  backend: SandboxBackend,
  target: ContainerTarget,
  policy: ContainerPolicy,
  hostConfigDir: string,
): Promise<ClaudeFolderAccess> {
  if (!existsSync(hostConfigDir)) return "absent";
  const marker = `.paseo-sandbox-check-${randomBytes(6).toString("hex")}`;
  const markerPath = path.join(hostConfigDir, marker);
  await writeFile(markerPath, "", { mode: 0o600 });
  try {
    const stdout = await backend.runOnce({ ...target, claude: { mode: "none" } }, policy, [
      "sh",
      "-c",
      CLAUDE_FOLDER_CHECK,
      "sh",
      hostConfigDir,
      marker,
    ]);
    const answer = stdout.trim().split("\n").pop()?.trim();
    return answer === "writable" ||
      answer === "read-only" ||
      answer === "other" ||
      answer === "absent"
      ? answer
      : "unknown";
  } finally {
    await rm(markerPath, { force: true });
  }
}
