Workspace Sandbox runs a workspace's agents and terminals inside a sandbox that sees only the folders you choose: the workspace itself, your agents' own state, and any extra folders you add. A sandbox is a Podman or Docker container, a microsandbox microVM, or a Bubblewrap sandbox built from your own system.

## How it works

Press **New sandboxed workspace** in the sidebar header or the Command Center, pick a project, a new worktree or the project directory, a container profile and a starting branch, and press Create. The workspace opens at once and its sandbox starts in the background.

Agents you start from the workspace's composer run in the sandbox with your usual attachments, modes and commands. The plugin switches each one to a sandboxed copy of the provider you picked, such as `claude-sandbox`, which runs the agent's CLI inside the sandbox. Sessions, permissions and history work as usual. The **Sandboxed** button in the workspace header opens the Sandbox panel, and the terminal button beside it opens a shell or one of your terminal profiles inside the sandbox. Archiving the workspace removes its sandbox.

## Setup

You need one of these on the daemon's machine:

- **Podman** or **Docker**: one long-lived container per workspace.
- **microsandbox** (`msb`): one microVM per workspace.
- **Bubblewrap** (`bwrap`): a fresh sandbox per launch with your system's `/usr` and `/etc` read-only, so it uses the tools installed on the host. It needs unprivileged user namespaces.
- **Apptainer** or **Singularity**: a fresh container per launch from an image, running as you. The image is a registry reference the plugin downloads after you agree, or a local `.sif` file.

Container profiles, in the form and in Settings > Sandbox, hold the engine, image, network (host, separate or none), extra folders to mount (read-write or read-only), extra engine arguments, and whether to run as you. Running as you, the default, uses your user and group IDs and your home folder path, and adds an account for you inside the sandbox, so files the agents write belong to you; otherwise the image's own default user and home are used. The first profile uses Podman, or Docker when only Docker is installed, with the `docker.io/library/node:22-bookworm-slim` image. Images are full references that name their registry. That image has no agent CLIs: use an image that installs them, or mount them from the host.

Sandboxes are created from the current version of their image. Before the plugin creates a sandbox, it compares the local image with the image's registry by asking the registry for the tag's current digest, a metadata request that downloads no image. It never downloads an image on its own: when the image is missing or older than the registry's, Create asks first, naming the full image reference. For an outdated image you can also continue with the local copy, and Cancel creates and downloads nothing. If a sandbox has to be recreated later and its image is missing or outdated, its start fails and the Sandbox panel offers the same choices. The answer covers that one start and is not remembered. A local image is used as it is when the registry can't be reached or needs credentials. Restarting an existing sandbox, such as after a reboot, checks and downloads nothing.

The plugin needs Paseo 0.13.0 or later. It has been tested on Linux.

## Claude Code sign-in

Each sandbox gets its own Claude Code config folder, so its agents can't read or change another workspace's transcripts. It starts with your `CLAUDE.md`, agents, commands, skills, output styles and plugins, read-only, and your `settings.json`.

Sandboxes never receive your refresh token, which would sign you out on the host when a sandbox used it. The plugin copies only your current access token into its data folder, readable only by you, and Claude Code in the sandbox reads it through `apiKeyHelper`. Shortly before the token expires, the plugin runs `claude auth status` on the host, which refreshes it through Claude Code's own login. A `/logout` on the host stops sandboxed Claude agents, and the header button asks you to sign in again. If a profile already mounts your Claude folder read-write, the sandbox uses it directly. On macOS Claude Code keeps its login in the Keychain, which the plugin does not read; set `CLAUDE_CODE_OAUTH_TOKEN` instead.

## What it changes

- The first time each provider runs in a sandbox, the plugin adds a `<provider>-sandbox` provider profile to the daemon's `config.json`. Profiles stay after the plugin is removed, and sandboxed agents fail rather than resume on the host until you delete them.
- Its state, the private Claude folders, the token copy and the `sandbox-run` launcher live in `plugin-data/workspace-sandbox` in your Paseo home.
- While deciding whether a sandbox can use your Claude folder, it briefly creates and deletes a file there.

Agents send prompts and tool results to their providers as usual; the sandbox limits what they can reach on your machine, not what they send.

## Limits

The plugin covers what Paseo's plugin API reaches. These still run on the host:

- Paseo's own terminals and terminal profiles, `paseo.json` scripts and services, and worktree setup commands. For an untrusted repository, setup alone defeats the sandbox.
- Git commands the daemon runs in the workspace. Title, branch, commit message and pull request text generation run on the host for other workspaces; in a sandboxed workspace the plugin refuses them and Paseo uses generic text.
- OpenCode and providers registered by plugins, which the plugin refuses to start in a sandboxed workspace.

Model lists and version checks for sandboxed providers come from the host's CLI, so images should carry the same agent versions as the host. A sandboxed directory shares the project directory with the project's other workspaces, so its sandbox doesn't protect the project's `.git`. It appears in Paseo at its own link to the project directory, inside the plugin's data folder.
