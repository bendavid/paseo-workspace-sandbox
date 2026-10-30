import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { arch } from "node:os";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { checkImage, parseImageReference } from "../server/registry";

const INDEX_DIGEST = "sha256:index-current";
const PLATFORM_DIGEST = "sha256:platform-current";
const HERE = arch() === "arm64" ? "arm64" : "amd64";
const ELSEWHERE = HERE === "arm64" ? "amd64" : "arm64";

let server: Server;
let host: string;
const requests: string[] = [];

beforeAll(async () => {
  // A registry speaking the Distribution API with anonymous bearer tokens, as Docker Hub does.
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://registry");
    requests.push(`${request.method} ${url.pathname}`);
    if (url.pathname === "/token") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ token: `token-for-${url.searchParams.get("scope")}` }));
      return;
    }
    if (url.pathname.startsWith("/v2/private/")) {
      response.statusCode = 401;
      response.setHeader("www-authenticate", 'Basic realm="registry"');
      response.end();
      return;
    }
    if (request.headers.authorization !== "Bearer token-for-repository:team/app:pull") {
      response.statusCode = 401;
      response.setHeader(
        "www-authenticate",
        `Bearer realm="http://${host}/token",service="test-registry"`,
      );
      response.end();
      return;
    }
    response.setHeader("content-type", "application/vnd.oci.image.index.v1+json");
    response.setHeader("docker-content-digest", INDEX_DIGEST);
    response.end(
      request.method === "HEAD"
        ? undefined
        : JSON.stringify({
            manifests: [
              {
                digest: "sha256:other-platform",
                platform: { os: "linux", architecture: ELSEWHERE },
              },
              { digest: PLATFORM_DIGEST, platform: { os: "linux", architecture: HERE } },
            ],
          }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  requests.length = 0;
});

test("parses full references", () => {
  expect(parseImageReference("docker.io/library/node:22-bookworm-slim")).toEqual({
    registry: "https://registry-1.docker.io",
    repository: "library/node",
    tag: "22-bookworm-slim",
  });
  expect(parseImageReference("registry.local:5000/team/app")).toEqual({
    registry: "https://registry.local:5000",
    repository: "team/app",
    tag: "latest",
  });
  expect(parseImageReference("ghcr.io/acme/agents:1.2@sha256:abc")).toMatchObject({
    repository: "acme/agents",
    tag: "1.2",
    digest: "sha256:abc",
  });
  expect(parseImageReference("localhost:5000/app:1")?.registry).toBe("http://localhost:5000");
  expect(parseImageReference("localhost/tools")).toBeNull();
});

test("an image recorded by its index digest is current after a HEAD request alone", async () => {
  expect(await checkImage(`${host}/team/app:1`, [INDEX_DIGEST])).toBe("current");
  expect(requests).toEqual([
    "HEAD /v2/team/app/manifests/1",
    "GET /token",
    "HEAD /v2/team/app/manifests/1",
  ]);
});

test("an image recorded by this platform's digest is current", async () => {
  expect(await checkImage(`${host}/team/app:1`, [PLATFORM_DIGEST])).toBe("current");
  expect(requests).toContain("GET /v2/team/app/manifests/1");
});

test("an image whose tag moved on is outdated", async () => {
  expect(await checkImage(`${host}/team/app:1`, ["sha256:old-index", "sha256:old-platform"])).toBe(
    "outdated",
  );
});

test("a missing image needs no registry", async () => {
  expect(await checkImage(`${host}/team/app:1`, null)).toBe("missing");
  expect(requests).toEqual([]);
});

test("a local copy is used when the registry can't confirm it", async () => {
  // Credentials required, registry unreachable, local-only, built locally.
  expect(await checkImage(`${host}/private/app:1`, ["sha256:x"])).toBe("unverified");
  expect(await checkImage("127.0.0.1:1/team/app:1", ["sha256:x"])).toBe("unverified");
  expect(await checkImage("localhost/tools", ["sha256:x"])).toBe("unverified");
  expect(await checkImage(`${host}/team/app:1`, [])).toBe("unverified");
});

test("a pinned digest is compared without asking the registry", async () => {
  expect(await checkImage(`${host}/team/app@sha256:pinned`, ["sha256:pinned"])).toBe("current");
  expect(await checkImage(`${host}/team/app@sha256:pinned`, ["sha256:other"])).toBe("outdated");
  expect(requests).toEqual([]);
});
