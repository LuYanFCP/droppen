// The text an interface source can put on screen, read from the TypeScript
// syntax tree so comments and identifiers never count. Shared by the wording
// tests (`ui-wording.test.ts`: device, never machine or computer;
// `brand-name.test.ts`: Droppen, never the old internal name).
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/** One string the source holds: `shown` when it certainly reaches the screen (JSX text, a shown attribute, a `t()` key, a literal in JSX), otherwise any other string literal. */
export interface SourceText {
  line: number;
  text: string;
  shown: boolean;
}

/**
 * Every string `source` holds, in the order the syntax tree has them:
 * JSX text, the `aria-label` / `aria-description` / `title` / `placeholder` /
 * `alt` / `label` attributes, `{"…"}` and template literals in JSX, `t()`
 * keys, and what the browser itself puts on screen (`alert`, `confirm`) or a
 * toast would — all `shown`; any other string or template literal (another
 * attribute included) as not `shown`.
 */
export function sourceTexts(file: string, source: string): SourceText[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: SourceText[] = [];
  const say = (node: ts.Node, text: string, shown: boolean) => {
    out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text, shown });
  };
  const literalText = (n: ts.Node): string | null => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (ts.isTemplateExpression(n)) return [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(" ");
    return null;
  };
  // `t()` keys, and what the browser itself puts on screen (`alert`, `confirm`) or a toast would.
  const TRANSLATE = /^(?:t|tr|i18next\.t|i18n\.t|toast|alert|confirm|window\.alert|window\.confirm)$/;
  const visit = (n: ts.Node): void => {
    if (ts.isJsxText(n)) say(n, n.text, true);
    else if (ts.isJsxAttribute(n) && n.initializer) {
      // What a person reads or hears (`label` too, a prop of our own components). Any other attribute (a `data-testid`, a class) is code.
      const shown = /^(aria-label|aria-description|title|placeholder|alt|label)$/.test(n.name.getText(sf));
      const value = ts.isStringLiteral(n.initializer) ? n.initializer.text : ts.isJsxExpression(n.initializer) && n.initializer.expression ? literalText(n.initializer.expression) : null;
      if (value !== null) {
        say(n, value, shown);
        return;
      }
    } else if (ts.isCallExpression(n) && TRANSLATE.test(n.expression.getText(sf)) && n.arguments[0]) {
      const key = literalText(n.arguments[0]);
      if (key !== null) {
        say(n, key, true);
        n.arguments.slice(1).forEach(visit);
        return;
      }
    } else if (ts.isJsxExpression(n) && n.expression) {
      const text = literalText(n.expression);
      if (text !== null) {
        say(n, text, true);
        return;
      }
    } else {
      const text = literalText(n);
      if (text !== null) say(n, text, false);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Every `.ts` / `.tsx` file under `dir` (declarations aside), as absolute paths. */
export function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) files.push(path);
    }
  };
  walk(dir);
  return files;
}
