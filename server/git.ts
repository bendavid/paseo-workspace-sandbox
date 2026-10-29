import { execCommand } from "@getpaseo/plugin/server";

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
