import { RoadSource,syntheticRoadTiles } from './road-source.mjs';
import { buildRoadGraph,clipRoadGraph } from '../../src/generation/roads/kernel.ts';
import { buildRoadDebugPackets } from '../../src/generation/roads/debug-packet.ts';

let current=null;const source=new RoadSource();
self.onmessage=async({data})=>{
  if(data.kind==='cancel'){if(current?.revision===data.revision)current.controller.abort();return;}
  if(data.kind!=='build'||current)return;
  const {ticket,job}=data,controller=new AbortController();current={revision:ticket.revision,controller};let attempts=0;
  try{
    if(!['synthetic','mapbox'].includes(job.source)||!Array.isArray(job.terrains)||job.terrains.length<1||job.terrains.length>9)throw new Error('ROAD_JOB_CONTRACT');
    const ids=job.terrains.map(t=>t.id),started=performance.now();
    const result=job.source==='mapbox'?await source.load(ids,job.token,controller.signal,job.httpGrant):{tiles:syntheticRoadTiles(ids),attempts:0,attribution:null,cacheHits:0,cacheBytes:0};
    attempts=result.attempts;
    const graph=buildRoadGraph(result.tiles),fragments=clipRoadGraph(graph,ids),packets=buildRoadDebugPackets(graph,job.terrains);
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
