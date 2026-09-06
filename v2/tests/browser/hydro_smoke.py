"""PR15b coherent hydro ground; fixture default, explicitly bounded live review.
Never writes credentials, raw MVT/DEM, decoded elevation arrays or built site.
Live review serves the branch locally, NOT the currently published main site.
"""
import asyncio, base64, functools, hashlib, http.server, json, os, shutil, tempfile, threading
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from playwright.async_api import async_playwright
from provider_smoke import png, QuietHandler
from environment_smoke import environmental_mvt
from experience_smoke import query
ROOT = Path(__file__).resolve().parents[2]
LIVE = os.getenv('ZERANA_LIVE_HYDRO') == '1'
OUTPUT = ROOT/'browser-results'/('hydro-live' if LIVE else 'hydro')
LIMIT = 256
STATE = '''({hydro:window.__ZERANA_HYDRO_DEBUG__,water:window.__ZERANA_WATER_DEBUG__,road:window.__ZERANA_ROAD_SURFACE_DEBUG__,stream:window.__ZERANA_STREAM_DEBUG__,terrain:window.__ZERANA_TERRAIN_DEBUG__,player:window.__ZERANA_PLAYER_DEBUG__,status:document.querySelector('#status')?.textContent})'''
READY = '''() => {
 const h=window.__ZERANA_HYDRO_DEBUG__,s=window.__ZERANA_STREAM_DEBUG__,w=window.__ZERANA_WATER_DEBUG__;
 const e=document.querySelector('#status.error');if(e)throw Error(e.textContent);
 if(h?.error||s?.error||w?.error)throw Error(h?.error||s?.error||w?.error);
 if(s?.scheduler?.errors?.length)throw Error(s.scheduler.errors[0].message||s.scheduler.errors[0].error||'HYDRO_STREAM_FAILED');
 return h?.active&&s?.active&&!s.waitingForWindow&&s.shownKeys.length===9&&s.shownKeys.every(k=>h.cells.some(c=>c.key===k&&c.colliderPrepared)&&w?.cells.some(c=>c.key===k&&c.ready));}'''

async def walk(page, key, distance, timeout=60000):
    # Falling is NOT traversal. Measure the component tangent to the initial
    # ellipsoidal up direction and fail promptly on any rejected stream cell.
    start=await page.evaluate('window.__ZERANA_PLAYER_DEBUG__.state.ecefPosition')
    await page.keyboard.down('ShiftLeft');await page.keyboard.down(key)
    try:
        await page.wait_for_function("""args=>{
          const p=window.__ZERANA_PLAYER_DEBUG__,s=window.__ZERANA_STREAM_DEBUG__;
          if(p.runtimeError)throw Error(p.runtimeError);
          if(s?.scheduler?.errors?.length)throw Error('HYDRO_STREAM_FAILED');
          const a=args.start,b=p.state.ecefPosition;
          const d=[b.xMeters-a.xMeters,b.yMeters-a.yMeters,b.zMeters-a.zMeters];
          // 70m local excursion: radial up suffices for a traversal regression,
          // not a replacement for the canonical geospatial transformations.
          const n=Math.hypot(a.xMeters,a.yMeters,a.zMeters),u=[a.xMeters/n,a.yMeters/n,a.zMeters/n];
          const vertical=d.reduce((v,x,i)=>v+x*u[i],0);
          if(Math.abs(vertical)>20)throw Error('PLAYER_LEFT_LOCAL_GROUND');
          return Math.sqrt(Math.max(0,d.reduce((v,x)=>v+x*x,0)-vertical*vertical))>=args.distance;
        }""",arg={'start':start,'distance':distance},timeout=timeout)
    finally:
        await page.keyboard.up(key);await page.keyboard.up('ShiftLeft')

