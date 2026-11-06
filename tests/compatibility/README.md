# Retained compatibility corpus

These databases preserve stored data produced through the packed public core package.
Run `pnpm check:core-package` to verify their hashes and recorded view outcomes with
the current candidate. This check opens copies in wasm memory and requires read-only
validation. It never generates replacement fixtures or expectations.

The initial `core-0.1.0-rc1-wasm` cohort retains four databases and eleven selection
outcomes. They cover empty workspaces, a sole namespace, multiple namespaces without
a default, an explicit default, missing selections, shared scopes across namespaces,
Unicode, omitted card options, nullable width and content at the configured limit.
The manifest records the migration ID, package version, source revision, exact
producer archive hash, Drizzle version, wasm version, SQLite engine and Node runtime.
This producer is an unpublished candidate running the wasm driver under Node.

Add a new cohort explicitly after building the intended candidate.

```sh
node scripts/check-core-package.mjs --bootstrap-corpus=<new-cohort-id>
```

The bootstrap refuses an existing cohort name. Retain the original `producer.tgz`,
database bytes, manifest and index hashes in Git. Do not regenerate an old cohort
when a candidate rejects it. Investigate the regression or record an intentional
migration-ID change with explicit compatibility expectations. An index hash detects
accidental changes but does not replace review of edits to retained expectations.

Libsql-produced fixtures, broader boundary data, browser restoration of these retained
files and publication gates remain tracked under P3-11, P3-12 and P3-18.
