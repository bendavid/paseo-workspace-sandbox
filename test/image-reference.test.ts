import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  dockerReference,
  podmanReference,
  resolveImageReference,
  type PodmanResolver,
} from "../server/image-reference";
import { isFullImageReference, isValidImage } from "../shared/rpc";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A Podman with these local images and this registries.conf. */
async function podman(local: string[], config: string): Promise<PodmanResolver> {
  const root = await mkdtemp(path.join(tmpdir(), "sandbox-registries-"));
  roots.push(root);
  const file = path.join(root, "registries.conf");
  await writeFile(file, config);
  return {
    localNames: async () => (local.length > 0 ? local : null),
    configFiles: async () => [file],
  };
}

test("accepts image references that name their registry", () => {
  for (const image of [
    "docker.io/library/node:22-bookworm-slim",
    "ghcr.io/acme/agents:1.2",
    "localhost/tools",
    "registry.local:5000/team/image@sha256:abc",
  ]) {
    expect(isFullImageReference(image), image).toBe(true);
  }
});

test("rejects short names, which engines resolve differently", () => {
  for (const image of ["node:22", "library/node", "acme/agents:1.2", "", "docker.io/ node"]) {
    expect(isFullImageReference(image), image).toBe(false);
  }
});

test("Apptainer and Singularity also take the absolute path of a SIF file", () => {
  expect(isValidImage("apptainer", "/images/agents.sif")).toBe(true);
  expect(isValidImage("singularity", "/images/agents.sif")).toBe(true);
  expect(isValidImage("apptainer", "docker.io/library/node:22")).toBe(true);
  expect(isValidImage("podman", "/images/agents.sif")).toBe(false);
  expect(isValidImage("apptainer", "agents.sif")).toBe(false);
});

test("profiles may name a short image for engines that resolve it", () => {
  expect(isValidImage("podman", "node:22")).toBe(true);
  expect(isValidImage("docker", "acme/agents")).toBe(true);
  expect(isValidImage("podman", "")).toBe(false);
  expect(isValidImage("apptainer", "node:22")).toBe(false);
});

test("Docker puts a short name on Docker Hub", () => {
  expect(dockerReference("node:22")).toBe("docker.io/library/node:22");
  expect(dockerReference("acme/agents@sha256:abc")).toBe("docker.io/acme/agents@sha256:abc");
  expect(dockerReference("ghcr.io/acme/agents")).toBe("ghcr.io/acme/agents");
});

test("Podman prefers a local image, then an alias, then its only search registry", async () => {
  const config = [
    'unqualified-search-registries = ["quay.io"]',
    "[aliases]",
    '"python" = "docker.io/library/python"',
  ].join("\n");
  // A local build Podman named itself.
  expect(await podmanReference("myimg", await podman(["localhost/myimg:latest"], config))).toBe(
    "localhost/myimg:latest",
  );
  expect(await podmanReference("python:3.13", await podman([], config))).toBe(
    "docker.io/library/python:3.13",
  );
  expect(await podmanReference("acme/agents:1", await podman([], config))).toBe(
    "quay.io/acme/agents:1",
  );
});

test("Podman refuses a short name several registries could serve, or none", async () => {
  const several = await podman([], 'unqualified-search-registries = ["docker.io", "quay.io"]');
  await expect(podmanReference("node:22", several)).rejects.toThrow(
    'Podman could find "node:22" on docker.io, quay.io; give its full reference, such as docker.io/library/node:22',
  );
  await expect(podmanReference("node:22", await podman([], ""))).rejects.toThrow(
    /no registry to look up "node:22"/,
  );
});

test("leaves full references, and engines that don't resolve short names, alone", async () => {
  const none = await podman([], "");
  expect(await resolveImageReference("podman", " docker.io/library/node:22 ", none)).toBe(
    "docker.io/library/node:22",
  );
  expect(await resolveImageReference("microsandbox", "node:22", none)).toBe(
    "docker.io/library/node:22",
  );
  expect(await resolveImageReference("apptainer", "/images/a.sif", none)).toBe("/images/a.sif");
});
