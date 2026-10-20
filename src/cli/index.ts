#!/usr/bin/env node

// Run the command tree defined in `program.ts`. Keeping its construction separate lets
// `spec.test.ts` inspect the tree without executing commands.
import { buildProgram } from "./program.js";

buildProgram().parse();
