import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";

/** Host runtime code must resolve workspace libraries through their public export maps. */
function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "test-utils") inspect(file);
      continue;
    }
    if (!/\.(ts|svelte)$/.test(file) || /\.(test|fixtures)\.ts$/.test(file)) continue;
    const source = readFileSync(file, "utf8");
    const parts = file.endsWith(".svelte")
      ? [...source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1])
      : [source];
    for (const part of parts) {
      const tree = ts.createSourceFile(file, part, ts.ScriptTarget.Latest, true);
      function visit(node) {
        let value;
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        )
          value = node.moduleSpecifier.text;
        if (
          ts.isImportTypeNode(node) &&
          ts.isLiteralTypeNode(node.argument) &&
          ts.isStringLiteral(node.argument.literal)
        )
          value = node.argument.literal.text;
        if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
          node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0])
        )
          value = node.arguments[0].text;
        if (value && /(?:^|\/)(?:client|core)\/src\//.test(value))
          throw new Error(`Private workspace import in ${file}: ${value}`);
        if (value && /^@kozane\/(?:client|core)\/(?:src|dist)(?:\/|$)/.test(value))
          throw new Error(`Private package import in ${file}: ${value}`);
        ts.forEachChild(node, visit);
      }
      visit(tree);
    }
  }
}
inspect(fileURLToPath(new URL("../packages/kozane/src", import.meta.url)));
console.log("Application runtime uses public core and client package imports.");
