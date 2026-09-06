import { admitHydroCohort } from '../hydro/cohort.mjs';
import { MercatorCellScheme } from '../../src/geo/mercator-cell-scheme.ts';
import { StreamWorkerPool } from './worker-pool.mjs';
import { validatePacket } from './packet.mjs';
import { streamCellKey } from '../../src/streaming/selection.ts';
import { TriangleIndex } from '../../src/physics/geometry.ts';
import { assertReadSetsCompatible } from '../../src/generation/roads/snapshot-readset.ts';
const frame=()=>new Promise(requestAnimationFrame);
const check=signal=>{if(signal.aborted)throw new DOMException('Cancelled','AbortError');};
/** Prepare the new world's immutable CPU bundle BEFORE replacing the old world.
 * The same worker is handed to streaming, keeping the recipe/DEM/MVT cache hot.
 * The initial calls count against the first activation's shared 256-call quota.
 */
export async function prepareRealPatch(ids,position,config,signal,onProgress){
  if(!ids.length||ids.length>9||config.source!=='mapbox'||config.allowPreview!==true)throw new Error('ROAD_ENGINEERING_PATCH_CONTRACT');
  const centre=streamCellKey(new MercatorCellScheme().getCellAt(position,config.level));
  ids=[...ids].sort((a,b)=>Number(streamCellKey(b)===centre)-Number(streamCellKey(a)===centre));
  const pool=new StreamWorkerPool(1),bundles=[],prepared=new Map();let used=0,sourceCacheBytes=0,probeHeight=null;
  try{
    for(let i=0;i<ids.length;i++){
      check(signal);const grant=Math.min(128,256-used);if(grant<=0)throw new Error('STREAM_HTTP_BUDGET');
      const job={...config,id:ids[i],engineering:config.engineering===true,hydro:config.hydro===true,persistent:false,layer:'terrain',httpGrant:grant,probe:position};
      // Probe only the cell containing the spawn: other contexts need not contain it.
      // The containing cell is explicitly sorted first.
      if(i!==0)delete job.probe;
      const result=await pool.run({key:streamCellKey(ids[i]),revision:-(i+1)},job,signal);
      if(!Number.isSafeInteger(result.attempts)||result.attempts<0||result.attempts>grant)throw new Error('ROAD_ENGINEERING_HTTP_ACCOUNT');
      used+=result.attempts;sourceCacheBytes=result.sourceCacheBytes;
      const b=validatePacket(result.bundle,job);
      if(config.hydro)admitHydroCohort(b,bundles);
      else assertReadSetsCompatible(b.engineering.readSet,bundles.map(v=>v.engineering.readSet));
      const validator=TriangleIndex.adopt(b.collider,b.packet.positions,b.packet.indices);let step;
      do{check(signal);const deadline=performance.now()+3;do{step=validator.next();}while(!step.done&&performance.now()<deadline);if(!step.done)await frame();}while(!step.done);
      b.colliderIndex=step.value;prepared.set(b.packet,step.value);bundles.push(b);
      if(i===0){if(!Number.isFinite(b.probeHeight))throw new Error('ROAD_ENGINEERING_SPAWN_HEIGHT');probeHeight=b.probeHeight;}
      onProgress?.(i+1,ids.length);await frame();
    }
    check(signal);return {pool,bundles,prepared,probeHeight,httpActual:used,sourceCacheBytes};
  }catch(error){pool.dispose();throw error;}
}
