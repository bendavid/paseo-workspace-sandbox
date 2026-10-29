import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const sandboxSettings = defineSettings({
  id: "sandbox",
  scope: "host",
  version: 1,
  schema: z.object({
    containerCli: z.string().trim().min(1, "Enter a container CLI").default("docker"),
    // The container configuration fields below predate container profiles. On first start they
    // seed the "Default" profile; after that, edit profiles instead.
    image: z.string().trim().min(1).default("docker.io/library/node:22-bookworm-slim"),
    network: z.enum(["host", "bridge", "none"]).default("host"),
    extraMounts: z.string().default(""),
    extraRunArgs: z.string().default(""),
  }),
});
