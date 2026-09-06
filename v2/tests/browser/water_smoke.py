"""PR15 water surfaces. Fixtures by default; explicit live run is globally bounded.
Never persist provider URLs with query strings, tokens or raw provider payloads.
"""
import asyncio, base64, functools, hashlib, http.server, json, os, shutil, tempfile, threading
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from playwright.async_api import async_playwright
from provider_smoke import png, QuietHandler
from environment_smoke import environmental_mvt
from experience_smoke import query, walk
ROOT=Path(__file__).resolve().parents[2]
LIVE=os.getenv('ZERANA_LIVE_WATER')=='1'
OUTPUT=ROOT/'browser-results'/('water-live' if LIVE else 'water')
LIMIT=256
STATE='''({water:window.__ZERANA_WATER_DEBUG__,road:window.__ZERANA_ROAD_SURFACE_DEBUG__,
 env:window.__ZERANA_ENVIRONMENT_DEBUG__,stream:window.__ZERANA_STREAM_DEBUG__,
 terrain:window.__ZERANA_TERRAIN_DEBUG__,player:window.__ZERANA_PLAYER_DEBUG__})'''
READY='''() => {const w=window.__ZERANA_WATER_DEBUG__,s=window.__ZERANA_STREAM_DEBUG__,r=window.__ZERANA_ROAD_SURFACE_DEBUG__;
 if(w?.error)throw Error(w.error);if(s?.error)throw Error(s.error);if(r?.error)throw Error(r.error);
 return s?.active&&!s.waitingForWindow&&s.shownKeys.length===9&&s.shownKeys.every(k=>w?.cells.some(c=>c.key===k&&c.ready)&&r?.cells.some(c=>c.key===k));}'''

