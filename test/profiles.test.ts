// Sandboxed provider profiles derived from the configured providers, with a stub Paseo API.
import { expect, test } from "vitest";
import { ProfileManager } from "../server/profiles";

function setup(providers: Record<string, unknown>) {
  const owned = new Map<string, string>();
  const store = {
    profileBase: (id: string) => owned.get(id) ?? null,
    putProfile: async (id: string, base: string) => void owned.set(id, base),
  };
  const patches: unknown[] = [];
  const paseo = {
    config: {
      get: async () => ({ config: { providers } }),
      patch: async (patch: { providers: Record<string, unknown> }) => {
        patches.push(patch);
        Object.assign(providers, patch.providers);
        return { config: { providers } };
      },
    },
    providers: {
      snapshot: async () => ({
        entries: [
          { provider: "copilot", label: "GitHub Copilot" },
          { provider: "pi", label: "Pi" },
          { provider: "codex", label: "Codex" },
        ],
      }),
    },
  };
  const manager = new ProfileManager(store as never, "/w/sandbox-run");
  return { manager, paseo: paseo as never, providers, patches };
}

test("derives a sandboxed profile for each provider", async () => {
  const { manager, paseo, providers, patches } = setup({
    myacp: {
      extends: "acp",
      label: "My ACP",
      command: ["my-agent", "--acp"],
      options: { supportsMcpServers: true },
    },
    copilot: { env: { GH: "1" }, options: { clientCapabilities: { terminal: true } } },
    work: { extends: "codex", env: { A: "1" }, disallowedTools: ["x"] },
    nested: { extends: "work", env: { B: "2" }, label: "Nested" },
  });

  expect(await manager.ensure(paseo, "myacp")).toEqual({ id: "myacp-sandbox", acp: true });
  expect(providers["myacp-sandbox"]).toMatchObject({
    extends: "acp",
    command: ["/w/sandbox-run", "agent", "my-agent", "--acp"],
    options: {
      supportsMcpServers: true,
      clientCapabilities: { terminal: false, fs: { readTextFile: false, writeTextFile: false } },
    },
  });

  // Built-in ACP: default binary (the daemon appends --acp), its own options kept but contained.
  expect(await manager.ensure(paseo, "copilot")).toEqual({ id: "copilot-sandbox", acp: true });
  expect(providers["copilot-sandbox"]).toMatchObject({
    extends: "copilot",
    label: "GitHub Copilot (sandboxed)",
    command: ["/w/sandbox-run", "agent", "copilot"],
    env: {},
    options: { clientCapabilities: { terminal: false } },
  });

  expect(await manager.ensure(paseo, "pi")).toEqual({ id: "pi-sandbox", acp: false });
  expect(providers["pi-sandbox"]).toMatchObject({
    extends: "pi",
    command: ["/w/sandbox-run", "agent", "pi"],
  });

  // Chains flatten onto the built-in root; env merges with the nearest winning.
  await manager.ensure(paseo, "nested");
  expect(providers["nested-sandbox"]).toMatchObject({
    extends: "codex",
    label: "Nested (sandboxed)",
    command: ["/w/sandbox-run", "agent", "codex"],
    env: { A: "1", B: "2" },
    disallowedTools: ["x"],
  });

  // Re-deriving an unchanged provider writes nothing.
  const before = patches.length;
  await manager.ensure(paseo, "nested");
  await manager.ensure(paseo, "nested-sandbox");
  expect(patches.length).toBe(before);

  await expect(manager.ensure(paseo, "opencode")).rejects.toThrow(/one server/);
  await expect(manager.ensure(paseo, "muse")).rejects.toThrow(/not a configurable provider/);
  providers["claude-sandbox"] = { extends: "claude" };
  await expect(manager.ensure(paseo, "claude")).rejects.toThrow(
    /not managed by the sandbox plugin/,
  );
});
