import { runPanda, buildStyles } from "./styles.mjs";
import fs from "node:fs/promises";
import { existsSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { execFileSync } from "node:child_process";
const root = fileURLToPath(new URL("../../..", import.meta.url));
const packageRoot = path.join(root, "packages/client");
runPanda(root, packageRoot, ["codegen"]);
const staging = path.join(packageRoot, "tmp/source");
await fs.rm(staging, { recursive: true, force: true });
await fs.mkdir(staging, { recursive: true });
const inputSource = () =>
  readFileSync(path.join(root, "packages/core/src/services/inputs.ts"), "utf8");
let inputDeclarations;
const queue = [],
  visited = new Set();
const slash = (value) => value.split(path.sep).join("/");
function local(source, importer) {
  const target = source.startsWith("$lib/")
    ? path.join(root, "src/lib", source.slice(5))
    : source.startsWith("$db/")
      ? path.join(root, "src/db", source.slice(4))
      : source.startsWith("styled-system/")
        ? path.join(root, source)
        : source.startsWith(".")
          ? path.resolve(path.dirname(importer), source)
          : undefined;
  if (!target) return;
  for (const file of [
    target,
    target.replace(/\.js$/, ".ts"),
    target + ".ts",
    target + ".d.ts",
    target + ".svelte",
    target + ".mjs",
    path.join(target, "index.ts"),
    path.join(target, "index.mjs"),
  ])
    if (existsSync(file) && statSync(file).isFile())
      return file === path.join(root, "src/lib/constants.ts")
        ? path.join(packageRoot, "src/constants/index.ts")
        : file === path.join(root, "src/lib/ui-config.ts")
          ? path.join(packageRoot, "src/ui-config.ts")
          : file === path.join(root, "src/lib/constants/canvas.ts")
            ? path.join(packageRoot, "src/constants/canvas.ts")
            : file === path.join(root, "src/lib/warp-list.ts")
              ? path.join(packageRoot, "src/warp-list.ts")
              : file === path.join(root, "src/lib/tag/truncation.ts")
                ? path.join(packageRoot, "src/tag/truncation.ts")
                : file;
  throw new Error(`Unresolved client import ${source} from ${importer}`);
}
function destination(file) {
  const relative = slash(path.relative(root, file));
  if (relative.startsWith("src/lib/server/"))
    throw new Error(`Client cannot contain server modules: ${relative}`);
  if (relative.startsWith("packages/client/src/backend/"))
    return "lib/backend/" + relative.slice("packages/client/src/backend/".length);
  if (relative.startsWith("packages/client/src/"))
    return "lib/client/" + relative.slice("packages/client/src/".length);
  if (relative.startsWith("src/lib/")) return relative.slice(4);
  if (relative.startsWith("styled-system/")) return relative.replace(/\.mjs$/, ".js");
  throw new Error(`Client closure cannot contain ${relative}`);
}
function reference(target, importer) {
  let relative = slash(path.relative(path.dirname(destination(importer)), destination(target)));
  if (!relative.startsWith(".")) relative = "./" + relative;
  return relative.replace(/\.d\.ts$/, ".js").replace(/\.ts$/, ".js");
}
function rewrite(source, importer) {
  const tree = ts.createSourceFile(
    importer,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const edits = [];
  function visit(node) {
    let literal;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      literal = node.moduleSpecifier;
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      literal = node.argument.literal;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      throw new Error(`Dynamic client import needs explicit packaging support: ${importer}`);
    if (literal) {
      const specifier = literal.text;
      const target = local(specifier, importer);
      if (!target) {
        if (
          !["svelte", "@kozmof/reed", "@kozane/core", "@kozane/core/services"].includes(
            specifier,
          ) &&
          !specifier.startsWith("svelte/")
        )
          throw new Error(`Undeclared client dependency ${specifier}`);
      } else {
        const relative = slash(path.relative(root, target));
        // Panda authoring augmentations belong to build tooling, not consumer declarations.
        if (relative === "styled-system/types/global.d.ts") {
          edits.push({ start: node.getStart(tree), end: node.end, text: "" });
          return;
        }
        if (
          relative === "src/services/inputs.ts" &&
          ts.isExportDeclaration(node) &&
          node.isTypeOnly &&
          !node.exportClause
        ) {
          const inputs = ts.createSourceFile(
            target,
            (inputDeclarations ??= inputSource()),
            ts.ScriptTarget.Latest,
            true,
          );
          const names = inputs.statements
            .filter(
              (statement) =>
                (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) &&
                statement.modifiers?.some(
                  (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
                ),
            )
            .map((statement) => statement.name.text);
          edits.push({
            start: node.getStart(tree),
            end: node.end,
            text: `export type { ${names.join(", ")} } from "@kozane/core";`,
          });
          return;
        }
        let replacement;
        if (
          [
            "src/db/api/types.ts",
            "src/db/api/card.ts",
            "src/lib/types.ts",
            "src/services/inputs.ts",
            "src/services/errors.ts",
            "src/services/map.ts",
            "src/services/tags.ts",
          ].includes(relative)
        )
          replacement = "@kozane/core";
        else if (relative === "src/services/prepare-input.ts")
          replacement = "@kozane/core/services";
        else if (
          relative.startsWith("src/services/") &&
          ts.isImportDeclaration(node) &&
          node.importClause?.isTypeOnly &&
          node.importClause.namedBindings &&
          ts.isNamespaceImport(node.importClause.namedBindings)
        ) {
          const resource = path.basename(relative, ".ts");
          edits.push({
            start: node.getStart(tree),
            end: node.end,
            text: `import type { ${resource} as ${node.importClause.namedBindings.name.text} } from "@kozane/core/services";`,
          });
          return;
        } else {
          destination(target);
          replacement = reference(target, importer);
          queue.push(target);
        }
        edits.push({
          start: literal.getStart(tree),
          end: literal.end,
          text: JSON.stringify(replacement),
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  for (const edit of edits.sort((a, b) => b.start - a.start))
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return source;
}
for (const name of ["index", "ui", "testing", "board", "tags", "map", "editor"]) {
  const entry =
    name === "index"
      ? path.join(packageRoot, "src/backend/index.ts")
      : name === "testing"
        ? path.join(packageRoot, "src/backend/testing/index.ts")
        : path.join(packageRoot, "src", name === "ui" ? "ui.ts" : `${name}/index.ts`);
  queue.push(entry);
  await fs.writeFile(
    path.join(staging, `${name}.ts`),
    `export * from "./${destination(entry).replace(/\.ts$/, ".js")}";\n`,
  );
}
while (queue.length) {
  const file = queue.pop();
  if (visited.has(file)) continue;
  visited.add(file);
  const output = path.join(staging, destination(file));
  await fs.mkdir(path.dirname(output), { recursive: true });
  let source = await fs.readFile(file, "utf8");
  if (slash(path.relative(root, file)).startsWith("src/lib/")) {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    if (
      !tree.statements.every(
        (node) =>
          ts.isImportDeclaration(node) ||
          ts.isExportDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isEmptyStatement(node),
      )
    )
      throw new Error(`Client cannot copy application helper implementations: ${file}`);
  }
  if (file.endsWith(".svelte"))
    source = source.replace(
      /(<script[^>]*>)([\s\S]*?)(<\/script>)/g,
      (_all, open, script, close) => open + rewrite(script, file) + close,
    );
  else source = rewrite(source, file);
  await fs.writeFile(output, source);
  if (file.endsWith(".mjs") && existsSync(file.replace(/\.mjs$/, ".d.ts")))
    queue.push(file.replace(/\.mjs$/, ".d.ts"));
}
execFileSync(
  "pnpm",
  ["exec", "svelte-package", "--input", staging, "--output", "dist", "--tsconfig", "tsconfig.json"],
  { cwd: packageRoot, stdio: "inherit" },
);
await buildStyles(root, packageRoot);
console.log(`Packaged ${visited.size} client modules with public core imports.`);
