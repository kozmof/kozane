import adapterNode from "@sveltejs/adapter-node";
import adapterStatic from "@sveltejs/adapter-static";

// `kozane ssg` builds a static, read-only export (see src/cli/commands/ssg.ts).
// KOZANE_SSG selects the static adapter; everything else (kozane open, pnpm build)
// keeps the Node adapter untouched.
const ssg = process.env.KOZANE_SSG === "1";
// GitHub Pages serves project sites under /<repo>/, so the export needs a base path.
// Must start with "/" and not end with one (e.g. "/kozane"); empty means root.
const base = ssg ? (process.env.KOZANE_SSG_BASE ?? "") : "";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  compilerOptions: {
    // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
    runes: ({ filename }) => (filename.split(/[/\\]/).includes("node_modules") ? undefined : true),
  },
  kit: {
    adapter: ssg
      ? // Dedicated output dir so a static export never clobbers the Node
        // adapter's build/index.js that `kozane open` depends on.
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
        // Dynamic canvas positioning uses style attributes. Scripts remain nonce-protected.
        "style-src": ["self", "unsafe-inline"],
      },
    },
    // Aliases resolve only in code Vite compiles, which is `src/routes`. `src/cli`,
    // `src/db` and `src/lib` are built by `tsc --project tsconfig.cli.json`, which does
    // not rewrite import paths, so those three keep relative specifiers — which is why
    // `$lib` appears nowhere outside `src/routes` either.
    alias: {
      "styled-system": "./styled-system",
      $db: "./src/db",
    },
  },
};

export default config;
