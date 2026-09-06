import { RoadSurfaceView } from '../render/road-surface-view.mjs';
import { TriangleIndex } from '../../src/physics/geometry.ts';

/** One cell, explicit short stages, no secondary scheduler. The caller owns
 * the ready ticket and commits physics/visibility only after this returns true. */
export class CellAdmission {
  constructor(ready, view, measure) {
    this.ready = ready; this.view = view; this.measure = measure;
    this.stage = 'validate'; this.staged = false; this.cancelled = false;
    this.bundle = ready.value;this.roads=new RoadSurfaceView(view);this.roadHandle=null;
    this.validator = this.bundle.colliderIndex ? null : TriangleIndex.adopt(
      this.bundle.collider, this.bundle.packet.positions, this.bundle.packet.indices);
  }
  advance(deadline) {
    const start = performance.now(), stage = this.stage;
    try {
      if (this.cancelled) return false;
      if (this.error) throw this.error;
      if (stage === 'validate') {
        if (this.validator) {
          let result;
          do { result = this.validator.next(); } while (!result.done && performance.now() < deadline);
          if (!result.done) return false;
          this.bundle.colliderIndex = result.value;
        }
        this.stage = 'mesh';
      } else if (stage === 'mesh') {
        this.view.addCell(this.bundle.packet, this.bundle.texture, {visible:false});
        this.staged = true; this.stage = 'shader';
      } else if (stage === 'shader') {
        this.stage = 'waiting-shader';
        Promise.resolve(this.view.compileCell(this.bundle.packet.id)).then(() => {
          if (!this.cancelled) this.stage = 'upload';
        }).catch(() => { if (!this.cancelled) this.error = new Error('STREAM_SHADER_ERROR'); });
      } else if (stage === 'upload') {
        this.view.warmCell(this.bundle.packet.id); this.stage = this.bundle.roadSurface?'road-mesh':'commit';
      } else if(stage==='road-mesh'){
        this.roadHandle=this.roads.stage(this.view.findCell(this.bundle.packet.id),this.bundle.roadSurface);this.stage='road-shader';
      } else if(stage==='road-shader'){
        this.stage='waiting-road-shader';
        Promise.resolve(this.roads.compile(this.roadHandle)).then(()=>{if(!this.cancelled)this.stage='road-upload';})
          .catch(()=>{if(!this.cancelled)this.error=new Error('ROAD_SURFACE_SHADER');});
      } else if(stage==='road-upload'){
        this.roads.warm(this.roadHandle);this.roads.commit(this.roadHandle);this.stage='commit';
      }
      return this.stage === 'commit';
    } finally {
      if (!stage.startsWith('waiting')) this.measure(stage, performance.now() - start);
    }
  }
  finish() { this.staged = false; this.cancelled = true; this.validator = null; }
  cancel() {
    this.cancelled = true; this.validator = null;
    this.roads.remove(this.roadHandle);this.roadHandle=null;
    if (this.staged) this.view.removeCell(this.bundle.packet.id);
    this.staged = false;
  }
}
