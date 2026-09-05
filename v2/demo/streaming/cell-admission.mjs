import { TriangleIndex } from '../../src/physics/geometry.ts';

/** One cell, explicit short stages, no secondary scheduler. The caller owns
 * the ready ticket and commits physics/visibility only after this returns true. */
export class CellAdmission {
  constructor(ready, view, measure) {
    this.ready = ready; this.view = view; this.measure = measure;
    this.stage = 'validate'; this.staged = false; this.cancelled = false;
    this.bundle = ready.value;
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
        this.view.warmCell(this.bundle.packet.id); this.stage = 'commit';
      }
      return this.stage === 'commit';
    } finally {
      if (stage !== 'waiting-shader') this.measure(stage, performance.now() - start);
    }
  }
  finish() { this.staged = false; this.cancelled = true; this.validator = null; }
  cancel() {
    this.cancelled = true; this.validator = null;
    if (this.staged) this.view.removeCell(this.bundle.packet.id);
    this.staged = false;
  }
}
