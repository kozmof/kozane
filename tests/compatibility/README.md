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

The `core-0.1.0-rc2-libsql` cohort adds the same public-service scenarios through
`@libsql/client` and Drizzle's libsql adapter. Driver-owned transactions and the native
migration batch produce four original files with eleven recorded outcomes. The packed
candidate's wasm reader accepts all 22 outcomes across both cohorts. Both cohorts remain
unpublished release candidates.

Add a new cohort explicitly after building the intended candidate.

```sh
node scripts/check-core-package.mjs --bootstrap-corpus=<new-cohort-id>
```

Select the locked libsql producer explicitly when adding a native cohort.

```sh
node scripts/check-core-package.mjs --bootstrap-corpus=<new-cohort-id> --corpus-driver=libsql
```

Both generators use the same public-service scenarios. The libsql producer installs its
exact dependency graph from the repository lock in the isolated consumer, including native
platform artifacts. It does not import workspace core code. If the temporary mount blocks
native library execution, use an executable temporary directory, such as
`TMPDIR=/workspace/tmp` in the development workspace.

The bootstrap refuses an existing cohort name. Retain the original `producer.tgz`,
database bytes, manifest and index hashes in Git. Do not regenerate an old cohort
when a candidate rejects it. Investigate the regression or record an intentional
migration-ID change with explicit compatibility expectations. An index hash detects
accidental changes but does not replace review of edits to retained expectations.

Run `pnpm test:restoration-harness` to build the isolated browser harness and restore
every recorded selection under Chromium. CI includes this command in its browser job.
The browser cases verify fetched fixture hashes, require successful restoration, preserve
the saved envelope and compare the recorded view summaries. Browser execution of these
new corpus cases remains pending.

Broader boundary data, recovery-size fixtures and publication gates remain tracked under
P3-11, P3-12 and P3-18.
