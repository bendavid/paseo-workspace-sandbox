// Runs real sandboxes with each engine that is installed. Images are never downloaded: an engine
// without its image is skipped (see images.ts).
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { backendFor } from "../../server/backends/index";
import { createLink, type ContainerPolicy, type ContainerTarget } from "../../server/container";
import type { Engine } from "../../shared/rpc";
import { engineImage } from "./images";

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const ENGINES: Engine[] = ["bubblewrap", "podman", "microsandbox", "apptainer", "singularity"];
const setups = Object.fromEntries(
  await Promise.all(ENGINES.map(async (engine) => [engine, await engineImage(engine)] as const)),
);

// Prints how the sandbox sees the link and the project, and writes through both.
const CHECK = [
  'link=$1; project=$2; cd "$link"',
  'echo "pwd=$(pwd -P)"',
  'if [ -L "$link" ]; then echo kind=symlink; else echo kind=directory; fi',
  'echo from-link > "$link/written-through-link"',
  'echo "real=$(cat "$project/written-through-link")"',
  'echo from-real > "$project/written-through-real"',
  'echo "linked=$(cat "$link/written-through-real")"',
].join("\n");

describe.each(ENGINES)("a sandboxed directory with %s", (engine) => {
  const setup = setups[engine];
  test.skipIf(!setup).each([
    ["without extra mounts", false],
    ["under a read-only extra mount", true],
  ])("runs at the link path %s", async (_label, covered) => {
    const root = await mkdtemp(path.join(tmpdir(), "sandbox-linked-e2e-"));
    roots.push(root);
    const project = path.join(root, "project");
    await mkdir(project);
    await writeFile(path.join(project, "README.md"), "hi\n");
    const link = path.join(root, "data", "links", `wks_${randomBytes(4).toString("hex")}`);
    await createLink(link, project);
    const target: ContainerTarget = {
      container: `paseo-sandbox-e2e-${randomBytes(4).toString("hex")}`,
      label: "e2e=1",
      image: setup!.image,
      workspace: link,
      workdir: link,
      claude: { mode: "none" },
      linkedDirectory: project,
    };
    const policy: ContainerPolicy = {
      engine,
      cli: setup!.cli,
      network: "none",
      // Covers the link, which then shows inside as a symlink unless the plugin prevents it.
      extraMounts: covered ? `${root}:ro` : "",
      extraRunArgs: "",
      runAsHostUser: true,
      shareAgentState: true,
    };
    const output = await backendFor(engine).runOnce(target, policy, [
      "sh",
      "-c",
      CHECK,
      "sh",
      link,
      project,
    ]);
    const lines = Object.fromEntries(
      output
        .trim()
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    expect(lines).toEqual({
      pwd: link,
      kind: "directory",
      real: "from-link",
      linked: "from-real",
    });
    // Files written in the sandbox are yours on the host.
    const written = path.join(project, "written-through-link");
    expect(await readFile(written, "utf8")).toBe("from-link\n");
    expect((await stat(written)).uid).toBe(process.getuid?.());
  });
});
