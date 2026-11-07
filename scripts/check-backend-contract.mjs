import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { matrixOperations } from "./backend-contract-matrix.mjs";

const root = new URL("../", import.meta.url);
function source(path) {
  return ts.createSourceFile(
    path,
    readFileSync(new URL(path, root), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}
const declarations = ["contract", "resources", "taskspaces-api"].map((name) =>
  source(`packages/client/src/backend/${name}.ts`),
);
const interfaces = new Map();
for (const file of declarations) {
  for (const statement of file.statements) {
    if (ts.isInterfaceDeclaration(statement)) interfaces.set(statement.name.text, statement);
  }
}
const expected = new Set();
const backend = interfaces.get("KozaneBackend");
if (!backend) throw new Error("KozaneBackend interface is missing");
for (const member of backend.members) {
  const name = member.name?.getText().replace(/^['"]|['"]$/g, "");
  if (ts.isMethodSignature(member)) expected.add(name);
  else if (member.type && ts.isTypeReferenceNode(member.type)) {
    const resource = interfaces.get(member.type.typeName.getText());
    if (!resource?.name.text.endsWith("Api")) continue;
    for (const method of resource.members) {
      if (ts.isMethodSignature(method)) expected.add(`${name}.${method.name.getText()}`);
    }
  }
}
const matrixURL = new URL("packages/client/src/backend/operation-matrix.md", root);
const matrix = readFileSync(matrixURL, "utf8");
const rows = matrixOperations(matrix);
const problems = [];
for (const method of expected) {
  const count = rows.filter((row) => row === method).length;
  if (count !== 1) problems.push(`${method} needs exactly one matrix row (found ${count})`);
}
for (const row of rows) if (!expected.has(row)) problems.push(`Unknown matrix operation: ${row}`);
for (const match of matrix.matchAll(/\]\(([^)]+)\)/g)) {
  if (/^(?:https?:|#)/.test(match[1])) continue;
  const url = new URL(match[1], matrixURL);
  if (!existsSync(fileURLToPath(url))) problems.push(`Missing matrix link: ${match[1]}`);
}
const fixture = source("src/test-utils/backend-inputs.typecheck.ts");
const aliases = new Map([["backend", ""]]);
const calls = new Set();
function access(node) {
  if (ts.isIdentifier(node)) return aliases.get(node.text);
  if (ts.isPropertyAccessExpression(node)) {
    const parent = access(node.expression);
    if (parent !== undefined) return parent ? `${parent}.${node.name.text}` : node.name.text;
  }
}
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    const value = access(node.initializer);
    if (value !== undefined) aliases.set(node.name.text, value);
  }
  if (ts.isCallExpression(node)) {
    const method = access(node.expression);
    if (method !== undefined) calls.add(method);
  }
  ts.forEachChild(node, visit);
}
visit(fixture);
for (const method of expected)
  if (!calls.has(method)) problems.push(`Consumer fixture does not call ${method}`);
if (problems.length) throw new Error(problems.join("\n"));
console.log(
  `Backend contract coverage passed for ${expected.size} methods, matrix rows and consumer calls.`,
);
