# Release packages

Kozane publishes three public packages. Release core first, client second and the unscoped CLI last. The client has an exact core peer version. The CLI has exact core and client runtime versions. The repository root stays private.

## Prepare versions

Run `pnpm changeset` when changing a public package. Use a minor core bump for API signature or result changes during 0.x, and a major bump during 1.x. Include a client change when it adopts a changed core API.

Run `pnpm release:status` to review the plan. Run `pnpm release:version` to apply it and refresh the lockfile. Review and commit the generated changelogs, versions and lockfile. Changesets updates exact peer and workspace dependency versions. Its automatic formatter is disabled so formatting follows the repository tools.

Run `pnpm release:check` to verify public package metadata and exact dependency versions. The check also applies two releases in a temporary workspace to test coordinated core/client upgrades. Run the normal verification and browser CI before merging the release commit to main.

## Configure npm

Before the first publication, create the kozane organization under kozmof and require 2FA for publishing. Confirm ownership of the scope before publishing either scoped package. If that scope is unavailable, apply the specification's fallback names consistently before release.

Configure each package's npm trusted publisher for this repository, the `release.yml` workflow and the `npm` GitHub environment. Package creation or an initial authenticated publication may be needed before npm exposes these settings. Configure required reviewers on the GitHub environment if releases need approval. These account and environment settings are external to this repository.

The workflow grants `id-token: write` for npm authentication and publishes with provenance. Trusted publishing requires a public repository for provenance and a supported npm CLI. The Node 24 runner provides the release toolchain. See the [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/) for account setup.

## Run the release workflow

Dispatch `Release packages` from main with `dry-run` enabled first. It installs the frozen lockfile, checks release versions, runs verification, audits production dependencies, tests local and global package installation, and runs the browser suites. Recursive pnpm publishing follows package dependencies and keeps the private tooling root out of the release.

Review the successful dry run. Dispatch the same commit with `dry-run` disabled to publish. The workflow serializes release dispatches and reruns the checks before publishing. `pnpm publish:npm` is the underlying recursive publication command and changes npm when invoked.

Publication is not atomic across the three packages. If it stops after a successful package publication, retain those versions and rerun the same release commit after fixing the failure. Never reuse a published version for different bytes.

After publication, verify all three versions through fresh registry installations, including `npm install --global kozane`, and check the provenance links. Gate 4 remains open until publication and registry installation evidence are recorded. Local archives and dry runs do not satisfy that gate.
