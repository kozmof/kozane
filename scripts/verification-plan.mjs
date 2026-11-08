/** No build or pack command belongs in this plan. All checks consume the prepared outputs. */
export function verificationPlan(directory) {
  return [
    ["pnpm", ["release:check"]],
    ["pnpm", ["--filter", "kozane", "check"]],
    [
      process.execPath,
      [
        "scripts/check-core-package.mjs",
        "--client-package",
        "--client-browser-harness",
        "--restoration-harness",
        "--artifacts=" + directory,
      ],
    ],
    ...[
      "check:app-imports",
      "check:client-browser",
      "check:core-browser",
      "check:client-contract",
      "lint",
      "fmt:check",
      "test:coverage:source",
    ].map((name) => ["pnpm", [name]]),
  ];
}
