import { StreamWorkerPool } from '../streaming/worker-pool.mjs';
import { ROAD_HTTP_LIMIT } from './road-source.mjs';
import { roadCellKey } from '../../src/generation/roads/kernel.ts';

/** Stage 9: explicit bounded snapshot diagnostic, NOT a second world streamer. */
export class RoadSession {
  constructor(view,getConfig,credit,onChanged=()=>{}){
    this.onChanged=onChanged;this.view=view;this.getConfig=getConfig;this.credit=credit;this.epoch=0;this.worldEpoch=0;this.httpLimit=ROAD_HTTP_LIMIT;this.charged=0;this.active=false;
    this.panel=document.createElement('section');this.panel.className='road-panel';
    this.panel.innerHTML=`<h2>Routes — surfaces et diagnostic</h2><p class="footnote">Diagnostic optionnel des axes cartographiques. Cyan : routes · jaune : chemins. Ponts, tunnels et escaliers restent en données, sans faux tracé au sol.</p><button type="button" id="road-load">Analyser la zone visible</button><button type="button" id="road-cancel" hidden>Annuler</button><label class="consent"><input type="checkbox" id="road-visible" checked /> Afficher les axes</label><p id="road-status" role="status">Chargement manuel ; maximum 32 requêtes vectorielles par monde. Aucun appel au démarrage.</p>`;
    this.$=id=>this.panel.querySelector(`#${id}`);this.events=new AbortController();
    this.$('road-load').addEventListener('click',()=>void this.load(),{signal:this.events.signal});
    this.$('road-cancel').addEventListener('click',()=>this.cancel(),{signal:this.events.signal});
    this.$('road-visible').addEventListener('change',()=>{this.view.setRoadDebugVisible(this.$('road-visible').checked);this.onChanged();},{signal:this.events.signal});
    this.report({state:'idle'});
  }
  report(extra={}){
    this.debug={...this.debug,...extra,httpCharged:this.charged,httpLimit:this.httpLimit};
    window.__ZERANA_ROADS_DEBUG__=this.debug;
  }
  cancel(){this.epoch++;this.controller?.abort();this.active=false;this.$('road-load').disabled=false;this.$('road-cancel').hidden=true;this.report({state:'cancelled'});}
  ensurePool(){return this.pool??=new StreamWorkerPool(1,()=>new Worker(new URL('./road.worker.mjs',import.meta.url),{type:'module'}));}
  reserve(){const grant=Math.min(ROAD_HTTP_LIMIT,Math.max(0,this.httpLimit-this.charged));this.charged+=grant;return grant;}
  account(grant,attempts){if(Number.isInteger(attempts)&&attempts>=0&&attempts<=grant)this.charged-=grant-attempts;}
  reset(){this.worldEpoch++;this.surfaceLayer?.reset();this.cancel();this.pool?.dispose();this.pool=null;this.charged=0;this.view.clearRoadDebug();this.report({state:'idle',summary:null,error:null});}
  async load(){
    const config=this.getConfig();if(this.active||!config||this.pool?.available===0)return;
    const cells=this.view.cellViews.filter(c=>c.root.visible);
    if(!cells.length||cells.length>9)return;
    const epoch=++this.epoch,controller=new AbortController();this.controller=controller;this.active=true;
    this.$('road-load').disabled=true;this.$('road-cancel').hidden=false;
    this.$('road-status').textContent='Analyse des axes dans un worker…';this.report({state:'loading',error:null});
    this.ensurePool();
    const grant=config.source==='mapbox'?this.reserve():0;
    const account=attempts=>{if(Number.isInteger(attempts)&&attempts>=0&&attempts<=grant)this.charged-=grant-attempts;};
    try{
      const result=await this.pool.run({key:'road-snapshot',revision:epoch},{source:config.source,token:config.token,
        terrains:cells.map(c=>c.packet),httpGrant:grant},controller.signal);
      if(epoch!==this.epoch)return;account(result.attempts);
      // A delayed snapshot cannot attach itself to a replaced terrain or an
      // evicted/recreated cell with the same geographical key.
      const valid=new Set(cells.filter(c=>this.view.findCell(c.packet.id)===c).map(c=>roadCellKey(c.packet.id)));
      this.view.setRoadDebugPackets(result.packets.filter(p=>valid.has(p.cellKey)));
      this.view.setRoadDebugVisible(this.$('road-visible').checked);this.onChanged();
      if(result.attribution)this.credit(result.attribution);
      this.report({state:'ready',summary:result.summary,attachedCells:valid.size});
      this.$('road-status').textContent=`${result.summary.fragments} fragments · ${result.summary.debugSegments} segments affichables. ${result.summary.unresolvedSourcePorts} extrémités source non raccordées (diagnostic). Instantané : relance après déplacement.`;
    }catch(error){if(epoch!==this.epoch)return;account(error.attempts);this.report({state:'error',error:error.message});this.$('road-status').textContent=`Analyse non publiée : ${error.message}. Terrain conservé.`;}
    finally{if(epoch===this.epoch){this.active=false;this.$('road-load').disabled=false;this.$('road-cancel').hidden=true;this.report();}}
  }
  dispose(){this.reset();this.events.abort();this.panel.remove();this.report({state:'disposed'});}
}
