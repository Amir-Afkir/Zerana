import {buildSync} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const input=fileURLToPath(new URL('../tests/adapters/roads.test.mjs',import.meta.url));
const output=fileURLToPath(new URL('../build/roads-adapters.test.mjs',import.meta.url));
buildSync({entryPoints:[input],outfile:output,bundle:true,platform:'node',format:'esm',packages:'external'});
execFileSync(process.execPath,['--test',output],{stdio:'inherit'});
