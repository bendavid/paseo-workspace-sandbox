import type { PaseoApi } from "./paseo";
import type { SandboxStore } from "./store";

const SANDBOX_SUFFIX = "-sandbox";

// Built-in providers and the command each runs when none is configured. These mirror the daemon's
// defaults. The daemon appends each provider's own arguments (`app-server`, `--acp`, `--mode rpc`)
// after a configured command, so the wrapped CLI receives the arguments it would on the host.
const BUILTIN_COMMANDS: Record<string, () => string[]> = {
  claude: () => ["claude"],
  codex: () => ["codex"],
  copilot: () => ["copilot"],
  pi: () => [process.env.PI_COMMAND ?? process.env.PI_ACP_PI_COMMAND ?? "pi"],
  omp: () => [process.env.OMP_COMMAND ?? "omp"],
};

// Providers whose sessions cannot move into a workspace's container.
const UNSUPPORTED: Record<string, string> = {
  opencode: "OpenCode runs one server for every session on the daemon",
};

// ACP agents run terminal commands through Paseo on the host unless told not to, and can delegate
// file reads and writes to it.
const ACP_ROOTS = new Set(["acp", "copilot"]);
export const CONTAINED_ACP_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
};

type ProviderEntry = Record<string, unknown>;

export interface DerivedProfile {
  id: string;
  /** Whether the provider speaks ACP, whose per-agent capabilities must also stay contained. */
  acp: boolean;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function asCommand(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string")
    ? value
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Follows `extends` from the requested provider to the built-in (or generic ACP) it is based on.
 * The derived profile extends that root directly, so it never depends on another profile's
 * position in the config.
 */
function resolveRoot(
  provider: string,
  providers: Record<string, ProviderEntry>,
): { root: string; chain: ProviderEntry[] } {
  const chain: ProviderEntry[] = [];
  const seen = new Set<string>();
  let current = provider;
  for (;;) {
    if (seen.has(current)) throw new Error(`Provider ${provider} has an extends cycle`);
    seen.add(current);
    const entry = providers[current];
    const parent = typeof entry?.extends === "string" ? entry.extends : null;
    if (!parent) {
      const unsupported = UNSUPPORTED[current];
      if (unsupported) throw new Error(`${unsupported}, so ${provider} cannot run in a sandbox.`);
      if (!BUILTIN_COMMANDS[current]) {
        // Plugin providers implement their own process handling and cannot be extended.
        throw new Error(
          `${provider} is not a configurable provider, so it cannot run in a sandbox.`,
        );
      }
      return { root: current, chain };
    }
    chain.push(entry);
    if (parent === "acp") return { root: "acp", chain };
    current = parent;
  }
}

function buildProfile(input: {
  provider: string;
  label: string;
  wrapper: string;
  providers: Record<string, ProviderEntry>;
}): { profile: ProviderEntry; acp: boolean } {
  const { root, chain } = resolveRoot(input.provider, input.providers);
  // The daemon merges command, env, and disallowed tools from the root built-in's own entry into
  // profiles that extend it; options and models are not inherited and are carried here.
  const rootEntry = root === "acp" ? undefined : input.providers[root];
  const first = (key: string) =>
    chain.map((entry) => entry[key]).find((value) => value !== undefined);
  const command =
    asCommand(first("command")) ??
    asCommand(rootEntry?.command) ??
    (root === "acp" ? undefined : BUILTIN_COMMANDS[root]?.());
  if (!command) throw new Error(`Provider ${input.provider} has no command to run`);
  // COMPAT(providerParams): `params` is the old spelling of `options`; the daemon still reads it.
  const options = {
    ...(asRecord(first("options")) ??
      asRecord(first("params")) ??
      asRecord(rootEntry?.options) ??
      asRecord(rootEntry?.params)),
  };
  const acp = ACP_ROOTS.has(root);
  if (acp) options.clientCapabilities = CONTAINED_ACP_CAPABILITIES;
  const source = chain[0] ?? rootEntry ?? {};
  return {
    acp,
    // Every field is written, so a patch replaces each one and nothing stale survives.
    profile: {
      extends: root,
      label: `${input.label} (sandboxed)`,
      description: `${input.label} in the workspace's sandbox container`,
      command: [input.wrapper, "agent", ...command],
      env: Object.assign({}, ...chain.toReversed().map((entry) => asRecord(entry.env) ?? {})),
      options,
      models: Array.isArray(source.models) ? source.models : [],
      additionalModels: Array.isArray(source.additionalModels) ? source.additionalModels : [],
      disallowedTools: chain.flatMap((entry) =>
        Array.isArray(entry.disallowedTools) ? entry.disallowedTools : [],
      ),
      // Paseo tools reach outside the container: host terminals, scripts, and other agents.
      paseoTools: { enabled: false },
      enabled: true,
    },
  };
}

async function providerLabel(
  paseo: PaseoApi,
  provider: string,
  entry: ProviderEntry | undefined,
): Promise<string> {
  if (typeof entry?.label === "string") return entry.label;
  const { entries } = await paseo.providers.snapshot();
  return entries.find((candidate) => candidate.provider === provider)?.label ?? provider;
}

/**
 * Derives a sandboxed profile from a provider's current configuration, or from its built-in
 * defaults, and writes it when it is missing or stale. Called whenever an agent is created in a
 * sandboxed workspace, so later edits to the source provider reach its sandboxed profile.
 * Profiles stay after the plugin is removed: agents saved with them keep failing closed instead of
 * resuming on the host.
 */
export class ProfileManager {
  private readonly pending = new Map<string, Promise<DerivedProfile>>();

  constructor(
    private readonly store: SandboxStore,
    private readonly wrapper: string,
  ) {}

  isDerived(provider: string): boolean {
    return this.store.profileBase(provider) !== null;
  }

  baseOf(provider: string): string {
    return this.store.profileBase(provider) ?? provider;
  }

  ensure(paseo: PaseoApi, provider: string): Promise<DerivedProfile> {
    const base = this.baseOf(provider);
    // Concurrent agent creations for one provider share a single read-compare-write.
    const existing = this.pending.get(base);
    if (existing) return existing;
    const task = this.write(paseo, base).finally(() => this.pending.delete(base));
    this.pending.set(base, task);
    return task;
  }

  private async write(paseo: PaseoApi, base: string): Promise<DerivedProfile> {
    const id = `${base}${SANDBOX_SUFFIX}`;
    const { config } = await paseo.config.get();
    const providers = (config.providers ?? {}) as Record<string, ProviderEntry>;
    if (providers[id] && this.store.profileBase(id) !== base) {
      throw new Error(`Provider ${id} already exists and is not managed by the sandbox plugin`);
    }
    const label = await providerLabel(paseo, base, providers[base]);
    const { profile, acp } = buildProfile({
      provider: base,
      label,
      wrapper: this.wrapper,
      providers,
    });
    // Record ownership first, so the session hook recognizes the profile as soon as it exists.
    await this.store.putProfile(id, base);
    const current = providers[id];
    const unchanged =
      current && Object.entries(profile).every(([key, value]) => sameJson(current[key], value));
    if (!unchanged) await paseo.config.patch({ providers: { [id]: profile } });
    return { id, acp };
  }
}
