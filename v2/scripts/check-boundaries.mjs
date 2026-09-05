import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import ts from 'typescript';
const root = resolve('src');
const allowed = {
  geo: new Set(['geo']), generation: new Set(['geo', 'generation']),
  providers: new Set(['geo', 'generation', 'providers']),
  world: new Set(['geo', 'generation', 'world']),
  debug: new Set(['geo', 'generation', 'world', 'debug']),
  physics: new Set(['geo', 'generation', 'physics']),
  runtime: new Set(['geo', 'physics', 'runtime']),
};
const errors = [];
function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) { inspect(path); continue; }
    if (!entry.name.endsWith('.ts')) continue;
    const name = relative(root, path), domain = name.split(/[\\/]/)[0], text = readFileSync(path, 'utf8');
    if (/^(<{7}|={7}|>{7})( |$)/m.test(text)) errors.push(`${name}: unresolved merge marker`);
    if (/\bMath\.random\s*\(/.test(text)) errors.push(`${name}: unseeded randomness`);
    if (/@ts-(ignore|nocheck)/.test(text)) errors.push(`${name}: disabled type checking`);
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true);
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        const specifier = node.moduleSpecifier.text;
        const target = relative(root, resolve(dirname(path), specifier)), targetDomain = target.split(/[\\/]/)[0];
        if (!specifier.startsWith('.') || target.startsWith('..') || !allowed[domain]?.has(targetDomain)) errors.push(`${name}: forbidden dependency: ${specifier}`);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) errors.push(`${name}: dynamic import in CPU module`);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
inspect(root);
if (errors.length) throw new Error(errors.join('\n'));
console.log('CPU boundaries OK. Browser/network adapters remain outside CPU domains.');
