# Workspace Sandbox for Paseo

A [Paseo](https://paseo.sh) plugin that runs a workspace's agents and terminals in a sandbox that
sees only the workspace, your agents' own state, and the folders you add. A sandbox is a Podman or
Docker container, a microsandbox microVM, or a Bubblewrap sandbox built from the host's system.

![A sandboxed terminal running Debian in a Podman container, with the sandbox's terminal menu open](assets/screenshot-terminal-light.png)

- **New sandboxed workspace** (sidebar header, Command Center, or the workspace command that
  preselects the current project) creates a workspace in a new worktree or the project directory,
  with a [container profile](#container-profiles-and-engines), and opens it at once. Its sandbox
  starts in the background.
- Agents start from the workspace's own composer, with attachments, modes, and commands. Each one
  switches to a sandboxed copy of the provider it asked for, such as `claude-sandbox` or
  `zai-sandbox`; see [Provider profiles](#provider-profiles). Sessions, permissions, and history
  work as usual.
- The **Sandboxed** header button opens the Sandbox panel: the sandbox's configuration, its Claude
  folder and sign-in, and **Open sandboxed terminal**. The terminal button beside it opens a menu of
  a shell and your terminal profiles, run in the sandbox.
- Each sandbox gets its own Claude Code config folder and signs in with the host's current access
  token, never its refresh token; see [Claude Code sign-in](#claude-code-sign-in).
- Archiving the workspace removes its sandbox.

## Install

From a checkout (the plugin has no runtime dependencies):

```sh
paseo plugin install "$PWD"
```

From Git:

```sh
paseo plugin add git:bendavid/paseo-workspace-sandbox
```

The plugin needs Paseo 0.14.0 or later and one of the [engines](#container-profiles-and-engines)
on the daemon's machine. It has been tested on Linux.

Installing it edits daemon configuration: the first time each provider runs in a sandbox, the
plugin adds a `<provider>-sandbox` provider profile to `config.json`. The profiles stay after the
plugin is removed, so agents saved with one fail instead of resuming on the host. To uninstall,
remove the plugin, delete the `*-sandbox` profiles from `config.json`, then delete
`$PASEO_HOME/plugin-data/workspace-sandbox`.

## Container profiles and engines

A profile is a saved sandbox configuration: engine and its command, image, network, extra mounts,
and extra run arguments. A new workspace copies the profile chosen in the form, so editing or
deleting a profile never changes an existing sandbox; the Sandbox panel shows the copy. The form's
**Container** dropdown has **New profile** (prefilled from the selected one) and **Edit**, and
Settings > Sandbox lists the profiles. The profile editor shows the **Start command** the
settings produce, built by the same code that starts sandboxes. Opened from the form it shows the
chosen project's real paths, for a worktree or a sandboxed directory as chosen; from the Sandbox
panel, that sandbox's own paths and name; from Settings, a plain checkout. Placeholders such as
`<worktree>` or `<workspace-id>` stand for what creating the workspace decides. The first profile uses Podman, or Docker when only Docker is
installed, with a separate network. Profiles live in `container-profiles.json` in the plugin's data
folder.

The Sandbox panel's **Manage** section changes a workspace's own sandbox:

- **Restart** stops the container or microVM and starts the same one again. **Recreate** removes it
  and creates it from the sandbox's settings again, with the usual image check or dev container
  go-ahead, and reads the login shell environment again; anything installed in it outside its
  mounts is lost. Engines that start a fresh sandbox per launch have neither.
- **Change settings** edits the sandbox's own copy of its profile, and **Use another profile**
  replaces it with a copy of a saved one; either recreates the sandbox. The panel lists what the
  change does to what already ran: a new workspace path inside the sandbox (agents' recorded paths
  and sessions refer to the old one, so resuming them may fail), another Claude folder (earlier
  Claude agents can't resume, and Paseo may not show their history), other agents' folders no
  longer mounted, or another user owning what the sandbox writes. Moving a worktree to sandbox
  paths offers to switch the repository to relative worktree paths first.

Each of these also stops what runs with the old settings, for every engine, and the go-ahead names
it first. All of the workspace's terminals close, the sandboxed ones and those on the host such as
scripts and services, and what runs in them stops; none reopen. The workspace's agents with a live
session are resumed once the sandbox runs again: Paseo reopens their sessions, which runs the
plugin's session hook with the new settings, and interrupts a running turn. Closed agents get the
new settings when next started. When the start waits for a download or dev container go-ahead, the
agents resume after the start that succeeds.

| Engine                  | Sandbox                          | Image            | Network: Host / Separate / None                     | Tested                                  |
| ----------------------- | -------------------------------- | ---------------- | --------------------------------------------------- | --------------------------------------- |
| Podman                  | One container per workspace      | Yes              | `--network host` / `private` / `none`               | Yes                                     |
| Docker                  | One container per workspace      | Yes              | `--network host` / `bridge` / `none`                | Through podman-docker                   |
| Bubblewrap              | One namespace sandbox per launch | No               | host network / not offered / `--unshare-net`        | Yes                                     |
| microsandbox            | One microVM per workspace        | Yes              | `--net all` / `--net public` / `--no-net`           | Yes (0.7.11)                            |
| Apptainer / Singularity | One container per launch         | Yes, or a `.sif` | host network / not offered / `--net --network none` | Apptainer 1.5.4 (also as `singularity`) |

New profiles default to **Separate** where the engine has it, and otherwise to **Host**. Podman's
Separate is `--network private`, a network namespace of the container's own whether Podman runs
rootless (pasta or slirp4netns) or as root (the bridge); Docker's is `bridge`.
Bubblewrap, Apptainer, and Singularity have no separate network without root, so they offer only
Host and None.

**Host** shares the host's network, including services that listen only on its loopback. The Paseo
daemon is one: with no daemon password, anything that reaches its port can control it, including
opening terminals on the host, so a sandbox on the host network is not contained. Set a daemon
password, or use Separate or None. Separate keeps the sandbox off the host's loopback, which also
means agents in sandboxed terminals can't report terminal activity to the daemon, and local
services such as a model server on `localhost` aren't reachable.

The profile's **Command** is the engine's executable; empty means the default (`podman`, `docker`,
`bwrap`, `msb`, `apptainer`, `singularity`) on `PATH`, or `~/.microsandbox/bin/msb`. Container runtimes such as krun, gVisor,
or Kata go in **Extra run arguments** (`--runtime krun`). Extra run arguments are split into words
like a shell command, without expanding variables or `~`: quote or backslash-escape a value with
spaces, as in `--sysctl "net.ipv4.ping_group_range=1000 1000"`.

- **Podman and Docker** keep a long-lived container that launches join with `exec`. As Host user,
  Podman uses `--userns=keep-id` and Docker `--user <uid>:<gid>`; see [User](#user).
- **Bubblewrap** keeps nothing between launches: each one is a fresh sandbox with the host's `/usr`,
  `/etc`, and `/opt` read-only, its own `/proc`, `/dev`, `/tmp`, and `/run`, the sandbox's mounts,
  and a clean environment. Tools are the host's own. The home directory is a scratch folder for the
  launch unless a mount covers it. It needs unprivileged user namespaces; starting the sandbox runs
  `true` in one, so a host without them shows a start failure. Extra run arguments go to `bwrap`.
- **microsandbox** keeps a libkrun microVM per workspace and joins it with `exec`, sharing host
  folders over virtio-fs at the same paths, with `-u <uid>:<gid>` as Host user. Each launch's
  variables are passed as `-e NAME`, which keeps their values off its command line. libkrun does not
  strictly confine a guest to a shared folder's subtree, so share narrow folders.
- **Apptainer and Singularity** start a fresh container per launch, like Bubblewrap, with
  `apptainer exec --containall --cleanenv`: no automatic mounts of your home, the working
  directory, or `/tmp`, and none of the daemon's environment. The image stays read-only; add
  `--writable-tmpfs` under extra run arguments for a writable layer over it for each launch. They
  run as you and add your account to the container's
  `/etc/passwd` themselves, so there is no User setting; the home directory is a
  scratch folder for the launch unless a mount covers it. The image is a full registry reference,
  pulled with `apptainer pull` into `images/` in the plugin's data folder after you agree, with the
  registry's digests recorded beside it for the freshness check, or the absolute path of a local
  `.sif` file, used as it is. Both engines evaluate `--env`, `--env-file`, and `APPTAINERENV_*`
  values as shell words, expanding `$` and command substitutions, so the plugin passes no value
  through them: the base environment is written into a small `sh` loader, shell-quoted, and each
  launch's variables arrive on an open file descriptor that the launcher deletes before the engine
  starts. The Singularity engine uses the `singularity` command, SingularityCE's or Apptainer's
  compatible one; only the latter is tested.
- **Dev container** builds each workspace's container from the workspace's own
  `.devcontainer/devcontainer.json` or `.devcontainer.json` with the
  [devcontainer CLI](https://github.com/devcontainers/cli) (`devcontainer up`), on Docker or Podman;
  see [Dev containers](#dev-containers). The profile holds only the CLI, the **Container command**,
  and **Agent sign-ins and history**; the configuration sets the image, user, network, and
  mounts.
- **BoxLite** is not supported: version 0.10.8 fails with more than two shared folders on x86_64
  (`IrqsExhausted`), and a sandbox needs at least three.

### Dev containers

The devcontainer CLI places the workspace as dev containers do, under `/workspaces`, so
[sandbox paths](#workspace-paths) apply, including the relative worktree paths a sandboxed worktree
needs and the agents that may not start in the right folder. Before creating a container the
plugin reads the configuration with `devcontainer read-configuration`, which runs nothing, and the
start waits for your go-ahead in the Sandbox panel. The panel lists what creating it does:
`initializeCommand`, which the CLI runs on this host outside any container on every
`devcontainer up`, the image or Dockerfile and features it downloads or builds, and the mounts,
`runArgs`, privileges, capabilities, and security options that reach the host. A repository's
configuration can mount any host folder and run anything as you, so read the list for repositories
you don't trust. The go-ahead covers that start only; an existing container restarts with
`podman start` (or `docker start`), without `devcontainer up`, so `initializeCommand` and
`postStartCommand` don't run again.

The CLI's `--mount` option has no read-only form, so the plugin passes its mounts, and the
environment Claude needs, in a copy of the configuration with `--override-config`. The copy lives in
`devcontainers/<sandbox>/` in the plugin's data folder; a `.devcontainer` folder is copied whole, so
a Dockerfile, local features, and the lock file beside `devcontainer.json` resolve as they do there,
and the build context stays the workspace's. It adds the Claude folder and the agents' folders, at
their host paths as for the other engines, linked from the configuration user's home, and for a
worktree the read-only git hooks, config, and other worktrees' entries at the paths the CLI's
`--mount-git-worktree-common-dir` uses. A configuration that sets its own `workspaceFolder` or
`workspaceMount` gets no git mounts, and the panel says its hooks are writable. Docker Compose
configurations are refused. Launches join the container with `exec` as the
configuration's user (`remoteUser`) in the CLI's workspace folder. Their environment is the one
`userEnvProbe` captures, as for the other engines (see [Environment](#environment)), with the
configuration's `remoteEnv` over it, its
`${containerEnv:…}` references resolved by the CLI; a `null` entry unsets the variable, including
one the container itself sets. Paseo's and the providers' forwarded variables still win. Archiving the workspace removes
the container; the images the CLI built for it (`vsc-…`) stay in the engine's storage, as they do
when you use the CLI yourself.

## What a sandbox sees

Each sandbox mounts, at the same absolute paths unless the profile uses [sandbox paths](#workspace-paths):

| Path                                        | Access     | Why                                                   |
| ------------------------------------------- | ---------- | ----------------------------------------------------- |
| Workspace directory                         | read-write | The agent's work                                      |
| Source checkout `.git`                      | read-write | A worktree's objects and refs live there              |
| `.git/hooks`, `.git/config`                 | read-only  | Both run on the host whenever git runs there          |
| `.git/worktrees`                            | read-only  | Other worktrees look missing inside; see below        |
| `.git/worktrees/<this worktree>`            | read-write | The worktree's own HEAD, index, and logs              |
| A Claude folder                             | read-write | See [Claude Code sign-in](#claude-code-sign-in)       |
| `~/.codex`, `~/.copilot`, `~/.pi`, `~/.omp` | read-write | Credentials, and history the daemon reads on the host |

The Claude folder row depends on the profile's **Agent sign-ins and history** setting, and the
provider row applies when it is Shared; see [Claude Code sign-in](#claude-code-sign-in). The `.git` rows apply
to sandboxed worktrees. The repository's other worktrees are not mounted, so
git in the sandbox sees them as missing, and `git worktree prune` there would remove them on the
host too. Their entries stay read-only, so pruning them fails, as does `git worktree add`, and
`git worktree repair` can only change this worktree's own entry; committing and switching branches
work. A sandboxed directory shares the project directory by
design and has no `.git` handling.

### Workspace paths

The profile's **Workspace paths** setting decides where the workspace is inside the sandbox, for
every engine. **Host paths**, the default, keeps the host paths above. **Sandbox paths** puts the
workspace under the **Sandbox folder**, `/workspaces` unless you set another, as dev containers do:

- A sandboxed directory is `<folder>/<project folder name>`. Only the project is mounted, without
  its real path or the link handling, so files that hold the host path, such as a virtual
  environment, break inside.
- A worktree is placed as the devcontainer CLI's `--mount-git-worktree-common-dir` places it: the
  folders from the closest one that holds both the worktree and the repository's `.git` down to the
  worktree go under the sandbox folder, and `.git` goes where the worktree's link points from
  there. A Paseo worktree in `~/.paseo/worktrees/<id>/<name>` of a repository in `~/code/proj` is
  `/workspaces/.paseo/worktrees/<id>/<name>`, with the git directory at `/workspaces/code/proj/.git`
  and the same read-only and read-write parts as above.

Git can follow a worktree's links to the repository at other paths only when they are relative.
Creating a sandboxed worktree with sandbox paths in a repository that links worktrees by absolute
path asks first, and offers to switch it: `git config worktree.useRelativePaths true`, so the
worktree Paseo creates is relative, and `git worktree repair`, which rewrites the existing
worktrees' links. Switching needs Git 2.48 on the host, and marks the repository with
`extensions.relativeWorktrees`: Git older than 2.48 refuses the repository and all its worktrees
from then on, including Git in images, on other machines, and in tools with their own Git. Git in
the sandbox also needs 2.48 to work in such a worktree. A worktree whose links are still absolute
fails to start with sandbox paths.

A process started in the workspace or a folder in it starts at the same folder inside the sandbox;
the Sandbox panel shows the workspace's directory there. Everything else keeps its host path:
`HOME`, the Claude and provider folders, and extra mounts.

Sandbox paths may break some agents. Claude and sandboxed terminals get the workspace as their
working directory, which `sandbox-run` translates. Codex also receives the directory in its
protocol (`cwd` in `thread/start` and each `turn/start`), and ACP agents in `session/new`; those
carry the host path, which the sandbox doesn't have, so their commands fail to start there. Agents
that work see and report sandbox paths: a path in an agent's message or tool call is not one Paseo
can open on the host, and a directory an agent passes to a Paseo tool is one the host doesn't have.

### User

The profile's **User** setting applies to Podman (all three choices), Docker, and microsandbox
(Host user and Image default user); Bubblewrap, Apptainer, and Singularity always run as you.
Profiles saved before the setting run as Host user, or as Image default user if they had Run as
host user turned off.

- **Host user** (the default): commands run as your uid and gid, `HOME` is your host home path, and `USER` your user
  name. When the sandbox is created, the plugin writes an account for you into its `/etc/passwd`
  and `/etc/group`, with your name, group, home, and `/bin/sh`, replacing whatever the image had
  for that uid or name, such as the Node images' `node` account for uid 1000. Tools that read the
  account instead of `HOME`, such as OpenSSH looking for `~/.ssh`, then agree with `HOME`. Files
  written to mounts belong to you. Podman also gets `--group-add keep-groups`, which keeps your
  supplementary groups, so files you reach through a group, such as a team's project folder or a
  shared file system, stay reachable; inside, those groups show as `nogroup`. It needs the `crun`
  runtime and rules out other `--group-add` options; for another runtime, or your own groups, choose
  Image default user and pass `--userns`, `--user`, and `--group-add` under extra run arguments.
  Docker keeps only your primary group; add others with `--group-add <gid>`. microsandbox's guest
  checks permissions with your primary group only.
- **Host user, squashed** (Podman): as Host user, but the container's user namespace maps only your
  uid and gid, with `--uidmap <uid>:0:1 --gidmap <gid>:0:1`. Podman and the runtime then set up the
  mounts as you rather than as a subordinate uid. NFS needs that for mounts inside folders only you
  can enter, such as the shared Claude entries in a workspace's private Claude folder; with
  keep-id, those fail when the folder is on NFS. Nothing inside can act as root, and the image's
  files appear as yours, so the root file system is read-only. `/tmp`, `/var/tmp`, `/run`,
  `/dev/shm`, and `HOME` (unless a mount covers it) are in memory, start empty, and are emptied when
  the sandbox stops; Podman's own read-only setup would copy the image's `/run` in, which fails for
  images with files there owned by system users. Your account comes from `--passwd-entry` and
  `--group-entry`, which Podman applies only when the image has no account for your uid, so use
  images without one. An own network namespace also gets
  `--sysctl net.ipv4.ping_group_range=<gid> <gid>`, since Podman's default of `0 0` fails while
  group 0 is unmapped. Packages can't be installed in the sandbox; put the tools in the image.
- **Image default user:** commands run as the image's default user, often root, with its own home and dotfiles.
  The provider folders are still mounted at their host paths, and linked from the image user's
  home (`~/.codex` and so on) so agents find them. Files written to mounts belong to whoever that
  user maps to: you with rootless Podman's root and with microsandbox, but root with Docker's
  root, or another uid for a non-root image user. Git is told to accept repositories owned by
  others (`safe.directory`), since it otherwise refuses them.

As Host user, only the explicit mounts exist under `HOME`. A container engine creates it owned
by root as the parent of the provider directories, so it is not writable: tools that write
elsewhere in `~`, such as npm's cache, `~/.cache`, or `~/.config`, fail until you add those
directories, or `~` itself, under extra mounts.

Extra mounts are host paths, one per line or comma separated, with `:ro` for read-only. They may
contain the mounts above: mounts are applied parents first, so `~:ro` gives a read-only home around
a read-write workspace. At a path the plugin already mounts, the plugin's access wins, so the
workspace stays writable and git hooks and config stay read-only. Two extra mounts of one path are
read-only if either is.

### Image

Engines other than Bubblewrap run an image. Podman, Docker, and microsandbox profiles may name it
by a short name such as `node:22`, which creating a workspace resolves to a full reference, stored
in the sandbox's copy of its profile: the download confirmation and the freshness check then name
exactly what is fetched, whichever engine runs it. Profiles keep what you typed, so each new
workspace resolves it again; the Start command box shows what it resolves to now. The rules:

- Docker and microsandbox put a short name on Docker Hub, as Docker does: `node:22` is
  `docker.io/library/node:22`, `acme/agents` is `docker.io/acme/agents`.
- Podman follows its own order: a local image of that name (`localhost/agents` for one you built),
  then the aliases in `registries.conf`, then its search registry when there is only one. Where
  several registries could serve the name, Podman would ask, and creating the workspace fails with
  that message instead; give the full reference then.
- Apptainer and Singularity take a full reference or the absolute path of a `.sif` file.

Sandboxes are created from the current version of their image, and nothing downloads an image
without your go-ahead. Every run and create passes `--pull never`, and the plugin pulls only after
you agree to that exact reference.

Whenever the plugin is about to create the container or microVM (retries included), it compares
the local copy with the registry:

- It asks the registry for the tag's current digest with a `HEAD` request, answering the
  registry's anonymous token challenge. Docker and Podman record that index digest, so this
  settles it. microsandbox records this platform's manifest digest, so when the index digest does
  not match, the plugin reads the index once to find this platform's entry. A `@sha256:` reference
  needs no request.
- A missing or outdated image waits for your go-ahead. In the form, Create asks first: **Create
  workspace and download `<image>`** (or **update**), for an outdated image **Create workspace with
  the local image**, or Cancel, which creates and downloads nothing. When a sandbox is recreated
  later, its start fails without downloading, and the Sandbox panel offers **Download** or
  **Update `<image>`**, and **Use the local image** for an outdated one. Each answer covers that
  one start and is never stored, so retries, daemon restarts, and agent launches never download
  and a later recreation asks again.
- When the registry can't be reached or needs credentials, a local image is used as it is, as is a
  `localhost/` image or one built locally.

Restarting an existing container or microVM, such as after a reboot, checks and downloads
nothing.

The first profile's image, `docker.io/library/node:22-bookworm-slim`, has no agent CLIs. Build one that installs them, or mount them from the host under extra mounts:

```dockerfile
FROM docker.io/library/node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && npm install -g @anthropic-ai/claude-code @openai/codex
```

A mounted CLI must be on the `PATH` the sandbox's login shell builds, or add its directory with
`--env-merge PATH=/its/dir:${PATH}` under extra run arguments (Podman only; Docker's `-e` does not
expand `${PATH}`).

### Environment

A sandboxed terminal runs the sandbox's interactive login shell: `bash -il`, or `sh -il` when the
image has no bash. Agents and terminal profiles start without a shell, so the first launch in each
sandbox captures the environment that shell builds and later ones reuse it. Starting each through
the shell would be slower, and anything the dotfiles print would reach the agent's protocol stream.

- The profile's **Read the login shell environment** setting, on by default, turns this off:
  agents and terminal profiles then get only the sandbox's own environment and the forwarded
  variables. A dev container follows its configuration's `userEnvProbe` instead: `none`,
  `loginShell` (`bash -l`), `interactiveShell` (`bash -i`), or `loginInteractiveShell`, the default.
- The capture lives in `workspaces/<id>.env`, readable only by you, because dotfiles can export
  secrets. A recreated container, or another way of capturing, captures again. Delete the file to
  pick up changed dotfiles.
- Variables `sandbox-run` forwards for each launch (`PASEO_*`, provider, and locale variables)
  override captured ones.
- As Host user, squashed or not, your dotfiles only take part when an extra mount covers them, such as
  `~:ro`; otherwise the image user's own dotfiles do.

## Claude Code sign-in

The profile's **Agent sign-ins and history** setting decides how the agents' own folders reach the
sandbox, for every engine:

| Setting            | Claude                                                      | `~/.codex`, `~/.copilot`, `~/.pi`, `~/.omp` |
| ------------------ | ----------------------------------------------------------- | ------------------------------------------- |
| Isolated (default) | A private folder per workspace, signed in with a token copy | Not mounted                                 |
| Shared             | Your host folder, read-write, as `CLAUDE_CONFIG_DIR`        | Read-write at their host paths              |
| Off                | Nothing of the plugin's                                     | Not mounted                                 |

Profiles saved before the setting are Isolated, or Off if they had sharing turned off. Their
sandboxes keep the Claude folder they started with: one whose own mounts made your host folder
writable keeps sharing it, as Shared. The other agents have no isolated form yet, so Isolated
doesn't mount their folders: they start signed out, and Paseo may not show their history. Use
Shared for them.

**Off:** no Claude folder, token copy, or `apiKeyHelper`, no shared entries or plugins, no agent
folders or links to them, and the session hook sets no `CLAUDE_CONFIG_DIR`. Agents start signed out
unless the image, an extra mount, or a forwarded variable such as `ANTHROPIC_API_KEY` provides
credentials, and they keep their sessions inside the sandbox, where Paseo may not find them to show
history or resume.

**Shared:** your Claude folder is mounted read-write at its host path and set as
`CLAUDE_CONFIG_DIR`, which keeps `.claude.json` inside it rather than in your home folder. Sandboxed
agents use your login, settings, skills, and transcripts, and can change all of them, including
`.credentials.json` with its refresh token: a refresh in a sandbox rotates the token in the shared
file, which a Claude session running on the host at the same time may not pick up. The other
agents' folders are mounted read-write and linked from the image user's home when it isn't yours.
There is no private folder or helper.

**Isolated:** each new sandbox gets its own Claude config folder, `homes/<workspace id>/claude` in the plugin's
data folder, mounted at that path and set as `CLAUDE_CONFIG_DIR`. Transcripts, prompt history, and
file history stay in it, so agents can't read or change another workspace's sessions. The session
hook passes the same `CLAUDE_CONFIG_DIR` to the daemon, which reads transcripts there. The folder
stays after the workspace is archived, so its agents' history stays readable. The host login is
refreshed while some sandbox is Isolated.

- From your host folder, `CLAUDE.md`, `agents/`, `commands/`, `skills/`, and `output-styles/` are
  mounted read-only, and `plugins/` is the read-only `CLAUDE_CODE_PLUGIN_SEED_DIR`.
- `settings.json` is your host's, rewritten whenever the plugin reconciles, with `apiKeyHelper`
  added. `.claude.json` is copied once without its `projects` map.
- An extra mount that shows your host folder, such as `~:ro`, stays: the sandbox can read the host
  folder, including `.credentials.json`, but Claude Code uses the private folder. Anything that
  used the refresh token in there would sign the host out.

### Sign-in

A sandbox never gets your host's refresh token. Each refresh issues a new refresh token and the old
one stops working, so a sandbox that refreshed a copy would sign out the host and every other
holder. The credentials file can't be shared another way: Claude Code saves it by rename, does not
follow a symlink for it, and always keeps it in the config folder.

Instead, sandboxes sign in with your host's current access token:

1. The plugin copies the access token alone to `auth/claude-access-token` (mode `600`), and its
   `apiKeyHelper`, `auth/claude-api-key-helper`, prints it. Both are mounted read-only through the
   `auth/` folder, since a file mount would keep the replaced file. Claude Code re-runs the helper
   every five minutes and after a 401, so long sessions follow your host's refreshes.
2. The plugin re-reads `.credentials.json` once a minute, at every sandboxed agent launch, and after
   its own refreshes.
3. About four minutes before the token expires, the plugin runs `claude auth status` on the host.
   It is the cheapest command that refreshes: Claude Code refreshes a token with less than about
   five minutes left when it starts, and `auth status` sends no model request. It goes through
   Claude Code's own lock, so it can't collide with your sessions.

`/login` on the host revokes nothing; sandboxes switch to the new token at the next read. `/logout`
revokes the refresh token and every access token issued with it, so sandboxed agents fail at once,
and the header button reads **Sign in on host** within a minute.

A `CLAUDE_CODE_OAUTH_TOKEN` that reaches the sandbox, from the Claude provider's env or the
daemon's, takes over: the helper prints it, because `apiKeyHelper` ranks above that variable.
`ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` rank above the helper, so providers such as Z.AI keep
their own credentials. On macOS, Claude Code keeps its login in the Keychain, which the plugin does
not read; set `CLAUDE_CODE_OAUTH_TOKEN` there.

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
- `state.json` records which profiles the plugin owns. An existing profile with the same ID that the
  plugin did not create is refused.

OpenCode is refused: it runs one server for every session on the daemon. Plugin-registered
providers are refused because a profile cannot extend them. The daemon checks the requested
provider before plugin hooks run, so an agent started in a sandboxed workspace needs its provider
available on the host too.

Paseo runs some provider commands without an agent session: model discovery, version checks, and
history for agents whose sandbox is gone. `sandbox-run` runs these with the host's CLI, so images
should carry the same CLI versions as the host. Agent sessions never fall back to the host.

## How it works

The plugin alone starts, recreates, and waits for sandboxes; `sandbox-run` only joins a running
one. One start per workspace runs at a time, and everything that needs the sandbox joins it:

- Creating a workspace starts the first one, which also decides the Claude folder.
- The `agent.session_open` hook waits up to 25 of its 30 seconds before every agent launch: the
  daemon needs the session's `CLAUDE_CONFIG_DIR` before the session starts.
- Opening a sandboxed terminal waits up to 45 seconds of the RPC's 60.
- Starting a stopped container, such as after a reboot, takes a second or two. Only an image
  download you agreed to runs longer; launches are refused with "still downloading" while it goes
  on.

A failed start turns the header button into **Sandbox failed**, with the engine's last error line as
its tooltip, and the Sandbox panel shows the error. Agent launches and sandboxed terminals fail with
"The sandbox did not start: …". Each launch tries again, and a sandbox that then runs clears the
failure. The daemon log has the engine's full output.

The plugin keeps `bin/sandbox-run`, `state.json`, `container-profiles.json`, a `workspaces/<id>.sh`
spec and its captured `.env` per sandbox, the private Claude folders in `homes/`, sandboxed
directories' links in `links/` and `link-mounts/`, and the token and helper in `auth/`, in
`$PASEO_HOME/plugin-data/workspace-sandbox`. The plugin cannot read its
runtime ID, so the folder uses the manifest ID: install it once per daemon. Removing the plugin
leaves the folder, and the provider profiles still point at `sandbox-run`, so sandboxed agents keep
failing closed.

| Launch                       | Sandbox from                                              | Without a sandbox            |
| ---------------------------- | --------------------------------------------------------- | ---------------------------- |
| Agent session                | `PASEO_SANDBOX_WORKSPACE_ID`, set by `agent.session_open` | Fails (`PASEO_AGENT_ID` set) |
| History of an archived agent | `PASEO_SANDBOX_ROUTE=host`, set by `agent.session_open`   | Host CLI                     |
| Model or version check       | none                                                      | Host CLI                     |
| Sandboxed terminal           | `PASEO_WORKSPACE_ID`, set on every terminal               | Fails                        |

The spec holds the engine's part of `sandbox-run`: a few shell functions (ready, ID, run a command
inside, signal), documented at the top of `server/wrapper.ts`. Killing a long-lived engine's `exec`
client does not stop the process inside, so the wrapper records the inner pid and forwards `TERM`,
`INT`, and `HUP`; Bubblewrap's launch replaces the wrapper and dies with it.

### Sandboxed directories

**Sandboxed directory** is the sandboxed counterpart of New workspace's "Local": a workspace on the
project directory, titled `<project> (sandboxed)` unless you name it. Projects that are not Git
repositories always get one. It shares the project directory with the project's other workspaces by
design, so its sandbox does not protect `.git` the way a sandboxed worktree's does.

The workspace lives at its own link to the project directory, `links/<workspace id>` in the
plugin's data folder, and Paseo shows that path as its directory. The plugin's hooks only see an
agent's directory when it is created, and commit-message and similar helpers only get a directory,
so the link is what tells the sandboxed workspace's agents and helpers apart from the project's
other workspaces, and two sandboxed directories on one project from each other. Agents of the other
workspaces run in the real path and keep their own provider.

Inside the sandbox the project is mounted at the link path, where the agent runs, and at its real
path, so files that contain the real path keep working: virtual environments, absolute symlinks,
build caches. An extra mount that covers the plugin's data folder, such as `~:ro`, would show the
link there as a symlink, and engines follow a symlink at a mount's destination; each sandbox
mounts its own `link-mounts/<workspace id>` over `links/`, so the link path stays a plain mount
point. Archiving the workspace removes the link.

Sandboxed directories created before links use the project directory itself. There, an agent of
an unsandboxed workspace in that directory still gets the sandboxed provider at creation, and the
session hook, which sees the workspace, runs it on the host, labelled as sandboxed (for example
"Claude Code (sandboxed)"), with Paseo tools disabled and, for ACP providers, Paseo's terminal and
file access off. When the daemon passes no workspace (agents saved without one, or a session
resumed through the SDK's `resumeAgent`), the directory decides and the agent stays sandboxed. An
agent whose workspace had a sandbox that is gone shows its history but does not run again; the
plugin remembers removed sandboxes in `state.json` for this.

## Not sandboxed

The plugin covers what the plugin API reaches. Everything else still runs on the host:

- Terminals Paseo opens itself, including its new terminal and terminal profiles, `paseo.json`
  scripts and services, and worktree setup and teardown. For an untrusted repository, setup alone
  defeats the sandbox.
- Git that the daemon runs in the workspace. The agent can write the workspace's `.git` file and
  point it at a directory whose config runs commands (`core.fsmonitor`) the next time the daemon
  runs git there.
- OpenCode and plugin-registered providers: creating one in a sandboxed workspace fails.
- State for custom ACP agents outside the directories above, until added under extra mounts.
- Title, branch, commit message, and pull request text generation, which use the
  `metadataGeneration` providers. Paseo runs these helpers for a directory, with a host provider,
  so in a sandboxed workspace the plugin refuses them rather than run them on the host with its
  content, and Paseo falls back to generic text such as "Update files".

Agents saved with a host provider cannot reopen in a sandboxed workspace, and sandboxed profiles
cannot run outside one; both fail with an explanation.

## What Paseo would need for more

- A terminal creation hook, so Paseo's own terminals, scripts, and setup could run in the sandbox.
- A provider launch hook, so sandboxing a provider would not need a visible derived profile, and the
  requested provider would not have to be available on the host.
- `agent.create` hooks that receive the agent's workspace, so routing would not depend on
  directories, and sandboxed directories would not need links.
- `agent.session_open` telling internal helpers apart, with the workspace they work for, so the
  plugin could run a sandboxed workspace's commit-message and similar helpers in its sandbox.
- `before("workspace.create")` with the workspace ID the daemon allocates, so Paseo's own New
  workspace form could create sandboxed workspaces.
- A slot in the New workspace form, or access to the app's composer and combobox, instead of a
  rebuilt form that cannot start agents.
- A way to push state to the app and to focus a terminal; start failures are polled, and new
  sandboxed terminals open as background tabs.
- Workspace labels in the plugin SDK, to mark sandboxed workspaces in the sidebar.
- A Paseo session in the server entry. The plugin finishes starting on the first RPC or hook, which
  the client entry triggers when an app connects.

## Develop

```sh
npm install
npm run typecheck
npm test
npm run test:e2e       # real sandboxes with each installed engine; never downloads images
SANDBOX_E2E_ALLOW_DOWNLOADS=1 npm run test:e2e   # also pulls busybox with Apptainer
npm run format
paseo plugin install "$PWD"
paseo plugin reload workspace-sandbox   # after changes
```

The unit tests use temporary folders and a fake `claude`; they never touch your own login or
sandboxes. The end-to-end tests run throwaway sandboxes with Bubblewrap, and with Podman and
microsandbox when `docker.io/library/node:22-bookworm-slim` is already present; Apptainer and
Singularity use a `.sif` built from Podman's copy. An engine without its image is skipped.

## License

MIT. See [LICENSE](LICENSE).
