# Security matrix

Kozane's access rules depend on its bind address and whether a workspace API key
exists. Start the server through `bin/server.js`. It binds `HOST` when set and
`127.0.0.1` otherwise.

## At a glance

| Mode                                    | Network reach   | API key  | Transport       | Host checked  | Writes |
| --------------------------------------- | --------------- | -------- | --------------- | ------------- | ------ |
| Local                                   | Loopback        | Optional | HTTP            | Without a key | Yes    |
| Local with `--allow-remote`             | Loopback        | Required | HTTP            | No            | Yes    |
| Remote (`--allow-remote`, non-loopback) | Bound interface | Required | HTTPS via proxy | No            | Yes    |
| Static export                           | Wherever hosted | None     | Host-defined    | No server     | No     |

When a key exists, every request requires authentication. Browsers use an
`HttpOnly`, `SameSite=Strict` cookie. Unauthenticated browser navigations redirect
to login, API clients receive 401, and repeated failures receive 429.

## Local

Start a loopback server with the following command.

```sh
kozane open
```

Without a key, any local user or process that can reach the port can read and
write the workspace, including taskspace files. Generate a key to require
authentication.

```sh
kozane api key generate
```

`kozane open` launches a URL containing the key, exchanges it for a cookie, and
removes it from the URL. Other local users may see the launcher's command line.
Use `--no-open` and paste the key into the login page to avoid that exposure.
Loopback HTTP cookies are not marked `Secure`.

HTTP loopback origin aliases (`localhost`, `127.0.0.1`, and `[::1]`) are accepted
on the same port. For local port forwarding, the incoming Origin must match Host.
Forwarded-host headers are not trusted, and missing or mismatched origins remain
subject to form-origin checks.

### Host checking without a key

Keyless workspaces reject non-loopback Host headers with 403 to prevent DNS
rebinding. Allow a custom local name through comma-separated `KOZANE_ALLOWED_HOSTS`.

```sh
KOZANE_ALLOWED_HOSTS=kozane.local kozane open
```

Generating a key replaces host checking with authentication.

## Local with `--allow-remote`

The flag requires a generated key but does not change the bind address.

```sh
kozane open --allow-remote
```

The server stays on loopback unless `--host` selects another interface.

## Remote

Generate a key, then bind behind an HTTPS reverse proxy.

```sh
kozane api key generate
kozane open --host 0.0.0.0 --allow-remote --no-open
```

| Requirement           | Behavior                                                                               |
| --------------------- | -------------------------------------------------------------------------------------- |
| API key               | CLI refuses to launch without one, server requests fail closed with 503 if unavailable |
| HTTPS                 | Plain HTTP as seen by SvelteKit receives 426                                           |
| `--no-open`           | Required for remote binding, use the proxy URL in the browser                          |
| Trusted proxy headers | Configure scheme and client-address forwarding for the actual proxy chain              |

Remote cookies are marked `Secure`. Restrict the HTTP listener to the proxy.
See [Production operations](./production.md) for proxy settings and rate limiting.

## Static export (SSG)

Export a read-only site with the following command.

```sh
kozane net ssg generate
```

Every namespace is exported. Anyone with access to the hosted files can read their
embedded data. Kozane provides no authentication on static sites. Editing and live
sync are disabled. Machine-specific workspace and taskspace paths are stripped.

| Data                                     | Default export | With `--include-scoped-files` |
| ---------------------------------------- | -------------- | ----------------------------- |
| Cards, partitions, layers, warps, glue   | Included       | Included                      |
| Map and card tags                        | Included       | Included                      |
| Scopes and map scope graph               | Excluded       | Included                      |
| Scoped taskspace names and file contents | Excluded       | Included within limits        |
| File-tag results                         | Excluded       | Included                      |
| Unscoped taskspaces                      | Excluded       | Excluded                      |

Use `--include-scoped-files` only for taskspace contents intended for publication.

| File export boundary                                                    | Result                                                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Dot-entries                                                             | Excluded                                                                  |
| Symbolic links                                                          | Listed, never followed                                                    |
| Non-UTF-8 files, files over 16 MiB, or content beyond 20 MB per taskspace | Names listed, contents withheld                                           |
| More than 50,000 entries per taskspace or 64 directory levels           | Walk stops and marks the directory truncated, further entries are omitted |

Content caps apply per taskspace per page. Scoped taskspaces with no assigned
namespace can appear on every board, duplicating their embedded contents across pages.

## Taskspace files

Authenticated users can browse, create, and edit files in registered taskspaces.
The boundary is the taskspace directory, including when it lies outside the
workspace. Register only directories that those users may read and write.
Without an API key, this access extends to local processes that can reach the port.

Paths are checked before and after resolution. Traversal outside the taskspace,
dot-entries, and access through symlinks are refused. These rules cover directory
listing, file reads, saves, and creation.

| Operation                | Boundary                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| List directory           | Names, kinds, sizes, and modification times only, symlinks listed but not followed                        |
| Read file                | Regular UTF-8 files up to 16 MiB                                                                            |
| Save file                | Existing files only, atomic replacement, 409 if the read signature no longer matches                      |
| Create file or directory | One empty entry, no replacement or parent creation, 409 for an existing name and 404 for a missing parent |
| Scan tags                | Same read boundaries, with byte, entry, depth, and hit limits and notices for incomplete scans            |

Tag scans also skip generated and vendored directories, including `node_modules`,
`build`, `dist`, `out`, `target`, `coverage`, `vendor`, `bower_components`,
`__pycache__`, and `tmp`.

Tag caches can contain excerpts from external taskspaces. Protect `.kozane/` like
its source data and keep it out of version control. `kozane init` creates an
internal `.gitignore` for this purpose. See [Cache behavior](./cache.md) for cache
validation, limits, and cleanup.

Static sites can read only the files embedded during export and cannot write to
the original taskspaces.

## Config page

`kozane config open` runs its own small server, separate from `kozane open`. It always binds
`127.0.0.1`, and it has no `--host` or `--allow-remote` flag. Each run makes a new random
token and prints it in the page link. The page sends it in the `X-Kozane-Config-Token` header,
and requests without it get 403. A custom header cannot be sent by a plain cross-site form, so
the token also blocks cross-site writes. The server only answers `Host` values of
`127.0.0.1:<port>` or `localhost:<port>`, and refuses a save whose `Origin` is another site.
The page is a Svelte build served from `dist/config-editor`. Only `index.html` and the flat
`assets` directory are served, and asset names must be plain file names. Its Content Security
Policy allows scripts and styles from the same origin only, with nothing inline, and
`Referrer-Policy: no-referrer` keeps the token out of referrers.

The server reads and writes only `.kozane/config.json`. Saves accept only known settings, are
checked with the `doctor config` rules, and are written atomically.

## Where each rule lives

| Rule                                       | Source                                         |
| ------------------------------------------ | ---------------------------------------------- |
| Startup host and key checks                | `src/cli/commands/open.ts`                     |
| TLS, host, and missing-key gating          | `src/hooks.server.ts`                          |
| Authentication, login redirect, throttling | `src/lib/server/request-auth.ts`               |
| Loopback, TLS, and rate-limit helpers      | `src/lib/server/security.ts`                   |
| Login and redirect validation              | `src/routes/login/`, `src/lib/server/login.ts` |
| Taskspace file boundaries                  | `src/lib/server/taskspace-files.ts`            |
| Taskspace tag scanning                     | `src/lib/server/taskspace-tags.ts`             |
| Atomic file replacement                    | `src/lib/server/atomic-write.ts`               |
| Config page token, host, and origin checks | `src/cli/lib/config-editor/handler.ts`         |
