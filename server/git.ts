import { execCommand } from "@getpaseo/plugin/server";
import type { RelativeWorktrees } from "../shared/rpc";

export interface ProjectRefs {
  current: string | null;
  refs: Array<{ name: string; remote: boolean }>;
}

/** Local and remote-tracking branches a sandboxed worktree can start from, newest first. */
export async function listRefs(root: string): Promise<ProjectRefs> {
  const [head, refs] = await Promise.all([
    execCommand("git", ["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"]).catch(
      () => null,
    ),
    execCommand("git", [
      "-C",
      root,
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname)",
      "refs/heads",
      "refs/remotes",
    ]),
  ]);
  return {
    current: head?.stdout.trim() || null,
    refs: refs.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((ref) => ref && !ref.endsWith("/HEAD"))
      .map((ref) =>
        ref.startsWith("refs/heads/")
          ? { name: ref.slice("refs/heads/".length), remote: false }
          : { name: ref.slice("refs/remotes/".length), remote: true },
      ),
  };
}

/** Git 2.48 added relative worktree links, and the repository extension older Git refuses. */
export function supportsRelativeWorktrees(version: string): boolean {
  const match = /(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 2 || (major === 2 && minor >= 48);
}

/**
 * Whether new worktrees of the repository at `root` link to it by relative path. Paseo creates
 * worktrees with plain `git worktree add`, which follows the repository's
 * `worktree.useRelativePaths`.
 */
export async function relativeWorktrees(root: string): Promise<RelativeWorktrees> {
  const gitVersion = (await execCommand("git", ["--version"])).stdout.trim();
  if (!supportsRelativeWorktrees(gitVersion)) return { state: "unsupported", gitVersion };
  const setting = await execCommand("git", [
    "-C",
    root,
    "config",
    "--bool",
    "worktree.useRelativePaths",
  ]).catch(() => null);
  return { state: setting?.stdout.trim() === "true" ? "relative" : "absolute", gitVersion };
}

/**
 * Sets the repository to link new worktrees relatively and rewrites the existing ones' links.
 * Git marks the repository with `extensions.relativeWorktrees`, which Git before 2.48 refuses.
 */
export async function enableRelativeWorktrees(root: string): Promise<RelativeWorktrees> {
  const status = await relativeWorktrees(root);
  if (status.state === "unsupported") {
    throw new Error(
      `Relative worktree paths need Git 2.48 or newer; this host has ${status.gitVersion}`,
    );
  }
  await execCommand("git", ["-C", root, "config", "worktree.useRelativePaths", "true"]);
  await execCommand("git", ["-C", root, "worktree", "repair"]);
  return relativeWorktrees(root);
}
