// ClaudeLoginKeeper with a fake `claude` and temporary folders; it never touches your own login.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { ClaudeLoginKeeper } from "../server/claude-login";

const run = promisify(execFile);
const keepers: ClaudeLoginKeeper[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const keeper of keepers.splice(0)) keeper.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function waitFor<T>(
  label: string,
  read: () => Promise<T | null> | T | null,
  ms = 10_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function setup(options: { fakeClaude: "refreshes" | "fails" }) {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-login-"));
  roots.push(root);
  const configDir = path.join(root, "claude");
  const authDir = path.join(root, "auth");
  const credentials = path.join(configDir, ".credentials.json");
  const write = async (accessToken: string, expiresInMs: number) => {
    await mkdir(configDir, { recursive: true });
    const temporary = `${credentials}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({
        claudeAiOauth: {
          accessToken,
          refreshToken: `r-${accessToken}`,
          expiresAt: Date.now() + expiresInMs,
        },
      }),
    );
    // Claude Code replaces the file by rename.
    await rename(temporary, credentials);
  };
  const fake = path.join(root, "fake-claude");
  const refreshed = JSON.stringify({
    claudeAiOauth: {
      accessToken: "tok-refreshed",
      refreshToken: "r2",
      expiresAt: Date.now() + 8 * 3600_000,
    },
  });
  await writeFile(
    fake,
    options.fakeClaude === "refreshes"
      ? `#!/bin/sh\necho "$@" >> '${root}/calls'\n[ "$CLAUDE_CONFIG_DIR" = '${configDir}' ] || exit 3\n[ -z "$CLAUDE_CODE_OAUTH_TOKEN" ] || exit 4\nprintf '%s' '${refreshed}' > '${credentials}.new' && mv '${credentials}.new' '${credentials}'\n`
      : `#!/bin/sh\necho "$@" >> '${root}/calls'\necho "Error: refresh rejected" >&2\nexit 1\n`,
  );
  await chmod(fake, 0o755);
  const keeper = new ClaudeLoginKeeper(authDir, () => true, 200);
  keepers.push(keeper);
  await keeper.configure({ configDir, configDirExplicit: true, command: [fake], envToken: false });
  return { root, configDir, authDir, credentials, write, keeper, tokenFile: keeper.tokenFile };
}

const read = (file: string) => (existsSync(file) ? readFile(file, "utf8") : null);

test("refreshes the host login before it expires and follows /login and /logout", async () => {
  const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: "should-be-stripped" };
  process.env.CLAUDE_CODE_OAUTH_TOKEN = env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    const t = await setup({ fakeClaude: "refreshes" });
    await t.write("tok-1", 2 * 60_000); // inside the refresh window
    await t.keeper.start();
    // The refresh runs at once and the token file follows it.
    expect(
      await waitFor("refreshed token", async () =>
        (await read(t.tokenFile)) === "tok-refreshed" ? "ok" : null,
      ),
    ).toBe("ok");
    expect((await readFile(path.join(t.root, "calls"), "utf8")).trim()).toBe("auth status");
    expect(t.keeper.state()).toMatchObject({ state: "signed-in" });
    // Only the access token, readable only by you.
    expect((await stat(t.tokenFile)).mode & 0o777).toBe(0o600);

    // A host /login replaces the file: the minute check (200 ms here) picks it up.
    await t.write("tok-login", 8 * 3600_000);
    expect(
      await waitFor("login token", async () =>
        (await read(t.tokenFile)) === "tok-login" ? "ok" : null,
      ),
    ).toBe("ok");

    // The helper prints the token, prefers CLAUDE_CODE_OAUTH_TOKEN, and fails clearly without one.
    const clean = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
    expect((await run("sh", [t.keeper.helperFile], { env: clean })).stdout).toBe("tok-login");
    expect(
      (
        await run("sh", [t.keeper.helperFile], {
          env: { ...clean, CLAUDE_CODE_OAUTH_TOKEN: "env-tok" },
        })
      ).stdout,
    ).toBe("env-tok");

    // A host /logout deletes the file.
    await rm(t.credentials);
    expect(
      await waitFor("token file removed", () => (existsSync(t.tokenFile) ? null : "gone")),
    ).toBe("gone");
    expect(t.keeper.state()).toMatchObject({ state: "signed-out" });
    const failed = await run("sh", [t.keeper.helperFile], { env: clean }).then(
      () => null,
      (error: { code: number; stderr: string }) => error,
    );
    expect(failed?.code).toBe(1);
    expect(failed?.stderr).toMatch(/signed out on the host/);
  } finally {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }
});

test("reports a refresh that fails", async () => {
  const t = await setup({ fakeClaude: "fails" });
  await t.write("tok-old", 60_000);
  await t.keeper.start();
  const state = await waitFor("refresh-failed", () =>
    t.keeper.state().state === "refresh-failed" ? t.keeper.state() : null,
  );
  expect(state).toMatchObject({
    state: "refresh-failed",
    message: expect.stringContaining("refresh rejected"),
  });
  // The old token stays available until it expires.
  expect(await read(t.tokenFile)).toBe("tok-old");
});

test("reports CLAUDE_CODE_OAUTH_TOKEN instead of the host login", async () => {
  const t = await setup({ fakeClaude: "refreshes" });
  await t.write("tok-1", 8 * 3600_000);
  await t.keeper.start();
  await t.keeper.configure({
    configDir: t.configDir,
    configDirExplicit: true,
    command: ["claude"],
    envToken: true,
  });
  expect(t.keeper.state()).toEqual({ state: "env-token" });
});
