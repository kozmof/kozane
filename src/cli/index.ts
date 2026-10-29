#!/usr/bin/env node

// Run the command tree defined in `program.ts`. Keeping its construction separate lets
// `spec.test.ts` inspect the tree without executing commands.
import { buildProgram } from "./program.js";
import { fail } from "./lib/workspace-command.js";

// Await async actions so a rejection from any of them is reported as a CLI error rather than
// an unhandled rejection.
buildProgram().parseAsync().catch(fail);
