"""Real engineering pipeline with deterministic binary MVT/DEM HTTP fixtures.
Not a real Mapbox verification. No access token or URL query is retained.
"""
import asyncio
import functools
import http.server
import json
import math
import os
from pathlib import Path
import re
import shutil
import struct
import tempfile
import threading
import zlib
from urllib.parse import urlsplit
from playwright.async_api import async_playwright
from provider_smoke import png, QuietHandler
from roads_smoke import mvt
from experience_smoke import walk, query

ROOT=Path(__file__).resolve().parents[2]
OUTPUT=ROOT/'browser-results'/'real-engineering'

def elevation_png(x,y):
    """Pixel-centred GLOBAL raster; neighbouring tiles never restart the waves."""
    rows=bytearray()
    for j in range(256):
        rows.append(0)
        for i in range(256):
            h=30+.35*math.sin((x*256+i+.5)*.31)+.2*math.sin((y*256+j+.5)*.17)
            v=round((10000+h)*10)
            rows.extend((v>>16,(v>>8)&255,v&255,255))
    def chunk(k,b):return struct.pack('>I',len(b))+k+b+struct.pack('>I',zlib.crc32(k+b)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',256,256,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(rows))+chunk(b'IEND',b'')

async def run(base):
    OUTPUT.mkdir(parents=True,exist_ok=True)
    report={'mode':'MOCKED_REAL_ENGINEERING_PIPELINE','success':False,'checks':[]}
    errors=[];unexpected=[];requests=[];network_errors=[];dem_cache={}
    state={'blocked':False,'refuse':False};gate=asyncio.Event();gate.set()
    async with async_playwright() as p:
        opts={'headless':True,'args':['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']}
        if os.getenv('CHROMIUM_PATH'):opts['executable_path']=os.environ['CHROMIUM_PATH']
        browser=await p.chromium.launch(**opts)
        context=await browser.new_context(viewport={'width':1440,'height':1000},service_workers='block')
        page=await context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
        async def intercept(route):
            parts=urlsplit(route.request.url)
            if parts.hostname=='api.mapbox.com':
                requests.append(parts.path)
                async def respond(**kwargs):
                    await route.fulfill(headers={'access-control-allow-origin':'*'},**kwargs)
                try:
                    is_road='mapbox.mapbox-streets-v8' in parts.path
                    if state['blocked'] and is_road:await asyncio.wait_for(gate.wait(),25)
                    if state['refuse'] and is_road:
                        await respond(status=401,body='{}',content_type='application/json');return
                    if parts.path.endswith('.json'):
                        await respond(content_type='application/json',body=json.dumps({'scheme':'xyz','maxzoom':16,'modified':123,
                            'vector_layers':[{'id':'road'}],'attribution':'© <a href="https://www.mapbox.com/about/maps">Mapbox</a> © <a href="https://www.openstreetmap.org/copyright/">OpenStreetMap</a>'}))
                    elif is_road:await respond(content_type='application/x-protobuf',body=mvt())
                    elif 'terrain-rgb/' in parts.path:
                        match=re.search(r'/15/(\d+)/(\d+)\.pngraw$',parts.path);assert match,parts.path
                        xy=tuple(map(int,match.groups()))
                        if xy not in dem_cache:dem_cache[xy]=elevation_png(*xy)
                        await respond(content_type='image/png',body=dem_cache[xy])
                    else:await respond(content_type='image/png',body=png((80,125,85)))
                except Exception as e:
                    if not isinstance(e,asyncio.TimeoutError):network_errors.append(type(e).__name__)
                return
            if parts.netloc!=urlsplit(base).netloc:unexpected.append(parts.hostname);await route.abort();return
            await route.continue_()
        await context.route('**/*',intercept)
        async def ready():
            await page.wait_for_function('''() => {
              const e=window.__ZERANA_REAL_ENGINEERING_DEBUG__,s=window.__ZERANA_STREAM_DEBUG__,r=window.__ZERANA_ROAD_SURFACE_DEBUG__;
              if(!document.querySelector('#build').disabled&&document.querySelector('#status').classList.contains('error'))throw Error(document.querySelector('#status').textContent);
              if(s?.error)throw Error(s.error);if(s?.scheduler?.errors.length)throw Error(s.scheduler.errors.join(','));
              return e?.active && s?.active && !s.waitingForWindow && s.shownKeys.length===9 &&
                s.shownKeys.every(k=>e.cells.some(c=>c.key===k)&&r?.cells.some(c=>c.key===k&&c.bundled));
            }''',timeout=120000)
            return await page.evaluate('({engineering:window.__ZERANA_REAL_ENGINEERING_DEBUG__,stream:window.__ZERANA_STREAM_DEBUG__,roads:window.__ZERANA_ROAD_SURFACE_DEBUG__})')
        try:
            await page.goto(query(base,source='mapbox',engineering='1',level='19'),wait_until='domcontentloaded')
            initial=await ready();report['initial']=initial
            expected=os.getenv('ZERANA_EXPECTED_SHA')
            report['commit']=await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.buildSha')
            if expected:assert report['commit']==expected
            assert initial['engineering']['modifiedSamples']>0 and initial['engineering']['maxDeltaMeters']>1e-4
            assert initial['engineering']['mainThreadBvhBuildCount']==0
            assert initial['engineering']['preparedBvhAdoptions']>=9
            assert all(c['terrainSourceId'].startswith('mapbox.terrain-rgb/real-ground-engineering-v1/') for c in initial['roads']['cells'])
            assert initial['roads']['collidersAdded']==0 and initial['roads']['httpCharged']==0
            report['checks'].append('real-adapter-worker-compiles-nonzero-earthwork-terrain-road-and-prepared-collider-together')
            def geometries(d):return {c['key']:c['geometryId'] for c in d['roads']['cells']}
            originals=geometries(initial)
            await walk(page,'ArrowRight',70,timeout=120000);forward=await ready()
            assert forward['stream']['installed']>initial['stream']['installed']
            assert await page.evaluate('window.__ZERANA_PLAYER_DEBUG__.state.grounded')
            await walk(page,'ArrowLeft',70,timeout=120000);back=await ready();report['back']=back
            now=geometries(back);assert all(now[k]==v for k,v in originals.items() if k in now)
            assert back['roads']['reused']>0 and back['roads']['residentBytes']<=back['roads']['residentLimit']
            assert back['stream']['loadedBytes']<=back['stream']['maxResidentPayloadBytes']
            report['checks'].append('native-walk-and-return-preserve-physical-support-and-recycled-road-identities')
            await page.keyboard.press('Escape');await page.locator('#diagnostics').evaluate('(e)=>e.open=true')
            before=geometries(back)
            for _ in range(3):await page.click('#rebase')
            await page.wait_for_timeout(350)
            after=await ready();assert geometries(after)==before
            terrain=await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__')
            assert terrain['seams']['maxGapMeters']<.001 and terrain['seams']['maxNormalDelta']<.001
            report['checks'].append('three-origin-changes-preserve-cohort-geometries-and-millimetre-seams')
            await page.click('#overview');await page.screenshot(path=str(OUTPUT/'real-engineering-fixture.png'))
            await page.locator('#world-options').evaluate('(e)=>e.open=true')
            await page.select_option('#source-mode','synthetic')
            await page.wait_for_function("window.__ZERANA_STREAM_DEBUG__?.source==='synthetic' && window.__ZERANA_PLAYER_DEBUG__?.active",timeout=60000)
            revision=await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.revision')
            state['blocked']=True;gate.clear()
            await page.select_option('#source-mode','mapbox');await page.wait_for_timeout(350)
            assert await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.revision')==revision
            assert not await page.evaluate('window.__ZERANA_PLAYER_DEBUG__.active')
            assert not await page.evaluate('window.__ZERANA_REAL_ENGINEERING_DEBUG__.active')
            await page.click('#cancel-load');state['blocked']=False;gate.set()
            await page.wait_for_function("!document.querySelector('#build').disabled",timeout=10000)
            assert await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.revision')==revision
            report['checks'].append('delayed-vector-context-and-cancellation-preserve-the-previous-world')
            state['refuse']=True;await page.click('#build')
            await page.wait_for_function("!document.querySelector('#build').disabled && document.querySelector('#status').classList.contains('error')",timeout=30000)
            assert 'ROAD_PROVIDER_AUTH' in await page.text_content('#status')
            assert await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.revision')==revision
            report['checks'].append('provider-denial-cannot-publish-partial-ground-or-credentials')
            state['refuse']=False
            await page.select_option('#source-mode','synthetic')
            await page.wait_for_function("window.__ZERANA_STREAM_DEBUG__?.source==='synthetic' && window.__ZERANA_PLAYER_DEBUG__?.active",timeout=60000)
            assert not await page.evaluate('window.__ZERANA_REAL_ENGINEERING_DEBUG__.active')
            assert not await page.evaluate('window.__ZERANA_ROAD_SURFACE_DEBUG__.cells.some(c=>c.bundled)')
            report['checks'].append('world-replacement-disposes-engineered-cohorts-and-restores-normal-streaming')
            assert not errors and not unexpected,(errors,unexpected)
            report['success']=True
        finally:
            report.update(pageErrors=errors,unexpected=unexpected,observedAttempts=len(requests))
            try:
                report['lastStatus']=await page.text_content('#status')
                report['lastStream']=await page.evaluate('window.__ZERANA_STREAM_DEBUG__')
                report['lastEngineering']=await page.evaluate('window.__ZERANA_REAL_ENGINEERING_DEBUG__')
            except Exception:pass
            (OUTPUT/'summary.json').write_text(json.dumps(report,indent=2));await browser.close()
    print(json.dumps({k:report[k] for k in ['mode','success','checks','observedAttempts']}))

if __name__=='__main__':
    if os.getenv('ZERANA_PREVIEW_URL'):asyncio.run(run(os.environ['ZERANA_PREVIEW_URL']))
    else:
        with tempfile.TemporaryDirectory() as temp:
            target=Path(temp)/'Zerana'/'v2';target.parent.mkdir(parents=True)
            shutil.copytree(ROOT/'demo-dist',target)
            server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(QuietHandler,directory=temp))
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try:asyncio.run(run(f'http://127.0.0.1:{server.server_port}/Zerana/v2/'))
            finally:server.shutdown();server.server_close()
