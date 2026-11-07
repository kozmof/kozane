# @kozane/client

Shared Kozane views for Svelte applications.

The root exports backend contracts, adapters, UI configuration and gesture defaults.
Import shared views from `./ui` or
the `./board`, `./tags`, `./map` and `./editor` entries. It ships Svelte source and
declarations built with `@sveltejs/package`. Core types and validation use the public
`@kozane/core` package, which is an exact peer dependency. The editor declares its
Reed runtime dependency.

Import `DEFAULT_UI_CONFIG`, `parseUiOverrides` and `validateUiOverrides` from the root
entry for defaults and workspace configuration checks. It also exports the gesture and
zoom constants. These exports work in Node without loading Svelte components. The UI entry
re-exports the same default configuration object.

The root entry also exports warp hint/layout calculations and tag truncation labels for
views and CLI output. Map display bounds and tag display caps use the same exported constants.

Prepare and verify candidate packages through the [local release flow](../../docs/releases.md).

Views, backend adapters, contracts and rendering helpers live in `packages/client/src`. Tests and fixtures live in `packages/client/tests` and are not published. Source imports public core entries and relative client modules, with no application imports or workspace aliases.

Run `pnpm build:client` from the repository root to build core before client. The client build generates Panda assets and runs `svelte-package --input src --output dist` directly. It does not rewrite application code, import paths or type declarations. Public entry files in `src` match the package export map. TypeScript checks `src/**/*` without emitting files beside inputs.

The client owns the shared Panda theme and base stylesheet. The Node app uses those same inputs. Typed CSS helpers use generated runtime assets copied unchanged into the ignored `src/styles/generated` directory. Panda's authoring augmentation and its barrel stay outside the published declarations. Consumers need the public stylesheet, not Panda or code generation. Generated assets, temporary output and `dist` are ignored.

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

The same command installs a separate SvelteKit consumer from the candidate tarballs
and exact locked build tools. It type-checks and prerenders board, tags, map, editor
and namespace pages under `/kit`, without consumer Panda or workspace aliases.
Checks verify meaningful server HTML, initial readiness and stylesheet/asset links.
Four additional browser cases hydrate the views, check editor input/undo and verify
that SvelteKit handles shared navigation links without reloading the document.
The fixture treats tag/day fragments as filters when checking prerendered links.

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

## Shared core runtime

Packed checks inspect each consumer's installed runtime dependencies and required peers.
They require the expected core/client versions and an exact core peer, and reject a
second physical core installation even when both copies have the same version. Multiple
symlinks to the same physical package are accepted. Node checks also compare public ESM
resolution and module identity from the application and client locations.

Both production browser fixtures require the client to recognize a validation error
created by the application's public core import before reporting hydration readiness.
This check exercises the bundled runtime through public entries without network calls.
The packed client development dependency must match its exact core peer.

The root entry also exports the map and tag view projections used by server loaders. These helpers run without browser globals.
