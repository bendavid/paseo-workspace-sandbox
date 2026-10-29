import { expect, test } from "vitest";
import { listTerminalProfiles, resolveTerminalLaunch } from "../server/terminals";

function paseoWith(terminalProfiles: unknown) {
  return { config: { get: async () => ({ config: { terminalProfiles } }) } } as never;
}

test("lists Paseo's default profiles while the config has none", async () => {
  const profiles = await listTerminalProfiles(paseoWith(undefined));
  expect(profiles.map((profile) => profile.id)).toEqual(["claude", "codex", "opencode", "pi"]);
});

test("launches a profile without a prompt, as New workspace does", async () => {
  const paseo = paseoWith([
    { id: "claude", name: "Claude", command: "claude", args: ["--verbose", "{{{prompt}}}"] },
    { id: "opencode", name: "OpenCode", command: "opencode", args: ["--prompt={{{prompt}}}"] },
    { id: "echo", name: "Echo", command: "sh", args: ["-c", "echo {{{prompt}}} done"] },
  ]);
  expect(await listTerminalProfiles(paseo)).toEqual([
    { id: "claude", name: "Claude", command: "claude --verbose" },
    { id: "opencode", name: "OpenCode", command: "opencode" },
    { id: "echo", name: "Echo", command: "sh -c echo  done" },
  ]);
  expect(await resolveTerminalLaunch(paseo, "opencode")).toEqual({
    name: "OpenCode",
    argv: ["opencode"],
  });
  expect(await resolveTerminalLaunch(paseo, undefined)).toEqual({
    name: "Sandboxed terminal",
    argv: [],
  });
  await expect(resolveTerminalLaunch(paseo, "missing")).rejects.toThrow(/does not exist/);
});

test("lists no profiles when the config has an empty list", async () => {
  expect(await listTerminalProfiles(paseoWith([]))).toEqual([]);
});
