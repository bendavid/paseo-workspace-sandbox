import type { PaseoApi } from "@getpaseo/client";
import {
  formatResolvedCommand,
  profileTakesPrompt,
  resolveTerminalProfiles,
  substitutePrompt,
} from "@getpaseo/protocol/terminal-profiles";
import type { TerminalProfile } from "@getpaseo/protocol/terminal-profile";
import type { SandboxTerminalProfile } from "../shared/rpc";

// Earlier versions added a global "Sandbox shell" terminal profile with this ID.
const LEGACY_PROFILE_ID = "workspace-sandbox";

async function configuredProfiles(paseo: PaseoApi): Promise<readonly TerminalProfile[]> {
  const { config } = await paseo.config.get();
  return resolveTerminalProfiles(config.terminalProfiles).filter(
    (profile) => profile.id !== LEGACY_PROFILE_ID,
  );
}

/** The host's terminal profiles, as the New sandboxed workspace launch menu lists them. */
export async function listTerminalProfiles(paseo: PaseoApi): Promise<SandboxTerminalProfile[]> {
  return (await configuredProfiles(paseo)).map((profile) => ({
    id: profile.id,
    name: profile.name,
    takesPrompt: profileTakesPrompt(profile),
    command: formatResolvedCommand(substitutePrompt(profile, "")),
  }));
}

export interface TerminalLaunch {
  name: string;
  /** Run inside the container; empty for a login shell. */
  argv: string[];
  /** Typed into the shell after it starts, for a blank terminal's command. */
  input: string | null;
  /** What names the workspace and branch; a profile without a prompt contributes none. */
  namingPrompt: string;
}

/**
 * Resolves a launch as New workspace does: a profile substitutes the prompt into its argv, and a
 * blank terminal receives the text as a command typed at its prompt, so the shell parses it.
 */
export async function resolveTerminalLaunch(
  paseo: PaseoApi,
  input: { profileId?: string; prompt: string },
): Promise<TerminalLaunch> {
  const text = input.prompt.trim();
  if (!input.profileId) {
    return { name: "Sandboxed terminal", argv: [], input: text || null, namingPrompt: text };
  }
  const profile = (await configuredProfiles(paseo)).find((item) => item.id === input.profileId);
  if (!profile) throw new Error(`Terminal profile ${input.profileId} does not exist`);
  const resolved = substitutePrompt(profile, input.prompt);
  return {
    name: profile.name,
    argv: [resolved.command, ...resolved.args],
    input: null,
    namingPrompt: profileTakesPrompt(profile) ? text : "",
  };
}

/** Removes the "Sandbox shell" profile earlier versions added, leaving every other profile. */
export async function removeLegacyTerminalProfile(paseo: PaseoApi): Promise<void> {
  const { config } = await paseo.config.get();
  const profiles = config.terminalProfiles;
  if (!profiles?.some((profile) => profile.id === LEGACY_PROFILE_ID)) return;
  await paseo.config.patch({
    terminalProfiles: profiles.filter((profile) => profile.id !== LEGACY_PROFILE_ID),
  });
}
