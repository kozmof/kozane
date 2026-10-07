import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Command } from "commander";
import { buildProgram } from "./program.js";

/**
 * `spec/cli.md` against the command tree it specifies.
 *
 * Fifteen hundred lines of specification with nothing tying them to the code: a command
 * could be renamed, gain an argument, or be removed outright, and the spec would go on
 * describing the old one. Running the check found the larger version of that — fifteen
 * commands the spec has never mentioned at all, listed in {@link UNSPECIFIED} below.
 *
 * The check runs in both directions, and they catch different things. Spec → code catches a
 * section describing something that is no longer there. Code → spec catches a command
 * shipped without one, which is what had been happening.
 */

const SPEC_PATH = resolve("spec/cli.md");

/**
 * Commands `spec/cli.md` does not document.
 *
 * Empty, and the check below is what keeps it that way: a command added without a section
 * fails rather than quietly joining a list of exemptions. It held fifteen entries — every
 * `partition` and `warp` subcommand, the two `scope` membership commands, and seven of
 * `card` — each of them something a user could run today against no specified behaviour.
 * They are written up now.
 *
 * Kept as a list rather than deleted outright so that a command shipped ahead of its
 * documentation has somewhere honest to be recorded, instead of the check being loosened.
 * An entry here is a debt; an entry that has since been documented is a failure, which is
 * what the last test below is for.
 *
 * Written as full command paths without their arguments, the same key the check uses.
 */
const UNSPECIFIED: readonly string[] = [];

type CommandEntry = {
  /** Space-separated path, e.g. `net ssg generate`. */
  path: string;
  /** The heading this command would carry, arguments included. */
  signature: string;
};

/**
 * Every runnable command in the tree, by path.
 *
 * A group such as `net` or `api key` is not runnable and is not listed: it carries no action
 * and exists only to hold its children. `doctor` is the one that is both — it runs a check
 * of its own and hosts `doctor config` — so the test is on having an action handler rather
 * than on having no children.
 */
function runnableCommands(command: Command, prefix: string[] = []): CommandEntry[] {
  const entries: CommandEntry[] = [];
  for (const sub of command.commands) {
    const path = [...prefix, sub.name()];
    // `_actionHandler` is Commander's own field and is not in its public types; nothing else
    // distinguishes a group from a leaf that happens to have subcommands. Compared against
    // null rather than undefined: the constructor initialises it to null, so an
    // `!== undefined` test calls every group runnable.
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
 * That {@link runnableCommands} still tells a leaf from a group.
 *
 * It reads `_actionHandler`, which is Commander's own field and is not in its public types,
 * because nothing public distinguishes a group from a leaf that happens to have subcommands.
 * That probe is load-bearing for every check below, and it fails in the one direction none of
 * them would report: renamed or removed upstream, the field reads `undefined` for every
 * command, `runnableCommands` returns an empty list, and the two checks that walk from the
 * code — "documents every command" and the argument spelling — pass over nothing at all. The
 * suite would go green on a tree it had stopped looking at.
 *
 * So the probe is checked against commands whose kind is known by construction, in both
 * directions, with a floor on the count underneath. A Commander upgrade that moves the field
 * fails here, naming the cause, instead of quietly emptying the checks that gate the build.
 */
describe("the leaf/group probe the checks below rest on", () => {
  const commands = runnableCommands(buildProgram());
  const paths = new Set(commands.map(({ path }) => path));

  it("counts a leaf as runnable", () => {
    expect(paths.has("init")).toBe(true);
    expect(paths.has("card add")).toBe(true);
  });

  it("does not count a group that only holds children", () => {
    // `net` and `api key` carry no action of their own; running either prints help.
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
    // A floor, not a count: a number to keep in step with every new command is the thing
    // `vitest.config.ts` warns against. This only has to fail if the probe stops working.
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

    // Catches an argument added, removed, renamed, or made optional without the heading
    // following it — the drift a spec accumulates fastest, because the prose below the
    // heading usually still reads plausibly.
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
