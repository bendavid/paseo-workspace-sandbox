# Workspace sandbox

Prototype: one sandbox per workspace, using only the existing plugin API. A sandbox is a container
(Podman, Docker), a microVM (microsandbox, BoxLite), or a Bubblewrap namespace sandbox; see
[Engines](#engines).

- **New sandboxed workspace** (sidebar header, Command Center, or the workspace-context command
  that preselects the current project) is laid out like New workspace: project, isolation,
  [container profile](#container-profiles), the branch to start from, and a box that names the
  workspace. It opens the new workspace at once and starts its container in the background. As New
  workspace's Isolation, a Git project gets a new worktree or uses its own directory; see
  [Directory sandboxes](#directory-sandboxes).
- Agents start from the workspace's own composer, with attachments, modes, and commands, and
  sandboxed terminals from its header menu or Sandbox panel. Each launch waits for the container;
  see [Container lifecycle](#container-lifecycle).
- Agents created in a sandboxed workspace switch to a sandboxed profile of the provider they asked
  for, such as `claude-sandbox` or `zai-sandbox`. See [Provider profiles](#provider-profiles).
  Sessions, permissions, and history work as usual.
- A **Sandboxed** header button opens the Sandbox panel, which shows a workspace's container and
  its configuration and has **Open sandboxed terminal**. The terminal button beside it opens a menu
  of a terminal and your terminal profiles, run in the container. Settings > Sandbox holds the saved profiles. Archiving the
  workspace removes its container.
- The badge reads **Sandbox starting** until the container is up, then **Sandboxed**, or
  **Sandbox failed**. See [Start failures](#start-failures).

Installing this plugin edits daemon configuration: it adds a provider profile the first time each
provider is used in a sandbox. The profiles stay after the plugin is removed, so agents saved with a sandbox profile fail instead of resuming on the host. Delete them
from `config.json` to clean up. Earlier versions added a "Sandbox shell" terminal profile; the
plugin removes it when it loads.

```bash
paseo plugin install /absolute/path/to/plugin-examples/workspace-sandbox
```

Outside the Paseo repository, add `@getpaseo/protocol` to the plugin's development dependencies at
the same version as `@getpaseo/plugin`; the server bundles its default terminal profiles.

## Form

The form mirrors New workspace's layout and controls, from the app's source: badges in one row on
wide layouts and labeled fields stacked above the composer on compact ones, and anchored dropdowns
with search and check marks (bottom sheets on compact). Plugins cannot import the app's components,
so these are rebuilt in `client/standard-ui.tsx`; colors the plugin theme lacks are blended from its
tokens. Enter creates the workspace on the web.

It launches nothing: plugins can't embed the app's agent composer, and a rebuilt one would lack
attachments, modes, and commands. Without a prompt, the workspace and branch get Paseo's default
names unless you name the workspace.

The workspace ID is chosen by the plugin before the workspace exists: other apps and the daemon's
hooks see the workspace at once, and must already find its sandbox.

It does not offer the host picker or Import session.

## Container lifecycle

The plugin alone starts, recreates, and waits for containers; `sandbox-run` only joins a running
one. One attempt per workspace runs at a time, and everything that needs the container joins it:

- Creating a workspace starts the first attempt, which also decides the
  [Claude folder](#claude-folders).
- The `agent.session_open` hook waits for it before every agent launch: the daemon needs the
  session's `CLAUDE_CONFIG_DIR` before the session starts, and an agent waits only so long for its
  CLI. It waits up to 25 seconds of the hook's 30.
- Opening a sandboxed terminal waits up to 45 seconds of the RPC's 60.
- Starting a stopped container, such as after a reboot, or deciding the Claude folder takes a
  second or two. Only an image's first pull runs longer; that launch is refused with "still
  starting" while the pull goes on in the background.

## Terminals

The plugin never changes terminal profiles, and Paseo's own new terminal opens on the host. Sandboxed
terminals come from the plugin: the header terminal menu and the panel's **Open sandboxed
terminal**. Each runs `sandbox-run terminal` in the workspace, which joins the workspace's
container. A profile's `{prompt}` is left empty, and its command runs in the container, so the image
needs it.

The header menu and the panel open the terminal as a background tab: plugins cannot focus a
terminal. The menu is rebuilt when the workspace list changes, so a profile added in Settings shows
up after the next workspace update.

## Start failures

A failed start shows in the plugin's UI:

- The badge turns into **Sandbox failed**, with the CLI's last error line as its tooltip. Nothing
  pushes a start to the app, so the app polls the sandbox list while a sandbox is starting.
- The Sandbox panel shows the error above its rows. The daemon log has the CLI's full output.
- An agent launch fails with "The sandbox did not start: …", and opening a sandboxed terminal
  fails with the same message; no terminal opens.

Each of these launches tries again, and a container that then runs clears the failure.

## Container profiles

A profile is a saved sandbox configuration: [engine](#engines) and its command, image, network,
extra mounts, and extra run arguments. A new sandboxed workspace copies the profile chosen in the form, so editing or deleting
a profile never changes an existing workspace's container; the Sandbox panel shows the copy.

- The form's **Container** dropdown lists the profiles, with **New profile** (prefilled from the
  selected one) and **Edit** at the bottom. Settings > Sandbox lists them too.
- The default profile is preselected. At least one profile stays.
- Profiles live in `container-profiles.json` in the plugin's data directory. On first start, a
  "Default" profile is created from the settings that predate profiles. Profiles saved before
  engines get the engine of the old global container CLI setting: Podman when that is what it runs.

## Engines

| Engine       | Sandbox                          | Image | Network: Host / Separate / None                                                        | Tested                |
| ------------ | -------------------------------- | ----- | -------------------------------------------------------------------------------------- | --------------------- |
| Podman       | One container per workspace      | Yes   | `--network host` / `bridge` / `none`                                                   | Yes                   |
| Docker       | One container per workspace      | Yes   | as Podman                                                                              | Through podman-docker |
| Bubblewrap   | One namespace sandbox per launch | No    | host network / host network / `--unshare-net`                                          | Yes                   |
| microsandbox | One microVM per workspace        | Yes   | `--net all` / `--net public` / `--no-net`                                              | Yes (0.7.11)          |
| BoxLite      | One microVM per workspace        | Yes   | its own network (host loopback: `host.boxlite.internal`) / same / `--network disabled` | Fails; see below      |

The profile's **Command** is the engine's executable; empty means the default (`podman`, `docker`,
`bwrap`, `msb`, `boxlite`) on PATH, or where the microVM installers put it. Container runtimes such
as krun, gVisor, or Kata go in **Extra run arguments** (`--runtime krun`).

- **Podman and Docker** keep a long-lived container that launches join with `exec`. Podman runs with
  `--userns=keep-id` and Docker with `--user <uid>:<gid>`, so files keep your ownership.
- **Bubblewrap** has no image and nothing long-lived: each launch is a fresh sandbox with the host's
  `/usr`, `/etc`, and `/opt` read-only, its own `/proc`, `/dev`, `/tmp`, and `/run`, the sandbox's
  mounts, and a clean environment. Tools are the host's own. Bubblewrap applies mounts in order, so
  the plugin sorts them parents first. The home directory is a scratch folder for the launch unless
  a mount covers it. It needs unprivileged user namespaces; "starting" runs `true` in one, so a host
  without them fails as a start failure. Extra run arguments are added to `bwrap`.
- **microsandbox and BoxLite** keep a libkrun microVM per workspace and join it with `exec`, sharing
  host folders over virtio-fs at the same paths and running commands as your uid, so files keep your
  ownership. Each launch's variables are exported to the client and passed as `-e NAME`, which keeps
  their values off its command line. libkrun does not confine a guest to a shared folder's subtree,
  so share narrow folders.
- **BoxLite 0.10.8 does not work here yet,** for three reasons found in testing on x86_64:
  - libkrun runs out of interrupt lines with more than two shared folders (`IrqsExhausted` in the
    box's `shim.stderr`), and a sandbox needs at least the workspace, its Claude folder, and the token
    folder. microsandbox has no such limit.
  - On btrfs, BoxLite copies its `boxlite-shim` into each box without the execute bit, so no box
    starts. A `BOXLITE_HOME` on another filesystem avoids it.
  - A read-write folder inside a read-only one stays read-only, whatever the order.

The [Claude folder check](#claude-folders) uses a marker file the host creates, not device and
inode numbers, which a microVM's virtio-fs does not preserve.

## Directory sandboxes

**Sandboxed directory** is the sandboxed counterpart of New workspace's "Local": a new workspace on
the project directory, titled `<project> (sandboxed)` unless you name it. Projects that are not Git
repositories always get one; Git projects choose it in the Isolation dropdown, where the default is
**Sandboxed worktree**. The `agent.create`
hook sees only an agent's directory, not its workspace, so new agents started anywhere in that
directory, from any of the project's workspaces, run in the sandbox. Agents that were already running
there keep their host provider. Archiving the sandboxed workspace ends this.

## Provider profiles

Each time an agent is created in a sandboxed workspace, the plugin derives `<provider>-sandbox` from
the requested provider's current configuration, writes it if it is missing or stale, and switches
the agent to it. Editing the source provider reaches its sandboxed profile with the next agent.

- The profile extends the built-in at the root of the provider's `extends` chain, or `acp`, and
  carries the chain's command, env, options, models, and disallowed tools. A daemon fails to load a
  profile that extends one listed after it, so profiles never extend each other.
- The command is the provider's configured command, or the built-in default (`claude`, `codex`,
  `copilot`, `pi`, `omp`), behind `sandbox-run agent`. The daemon appends each provider's own
  arguments, such as `app-server` or `--acp`, after it.
- ACP providers (Copilot and `extends: "acp"`) get `clientCapabilities` with terminal and file
  access turned off, on the profile and on each agent, because Paseo would otherwise run their
  commands on the host.
- Paseo tools are disabled because they reach host terminals, scripts, and other agents.
- `state.json` records which profiles the plugin owns. An existing profile with the same ID that
  the plugin did not create is refused.

OpenCode is refused: it runs one server for every session on the daemon. Plugin-registered
providers are refused because a profile cannot extend them.

The daemon checks the requested provider before plugin hooks run, so an agent started in a sandboxed
workspace needs its provider available on the host, even though it runs in the container. Model
discovery runs the host's CLI too; see [Runs without a session](#runs-without-a-session).

## Runs without a session

Paseo runs some provider commands without an agent session: model discovery, version checks, and
history for agents whose sandbox is gone (Codex reads it through its CLI). `sandbox-run` runs these
with the host's CLI, so sandboxed profiles list the models the host's CLI reports. That assumes the
images carry the same CLI versions as the host. A per-image answer would need a provider per image:
Paseo keeps one catalog per provider ID, and Claude's catalog is global by design. Agent sessions
never fall back to the host.

Earlier versions ran these in a probe container, `paseo-sandbox-probe-<hash of the data directory>`;
the plugin removes it when it starts.

## Image

Engines other than Bubblewrap run an image. The "Default" profile's image, `node:22-bookworm-slim`,
has no agent CLIs. Build one that installs
them, or mount them from the host with **Extra mounts**. A mounted CLI must be on the `PATH` the
sandboxed terminal's shell builds (see [Commands see the terminal's environment](#commands-see-the-terminals-environment)),
or add it with `--env-merge PATH=/its/dir:${PATH}` under **Extra run arguments** (Podman only;
Docker's `-e` does not expand `${PATH}`):

```dockerfile
FROM docker.io/library/node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && npm install -g @anthropic-ai/claude-code @openai/codex
```

Each sandbox mounts, at the same absolute paths:

| Path                                        | Access     | Why                                                   |
| ------------------------------------------- | ---------- | ----------------------------------------------------- |
| Workspace directory                         | read-write | The agent's work                                      |
| Source checkout `.git`                      | read-write | A worktree's objects and refs live there              |
| `.git/hooks`, `.git/config`                 | read-only  | Both run on the host whenever git runs there          |
| The workspace's own Claude folder           | read-write | See [Claude folders](#claude-folders)                 |
| `~/.codex`, `~/.copilot`, `~/.pi`, `~/.omp` | read-write | Credentials, and history the daemon reads on the host |

`HOME` keeps the host path, but nothing else of the home directory is mounted. A container engine
creates it owned by root as the parent of the provider directories, so it is not writable (in
Bubblewrap it is a scratch folder for the launch): tools
that write elsewhere in `~`, such as `npm`'s cache, `~/.cache`, or `~/.config`, fail until you add
those directories, or `~` itself, under extra mounts.

Extra mounts may contain the mounts above. Engines mount parents before children whatever the order
(the plugin sorts them for Bubblewrap), so `~:ro` gives a read-only home around a read-write workspace and provider directories.
At a path the plugin already mounts, the plugin's access wins, so the workspace stays writable and
git hooks and config stay read-only. Two extra mounts of one path are read-only if either is.

The default host network lets agents reach the daemon's MCP endpoint on loopback.

## Claude folders

Each new sandbox gets its own Claude config folder, `homes/<workspace id>/claude` in the plugin's
data directory, mounted at that path and set as `CLAUDE_CONFIG_DIR`. Transcripts, prompt history,
and file history stay in it, so agents can't read or change another workspace's sessions. The
session hook passes the same `CLAUDE_CONFIG_DIR` to the daemon, which reads transcripts there. The
folder stays after the workspace is archived, so its agents' history stays readable.

- From your host folder, `CLAUDE.md`, `agents/`, `commands/`, `skills/`, and `output-styles/` are
  mounted read-only, and `plugins/` is the read-only `CLAUDE_CODE_PLUGIN_SEED_DIR`.
- `settings.json` is your host's, rewritten whenever the plugin reconciles, with `apiKeyHelper`
  added. `.claude.json` is copied once without its `projects` map.
- An extra mount that shows your host folder read-only, such as `~:ro`, stays: the container can
  read the host folder, including `.credentials.json`, but Claude Code uses the private folder.
  Anything that used the refresh token in there would sign the host out.
- When the sandbox's own configuration already makes your host folder writable, it uses the host
  folder, with no private folder or helper. Sandboxes created before private folders keep the host
  folder too.

The decision is made once per sandbox, as it starts, and the Sandbox panel shows it with its reason:

1. A throwaway container with the sandbox's image, user mapping, workspace, extra mounts,
   and extra run arguments, but none of the plugin's Claude mounts, checks the folder. It is shared
   only when it is the host's folder (same device and inode) and a file can be created in it. This
   catches `-v` in extra run arguments, symlinks, named volumes, and permissions.
2. Anything else is private, a failed check included: wrongly sharing would grant writes the mounts
   withheld, while wrongly keeping it private only stops sharing transcripts.

The check briefly creates and deletes a file in the host folder. Its first run pulls the image,
which the sandbox then reuses. It runs as part of the sandbox's first start, which agents and
terminals wait for; see [Container lifecycle](#container-lifecycle).

### Sign-in

A sandbox never gets your host's refresh token. Each refresh issues a new refresh token and the
old one stops working, so a sandbox that refreshed a copy would sign out the host and every other
holder. The credentials file can't be shared another way: Claude Code saves it by rename and does
not follow a symlink for it, and it always lives in the config folder.

Instead, sandboxes sign in with your host's current access token:

1. The plugin copies the access token alone to `auth/claude-access-token` (mode `600`), and its
   `apiKeyHelper`, `auth/claude-api-key-helper`, prints it. Both are mounted read-only through the
   `auth/` folder, since a file mount would keep the replaced file. Claude Code re-runs the helper
   every five minutes and after a 401, so long sessions follow your host's refreshes.
2. The plugin re-reads `.credentials.json` once a minute, at every sandboxed agent launch, and
   after its own refreshes.
3. About four minutes before the token expires, the plugin runs `claude auth status` on the host.
   It is the cheapest command that refreshes: Claude Code refreshes a token with less than about
   five minutes left when it starts, and `auth status` sends no model request. It goes through
   Claude Code's own lock, so it can't collide with your sessions. A host session that refreshes
   first makes it a no-op.

`/login` on the host revokes nothing; sandboxes switch to the new token at the next read. `/logout`
revokes the refresh token and every access token issued with it, so sandboxed agents fail at once,
and the Sandboxed badge reads **Sign in on host** within a minute.

A `CLAUDE_CODE_OAUTH_TOKEN` that reaches the sandbox, from the Claude provider's env or the daemon's,
takes over: the helper prints it, because `apiKeyHelper` ranks above that variable.
`ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` rank above the helper, so providers such as Z.AI keep
their own credentials. On macOS, Claude Code keeps its login in the Keychain, which the plugin does
not read; set `CLAUDE_CODE_OAUTH_TOKEN` there.

## Commands see the terminal's environment

A blank sandboxed terminal runs the container's interactive login shell: `bash -il`, or `sh -il`
when the image has no bash. Agents and terminal profiles start without a shell, so the first one in
each container captures the environment that shell builds and later ones reuse it. Starting each
through the shell would be slower, and anything the dotfiles print would reach the agent's
protocol stream.

- The capture lives in `workspaces/<id>.env`, readable only by you, because dotfiles can export
  secrets. Its first line names the container it came from, so a recreated container captures
  again. Delete the file to pick up changed dotfiles.
- Variables `sandbox-run` forwards for each launch, such as `PASEO_*`, override captured ones.
- Your dotfiles only take part when an extra mount covers them, such as `~:ro`. Otherwise the
  shell builds the image's environment.

## How the wrapper finds its workspace

The plugin keeps `bin/sandbox-run`, `state.json`, `container-profiles.json`, per sandbox
a `workspaces/<id>.sh` spec and its captured `.env`, the private Claude folders in `homes/`, and
the token and helper in `auth/` in `$PASEO_HOME/plugin-data/workspace-sandbox`,
the folder Paseo plugins use for their own data. The
plugin's own directory is not available at runtime, and it cannot read its runtime ID, so the folder
uses the manifest ID: install it once per daemon. Removing the plugin leaves the folder in place, and
the profiles still point at the wrapper, so sandboxed agents keep failing closed. Delete the folder
only after removing the profiles from `config.json`.

| Launch                       | Container from                                            | Without a sandbox            |
| ---------------------------- | --------------------------------------------------------- | ---------------------------- |
| Agent session                | `PASEO_SANDBOX_WORKSPACE_ID`, set by `agent.session_open` | Fails (`PASEO_AGENT_ID` set) |
| History of an archived agent | `PASEO_SANDBOX_ROUTE=host`, set by `agent.session_open`   | Host CLI                     |
| Model/version probe          | none                                                      | Host CLI                     |
| Sandboxed terminal           | `PASEO_WORKSPACE_ID`, set on every terminal               | Fails                        |

The spec holds the engine's part of `sandbox-run`: a few shell functions (ready, ID, run a command
inside, signal), documented at the top of `server/wrapper.ts`. `sandbox-run` joins the sandbox the
plugin started and fails when it isn't ready. It forwards only `PASEO_*`, provider, and locale
variables. Killing a long-lived engine's `exec` client does not stop the process inside, so the
wrapper records the inner pid and forwards `TERM`, `INT`, and `HUP`; Bubblewrap's launch replaces
the wrapper and dies with it.

## Not sandboxed

This prototype covers what the plugin API reaches. Everything else still runs on the host:

- Terminals Paseo opens itself, including its new terminal and terminal profiles, `paseo.json` scripts and services, and worktree setup and teardown.
  For an untrusted repository, setup alone defeats the sandbox. Plugins cannot intercept terminal
  creation.
- Git that the daemon runs in the workspace. The agent can write the workspace's `.git` file and
  point it at a directory whose config runs commands (`core.fsmonitor`) the next time the daemon
  runs git there.
- OpenCode and plugin-registered providers: creating one in a sandboxed workspace fails.
- State for custom ACP agents outside the directories above, until added under extra mounts.
- Title, branch, and commit-message generation use the `metadataGeneration` providers.

Agents saved with a host provider cannot reopen in a sandboxed workspace, and sandbox profiles
cannot run outside one; both fail with an explanation.

## Plugin API gaps found

- No way to push state to the app or show a toast, so start failures are polled and surfaced
  through the badge and panel.
- No way to focus a terminal. `navigation.openWorkspace` takes only a workspace, and header button
  actions receive no navigation.

- No terminal creation hook, so the default shell, scripts, and setup cannot be redirected.
- No provider launch hook, so sandboxing a provider needs a visible derived profile, and the
  requested provider must be available on the host.
- The server entry receives no Paseo session. The plugin finishes starting up on the first RPC or
  hook, which the client entry triggers when an app connects.
- No slot on sidebar project rows or in the New workspace form, and no access to the app's
  combobox and composer, so the plugin's form rebuilds their look.
- No way to decorate a workspace row in the sidebar. Workspace labels would do it, but the plugin
  SDK does not expose the daemon's label RPCs.
- `before("workspace.create")` does not receive the workspace ID the daemon allocates, so a
  sandbox can be registered ahead of time only for workspaces the plugin creates itself, under an
  ID it chooses.
- `agent.create` hooks receive the agent's directory but not its workspace, so a sandbox cannot be
  limited to one of several workspaces that share a directory.
