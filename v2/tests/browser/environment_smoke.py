"""PR14: shared MVT, automatic diagnostic, recycling, rebase, error isolation.
Fixtures by default. Explicit live mode is bounded and never records a token.
"""
import asyncio
import functools
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
from urllib.parse import urlsplit, parse_qs
from playwright.async_api import async_playwright
from provider_smoke import png, QuietHandler
from roads_smoke import mvt, field, varint
from experience_smoke import query, walk

ROOT = Path(__file__).resolve().parents[2]
LIVE = os.getenv('ZERANA_LIVE_ENVIRONMENT') == '1'
OUTPUT = ROOT / 'browser-results' / ('environment-live' if LIVE else 'environment')
LIMIT = 128

def environmental_mvt(bad=False):
    output = mvt()
    rect = lambda x,y,w,h: [(x,y),(x+w,y),(x+w,y+h),(x,y+h)]
    layers = [('water',3,[rect(1300,900,2100,2800),list(reversed(rect(2250,1800,400,400)))],''),
              ('waterway',2,[[(0,1850),(4096,1850)]],'stream'),
              ('landuse',3,[rect(100,100,3950,3800)],'wood'),
              ('landuse_overlay',3,[rect(900,100,600,3800)],'wetland')]
    for name,kind,paths,cls in layers:
        layer = field(1,2,name.encode())+field(15,0,2)+field(5,0,4096)
        layer += field(3,2,b'class')+field(4,2,field(1,2,cls.encode()))
        geom=[];x=y=0
        for path in paths:
            geom.append(9)
            for i,(xx,yy) in enumerate(path):
                if i==1:geom.append((len(path)-1)*8+2)
                dx,dy=xx-x,yy-y
                geom.extend([2*dx if dx>=0 else -2*dx-1,2*dy if dy>=0 else -2*dy-1]);x,y=xx,yy
            if kind==3:geom.append(15)
        if bad and name=='water':geom=[15]
        feature=field(1,0,0)+field(3,0,kind)+field(2,2,b'\0\0')+field(4,2,b''.join(varint(n) for n in geom))
        output += field(3,2,layer+field(2,2,feature))
    return output

STATE = '''({env:window.__ZERANA_ENVIRONMENT_DEBUG__,road:window.__ZERANA_ROAD_SURFACE_DEBUG__,
 stream:window.__ZERANA_STREAM_DEBUG__,terrain:window.__ZERANA_TERRAIN_DEBUG__,player:window.__ZERANA_PLAYER_DEBUG__})'''
READY = '''() => { const e=window.__ZERANA_ENVIRONMENT_DEBUG__,s=window.__ZERANA_STREAM_DEBUG__,r=window.__ZERANA_ROAD_SURFACE_DEBUG__;
 if(e?.error)throw Error(e.error);if(r?.error)throw Error(r.error);if(s?.error)throw Error(s.error);
 return s?.active && !s.waitingForWindow && s.shownKeys.length===9 &&
 s.shownKeys.every(k=>e?.cells.some(c=>c.key===k&&c.ready&&(!e.enabled||c.geometryId))&&r?.cells.some(c=>c.key===k)); }'''

