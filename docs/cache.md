# Cache behavior

Kozane keeps disposable cache files in the workspace's `.kozane/` directory. They make
aggregate pages and commands faster, but they do not own any user data:

- The SQLite database owns namespaces, partitions, cards, card modification times, scopes, scope
  relationships, and taskspace registrations.
- Each taskspace file owns its file contents and the tags written in those contents.
- Cache files contain only copies or aggregates calculated from those database rows and file
  contents. Kozane accepts a cached copy only after matching it to the current database or
  taskspace file identity.

Deleting a cache therefore removes no namespace, card, scope, relationship, taskspace
registration, or taskspace file. Kozane recreates the missing calculations from the database
and registered taskspace files when they are next requested.

## Cache files

### `.kozane/treemap.json`

The treemap cache is one versioned, workspace-wide semantic snapshot containing:

- namespaces and partitions, including partition card counts and display colours;
- card-change counts grouped by UTC day and partition;
- scopes and their namespace and partition relationships; and
- card tag hits, with each tagged card's namespace, partition, and UTC change day.

The map derives namespace filters, day filters, tag counts, tag-to-partition links, and treemap
input values from this snapshot. It does not cache rectangle coordinates, zoom, pan, or other
viewport-dependent geometry.

Static export generation does not use this persisted cache. It gathers the export data from
the database so the exported files reflect the database used for that build.

### `.kozane/tag-index.json`

The tag-index cache serves the tag page and tag CLI commands. Its database-backed section
stores card tag hits for recently used namespace scopes and for the whole workspace.

Its filesystem-backed section stores parsed tag hits from taskspace files. Each entry is
validated against that individual file's identity. A namespace-specific scan cannot decide
that another namespace's taskspace disappeared, so only a workspace-wide scan removes cached
taskspace directories that are no longer present.

Because tag hits include excerpts, this cache can contain text from taskspaces outside the
workspace directory. Treat it with the same confidentiality as those taskspaces.

## How freshness is checked

Database-backed cache data carries a signature of the SQLite database as it existed before
the data was gathered. The signature combines the database file's inode, nanosecond
modification time, and size. The SQLite `-wal` file is included when it exists.

On a request:

1. Kozane calculates the current database signature.
2. It reads and validates the cache file.
3. If the stored signature and schema version match, it uses the cached data.
4. Otherwise, it gathers current data and atomically replaces the cache.

Updates are therefore lazy. A database write does not edit every cache immediately; the next
request notices the changed signature and rebuilds what it needs.

The signature is captured before gathering. If another process changes the database while a
cache is being rebuilt, the written cache retains the older signature. The next request sees
the mismatch and rebuilds again instead of treating a mixed snapshot as current.

Databases without a local file identity, including in-memory databases, bypass persistent
database caching because Kozane cannot prove that a stored result is still current.

## Validation and write safety

Both cache formats have explicit schema versions and validate their nested data after JSON
parsing. Missing, malformed, truncated, or unknown-version files are ignored rather than
causing the page or command to fail.

Cache writes use a temporary file followed by an atomic rename. Failure to write a cache is
non-fatal. Concurrent writers may replace one another's disposable results, but cache writes
never write to the SQLite database or to a registered taskspace file.

Each cache has a 16 MiB read and write limit. A larger file is ignored, and an oversized
fresh result is not persisted. This bounds the synchronous file read on the request path; a
workspace exceeding the limit pays for a fresh gather instead.

## Security and backups

Cache files can contain card text excerpts, scope and namespace names, and taskspace excerpts.
Keep `.kozane/` private and apply the same filesystem permissions and backup protections used
for the database and taskspaces. The cache files themselves do not need to be backed up: a
restore without them rebuilds them from the restored database rows and taskspace file
contents.

## Clearing and troubleshooting

It is always safe to delete either cache while Kozane is stopped:

```sh
rm .kozane/treemap.json
rm .kozane/tag-index.json
```

The next relevant page load or command recreates it. Clearing a cache does not delete cards,
namespaces, scopes, partitions, or taskspace files.

If a view appears stale, first reload it. If it remains stale, stop the server, remove the
relevant cache, and restart. A cache that cannot be recreated usually indicates that
`.kozane/` is not writable; the feature should still work, but every access will gather the
data again.

`kozane init` places a `.gitignore` inside `.kozane/` that excludes the whole directory. For
older or manually created workspaces, ensure `.kozane/` is ignored so caches, runtime state,
and API credentials are not committed.
