import { rmSync } from "node:fs";

for (const directory of ["build", "build-ssg", "dist"]) {
  rmSync(new URL("../" + directory, import.meta.url), { recursive: true, force: true });
}
