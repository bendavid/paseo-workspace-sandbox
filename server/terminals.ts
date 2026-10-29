import type { PaseoApi } from "@getpaseo/client";
import type { SandboxTerminalProfile } from "../shared/rpc";

interface TerminalProfile {
  id: string;
  name: string;
  command: string;
  args?: string[];
}

// Paseo's own terminal profile format, which the plugin SDK does not export. A profile marks where
// a typed prompt goes with this; the sandbox's launch menu types none.
const PROMPT_SENTINEL = "{{{prompt}}}";

// Paseo's defaults, which apply while the config has no terminalProfiles.
const DEFAULT_PROFILES: readonly TerminalProfile[] = [
  { id: "claude", name: "Claude Code", command: "claude" },
  { id: "codex", name: "Codex", command: "codex" },
  { id: "opencode", name: "OpenCode", command: "opencode" },
  { id: "pi", name: "Pi", command: "pi" },
];

/**
 * A profile's command with no prompt, as Paseo launches it: arguments that only carry the prompt
 * (`{{{prompt}}}` or `--flag={{{prompt}}}`) are dropped, and a prompt inside other text is empty.
 */
function withoutPrompt(profile: TerminalProfile): string[] {
  const args = (profile.args ?? []).flatMap((arg) => {
    const separator = arg.indexOf("=");
    const promptOnly =
      arg === PROMPT_SENTINEL || (separator > 0 && arg.slice(separator + 1) === PROMPT_SENTINEL);
    return promptOnly ? [] : [arg.split(PROMPT_SENTINEL).join("")];
  });
  return [profile.command.split(PROMPT_SENTINEL).join(""), ...args];
}

async function configuredProfiles(paseo: PaseoApi): Promise<readonly TerminalProfile[]> {
  const { config } = await paseo.config.get();
  return config.terminalProfiles ?? DEFAULT_PROFILES;
}

/** The host's terminal profiles, as the sandbox's terminal menu lists them. */
export async function listTerminalProfiles(paseo: PaseoApi): Promise<SandboxTerminalProfile[]> {
  return (await configuredProfiles(paseo)).map((profile) => ({
    id: profile.id,
    name: profile.name,
    command: withoutPrompt(profile).join(" "),
  }));
}

export interface TerminalLaunch {
  name: string;
  /** Run inside the sandbox; empty for a login shell. */
  argv: string[];
}

/** A login shell, or a terminal profile's command, as New workspace launches it with no prompt. */
export async function resolveTerminalLaunch(
  paseo: PaseoApi,
  profileId: string | undefined,
): Promise<TerminalLaunch> {
  if (!profileId) return { name: "Sandboxed terminal", argv: [] };
  const profile = (await configuredProfiles(paseo)).find((item) => item.id === profileId);
  if (!profile) throw new Error(`Terminal profile ${profileId} does not exist`);
  return { name: profile.name, argv: withoutPrompt(profile) };
}
