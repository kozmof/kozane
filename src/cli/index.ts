#!/usr/bin/env node

// The entry, and nothing else. Every command lives in `program.ts`, which builds the tree
// without running it so `spec.test.ts` can walk it.
import { buildProgram } from "./program.js";

buildProgram().parse();
