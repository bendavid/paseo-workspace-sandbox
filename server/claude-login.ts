import { chmod, mkdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { execCommand } from "@getpaseo/plugin/server";
import type { ClaudeLogin } from "../shared/rpc";
import { writeFileAtomic } from "./store";

// Claude Code refreshes a token that has expired or has less than about five minutes left, the
// next time it starts or sends a request. `claude auth status` is the cheapest command that does:
// it makes no model request.
const REFRESH_BEFORE_EXPIRY_MS = 4 * 60_000;
const RETRY_AFTER_FAILURE_MS = 5 * 60_000;
const CHECK_INTERVAL_MS = 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

// A token in these variables would make `claude auth status` report it instead of refreshing the
// stored login, and a parent session's markers change how Claude Code starts.
const REFRESH_ENV_EXCLUDED = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_CHILD_SESSION",
];

export interface HostClaude {
  /** The host's Claude config folder, where `.credentials.json` lives. */
  configDir: string;
  /** Whether the folder was configured explicitly, rather than Claude Code's default. */
  configDirExplicit: boolean;
  command: string[];
  /** CLAUDE_CODE_OAUTH_TOKEN is set for the host's Claude provider or the daemon. */
  envToken: boolean;
}

export function defaultHostClaude(env: NodeJS.ProcessEnv = process.env): HostClaude {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return {
    configDir: configured ? path.resolve(configured) : path.join(homedir(), ".claude"),
    configDirExplicit: Boolean(configured),
    command: ["claude"],
    envToken: Boolean(env.CLAUDE_CODE_OAUTH_TOKEN?.trim()),
  };
}

function asStrings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string")
    ? value
    : undefined;
}

/**
 * The host's Claude: the `claude` provider's configured command and env, over the daemon's own
 * environment, which is where Claude Code also looks.
 */
export function hostClaudeFromConfig(config: { providers?: unknown }): HostClaude {
  const providers =
    config.providers !== null && typeof config.providers === "object"
      ? (config.providers as Record<string, unknown>)
      : {};
  const entry = providers.claude;
  const fields =
    entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
  const env =
    fields.env !== null && typeof fields.env === "object"
      ? (fields.env as Record<string, unknown>)
      : {};
  const strings = Object.fromEntries(
    Object.entries(env).filter((pair): pair is [string, string] => typeof pair[1] === "string"),
  );
  return {
    ...defaultHostClaude({ ...process.env, ...strings }),
    command: asStrings(fields.command) ?? ["claude"],
  };
}

interface OAuthLogin {
  accessToken: string;
  expiresAt: number;
}

