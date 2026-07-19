import { rmSync } from "node:fs";

for (const directory of ["build", "dist"]) {
  rmSync(new URL("../" + directory, import.meta.url), { recursive: true, force: true });
}
