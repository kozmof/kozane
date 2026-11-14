import { isDeepStrictEqual } from "node:util";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const args = process.argv.slice(2);
if (args.length !== 2 || args.some((arg) => arg.startsWith("-"))) {
  console.error("Usage: pnpm release:candidates <from-commit> <to-commit>");
  process.exit(1);
}
try {
  const [from, to] = args.map((ref) => git("rev-parse", "--verify", `${ref}^{commit}`).trim());
  // Disable rename detection so moves affect both the old and new package.
  const files = git("diff", "--no-renames", "--name-only", "-z", from, to, "--")
    .split("\0")
    .filter(Boolean);
  const packages = [
    { name: "@kozane/core", path: "packages/core/", dependents: ["@kozane/client", "kozane"] },
    { name: "@kozane/client", path: "packages/client/", dependents: ["kozane"] },
    { name: "kozane", path: "packages/kozane/", dependents: [] },
  ];
  function normalizeManifest(ref, file) {
    const value = JSON.parse(git("show", ref + ":" + file));
    delete value.version;
    for (const section of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      for (const pkg of packages) {
        if (typeof value[section]?.[pkg.name] === "string") {
          value[section][pkg.name] = value[section][pkg.name].replace(
            /^(workspace:)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
            "$1<version>",
          );
        }
      }
    }
    return value;
  }
  const relevantFiles = files.filter((file) => {
    if (file !== "package.json" && !packages.some((pkg) => file === pkg.path + "package.json"))
      return true;
    try {
      return !isDeepStrictEqual(normalizeManifest(from, file), normalizeManifest(to, file));
    } catch {
      return true; // Added or removed manifests count as changes.
    }
  });
  // Sources staged into published artifacts outside their package directories.
  const sharedInputs = [
    { prefix: "drizzle/", packages: ["@kozane/core", "kozane"] },
    { exact: "README.md", packages: ["kozane"] },
    { exact: "scripts/stage-package-readme.mjs", packages: ["kozane"] },
    { exact: "scripts/stage-cli-migrations.mjs", packages: ["kozane"] },
  ];
  const sharedFor = (file, name) =>
    sharedInputs.some(
      (input) =>
        input.packages.includes(name) &&
        (input.exact === file || (input.prefix && file.startsWith(input.prefix))),
    );
  const affected = new Map();
  for (const pkg of packages) {
    const changed = relevantFiles.filter(
      (file) => file.startsWith(pkg.path) || sharedFor(file, pkg.name),
    );
    if (!changed.length) continue;
    affected.set(pkg.name, [
      ...(affected.get(pkg.name) ?? []),
      `${changed.length} changed package or shared input file(s) for ${pkg.path}`,
    ]);
    for (const name of pkg.dependents) {
      affected.set(name, [...(affected.get(name) ?? []), `depends on changed ${pkg.name}`]);
    }
  }
  console.log(`Comparing ${from} to ${to}`);
  console.log(
    "Release candidates (includes dependency propagation; does not choose version bumps):",
  );
  for (const pkg of packages) {
    if (affected.has(pkg.name)) console.log(`  ${pkg.name}: ${affected.get(pkg.name).join("; ")}`);
  }
  if (!affected.size) console.log("  No release candidates.");
  const shared = relevantFiles.filter((file) => !packages.some((pkg) => file.startsWith(pkg.path)));
  if (shared.length) {
    console.log("Shared/root changes requiring release review:");
    for (const file of shared) console.log(`  ${file}`);
  }
} catch (error) {
  console.error(`Cannot compare commits: ${error.stderr?.toString().trim() || error.message}`);
  process.exitCode = 1;
}
