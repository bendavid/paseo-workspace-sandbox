import { expect, test } from "vitest";
import { SandboxBadges, type BadgeState } from "../client/sandbox-state";

test("sandbox badges tell listeners only of changes", () => {
  const badges = new SandboxBadges();
  let heard = 0;
  const stop = badges.subscribe(() => {
    heard += 1;
  });
  const starting = new Map<string, BadgeState>([["wks_a", { state: "starting" }]]);
  badges.set(starting);
  badges.set(new Map(starting));
  expect(heard).toBe(1);
  expect(badges.get("wks_a")).toEqual({ state: "starting" });
  expect(badges.get("wks_b")).toBeNull();
  badges.set(new Map([["wks_a", { state: "ready" }]]));
  expect(heard).toBe(2);
  stop();
  badges.set(new Map());
  expect(heard).toBe(2);
  expect(badges.get("wks_a")).toBeNull();
});
