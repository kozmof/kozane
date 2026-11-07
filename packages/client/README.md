# @kozane/client

Shared Kozane views for Svelte applications.

The root exports backend contracts and adapters. Import shared views from `./ui` or
the `./board`, `./tags`, `./map` and `./editor` entries. It ships Svelte source and
declarations built with `@sveltejs/package`. Core types and validation use the public
`@kozane/core` package, which is an exact peer dependency. The editor declares its
Reed runtime dependency.

This candidate is not ready for publication. Complete production consumer checks and
workspace conversion remain under Phase 3.

Run `pnpm build:client` from the repository root to build core before client. The build collects
the portable dependency closure and rewrites workspace aliases before packaging.
Generated staging files and `dist` are ignored. Runtime entries exclude test helpers,
SvelteKit modules and Node modules. Panda's authoring-only type augmentation stays
outside consumer declarations.

Run `pnpm check:client-package` to pack both packages and install them outside the
workspace using a frozen offline dependency graph. The check audits runtime and
declaration imports, type-checks all 55 backend methods and the public UI entries, server-renders board, tags, map, editor and namespace
views, verifies core validation-error identity and compiles the full browser entry.
`pnpm verify` includes this combined core/client artifact check.

Import the compiled stylesheet once in your root layout. It includes global reset and
base rules, shared tokens and extracted utility styles. The consuming app uses this CSS
directly without installing Panda or scanning package source.

```ts
import "@kozane/client/styles.css";
```

The stylesheet preserves the layer order `reset, base, tokens, recipes, utilities` and
is declared as a package side effect. The client build generates Panda helpers and CSS
with the same pinned tool version. Its config reuses the shared theme and excludes tests
and fixtures from extraction.

`pnpm check:client-package` also builds a production app that imports the stylesheet,
checks emitted CSS and links, and verifies that the isolated consumer has no Panda
dependency. Run `pnpm test:client-package` for the Chromium check of hydrated editor
and namespace views, token values, representative computed styles and layer precedence.
The browser CI job includes this command. Four additional cases hydrate the packed
board, tags and map pages, follow supplied navigation URLs, change map zoom and
exercise editor typing and undo. Each page starts with server-rendered content.
Declaration checks require every relative type dependency to ship its declaration
and reject a deliberately removed declaration.

## Backend contract checks

Import the framework-independent suite from `@kozane/client/testing`. The root and
testing entries run directly under Node without compiling Svelte. Register the cases
with your test runner or call `runBackendContract` to run them serially.

```ts
import { backendContractCases } from "@kozane/client/testing";

for (const test of backendContractCases(createFixture, { mode: "read-only" })) {
  it(test.name, test.run);
}
```

Provide `createFixture` with a ready backend, an existing `namespaceId` and optional
`cleanup`. Each case requests a fresh fixture and always attempts cleanup. Disable
background polling and external writers while a case runs. Declare unavailable tags,
map or warp-directory datasets through `unavailableDatasets`.

The read-only suite checks reads, versions, subscriptions and all 36 mutation
rejections. Writable mode checks namespace creation, card creation/update/deletion
and rejection without committed changes. Override `initialContent` and `updatedContent`
for workspace content limits. Adapter-specific suites still cover the remaining
resource mutations and taskspace file operations.

Before source publication, `prepublishOnly` runs `release:check:client`. Both client
and core release checks run packed candidate checks, the production style browser
case and the restoration browser suite. Retained current-ID corpus outcomes also
pass through the packed client snapshot, tags and map readers. Install the pinned
Chromium runtime and retain full Git history before running either release command.
