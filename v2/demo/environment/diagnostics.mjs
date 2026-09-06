import * as THREE from 'three';
import { ENV_LIMITS } from '../../src/generation/environment/model.ts';
import { environmentPacketBytes,validateEnvironmentPacket } from '../../src/generation/environment/debug-packet.ts';
import { packetBytes } from '../streaming/packet.mjs';

/** Passive consumer of the shared vector job: no HTTP, worker, cell selection,
 * physics or independent streaming. Resource ownership stays with the terrain. */
export class EnvironmentDiagnostics {
  constructor(session,stream){
    this.session=session;this.stream=stream;this.view=session.view;this.records=new Map();this.bytes=0;
    this.enabled=new URLSearchParams(location.search).get('environment')==='1';this.error=null;this.reused=0;this.evicted=0;this.decodedSnapshots=0;this.nextReport=0;
    const panel=document.createElement('section');panel.className='environment-panel';
    panel.innerHTML='<h2>Eau et occupation du sol</h2><label class="consent"><input id="environment-visible" type="checkbox" /> Afficher les contours environnementaux</label><p class="footnote">Données automatiques partagées avec les routes. Bleu : eau · vert : végétation · violet : zones humides · rose : usages. Contours de diagnostic, sans surface d’eau ni altitude hydrographique.</p><p id="environment-status" class="footnote" role="status"></p>';
    session.panel.append(panel);this.status=panel.querySelector('#environment-status');this.toggle=panel.querySelector('input');this.toggle.checked=this.enabled;
    this.toggle.addEventListener('change',()=>{this.enabled=this.toggle.checked;for(const r of this.records.values())if(r.mesh)r.mesh.visible=this.enabled&&r.stage==='ready';this.report();},{signal:session.events.signal});this.report();
  }
  current(r){return this.stream.loaded.get(r.key)===r.bundle&&this.view.findCell(r.bundle.packet.id)===r.cell;}
  payloadBytes(key){return this.records.get(key)?.bytes||0;}
  resize(r){if(this.stream.recycling&&this.stream.loaded.get(r.key)===r.bundle)this.stream.recycling.resize(r.key,packetBytes(r.bundle)+this.stream.layerPayloadBytes(r.key));}
  remove(key){
    const r=this.records.get(key);if(!r)return;r.mesh?.removeFromParent();
    for(const resource of [r.geometry,r.material])if(resource){if(r.cell.resources.has(resource)&&this.view.resources.has(resource))resource.dispose();r.cell.resources.delete(resource);this.view.resources.delete(resource);}
    this.records.delete(key);this.bytes-=r.bytes;this.evicted++;this.resize(r);
  }
  reset(){for(const key of [...this.records.keys()])this.remove(key);this.error=null;this.reused=0;this.evicted=0;this.decodedSnapshots=0;this.report();}
  offer(key,bundle,cell,packet,error,decodedSnapshots){
    if(Number.isInteger(decodedSnapshots))this.decodedSnapshots=decodedSnapshots;
    if(error){this.error=error;return;}
    if(!packet)return;
    try{
      validateEnvironmentPacket(packet,bundle.packet);if(this.records.has(key))return;
      const revisions=new Map(packet.sourceTiles.map(s=>s.split('@')));
      for(const r of this.records.values())if(this.current(r))for(const s of r.packet.sourceTiles){
        const [tile,digest]=s.split('@');if(revisions.has(tile)&&revisions.get(tile)!==digest)throw new Error('ENV_SNAPSHOT_CONFLICT');
      }
      const bytes=environmentPacketBytes(packet);
      if(this.bytes+bytes>ENV_LIMITS.residentBytes||this.stream.recycling&&!this.stream.recycling.fits(bytes,0))throw new Error('ENV_RESIDENCY_BUDGET');
      const r={key,bundle,cell,packet,bytes,stage:'data',mesh:null,geometry:null,material:null,everVisible:false,lastVisible:false};
      this.records.set(key,r);this.bytes+=bytes;try{this.resize(r);}catch(e){this.records.delete(key);this.bytes-=bytes;throw e;}
    }catch(e){this.error=/^ENV_[A-Z_]+$/.test(e.message)?e.message:'ENV_ADMISSION_FAILED';}
  }
  update(deadline,allowGpu){
    for(const [key,r] of this.records){
      if(!this.current(r)){this.remove(key);continue;}
      const visible=r.cell.root.visible;if(visible&&!r.lastVisible&&r.everVisible)this.reused++;
      r.lastVisible=visible;if(visible)r.everVisible=true;
    }
    if(this.enabled&&allowGpu&&this.stream.active&&!document.hidden&&performance.now()<deadline){
      const r=[...this.records.values()].find(r=>r.stage!=='ready');
      if(r)try{
        if(r.stage==='data'){
          r.geometry=new THREE.BufferGeometry();r.geometry.setAttribute('position',new THREE.BufferAttribute(r.packet.positions,3));r.geometry.setAttribute('color',new THREE.BufferAttribute(r.packet.colors,3));
          r.material=new THREE.LineBasicMaterial({vertexColors:true,depthTest:false,depthWrite:false});
          for(const resource of [r.geometry,r.material]){this.view.own(resource);r.cell.resources.add(resource);}
          r.mesh=new THREE.LineSegments(r.geometry,r.material);r.mesh.name='environment-cartographic-diagnostic';r.mesh.visible=false;r.mesh.renderOrder=49;r.cell.root.add(r.mesh);r.stage='upload';
        }else{if(r.packet.segmentCount)this.view.warmMesh(r.mesh);r.stage='ready';r.mesh.visible=this.enabled;}
      }catch{this.remove(r.key);this.error='ENV_RENDER_FAILED';}
    }
    if(performance.now()>=this.nextReport){this.report();this.nextReport=performance.now()+200;}
  }
  report(){
    const cells=[...this.records].map(([key,r])=>({key,ready:r.stage==='ready'||r.stage==='data',visible:r.cell.root.visible,drawn:!!r.mesh?.visible&&r.cell.root.visible,geometryId:r.geometry?.uuid||null,
      segmentCount:r.packet.segmentCount,fragmentCount:r.packet.fragmentCount,sourceZoom:r.packet.sourceZoom,classCounts:r.packet.classCounts,
      sourceTiles:r.packet.sourceTiles,missingLayers:r.packet.missingLayers,center:r.packet.center,bytes:r.bytes}));
    window.__ZERANA_ENVIRONMENT_DEBUG__={schema:'environment-debug-v1',enabled:this.enabled,cells,error:this.error,residentBytes:this.bytes,residentLimit:ENV_LIMITS.residentBytes,
      decodedSnapshots:this.decodedSnapshots,reused:this.reused,evicted:this.evicted,independentNetworkRequests:0,hydroAuthority:'unresolved',terrainModified:false,
      supportedMode:!this.stream.config?.engineering};
    this.status.textContent=this.stream.config?.engineering?'Diagnostic environnemental réservé au mode routier normal pour cette tranche.':
      `${cells.filter(c=>c.visible&&c.ready).length} cellules documentées · source partagée avec les routes · ${this.error||'niveaux d’eau non résolus'}`;
  }
}
