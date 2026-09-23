// Module worker: builds specimens off the main thread.
// Loaded by startGeneration() in src/main.js with { type: 'module' }.
import { createBimoblockCore } from './bimoblock-core.js';
import { runNumericJob } from './jobs.js';

const core = createBimoblockCore();
self.onmessage = ({data: job}) => {
  try {
    const result = runNumericJob(core, job);
    // The instance record is what crosses now: a flat index, a face mask and
    // an orbit byte per occupied cell, plus the axis centre table. Six bytes
    // a voxel where the baked vertex buffers were over a kilobyte.
    const inst = result.instances;
    const transfer = job.type === 'build'
      ? [result.occ.buffer, inst.cells.buffer, inst.masks.buffer, inst.centers.buffer,
         ...(inst.orbitIdx ? [inst.orbitIdx.buffer] : [])] : [];
    self.postMessage({ jobId: job.jobId, result }, transfer);
  } catch (error){
    self.postMessage({ jobId: job.jobId, error: String(error.message || error) });
  }
};
self.postMessage({ ready: true });
