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

The `core-0.1.0-rc3-wasm-boundaries` and `core-0.1.0-rc4-libsql-boundaries` cohorts add
two fixtures per driver. One retains harmless whitespace and comments in the migrated
schema plus SQLite-owned statistics created by `ANALYZE`. The other holds exactly
2,097,152 bytes of valid SQLite data populated through public card services. It has
no appended file padding. The full corpus has twelve databases and 26 view outcomes.

Add a new cohort explicitly after building the intended candidate.

```sh
node scripts/check-core-package.mjs --bootstrap-corpus=<new-cohort-id>
```

Select the locked libsql producer explicitly when adding a native cohort.

```sh
node scripts/check-core-package.mjs --bootstrap-corpus=<new-cohort-id> --corpus-driver=libsql
```

Select boundary scenarios to create schema-formatting and recovery-limit fixtures.

```sh
node scripts/check-core-package.mjs --bootstrap-corpus=<new-cohort-id> --corpus-scenarios=boundaries
```

Combine `--corpus-scenarios=boundaries` with `--corpus-driver=libsql` for the native driver.
Both generators use the same public-service scenarios. The libsql producer installs its
exact dependency graph from the repository lock in the isolated consumer, including native
platform artifacts. It does not import workspace core code. If the temporary mount blocks
native library execution, use an executable temporary directory, such as
`TMPDIR=/workspace/tmp` in the development workspace.

The bootstrap refuses an existing cohort name. Retain the original `producer.tgz`,
database bytes, manifest and index hashes in Git. Do not regenerate an old cohort
when a candidate rejects it. Investigate the regression or record an intentional
migration-ID change with explicit compatibility expectations. The packed check also compares the current index with every committed index reachable
from HEAD. Earlier records must remain unchanged and in the same order. Each historical
manifest hash pins its expectations, producer metadata and original byte hashes. Rewriting
a fixture and all its current hashes still fails. Review remains necessary for changes
to validators, normalization, services and drivers.

Run `pnpm test:restoration-harness` to build the isolated browser harness and restore
every recorded selection under Chromium. CI includes this command in its browser job.
The browser cases verify fetched fixture hashes, require successful restoration, preserve
the saved envelope and compare the recorded view summaries. Browser execution of these
retained corpus cases passed in CI. Two additional earlier-ID envelope-policy cases
await CI execution. They do not claim to be historical producer fixtures.

Run `pnpm check:compatibility-retention` to check current bytes and Git retention without
building a candidate. This requires a full checkout. CI uses `fetch-depth: 0`, and a shallow
clone fails with instructions to fetch the missing history. Commit the initial corpus before
running release checks.

Run `pnpm release:check:core` or `pnpm release:check:client` to run packed candidate
checks, the client style browser case and all Chromium restoration cases. Each package's
`prepublishOnly` hook invokes its command before normal source publication.
The internal pack step runs its build hook without re-entering the publication hook.
Install the pinned Chromium runtime before running the release check.

Same-ID fixtures must still validate and match their original view summaries. A producer ID
from earlier in the candidate's bundled migration history is incompatible with recovery.
The packed check verifies that its envelope rejects with `incompatible`. Browser cases
require validated sample fallback before deletion. A failed sample preserves the copy.
Unknown producer IDs and malformed candidate histories block release checks.

When introducing a new migration ID, retain a new producer cohort through that candidate's
packed public services. The check requires at least one cohort for the current ID, so a run
containing only incompatible old fixtures cannot pass. Earlier fixtures and their recorded
outcomes remain unchanged. Any intentional acceptance restriction still needs a new bundled
migration record and review. Same-ID validator regressions cannot be relabeled incompatible.

Current-ID outcomes also pass through the packed client namespace, snapshot, tags and map
readers. Both source publication paths enforce this check. All retained corpus restoration
cases passed in CI under P3-18. New client browser cases still require CI execution.
