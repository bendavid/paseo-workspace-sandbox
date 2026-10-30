import { expect, test } from "vitest";
import { isFullImageReference, isValidImage } from "../shared/rpc";

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
