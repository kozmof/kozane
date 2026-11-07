# @kozane/client

Shared Kozane views for Svelte applications.

The initial package exports the shared board, tags, map and editor through its root
and the `./board`, `./tags`, `./map` and `./editor` entries. It ships Svelte source and
declarations built with `@sveltejs/package`. Core types and validation use the public
`@kozane/core` package, which is an exact peer dependency. The editor declares its
Reed runtime dependency.

This candidate is not ready for publication. Packaged styles, the testing entry,
production consumer checks and the release hook remain under Phase 3.

Run `pnpm build:client` from the repository root to build core before client. The build collects
the portable dependency closure and rewrites workspace aliases before packaging.
Generated staging files and `dist` are ignored. Runtime entries exclude test helpers,
SvelteKit modules and Node modules. Panda's authoring-only type augmentation stays
outside consumer declarations.

Run `pnpm check:client-package` to pack both packages and install them outside the
workspace using a frozen offline dependency graph. The check audits runtime and
declaration imports, type-checks all five entries, server-renders the editor and namespace
view, verifies core validation-error identity and compiles the full browser entry.
`pnpm verify` includes this combined core/client artifact check.
