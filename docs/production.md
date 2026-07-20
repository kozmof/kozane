# Production operations

Kozane is a single-user, single-workspace application. It is suitable for localhost use and
for access on a trusted network behind an authenticated TLS reverse proxy. It is not a
multi-tenant service and does not provide user accounts or role-based access control.

## Supported runtime

- Pin Node.js 22 or 24 LTS; do not deploy a moving `latest` image.
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
if it is launched without the CLI. Put it behind a TLS reverse proxy, restrict ingress with a
firewall, and do not log URLs containing the one-time `api_key` query parameter.

Rotate the key with `kozane api key refresh`. Rotation immediately invalidates the previous
key. Treat `.kozane/api.json` as a secret and never copy it into logs or source control.

## Process and health management

Use a process supervisor such as systemd, Docker, or your platform's service manager. Configure
automatic restart with a bounded backoff and graceful `SIGTERM` shutdown. Probe `/health`
with the API key; it verifies that the database accepts queries.

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

## Release gate

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm pack --pack-destination "$(mktemp -d)"
pnpm smoke:production
```

The smoke test exercises the built CLI, initializes a real workspace, starts the packaged
server, checks authenticated readiness and security headers, rejects an unauthenticated request,
and exports the database.
