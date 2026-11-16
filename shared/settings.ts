import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** How the Sandbox field on Paseo's New workspace screen starts out, per host. */
export const newWorkspaceSettings = defineSettings({
  id: "new-workspaces",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Preselect the default container profile, rather than No sandbox. */
    sandboxByDefault: z.boolean().default(false),
  }),
});