async def run(base):
    OUTPUT.mkdir(parents=True,exist_ok=True)
    report={'mode':'LIVE_WATER_SURFACES' if LIVE else 'FIXTURE_WATER_SURFACES','success':False,'checks':[]}
    errors=[];http_errors=[];unexpected=[];attempts=[];vectors=[]
    state={'bad':False,'blocked':False};blocked=asyncio.Event();gate=asyncio.Event();gate.set()
    async with async_playwright() as p:
        options={'headless':True,'args':['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']}
        if os.getenv('ZERANA_BROWSER_EXECUTABLE'):options['executable_path']=os.environ['ZERANA_BROWSER_EXECUTABLE']
        browser=await p.chromium.launch(**options)
        context=await browser.new_context(viewport={'width':1440,'height':1000},service_workers='block')
        page=await context.new_page()
        page.on('pageerror',lambda e:errors.append(type(e).__name__))
        # Report HTTP failures, except the raster provider's documented all-water
        # 404 fallback. Its body is verified separately by the raster adapter.
        async def response(res):
            if res.status<400:return
            parts=urlsplit(res.url)
            if LIVE and res.status==404 and 'mapbox.terrain-rgb/' in parts.path:
                try:
                    if (await res.json()).get('message')=='Tile does not exist':return
                except Exception:pass
            http_errors.append({'path':parts.path,'status':res.status})
        page.on('response',response)
        async def intercept(route):
            parts=urlsplit(route.request.url)
            if parts.hostname=='api.mapbox.com':
                vector='mapbox.mapbox-streets-v8' in parts.path
                if vector:vectors.append(parts.path)
                if LIVE:
                    if len(attempts)>=LIMIT:unexpected.append('quota');await route.abort();return
                    fp=os.getenv('ZERANA_EXPECTED_TOKEN_SHA256')
                    if fp and hashlib.sha256(parse_qs(parts.query).get('access_token',[''])[0].encode()).hexdigest()!=fp:
                        unexpected.append('token-fingerprint');await route.abort();return
                    attempts.append(parts.path);await route.continue_();return
                try:
                    if vector and state['blocked']:
                        blocked.set();await asyncio.wait_for(gate.wait(),30)
                    if parts.path.endswith('.json'):
                        body=json.dumps({'scheme':'xyz','maxzoom':16,'modified':123,'vector_layers':[{'id':x} for x in ['road','water','waterway','landuse','landuse_overlay']],
                          'attribution':'© <a href="https://www.mapbox.com/about/maps">Mapbox</a> © <a href="https://www.openstreetmap.org/copyright/">OpenStreetMap</a>'})
                        await route.fulfill(content_type='application/json',body=body,headers={'access-control-allow-origin':'*'})
                    elif vector:await route.fulfill(content_type='application/x-protobuf',body=environmental_mvt(state['bad']),headers={'access-control-allow-origin':'*'})
                    else:await route.fulfill(content_type='image/png',body=png((1,150,136) if 'terrain-rgb/' in parts.path else (80,100,60)),headers={'access-control-allow-origin':'*'})
                except Exception:pass
                return
            if parts.netloc!=urlsplit(base).netloc:unexpected.append(parts.hostname);await route.abort();return
            await route.continue_()
        await context.route('**/*',intercept)
        async def ready():
            await page.wait_for_function(READY,timeout=120000)
            d=await page.evaluate(STATE)
            assert d['water']['residentBytes']<=d['water']['residentLimit']
            assert d['stream']['loadedBytes']<=d['stream']['maxResidentPayloadBytes']
            assert d['water']['heightAuthority']=='estimated-not-hydraulically-qualified'
            assert d['water']['terrainModified'] is False and d['water']['collidersAdded']==0
            return d
        async def switch(mode):
            previous=await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__?.revision||0')
            await page.select_option('#source-mode',mode)
            await page.wait_for_function('''a=>window.__ZERANA_TERRAIN_DEBUG__?.revision>a.revision&&window.__ZERANA_STREAM_DEBUG__?.source===a.source&&window.__ZERANA_STREAM_DEBUG__?.active''',arg={'revision':previous,'source':mode},timeout=120000)
        async def overview(name):
            await page.locator('#diagnostics').evaluate('(e)=>e.open=true');await page.click('#overview');await page.wait_for_timeout(600)
            # Compare rendered canvas pixels, not merely mesh.visible: water
            # hidden under an unchanged DEM must not pass as visible water.
            if name in ['water','seine']:
                canvas=page.locator('#viewport canvas');on=await canvas.screenshot()
                await page.uncheck('#water-visible');await page.wait_for_timeout(300);off=await canvas.screenshot()
                await page.check('#water-visible');await page.wait_for_timeout(300)
                pixels=await page.evaluate('''async images=>{
                  const load=src=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=reject;image.src='data:image/png;base64,'+src;});
                  const [a,b]=await Promise.all(images.map(load));const c=document.createElement('canvas');c.width=a.width;c.height=a.height;const x=c.getContext('2d',{willReadFrequently:true});
                  x.drawImage(a,0,0);const aa=x.getImageData(0,0,c.width,c.height).data;x.drawImage(b,0,0);const bb=x.getImageData(0,0,c.width,c.height).data;
                  let changed=0;for(let i=0;i<aa.length;i+=4)if(Math.max(Math.abs(aa[i]-bb[i]),Math.abs(aa[i+1]-bb[i+1]),Math.abs(aa[i+2]-bb[i+2]))>12)changed++;
                  return {changed,total:c.width*c.height};
                }''', [base64.b64encode(on).decode(),base64.b64encode(off).decode()])
                assert pixels['changed']>=64,(name,pixels)
                report.setdefault('visibleWaterPixels',{})[name]=pixels
            await page.screenshot(path=str(OUTPUT/f'{name}.png'))
        try:
            await page.goto(query(base,source='synthetic',level='19',water='1'),wait_until='domcontentloaded')
            initial=await ready();report['commit']=initial['terrain']['buildSha']
            if os.getenv('ZERANA_EXPECTED_SHA'):assert report['commit']==os.environ['ZERANA_EXPECTED_SHA']
            assert any(c['drawn'] and c['triangleCount']>0 for c in initial['water']['cells'])
            assert not vectors
            report['checks'].append('water-meshes-arrive-automatically-without-analysis-click')
            if LIVE:
                report['probes']=[]
                for name,lon,lat in [('seine',2.351,48.854),('lac_daumesnil',2.4152,48.8289),('canal',2.3650,48.8746),('cote_marseille',5.3715,43.295)]:
                    if report['probes']:await switch('synthetic');await ready()
                    await page.locator('#world-options').evaluate('(e)=>e.open=true');await page.fill('#longitude',str(lon));await page.fill('#latitude',str(lat));await switch('mapbox')
                    d=await ready();assert any(c['drawn'] and c['areaSquareMeters']>1 for c in d['water']['cells']),name
                    probe={'name':name,'state':d};report['probes'].append(probe);await overview(name)
                    if name=='seine':
                        original={c['key']:c['geometryId'] for c in d['water']['cells']}
                        await page.locator('#viewport').click(position={'x':700,'y':550})
                        await walk(page,'ArrowRight',70);probe['forward']=await ready()
                        await walk(page,'ArrowLeft',70);probe['back']=await ready()
                        found={c['key']:c['geometryId'] for c in probe['back']['water']['cells']}
                        assert all(found.get(k)==v for k,v in original.items())
                        assert probe['back']['water']['reused']>0 and probe['back']['player']['state']['grounded']
                        await page.keyboard.press('Escape')
                        for _ in range(3):await page.click('#rebase')
                        await ready();probe['rebased']=await page.evaluate(STATE)
                        assert all({c['key']:c['geometryId'] for c in probe['rebased']['water']['cells']}.get(k)==v for k,v in original.items())
                        report['checks'].append('real-Seine-70m-return-and-three-rebases-reuse-initial-water')
                report['checks'].append('real-water-geometry-visible-in-river-lake-canal-and-coastal-probes')
            else:
                await overview('water')
                original={c['key']:c['geometryId'] for c in initial['water']['cells']}
                await page.locator('#viewport').click(position={'x':700,'y':550})
                await walk(page,'ArrowRight',70);forward=await ready();assert forward['stream']['installed']>initial['stream']['installed']
                await walk(page,'ArrowLeft',70);back=await ready();found={c['key']:c['geometryId'] for c in back['water']['cells']}
                assert all(found[k]==v for k,v in original.items());assert back['water']['reused']>0
                assert back['player']['state']['grounded']
                report['checks'].append('70m-return-reuses-all-initial-water-geometries-with-bounded-memory')
                await page.keyboard.press('Escape');await page.locator('#diagnostics').evaluate('(e)=>e.open=true')
                for _ in range(3):await page.click('#rebase')
                await page.wait_for_timeout(300);d=await ready();assert {c['key']:c['geometryId'] for c in d['water']['cells']}==found
                assert d['terrain']['seams']['maxGapMeters']<.001
                report['checks'].append('three-floating-origin-rebases-preserve-water-meshes')
                await page.uncheck('#water-visible');await page.wait_for_timeout(300);assert not any(c['drawn'] for c in (await page.evaluate(STATE))['water']['cells'])
                await page.check('#water-visible');await ready();assert not vectors
                report['checks'].append('visibility-toggle-reuses-data-and-GPU-resources')
                await page.locator('#world-options').evaluate('(e)=>e.open=true');await switch('mapbox');d=await ready();report['mockedMapbox']=d
                assert any(c['drawn'] and c['triangleCount']>0 for c in d['water']['cells'])
                paths=[p for p in vectors if p.endswith('.pbf')];assert len(paths)==len(set(paths))
                before=len(vectors);await page.uncheck('#water-visible');await page.check('#water-visible');await ready();assert len(vectors)==before
                report['checks'].append('water-reuses-existing-vector-downloads-and-shared-cache')
                state['bad']=True;await switch('synthetic');await ready();await switch('mapbox')
                await page.wait_for_function('''()=>{const r=window.__ZERANA_ROAD_SURFACE_DEBUG__,s=window.__ZERANA_STREAM_DEBUG__,w=window.__ZERANA_WATER_DEBUG__;return w?.error&&s?.active&&s.shownKeys.length===9&&s.shownKeys.every(k=>r?.cells.some(c=>c.key===k));}''',timeout=90000)
                bad=await page.evaluate(STATE);assert not bad['road']['error'];assert not bad['stream']['error'];assert bad['water']['error']=='WATER_CONTEXT_INCOMPLETE'
                report['checks'].append('invalid-water-source-cannot-break-roads-or-terrain')
                state['bad']=False;await switch('synthetic');await ready();state['blocked']=True;gate.clear();blocked.clear()
                await page.select_option('#source-mode','mapbox');await asyncio.wait_for(blocked.wait(),30)
                await switch('synthetic');state['blocked']=False;gate.set();await ready()
                report['checks'].append('cancelled-job-cannot-install-water-into-new-world')
            assert not errors and not unexpected and not http_errors
            report['success']=True
        except Exception as e:
            report['failureType']=type(e).__name__
            raise
        finally:
            try:report['lastState']=await page.evaluate(STATE);await page.screenshot(path=str(OUTPUT/'last.png'))
            except Exception:pass
            report.update(pageErrors=errors,httpErrors=http_errors,unexpected=unexpected,observedAttempts=len(attempts),vectorRequests=len(vectors))
            (OUTPUT/'summary.json').write_text(json.dumps(report,indent=2));await browser.close()
    print(json.dumps({k:report[k] for k in ['mode','success','checks','observedAttempts','vectorRequests']}))

if __name__=='__main__':
    if os.getenv('ZERANA_PREVIEW_URL'):asyncio.run(run(os.environ['ZERANA_PREVIEW_URL']))
    else:
        with tempfile.TemporaryDirectory() as temp:
            shutil.copytree(ROOT.parent/'dist',Path(temp)/'Zerana');server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(QuietHandler,directory=temp))
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try:asyncio.run(run(f'http://127.0.0.1:{server.server_port}/Zerana/v2/'))
            finally:server.shutdown();thread.join()
