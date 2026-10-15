import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
async function files(dir) {
  const entries = await readdir(dir,{withFileTypes:true});
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]))).flat();
}
let count = 0;
for (const path of [...await files('src'), ...await files('test'), ...await files('examples'), ...await files('scripts')].filter(p => p.endsWith('.js'))) {
  const result = spawnSync(process.execPath,['--check',path],{stdio:'inherit'});
  if (result.status !== 0) process.exit(result.status ?? 1); count++;
}
console.log(`Syntax checked ${count} JavaScript files`);
