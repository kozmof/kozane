import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Command } from "commander";
import { buildProgram } from "./program.js";

/**
 * Compare the CLI specification with the command tree in both directions. Catch obsolete
 * documentation and commands without documentation.
 */

const SPEC_PATH = resolve("spec/cli.md");

/**
 * Full command paths temporarily exempted from documentation checks, without arguments.
 *
 * Keep this list empty when all commands are documented. The tests reject entries that have
 * since been documented.
 */
const UNSPECIFIED: readonly string[] = [];

type CommandEntry = {
  /** Space-separated path, e.g. `net ssg generate`. */
  path: string;
  /** The heading this command would carry, arguments included. */
  signature: string;
};

/**
 * List commands with action handlers by full path. Groups without actions are excluded, while
 * commands such as `doctor` can have both an action and subcommands.
 */
function runnableCommands(command: Command, prefix: string[] = []): CommandEntry[] {
  const entries: CommandEntry[] = [];
  for (const sub of command.commands) {
    const path = [...prefix, sub.name()];
    // Commander exposes no public action-handler predicate. Check `_actionHandler` against
    // null, its initial value, to distinguish groups from runnable commands.
    const runnable = (sub as unknown as { _actionHandler?: unknown })._actionHandler != null;
    if (runnable) {
      const args = sub.registeredArguments
        .map((argument) => (argument.required ? `<${argument.name()}>` : `[${argument.name()}]`))
        .join(" ");
      entries.push({ path: path.join(" "), signature: [...path, args].filter(Boolean).join(" ") });
    }
    entries.push(...runnableCommands(sub, path));
  }
  return entries;
}

/** The `### \`kozane …\`` headings, as written. */
function specifiedSignatures(): string[] {
  const spec = readFileSync(SPEC_PATH, "utf-8");
  return [...spec.matchAll(/^### `kozane ([^`]+)`$/gmu)].map((match) => match[1].trim());
}

/** A heading reduced to its command path, so `card show <cardId>` keys as `card show`. */
function pathOf(signature: string): string {
  return signature
    .split(" ")
    .filter((word) => !word.startsWith("<") && !word.startsWith("["))
    .join(" ");
}

/**
 * Verify the private action-handler probe against known commands and a minimum count. If
 * Commander changes the field, fail here instead of letting an empty command list make the
 * documentation checks pass.
 */
describe("the leaf/group probe the checks below rest on", () => {
  const commands = runnableCommands(buildProgram());
  const paths = new Set(commands.map(({ path }) => path));

  it("counts a leaf as runnable", () => {
    expect(paths.has("init")).toBe(true);
    expect(paths.has("card add")).toBe(true);
  });

  it("does not count a group that only holds children", () => {
    // `net` and `api key` have no action handlers. Running either prints help.
    expect(paths.has("net")).toBe(false);
    expect(paths.has("api key")).toBe(false);
    expect(paths.has("net ssg")).toBe(false);
  });

  it("counts a command that is both a leaf and a group", () => {
    // `doctor` runs a check of its own and hosts `doctor config`, which is why the probe
    // tests for an action handler rather than for having no children.
    expect(paths.has("doctor")).toBe(true);
    expect(paths.has("doctor config")).toBe(true);
  });

  it("finds the whole tree rather than a fraction of it", () => {
    // Check a minimum count so the test catches an empty probe without pinning the inventory.
    expect(commands.length).toBeGreaterThan(40);
  });
});

describe("spec/cli.md against the command tree", () => {
  const commands = runnableCommands(buildProgram());
  const signatures = specifiedSignatures();

  it("documents no command that does not exist", () => {
    const real = new Set(commands.map(({ path }) => path));
    const stale = signatures.map(pathOf).filter((path) => !real.has(path));

    // A section left behind by a rename or a removal. Nothing catches this by reading.
    expect(stale).toEqual([]);
  });

  it("spells each documented command's arguments the way the command declares them", () => {
    const declared = new Map(commands.map(({ path, signature }) => [path, signature]));
    const wrong = signatures
      .map((signature) => ({ signature, expected: declared.get(pathOf(signature)) }))
      .filter(({ signature, expected }) => expected !== undefined && expected !== signature);

    // Catch arguments added, removed, renamed, or made optional without a matching
    // documentation heading.
    expect(wrong).toEqual([]);
  });

  it("documents every command except the ones recorded as unspecified", () => {
    const documented = new Set(signatures.map(pathOf));
    const missing = commands
      .map(({ path }) => path)
      .filter((path) => !documented.has(path) && !UNSPECIFIED.includes(path as never))
      .sort();

    expect(missing).toEqual([]);
  });

  it("keeps the unspecified list honest", () => {
    const documented = new Set(signatures.map(pathOf));
    const real = new Set(commands.map(({ path }) => path));

    // An entry that has since been written up, and should have been deleted from the list
    // rather than left to exempt a section that now exists.
    expect(UNSPECIFIED.filter((path) => documented.has(path))).toEqual([]);
    // An entry naming a command that no longer exists.
    expect(UNSPECIFIED.filter((path) => !real.has(path))).toEqual([]);
  });
});
