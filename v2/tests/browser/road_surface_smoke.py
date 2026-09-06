"""Automatic road surfaces: native movement, worker and WebGL; all HTTP mocked.
No analysis button is needed. The same script can inspect the published prefix.
"""
import asyncio
import functools
import http.server
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
from urllib.parse import urlsplit
from playwright.async_api import async_playwright
from provider_smoke import png, QuietHandler
from roads_smoke import mvt
from experience_smoke import walk, query

ROOT=Path(__file__).resolve().parents[2]
OUTPUT=ROOT/'browser-results'/'road-surface'

async def run(base):
    OUTPUT.mkdir(parents=True,exist_ok=True)
    report={'mode':'PUBLISHED_ROAD_SURFACE_MOCKED' if os.getenv('ZERANA_PREVIEW_URL') else 'BUILT_ROAD_SURFACE_MOCKED','checks':[],'success':False}
    errors=[];unexpected=[];http_errors=[];roads=[];worker_paths=[]
    state={'blocked':False,'auth':False};gate=asyncio.Event();gate.set()
    async with async_playwright() as p:
        opts={'headless':True,'args':['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']}
        if os.getenv('CHROMIUM_PATH'):opts['executable_path']=os.environ['CHROMIUM_PATH']
        browser=await p.chromium.launch(**opts)
        context=await browser.new_context(viewport={'width':1440,'height':1000},service_workers='block')
        page=await context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
        async def intercept(route):
            parts=urlsplit(route.request.url)
            if parts.hostname=='api.mapbox.com':
                road='mapbox.mapbox-streets-v8' in parts.path
                if road:roads.append(parts.path)
                try:
                    if road and state['blocked']:await asyncio.wait_for(gate.wait(),30)
                    if road and state['auth']:
                        await route.fulfill(status=401,body='{}',content_type='application/json',headers={'access-control-allow-origin':'*'})
                    elif parts.path.endswith('.json'):
                        await route.fulfill(content_type='application/json',headers={'access-control-allow-origin':'*'},body=json.dumps({'scheme':'xyz','maxzoom':16,'modified':123,'vector_layers':[{'id':'road'}], 'attribution':'© <a href="https://www.mapbox.com/about/maps">Mapbox</a> © <a href="https://www.openstreetmap.org/copyright/">OpenStreetMap</a>'}))
                    elif road:await route.fulfill(content_type='application/x-protobuf',body=mvt(),headers={'access-control-allow-origin':'*'})
                    else:await route.fulfill(content_type='image/png',body=png((1,150,136) if 'terrain-rgb/' in parts.path else (70,130,100)),headers={'access-control-allow-origin':'*'})
                except Exception:pass
                return
            if parts.netloc!=urlsplit(base).netloc:unexpected.append(parts.hostname);await route.abort();return
            if 'road.worker-' in parts.path:worker_paths.append(parts.path)
            await route.continue_()
        await context.route('**/*',intercept)
        page.on('response',lambda r:http_errors.append({'path':urlsplit(r.url).path,'status':r.status}) if r.status>=400 else None)
        async def ready_surface():
            await page.wait_for_function('''() => {
              const d=window.__ZERANA_ROAD_SURFACE_DEBUG__,s=window.__ZERANA_STREAM_DEBUG__;
              if(d?.error)throw Error(d.error);
              return s?.active && !s.waitingForWindow && s.shownKeys.length===9 && s.shownKeys.every(k=>d?.cells.some(c=>c.key===k));
            }''',timeout=60000)
            return await page.evaluate('window.__ZERANA_ROAD_SURFACE_DEBUG__')
        try:
            await page.goto(query(base,source='synthetic',level='19'),wait_until='domcontentloaded')
            d=await ready_surface()
            expected=os.getenv('ZERANA_EXPECTED_SHA')
            if expected:assert await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.buildSha')==expected
            assert d['enabled'] and d['completed']>=9 and d['collidersAdded']==0
            assert worker_paths and len(roads)==0
            report['commit']=await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.buildSha')
            report['checks'].append('automatic-synthetic-surfaces-without-analysis-button-or-network')
            initial={c['key']:c['geometryId'] for c in d['cells']}
            await walk(page,'ArrowUp',30);await ready_surface()
            await walk(page,'ArrowDown',30);d=await ready_surface()
            now={c['key']:c['geometryId'] for c in d['cells']}
            assert all(now[k]==v for k,v in initial.items() if k in now)
            assert d['reused']>0,d
            report['checks'].append('native-walk-streams-surfaces-and-recycling-reuses-geometries')
            await page.locator('#diagnostics').evaluate('(e)=>e.open=true')
            await page.keyboard.press('Escape')
            before=await page.evaluate('window.__ZERANA_ROAD_SURFACE_DEBUG__')
            await page.click('#rebase');await page.wait_for_timeout(300)
            after=await page.evaluate('window.__ZERANA_ROAD_SURFACE_DEBUG__')
            assert {c['key']:c['geometryId'] for c in before['cells']}=={c['key']:c['geometryId'] for c in after['cells']}
            await page.click('#overview');await page.screenshot(path=str(OUTPUT/'road-surfaces-synthetic.png'))
            report['checks'].append('rebase-keeps-road-geometry-identities');report['synthetic']=after
            if os.getenv('ZERANA_SURFACE_QUICK')=='1':report['success']=True;return
            state['blocked']=True;gate.clear()
            await page.goto(query(base,source='mapbox',level='19'),wait_until='domcontentloaded')
            await page.wait_for_function('window.__ZERANA_STREAM_DEBUG__?.active && window.__ZERANA_PLAYER_DEBUG__?.active',timeout=60000)
            await walk(page,'ArrowUp',4)
            assert await page.evaluate('window.__ZERANA_PLAYER_DEBUG__.state.grounded')
            state['blocked']=False;gate.set();d=await ready_surface()
            assert len(roads)>0 and d['sourceCacheHits']>0 and d['httpCharged']<=d['httpLimit'],d
            assert d['residentBytes']<=d['residentLimit']
            report['checks'].append('delayed-vector-data-does-not-block-safe-ground-or-movement')
            oldcount=len(roads);oldcompleted=d['completed']
            await walk(page,'ArrowUp',30);d=await ready_surface()
            assert d['completed']>oldcompleted and d['sourceCacheHits']>0
            report['checks'].append('automatic-mapbox-binary-mvt-worker-and-shared-source-cache')
            report['mapbox']=d;report['roadRequests']=len(roads);report['requestsBeforeSecondWalk']=oldcount
            await page.keyboard.press('Escape');await page.locator('#diagnostics').evaluate('(e)=>e.open=true');await page.click('#overview')
            await page.screenshot(path=str(OUTPUT/'road-surfaces-mocked.png'))
            state['auth']=True
            await page.goto(query(base,source='mapbox',level='19'),wait_until='domcontentloaded')
            await page.wait_for_function('window.__ZERANA_ROAD_SURFACE_DEBUG__?.error',timeout=60000)
            assert await page.evaluate('window.__ZERANA_STREAM_DEBUG__.active')
            await walk(page,'ArrowUp',4)
            report['checks'].append('road-auth-failure-keeps-terrain-and-player-operational')
            state['auth']=False;state['blocked']=True;gate.clear()
            await page.goto(query(base,source='mapbox',level='19'),wait_until='domcontentloaded')
            await page.wait_for_function('window.__ZERANA_ROAD_SURFACE_DEBUG__?.inFlight',timeout=60000)
            await page.locator('#world-options').evaluate('(e)=>e.open=true');await page.select_option('#source-mode','synthetic')
            state['blocked']=False;gate.set();d=await ready_surface()
            assert d['httpCharged']==0 and d['error'] is None,d
            report['checks'].append('world-replacement-rejects-late-vector-results-and-resets-world-quota')
            await page.evaluate('window.dispatchEvent(new Event("pagehide"))');await page.wait_for_timeout(100)
            assert await page.evaluate('window.__ZERANA_ROAD_SURFACE_DEBUG__.cells.length')==0
            report['checks'].append('pagehide-disposes-road-residency-and-shared-worker')
            assert not errors and not unexpected,(errors,unexpected)
            assert all(e['status']==401 for e in http_errors),http_errors
            report['success']=True
        finally:
            state['blocked']=False;gate.set()
            report.update(pageErrors=errors,unexpectedRequests=unexpected,httpErrors=http_errors)
            try:report['lastState']=await page.evaluate('window.__ZERANA_ROAD_SURFACE_DEBUG__')
            except Exception:pass
            (OUTPUT/'summary.json').write_text(json.dumps(report,indent=2));await browser.close()
    print(json.dumps({'success':report['success'],'checks':report['checks']}))

if __name__=='__main__':
    if os.getenv('ZERANA_PREVIEW_URL'):asyncio.run(run(os.environ['ZERANA_PREVIEW_URL']))
    else:
        with tempfile.TemporaryDirectory() as temp:
            shutil.copytree(ROOT.parent/'dist',Path(temp)/'Zerana')
            server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(QuietHandler,directory=temp))
            threading.Thread(target=server.serve_forever,daemon=True).start()
            try:asyncio.run(run(f'http://127.0.0.1:{server.server_port}/Zerana/v2/'))
            finally:server.shutdown();server.server_close()