async def run(base):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    report={'levelPolicy':'bank-constrained-lower-envelope-preview','mode':'LIVE_HYDRO_RECONCILIATION' if LIVE else 'FIXTURE_HYDRO_RECONCILIATION','success':False,'checks':[], 'requestLimit':LIMIT,'probes':[]}
    requests=[];vectors=[];errors=[];unexpected=[];http_errors=[]
    flags={'blocked':False};blocked=asyncio.Event();gate=asyncio.Event();gate.set()
    async with async_playwright() as p:
        options={'headless':True,'args':['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']}
        if os.getenv('ZERANA_BROWSER_EXECUTABLE'):options['executable_path']=os.environ['ZERANA_BROWSER_EXECUTABLE']
        browser=await p.chromium.launch(**options)
        context=await browser.new_context(viewport={'width':1440,'height':1000}, service_workers='block')
        page=await context.new_page();page.on('pageerror', lambda e:errors.append(type(e).__name__))
        async def response(res):
            if res.status<400:return
            path=urlsplit(res.url).path
            if LIVE and res.status==404 and 'mapbox.terrain-rgb/' in path:
                try:
                    if (await res.json()).get('message')=='Tile does not exist':return
                except Exception:pass
            http_errors.append({'path':path,'status':res.status})
        page.on('response',response)
        async def intercept(route):
            parts=urlsplit(route.request.url)
            if parts.hostname=='api.mapbox.com':
                if len(requests)>=LIMIT:unexpected.append('quota');await route.abort();return
                requests.append(parts.path)
                vector='mapbox.mapbox-streets-v8' in parts.path
                if vector:vectors.append(parts.path)
                if LIVE:
                    expected=os.getenv('ZERANA_EXPECTED_TOKEN_SHA256')
                    if expected and hashlib.sha256(parse_qs(parts.query).get('access_token',[''])[0].encode()).hexdigest()!=expected:
                        unexpected.append('credential-fingerprint');await route.abort();return
                    await route.continue_();return
                try:
                    if vector and flags['blocked']:
                        blocked.set();await asyncio.wait_for(gate.wait(),30)
                    if parts.path.endswith('.json'):
                        data={'scheme':'xyz','maxzoom':16,'modified':123,'vector_layers':[{'id':k} for k in ['road','water','waterway','landuse','landuse_overlay']],
                              'attribution':'© <a href="https://www.mapbox.com/about/maps">Mapbox</a> © <a href="https://www.openstreetmap.org/copyright/">OpenStreetMap</a>'}
                        await route.fulfill(content_type='application/json',body=json.dumps(data),headers={'access-control-allow-origin':'*'})
                    elif vector:await route.fulfill(content_type='application/x-protobuf',body=environmental_mvt(),headers={'access-control-allow-origin':'*'})
                    else:await route.fulfill(content_type='image/png',body=png((1,150,136) if 'terrain-rgb/' in parts.path else (80,100,60)),headers={'access-control-allow-origin':'*'})
                except Exception:pass # Cancellation closes the requesting worker.
                return
            if parts.netloc!=urlsplit(base).netloc:unexpected.append(parts.hostname);await route.abort();return
            await route.continue_()
        await context.route('**/*',intercept)
        async def ready():
            await page.wait_for_function(READY,timeout=120000)
            d=await page.evaluate(STATE);h=d['hydro'];s=d['stream']
            assert h['sameTerrainAndCollider'] and not h['waterCollider'] and h['renderLiftMeters']==0
            assert h['maxTerrainAboveWaterMeters'] is None or h['maxTerrainAboveWaterMeters']<=h['toleranceMeters']
            for c in h['cells']:
                assert c['levelAuthority']=='bank-constrained-lower-envelope-preview'
                if c['waterTriangles']:
                    assert c['maxWaterAboveRawTerrainMeters'] is not None
                    assert c['certificate']['maxWaterAboveTerrainMeters'] is not None
                assert c['certificate']['passed'] and c['terrainSourceId']==c['waterTerrainSourceId']
            assert s['mainThreadBvhBuildCount']==0
            assert s['loadedBytes']<=s['maxResidentPayloadBytes']
            assert d['water']['residentBytes']<=d['water']['residentLimit']
            assert d['terrain']['seams']['maxGapMeters']<.001
            return d
        async def changed_pixels(on, off):
            return await page.evaluate('''async images=>{const load=src=>new Promise((ok,no)=>{let i=new Image();i.onload=()=>ok(i);i.onerror=no;i.src='data:image/png;base64,'+src;});
              const [a,b]=await Promise.all(images.map(load)),c=document.createElement('canvas');c.width=a.width;c.height=a.height;
              const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(a,0,0);const aa=x.getImageData(0,0,c.width,c.height).data;
              x.drawImage(b,0,0);const bb=x.getImageData(0,0,c.width,c.height).data;let changed=0;
              for(let i=0;i<aa.length;i+=4)if(Math.max(Math.abs(aa[i]-bb[i]),Math.abs(aa[i+1]-bb[i+1]),Math.abs(aa[i+2]-bb[i+2]))>12)changed++;
              return {changed,total:c.width*c.height};}''',[base64.b64encode(on).decode(),base64.b64encode(off).decode()])
        async def human_view(name, strict_bank=False):
            # Stay in the player's real camera, not the overview/orbit camera.
            if not (await page.evaluate(STATE))['player']['active']:
                await page.locator('#viewport').click(position={'x':700,'y':550})
            await page.wait_for_timeout(300)
            before_heading=(await page.evaluate(STATE))['player']['state']['headingRad']
            if strict_bank:
                # Turn using the same pointer input as the player. Fixed Seine
                # probe faces east toward the river, not north away from it.
                await page.locator('#diagnostics').evaluate('(e)=>e.open=true')
                bb=await page.locator('#viewport canvas').bounding_box()
                mx=bb['x']+200;my=bb['y']+bb['height']*.55;dx=500
                await page.mouse.move(mx,my);await page.mouse.down()
                await page.mouse.move(mx+dx,my,steps=12);await page.mouse.up()
                await page.wait_for_timeout(300)
            q=await page.evaluate('window.__ZERANA_HYDRO_VIEW_PROBE__()')
            assert q and q['active']
            # A camera under real water differs from water floating above a bank.
            if strict_bank:
                assert not q['foot']['overWater'], 'Seine bank probe must be on dry terrain'
                assert q['eye']['nearbyVertices']>0
                assert q['eye']['nearbyMaxWaterAbovePointMeters']<0, q
            if strict_bank:
                canvas=page.locator('#viewport canvas');on=await canvas.screenshot()
                await page.uncheck('#water-visible');await page.wait_for_timeout(250);off=await canvas.screenshot()
                await page.check('#water-visible');await page.wait_for_timeout(250)
                q['visiblePixels']=await changed_pixels(on,off)
                assert q['visiblePixels']['changed']>=64, 'Water must be visible from the actual player camera'
            await page.screenshot(path=str(OUTPUT/f'{name}-human.png'))
            if strict_bank:
                # Restore heading: the existing 70m east/west route is unchanged.
                await page.mouse.move(mx+dx,my);await page.mouse.down()
                await page.mouse.move(mx,my,steps=12);await page.mouse.up()
                await page.wait_for_timeout(150)
                after_heading=(await page.evaluate(STATE))['player']['state']['headingRad']
                assert abs(after_heading-before_heading)<1e-6
            return q
        async def overview(name):
            await page.locator('#diagnostics').evaluate('(e)=>e.open=true');await page.click('#overview');await page.wait_for_timeout(500)
            canvas=page.locator('#viewport canvas');on=await canvas.screenshot()
            await page.uncheck('#water-visible');await page.wait_for_timeout(250);off=await canvas.screenshot()
            await page.check('#water-visible');await page.wait_for_timeout(250)
            pixels=await changed_pixels(on,off)
            assert pixels['changed']>=64,(name,pixels)
            await page.screenshot(path=str(OUTPUT/f'{name}.png'))
            return pixels
        try:
            # Same Seine regression point as PR15. Additional fixed probes are
            # reported even if dry; dry probes NEVER count as successful water.
            probes=[('seine',2.351,48.854)] if LIVE else [('fixture',2.351,48.854)]
            if LIVE:probes += [('lac_daumesnil',2.4152,48.8289),('canal',2.3650,48.8746),('cote_marseille',5.3715,43.295)]
            for name,lon,lat in probes:
                await page.goto(query(base,source='mapbox',level='19',hydro='1',water='1',lon=str(lon),lat=str(lat)),wait_until='domcontentloaded')
                # Explicit UI fields: preserve the requested fixed coordinates,
                # regardless of which URL aliases the laboratory supports.
                await page.locator('#world-options').evaluate('(e)=>e.open=true')
                if float(await page.input_value('#longitude'))!=lon or float(await page.input_value('#latitude'))!=lat:
                    await page.fill('#longitude',str(lon));await page.fill('#latitude',str(lat));await page.click('#build')
                d=await ready();report['commit']=d['terrain']['buildSha']
                if os.getenv('ZERANA_EXPECTED_SHA'):assert report['commit']==os.environ['ZERANA_EXPECTED_SHA']
                wet=any(c['waterTriangles']>0 for c in d['hydro']['cells'])
                probe={'name':name,'longitude':lon,'latitude':lat,'waterPresent':wet,'state':d};report['probes'].append(probe)
                if not wet:
                    probe['qualification']='NO_WATER_IN_REQUESTED_WINDOW';continue
                assert d['hydro']['modifiedSamples']>0
                if name in ['seine','fixture']:
                    assert d['hydro']['maxWaterAboveRawTerrainMeters']<=d['hydro']['toleranceMeters']
                    assert d['hydro']['maxWaterAboveConditionedTerrainMeters']<1, 'Floating water/deep gap regression'
                    probe['humanView']=await human_view(name,strict_bank=name=='seine')
                probe['visiblePixels']=await overview(name)
                report['checks'].append(name+'-conditioned-ground-water-collider-and-triangle-proof')
                if name in ['seine','fixture']:
                    original={c['key']:c['waterGeometryId'] for c in d['hydro']['cells']}
                    await page.locator('#viewport').click(position={'x':700,'y':550})
                    await walk(page,'ArrowRight',70,timeout=90000);probe['forward']=await ready()
                    await walk(page,'ArrowLeft',70,timeout=90000);probe['back']=await ready()
                    returned={c['key']:c['waterGeometryId'] for c in probe['back']['hydro']['cells']}
                    assert all(returned.get(k)==v for k,v in original.items())
                    probe['humanReturnView']=await human_view(name+'-return',strict_bank=name=='seine')
                    assert probe['back']['hydro']['maxWaterAboveRawTerrainMeters']<=probe['back']['hydro']['toleranceMeters']
                    assert probe['back']['hydro']['maxWaterAboveConditionedTerrainMeters']<1
                    assert probe['back']['player']['state']['grounded'] and probe['back']['stream']['reused']>0
                    await page.keyboard.press('Escape');await page.locator('#diagnostics').evaluate('(e)=>e.open=true')
                    for _ in range(3):await page.click('#rebase')
                    probe['rebased']=await ready()
                    assert all({c['key']:c['waterGeometryId'] for c in probe['rebased']['hydro']['cells']}.get(k)==v for k,v in original.items())
                    before=len(requests);await page.uncheck('#water-visible');await page.check('#water-visible');await ready();assert len(requests)==before
                    report['checks'].append(name+'-70m-return-three-rebases-and-hot-cohort-recycling')
                    report['checks'].append(name+'-two-sided-elevation-bounds-and-human-camera')
            assert report['probes'][0]['waterPresent'], 'Seine regression must contain visible water'
            if not LIVE:
                paths=[s for s in vectors if s.endswith('.pbf')];assert len(paths)==len(set(paths))
                report['checks'].append('one-vector-snapshot-shared-by-ground-roads-water-and-environment')
                # Cancel an actual pending new-world request. It must not be
                # adopted into the synthetic world that follows.
                await page.select_option('#source-mode','synthetic')
                await page.wait_for_function("window.__ZERANA_STREAM_DEBUG__?.source==='synthetic'&&window.__ZERANA_STREAM_DEBUG__?.active",timeout=90000)
                flags['blocked']=True;gate.clear();blocked.clear();await page.select_option('#source-mode','mapbox')
                await asyncio.wait_for(blocked.wait(),30);await page.select_option('#source-mode','synthetic');flags['blocked']=False;gate.set()
                await page.wait_for_function("window.__ZERANA_STREAM_DEBUG__?.source==='synthetic'&&window.__ZERANA_STREAM_DEBUG__?.active",timeout=90000)
                await page.wait_for_timeout(1000)
                assert not (await page.evaluate(STATE))['hydro']['active']
                report['checks'].append('aborted-hydro-job-never-enters-a-new-world')
            assert not errors and not unexpected and not http_errors
            report['success']=True
        except Exception as e:
            report['failureType']=type(e).__name__
            # Whitelist engine diagnostics only. A traceback/URL could carry a token.
            try:text=await page.locator('#status').inner_text(timeout=1000)
            except Exception:text='STATUS_UNAVAILABLE'
            report['status']=text if 'access_token' not in text and 'pk.' not in text else 'REDACTED'
            raise
        finally:
            try:report['lastState']=await page.evaluate(STATE);await page.screenshot(path=str(OUTPUT/'last.png'))
            except Exception:pass
            report.update(pageErrors=errors,httpErrors=http_errors,unexpected=unexpected,observedAttempts=len(requests),vectorRequests=len(vectors))
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
