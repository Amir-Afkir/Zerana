import './style.css';
import './providers.css';
import './preview.css';
import { isPublicMapboxToken, resolveMapboxToken } from './site-token.mjs';
import { loadMapboxPatch } from './providers/mapbox-raster.mjs';
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
const siteToken = String(import.meta.env.VITE_MAPBOX_API_KEY || '').trim();
const buildSha = String(import.meta.env.VITE_BUILD_SHA || 'local');
const places = { paris:[2.35,48.86],equator:[0,0],tanger:[-5.81,35.76],tokyo:[139.69,35.68],antimeridian:[179.99999,35],north:[0,85] };
let view, packets=[], world, revision=0, rebases=0, sourceId='', cacheSize=0, busy=false, loadController=null, requestRevision=0, providerReport=null;
function status(message,error=false){$('status').textContent=message;$('status').classList.toggle('error',error);}
function refreshMetrics(){
  const seams=measureTerrainSeams(packets,world), snapshot=view.snapshot();
  const rows=[['Cellules',packets.length],['Source',providerReport?'Mapbox / aperçu':sourceId],['Altitude',providerReport?'Datum non résolu — aperçu uniquement':'Ellipsoïdale synthétique'],['Zoom DEM / image',providerReport?`${providerReport.elevationZoom} / ${providerReport.imageryZoom}`:'—'],['Sommets',packets.reduce((n,c)=>n+c.positions.length/3,0)],
    ['Bords comparés',seams.edgePairs],['Écart CPU / m',(seams.maxGapMeters).toExponential(2)],
    ['Estimation Float32 / m',seams.estimatedFloat32GapMeters.toExponential(2)],['Clés différentes',seams.mismatchedKeys],
    ['Samples en cache',cacheSize],['Géométries GPU',snapshot.geometries],['Origines déplacées',rebases]];
  $('metrics').replaceChildren(...rows.flatMap(([name,value])=>{
    const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=name;dd.textContent=String(value);return [dt,dd];
  }));
  window.__ZERANA_TERRAIN_DEBUG__={buildSha,siteTokenConfigured:isPublicMapboxToken(siteToken),revision,rebases,cellCount:packets.length,sourceId,seams,providerReport,...snapshot};
}
function modes(){view.setModes({wireframe:$('wireframe').checked,normals:$('normals').checked,metricGrid:$('metric-grid').checked});}

function attribution(values){
  const container=$('provider-attribution');container.replaceChildren();
  for(const value of values){
    const parsed=new DOMParser().parseFromString(value,'text/html');
    // Provider HTML is untrusted: copy text and safe HTTPS links only, no attributes or scripts.
    for(const node of parsed.body.childNodes){
      if(node.nodeType===Node.TEXT_NODE){container.append(document.createTextNode(node.textContent));continue;}
      if(node.nodeName==='A'){
        try{const url=new URL(node.getAttribute('href'));if(url.protocol!=='https:')continue;
          const a=document.createElement('a');a.href=url.href;a.textContent=node.textContent;a.rel='noopener noreferrer';a.target='_blank';container.append(a,document.createTextNode(' '));
        }catch{/* invalid link omitted */}
      }
    }
  }
}
async function build(){
  loadController?.abort();
  const request=++requestRevision,controller=new AbortController();loadController=controller;
  const isMapbox=$('source-mode').value==='mapbox';
  busy=true;$('build').disabled=true;$('cancel-load').hidden=!isMapbox;
  status(isMapbox?'Chargement borné du relief et du satellite…':'Construction de la scène synthétique…');
  await new Promise(requestAnimationFrame);
  try{
    const position=geodeticDegrees(degrees(Number($('longitude').value)),degrees(Number($('latitude').value)),meters(0));
    const subdivisions=Number($('subdivisions').value),ids=terrainPatchCells(position,Number($('level').value),Number($('side').value));
    const result=isMapbox?await loadMapboxPatch({cells:ids,subdivisions,token:resolveMapboxToken($('mapbox-token').value,siteToken),
      allowPreview:$('allow-preview').checked,signal:controller.signal,
      onProgress:(n,total)=>{if(request===requestRevision)status(`Tuiles reçues : ${n}/${total}`);}}):null;
    if(controller.signal.aborted||request!==requestRevision)return;
    const source=result?.source||syntheticElevation($('profile').value);
    const sampler=new TerrainSampler(source,undefined,{allowUnresolvedDatumPreview:isMapbox});
    // Bounded static diagnostic generation, not an interactive streaming implementation.
    const next=ids.map(id=>buildTerrainCell(id,sampler,subdivisions));
    const markerPosition=geodeticRadians(position.longitudeRad,position.latitudeRad,source.heightAt(position));
    const nextWorld=createGeoAnchor(markerPosition);
    if(controller.signal.aborted||request!==requestRevision)return;
    view.setPatch(next,nextWorld,geodeticToEcef(markerPosition),result?.textures);
    packets=next;world=nextWorld;sourceId=source.id;cacheSize=sampler.size;sampler.clear();
    providerReport=result?{snapshotId:result.snapshotId,elevationZoom:result.elevationZoom,imageryZoom:result.imageryZoom,
      requestCount:result.requestCount,waterFallbackCount:result.waterFallbackCount,evidence:result.evidence,
      verticalReference:source.verticalReference,accuracy:'not-certified'}:null;
    $('source-badge').textContent=isMapbox?'MAPBOX · DATUM NON RÉSOLU · APERÇU APPROXIMATIF':'SYNTHÉTIQUE · 1 UNITÉ = 1 MÈTRE';
    $('source-badge').classList.toggle('preview-warning',isMapbox);
    $('attribution').hidden=!isMapbox;$('uv-legend').hidden=isMapbox;
    if(result)attribution(result.attributions);
    revision++;rebases=0;modes();view.overview();view.render();refreshMetrics();
    document.body.dataset.ready=String(revision);
    status(isMapbox?'Satellite et relief reçus. Altitudes source non certifiées WGS84.':'Scène prête. Relief synthétique, aucun fournisseur externe.');
  }catch(error){if(request===requestRevision)status(error.name==='AbortError'?'Chargement annulé ; scène précédente conservée.':error.message,true);}
  finally{if(request===requestRevision){busy=false;$('build').disabled=false;$('cancel-load').hidden=true;}}
}

try{
  $('build-version').textContent=`Préversion · ${buildSha.slice(0,12)}`;
  $('site-token-state').textContent=isPublicMapboxToken(siteToken)?'Token public du site disponible ; laisse ce champ vide pour l’utiliser.':'Aucun token de site configuré ; saisis ton token public.';
  view=new TerrainView($('viewport'),error=>status(error,true));
  $('source-mode').addEventListener('change',()=>{$('provider-options').hidden=$('source-mode').value!=='mapbox';loadController?.abort();});
  $('cancel-load').addEventListener('click',()=>loadController?.abort());
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
  window.addEventListener('pagehide',()=>{loadController?.abort();view.dispose();},{once:true});
  void build();
}catch(error){status(`Initialisation WebGL impossible : ${error.message}`,true);}
