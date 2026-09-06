import { waterMaterial } from '../render/water-surface-view.mjs';
import * as THREE from 'three';
import { WATER_LIMITS as L } from '../../src/generation/water/model.ts';
import { waterPacketBytes,validateWaterPacket,assertWaterReadSets } from '../../src/generation/water/surface.ts';
import { packetBytes } from '../streaming/packet.mjs';
import { elevationReads } from './readset.mjs';

/** Surface and GPU ownership follow the existing terrain root. Reflection is
 * a cheap procedural sky approximation, not a scene-reflection render pass. */
export class WaterLayer {
  constructor(session,stream){
    this.session=session;this.stream=stream;this.view=session.view;this.records=new Map();this.bytes=0;this.error=null;this.reused=0;this.evicted=0;this.nextReport=0;this.maxStageMs={};this.cacheBytes=0;this.groundRevision='';
    this.requested=new URLSearchParams(location.search).get('water')!=='0';this.enabled=this.requested;
    const panel=document.createElement('section');panel.className='water-panel';
    panel.innerHTML='<h2>Surfaces d’eau</h2><label class="consent"><input id="water-visible" type="checkbox" /> Afficher l’eau</label><p class="footnote">Chargement automatique · niveaux estimés · reflets simplifiés. Pas encore de baignade ni de profondeur physique.</p><p id="water-status" class="footnote" role="status"></p>';
    session.panel.append(panel);this.status=panel.querySelector('#water-status');this.toggle=panel.querySelector('input');this.toggle.checked=this.enabled;this.toggle.disabled=!this.requested;
    this.toggle.addEventListener('change',()=>{this.enabled=this.toggle.checked;for(const r of this.records.values())if(r.mesh)r.mesh.visible=this.enabled&&r.stage==='ready';this.report();},{signal:session.events.signal});this.report();
  }
  current(r){return this.stream.loaded.get(r.key)===r.bundle&&this.view.findCell(r.bundle.packet.id)===r.cell;}
  payloadBytes(key){const r=this.records.get(key);return r?.bundled?0:r?.bytes||0;}
  resize(r){if(this.stream.recycling&&this.stream.loaded.get(r.key)===r.bundle)this.stream.recycling.resize(r.key,packetBytes(r.bundle)+this.stream.layerPayloadBytes(r.key));}
  remove(key){
    const r=this.records.get(key);if(!r)return;r.mesh?.removeFromParent();
    for(const resource of [r.geometry,r.material])if(resource){if(r.cell.resources.has(resource)&&this.view.resources.has(resource))resource.dispose();r.cell.resources.delete(resource);this.view.resources.delete(resource);}
    this.records.delete(key);this.bytes-=r.bytes;this.evicted++;this.resize(r);
  }
  reset(){for(const key of [...this.records.keys()])this.remove(key);this.error=null;this.reused=0;this.evicted=0;this.cacheBytes=0;this.maxStageMs={};this.groundRevision='';this.report();}
  offer(key,bundle,cell,packet,error,cacheBytes){
    if(Number.isFinite(cacheBytes))this.cacheBytes=cacheBytes;
    if(error){this.error=error;return;}if(!packet||this.records.has(key))return;
    try{
      validateWaterPacket(packet,bundle.packet);
      assertWaterReadSets(packet.readSet,[...this.records.values()].filter(r=>this.current(r)).map(r=>r.packet.readSet));
      assertWaterReadSets(packet.readSet,[...this.stream.loaded.values()].map(b=>elevationReads(b.evidence)));
      const bytes=waterPacketBytes(packet);
      if(this.bytes+bytes>L.residentBytes||this.stream.recycling&&!this.stream.recycling.fits(bytes,0))throw new Error('WATER_RESIDENCY_BUDGET');
      const r={key,bundle,cell,packet,bytes,stage:packet.triangleCount?'data':'ready',mesh:null,geometry:null,material:null,everVisible:false,lastVisible:false};
      this.records.set(key,r);this.bytes+=bytes;try{this.resize(r);}catch(e){this.remove(key);throw e;}
    }catch(e){this.error=/^WATER_[A-Z_]+$/.test(e.message)?e.message:'WATER_ADMISSION_FAILED';}
  }
  update(deadline,allowGpu){
    const time=performance.now()/1000;
    // Already admitted as an indivisible physical cohort. Only adopt ownership
    // metadata: no late water build, HTTP, GPU upload or terrain replacement.
    for(const [key,bundle] of this.stream.loaded){
      if(!bundle.hydro||!bundle.water||this.records.has(key))continue;
      const cell=this.view.findCell(bundle.packet.id);if(!cell)continue;
      const handle=cell.waterSurface;
      if(bundle.water.triangleCount&&!handle)continue;
      if(handle)handle.mesh.visible=this.enabled;
      const bytes=waterPacketBytes(bundle.water);
      this.records.set(key,{key,bundle,cell,packet:bundle.water,bytes,bundled:true,stage:'ready',mesh:handle?.mesh||null,
        geometry:handle?.geometry||null,material:handle?.material||null,everVisible:false,lastVisible:false});
      this.bytes+=bytes;
    }
    // Later terrain may come from a different provider revision after cache
    // eviction. Recheck on terrain membership changes, not on every frame.
    const revision=`${this.stream.epoch}/${this.stream.installed}/${this.stream.evicted}`;
    if(revision!==this.groundRevision){
      this.groundRevision=revision;const reads=[...this.stream.loaded.values()].map(b=>elevationReads(b.evidence));
      for(const [key,r] of this.records)try{assertWaterReadSets(r.packet.readSet,reads);}
      catch{this.remove(key);this.error='WATER_SOURCE_REVISION_CONFLICT';}
    }
    for(const [key,r] of this.records){
      if(!this.current(r)){this.remove(key);continue;}
      const visible=r.cell.root.visible;if(visible&&!r.lastVisible&&r.everVisible)this.reused++;r.lastVisible=visible;if(visible)r.everVisible=true;
      if(r.material)r.material.uniforms.waterTime.value=time;
    }
    let didWork=false;
    if(this.enabled&&allowGpu&&this.stream.active&&!document.hidden&&performance.now()<deadline){
      const r=[...this.records.values()].find(r=>r.stage!=='ready'&&r.stage!=='waiting');
      if(r){const started=performance.now(),stage=r.stage;didWork=true;try{
        if(r.stage==='data'){
          r.geometry=new THREE.BufferGeometry();r.geometry.setAttribute('position',new THREE.BufferAttribute(r.packet.positions,3));r.geometry.setAttribute('normal',new THREE.BufferAttribute(r.packet.normals,3));r.geometry.setAttribute('uv',new THREE.BufferAttribute(r.packet.uvs,2));r.geometry.setIndex(new THREE.BufferAttribute(r.packet.indices,1));r.geometry.computeBoundingBox();r.geometry.computeBoundingSphere();
          r.material=waterMaterial();for(const resource of [r.geometry,r.material]){this.view.own(resource);r.cell.resources.add(resource);}
          r.mesh=new THREE.Mesh(r.geometry,r.material);r.mesh.name='water-surface-preview';r.mesh.visible=false;r.mesh.renderOrder=3;r.cell.root.add(r.mesh);r.stage='shader';
        }else if(r.stage==='shader'){
          r.stage='waiting';Promise.resolve(this.view.renderer.compileAsync(r.mesh,this.view.camera,this.view.scene)).then(()=>{if(this.records.get(r.key)===r)r.stage='upload';}).catch(()=>{if(this.records.get(r.key)===r){this.remove(r.key);this.error='WATER_SHADER_FAILED';}});
        }else if(r.stage==='upload'){this.view.warmMesh(r.mesh);r.stage='commit';}
        else{if(!this.current(r))throw new Error('WATER_STALE_CELL');r.stage='ready';r.mesh.visible=this.enabled;}
      }catch{this.remove(r.key);this.error='WATER_RENDER_FAILED';}finally{this.maxStageMs[stage]=Math.max(this.maxStageMs[stage]||0,performance.now()-started);}}
    }
    if(performance.now()>=this.nextReport){this.report();this.nextReport=performance.now()+200;}return didWork;
  }
  report(){
    const cells=[...this.records].map(([key,r])=>({key,ready:r.stage==='ready',visible:r.cell.root.visible,drawn:r.cell.root.visible&&!!r.mesh?.visible,geometryId:r.geometry?.uuid||null,triangleCount:r.packet.triangleCount,areaSquareMeters:r.packet.areaSquareMeters,
      regionKey:r.packet.regionKey,enclosedLevels:r.packet.enclosedLevels,readSet:r.packet.readSet,minLevelMeters:r.packet.minLevelMeters,maxLevelMeters:r.packet.maxLevelMeters,deferredWaterways:r.packet.deferredWaterways,bytes:r.bytes}));
    window.__ZERANA_WATER_DEBUG__={enabled:this.enabled,requested:this.requested,cells,error:this.error,residentBytes:this.bytes,residentLimit:L.residentBytes,cacheBytes:this.cacheBytes,reused:this.reused,evicted:this.evicted,maxStageMs:this.maxStageMs,
      heightAuthority:'estimated-not-hydraulically-qualified',terrainModified:this.stream.config?.hydro===true,collidersAdded:0,swimming:false,renderLiftMeters:this.stream.config?.hydro?0:.03,supportedMode:!this.stream.config?.engineering};
    this.status.textContent=this.stream.config?.engineering?'Eau réservée au mode routier normal.':!this.requested?'Eau désactivée pour cette session (water=0).':`${cells.filter(c=>c.visible&&c.ready&&c.triangleCount).length} cellules d’eau visibles · niveaux estimés · ${this.error||'streaming et recyclage actifs'}`;
  }
}
