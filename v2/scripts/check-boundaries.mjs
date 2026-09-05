import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import ts from 'typescript';

const root = resolve('src/geo');
const errors = [];
for (const name of readdirSync(root).filter((name) => name.endsWith('.ts'))) {
  const path = resolve(root, name), text = readFileSync(path, 'utf8');
  if (/^(<{7}|={7}|>{7})( |$)/m.test(text)) errors.push(`${name}: unresolved merge marker`);
  if (/\bMath\.random\s*\(/.test(text)) errors.push(`${name}: unseeded randomness`);
  if (/@ts-(ignore|nocheck)/.test(text)) errors.push(`${name}: disabled type checking`);
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true);
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const specifier = node.moduleSpecifier.text;
      const target = resolve(dirname(path), specifier);
      if (!specifier.startsWith('./') || relative(root, target).startsWith('..')) {
        errors.push(`${name}: import/export leaves the geo kernel: ${specifier}`);
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      errors.push(`${name}: dynamic imports forbidden in geo kernel`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
if (errors.length) throw new Error(errors.join('\n'));
console.log('Geo boundaries OK: no application, DOM, network or Three.js dependencies.');
