# @kozane/client

Kozane client provides Svelte views for boards, tags, maps, and files.
Use a shared client to connect these views to your data.

The package connects views to data through `KozaneClient`. Your application owns the
connection, navigation, and workspace lifetime. Views borrow the client and manage
their own reads and subscriptions. `@kozane/core` supplies shared types and validation.

## What the package provides

- Board, tags, map, editor, and namespace views for Svelte applications.
- `HttpClient` for a local server and `StaticClient` for embedded read-only data.
- Contracts and reusable checks for custom client implementations.
- Shared styles, UI configuration, gesture defaults, and rendering helpers.

The package ships Svelte source and TypeScript declarations. Svelte and an exact
version of `@kozane/core` are peer dependencies. The editor declares Reed as a
runtime dependency.

## Integrate the views

1. Choose an HTTP or static client for your data source.
2. Create one owned client for the active workspace in the host root layout.
3. Load the shared stylesheet once in that layout.
4. Import the views and supply the client interface each view requires.
5. Share the client across navigation and dispose it when its owner ends.

Import the compiled stylesheet in your root layout.

```ts
import "@kozane/client/styles.css";
```

It includes reset and base rules, shared tokens, and utility styles. Consumers do
not need Panda or source scanning. Hosts that generate their own shared Panda
utilities can use `@kozane/client/base.css` for the common base rules.

### Public entry points

Use public imports. Private source paths are unsupported.

| Entry point                 | Purpose                                                                   |
| --------------------------- | ------------------------------------------------------------------------- |
| `@kozane/client`            | Client contracts, built-in clients, configuration, and rendering helpers  |
| `@kozane/client/ui`         | Shared views and default UI configuration                                 |
| `@kozane/client/board`      | Board view exports                                                        |
| `@kozane/client/tags`       | Tags view exports                                                         |
| `@kozane/client/map`        | Map view exports                                                          |
| `@kozane/client/editor`     | Editor exports                                                            |
| `@kozane/client/host`       | Wire decoders, static-file helpers, polling lifecycle, and activity types |
| `@kozane/client/testing`    | Framework-independent client contract checks                              |
| `@kozane/client/styles.css` | Complete shared stylesheet                                                |
| `@kozane/client/base.css`   | Base rules for hosts that generate shared utilities                       |

The root, host, and testing entries load in Node without compiling Svelte components.
Use `DEFAULT_UI_CONFIG`, `parseUiOverrides`, and `validateUiOverrides` from the root
for workspace defaults and configuration checks. The UI entry re-exports the same
default configuration object.

The root also exports gesture and zoom constants, warp hint and layout calculations,
tag truncation labels, and map and tag projections for server loaders. These helpers
work without browser globals. Map bounds and tag display caps use shared constants.

## Client ownership

Create one owned client for the active workspace in the host's root layout. Share it across board, tags, map and namespace navigation. During server-side rendering (SSR), create an owner for each render request. Keep mutable clients out of module-level singletons. Static clients receive only the data allowed for the current exported page.

`ManagedClient` extends `KozaneClient` with synchronous, idempotent `dispose()`. The host owns disposal. Views borrow clients and release only their own subscriptions and reads. Leaving a view also disables its undispatched UI actions without closing the shared connection. The Node host retains its HTTP subscription for the root layout lifetime, so route changes share polling and transport state. A capability change replaces the client and closes the previous one. Reusing a client on another board page requires a fresh snapshot before editing, since navigation may restore an older server seed.

Disposal cancels pending reads, stops polling, removes listeners and prevents new operations. An HTTP mutation already dispatched may still settle with its known result, but it publishes no later invalidation through the disposed client. Disposal never implies server rollback. Do not replay a mutation after an unknown outcome. Connection replacement or worker recovery belongs to the host, not to an individual view.

Preserve the owner when `pagehide.persisted` is true. Dispose it when the root layout is destroyed or the document is discarded. Future worker hosts must also implement their transport's suspension and reconnection policy.

## Read cancellation

Pass `ReadOptions` with an `AbortSignal` to namespace list/get, tags, map, warp-directory and taskspace file/directory reads. Snapshot reads accept the same signal through `SnapshotReadOptions`. Pre-cancelled reads perform no HTTP request or static lookup. Cancellation rejects with the signal's original reason and does not become a network failure. Injected fetch implementations must honor the supplied signal.

Views cancel obsolete reads on invalidation, generation changes and cleanup. They retain generation and sequence checks to discard late results from readers that cannot stop immediately. Read cancellation publishes no invalidation. Mutation options support `keepalive` and do not expose read cancellation.

## View interfaces

Use the smallest public client interface accepted by each view. Full `KozaneClient` implementations satisfy these interfaces. View interfaces do not expose owner disposal.

