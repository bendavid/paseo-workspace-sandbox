// Images for the engine tests, never downloaded: the OCI engines use IMAGE as it is, and Apptainer
// and Singularity a SIF built from Podman's copy of it.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { backendFor, resolveEngineCli } from "../../server/backends/index";
import type { Engine } from "../../shared/rpc";

const run = promisify(execFile);
export const IMAGE = "docker.io/library/node:22-bookworm-slim";
const SIF = path.join(tmpdir(), "paseo-sandbox-e2e-images", "node.sif");
let sif: Promise<string | null> | null = null;

/**
 * A SIF of IMAGE built from Podman's copy, once per run; null without Podman's copy. Test files
 * run in parallel and may build it at once, so each builds under its own name and renames.
 */
function buildSif(apptainer: string): Promise<string | null> {
  sif ??= (async () => {
    if (existsSync(SIF)) return SIF;
    const podman = await resolveEngineCli("podman").catch(() => null);
    if (!podman) return null;
    await mkdir(path.dirname(SIF), { recursive: true });
    const own = `${SIF}.${process.pid}.${Date.now()}`;
    try {
      await run(podman, ["image", "exists", IMAGE]);
      await run(podman, ["save", "--format", "oci-archive", "-o", `${own}.tar`, IMAGE]);
      await run(apptainer, ["build", "--force", own, `oci-archive://${own}.tar`]);
      await rename(own, SIF);
      return SIF;
    } catch {
      return existsSync(SIF) ? SIF : null;
    } finally {
      await rm(`${own}.tar`, { force: true });
      await rm(own, { force: true });
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

const WITHOUT_ACCOUNT = "localhost/paseo-sandbox-e2e-squashed:1";

/**
 * IMAGE without accounts for your uid and gid, built locally from Podman's copy once, for a
 * squashed sandbox, where Podman adds your account only for a uid the image has none for. Like
 * images with a system service, it has a folder in /run owned by another id. Null without
 * Podman's copy.
 */
export async function imageWithoutAccount(podman: string): Promise<string | null> {
  if (
    await run(podman, ["image", "exists", WITHOUT_ACCOUNT]).then(
      () => true,
      () => false,
    )
  ) {
    return WITHOUT_ACCOUNT;
  }
  if (
    !(await run(podman, ["image", "exists", IMAGE]).then(
      () => true,
      () => false,
    ))
  )
    return null;
  const { uid, gid } = userInfo();
  const remove = [
    `user=$(getent passwd ${uid} | cut -d: -f1); [ -z "$user" ] || userdel -r "$user"`,
    `group=$(getent group ${gid} | cut -d: -f1); [ -z "$group" ] || groupdel "$group"`,
    "mkdir -p /run/service && chown 100:100 /run/service",
  ].join("; ");
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-sandbox-e2e-build-"));
  try {
    await writeFile(path.join(directory, "Containerfile"), `FROM ${IMAGE}\nRUN ${remove}\n`);
    await run(podman, ["build", "--pull=never", "-t", WITHOUT_ACCOUNT, directory]);
    return WITHOUT_ACCOUNT;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
