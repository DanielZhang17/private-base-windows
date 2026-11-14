import { expect, it } from "vitest";
import ts from "typescript";

// Each workstream appends its own globs. UiPreferencesEffects keeps its existing
// data access: W3a owns it only for theme-color syncing, not the preference logic.
const views = import.meta.glob([
  "../App.tsx", "./ChatListPage.tsx", "./ChatPage.tsx", "./CallPage.tsx",
  "../components/layout/**/*.tsx", "../components/chat/**/*.tsx",
  "../components/calls/**/*.tsx", "../components/user-picker/**/*.tsx",
  "../components/avatar/UserAvatar.tsx", "!../components/**/*.test.tsx",
], { eager: true, query: "?raw", import: "default" });

it.each(Object.entries(views))("W3a: %s keeps data and crypto behind features", (path, raw) => {
  const source = ts.createSourceFile(path, String(raw), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: string[] = [];
  function check(specifier: string, typeOnly = false) {
    if (/(?:^|\/)i18n\//.test(specifier)) return;
    if (specifier.includes("@e2ee-chat/crypto")) violations.push(specifier);
    else if (/(?:^|\/)(services|lib|stores|db|hooks)\//.test(specifier) && !(typeOnly && /(?:lib|stores)\//.test(specifier))) violations.push(specifier);
    else if (!specifier.startsWith(".") && !["react", "react-router", "react-router-dom"].includes(specifier)) violations.push(specifier);
  }
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const onlyTypes = clause?.isTypeOnly || (!!clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.name && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((binding) => binding.isTypeOnly));
      check(node.moduleSpecifier.text, !!onlyTypes);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) check(node.moduleSpecifier.text, node.isTypeOnly);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) check(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(violations).toEqual([]);
});
