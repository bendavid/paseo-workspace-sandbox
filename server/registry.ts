import { arch } from "node:os";

/**
 * Whether the local copy of an image is the registry's current one for its tag.
 * - `missing`: not on this machine.
 * - `outdated`: the registry's tag points at a different image.
 * - `unverified`: on this machine, but the registry could not be asked (offline, credentials
 *   needed, or a local-only `localhost/` image); the local copy is used.
 */
export type ImageState = "current" | "missing" | "outdated" | "unverified";

interface ImageReference {
  /** Base URL of the registry's API. */
  registry: string;
  repository: string;
  tag: string;
  digest?: string;
}

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * A full reference, as profiles require: `host/repository[:tag][@digest]`. Podman's local-only
 * `localhost/` namespace has no registry. A local registry on a loopback port speaks plain HTTP.
 */
export function parseImageReference(image: string): ImageReference | null {
  const slash = image.indexOf("/");
  const host = image.slice(0, slash);
  if (slash <= 0 || host === "localhost") return null;
  let rest = image.slice(slash + 1);
  let digest: string | undefined;
  const at = rest.indexOf("@");
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  const colon = rest.lastIndexOf(":");
  const tag = colon > rest.lastIndexOf("/") ? rest.slice(colon + 1) : "latest";
  const repository = colon > rest.lastIndexOf("/") ? rest.slice(0, colon) : rest;
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host);
  const apiHost = host === "docker.io" ? "registry-1.docker.io" : host;
  return {
    registry: `${loopback ? "http" : "https"}://${apiHost}`,
    repository,
    tag,
    ...(digest ? { digest } : {}),
  };
}

/** Parses `Bearer realm="…",service="…"` into its parameters. */
function challengeParameters(header: string): Record<string, string> {
  return Object.fromEntries(
    [...header.matchAll(/(\w+)="([^"]*)"/g)].map((match) => [match[1], match[2]]),
  );
}

/**
 * Requests a manifest, answering a registry's anonymous token challenge. Null when the registry
 * needs credentials or does not answer.
 */
async function manifestRequest(
  reference: ImageReference,
  method: "HEAD" | "GET",
): Promise<Response | null> {
  const url = `${reference.registry}/v2/${reference.repository}/manifests/${reference.tag}`;
  const request = (authorization?: string) =>
    fetch(url, {
      method,
      headers: { accept: MANIFEST_TYPES, ...(authorization ? { authorization } : {}) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  let response = await request();
  if (response.status === 401) {
    const challenge = response.headers.get("www-authenticate") ?? "";
    if (!/^bearer\s/i.test(challenge)) return null;
    const { realm, service } = challengeParameters(challenge);
    if (!realm) return null;
    const tokenUrl = new URL(realm);
    if (service) tokenUrl.searchParams.set("service", service);
    tokenUrl.searchParams.set("scope", `repository:${reference.repository}:pull`);
    const tokenResponse = await fetch(tokenUrl, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!tokenResponse.ok) return null;
    const body = (await tokenResponse.json()) as { token?: string; access_token?: string };
    const token = body.token ?? body.access_token;
    if (!token) return null;
    response = await request(`Bearer ${token}`);
  }
  return response.ok ? response : null;
}

const PLATFORM_ARCHITECTURES: Record<string, string> = { x64: "amd64", arm64: "arm64", arm: "arm" };

/** The digest of this machine's entry in a multi-platform index. */
async function platformDigest(reference: ImageReference): Promise<string | null> {
  const response = await manifestRequest(reference, "GET");
  if (!response) return null;
  const manifest = (await response.json()) as {
    manifests?: Array<{ digest: string; platform?: { os?: string; architecture?: string } }>;
  };
  const architecture = PLATFORM_ARCHITECTURES[arch()] ?? arch();
  return (
    manifest.manifests?.find(
      (entry) => entry.platform?.os === "linux" && entry.platform.architecture === architecture,
    )?.digest ?? null
  );
}

/**
 * Compares the local copy's digests with the registry's for the tag. Engines record the
 * multi-platform index digest (Docker, Podman), this platform's manifest digest (Podman,
 * microsandbox), or both. A HEAD request answers the first without counting as a pull; only when
 * it does not match is the index read for this platform's entry.
 */
export async function checkImage(
  image: string,
  localDigests: string[] | null,
): Promise<ImageState> {
  if (!localDigests) return "missing";
  // Built locally rather than pulled: nothing to compare, and nothing to replace it with.
  if (localDigests.length === 0) return "unverified";
  const reference = parseImageReference(image);
  if (!reference) return "unverified";
  if (reference.digest) return localDigests.includes(reference.digest) ? "current" : "outdated";
  try {
    const head = await manifestRequest(reference, "HEAD");
    const digest = head?.headers.get("docker-content-digest");
    if (!digest) return "unverified";
    if (localDigests.includes(digest)) return "current";
    const isIndex = /index|manifest\.list/.test(head?.headers.get("content-type") ?? "");
    if (!isIndex) return "outdated";
    const platform = await platformDigest(reference);
    if (!platform) return "unverified";
    return localDigests.includes(platform) ? "current" : "outdated";
  } catch (error) {
    console.error(`Could not check ${image} with its registry`, error);
    return "unverified";
  }
}
