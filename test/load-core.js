// Loads createBimoblockCore() for Node tests.
//
// Until Phase 2 of refactorplan.md lands, the core lives inside
// src/main.js, so it is sliced out of that file by text markers and
// evaluated. After Phase 2 this file becomes a one-line re-export of
// src/core/bimoblock-core.js and the slicing goes away.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const modulePath = join(here, '..', 'src', 'core', 'bimoblock-core.js');

export async function loadCore(){
  if (existsSync(modulePath)){
    const mod = await import(modulePath);
    return mod.createBimoblockCore();
  }
  const html = readFileSync(join(here, '..', 'src', 'main.js'), 'utf8');
  const start = html.indexOf('function createBimoblockCore(){');
  const end = html.indexOf('\nconst Core = createBimoblockCore();');
  if (start < 0 || end < 0) throw new Error('core markers not found in src/main.js');
  const src = html.slice(start, end);
  const factory = new Function('"use strict";\n' + src + '\nreturn createBimoblockCore;')();
  return factory();
}
