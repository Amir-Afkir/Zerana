import './style.css';
import { fixtureEngineeringDiagnostics, fixtureEngineeringSample } from '../src/generation/roads/engineering-fixture.ts';
import './providers.css';
import './preview.css';
import './experience.css';
import { renderAttribution } from './attribution.mjs';
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
import { RoadSurfaceLayer } from './roads/surface-layer.mjs';
import { RoadSession } from './roads/road-session.mjs';
import { StreamSession } from './streaming/stream-session.mjs';
import { STREAM_LIMITS } from '../src/streaming/selection.ts';
import { PlayerSession } from './runtime/player-session.mjs';

const $ = id => document.getElementById(id);
const siteToken = String(import.meta.env.VITE_MAPBOX_API_KEY || '').trim();
const buildSha = String(import.meta.env.VITE_BUILD_SHA || 'local');
const manualMode = new URLSearchParams(location.search).get('lab') === 'manual';
const credits = new Set();
const places = { paris:[2.35,48.86],equator:[0,0],tanger:[-5.81,35.76],tokyo:[139.69,35.68],antimeridian:[179.99999,35],north:[0,85] };
let view, playerSession, streamSession, roadSession, packets=[], world, revision=0, rebases=0, sourceId='', cacheSize=0, busy=false, loadController=null, requestRevision=0, providerReport=null;
function status(message,error=false){$('status').textContent=message;$('status').classList.toggle('error',error);}
function refreshMetrics(){
  const seams=measureTerrainSeams(packets,world,{allowSourceSnapshots:true}), snapshot=view.snapshot();
  const rows=[['Cellules',packets.length],['Source',providerReport?'Mapbox / aperçu':sourceId],['Altitude',providerReport?'Datum non résolu — aperçu uniquement':'Ellipsoïdale synthétique'],['Zoom DEM / image',providerReport?`${providerReport.elevationZoom} / ${providerReport.imageryZoom}`:'—'],['Sommets',packets.reduce((n,c)=>n+c.positions.length/3,0)],
    ['Bords comparés',seams.edgePairs],['Écart CPU / m',(seams.maxGapMeters).toExponential(2)],
    ['Estimation Float32 / m',seams.estimatedFloat32GapMeters.toExponential(2)],['Clés différentes',seams.mismatchedKeys],
    ['Samples en cache',cacheSize],['Géométries GPU',snapshot.geometries],['Origines déplacées',rebases]];
  $('metrics').replaceChildren(...rows.flatMap(([name,value])=>{
    const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=name;dd.textContent=String(value);return [dt,dd];
  }));
  window.__ZERANA_TERRAIN_DEBUG__={buildSha,siteTokenConfigured:isPublicMapboxToken(siteToken),revision,rebases,cellCount:packets.length,sourceId,seams,providerReport,...snapshot};
}
function modes(){view.setModes({wireframe:$('wireframe').checked,normals:$('normals').checked,metricGrid:$('metric-grid').checked});$('uv-legend').hidden=$('source-mode').value==='mapbox'||!$('wireframe').checked;}

function attribution(values){
  for(const value of values)credits.add(value);
  renderAttribution($('provider-attribution'),[...credits]);
}
async function build(){
  const autoExplore = $('auto-explore').checked;
  let completed=false;
  playerSession?.setLoading(true);
  loadController?.abort();
  const request=++requestRevision,controller=new AbortController();loadController=controller;
  const isMapbox=$('source-mode').value==='mapbox';
  busy=true;$('build').disabled=true;$('cancel-load').hidden=!isMapbox;
  status(isMapbox?'Chargement borné du relief et du satellite…':'Construction de la scène synthétique…');
  await new Promise(requestAnimationFrame);
  try{
    const position=geodeticDegrees(degrees(Number($('longitude').value)),degrees(Number($('latitude').value)),meters(0));
    const subdivisions=Number($('subdivisions').value),level=Number($('level').value),profile=$('profile').value;
    const allowPreview=isMapbox && $('allow-preview').checked,token=isMapbox?resolveMapboxToken($('mapbox-token').value,siteToken):'';
    const ids=terrainPatchCells(position,level,Number($('side').value));
    const result=isMapbox?await loadMapboxPatch({cells:ids,subdivisions,token,
      allowPreview,signal:controller.signal,
      onProgress:(n,total)=>{if(request===requestRevision)status(`Tuiles reçues : ${n}/${total}`);}}):null;
    if(controller.signal.aborted||request!==requestRevision)return;
    const source=result?.source||syntheticElevation(profile);
    const sampler=new TerrainSampler(source,undefined,{allowUnresolvedDatumPreview:isMapbox});
    // Bounded static diagnostic generation, not an interactive streaming implementation.
    const next=ids.map(id=>buildTerrainCell(id,sampler,subdivisions));
    const markerPosition=geodeticRadians(position.longitudeRad,position.latitudeRad,source.heightAt(position));
    const nextWorld=createGeoAnchor(markerPosition);
    if(controller.signal.aborted||request!==requestRevision)return;
    roadSession?.reset();streamSession?.stop();
    view.setPatch(next,nextWorld,geodeticToEcef(markerPosition),result?.textures);
    packets=next;world=nextWorld;
    playerSession.install(next,nextWorld,geodeticToEcef(markerPosition),allowPreview);
    streamSession.install(next,result?.textures,{source:isMapbox?'mapbox':'synthetic',profile,
      level,subdivisions,allowPreview,token});
    window.__ZERANA_ENGINEERING_DEBUG__={active:!isMapbox&&profile==='engineering',
      source:source.id,...(!isMapbox&&profile.startsWith('engineering')?{...fixtureEngineeringDiagnostics(),
        spawn:fixtureEngineeringSample(position)}:{})};
    sourceId=source.id;cacheSize=sampler.size;sampler.clear();
    providerReport=result?{snapshotId:result.snapshotId,elevationZoom:result.elevationZoom,imageryZoom:result.imageryZoom,
      requestCount:result.requestCount,waterFallbackCount:result.waterFallbackCount,evidence:result.evidence,
      verticalReference:source.verticalReference,accuracy:'not-certified'}:null;
    $('source-badge').textContent=isMapbox?'MAPBOX · RELIEF APPROXIMATIF':'SYNTHÉTIQUE · 1 UNITÉ = 1 MÈTRE';
    $('source-badge').classList.toggle('preview-warning',isMapbox);
    $('attribution').hidden=!isMapbox;$('uv-legend').hidden=isMapbox||!$('wireframe').checked;
    credits.clear();if(result)attribution(result.attributions);
    revision++;rebases=0;modes();view.overview();view.render();refreshMetrics();completed=true;
    document.body.dataset.ready=String(revision);
    status(isMapbox?'Satellite et relief reçus. Altitudes source non certifiées WGS84.':'Prêt. Terrain de test, sans appel fournisseur.');
  }catch(error){if(request===requestRevision)status(error.name==='AbortError'?'Chargement annulé ; scène précédente conservée.':error.message,true);}
  finally{if(request===requestRevision){
    busy=false;$('build').disabled=false;$('cancel-load').hidden=true;playerSession?.setLoading(false);
    if(completed&&autoExplore){
      streamSession.$('stream-network-consent').checked=isMapbox;
      roadSession.surfaceLayer.setEnabled(true);
      streamSession.start();playerSession.start({focus:false});
      status(streamSession.active?'Prêt : streaming actif. Utilise les touches pour avancer.':'Terrain prêt ; consulte les outils pour le streaming.');
    }
  }}
}

