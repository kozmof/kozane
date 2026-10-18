# Cache behavior

Kozane stores disposable caches in `.kozane/`. Deleting them leaves database
records and taskspace files intact. Relevant pages and commands rebuild them.

## Cache files

| File                     | Contents                                                                                       | Used by                        |
| ------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------ |
| `.kozane/treemap.json`   | Namespace and partition counts, colors, daily card changes, scope relationships, and card tags | Workspace map                  |
| `.kozane/tag-index.json` | Card tag hits by namespace and workspace, plus taskspace file tags and excerpts                | Tag index and tag CLI commands |

The map derives filters and layout from its snapshot. It does not cache pan,
zoom, or rectangle coordinates. Static exports gather directly from the database.
Only workspace-wide tag scans remove cached taskspace directories that disappeared.

## How freshness is checked

Database caches match the database file's inode, nanosecond modification time,
and size, including the SQLite `-wal` file when present. File-tag entries match
individual file identities.

Each request validates the cache's schema and signature. A mismatch triggers a
fresh gather and replacement. The database signature is captured before gathering,
so a concurrent change triggers another rebuild on the next request.
In-memory databases bypass persistent database caching.

## Validation and write safety

Missing, malformed, truncated, and unknown-version caches are ignored. Each cache
has a 16 MiB read and write limit. Oversized results are gathered without persistence.

Writes use a temporary file and atomic rename. Write failures are non-fatal and
never modify the database or taskspace files.

## Security and backups

Caches contain names and text excerpts, including files from taskspaces outside
the workspace. Protect them with the same permissions as their source data.
Cache backups are optional because caches can be rebuilt.

`kozane init` ignores all of `.kozane/` through an internal `.gitignore`.
For older or manually created workspaces, ensure the directory is ignored to keep
caches, credentials, and runtime state out of source control.

## Clearing and troubleshooting

Reload a stale view first. If it remains stale, stop the server, delete the
relevant cache, and restart.

```sh
rm .kozane/treemap.json
rm .kozane/tag-index.json
```

If caches are not recreated, check that `.kozane/` is writable. Features still
work without cache writes, but gather data on every access.