async def run(base):
    OUTPUT.mkdir(parents=True,exist_ok=True)
    report={'mode':'LIVE_ENVIRONMENT_KERNEL' if LIVE else 'MOCKED_ENVIRONMENT_KERNEL','success':False,'checks':[],'requestLimit':LIMIT if LIVE else 0}
    attempts=[];vectors=[];errors=[];unexpected=[];http_errors=[];state={'bad':False,'blocked':False};gate=asyncio.Event();gate.set();blocked=asyncio.Event()
    async with async_playwright() as p:
        options={'headless':True,'args':['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']}
        if os.getenv('CHROMIUM_PATH'):options['executable_path']=os.environ['CHROMIUM_PATH']
        browser=await p.chromium.launch(**options)
        context=await browser.new_context(viewport={'width':1440,'height':1000},service_workers='block')
        page=await context.new_page();page.on('pageerror',lambda e:errors.append(type(e).__name__))
        page.on('response',lambda r:http_errors.append({'path':urlsplit(r.url).path,'status':r.status}) if r.status>=400 else None)
        async def intercept(route):
            parts=urlsplit(route.request.url)
            if parts.hostname=='api.mapbox.com':
                vector='mapbox.mapbox-streets-v8' in parts.path
                if vector:vectors.append(parts.path)
                if LIVE:
                    if len(attempts)>=LIMIT:unexpected.append('request-limit');await route.abort();return
                    fp=os.getenv('ZERANA_EXPECTED_TOKEN_SHA256')
                    if fp and hashlib.sha256(parse_qs(parts.query).get('access_token',[''])[0].encode()).hexdigest()!=fp:
                        unexpected.append('token-fingerprint');await route.abort();return
                    attempts.append(parts.path);await route.continue_();return
                try:
                    if vector and state['blocked']:
                        blocked.set()
                        await asyncio.wait_for(gate.wait(),30)
                    if parts.path.endswith('.json'):
                        body=json.dumps({'scheme':'xyz','maxzoom':16,'modified':123,'vector_layers':[{'id':x} for x in ['road','water','waterway','landuse','landuse_overlay']],
                          'attribution':'© <a href="https://www.mapbox.com/about/maps">Mapbox</a> © <a href="https://www.openstreetmap.org/copyright/">OpenStreetMap</a>'})
                        await route.fulfill(content_type='application/json',body=body,headers={'access-control-allow-origin':'*'})
                    elif vector:await route.fulfill(content_type='application/x-protobuf',body=environmental_mvt(state['bad']),headers={'access-control-allow-origin':'*'})
                    else:await route.fulfill(content_type='image/png',body=png((1,150,136) if 'terrain-rgb/' in parts.path else (50,100,80)),headers={'access-control-allow-origin':'*'})
                except Exception:pass
                return
            if parts.netloc!=urlsplit(base).netloc:unexpected.append(parts.hostname);await route.abort();return
            await route.continue_()
        await context.route('**/*',intercept)
        async def ready():
            await page.wait_for_function(READY,timeout=120000)
            d=await page.evaluate(STATE)
            assert d['env']['residentBytes']<=d['env']['residentLimit']
            assert d['stream']['loadedBytes']<=d['stream']['maxResidentPayloadBytes']
            assert d['env']['terrainModified'] is False and d['env']['hydroAuthority']=='unresolved'
            return d
        async def select_source(mode):
            # build() yields to requestAnimationFrame before replacing the world.
            # A previous world's ready/error report is not the new world's state.
            previous=await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__?.revision||0')
            await page.select_option('#source-mode',mode)
            await page.wait_for_function('''a => window.__ZERANA_TERRAIN_DEBUG__?.revision>a.revision &&
              window.__ZERANA_STREAM_DEBUG__?.source===a.source && window.__ZERANA_STREAM_DEBUG__?.active''',
              arg={'revision':previous,'source':mode},timeout=120000)
        async def mapbox(lon,lat):
            await page.locator('#world-options').evaluate('(e)=>e.open=true')
            await page.fill('#longitude',str(lon));await page.fill('#latitude',str(lat))
            await select_source('mapbox')
            return await ready()
        try:
            await page.goto(query(base,source='synthetic',level='19',environment='1'),wait_until='domcontentloaded')
            initial=await ready();report['commit']=initial['terrain']['buildSha']
            if os.getenv('ZERANA_EXPECTED_SHA'):assert report['commit']==os.environ['ZERANA_EXPECTED_SHA']
            assert any(c['segmentCount']>0 for c in initial['env']['cells']) and not vectors
            report['checks'].append('synthetic-environment-arrives-with-streamed-roads-without-analysis-click')
            if LIVE:
                report['probes']=[]
                # Actual water edge and park semantics; no claim of physical water.
                for name,lon,lat in [('seine',2.351,48.854),('tuileries',2.333,48.863)]:
                    if report['probes']:
                        await select_source('synthetic');await ready()
                    d=await mapbox(lon,lat)
                    assert d['env']['decodedSnapshots']>0 and d['road']['httpCharged']>0
                    assert any(c['fragmentCount']>0 for c in d['env']['cells'])
                    report['probes'].append({'name':name,'state':d})
                    await page.locator('#diagnostics').evaluate('(e)=>e.open=true');await page.click('#overview')
                    await page.wait_for_timeout(250);await page.screenshot(path=str(OUTPUT/f'{name}.png'))
                counts=[c['classCounts'] for probe in report['probes'] for c in probe['state']['env']['cells'] if c['visible']]
                assert any(any(k.startswith('water:') for k in d) for d in counts)
                assert any(any(k.startswith('landuse:') for k in d) for d in counts)
                report['checks'].append('real-water-and-landuse-from-shared-MVT-under-fixed-request-budget')
            else:
                original={c['key']:c['geometryId'] for c in initial['env']['cells']}
                await page.locator('#viewport').click(position={'x':700,'y':550})
                await walk(page,'ArrowRight',70);forward=await ready();assert forward['stream']['installed']>initial['stream']['installed']
                await walk(page,'ArrowLeft',70);back=await ready();found={c['key']:c['geometryId'] for c in back['env']['cells']}
                assert all(found[k]==v for k,v in original.items()) and back['env']['reused']>0
                assert back['player']['state']['grounded'];report['checks'].append('native-walk-return-reuses-environment-geometries-with-bounded-residency')
                await page.keyboard.press('Escape');await page.locator('#diagnostics').evaluate('(e)=>e.open=true')
                for _ in range(3):await page.click('#rebase')
                await page.wait_for_timeout(400);rebased=await ready()
                assert {c['key']:c['geometryId'] for c in rebased['env']['cells']}==found
                assert rebased['terrain']['seams']['maxGapMeters']<.001
                report['checks'].append('three-rebases-preserve-environment-geometries-and-terrain-seams')
                await page.uncheck('#environment-visible');await page.wait_for_timeout(300)
                assert not any(c['drawn'] for c in (await page.evaluate(STATE))['env']['cells'])
                await page.check('#environment-visible');await ready();assert not vectors
                d=await mapbox(2.35,48.86);report['mockedMapbox']=d
                paths=[x for x in vectors if x.endswith('.pbf')]
                assert len(paths)==len(set(paths))==d['env']['decodedSnapshots']
                before=len(vectors);await page.uncheck('#environment-visible');await page.check('#environment-visible');await ready()
                assert len(vectors)==before
                report['checks'].append('roads-water-landuse-share-one-decode-and-one-request-per-cached-tile')
                await page.click('#overview');await page.wait_for_timeout(200);await page.screenshot(path=str(OUTPUT/'environment.png'))
                state['bad']=True
                await select_source('synthetic');await ready();await select_source('mapbox')
                await page.wait_for_function('''() => {const r=window.__ZERANA_ROAD_SURFACE_DEBUG__,s=window.__ZERANA_STREAM_DEBUG__;return s?.active&&s.shownKeys.length===9&&s.shownKeys.every(k=>r?.cells.some(c=>c.key===k));}''',timeout=90000)
                bad=await page.evaluate(STATE);assert bad['env']['error']=='ENV_MVT_CLOSE';assert not bad['road']['error'];assert bad['stream']['active']
                report['checks'].append('invalid-water-geometry-cannot-disable-valid-roads-or-physical-ground')
                state['bad']=False
                await select_source('synthetic');await ready()
                state['blocked']=True;gate.clear();blocked.clear()
                await page.select_option('#source-mode','mapbox')
                # Prove a vector request is actually in flight, not a timed guess.
                await asyncio.wait_for(blocked.wait(),30)
                await select_source('synthetic');gate.set();state['blocked']=False
                final=await ready();assert final['env']['cells'] and not final['env']['error'];assert final['stream']['active']
                report['checks'].append('cancelled-provider-work-cannot-attach-to-the-replacement-world')
            assert not errors and not unexpected and not http_errors
            report['success']=True
        except Exception as e:
            # Do not persist exception messages that may contain provider URLs.
            report['failureType']=type(e).__name__
            raise
        finally:
            try:report['lastState']=await page.evaluate(STATE)
            except Exception:pass
            report.update(pageErrors=errors,httpErrors=http_errors,unexpected=unexpected,observedAttempts=len(attempts),vectorRequests=len(vectors))
            (OUTPUT/'summary.json').write_text(json.dumps(report,indent=2));await browser.close()
    print(json.dumps({k:report[k] for k in ['mode','success','checks','observedAttempts','vectorRequests']}))

if __name__=='__main__':
    if os.getenv('ZERANA_PREVIEW_URL'):asyncio.run(run(os.environ['ZERANA_PREVIEW_URL']))
    else:
        with tempfile.TemporaryDirectory() as temp:
            shutil.copytree(ROOT.parent/'dist',Path(temp)/'Zerana')
            handler=functools.partial(QuietHandler,directory=temp)
            server=http.server.ThreadingHTTPServer(('127.0.0.1',0),handler)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try:asyncio.run(run(f'http://127.0.0.1:{server.server_port}/Zerana/v2/'))
            finally:server.shutdown();thread.join()
