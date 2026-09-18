/* Bounded performance diagnostics, available from the console as
   showroomPerformance() / resetShowroomPerformance(). The ring buffer and
   phase timers live here; the app-specific fields of a snapshot (queue
   depths, resident bytes, draw calls…) come from the probe main.js installs. */
export const Perf = {
  frames: new Float64Array(2048), count: 0, cursor: 0, longFrames: 0,
  phases: {}, discarded: 0, installed: 0, maxUploadBytes:0, epochStarted: performance.now(), populationMs: null,
  probe: null,
  sample(name, ms){
    const p = this.phases[name] || (this.phases[name] = { count:0, total:0, max:0 });
    p.count++; p.total += ms; p.max = Math.max(p.max, ms);
  },
  frame(ms){
    this.frames[this.cursor++ % this.frames.length] = ms;
    this.count = Math.min(this.count + 1, this.frames.length);
    if (ms > 50) this.longFrames++;
  },
  reset(){
    this.count = this.cursor = this.longFrames = this.discarded = this.installed = this.maxUploadBytes = 0;
    this.phases = {}; this.epochStarted = performance.now(); this.populationMs = null;
  },
  snapshot(){
    const f = Array.from(this.frames.subarray(0, this.count)).sort((a,b) => a-b);
    const phases = {};
    for (const [name,p] of Object.entries(this.phases))
      phases[name] = { count:p.count, meanMs:p.total/p.count, maxMs:p.max };
    return { frames:f.length, medianMs:f[Math.floor(f.length*.5)] || 0,
      p95Ms:f[Math.min(f.length-1, Math.floor(f.length*.95))] || 0,
      longFrames:this.longFrames, populationMs:this.populationMs, phases,
      discarded:this.discarded, installed:this.installed, maxUploadBytes:this.maxUploadBytes,
      ...(this.probe ? this.probe() : {}) };
  }
};

/* `probe()` returns the live app fields appended to every snapshot. */
export function installPerformanceDiagnostics(probe){
  Perf.probe = probe;
  window.showroomPerformance = () => Perf.snapshot();
  window.resetShowroomPerformance = () => Perf.reset();
}
