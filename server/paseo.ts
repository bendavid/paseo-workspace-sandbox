import type { PluginHandlerContext } from "@getpaseo/plugin/server";

/**
 * The daemon API handlers and hooks receive. Plugins may only import host-provided modules, type
 * imports included, so it comes from the plugin SDK rather than `@getpaseo/client`.
 */
export type PaseoApi = PluginHandlerContext["paseo"];
