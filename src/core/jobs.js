/* Worker jobs contain only numeric input. Rendering objects never cross threads.
   Shared by the module worker and the main-thread 'compatibility' fallback. */
export function runNumericJob(core, job){
  if (job.type === 'build') return core.buildBlock(job.recipe, job.levels);
  if (job.type === 'analyze'){
    const started = performance.now();
    return { aut: core.autOrder(job.occ, job.R), analysisMs: performance.now() - started };
  }
  throw new Error('Unknown generation job: ' + job.type);
}
