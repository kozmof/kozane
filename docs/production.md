# Production operations

Kozane supports one user and one server per workspace. Use it locally or on a
trusted network behind a TLS reverse proxy. It has no user accounts or roles.

## Supported runtime

- Pin Node.js 24 LTS.
- Install with `pnpm install --frozen-lockfile`, then run `pnpm verify`.
- Run as an unprivileged operating-system user with write access limited to
  the workspace and intended taskspace directories.

## Secure remote access

Generate a key and start the server behind a TLS reverse proxy.

```sh
kozane api key generate
kozane open --host 0.0.0.0 --allow-remote --no-open
```

Restrict the HTTP listener to traffic from the proxy using firewall rules.
Non-loopback bindings require a key and HTTPS as seen by SvelteKit. Missing or
incorrect protocol forwarding causes HTTP 426 responses.

Configure headers for the exact trusted proxy chain. For a single trusted proxy, use these settings.

| Setting           | Value               | Purpose                                                 |
| ----------------- | ------------------- | ------------------------------------------------------- |
| `PROTOCOL_HEADER` | `x-forwarded-proto` | Recognize HTTPS terminated at the proxy                 |
| `ADDRESS_HEADER`  | `x-forwarded-for`   | Identify clients for logs and authentication throttling |
| `XFF_DEPTH`       | `1`                 | Trust one proxy hop                                     |

Accept these headers only from trusted proxies. Without client-address forwarding,
all clients share the proxy's authentication-failure counter. Add proxy-level
rate limiting because Kozane's throttle resets when the process restarts.

Rotate keys with `kozane api key refresh`, which invalidates the old key immediately.
Keep `.kozane/api.json` out of source control and logs. Do not log URLs containing
`api_key`.

## Process and health management

Use a process supervisor with bounded restart backoff and graceful `SIGTERM`
shutdown. Point it at `bin/server.js`, which binds `HOST` or defaults to
`127.0.0.1`. The adapter's `build/index.js` is excluded from the package.

Run one instance and one worker per workspace. An exclusive runtime reservation
prevents concurrent servers. `kozane open` refuses a conflict, and a directly
started server returns 503. Shutdown drains requests and releases the reservation.

Probe `/health` with the API key when configured. A successful database query
returns 200 with `status: "ok"`. Failure returns 503 with `status: "error"`.
Check the status field and consult logs for the underlying error.

Responses include `X-Request-Id`, and request completion and errors use JSON logs.
Capture standard output and standard error. Set log retention limits and alert on repeated restarts,
HTTP 5xx responses, failed readiness, disk exhaustion, and backup failures.

See the [Security matrix](./security-matrix.md) for access rules.

## Backup and recovery

Back up `.kozane/` while the server is stopped. To back up database data alone,
export it to a JSON file. Back up taskspace directories separately.

```sh
kozane db export backup.json
kozane db status
kozane doctor
```

Migrations create database backups automatically. Keep backups on another device,
define retention, and test `kozane db restore` before relying on them.
Stop the server before restoring. Restore validates SQLite integrity and migration
metadata before atomically replacing the database.

## Release gate

Run the full release gate with `pnpm verify:production`, or run its steps individually.

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm audit:production
pnpm smoke:package
pnpm test:e2e
```

The package smoke test checks installation, CLI operations, authenticated readiness,
security headers, access rejection, and export. Browser tests check login, card
creation and persistence, and unauthenticated access rejection.
