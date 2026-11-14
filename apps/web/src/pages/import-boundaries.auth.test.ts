import ts from "typescript";
import { expect, it } from "vitest";

// W3b ownership. Other workstreams append their view globs here.
const views = import.meta.glob<string>([
  "./LoginPage.tsx", "./RegisterPage.tsx", "./UnlockPage.tsx",
  "../components/app/ForgetLocalKeys*.tsx",
  "../components/avatar/AvatarPicker.tsx",
  "!../components/**/*.test.tsx",
], { query: "?raw", import: "default", eager: true });

it("keeps auth views behind the UI, feature, platform and i18n boundaries", () => {
  expect(Object.keys(views).length).toBeGreaterThanOrEqual(6);
  const violations: string[] = [];
  for (const [file, source] of Object.entries(views)) {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const check = (specifier: string, typeOnly: boolean) => {
      if (/(?:^|\/)i18n\//.test(specifier)) return;
      if (typeOnly && /(?:lib|stores)\//.test(specifier)) return;
      if (/(?:services|lib|stores)\/|^@e2ee-chat\/crypto/.test(specifier)) violations.push(`${file}: ${specifier}`);
    };
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        const named = clause?.namedBindings;
        const typeOnly = !!clause?.isTypeOnly || (!clause?.name && !!named && ts.isNamedImports(named) && named.elements.every((item) => item.isTypeOnly));
        check(node.moduleSpecifier.text, typeOnly);
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) check(node.moduleSpecifier.text, node.isTypeOnly);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) check(node.arguments[0].text, false);
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  expect(violations).toEqual([]);
});
