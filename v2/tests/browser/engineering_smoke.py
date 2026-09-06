"""Synthetic engineering acceptance track, real terrain streaming/physics.
This does NOT certify live Mapbox engineering or hardware frame rates.
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
from provider_smoke import QuietHandler
from experience_smoke import query, walk

ROOT=Path(__file__).resolve().parents[2]
OUTPUT=ROOT/'browser-results'/'engineering'

async def run(base):
    OUTPUT.mkdir(parents=True,exist_ok=True)
    report={'mode':'SYNTHETIC_ENGINEERING_STREAM','success':False,'checks':[]}
    errors=[];unexpected=[];http_errors=[]
    async with async_playwright() as p:
        opts={'headless':True,'args':['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']}
        if os.getenv('CHROMIUM_PATH'):opts['executable_path']=os.environ['CHROMIUM_PATH']
        browser=await p.chromium.launch(**opts)
        context=await browser.new_context(viewport={'width':1440,'height':1000},service_workers='block')
        page=await context.new_page()
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.on('response',lambda r:http_errors.append({'path':urlsplit(r.url).path,'status':r.status}) if r.status>=400 else None)
        async def intercept(route):
            if urlsplit(route.request.url).netloc!=urlsplit(base).netloc:
                unexpected.append(urlsplit(route.request.url).hostname);await route.abort();return
            await route.continue_()
        await context.route('**/*',intercept)
        async def ready():
            await page.wait_for_function('''() => {
              const e=window.__ZERANA_ENGINEERING_DEBUG__,s=window.__ZERANA_STREAM_DEBUG__,r=window.__ZERANA_ROAD_SURFACE_DEBUG__;
              if(r?.error)throw Error(r.error);
              return e?.active && s?.active && !s.waitingForWindow && s.shownKeys.length===9 && s.shownKeys.every(k=>r?.cells.some(c=>c.key===k));
            }''',timeout=60000)
            return await page.evaluate('({engineering:__ZERANA_ENGINEERING_DEBUG__,terrain:__ZERANA_TERRAIN_DEBUG__,roads:__ZERANA_ROAD_SURFACE_DEBUG__,stream:__ZERANA_STREAM_DEBUG__,player:__ZERANA_PLAYER_DEBUG__})')
        try:
            await page.goto(query(base,source='synthetic',profile='engineering',level='19'),wait_until='domcontentloaded')
            first=await ready();expected=os.getenv('ZERANA_EXPECTED_SHA')
            if expected:assert first['terrain']['buildSha']==expected
            assert first['engineering']['source']=='synthetic-engineering-v1'
            assert first['engineering']['mode']=='synthetic-acceptance-only'
            assert first['engineering']['defaultMapboxAltered'] is False
            assert first['engineering']['profile']['maxCutMeters']>1 and first['engineering']['profile']['maxFillMeters']>1
            assert first['terrain']['seams']['maxGapMeters']<.001
            assert sum(c['triangles'] for c in first['roads']['cells'])>0
            assert first['player']['state']['grounded']
            report['checks'].append('opt-in-engineered-track-automatic-terrain-roads-player-no-network')
            report['initial']=first['engineering'];report['commit']=first['terrain']['buildSha']
            initial={c['key']:c['geometryId'] for c in first['roads']['cells']}
            await walk(page,'ArrowRight',80,timeout=90000);forward=await ready()
            assert forward['roads']['completed']>first['roads']['completed']
            assert forward['player']['state']['grounded']
            assert forward['terrain']['seams']['maxGapMeters']<.001
            report['checks'].append('native-movement-crosses-engineered-chunks-with-physical-ground')
            await walk(page,'ArrowLeft',80,timeout=90000);back=await ready()
            now={c['key']:c['geometryId'] for c in back['roads']['cells']}
            retained=[k for k in initial if k in now]
            assert retained and all(now[k]==initial[k] for k in retained)
            assert back['roads']['reused']>0 and back['roads']['residentBytes']<=back['roads']['residentLimit']
            report['checks'].append('return-reuses-engineered-terrain-and-retained-road-resources')
            await page.keyboard.press('Escape');await page.locator('#diagnostics').evaluate('(e)=>e.open=true')
            before=await page.evaluate('window.__ZERANA_PLAYER_DEBUG__.state.ecefPosition')
            for _ in range(3):await page.click('#rebase')
            await page.wait_for_timeout(300)
            after=await page.evaluate('window.__ZERANA_PLAYER_DEBUG__.state.ecefPosition')
            assert before==after
            report['checks'].append('three-rebases-preserve-global-player-pose-on-engineered-ground')
            await page.click('#overview')
            await page.screenshot(path=str(OUTPUT/'engineering-track.png'))
            report['roads']=back['roads'];report['seams']=back['terrain']['seams']
            await page.goto(query(base,source='synthetic',profile='engineering-raw',level='19'),wait_until='domcontentloaded')
            await page.wait_for_function('window.__ZERANA_STREAM_DEBUG__?.active && window.__ZERANA_ENGINEERING_DEBUG__?.source === "synthetic-engineering-raw-v1"',timeout=60000)
            assert await page.evaluate('window.__ZERANA_ENGINEERING_DEBUG__.active') is False
            report['checks'].append('raw-reference-source-can-be-selected-without-cache-aliasing')
            await page.goto(query(base,source='synthetic',profile='flat',level='19'),wait_until='domcontentloaded')
            await page.wait_for_function('window.__ZERANA_ENGINEERING_DEBUG__?.source === "synthetic-flat-v1"',timeout=60000)
            assert await page.evaluate('window.__ZERANA_ENGINEERING_DEBUG__.active') is False
            report['checks'].append('existing-flat-world-retains-its-original-source-authority')
            assert not errors and not unexpected and not http_errors
            report['success']=True
        finally:
            report.update(pageErrors=errors,unexpectedRequests=unexpected,httpErrors=http_errors)
            try:report['lastState']=await page.evaluate('window.__ZERANA_ENGINEERING_DEBUG__')
            except Exception:pass
            (OUTPUT/'summary.json').write_text(json.dumps(report,indent=2));await browser.close()
    print(json.dumps({k:report[k] for k in ['mode','success','checks']}))

if __name__=='__main__':
    public=os.getenv('ZERANA_PREVIEW_URL')
    if public:asyncio.run(run(public))
    else:
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);shutil.copytree(ROOT.parent/'dist',root/'Zerana')
            server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(QuietHandler,directory=str(root)))
            threading.Thread(target=server.serve_forever,daemon=True).start()
            try:asyncio.run(run(f'http://127.0.0.1:{server.server_port}/Zerana/v2/'))
            finally:server.shutdown()
