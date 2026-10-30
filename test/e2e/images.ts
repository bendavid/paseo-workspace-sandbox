// Images for the engine tests, never downloaded: the OCI engines use IMAGE as it is, and Apptainer
// and Singularity a SIF built from Podman's copy of it.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { backendFor, resolveEngineCli } from "../../server/backends/index";
import type { Engine } from "../../shared/rpc";

const run = promisify(execFile);
export const IMAGE = "docker.io/library/node:22-bookworm-slim";
const SIF = path.join(tmpdir(), "paseo-sandbox-e2e-images", "node.sif");
let sif: Promise<string | null> | null = null;

/** A SIF of IMAGE built from Podman's copy, once per run; null without Podman's copy. */
function buildSif(apptainer: string): Promise<string | null> {
  sif ??= (async () => {
    if (existsSync(SIF)) return SIF;
    const podman = await resolveEngineCli("podman").catch(() => null);
    if (!podman) return null;
    await mkdir(path.dirname(SIF), { recursive: true });
    const archive = `${SIF}.tar`;
    try {
      await run(podman, ["image", "exists", IMAGE]);
      await run(podman, ["save", "--format", "oci-archive", "-o", archive, IMAGE]);
      await run(apptainer, ["build", "--force", SIF, `oci-archive://${archive}`]);
      return SIF;
    } catch {
      return null;
    } finally {
      await rm(archive, { force: true });
    }
  })();
  return sif;
}

/** The engine's command and the image to use with it, or null when either is not here. */
export async function engineImage(engine: Engine): Promise<{ cli: string; image: string } | null> {
  const cli = await resolveEngineCli(engine).catch(() => null);
  if (!cli) return null;
  if (engine === "apptainer" || engine === "singularity") {
    const image = await buildSif(cli);
    return image ? { cli, image } : null;
  }
  const { images } = backendFor(engine);
  if (images && !(await images.localDigests(cli, IMAGE))) return null;
  return { cli, image: IMAGE };
}
