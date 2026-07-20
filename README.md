# Kozane

Kozane is a local-first, card-based thinking workspace with a browser UI, CLI, and a per-workspace SQLite-compatible database.

## Requirements

- Node.js 22 LTS or newer
- pnpm 10.12.1 for source builds

## Quick start

```sh
npm install --global kozane
mkdir my-workspace && cd my-workspace
kozane init
kozane project create "My project"
kozane open
```

The server defaults to `127.0.0.1:5173`. The `/health` endpoint checks server and database readiness.

## Security and remote access

Generate a per-workspace API key before allowing remote access:

```sh
kozane api key generate
kozane open --host 0.0.0.0 --allow-remote
```

The key is stored separately in `.kozane/api.json` with owner-only permissions. Once that file exists, every HTTP request requires the key. API clients can send `Authorization: Bearer <key>` (preferred) or `X-API-Key: <key>`. `kozane api key refresh` immediately replaces the old key.

The browser opened by `kozane open` is authenticated automatically. For a browser on another device, open `http://host:port/?api_key=<key>` once; Kozane exchanges the query parameter for an HttpOnly cookie and removes it from the URL.

`--allow-remote` always requires a generated key. Never expose plain HTTP directly to the public internet; use TLS, firewall restrictions, and an unprivileged runtime user.

## Upgrades and recovery

```sh
kozane db status
kozane db migrate
kozane db export
kozane db restore
kozane doctor
```

Migrations create a backup first. Back up the entire `.kozane` directory and test restores regularly.

## Development and releases

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm pack --dry-run
```

`pnpm verify` runs static checks, formatting, coverage thresholds, tests, and a clean production build. CI verifies Node 22, 24, and the latest release. Package builds clean `build/` and `dist/` first to prevent stale artifacts.

## License

See [LICENCE](./LICENCE).
