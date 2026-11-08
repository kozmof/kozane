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
