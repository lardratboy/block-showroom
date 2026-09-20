/* GENERATION — a bounded worker pool that mints specimens nearest-first.
   Jobs are chosen from the virtualiser's visible list (plus the focused
   cell and a parked pin anchor), run in module workers or, when those are
   unavailable, on the main thread one per frame ('compatibility'). Results
   wait in a small ready queue and are admitted into the cache under a
   per-frame CPU and upload budget by service(). Every job carries the
   revision it was issued under; invalidate() bumps it so in-flight results
   for a superseded lattice are discarded on arrival. */
import { Core } from '../core/bimoblock-core.js';
import { runNumericJob } from '../core/jobs.js';
import { CFG } from '../config.js';
import { Tier, Pin, Focus } from '../state.js';
import { geometryFromArrays, cellWorldX, cellWorldZ, cellRecipe } from './recipe.js';
import { Perf } from '../perf.js';

const { levelResolution } = Core;

export class GenerationPool {
  constructor(virtualiser, rig, { workerCount }){
    this.virtualiser = virtualiser;
    this.rig = rig;
    this.workerCount = workerCount;
    this.revision = 0; this.serial = 0;
    this.paused = false; this.suspended = false;
    this.pool = [];
    /** @type {Map<string, import('../types.js').Job>} */
    this.pending = new Map();
    this.results = []; this.failures = new Map();
    this.mode = workerCount ? 'starting workers' : 'compatibility';
    this.dispatches = 0;
    this.resultLimit = Math.max(4, workerCount * 16);

    window.addEventListener('pagehide', () => this.suspend());
    window.addEventListener('pageshow', event => {
      // Resume a back/forward-cached page without losing its unsaved catalogue settings.
      if (event.persisted) this.resume();
    });
  }

  get liveWorkers(){ return this.pool.filter(s => !s.dead).length; }

  token(type, key){ return this.revision + '/' + type + '/' + key; }
  /* Has a job of this type for this cell given up (two failed attempts)? */
  failed(type, i, j){
    return (this.failures.get(this.token(type, this.virtualiser.keyOf(i, j)))?.tries || 0) >= 2;
  }

  jobIsCurrent(job){
    const v = this.virtualiser;
    return !this.paused && job.revision === this.revision && job.key === v.keyOf(job.i, job.j)
      && (job.type !== 'analyze' || v.cache.get(job.key) === job.specimen);
  }
  isDemanded(job){
    return this.virtualiser.visKeys.has(job.key) || (job.i === Focus.i && job.j === Focus.j)
      || (Pin.want && job.i === Pin.want.i && job.j === Pin.want.j);
  }
  invalidate(paused){
    this.revision++;
    this.paused = paused;
    this.pending.clear(); this.results.length = 0; this.failures.clear();
    Perf.populationMs = null; Perf.epochStarted = performance.now();
    // Active workers finish their one job. Revision checks discard the obsolete result.
  }

