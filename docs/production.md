# Production operations

Kozane is a single-user, single-workspace application. It is suitable for localhost use and
for access on a trusted network behind an authenticated TLS reverse proxy. It is not a
multi-tenant service and does not provide user accounts or role-based access control.

## Supported runtime

- Pin Node.js 24 LTS for production. Do not deploy a moving `latest` image.
- Install with `pnpm install --frozen-lockfile`, run `pnpm verify`, and build with
  `pnpm build`.
- Run the service as an unprivileged operating-system user with write access only to its
  workspace.

## Secure remote access

Generate a workspace key before binding to a non-loopback address:

```sh
kozane api key generate
kozane open --host 0.0.0.0 --allow-remote --no-open
```

The server independently fails closed when `HOST` is non-loopback and no key exists, even
if it is launched without the CLI. It also rejects remotely bound requests unless SvelteKit sees
an HTTPS URL. Put it behind a TLS reverse proxy, restrict ingress with a
firewall, and do not log URLs containing the one-time `api_key` query parameter. Configure the
Node adapter for the exact proxy chain (for a single trusted proxy, typically
`ADDRESS_HEADER=x-forwarded-for`, `XFF_DEPTH=1`, and `PROTOCOL_HEADER=x-forwarded-proto`). Never
accept these headers directly from untrusted clients.

The Node listener itself remains HTTP and should only be reachable by the proxy. A missing or
incorrect `PROTOCOL_HEADER` configuration causes requests to fail closed with HTTP 426.

The built-in authentication throttle is intentionally process-local. Configure rate limiting at
the reverse proxy or ingress so limits survive restarts and cover every instance.

`ADDRESS_HEADER` matters to that throttle as much as to your logs. The throttle counts
failures per client address, and without the header every request behind the proxy arrives
from the proxy's own address. All remote clients then share one counter, so a single client
failing to authenticate can throttle everyone else. Configure the proxy chain before allowing remote
access, not after.

Rotate the key with `kozane api key refresh`. Rotation immediately invalidates the previous
key. Treat `.kozane/api.json` as a secret and never copy it into logs or source control.

## Process and health management

Use a process supervisor such as systemd, Docker, or your platform's service manager. Configure
automatic restart with a bounded backoff and graceful `SIGTERM` shutdown. Probe `/health`
with the API key. It verifies that the database accepts queries.

Run only one Kozane server per workspace, enforced by an exclusive runtime reservation.
`kozane open` checks the reservation before it starts anything and refuses outright. A server
started directly (`node build/index.js`) against a workspace another process already holds
answers every request with HTTP 503 naming the process that holds it, and logs the conflict
once. `kozane open` forwards `SIGINT` and `SIGTERM` to the Node server so the adapter can
drain connections before exit.

Each HTTP response includes `X-Request-Id`. Request completion and errors are emitted as JSON.

Capture stdout/stderr in structured platform logs, set retention limits, and alert on repeated
restarts, HTTP 5xx responses, failed health checks, disk exhaustion, and backup failures.

## Backup and recovery

Back up the complete `.kozane` directory on a regular schedule while the process is stopped,
or use:

```sh
kozane db export
kozane db status
kozane doctor
```

Migrations create a database backup automatically. Keep backups on a different device, define
a retention policy, and rehearse `kozane db restore` at least once before relying on them.
Restore refuses to run while a recorded Kozane server process is active. Stop the service before
restoring. Restore validates SQLite integrity and migration metadata before atomically replacing
the current database.

## Release gate

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm audit:production
pnpm smoke:package
pnpm test:e2e
```

The smoke test packs and installs the tarball, then exercises its CLI, initializes a real
workspace, starts the packaged server, checks authenticated readiness and security headers,
rejects an unauthenticated request,
and exports the database.

The browser test starts the built server against a temporary real workspace, verifies the
one-time API-key exchange, hydrates the project UI in Chromium, creates and reloads a card,
and confirms that an unauthenticated browser remains locked out. Run `pnpm verify:production`
to execute the complete release gate locally.
