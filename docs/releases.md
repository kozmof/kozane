# Release packages locally

Prepare and publish Kozane from your workstation. This project has no CI/CD release workflow. Test CI remains available, but publication does not depend on a workflow dispatch or GitHub environment.

The packages publish in dependency order as core, client and the unscoped CLI. Client declares an exact core peer. The CLI declares exact core and client runtime versions. The repository root stays private.

## Prepare versions

Run `pnpm changeset` for a public package change. Core API signature or result changes require a minor bump during 0.x and a major bump during 1.x. Include a client change when it adopts a changed core API.

Run `pnpm release:status` to review the plan. Run `pnpm release:version` to update package versions and changelogs and refresh the lockfile. Review formatting and commit the resulting files. The initial candidate versions are core 0.1.0, client 0.1.0 and kozane 0.22.0.

## Prepare a local release

Use Node 24 or newer and the pinned pnpm toolchain. Install dependencies with `pnpm install --frozen-lockfile`. Install the browser used by the local checks with `pnpm exec playwright install chromium`.

Commit all source changes, then run the local release checks.

```sh
pnpm release:local
```

This runs release metadata and versioning regressions, verification and coverage, production dependency auditing, local/global archive installation and HTTP smoke, and the app, restoration and public-client browser suites. It builds once and packs all three packages once with lifecycle rebuilds disabled. Verification, installed-package tests, browser fixtures, installation smoke and npm dry-run publication consume those same archives. It writes a release manifest containing their versions, SHA-256 hashes and source commit under `tmp/releases/<commit>/`. An optional directory argument chooses another destination.

Database driver parity checks are optional and are not part of release preparation. Run `pnpm test:db-wasm` or `pnpm test:db-browser` separately when needed.

Preparation does not publish. It rejects uncommitted source changes and writes the manifest only after every check passes. Keep the prepared directory until publication is verified. Use the full commit hash and archive hashes when recording release evidence.

For a narrower installation check during development, run `pnpm smoke:package:install`. This builds and installs all three candidate archives locally and globally without starting a server. `pnpm smoke:package` also checks the installed HTTP server. Neither command substitutes for release preparation.

## Authenticate and publish

Confirm that kozmof owns the kozane npm organization and that publishing requires 2FA. If the scope is unavailable, apply the specification's fallback package names throughout the repository before preparing the release. Log in locally with `npm login --registry=https://registry.npmjs.org/` and check the account with `npm whoami`.

Publish the prepared directory explicitly.

```sh
pnpm release:publish tmp/releases/<commit>
```

The publisher requires a clean checkout at the prepared commit. It checks package order, versions, archive filenames and hashes before contacting npm. It publishes those archives with lifecycle scripts disabled, so publication cannot rebuild them. npm handles your account authentication and 2FA challenge. `pnpm publish:npm <directory>` is an alias for the same local publisher.

Publication is not atomic across packages. A rerun skips a published version only when its registry integrity matches the prepared archive. It rejects an existing version with different bytes and preserves unpublished archives for investigation.

The local flow does not request CI-generated npm provenance. Registry checks accept local publications without that metadata. If npm supplies provenance metadata, the check validates and records its registry link. It does not verify the signed attestation itself. This local publishing policy replaces the specification's earlier GitHub Actions provenance requirement at the user's request.

## Verify publication

The publisher runs `pnpm release:verify:registry` after all three packages are published. Run it again to repeat the checks independently.

It checks exact registry versions, repository paths, runtime and peer pins and integrity metadata. It installs those exact versions from the public registry locally and globally, checks both CLI versions and shared runtime identity, and tests the installed HTTP server. Registry mode does not build or substitute candidate archives.

Retain the prepared manifest and registry verification output as release evidence. Publish and verify the intended package pair before starting the [web demo tasks](web-demo-tasks.md).

## Development verification

Run `pnpm verify` to build and pack once, then check the prepared outputs. Source unit tests use `vitest.source.config.ts` and source aliases. Installed-package tests use `vitest.package.config.ts` without source aliases. Run `pnpm test:packages` to prepare an isolated installation and run its public runtime tests.

Normal builds check committed migration records and schema without rewriting them. After editing the application schema, run `pnpm db:generate`, review the SQL and generated core inputs, and commit them together.
