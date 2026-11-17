import ts from "typescript";
import { expect, it } from "vitest";
const views = import.meta.glob<string>(["../pages/**/*.tsx", "../components/**/*.tsx", "../ui/**/*.tsx", "../features/updates/**/*.tsx", "!../**/*.test.tsx"], { eager: true, query: "?raw", import: "default" });
// Proper names and the literal confirmation token are intentionally unchanged.
const allowed = new Set(["Private Base", "Genshin", "#14586e"]);
const props = new Set(["placeholder", "aria-label", "title", "label", "description", "subtitle", "help", "confirmLabel", "cancelLabel", "acknowledgeLabel", "alt"]);
function translationViolations(file: string, text: string): string[] {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: string[] = [];
  function check(value: string, node: ts.Node) {
    if (/[a-zA-Z]/.test(value) && !allowed.has(value.trim())) violations.push(`${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: ${value.trim()}`);
  }
  function literals(node: ts.Node) {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return;
    if (ts.isCallExpression(node) && (node.expression.getText(ast) === "t" || node.expression.getText(ast).endsWith(".t"))) return;
    if (ts.isConditionalExpression(node)) { literals(node.whenTrue); literals(node.whenFalse); return; }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) check(node.text, node);
    if (ts.isTemplateExpression(node)) {
      check(node.head.text + node.templateSpans.map((span) => span.literal.text).join(""), node);
      return;
    }
    ts.forEachChild(node, literals);
  }
  function containsTranslation(node: ts.Node): boolean {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return false;
    if (ts.isCallExpression(node) && (node.expression.getText(ast) === "t" || node.expression.getText(ast).endsWith(".t"))) return true;
    return ts.forEachChild(node, containsTranslation) ?? false;
  }
  function containsJsx(node: ts.Node): boolean {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return true;
    return ts.forEachChild(node, containsJsx) ?? false;
  }
  function checkTextRuns(children: ts.NodeArray<ts.JsxChild>) {
    let run: ts.Node[] = [];
    function flush() {
      if (run.length > 1 && run.some(containsTranslation)) violations.push(`${ast.getLineAndCharacterOfPosition(run[0].getStart(ast)).line + 1}: adjacent translation and text; use interpolation`);
      run = [];
    }
    for (const child of children) {
      if (ts.isJsxText(child)) { if (child.text.trim()) run.push(child); }
      else if (ts.isJsxExpression(child)) { if (child.expression && containsJsx(child.expression)) flush(); else if (child.expression) run.push(child.expression); }
      else flush();
    }
    flush();
  }
  function visit(node: ts.Node) {
    if (ts.isJsxText(node)) check(node.text, node);
    if (ts.isJsxAttribute(node) && props.has(node.name.getText(ast)) && node.initializer) literals(node.initializer);
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) checkTextRuns(node.children);
    if ((ts.isTemplateExpression(node) || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)) && containsTranslation(node)) violations.push(`${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: concatenated translation; use interpolation`);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return violations;
}
it.each(Object.entries(views))("%s contains no untranslated JSX copy", (file, text) => {
  expect(translationViolations(file, text)).toEqual([]);
});
it.each([
  '<p>{t("loadingStatus")} {fileName}...</p>',
  '<p>{name} {t("messageReadStatus")}</p>',
  '<p aria-label={`Name: ${t("selfDisplayName")}`}/>',
  '<p>{t("selfDisplayName") + ": " + preview}</p>',
])("rejects translation fragments in %s", (source) => {
  expect(translationViolations("fixture.tsx", source).some((violation) => /adjacent|concatenated/.test(violation))).toBe(true);
});
it("allows complete messages and separate UI elements", () => {
  expect(translationViolations("fixture.tsx", '<p>{t("fileLoadFailedNamed", { name })}<button>{t("retry")}</button></p>')).toEqual([]);
});
