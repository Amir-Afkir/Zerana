import './stream.css';
import { CellAdmission } from './cell-admission.mjs';
import { CellScheduler } from '../../src/streaming/scheduler.ts';
import { selectSlidingWindow } from '../../src/streaming/sliding-window.ts';
import { RecyclingIndex } from '../../src/streaming/recycling.ts';
import { MercatorCellScheme } from '../../src/geo/mercator-cell-scheme.ts';
import { WeightedLru } from '../../src/streaming/weighted-lru.ts';
import { selectStreamCells, streamCellKey, STREAM_LIMITS, DEFAULT_STREAM } from '../../src/streaming/selection.ts';
import { measureTerrainSeams } from '../../src/debug/seam-metrics.ts';
import { planRasterTiles } from '../../src/providers/raster/request-plan.ts';
import { StreamWorkerPool } from './worker-pool.mjs';
import { packetBytes, validatePacket } from './packet.mjs';
import { clearPersistentPackets } from './indexed-cache.mjs';

const HTTP_LIMIT=256;
const scheme=new MercatorCellScheme();
/** Owns one immutable source configuration; no fake player or world position.
 * All scene/physics commits happen at the beginning of a render frame. */
export class StreamSession {
  constructor(view,player,onChanged) {
    this.view=view;this.player=player;this.onChanged=onChanged;this.active=false;this.disposed=false;
    this.layerPayloadBytes=()=>0;this.loaded=new Map();this.controllers=new Map();this.epoch=0;this.error=null;
    this.events=new AbortController();
    this.panel=document.createElement('section');this.panel.className='stream-panel';
    this.panel.innerHTML=`<h2>Monde continu</h2>
      <label>Fenêtre de chargement<select id="stream-radius"><option value="window" selected>3×3 + préchargement + recyclage</option><option value="normal">120 m visibles / 200 m retenus</option><option value="small">20 m / 35 m — test rapproché</option></select></label>
      <label class="stream-check"><input type="checkbox" id="stream-cache" checked /> Cache local synthétique (16 Mio max.)</label>
      <label class="stream-check" id="stream-network-option" hidden><input type="checkbox" id="stream-network-consent" /> J’autorise jusqu’à 256 requêtes Mapbox supplémentaires.</label>
      <div class="stream-actions"><button id="stream-toggle" type="button" disabled>Activer le streaming</button><button id="stream-clear" type="button">Vider le cache</button></div>
      <p class="footnote">16 ou 32 subdivisions. Mapbox : activation volontaire, maximum 256 requêtes supplémentaires par session ; aucune persistance de ses tuiles.</p>
      <p id="stream-status" role="status">Désactivé : la scène reste un patch statique.</p><dl id="stream-metrics"></dl>`;
    this.player.panel.after(this.panel);this.$=id=>this.panel.querySelector(`#${id}`);
    this.$('stream-toggle').addEventListener('click',()=>this.active?this.stop():this.start(),{signal:this.events.signal});
    this.$('stream-clear').addEventListener('click',async()=>{this.stop();this.cache?.clear();
      const ok=await clearPersistentPackets();if(!this.disposed)this.message(ok?'Cache synthétique vidé.':'Cache occupé ou indisponible ; la scène est conservée.');},{signal:this.events.signal});
    this.$('stream-network-consent').addEventListener('change',()=>{if(this.active&&this.config.source==='mapbox'&&!this.$('stream-network-consent').checked)this.stop('STREAM_CONSENT_REVOKED');},{signal:this.events.signal});
    this.view.onBeforeFrame=dt=>this.update(dt);
    this.player.beforeRespawn=()=>{
      if(this.sliding&&this.pinned?.size){this.present(this.pinned);this.nextSelection=0;}
    };
  }
  message(text){this.$('stream-status').textContent=text;}
  buttons(){
    this.$('stream-toggle').disabled=!this.config||!this.player.player||this.player.loading;
    this.$('stream-toggle').textContent=this.active?'Arrêter le streaming':'Activer le streaming';
    this.$('stream-radius').disabled=this.active;this.$('stream-cache').disabled=this.active;
  }
  install(packets,textures,config) {
    this.stop();this.sliding=false;this.recycling=null;this.plan=null;this.config=Object.freeze({...config});this.loaded.clear();
    for(const packet of packets)this.loaded.set(streamCellKey(packet.id),{packet,
      texture:textures?.get(`${packet.id.level}/${packet.id.x}/${packet.id.y}`)||null,evidence:[],attributions:[]});
    // The small original spawn patch is pinned for safe respawn, with a fixed cap.
    this.shown=new Set(this.loaded.keys());this.seen=new Set(this.shown);
    this.pinned=new Set(this.loaded.keys());this.$('stream-network-option').hidden=config.source!=='mapbox';this.$('stream-network-consent').checked=false;this.error=null;this.buttons();this.report();
  }
  start() {
    if(!this.config||!this.player.player||this.player.loading||this.disposed)return;
    if(this.config.source==='mapbox'&&!this.$('stream-network-consent').checked){this.message('Autorise explicitement le budget Mapbox avant de lancer le streaming.');return;}
    if(![16,32].includes(this.config.subdivisions)){this.message('Streaming limité à 16/32 subdivisions. Régénère la scène en 32.');return;}
    const radii=this.$('stream-radius').value==='small'?{physicsRadiusMeters:4,visibleRadiusMeters:20,retentionRadiusMeters:35}:{};
    const sliding=this.$('stream-radius').value==='window';
    const settings={...DEFAULT_STREAM,...radii,level:this.config.level},velocity=[0,0,0];
    let recycling;
    // Prepare and validate before changing the stopped session's presentation mode.
    // A rejected mode/capacity must not break the hidden spawn or active colliders.
    try{
      const position=this.player.player.state.ecefPosition;
      const plan=sliding?selectSlidingWindow(position,velocity,this.config.level):selectStreamCells(position,velocity,settings);
      this.checkCapacity(plan);
      recycling=new RecyclingIndex(64,sliding?32*1048576:64*1048576);
      for(const [key,bundle] of this.loaded)recycling.insert(key,packetBytes(bundle)+this.layerPayloadBytes(key));
    }catch(error){this.message(`${error.message} — choisis un niveau moins fin ou un rayon réduit.`);return;}
    this.player.physics.setCapacity(STREAM_LIMITS.maxCells);
    this.sliding=sliding;this.settings=settings;this.velocity=velocity;this.recycling=recycling;
    if(!this.sliding){this.shown=new Set(this.loaded.keys());this.view.setVisibleCells([...this.loaded.values()].map(b=>b.packet.id));this.player.physics.setActiveCells(null);}
    else this.player.physics.setActiveCells([...this.shown].map(k=>this.loaded.get(k).packet.id));
    this.reused=0;this.windowSwitches=0;this.maxSwitchMs=0;this.waiting=false;this.plan=null;
    this.epoch++;this.active=true;this.error=null;this.nextSelection=0;this.lastReport=0;this.now=0;
    this.scheduler=new CellScheduler();this.cache=new WeightedLru(STREAM_LIMITS.cacheBytes,STREAM_LIMITS.cacheEntries);
    this.pool=new StreamWorkerPool(this.config.source==='mapbox'?1:Math.max(1,Math.min(2,(navigator.hardwareConcurrency||2)-2)));
    this.admission=null;this.imageFlight=null;this.imageReady=null;this.imageFailures=new Set();this.imageSerial=1000000;
    this.imageryInstalled=0;this.maxStageMs={};this.maxCellWorkMs=0;this.currentCellWorkMs=0;
    this.httpCharged=0;this.httpActual=0;this.diskHits=0;this.workerCompleted=0;this.evicted=0;
    this.installed=0;this.peakCells=this.loaded.size;this.peakQueuedBytes=0;this.maxCommitMs=0;this.sourceCacheBytes=0;
    this.persistent=this.$('stream-cache').checked&&this.config.source==='synthetic';
    for(const [key,bundle] of this.loaded)this.scheduler.seed({key,id:bundle.packet.id,priority:0,distanceMeters:0,visible:true,physics:true});
    this.message(this.config.source==='mapbox'?'Streaming Mapbox expérimental : budget 256 requêtes.':this.sliding?'Fenêtre 3×3 active : préparation des voisines.':'Streaming métrique synthétique actif.');
    this.buttons();this.report();
  }
  select(position){return this.sliding?selectSlidingWindow(position,this.velocity,this.config.level):selectStreamCells(position,this.velocity,this.settings);}
  protectedKeys(){return new Set([...(this.plan?.wanted||[]).map(i=>i.key),...this.shown,...this.pinned]);}
  /** Commit only an entirely ready window. One synchronous render/physics switch. */
  present(keys){
    if([...keys].some(key=>!this.loaded.has(key)))return false;
    if(keys.size===this.shown.size&&[...keys].every(k=>this.shown.has(k)))return true;
    const start=performance.now(),ids=[...keys].map(k=>this.loaded.get(k).packet.id);
    const previous=[...this.shown].map(k=>this.loaded.get(k).packet.id);
    this.player.physics.setActiveCells(ids);
    try{this.view.setVisibleCells(ids);}catch(error){this.player.physics.setActiveCells(previous);throw error;}
    for(const key of keys)if(!this.shown.has(key)&&this.seen.has(key))this.reused++;
    this.shown=new Set(keys);for(const key of keys)this.seen.add(key);
    this.recycling?.touch(keys);this.windowSwitches++;this.metricsDirty=true;this.player.report();
    this.maxSwitchMs=Math.max(this.maxSwitchMs,performance.now()-start);return true;
  }
  trimRecycled(reservedBytes=0,reservedCells=0){
    const key=this.recycling.victim(this.protectedKeys(),reservedBytes,reservedCells);
    if(key&&this.scheduler.evictRetained(key))this.evict([key]);
  }
  checkCapacity(plan){if(new Set([...plan.wanted.map(i=>i.key),...this.pinned]).size>STREAM_LIMITS.maxCells)throw new Error('STREAM_RESIDENCY_BUDGET');}
  stop(reason=null) {
    this.epoch++;this.active=false;
    this.admission?.cancel();this.admission=null;
    this.imageFlight?.controller.abort();this.imageFlight=null;this.imageReady=null;
    for(const controller of this.controllers.values())controller.abort();this.controllers.clear();
    this.pool?.dispose();this.scheduler?.dispose();this.cache?.clear();
    if(reason){this.error=reason;this.message(`Streaming arrêté : ${reason}. Terrain déjà chargé conservé.`);}
    else this.message('Streaming arrêté. Terrain déjà chargé conservé.');
    this.buttons();this.report();
  }
  evict(keys){
    if(!keys.length)return;
    const remove=new Set(keys.filter(key=>!this.pinned.has(key)&&this.loaded.has(key)));
    if(!remove.size)return;
    const remaining=[...this.loaded].filter(([key])=>!remove.has(key)).map(([,value])=>value.packet);
    // No fall-through frame: collision and visual residency change synchronously.
    this.player.physics.syncPackets(remaining);
    for(const key of remove){
      if(this.imageFlight?.key===key)this.imageFlight.controller.abort();
      this.imageFailures?.delete(key);
      const value=this.loaded.get(key);this.view.removeCell(value.packet.id);this.loaded.delete(key);
      this.cache.set(key,value,packetBytes(value));this.recycling?.delete(key);this.seen?.delete(key);this.shown?.delete(key);this.evicted++;}
    this.metricsDirty=true;
  }
  dispatch(job) {
    const {ticket,interest}=job,epoch=this.epoch;
    const cached=this.cache.take(ticket.key);
    if(cached){this.scheduler.complete(ticket,cached,packetBytes(cached));return;}
    let grant=0;
    if(this.config.source==='mapbox') {
      const dem=planRasterTiles([interest.id],Math.min(interest.id.level,15),256,this.config.subdivisions,1);
      grant=Math.min(2*(dem.length+1),HTTP_LIMIT-this.httpCharged);
      if(grant<=0){this.stop('STREAM_HTTP_BUDGET');return;}
      this.httpCharged+=grant; // Reserve worst case BEFORE starting network work.
    }
    const controller=new AbortController();this.controllers.set(ticket.revision,controller);
    const input={...this.config,id:interest.id,persistent:this.persistent,httpGrant:grant,layer:'terrain'};
    const account=attempts=>{
      // On crash/termination, retain the whole reservation: never reset a hidden quota.
      if(Number.isInteger(attempts)&&attempts>=0&&attempts<=grant){this.httpCharged-=grant-attempts;this.httpActual+=attempts;}
    };
    this.pool.run(ticket,input,controller.signal).then(result=>{
      if(epoch!==this.epoch||this.disposed)return;
      account(result.attempts);this.workerCompleted++;if(result.cacheHit)this.diskHits++;
      this.sourceCacheBytes=result.sourceCacheBytes;
      validatePacket(result.bundle,input);
      this.scheduler.complete(ticket,result.bundle,packetBytes(result.bundle));
      this.peakQueuedBytes=Math.max(this.peakQueuedBytes,this.scheduler.queuedBytes);
    }).catch(error=>{
      if(epoch!==this.epoch||this.disposed)return;
      account(error.attempts);
      const code=error.message;this.scheduler.fail(ticket,code,this.now,!['ABORTED','PROVIDER_AUTH','PROVIDER_NOT_FOUND','STREAM_HTTP_BUDGET'].includes(code));
      if(['PROVIDER_AUTH','STREAM_HTTP_BUDGET'].includes(code))this.stop(code);
    }).finally(()=>{if(epoch===this.epoch)this.controllers.delete(ticket.revision);});
  }
  measureStage(stage,ms){
    if(stage==='upload'||stage==='imagery')this.didGpuWork=true;
    this.maxStageMs[stage]=Math.max(this.maxStageMs[stage]||0,ms);
    this.maxCommitMs=Math.max(this.maxCommitMs,ms);this.currentCellWorkMs+=ms;
  }
  /** One low-priority image job at a time, sharing workers and the SAME HTTP
   * quota with terrain. A slow image never blocks terrain admission. */
  updateImagery(){
    if(this.config.source!=='mapbox')return;
    if(this.imageReady){
      const result=this.imageReady;this.imageReady=null;
      const bundle=this.loaded.get(result.key);
      if(bundle!==result.bundle||bundle.texture)return;
      const next={...bundle,texture:result.texture};
      try{
        validatePacket(next,{...this.config,id:bundle.packet.id});
        const bytes=packetBytes(next),extra=bytes-packetBytes(bundle);
        if(!this.recycling.fits(extra,0)){this.trimRecycled(extra,0);this.imageReady=result;return;}
        const start=performance.now();this.view.applyTexture(bundle.packet.id,result.texture);
        this.recycling.resize(result.key,bytes+this.layerPayloadBytes(result.key));bundle.texture=result.texture;
        this.imageryInstalled++;this.metricsDirty=true;this.pendingAttributions=result.attributions;
        this.measureStage('imagery',performance.now()-start);
      }catch{this.imageFailures.add(result.key);this.error='STREAM_IMAGERY_ERROR';}
      return;
    }
    if(this.imageFlight||this.pool.available<1||this.scheduler.queuedBytes+this.scheduler.reservedBytes+STREAM_LIMITS.reservedCellBytes>STREAM_LIMITS.maxQueuedBytes)return;
    const interest=[...this.plan.wanted].sort((a,b)=>Number(this.shown.has(b.key))-Number(this.shown.has(a.key))||a.priority-b.priority)
      .find(i=>this.loaded.has(i.key)&&!this.loaded.get(i.key).texture&&!this.imageFailures.has(i.key));
    if(!interest)return;
    const bundle=this.loaded.get(interest.key),epoch=this.epoch;
    const tiles=planRasterTiles([interest.id],Math.min(interest.id.level,18),256,256,1);
    const grant=Math.min(2*(tiles.length+1),HTTP_LIMIT-this.httpCharged);
    if(grant<=0){this.stop('STREAM_HTTP_BUDGET');return;}
    this.httpCharged+=grant;
    const controller=new AbortController(),ticket={key:`imagery:${interest.key}`,revision:++this.imageSerial};
    const flight={key:interest.key,controller};this.imageFlight=flight;
    const account=attempts=>{if(Number.isSafeInteger(attempts)&&attempts>=0&&attempts<=grant){this.httpCharged-=grant-attempts;this.httpActual+=attempts;}};
    this.pool.run(ticket,{...this.config,id:interest.id,layer:'imagery',persistent:false,httpGrant:grant},controller.signal).then(result=>{
      if(epoch!==this.epoch||this.disposed)return;
      account(result.attempts);this.sourceCacheBytes=result.sourceCacheBytes;
      if(!controller.signal.aborted&&this.loaded.get(interest.key)===bundle)
        this.imageReady={key:interest.key,bundle,texture:result.texture,attributions:result.attributions};
    }).catch(error=>{
      if(epoch!==this.epoch||this.disposed)return;
      account(error.attempts);
      if(error.message!=='ABORTED')this.imageFailures.add(interest.key);
      if(['PROVIDER_AUTH','STREAM_HTTP_BUDGET'].includes(error.message))this.stop(error.message);
    }).finally(()=>{if(this.imageFlight===flight)this.imageFlight=null;});
  }
  update(dt) {
    this.buttons();
    if(!this.active||this.disposed||document.hidden||this.player.loading||!this.player.player)return;
    this.now+=Math.min(Math.max(dt,0),.1)*1000;
    const frameStart=performance.now();this.didGpuWork=false;
    try {
      const state=this.player.player.state;
      // Exponential velocity filter; one authoritative player's ECEF velocity.
      const factor=1-Math.exp(-Math.min(dt,.1)/.25);
      this.velocity=this.velocity.map((v,i)=>v+(state.velocityEcefMetersPerSecond[i]-v)*factor);
      if(this.now>=this.nextSelection){
        this.plan=this.select(state.ecefPosition);this.checkCapacity(this.plan);this.nextSelection=this.now+100;
        // In window mode, residency is bounded by LRU/count/bytes, not distance.
        const plan=this.sliding?{...this.plan,retained:new Set([...this.plan.retained,...this.loaded.keys()])}:this.plan;
        const actions=this.scheduler.reconcile(plan,this.pinned);
        for(const ticket of actions.cancel)this.controllers.get(ticket.revision)?.abort();
        this.evict(actions.evict);
      }
      // Cooperative validation, mesh creation, shader compilation and upload
      // happen on separate frames. Safety/collision commits remain atomic.
      if(this.admission&&!this.scheduler.isReady(this.admission.ready.ticket)){
        this.admission.cancel();this.admission=null;
      }
      const deadline=frameStart+STREAM_LIMITS.uploadBudgetMs;
      if(performance.now()<deadline){
        const ready=this.admission?.ready||this.scheduler.ready();
        if(ready){
          if(this.sliding)this.trimRecycled(packetBytes(ready.value),1);
          if(!this.sliding&&this.loaded.size>=STREAM_LIMITS.maxCells){
            const keep=new Set(this.plan.wanted.map(i=>i.key));
            const candidate=[...this.loaded.keys()].find(k=>!keep.has(k)&&!this.pinned.has(k));
            if(candidate&&this.scheduler.evictRetained(candidate))this.evict([candidate]);
          }
          if(this.loaded.size<STREAM_LIMITS.maxCells&&this.recycling.fits(packetBytes(ready.value))){
            try{
              if(!this.admission){
                this.currentCellWorkMs=0;
                this.admission=new CellAdmission(ready,this.view,(stage,ms)=>this.measureStage(stage,ms));
              }
              const complete=this.admission.advance(deadline);
              if(complete&&performance.now()<deadline){
                const started=performance.now(),bundle=ready.value;
                const existing=[...this.loaded.values()].map(v=>v.packet),next=[...existing,bundle.packet];
                const neighbors=scheme.getNeighbors(bundle.packet.id).map(id=>this.loaded.get(streamCellKey(id))?.packet).filter(Boolean);
                const seams=measureTerrainSeams([bundle.packet,...neighbors],this.player.player.frame,{allowSourceSnapshots:true});
                if(seams.mismatchedKeys||seams.maxGapMeters>.001||seams.maxNormalDelta>.001)throw new Error('STREAM_SEAM_MISMATCH');
                this.player.physics.syncPackets(next,new Map([[bundle.packet,bundle.colliderIndex]]));
                this.loaded.set(ready.ticket.key,bundle);this.recycling.insert(ready.ticket.key,packetBytes(bundle));
                this.scheduler.installed(ready.ticket);this.installed++;
                this.admission.finish();this.admission=null;
                if(!this.sliding){this.shown.add(ready.ticket.key);this.view.setVisibleCells([...this.loaded.values()].map(v=>v.packet.id));}
                this.metricsDirty=true;if(bundle.attributions?.length)this.pendingAttributions=bundle.attributions;
                this.peakCells=Math.max(this.peakCells,this.loaded.size);
                this.measureStage('commit',performance.now()-started);
                this.maxCellWorkMs=Math.max(this.maxCellWorkMs,this.currentCellWorkMs);
              }
            }catch(error){
              this.admission?.cancel();this.admission=null;
              this.scheduler.fail(ready.ticket,error.message,this.now,false);this.error=error.message;
            }
          }
        }
      }
      if(this.sliding){
        this.waiting=!this.present(this.plan.activeKeys);
        this.trimRecycled();
      }
      // Generation may not outrun the small byte-bounded CPU-ready/upload queue.
      for(let i=0;i<2&&this.pool.available>0&&this.active;i++){
        const imageReservation=(this.imageFlight||this.imageReady)?STREAM_LIMITS.reservedCellBytes:0;
        if(this.scheduler.queuedBytes+this.scheduler.reservedBytes+imageReservation+STREAM_LIMITS.reservedCellBytes>STREAM_LIMITS.maxQueuedBytes)break;
        const job=this.scheduler.next(this.now);if(!job)break;this.dispatch(job);
      }
      if(this.active){
        if(this.imageFlight && (!this.plan.wanted.some(i=>i.key===this.imageFlight.key) || this.scheduler.snapshot().states.QUEUED>0))this.imageFlight.controller.abort();
        if(!this.admission&&!this.didGpuWork&&performance.now()<deadline)this.updateImagery();
      }
      if(this.now-this.lastReport>200){this.report();this.lastReport=this.now;}
    }catch(error){this.stop(error.message);}
  }
  report(){
    if(!this.loaded)return;
    if(this.metricsDirty){
      const values=this.sliding?[...this.shown].map(k=>this.loaded.get(k)):[...this.loaded.values()];
      this.onChanged(values.map(v=>v.packet),this.pendingAttributions);this.pendingAttributions=null;this.metricsDirty=false;
    }
    const summary={active:this.active,source:this.config?.source,epoch:this.epoch,settings:this.settings,
      mode:this.sliding?'sliding-3x3':'metric-radius',shownKeys:[...(this.shown||[])],
      activeKeys:[...(this.plan?.activeKeys||[])],prefetchKeys:[...(this.plan?.prefetchKeys||[])],
      recycledKeys:[...this.loaded.keys()].filter(k=>!this.shown?.has(k)&&!this.plan?.wanted.some(i=>i.key===k)&&!this.pinned?.has(k)),
      reused:this.reused||0,windowSwitches:this.windowSwitches||0,waitingForWindow:this.waiting||false,
      maxSwitchMs:this.maxSwitchMs||0,residentPayloadBytes:this.recycling?.bytes||0,maxResidentPayloadBytes:this.recycling?.maxBytes||32*1048576,maxRecycled:12,
      trackedResidentKeys:this.seen?.size||0,bvhBuildCount:this.player.physics?.bvhBuildCount||0,
      mainThreadBvhBuildCount:this.player.physics?.mainThreadBvhBuildCount||0,
      preparedBvhAdoptions:this.player.physics?.preparedBvhAdoptions||0,
      admissionStage:this.admission?.stage||null,maxStageMs:this.maxStageMs||{},maxCellWorkMs:this.maxCellWorkMs||0,
      imageryInstalled:this.imageryInstalled||0,imageryPending:!!(this.imageFlight||this.imageReady),
      imageryReservationBytes:(this.imageFlight||this.imageReady)?STREAM_LIMITS.reservedCellBytes:0,
      error:this.error,installed:this.installed||0,evicted:this.evicted||0,workerCompleted:this.workerCompleted||0,
      workers:this.pool?{created:this.pool.created,terminated:this.pool.terminated,available:this.pool.available}:null,
      renderedKeys:[...this.loaded.keys()],pinnedKeys:[...(this.pinned||[])],centerKey:this.plan?.centerKey,
      cells:this.loaded.size,peakCells:this.peakCells||this.loaded.size,maxCells:STREAM_LIMITS.maxCells,
      loadedBytes:[...this.loaded.values()].reduce((n,v)=>n+packetBytes(v),0),
      cacheBytes:this.cache?.bytes||0,cacheEntries:this.cache?.size||0,cacheHits:this.cache?.hits||0,diskHits:this.diskHits||0,
      sourceCacheBytes:this.sourceCacheBytes||0,httpCharged:this.httpCharged||0,httpActual:this.httpActual||0,httpLimit:HTTP_LIMIT,
      maxCommitMs:this.maxCommitMs||0,peakQueuedBytes:this.peakQueuedBytes||0,
      scheduler:this.scheduler?.snapshot()||null};
    window.__ZERANA_STREAM_DEBUG__=summary;
    const rows=[['Visibles / recyclées',`${summary.shownKeys.length} / ${summary.recycledKeys.length}`],['Réactivées sans génération',summary.reused],['Cellules résidentes',`${summary.cells} / ${summary.maxCells}`],['Nouvelles / libérées',`${summary.installed} / ${summary.evicted}`],
      ['Cache mémoire',`${(summary.cacheBytes/1048576).toFixed(2)} Mio`],['Cache disque : hits',summary.diskHits],
      ['Requêtes Mapbox',`${summary.httpActual} / ${HTTP_LIMIT}`],['Étape d’intégration max.',`${summary.maxCommitMs.toFixed(1)} ms`]];
    this.$('stream-metrics').replaceChildren(...rows.flatMap(([key,value])=>{const a=document.createElement('dt'),b=document.createElement('dd');a.textContent=key;b.textContent=String(value);return[a,b];}));
    if(this.active&&this.sliding&&!summary.scheduler?.errors.length)this.message(this.waiting?'Préparation de la fenêtre suivante ; terrain précédent conservé.':'Fenêtre 3×3 prête. Les cellules quittées restent en recyclage.');
    if(this.active&&summary.scheduler?.errors.length)this.message(`Chargements en erreur : ${summary.scheduler.errors.join(', ')}. Le sol valide est conservé.`);
  }
  dispose(){this.stop();this.disposed=true;this.loaded.clear();this.seen?.clear();this.events.abort();this.view.onBeforeFrame=null;this.player.beforeRespawn=null;this.panel.remove();window.__ZERANA_STREAM_DEBUG__={disposed:true};}
}
