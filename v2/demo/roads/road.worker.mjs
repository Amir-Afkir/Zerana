import { WaterSource } from '../water/source.mjs';
import { buildEnvironmentPacket } from '../../src/generation/environment/debug-packet.ts';
import { syntheticEnvironmentTile } from '../environment/synthetic.mjs';
import { RoadSource,syntheticRoadTiles } from './road-source.mjs';
import { buildRoadGraph,clipRoadGraph } from '../../src/generation/roads/kernel.ts';
import { buildRoadDebugPackets } from '../../src/generation/roads/debug-packet.ts';

import { buildRoadSurface } from '../../src/generation/roads/surface.ts';

let current=null;const source=new RoadSource(),waterSource=new WaterSource();
self.onmessage=async({data})=>{
  if(data.kind==='cancel'){if(current?.revision===data.revision)current.controller.abort();return;}
  if(data.kind!=='build'||current)return;
  const {ticket,job}=data,controller=new AbortController();current={revision:ticket.revision,controller};let attempts=0;
  try{
    if(!['synthetic','mapbox'].includes(job.source)||!Array.isArray(job.terrains)||job.terrains.length<1||job.terrains.length>9)throw new Error('ROAD_JOB_CONTRACT');
    const ids=job.terrains.map(t=>t.id),started=performance.now();
    const result=job.source==='mapbox'?await source.load(ids,job.token,controller.signal,job.httpGrant):{tiles:syntheticRoadTiles(ids,job.profile),attempts:0,attribution:null,cacheHits:0,cacheBytes:0};
    attempts=result.attempts;
    const graph=buildRoadGraph(result.tiles);
    if(job.mode==='surface'){
      if(job.terrains.length!==1)throw new Error('ROAD_SURFACE_JOB');
      let surface=null,surfaceError=null;
      try{surface=buildRoadSurface(graph,job.terrains[0]);}catch(e){surfaceError=/^ROAD_[A-Z_]+$/.test(e.message)?e.message:'ROAD_SURFACE_FAILURE';}
      let environment=null,environmentError=null;
      try{
        const id=job.terrains[0].id;
        const owners=result.tiles.filter(t=>Math.floor(id.x/2**(id.level-t.z))===t.x&&Math.floor(id.y/2**(id.level-t.z))===t.y);
        const tiles=owners.map(t=>job.source==='synthetic'?syntheticEnvironmentTile(t):t.environment);
        environmentError=owners.find(t=>t.environmentError)?.environmentError||null;
        if(!environmentError&&tiles.every(Boolean))environment=buildEnvironmentPacket(tiles,job.terrains[0]);
      }catch(e){environmentError=/^ENV_[A-Z_]+$/.test(e.message)?e.message:'ENV_BUILD_FAILED';}
      let water=null,waterError=null,waterCacheBytes=0,waterAttributions=[];
      if(job.water===true)try{
        const tiles=result.tiles.map(t=>job.source==='synthetic'?syntheticEnvironmentTile(t):t.environment);
        if(tiles.some(t=>!t))throw new Error('WATER_CONTEXT_INCOMPLETE');
        const w=await waterSource.build({tiles,terrain:job.terrains[0],source:job.source,profile:job.profile,token:job.token,
          evidence:job.terrainEvidence||[],signal:controller.signal,
          onAttempt:()=>{if(attempts>=job.httpGrant)throw new Error('WATER_HTTP_BUDGET');attempts++;}});
        water=w.packet;waterAttributions=w.attributions;waterCacheBytes=w.cacheBytes;
      }catch(e){waterError=/^WATER_[A-Z_]+$/.test(e.message)?e.message:'WATER_SOURCE_UNAVAILABLE';}
      if(controller.signal.aborted)throw new DOMException('Cancelled','AbortError');
      self.postMessage({kind:'result',ticket,surface,surfaceError,environment,environmentError,water,waterError,waterCacheBytes,waterAttributions,attribution:result.attribution,attempts,
        summary:{decodedSnapshots:result.decodedSnapshots||0,cacheBytes:result.cacheBytes,cacheHits:result.cacheHits,generationMs:performance.now()-started}},
        [...(surface?[surface.positions.buffer,surface.normals.buffer,surface.colors.buffer,surface.uvs.buffer,surface.indices.buffer]:[]),...(environment?[environment.positions.buffer,environment.colors.buffer]:[]),...(water?[water.positions.buffer,water.normals.buffer,water.uvs.buffer,water.indices.buffer]:[])]);
      return;
    }
    const fragments=clipRoadGraph(graph,ids),packets=buildRoadDebugPackets(graph,job.terrains);
    if(controller.signal.aborted)throw new DOMException('Cancelled','AbortError');
    const summary={schema:graph.schema,source:job.source,sourceZoom:result.tiles[0]?.z,
      topologyAuthority:graph.topologyAuthority,edges:graph.edges.length,nodes:graph.nodes.length,
      junctionCandidates:graph.nodes.filter(n=>n.edges.length>2).length,
      unresolvedSourcePorts:graph.unresolvedSourcePorts,duplicates:graph.duplicateSegments,
      fragments:fragments.length,debugSegments:packets.reduce((n,p)=>n+p.segmentCount,0),
      deferredStructures:graph.edges.filter(e=>!['ground','ford'].includes(e.attributes.structure)||e.attributes.category==='STEPS').length,
      sourceTiles:graph.sourceTiles,cacheHits:result.cacheHits,cacheBytes:result.cacheBytes,
      generationMs:performance.now()-started,packetBytes:packets.reduce((n,p)=>n+p.positions.byteLength+p.colors.byteLength,0)};
    self.postMessage({kind:'result',ticket,packets,summary,attribution:result.attribution,attempts},packets.flatMap(p=>[p.positions.buffer,p.colors.buffer]));
  }catch(error){
    const safe=String(error.message||'').match(/^ROAD_[A-Z_]+$/)?.[0];
    self.postMessage({kind:'error',ticket,code:error.name==='AbortError'?'ABORTED':safe||'ROAD_DECODE_FAILED',attempts:error.attempts??attempts});
  }finally{current=null;}
};
