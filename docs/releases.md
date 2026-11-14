# Release packages locally

Prepare and publish Kozane from your workstation. CI runs tests. Publication uses
the local commands below and does not require a GitHub workflow or environment.

The packages publish in dependency order as core, client and the unscoped CLI. Client declares an exact core peer. The CLI declares exact core and client runtime versions. The repository root stays private.

## Prepare versions

Run `pnpm changeset` for a public package change. Core API signature or result changes require a minor bump during 0.x and a major bump during 1.x. Include a client change when it adopts a changed core API.

Run `pnpm release:status` to review the plan. Run `pnpm release:version` to update package versions and refresh the lockfile. Review formatting and commit the resulting files. Use the versions in the package manifests.

## Release with one command

After finalizing versions, committing changes and completing the tool setup below, run the release command.

```sh
pnpm release:auto
```

This prepares and publishes core, client and kozane in dependency order, then verifies their registry installations. It uses the versions already committed in the package manifests. It does not bump versions or create commits.

After preparation, the command checks npm authentication with `npm whoami`. If that check fails, it runs `npm login --registry=https://registry.npmjs.org/` and verifies the account before publishing. Existing authentication is reused. npm 2FA prompts still apply.

If a prepared release already exists for the current commit, the command reuses it. Rerun the command after a partial publication to resume with the same archives. The publisher validates the manifest and archive hashes and skips published versions only when their bytes match. Preparation failures stop publication.

`release:auto` skips Playwright browser execution because those suites run in CI. Source coverage, package checks, browser compilation, auditing, and smoke checks still run. Use `pnpm release:local` for full local preparation with browser tests. A source test failure still stops automatic release.

## Prepare a local release

Use Node 24 or newer and the pinned pnpm toolchain. Install dependencies with `pnpm install --frozen-lockfile`. Install the browser used by the local checks with `pnpm exec playwright install chromium`.

Commit all source changes, then run the local release checks.

```sh
pnpm release:local
```

This runs release metadata and versioning regressions, verification and coverage, production dependency auditing, local/global archive installation and HTTP smoke, and the app, restoration and public-client browser suites. It builds once and packs all three packages once with lifecycle rebuilds disabled. Verification, installed-package tests, browser fixtures, installation smoke and npm dry-run publication consume those same archives.

It writes a release manifest containing their versions, SHA-256 hashes and source commit under `tmp/releases/<commit>/`. An optional directory argument chooses another destination.

Database driver parity checks are optional and are not part of release preparation. Run `pnpm test:db-wasm` or `pnpm test:db-browser` separately when needed.

Installed core package checks stage their consumers under the ignored `tmp/package-checks/` directory. This keeps native driver libraries off restricted system temporary mounts, even when the tool sandbox resets `TMPDIR`. Temporary consumers are removed after checks.

Preparation does not publish. It rejects uncommitted source changes and writes the manifest only after every check passes. Keep the prepared directory until publication is verified. Use the full commit hash and archive hashes when recording release evidence.

For a narrower installation check during development, run `pnpm smoke:package:install`. This builds and installs all three candidate archives locally and globally without starting a server. `pnpm smoke:package` also checks the installed HTTP server. Neither command substitutes for release preparation.

## Authenticate and publish

```sh
pnpm release:publish tmp/releases/<commit>
```

The publisher requires a clean checkout at the prepared commit. It checks package order, versions, archive filenames and hashes before contacting npm. It publishes those archives with lifecycle scripts disabled, so publication cannot rebuild them. npm handles your account authentication and 2FA challenge.

Publication is not atomic across packages. A rerun skips a published version only when its registry integrity matches the prepared archive. It rejects an existing version with different bytes and preserves unpublished archives for investigation.

The local flow does not request CI-generated npm provenance. Registry checks accept local publications without that metadata. If npm supplies provenance metadata, the check validates and records its registry link. It does not verify the signed attestation itself. The local release flow defines the publication policy.

## Verify publication

The publisher runs `pnpm release:verify:registry` after all three packages are published. Run it again to repeat the checks independently.

It checks exact registry versions, repository paths, runtime and peer pins and integrity metadata. It installs those exact versions from the public registry locally and globally, checks both CLI versions and shared runtime identity, and tests the installed HTTP server. Registry mode does not build or substitute candidate archives.

Retain the prepared manifest and registry verification output as release evidence. Publish and verify the intended package pair before starting the [web demo tasks](web-demo-tasks.md).

## Development verification

Run `pnpm verify` to build and pack once, then check the prepared outputs.

Source unit tests use `vitest.source.config.ts` and source aliases. Installed-package tests use `vitest.package.config.ts` without source aliases. Run `pnpm test:packages` to prepare an isolated installation and run its public runtime tests.

Normal builds check committed migration records and schema without rewriting them. After editing the application schema, run `pnpm db:generate`, review the SQL and generated core inputs, and commit them together.

Retain a verified candidate when later checks need the same archives.

```sh
pnpm verify --output=tmp/verified-packages
pnpm smoke:package --artifacts=tmp/verified-packages
```

The verifier checks that its prepared archive hashes remain unchanged. Pass `--artifacts=<directory>` to verify existing archives without rebuilding. Run `pnpm build:packages --output=tmp/packages` to build and pack a candidate without running verification.

Each CI verification job retains its candidate and passes those archives to package smoke checks. The browser job builds its own candidate once, compiles both harnesses from those archives and runs the suites without rebuilding packages.

Jobs remain independent so the Node versions and browser checks can run in parallel. These are test workflows. Publication continues through the local release flow.
