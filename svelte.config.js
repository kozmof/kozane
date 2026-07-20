import adapter from "@sveltejs/adapter-node";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  compilerOptions: {
    // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
    runes: ({ filename }) => (filename.split(/[/\\]/).includes("node_modules") ? undefined : true),
  },
  kit: {
    adapter: adapter(),
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
    alias: {
      "styled-system": "./styled-system",
    },
  },
};

export default config;
