# Kozane

Kozane organizes text fragments and the relationships between them. This package contains
the Node app, CLI, HTTP routes, configuration editor and static export commands.

Requires Node.js 24 or later. Install the unscoped package globally to use the command.

```sh
npm install --global kozane
kozane init
kozane open
```

The package uses the tested `@kozane/core` and `@kozane/client` versions. Its executable
entries remain `bin/kozane.js` and `bin/server.js`. Bundled migration files preserve the
repository's original SQL and journal bytes.

Run development commands from the repository root. `pnpm build` builds core, client and
this package. `pnpm check` checks the app, and `pnpm test` runs workspace tests. Generated
CLI/server output lives in this package's `dist` and `build` directories.

Kozane is beta software under active development and is not yet production-ready.
