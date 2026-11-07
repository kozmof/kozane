# Package changes

Run `pnpm changeset` for changes to public packages. Select each affected package and describe the resulting behavior. Core API signature or result changes require a minor bump during 0.x and a major bump during 1.x.

Run `pnpm release:status` to review pending versions. Run `pnpm release:version` on a release branch to apply them and refresh the lockfile. Commit the package versions, changelogs and lockfile together. The initial changeset advances the existing CLI release while keeping the new core and client packages at 0.1.0.

See [the release guide](../docs/releases.md) for package checks and publishing.
