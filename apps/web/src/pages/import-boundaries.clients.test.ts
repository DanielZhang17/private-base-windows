// @vitest-environment node
import ts from "typescript";
import { expect, it } from "vitest";

// The public download page must not load session, store, API, database or crypto code:
// Direct visits to /clients and /clients/releases both mount ClientsApp (see main.tsx).
// Keys are paths relative to src/, e.g. "pages/ClientsPage.tsx".
const sources = Object.fromEntries(Object.entries(import.meta.glob<string>(
  ["../**/*.ts", "../**/*.tsx", "!../**/*.test.ts", "!../**/*.test.tsx", "!../**/*.d.ts"],
  { query: "?raw", import: "default", eager: true },
)).map(([path, source]) => [path.replace(/^\.\.\//, "").replace(/^\.\//, "pages/"), source]));
const forbidden = /^(stores|services|lib|db|hooks|components|workers)\//;

function join(fromFile: string, specifier: string): string {
  const parts = fromFile.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

function resolveImport(from: string, specifier: string): string | null {
  const base = join(from, specifier).replace(/\.js$/, "");
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((candidate) => candidate in sources) ?? null;
}

function importGraph(entry: string): { files: string[]; packages: string[] } {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const ast = ts.createSourceFile(file, sources[file], ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      let specifier: string | undefined;
      let typeOnly = false;
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        specifier = node.moduleSpecifier.text;
        const clause = node.importClause;
        const named = clause?.namedBindings;
        typeOnly = !!clause?.isTypeOnly || (!clause?.name && !!named && ts.isNamedImports(named) && named.elements.every((item) => item.isTypeOnly));
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifier = node.moduleSpecifier.text;
        typeOnly = node.isTypeOnly;
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        specifier = node.arguments[0].text;
      }
      if (specifier && !typeOnly) {
        if (specifier.startsWith(".")) {
          const target = resolveImport(file, specifier);
          if (target) queue.push(target);
          else if (!/\.(json|css)$/.test(specifier)) throw new Error(`${file}: cannot resolve ${specifier}`);
        } else packages.add(specifier);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return { files: [...seen], packages: [...packages] };
}

it("ClientsApp loads no session, store, API or crypto modules", () => {
  const { files, packages } = importGraph("ClientsApp.tsx");
  expect(files).toContain("pages/ClientsPage.tsx");
  expect(files).toContain("features/clients/useClientsPage.ts");
  expect(files).toContain("features/clients/ClientsReleaseNotes.tsx");
  expect(files.filter((file) => forbidden.test(file))).toEqual([]);
  expect(files.filter((file) => file.startsWith("platform/")).sort()).toEqual(["platform/clipboard.ts", "platform/environment.ts", "platform/external.ts"]);
  expect(packages.filter((name) => name.startsWith("@e2ee-chat/") || /sodium|idb|zustand|@tanstack/.test(name))).toEqual([]);
});
