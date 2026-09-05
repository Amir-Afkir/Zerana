import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import ts from 'typescript';

const root = resolve('src');
const allowed = {
  geo: new Set(['geo']),
  generation: new Set(['geo', 'generation']),
  world: new Set(['geo', 'generation', 'world']),
  debug: new Set(['geo', 'generation', 'world', 'debug']),
};
const errors = [];
function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) { inspect(path); continue; }
    if (!entry.name.endsWith('.ts')) continue;
    const name = relative(root, path), domain = name.split(/[\\/]/)[0];
    const text = readFileSync(path, 'utf8');
    if (/^(<{7}|={7}|>{7})( |$)/m.test(text)) errors.push(`${name}: unresolved merge marker`);
    if (/\bMath\.random\s*\(/.test(text)) errors.push(`${name}: unseeded randomness`);
    if (/@ts-(ignore|nocheck)/.test(text)) errors.push(`${name}: disabled type checking`);
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true);
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        const specifier = node.moduleSpecifier.text;
        const target = relative(root, resolve(dirname(path), specifier));
        const targetDomain = target.split(/[\\/]/)[0];
        if (!specifier.startsWith('.') || target.startsWith('..') || !allowed[domain]?.has(targetDomain)) {
          errors.push(`${name}: forbidden domain dependency: ${specifier}`);
        }
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        errors.push(`${name}: dynamic import in pure CPU modules`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
inspect(root);
if (errors.length) throw new Error(errors.join('\n'));
console.log('CPU domain boundaries OK: geo/generation/world/debug remain independent of Three.js, DOM and network.');