  _failure(job, error){
    if (!job) return;
    this.pending.delete(job.token);
    if (!this.jobIsCurrent(job)) return;
    const tries = (this.failures.get(job.token)?.tries || 0) + 1;
    this.failures.set(job.token, { tries, message:String(error) });
    if (tries >= 2) console.warn('Specimen generation failed', job.key, error);
  }
  _finish(slot, message){
    const job = slot.job;
    if (!job || message.jobId !== job.jobId) return;
    clearTimeout(slot.timer); slot.timer = null; slot.job = null;
    if (message.error){
      this._failure(job, message.error);
      if (slot.worker) this._restartWorker(slot);
      return;
    }
    if (!this.jobIsCurrent(job) || !this.isDemanded(job)){
      this.pending.delete(job.token); Perf.discarded++; return;
    }
    const result = message.result;
    const bytes = job.type === 'build' ? result.geometry.bytes + result.occ.byteLength : 0;
    this.results.push({ job, result, bytes });
    const source = slot.worker ? 'worker.' : 'compatibility.';
    if (result.timings) for (const [name,ms] of Object.entries(result.timings)) Perf.sample(source+name, ms);
    if (result.analysisMs != null) Perf.sample(source+'analysis', result.analysisMs);
  }
  _restartWorker(slot){
    clearTimeout(slot.timer);
    if (slot.worker){ slot.worker.onmessage = slot.worker.onerror = slot.worker.onmessageerror = null; slot.worker.terminate(); }
    slot.worker = null; slot.ready = false;
    if (slot.restarts++ < 1) this._startWorker(slot);
    else slot.dead = true;
    if (this.pool.every(s => s.dead)){
      this.mode = 'compatibility';
      console.warn('Workers unavailable; using conservative main-thread generation.');
    }
  }
  _startWorker(slot){
    const fail = error => {
      const job = slot.job; slot.job = null;
      this._failure(job, error);
      this._restartWorker(slot);
    };
    try {
      // Module worker; browsers without module-worker support throw here and
      // fall through to the main-thread 'compatibility' path.
      const worker = slot.worker = new Worker(new URL('../core/worker.js', import.meta.url), {type:'module'});
      slot.timer = setTimeout(() => fail('Worker startup timed out'), 10000);
      worker.onerror = event => { event.preventDefault(); fail(event.message || 'Worker error'); };
      worker.onmessageerror = () => fail('Invalid worker message');
      worker.onmessage = ({data}) => {
        if (data.ready){
          clearTimeout(slot.timer); slot.timer = null; slot.ready = true;
          this.mode = 'workers';
        } else this._finish(slot, data);
        this.dispatch();
      };
      slot.fail = fail;
    } catch (error){ fail(error.message); }
  }
  start(){
    if (!this.workerCount) return;
    // Allocate slots first: startup failures must see the complete pool.
    this.pool = Array.from({length:this.workerCount}, () => ({worker:null, job:null, ready:false, dead:false, restarts:0}));
    try {
      for (const slot of this.pool) this._startWorker(slot);
    } catch (error){
      for (const slot of this.pool) slot.dead = true;
      this.mode = 'compatibility'; console.warn('Worker setup failed', error);
    }
  }
  suspend(){
    this.suspended = true;
    for (const slot of this.pool){
      clearTimeout(slot.timer);
      if (slot.worker){
        slot.worker.onmessage = slot.worker.onerror = slot.worker.onmessageerror = null;
        slot.worker.terminate();
      }
    }
    this.pool = []; this.pending.clear(); this.results.length = 0;
  }
  resume(){
    this.suspended = false;
    this.mode = this.workerCount ? 'starting workers' : 'compatibility';
    this.start();
  }

  /** @returns {import('../types.js').Job|null} */
  _nextJob(){
    const v = this.virtualiser;
    const analyze = () => {
      const key = v.keyOf(Focus.i, Focus.j), p = v.cache.get(key), token = this.token('analyze', key);
      if (!p || p.aut >= 0 || this.pending.has(token) || (this.failures.get(token)?.tries || 0) >= 2) return null;
      return { type:'analyze', i:Focus.i, j:Focus.j, key, token, specimen:p, estimate:p.occ.byteLength,
        // Structured cloning copies this small occupancy buffer; never detach the cached original.
        payload:{ occ:p.occ, R:p.R } };
    };
    const priority = [];
    if (Pin.want) priority.push(Pin.want);
    priority.push(Focus);
    const makeBuild = c => {
      const key = v.keyOf(c.i,c.j), token = this.token('build', key);
      if (v.cache.has(key) || this.pending.has(token) || (this.failures.get(token)?.tries || 0) >= 2) return null;
      const rec = cellRecipe(c.i,c.j), levels = Tier.levels.map(l => ({...l})), R = levelResolution(levels);
      rec.P.tierSymmetry = Tier.symmetry;
      return { type:'build', i:c.i, j:c.j, key, token, rec, levels,
        // Six independent quads per cell, 32-bit indices, occupancy, plus the
        // colOrbit buffer alongside the existing gamut one: conservative reservation.
        estimate:R*R*R*(6*216+1), payload:{recipe:rec.P, levels} };
    };
    for (const c of priority){ const job = makeBuild(c); if (job) return job; }
    if (this.dispatches % 4 === 3){ const job = analyze(); if (job) return job; }
    for (const c of v.visible){ const job = makeBuild(c); if (job) return job; }
    return analyze();
  }