try{
  $('auto-explore').checked=!manualMode;
  $('world-options').open=manualMode;$('diagnostics').open=manualMode;
  $('wireframe').checked=manualMode;
  if(!manualMode){
    $('source-mode').value=isPublicMapboxToken(siteToken)?'mapbox':'synthetic';
    $('allow-preview').checked=true;$('profile').value='flat';
  }
  if(!manualMode){
    const params=new URLSearchParams(location.search);
    if(['synthetic','mapbox'].includes(params.get('source')))$('source-mode').value=params.get('source');
    if(['flat','waves','engineering','engineering-raw'].includes(params.get('profile'))&&$('source-mode').value==='synthetic')$('profile').value=params.get('profile');
    if(['15','17','19','21'].includes(params.get('level')))$('level').value=params.get('level');
  }
  $('provider-options').hidden=$('source-mode').value!=='mapbox';
  $('build-version').textContent=`Préversion · ${buildSha.slice(0,12)}`;
  $('site-token-state').textContent=isPublicMapboxToken(siteToken)?'Token public du site disponible ; laisse ce champ vide pour l’utiliser.':'Aucun token de site configuré ; saisis ton token public.';
  view=new TerrainView($('viewport'),error=>status(error,true));
  playerSession=new PlayerSession(view,next=>{
    view.rebase(next);world=next;rebases++;playerSession.rebase(next);refreshMetrics();
  });
  streamSession=new StreamSession(view,playerSession,(next,attributions)=>{
    packets=next;if(attributions?.length)attribution(attributions);refreshMetrics();
  });
  roadSession=new RoadSession(view,()=>busy?null:streamSession.config,value=>{attribution([value]);$('attribution').hidden=false;},refreshMetrics);
  roadSession.surfaceLayer=new RoadSurfaceLayer(roadSession,streamSession);
  const terrainFrame=view.onBeforeFrame;
  view.onBeforeFrame=dt=>{
    const deadline=performance.now()+STREAM_LIMITS.uploadBudgetMs;
    terrainFrame(dt);
    roadSession.surfaceLayer.update(deadline,!streamSession.didGpuWork&&!streamSession.admission);
  };
  $('runtime-tools').append(playerSession.panel,streamSession.panel,roadSession.panel);
  playerSession.autoResume=!manualMode;
  $('auto-explore').addEventListener('change',()=>{playerSession.autoResume=$('auto-explore').checked;});
  modes();
  $('source-mode').addEventListener('change',()=>{streamSession.stop();$('provider-options').hidden=$('source-mode').value!=='mapbox';loadController?.abort();if(!manualMode)void build();});
  $('cancel-load').addEventListener('click',()=>loadController?.abort());
  $('controls').addEventListener('submit',event=>{event.preventDefault();void build();});
  $('place').addEventListener('change',()=>{
    const [lon,lat]=places[$('place').value];$('longitude').value=lon;$('latitude').value=lat;if(!manualMode)void build();
  });
  for(const name of ['wireframe','normals','metric-grid'])$(name).addEventListener('change',()=>{modes();view.render();refreshMetrics();});
  $('overview').addEventListener('click',()=>{playerSession.pause();view.overview();view.render();refreshMetrics();});
  $('human').addEventListener('click',()=>{playerSession.pause();view.humanView();view.render();refreshMetrics();});
  $('rebase').addEventListener('click',()=>{
    if(!world)return;
    const next=createGeoAnchor(ecefToGeodetic(threeLocalToEcef([512,0,0],world)));
    view.rebase(next);world=next;rebases++;playerSession.rebase(next);view.render();refreshMetrics();
  });
  window.addEventListener('pagehide',()=>{loadController?.abort();roadSession.dispose();streamSession.dispose();playerSession.dispose();view.dispose();},{once:true});
  void build();
}catch(error){status(`Initialisation WebGL impossible : ${error.message}`,true);}
