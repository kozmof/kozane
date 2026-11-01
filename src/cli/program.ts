import { createRequire } from "node:module";
import { Command } from "commander";
import { registerWorkspaceCommands } from "./program/workspace.js";
import { registerStructureCommands } from "./program/structure.js";
import { registerDataCommands } from "./program/data.js";
import { registerCardCommands } from "./program/cards.js";
import { registerBoardCommands } from "./program/board.js";

const _require = createRequire(import.meta.url);
const { version: _version } = _require("../../package.json") as { version: string };

/**
 * Build the command tree without parsing arguments or running a command. `index.ts` parses
 * arguments, and `spec.test.ts` compares this tree with `spec/cli.md`.
 *
 * Each command group registers itself from `./program/`, in the order `kozane --help` lists
 * them.
 */
export function buildProgram(): Command {
  const program = new Command();

  program.name("kozane").description("Local card-based thinking workspace").version(_version);

  registerWorkspaceCommands(program);
  registerStructureCommands(program);
  registerDataCommands(program);
  registerCardCommands(program);
  registerBoardCommands(program);

  return program;
}
