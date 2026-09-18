// Loads createBimoblockCore() for Node tests from the real module.
// (Before Phase 2 this sliced the core out of src/main.js by text markers.)
import { createBimoblockCore } from '../src/core/bimoblock-core.js';

export async function loadCore(){
  return createBimoblockCore();
}
