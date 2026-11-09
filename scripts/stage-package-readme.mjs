import { copyFileSync } from "node:fs";

// npm displays the README included at the root of the package archive.
copyFileSync(
  new URL("../README.md", import.meta.url),
  new URL("../packages/kozane/README.md", import.meta.url),
);
