import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isFullImageReference, type Engine } from "../shared/rpc";
import { runCli } from "./container";

/**
 * A short image name, such as `node:22`, resolved to the full reference an engine would use, so
 * the download consent and the freshness check name the registry. Resolved when a workspace is
 * created, on the machine that runs it; profiles keep what was typed.
 */

interface ShortName {
  /** Repository path without registry, such as `node` or `acme/agents`. */
  repository: string;
  /** `:tag` or `@digest`, as given. */
  suffix: string;
}

function splitShortName(image: string): ShortName {
  const at = image.indexOf("@");
  const base = at === -1 ? image : image.slice(0, at);
  const digest = at === -1 ? "" : image.slice(at);
  const colon = base.lastIndexOf(":");
  const hasTag = colon > base.lastIndexOf("/");
  return {
    repository: hasTag ? base.slice(0, colon) : base,
    suffix: (hasTag ? base.slice(colon) : "") + digest,
  };
}

/** On a registry, as Docker places a short name there: `node` is `library/node` on Docker Hub. */
function onRegistry(registry: string, { repository, suffix }: ShortName): string {
  const path =
    registry === "docker.io" && !repository.includes("/") ? `library/${repository}` : repository;
  return `${registry}/${path}${suffix}`;
}

/** Docker's rule, which never varies: a short name is on Docker Hub. */
export function dockerReference(image: string): string {
  return isFullImageReference(image) ? image : onRegistry("docker.io", splitShortName(image));
}

/** Where Podman reads registries.conf and its drop-ins, the user's after the system's. */
export function podmanConfigFiles(home = homedir()): Promise<string[]> {
  const dropIns = async (directory: string) =>
    (await readdir(directory).catch(() => []))
      .filter((name) => name.endsWith(".conf"))
      .sort()
      .map((name) => path.join(directory, name));
  return Promise.all([
    "/etc/containers/registries.conf",
    dropIns("/etc/containers/registries.conf.d"),
    path.join(home, ".config/containers/registries.conf"),
    dropIns(path.join(home, ".config/containers/registries.conf.d")),
    path.join(home, ".cache/containers/short-name-aliases.conf"),
  ]).then((entries) => entries.flat());
}

interface PodmanConfig {
  aliases: Map<string, string>;
  searchRegistries: string[] | null;
}

/** The two settings that resolve short names, read from TOML well enough for them. */
async function readPodmanConfig(files: string[]): Promise<PodmanConfig> {
  const aliases = new Map<string, string>();
  let searchRegistries: string[] | null = null;
  for (const file of files) {
    const text = await readFile(file, "utf8").catch(() => null);
    if (text === null) continue;
    let section = "";
    for (const raw of text.split("\n")) {
      const line = raw.replace(/#.*$/, "").trim();
      const header = /^\[([^\]]+)\]$/.exec(line);
      if (header) {
        section = header[1]!.trim();
        continue;
      }
      const alias = /^"([^"]+)"\s*=\s*"([^"]+)"$/.exec(line);
      if (section === "aliases" && alias) aliases.set(alias[1]!, alias[2]!);
      const search = /^unqualified-search-registries\s*=\s*\[(.*)\]$/.exec(line);
      if (section === "" && search) {
        searchRegistries = [...search[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
      }
    }
  }
  return { aliases, searchRegistries };
}

export interface PodmanResolver {
  /** The full names of a local image matching the short name, or null when there is none. */
  localNames(image: string): Promise<string[] | null>;
  configFiles(): Promise<string[]>;
}

/**
 * Podman's order for a short name: a local image, then its alias table, then its search
 * registries. Podman prompts when several registries could serve the name, and fails without a
 * terminal; so does this, rather than pick one.
 */
export async function podmanReference(image: string, resolver: PodmanResolver): Promise<string> {
  if (isFullImageReference(image)) return image;
  const short = splitShortName(image);
  const wanted =
    short.suffix.startsWith(":") || short.suffix === "" ? short.suffix || ":latest" : null;
  if (wanted) {
    const names = (await resolver.localNames(image)) ?? [];
    const local = names.find(
      (name) =>
        name.endsWith(`/${short.repository}${wanted}`) ||
        name.endsWith(`/library/${short.repository}${wanted}`),
    );
    if (local) return local;
  }
  const config = await readPodmanConfig(await resolver.configFiles());
  const alias = config.aliases.get(short.repository);
  if (alias) return `${alias}${short.suffix}`;
  const registries = config.searchRegistries ?? [];
  if (registries.length === 1) return onRegistry(registries[0]!, short);
  throw new Error(
    registries.length === 0
      ? `Podman has no registry to look up "${image}" in; give its full reference, such as ${onRegistry("docker.io", short)}`
      : `Podman could find "${image}" on ${registries.join(", ")}; give its full reference, such as ${onRegistry(registries[0]!, short)}`,
  );
}

/** Podman's own answers: its local images, through `cli`, and its configuration files. */
export function podmanResolver(cli: string | null): PodmanResolver {
  return {
    localNames: async (name) => {
      if (!cli) return null;
      const output = await runCli(cli, [
        "image",
        "inspect",
        "--format",
        "{{json .RepoTags}}",
        name,
      ]).catch(() => null);
      return output ? ((JSON.parse(output.trim() || "null") as string[] | null) ?? null) : null;
    },
    configFiles: () => podmanConfigFiles(),
  };
}

/** The full reference an engine would use for an image; others are returned as they are. */
export async function resolveImageReference(
  engine: Engine,
  image: string,
  podman: PodmanResolver,
): Promise<string> {
  const trimmed = image.trim();
  if (engine === "docker" || engine === "microsandbox") return dockerReference(trimmed);
  if (engine === "podman") return podmanReference(trimmed, podman);
  return trimmed;
}
