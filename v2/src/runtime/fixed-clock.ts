/** Fixed 60 Hz simulation, independent of display refresh rate.
 * Long frame gaps are deliberately dropped, never replayed as a large physics step.
 */
export class FixedClock {
  readonly stepSeconds=1/60;
  private accumulator=0;
  steps=0;
  droppedSeconds=0;
  reset(): void {this.accumulator=0;}
  advance(deltaSeconds: number,step: (dt:number)=>void): number {
    if(!Number.isFinite(deltaSeconds)||deltaSeconds<0) throw new RangeError('Invalid frame delta');
    const accepted=Math.min(deltaSeconds,.1);
    this.droppedSeconds+=deltaSeconds-accepted;this.accumulator+=accepted;
    let count=0;
    while(this.accumulator+1e-12>=this.stepSeconds && count<6){
      step(this.stepSeconds);this.accumulator=Math.max(0,this.accumulator-this.stepSeconds);this.steps++;count++;
    }
    return Math.max(0,Math.min(1,this.accumulator/this.stepSeconds));
  }
}
