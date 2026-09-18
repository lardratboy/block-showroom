// Module worker: builds specimens off the main thread.
// Loaded by startGeneration() in src/main.js with { type: 'module' }.
import { createBimoblockCore } from './bimoblock-core.js';
import { runNumericJob } from './jobs.js';

const core = createBimoblockCore();
self.onmessage = ({data: job}) => {
  try {
    const result = runNumericJob(core, job);
    const transfer = job.type === 'build'
      ? [result.occ.buffer, result.geometry.pos.buffer, result.geometry.col.buffer,
         result.geometry.nrm.buffer, result.geometry.idx.buffer,
         ...(result.geometry.colOrbit ? [result.geometry.colOrbit.buffer] : [])] : [];
    self.postMessage({ jobId: job.jobId, result }, transfer);
  } catch (error){
    self.postMessage({ jobId: job.jobId, error: String(error.message || error) });
  }
};
self.postMessage({ ready: true });