| Interface              | Available operations                                                         |
| ---------------------- | ---------------------------------------------------------------------------- |
| `TagsViewClient`       | Lifecycle observations, writable capability and tag reads                    |
| `MapViewClient`        | Lifecycle observations, writable capability and map reads                    |
| `NamespacesViewClient` | Lifecycle observations, writable capability and namespace list/create        |
| `BoardViewClient`      | Board snapshots, mutations, warp directory and optional taskspace operations |

The host entry uses explicit exports. Its `ActivityGuard` and `BoardPoint` interfaces are independent of board implementation modules, and `CardPositionPatch` comes from the public core domain type. New private decoder helpers do not automatically become public API.

## Image cards

Provide `uploadImage(file)` on the borrowed client to enable image uploads.
`HttpClient` sends the file through its configured transport and returns the
workspace-relative asset URL. Its `resolveImageUrl(path)` method adds the
configured server base when shared board views render the image. Custom clients
can provide both optional methods. Image references alone do not embed file bytes
in static data.

## Taskspace availability

Use `createClientFeatures(capabilities, taskspaces)` when constructing a client. It derives the taskspace capability from the attached API and freezes the feature pair. Omit the API to disable taskspaces. An attached API must implement every taskspace method, including explicit rejections for unsupported writes.

Both built-in clients use this constructor. Every shared contract case checks that the taskspace flag agrees with API availability and that the API has all required methods. Custom clients remain responsible for operation results and access permissions.

## How views and transports cooperate

### HTTP implementation

`HttpClient` owns transport, lifetime, snapshot validators and invalidation. Resource modules under `src/client/http` wire namespace, card, collection, dataset and taskspace operations through that shared context. They do not create connections or own subscriptions.

The client prepares mutation inputs once through the public core helper before dispatch and response validation. Transport encodes the prepared copy and handles HTTP status, authentication, throttling, cancellation and keepalive. Services still validate inputs at their own boundary. Production views use this client rather than separate route-local request helpers.

### Board coordination

Each mounted board creates a private controller. It coordinates snapshots, editing, navigation, files and keyboard actions for that view. The component renders the controller's state and supplies canvas and composer actions through small interfaces. Leaving the board releases its effects and disables pending actions. The host continues to own the shared client.

## Client contract checks

Import the framework-independent suite from `@kozane/client/testing`. The root and
testing entries run directly under Node without compiling Svelte. Register the cases
with your test runner or call `runClientContract` to run them serially.

```ts
import { clientContractCases } from "@kozane/client/testing";

for (const test of clientContractCases(createFixture, { mode: "read-only" })) {
  it(test.name, test.run);
}
```

Provide `createFixture` with a ready client, an existing `namespaceId` and optional
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

## Develop and verify the package

Run commands from the repository root.

| Task                                                       | Command                     |
| ---------------------------------------------------------- | --------------------------- |
| Build core and client                                      | `pnpm build:client`         |
| Test installed packages through public exports             | `pnpm test:packages`        |
| Verify the installed client package and core compatibility | `pnpm check:client-package` |
| Verify client views and styles in Chromium                 | `pnpm test:client-package`  |
| Run repository verification, including package checks      | `pnpm verify`               |

Source unit tests use `vitest.source.config.ts`. The installed-package project
resolves public exports from candidate archives without source aliases.

Views, client adapters, contracts and rendering helpers live in `packages/client/src`. Tests and fixtures live in `packages/client/tests` and are not published. Source imports public core entries and relative client modules, with no application imports or workspace aliases.

The client build runs after core. It generates Panda assets and runs `svelte-package --input src --output dist` directly. It does not rewrite application code, import paths or type declarations. Public entry files in `src` match the package export map. TypeScript checks `src/**/*` without emitting files beside inputs.

The client owns the shared Panda theme and base stylesheet. The Node app uses those same inputs. Typed CSS helpers use generated runtime assets copied unchanged into the ignored `src/styles/generated` directory. Panda's authoring augmentation and its barrel stay outside the published declarations. Consumers need the public stylesheet, not Panda or code generation. Generated assets, temporary output and `dist` are ignored.

`pnpm check:client-package` packs both packages and installs them outside the
workspace using a frozen offline dependency graph. It audits runtime and
declaration imports, type-checks all 55 client methods and the public UI entries, server-renders board, tags, map, editor and namespace
views, verifies core validation-error identity and compiles the full browser entry.
`pnpm verify` includes this combined core/client artifact check.

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

## Future worker clients

Worker clients are not implemented. The proposed `WorkerClient`
uses an injected message transport. Planned runtime packages are `@kozane/web-worker`
and `@kozane/service-worker`. Each transport owns its lifecycle and keeps request
handling independent of Svelte. Service Worker support requires explicit restart and
reconnection handling.

See the [worker package design](../../docs/web-demo-specification.md#future-worker-packages)
for protocol boundaries and the separate focus-sharing contract. See the
[local release guide](../../docs/releases.md) for package preparation and publication.
