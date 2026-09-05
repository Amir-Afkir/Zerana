import './style.css';
import { geodeticDegrees, geodeticRadians } from '../src/geo/geodetic.ts';
import { geodeticToEcef, ecefToGeodetic } from '../src/geo/ecef.ts';
import { degrees, meters } from '../src/geo/units.ts';
import { createGeoAnchor } from '../src/geo/enu.ts';
import { threeLocalToEcef } from '../src/geo/three-frame.ts';
import { terrainPatchCells } from '../src/world/terrain-patch.ts';
import { syntheticElevation } from '../src/generation/terrain/synthetic-elevation.ts';
import { TerrainSampler } from '../src/generation/terrain/terrain-sampler.ts';
import { buildTerrainCell } from '../src/generation/terrain/terrain-builder.ts';
import { measureTerrainSeams } from '../src/debug/seam-metrics.ts';
import { TerrainView } from './render/terrain-view.mjs';

const $ = id => document.getElementById(id);
const places = { paris:[2.35,48.86],equator:[0,0],tanger:[-5.81,35.76],tokyo:[139.69,35.68],antimeridian:[179.99999,35],north:[0,85] };
let view, packets=[], world, revision=0, rebases=0, sourceId='', cacheSize=0, busy=false;
function status(message,error=false){$('status').textContent=message;$('status').classList.toggle('error',error);}
function refreshMetrics(){
  const seams=measureTerrainSeams(packets,world), snapshot=view.snapshot();
  const rows=[['Cellules',packets.length],['Source',sourceId],['Sommets',packets.reduce((n,c)=>n+c.positions.length/3,0)],
    ['Bords comparés',seams.edgePairs],['Écart CPU / m',(seams.maxGapMeters).toExponential(2)],
    ['Estimation Float32 / m',seams.estimatedFloat32GapMeters.toExponential(2)],['Clés différentes',seams.mismatchedKeys],
    ['Samples en cache',cacheSize],['Géométries GPU',snapshot.geometries],['Origines déplacées',rebases]];
  $('metrics').replaceChildren(...rows.flatMap(([name,value])=>{
    const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=name;dd.textContent=String(value);return [dt,dd];
  }));
  window.__ZERANA_TERRAIN_DEBUG__={revision,rebases,cellCount:packets.length,sourceId,seams,...snapshot};
}
function modes(){view.setModes({wireframe:$('wireframe').checked,normals:$('normals').checked,metricGrid:$('metric-grid').checked});}
async function build(){
  if(busy)return;
  busy=true;$('build').disabled=true;status('Construction de la scène synthétique…');
  await new Promise(requestAnimationFrame);
  try{
    const position=geodeticDegrees(degrees(Number($('longitude').value)),degrees(Number($('latitude').value)),meters(0));
    const source=syntheticElevation($('profile').value),sampler=new TerrainSampler(source);
    const ids=terrainPatchCells(position,Number($('level').value),Number($('side').value));
    // Bounded static diagnostic generation. No streaming performance claim here.
    const next=ids.map(id=>buildTerrainCell(id,sampler,Number($('subdivisions').value)));
    const markerPosition=geodeticRadians(position.longitudeRad,position.latitudeRad,source.heightAt(position));
    const nextWorld=createGeoAnchor(markerPosition);
    view.setPatch(next,nextWorld,geodeticToEcef(markerPosition));
    packets=next;world=nextWorld;sourceId=source.id;cacheSize=sampler.size;sampler.clear();
    revision++;rebases=0;modes();view.overview();view.render();refreshMetrics();
    document.body.dataset.ready=String(revision);
    status('Scène prête. Relief synthétique, aucun fournisseur externe.');
  }catch(error){status(error.message,true);}
  finally{busy=false;$('build').disabled=false;}
}
try{
  view=new TerrainView($('viewport'),error=>status(error,true));
  $('controls').addEventListener('submit',event=>{event.preventDefault();void build();});
  $('place').addEventListener('change',()=>{
    const [lon,lat]=places[$('place').value];$('longitude').value=lon;$('latitude').value=lat;
  });
  for(const name of ['wireframe','normals','metric-grid'])$(name).addEventListener('change',()=>{modes();view.render();refreshMetrics();});
  $('overview').addEventListener('click',()=>{view.overview();view.render();refreshMetrics();});
  $('human').addEventListener('click',()=>{view.humanView();view.render();refreshMetrics();});
  $('rebase').addEventListener('click',()=>{
    if(!world)return;
    const next=createGeoAnchor(ecefToGeodetic(threeLocalToEcef([512,0,0],world)));
    view.rebase(next);world=next;rebases++;view.render();refreshMetrics();
  });
  window.addEventListener('pagehide',()=>view.dispose(),{once:true});
  void build();
}catch(error){status(`Initialisation WebGL impossible : ${error.message}`,true);}
