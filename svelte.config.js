import adapterNode from "@sveltejs/adapter-node";
import adapterStatic from "@sveltejs/adapter-static";

// `kozane net ssg generate` sets `KOZANE_SSG` to select the static adapter. Other builds use
// the Node adapter. See `src/cli/commands/ssg.ts`.
const ssg = process.env.KOZANE_SSG === "1";
// GitHub Pages project sites need a base path such as "/kozane". A nonempty base starts with
// "/" and has no trailing slash. An empty base serves from the root.
const base = ssg ? (process.env.KOZANE_SSG_BASE ?? "") : "";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  compilerOptions: {
    // Enable runes for project code while letting dependencies choose their own mode.
    runes: ({ filename }) => (filename.split(/[/\\]/).includes("node_modules") ? undefined : true),
  },
  kit: {
    adapter: ssg
      ? // Keep static output separate from the Node build used by `kozane open`.
        adapterStatic({ pages: "build-ssg", assets: "build-ssg", fallback: "404.html" })
      : adapterNode(),
    paths: { base },
    csp: {
      mode: "auto",
      directives: {
        "default-src": ["self"],
        "base-uri": ["none"],
        "frame-ancestors": ["none"],
        "object-src": ["none"],
        "connect-src": ["self"],
        "script-src": ["self"],
        // Allow style attributes for dynamic canvas positioning. Keep the separate script
        // policy in force.
        "style-src": ["self", "unsafe-inline"],
      },
    },
    // Use aliases in route code compiled by Vite. Use relative imports in CLI, database, and
    // library modules because the CLI's TypeScript build does not rewrite import paths.
    alias: {
      "styled-system": "./styled-system",
      $db: "./src/db",
    },
  },
};

export default config;
