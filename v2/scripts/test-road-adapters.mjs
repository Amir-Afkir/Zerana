import {buildSync} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
for(const name of ['roads','real-engineering','environment','water','hydro']) {
const input=fileURLToPath(new URL(`../tests/adapters/${name}.test.mjs`,import.meta.url));
const output=fileURLToPath(new URL(`../build/${name}-adapters.test.mjs`,import.meta.url));
buildSync({entryPoints:[input],outfile:output,bundle:true,platform:'node',format:'esm',packages:'external'});
execFileSync(process.execPath,['--test',output],{stdio:'inherit'});

}
