import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  ContainerProfileSchema,
  DEFAULT_IMAGE,
  defaultNetwork,
  ENGINE_NETWORKS,
  engineUsesImage,
  imageHint,
  isValidImage,
  type ContainerProfile,
} from "../shared/rpc";
import { which } from "./container";
import { writeFileAtomic } from "./store";

const FileSchema = z.object({
  version: z.literal(1),
  defaultId: z.string(),
  profiles: z.array(ContainerProfileSchema).min(1),
});

/** The first profile: Podman, or Docker when only Docker is installed. */
async function defaultProfile(): Promise<ContainerProfile> {
  const engine = (await which("podman")) || !(await which("docker")) ? "podman" : "docker";
  return {
    id: "default",
    name: "Default",
    engine,
    image: DEFAULT_IMAGE,
    network: defaultNetwork(engine),
    extraMounts: "",
    extraRunArgs: "",
  };
}

/**
 * Saved container configurations, in `container-profiles.json` next to the plugin's state. A new
 * sandbox copies one, so editing a profile never changes an existing workspace's container.
 */
export class ContainerProfiles {
  private profiles: ContainerProfile[] = [];
  private defaultProfileId = "";
  private readonly file: string;

  constructor(directory: string) {
    this.file = path.join(directory, "container-profiles.json");
  }

  /** Loads the saved profiles, or creates "Default" on first start. */
  async load(): Promise<void> {
    let raw: string | null = null;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (raw !== null) {
      const state = FileSchema.parse(JSON.parse(raw));
      this.profiles = state.profiles;
      this.defaultProfileId = state.defaultId;
      return;
    }
    this.profiles = [await defaultProfile()];
    this.defaultProfileId = "default";
    await this.persist();
  }

  snapshot(): { profiles: ContainerProfile[]; defaultId: string } {
    return { profiles: [...this.profiles], defaultId: this.defaultProfileId };
  }

  get(id: string | undefined): ContainerProfile {
    const profile = this.profiles.find(
      (candidate) => candidate.id === (id ?? this.defaultProfileId),
    );
    if (!profile) throw new Error(`Container profile ${id} does not exist`);
    return profile;
  }

  async save(
    input: Omit<ContainerProfile, "id"> & { id?: string },
    makeDefault: boolean,
  ): Promise<ContainerProfile> {
    if (engineUsesImage(input.engine) && !isValidImage(input.engine, input.image)) {
      throw new Error(input.image ? imageHint(input.engine) : `${input.engine} needs an image`);
    }
    if (!ENGINE_NETWORKS[input.engine].includes(input.network)) {
      throw new Error(`${input.engine} has no ${input.network} network`);
    }
    const profile: ContainerProfile = {
      ...input,
      id: input.id ?? `profile-${randomUUID().slice(0, 8)}`,
    };
    const index = this.profiles.findIndex((candidate) => candidate.id === profile.id);
    if (index === -1) this.profiles.push(profile);
    else this.profiles[index] = profile;
    if (makeDefault) this.defaultProfileId = profile.id;
    await this.persist();
    return profile;
  }

  async delete(id: string): Promise<void> {
    if (this.profiles.length === 1) throw new Error("Keep at least one container profile");
    this.profiles = this.profiles.filter((candidate) => candidate.id !== id);
    if (this.defaultProfileId === id) this.defaultProfileId = this.profiles[0]!.id;
    await this.persist();
  }

  private async persist(): Promise<void> {
    const state = { version: 1, defaultId: this.defaultProfileId, profiles: this.profiles };
    await writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`);
  }
}
