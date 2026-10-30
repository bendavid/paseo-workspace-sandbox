import { expect, test } from "vitest";
import { splitArguments } from "../shared/rpc";

test("splits on whitespace", () => {
  expect(splitArguments("  --memory 8g\t--cpus\n4 ")).toEqual(["--memory", "8g", "--cpus", "4"]);
  expect(splitArguments("")).toEqual([]);
});

test("keeps quoted spaces in one argument", () => {
  const sysctl = "net.ipv4.ping_group_range=23064 23064";
  expect(splitArguments(`--sysctl "${sysctl}"`)).toEqual(["--sysctl", sysctl]);
  expect(splitArguments(`--sysctl '${sysctl}'`)).toEqual(["--sysctl", sysctl]);
  expect(splitArguments("--sysctl net.ipv4.ping_group_range=23064\\ 23064")).toEqual([
    "--sysctl",
    sysctl,
  ]);
  // Quotes join with the text around them, as in a shell.
  expect(splitArguments(`--label=a"b c"'d e'`)).toEqual(["--label=ab cd e"]);
});

test("expands nothing", () => {
  expect(splitArguments(`'$HOME' "$HOME" $HOME '\\n' "\\n" ~ *`)).toEqual([
    "$HOME",
    "$HOME",
    "$HOME",
    "\\n",
    "\\n",
    "~",
    "*",
  ]);
});

test("handles escapes and empty arguments", () => {
  expect(splitArguments(`"a \\"b\\" \\\\ \\$ \\x" it\\'s '' ""`)).toEqual([
    'a "b" \\ $ \\x',
    "it's",
    "",
    "",
  ]);
});

test("rejects unclosed quotes and a trailing backslash", () => {
  expect(() => splitArguments(`--label "a b`)).toThrow(/unclosed "/);
  expect(() => splitArguments("--label 'a b")).toThrow(/unclosed '/);
  expect(() => splitArguments("--label a\\")).toThrow(/backslash/);
});
