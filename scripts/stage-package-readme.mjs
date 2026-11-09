import { readFileSync, writeFileSync } from "node:fs";

// npm resolves relative links against packages/kozane. The source README's
// links refer to the repository root, so make file links absolute for npm.
const repository = "https://github.com/kozmof/kozane/blob/main/";
const source = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const readme = source.replace(/(!?\[[^\]]*\]\()([^\s)]+)(\))/g, (link, start, target, end) => {
  if (target.startsWith("#") || target.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(target)) {
    return link;
  }
  return `${start}${new URL(target, repository).href}${end}`;
});
writeFileSync(new URL("../packages/kozane/README.md", import.meta.url), readme);