function parseLogin(raw: string): OAuthLogin | null {
  const parsed: unknown = JSON.parse(raw);
  const oauth =
    parsed !== null && typeof parsed === "object"
      ? (parsed as { claudeAiOauth?: unknown }).claudeAiOauth
      : undefined;
  if (oauth === null || typeof oauth !== "object") return null;
  const { accessToken, expiresAt } = oauth as Record<string, unknown>;
  if (typeof accessToken !== "string" || !accessToken || typeof expiresAt !== "number") return null;
  return { accessToken, expiresAt };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function lastLine(error: unknown): string {
  const stderr =
    typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : "";
  const line = stderr.trim().split("\n").pop()?.trim();
  return line || (error instanceof Error ? error.message : String(error));
}

/**
 * Gives sandboxes with a private Claude config folder the host's current access token, never its
 * refresh token: a sandbox that refreshed would use up the token the host holds and sign it out.
 *
 * The token goes to a file of its own that sandboxes mount read-only, and their `apiKeyHelper`
 * prints it. Claude Code re-runs the helper every five minutes and after a 401, so long sessions
 * follow the host's refreshes. When nothing on the host refreshes, the plugin runs
 * `claude auth status` shortly before the token expires.
 */
export class ClaudeLoginKeeper {
  private host: HostClaude = defaultHostClaude();
  private current: ClaudeLogin = { state: "signed-out", message: "Not read yet" };
  private fingerprint = "";
  private token: string | null = null;
  private expiresAt: number | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<void> | null = null;
  private syncing: Promise<void> | null = null;
  private stopped = false;

  constructor(
    /** Mounted read-only into sandboxes with a private config folder. */
    readonly directory: string,
    /** Whether any sandbox needs the token; the plugin refreshes the host login only then. */
    private readonly needed: () => boolean,
    private readonly checkIntervalMs = CHECK_INTERVAL_MS,
  ) {}

  get tokenFile(): string {
    return path.join(this.directory, "claude-access-token");
  }

  get helperFile(): string {
    return path.join(this.directory, "claude-api-key-helper");
  }

  /** The `apiKeyHelper` setting for a private config folder. */
  get helperCommand(): string {
    return `sh ${shellQuote(this.helperFile)}`;
  }

  get hostConfigDir(): string {
    return this.host.configDir;
  }

  get credentialsFile(): string {
    return path.join(this.host.configDir, ".credentials.json");
  }

  state(): ClaudeLogin {
    return this.host.envToken ? { state: "env-token" } : this.current;
  }

  async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await chmod(this.directory, 0o700);
    await this.writeHelper();
    await this.sync();
    this.checkTimer = setInterval(() => void this.check(), this.checkIntervalMs);
    this.checkTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.checkTimer) clearInterval(this.checkTimer);
  }

  /** Applies the host's Claude provider configuration; re-reads the login when it moved. */
  async configure(host: HostClaude): Promise<void> {
    const moved = host.configDir !== this.host.configDir;
    this.host = host;
    if (moved) {
      this.fingerprint = "";
      await this.sync();
    }
  }

  /** Re-reads the credentials file now. Cheap when it has not changed. */
  sync(): Promise<void> {
    this.syncing ??= this.read().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async check(): Promise<void> {
    try {
      await this.sync();
    } catch (error) {
      console.error("Claude login check failed", error);
    }
  }

  /**
   * `/login` replaces the credentials file and `/logout` deletes it (revoking the refresh token,
   * and with it every access token issued from it), so inode, size, and mtime tell when to look.
   */
  private async read(): Promise<void> {
    let fingerprint: string;
    try {
      const info = await stat(this.credentialsFile);
      fingerprint = `${info.ino}:${info.size}:${info.mtimeMs}`;
    } catch {
      fingerprint = "missing";
    }
    if (fingerprint === this.fingerprint) return;
    this.fingerprint = fingerprint;
    const login =
      fingerprint === "missing"
        ? null
        : await readFile(this.credentialsFile, "utf8")
            .then(parseLogin)
            .catch(() => null);
    if (!login) {
      await this.signedOut();
      return;
    }
    if (login.accessToken !== this.token) {
      await writeFileAtomic(this.tokenFile, login.accessToken, 0o600);
      this.token = login.accessToken;
    }
    this.expiresAt = login.expiresAt;
    this.current = { state: "signed-in", expiresAt: login.expiresAt };
    this.schedule(login.expiresAt - REFRESH_BEFORE_EXPIRY_MS - Date.now());
  }

  private async signedOut(): Promise<void> {
    this.token = null;
    this.expiresAt = null;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    await rm(this.tokenFile, { force: true });
    this.current = {
      state: "signed-out",
      message:
        process.platform === "darwin"
          ? "No Claude login file on the host. Claude Code on macOS keeps its login in the Keychain, which sandboxes cannot use; set CLAUDE_CODE_OAUTH_TOKEN instead."
          : "Claude is signed out on the host. Run /login in Claude Code there.",
    };
  }

  private schedule(delayMs: number): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.stopped) return;
    this.refreshTimer = setTimeout(
      () => void this.refresh(),
      Math.min(Math.max(delayMs, 0), MAX_TIMER_MS),
    );
    this.refreshTimer.unref?.();
  }

  private refresh(): Promise<void> {
    this.refreshing ??= this.runRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async runRefresh(): Promise<void> {
    // A host session may have refreshed already.
    await this.sync();
    if (this.expiresAt === null || this.expiresAt - Date.now() > REFRESH_BEFORE_EXPIRY_MS) return;
    if (!this.needed()) {
      this.schedule(RETRY_AFTER_FAILURE_MS);
      return;
    }
    const [command, ...args] = this.host.command;
    const env = { ...process.env };
    for (const name of REFRESH_ENV_EXCLUDED) delete env[name];
    // Setting CLAUDE_CONFIG_DIR to the default moves where Claude Code keeps `.claude.json`, so
    // only an explicitly configured folder is passed on.
    if (this.host.configDirExplicit) env.CLAUDE_CONFIG_DIR = this.host.configDir;
    let failure: string | null = null;
    try {
      await execCommand(command ?? "claude", [...args, "auth", "status"], {
        env,
        timeout: 60_000,
      });
    } catch (error) {
      // `auth status` exits 1 when signed out; the credentials file tells what happened.
      failure = lastLine(error);
    }
    await this.sync();
    if (this.expiresAt !== null && this.expiresAt - Date.now() <= REFRESH_BEFORE_EXPIRY_MS) {
      this.current = {
        state: "refresh-failed",
        message: `Could not refresh the host's Claude login${failure ? `: ${failure}` : ""}. Run /login in Claude Code on the host.`,
      };
      this.schedule(RETRY_AFTER_FAILURE_MS);
    }
  }

  /**
   * Claude Code passes its environment to the helper, so a CLAUDE_CODE_OAUTH_TOKEN reaching the
   * sandbox wins: the helper ranks above that variable and would otherwise replace it.
   */
  private async writeHelper(): Promise<void> {
    const script = [
      "#!/bin/sh",
      "# Generated by the workspace-sandbox plugin: Claude Code's apiKeyHelper in sandboxes with a",
      "# private config folder. Prints the host's current access token, never its refresh token.",
      'if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then',
      '  printf "%s" "$CLAUDE_CODE_OAUTH_TOKEN"',
      "  exit 0",
      "fi",
      `token=$(cat ${shellQuote(this.tokenFile)} 2>/dev/null)`,
      'if [ -z "$token" ]; then',
      '  echo "workspace-sandbox: Claude is signed out on the host. Run /login there, or set CLAUDE_CODE_OAUTH_TOKEN." >&2',
      "  exit 1",
      "fi",
      'printf "%s" "$token"',
      "",
    ].join("\n");
    await writeFileAtomic(this.helperFile, script, 0o700);
  }
}
