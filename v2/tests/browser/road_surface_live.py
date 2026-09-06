"""Delivery opt-in only. 96 actual Mapbox attempts maximum, not a benchmark.
Uses the real automatic route/terrain stream and never retains tokens/queries.
"""
import asyncio
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from playwright.async_api import async_playwright
from experience_smoke import query, walk

async def run():
    base=os.environ['ZERANA_PREVIEW_URL'];expected=os.environ['ZERANA_EXPECTED_SHA']
    output=Path(__file__).resolve().parents[2]/'browser-results'/'road-surface-live';output.mkdir(parents=True,exist_ok=True)
    report={'mode':'LIVE_AUTOMATIC_ROAD_SURFACES','success':False,'checks':[],'requestLimit':96}
    requests=[];errors=[];http_errors=[];unexpected=[]
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True,args=['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
        context=await browser.new_context(viewport={'width':1440,'height':1000},service_workers='block')
        page=await context.new_page()
        page.on('pageerror',lambda e:errors.append(type(e).__name__))
        page.on('response',lambda r:http_errors.append({'path':urlsplit(r.url).path,'status':r.status}) if r.status>=400 else None)
        async def intercept(route):
            parts=urlsplit(route.request.url)
            if parts.hostname=='api.mapbox.com':
                if len(requests)>=96:unexpected.append('live-request-cap');await route.abort();return
                token=parse_qs(parts.query).get('access_token',[''])[0]
                fingerprint=os.getenv('ZERANA_EXPECTED_TOKEN_SHA256')
                if fingerprint and hashlib.sha256(token.encode()).hexdigest()!=fingerprint:
                    unexpected.append('token-fingerprint');await route.abort();return
                requests.append(parts.path)
            elif parts.netloc!=urlsplit(base).netloc:unexpected.append(parts.hostname);await route.abort();return
            await route.continue_()
        await context.route('**/*',intercept)
        async def ready():
            await page.wait_for_function('''() => {
              const d=window.__ZERANA_ROAD_SURFACE_DEBUG__,s=window.__ZERANA_STREAM_DEBUG__;
              if(d?.error) throw Error(d.error);
              return s?.active && !s.waitingForWindow && s.shownKeys.length===9 && s.shownKeys.every(k=>d?.cells.some(c=>c.key===k));
            }''',timeout=90000)
            return await page.evaluate('window.__ZERANA_ROAD_SURFACE_DEBUG__')
        try:
            await page.goto(query(base,source='mapbox',level='19'),wait_until='domcontentloaded')
            initial=await ready()
            assert await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.buildSha')==expected
            assert await page.input_value('#source-mode')=='mapbox'
            assert initial['enabled'] and sum(c['triangles'] for c in initial['cells'])>0
            assert initial['collidersAdded']==0
            report['initial']=initial;report['checks'].append('live-mapbox-surfaces-automatic-no-analysis-click')
            await walk(page,'ArrowUp',55,timeout=90000);forward=await ready()
            assert forward['completed']>initial['completed']
            assert await page.evaluate('window.__ZERANA_PLAYER_DEBUG__.state.grounded')
            report['forward']=forward;report['checks'].append('native-walk-loads-new-road-cells-with-ground-support')
            await walk(page,'ArrowDown',55,timeout=90000);back=await ready()
            ids={c['key']:c['geometryId'] for c in back['cells']}
            original={c['key']:c['geometryId'] for c in initial['cells']}
            retained=[k for k in original if k in ids]
            assert retained and all(ids[k]==original[k] for k in retained)
            assert back['reused']>0 and back['residentBytes']<=back['residentLimit']
            report['back']=back;report['checks'].append('retained-road-geometry-reused-on-return')
            await page.keyboard.press('Escape');await page.locator('#diagnostics').evaluate('(e)=>e.open=true')
            await page.click('#overview');await page.screenshot(path=str(output/'road-surfaces-live.png'))
            assert not errors and not http_errors and not unexpected
            report.update(success=True,commit=expected,mapboxAttempts=len(requests),roadAttempts=sum('mapbox.mapbox-streets-v8' in s for s in requests))
        finally:
            report.update(pageErrors=errors,httpErrors=http_errors,unexpectedRequests=unexpected,observedAttempts=len(requests))
            try:report['lastState']=await page.evaluate('window.__ZERANA_ROAD_SURFACE_DEBUG__')
            except Exception:pass
            (output/'summary.json').write_text(json.dumps(report,indent=2));await browser.close()
    print(json.dumps({k:report[k] for k in ['mode','success','checks','mapboxAttempts','roadAttempts']}))

if __name__=='__main__':asyncio.run(run())
