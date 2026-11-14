// @vitest-environment node
import { expect, it } from "vitest";
import ts from "typescript";
// Append each workstream's views here. Tests may import their test infrastructure.
const views = import.meta.glob([
  "./SettingsPage.tsx", "./DeviceLinkPage.tsx", "./VerifyPage.tsx",
  "../components/avatar/AvatarPicker.tsx",
], { query: "?raw", import: "default", eager: true });
it.each(Object.entries(views))("%s keeps application logic behind features", (file, source) => {
  const ast = ts.createSourceFile(file, source as string, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const forbidden: string[] = [];
  function check(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const path = node.moduleSpecifier.text;
      const typeOnly = node.importClause?.isTypeOnly || (node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.every((element) => element.isTypeOnly));
      const allowed = /^(react|react-router|react-router-dom)$/.test(path) || /(^|\/)(ui|features|platform|i18n)\//.test(path) || (typeOnly && /(^|\/)(lib|stores)\//.test(path));
      if (!allowed) forbidden.push(path);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) forbidden.push(node.getText(ast));
    ts.forEachChild(node, check);
  }
  check(ast); expect(forbidden).toEqual([]);
});
