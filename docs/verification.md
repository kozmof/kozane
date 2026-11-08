# Choose verification checks

Run checks from the workspace root. Use Node 24 or later and the pnpm version
declared in `package.json`.

| Change                                  | Checks                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------- |
| Core services or database behavior      | `pnpm test`, `pnpm check:core-browser`                                 |
| Client contracts or adapters            | `pnpm test`, `pnpm check:client-contract`, `pnpm check:client-browser` |
| Svelte views or application integration | `pnpm check`, `pnpm test`, `pnpm test:e2e`                             |
| Package exports or build output         | `pnpm test:packages`                                                   |
| Persistence recovery                    | `pnpm test:restoration-harness`                                        |
| Release scripts or versioning           | `pnpm release:check`                                                   |
| Documentation                           | Check local links and verify commands against `package.json`           |

Run `pnpm lint` and `pnpm fmt:check` for source changes. Build the application
with `pnpm build` before running application end-to-end tests.

Run `pnpm verify` for the workspace verification plan. The plan is defined in
`scripts/verification-plan.mjs`. Use `pnpm verify:production` when checking a
production candidate, including package installation and browser behavior.

## Choose checks for a change

| Change                      | Checks                                                    |
| --------------------------- | --------------------------------------------------------- |
| Core validation or services | `pnpm test`                                               |
| Database adapters           | `pnpm check:core-package` and `pnpm test:db-wasm`         |
| Browser database adapters   | Also run `pnpm test:db-browser`                           |
| Public types or exports     | `pnpm check:core-package` and `pnpm check:client-package` |
| Client views or lifecycle   | `pnpm test` and `pnpm test:client-package`                |
| Restoration                 | `pnpm test:restoration-harness`                           |
| Host integration            | `pnpm check:app-imports` and `pnpm check`                 |
| Formatting and lint         | `pnpm fmt:check` and `pnpm lint`                          |

The verification plan consumes prepared artifacts. Use `pnpm verify` to run the
workspace verification entry point. Use `pnpm release:local` for release preparation.

For every driver, retain consumer checks for committed writes, rollback after
callback failure, reads after rollback and subsequent successful writes. Test
commit and rollback failures in the host that owns the driver hooks.
