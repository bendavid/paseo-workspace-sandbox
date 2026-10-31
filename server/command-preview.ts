import path from "node:path";
import { backendFor } from "./backends";
import type { CommandLine } from "./backends/types";
import {
  claudeMounts,
  combineMounts,
  parseExtraMounts,
  providerDirectories,
  shellQuote,
  type ContainerPolicy,
  type ContainerTarget,
  type Mount,
} from "./container";

// What each workspace's sandbox fills in.
const WORKSPACE = "<workspace>";
const CLAUDE_FOLDER = "<claude-folder>";
const SIGN_IN_FOLDER = "<claude-sign-in>";

/**
 * The command a sandbox from a profile starts with, as the engine builds it, for a workspace that
 * is a plain checkout with a private Claude folder; per-launch engines show `<command>` for what
 * each launch runs. Paths a workspace fills in are placeholders.
 */
export async function previewCommand(input: {
  policy: ContainerPolicy;
  image: string;
  hostConfigDir: string;
}): Promise<string> {
  const { policy, hostConfigDir } = input;
  const target: ContainerTarget = {
    container: "<sandbox>",
    label: "workspace=<workspace-id>",
    image: input.image || "<image>",
    workspace: WORKSPACE,
    workdir: WORKSPACE,
    claude: policy.shareAgentState
      ? { mode: "private", configDir: CLAUDE_FOLDER, hostConfigDir, authDir: SIGN_IN_FOLDER }
      : { mode: "none" },
  };
  const git = path.join(WORKSPACE, ".git");
  const mounts: Mount[] = [
    { path: WORKSPACE, readOnly: false },
    { path: path.join(git, "hooks"), readOnly: true },
    { path: path.join(git, "config"), readOnly: true },
    ...claudeMounts(target.claude, () => true),
    ...(policy.shareAgentState
      ? providerDirectories().map((directory) => ({ path: directory, readOnly: false }))
      : []),
  ];
  const combined = combineMounts(mounts, parseExtraMounts(policy.extraMounts));
  const line = await backendFor(policy.engine).commandLine(target, policy, combined, ["<command>"]);
  return formatCommand(policy.cli, line);
}

/** Placeholders and plain words stay as they are; anything else is shell-quoted. */
function displayWord(word: string): string {
  return /^[\w@%+=:,./<>~-]+$/.test(word) ? word : shellQuote(word);
}

/** One line for the command, one per option and its values, and one for the image and command. */
export function formatCommand(cli: string, line: CommandLine): string {
  const options: string[][] = [];
  for (const word of line.options) {
    if (word.startsWith("-") || options.length === 0) options.push([word]);
    else options.at(-1)!.push(word);
  }
  return [[cli, ...line.head], ...options, line.tail]
    .filter((words) => words.length > 0)
    .map((words) => words.map(displayWord).join(" "))
    .join(" \\\n  ");
}