  /* Once per frame: admit ready results into the cache under budget. */
  service(){
    if (this.paused) return;
    const v = this.virtualiser, camera = this.rig.camera;
    const started = performance.now();
    // Re-check demand even after a result was queued, since the camera/settings can change meanwhile.
    this.results = this.results.filter(item => {
      if (this.jobIsCurrent(item.job) && this.isDemanded(item.job)) return true;
      this.pending.delete(item.job.token); Perf.discarded++; return false;
    });
    const rank = item => item.job.i === Focus.i && item.job.j === Focus.j ? -2
      : Pin.want && item.job.i === Pin.want.i && item.job.j === Pin.want.j ? -1
      : (cellWorldX(item.job.i)-camera.position.x)**2 + (cellWorldZ(item.job.j)-camera.position.z)**2;
    this.results.sort((a,b) => rank(a)-rank(b));
    let accepted = 0, admittedBytes = 0;
    while (this.results.length && accepted < 32){
      const item = this.results[0], {job,result} = item;
      if (accepted && (performance.now()-started >= CFG.INSTALL_MS || admittedBytes+item.bytes > CFG.UPLOAD_BYTES)) break;
      this.results.shift(); this.pending.delete(job.token); this.failures.delete(job.token);
      if (job.type === 'build'){
        const p = { ...job.rec.P, occ:result.occ, R:result.R, levels:job.levels,
          filled:result.filled, envelopeCells:result.envelopeCells,
          geo:geometryFromArrays(result.geometry), geoLod:null, geoCenters:null, tris:result.geometry.tris,
          aut:-1, seen:v.seenTick, kin:job.rec.kin, bytes:item.bytes, revision:job.revision };
        v.install(job.key, p); Perf.installed++;
      } else job.specimen.aut = result.aut;
      accepted++; admittedBytes += item.bytes;
    }
    Perf.sample('main.install', performance.now()-started);
    this.dispatch();
    if (Perf.populationMs === null && v.visible.every(c => v.cache.has(c.key)))
      Perf.populationMs = performance.now() - Perf.epochStarted;
  }

  // Refill idle workers on completion, not just at RAF cadence. The bounded ready
  // queue absorbs bursts; install time and upload bytes determine admission per frame.
  dispatch(){
    if (this.paused || this.suspended || document.hidden) return;
    const available = this.mode === 'compatibility' ? [{job:null,worker:null}]
      : this.pool.filter(s => s.ready && !s.dead && !s.job);
    for (const slot of available){
      const active = this.pool.filter(s => s.job);
      if (this.results.length + active.length >= this.resultLimit) break;
      const reserved = active.reduce((n,s) => n+s.job.estimate, 0)
        + this.results.reduce((n,r) => n+r.bytes, 0);
      const job = this._nextJob();
      if (!job) break;
      if (reserved && reserved+job.estimate > CFG.RESULT_BYTES) break;
      job.revision = this.revision; job.jobId = ++this.serial;
      const message = {type:job.type, jobId:job.jobId, ...job.payload};
      this.pending.set(job.token,job); this.dispatches++; slot.job = job;
      if (slot.worker){
        slot.timer = setTimeout(() => slot.fail('Worker job timed out'), 30000);
        try { slot.worker.postMessage(message); } catch (error){ slot.fail(error.message); }
      } else {
        // At most one complete job per compatibility frame. A single build cannot be preempted.
        const t0 = performance.now();
        try { this._finish(slot, {jobId:job.jobId, result:runNumericJob(Core,message)}); }
        catch (error){ this._finish(slot, {jobId:job.jobId,error:error.message}); }
        Perf.sample('main.compatibility', performance.now()-t0);
      }
    }
  }
}
