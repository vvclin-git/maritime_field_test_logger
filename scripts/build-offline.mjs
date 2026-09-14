import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
async function files(dir) {
  return (await Promise.all((await readdir(dir, {withFileTypes:true})).map(async e => e.isDirectory() ? (await files(`${dir}/${e.name}`)).map(x=>`${e.name}/${x}`) : [e.name]))).flat();
}
const paths=(await files('dist')).filter(x=>x!=='sw.js').sort();
const hash=createHash('sha256');
for(const path of paths) hash.update(path).update(await readFile(`dist/${path}`));
const template=await readFile('public/sw.js','utf8');
hash.update(template);
await writeFile('dist/sw.js',template.replace('/* BUILD_FILES */ []',JSON.stringify(paths)).replace('BUILD_VERSION',hash.digest('hex').slice(0,16)));
console.log(`Offline bundle: ${paths.length} required files`);
