# @kozane/core

Kozane database contracts, schema and domain services for Node and browsers.

| Export                  | Contents                                                                  |
| ----------------------- | ------------------------------------------------------------------------- |
| `@kozane/core`          | Domain types, service input types and errors                              |
| `@kozane/core/database` | Adapter factory, branded handles, transaction helpers and service context |
| `@kozane/core/schema`   | Drizzle tables and relations                                              |
| `@kozane/core/services` | Domain services and input validation                                      |

The host supplies its database driver and transaction hooks through the adapter factory.
The package declares Drizzle and UUID as runtime dependencies and includes JavaScript and
TypeScript declarations. Private module paths are unsupported.

Build from the repository root with `pnpm build:core`. Run `pnpm check:core-package` to pack
the artifact, install it outside the workspace with only its declared dependencies, check
its public declarations and runtime exports, and build its browser entries.

The workspace conversion and public migration exports are being completed under
[Phase 3](../../docs/backend-separation/Kozane-Client-Backend-Separation-and-Web-Demo-Tasks.md).
