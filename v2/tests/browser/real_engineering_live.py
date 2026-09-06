"""Release opt-in: bounded REAL MVT/DEM engineering, never mock provider data.

Five fixed geographic probes; only the first walks 70 m out and back. Regions
with deferred alignments remain valid raw ground, but at least one real probe
must produce nonzero earthwork. This is not road-design or driving qualification.
"""
import asyncio
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from playwright.async_api import async_playwright
from experience_smoke import query, walk

OUTPUT = Path(__file__).resolve().parents[2] / 'browser-results' / 'real-engineering-live'
LIMIT = 384
# Labels are test locations, not assertions about geometry or source completeness.
PROBES = [('paris', 2.35, 48.86), ('morvan', 4.103, 47.27),
          ('chamonix', 6.869, 45.923), ('calanques', 5.44, 43.222),
          ('paris-junction', 2.293, 48.873)]
READY = '''() => {
  const e=window.__ZERANA_REAL_ENGINEERING_DEBUG__,s=window.__ZERANA_STREAM_DEBUG__,r=window.__ZERANA_ROAD_SURFACE_DEBUG__;
  if(!document.querySelector('#build').disabled&&document.querySelector('#status').classList.contains('error'))throw Error(document.querySelector('#status').textContent);
  if(s?.error)throw Error(s.error);if(s?.scheduler?.errors.length)throw Error(s.scheduler.errors.join(','));
  if(r?.error)throw Error(r.error);
  return e?.active && s?.active && !s.waitingForWindow && s.shownKeys.length===9 &&
    s.shownKeys.every(k=>e.cells.some(c=>c.key===k)&&r?.cells.some(c=>c.key===k&&c.bundled));
}'''
STATE = '''({engineering:window.__ZERANA_REAL_ENGINEERING_DEBUG__,stream:window.__ZERANA_STREAM_DEBUG__,
 roads:window.__ZERANA_ROAD_SURFACE_DEBUG__,terrain:window.__ZERANA_TERRAIN_DEBUG__,player:window.__ZERANA_PLAYER_DEBUG__})'''

async def run():
    base = os.environ['ZERANA_PREVIEW_URL']; expected = os.environ['ZERANA_EXPECTED_SHA']
    OUTPUT.mkdir(parents=True, exist_ok=True)
    report = {'mode':'LIVE_REAL_ROAD_ENGINEERING','success':False,'commit':expected,
              'requestLimit':LIMIT,'cellLevel':19,'probes':[],'checks':[]}
    requests=[]; errors=[]; http_errors=[]; unexpected=[]
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=['--no-sandbox','--use-gl=angle',
            '--use-angle=swiftshader','--enable-unsafe-swiftshader'])
        try:
            for name, lon, lat in PROBES:
                context = await browser.new_context(viewport={'width':1440,'height':1000},service_workers='block')
                page = await context.new_page(); begin=len(requests)
                probe={'name':name,'longitude':lon,'latitude':lat,'success':False};report['probes'].append(probe)
                page.on('pageerror',lambda e:errors.append(type(e).__name__))
                page.on('response',lambda r:http_errors.append({'path':urlsplit(r.url).path,'status':r.status}) if r.status>=400 else None)
                async def intercept(route):
                    parts=urlsplit(route.request.url)
                    if parts.hostname=='api.mapbox.com':
                        if len(requests)>=LIMIT or len(requests)-begin>=128:
                            unexpected.append('live-request-cap');await route.abort();return
                        token=parse_qs(parts.query).get('access_token',[''])[0]
                        fp=os.getenv('ZERANA_EXPECTED_TOKEN_SHA256')
                        if fp and hashlib.sha256(token.encode()).hexdigest()!=fp:
                            unexpected.append('token-fingerprint');await route.abort();return
                        requests.append(parts.path) # Queries/tokens are never retained.
                    elif parts.netloc!=urlsplit(base).netloc:
                        unexpected.append(parts.hostname);await route.abort();return
                    await route.continue_()
                await context.route('**/*',intercept)
                async def ready():
                    await page.wait_for_function(READY, timeout=180000)
                    return await page.evaluate(STATE)
                try:
                    # Start without paid calls, then choose the exact probe before
                    # enabling the real source. No analysis or walk/pause button.
                    await page.goto(query(base,source='synthetic',level='19'),wait_until='domcontentloaded')
                    await page.wait_for_function("window.__ZERANA_PLAYER_DEBUG__?.active",timeout=60000)
                    await page.locator('#world-options').evaluate('(e)=>e.open=true')
                    await page.fill('#longitude',str(lon));await page.fill('#latitude',str(lat))
                    await page.locator('#real-engineering').evaluate('(e)=>e.checked=true')
                    await page.select_option('#source-mode','mapbox')
                    initial=await ready();probe['initial']=initial
                    assert initial['terrain']['buildSha']==expected
                    assert initial['engineering']['qualifiedForDriving'] is False
                    assert initial['engineering']['mainThreadBvhBuildCount']==0
                    assert initial['engineering']['preparedBvhAdoptions']>=9
                    assert initial['engineering']['maxDeltaMeters']<=3.000000001
                    assert initial['roads']['collidersAdded']==0 and initial['roads']['httpCharged']==0
                    assert all(c['bundled'] and c['terrainSourceId'].startswith('mapbox.terrain-rgb/real-ground-engineering-v1/') for c in initial['roads']['cells'])
                    assert initial['terrain']['seams']['maxGapMeters']<.001
                    assert initial['terrain']['seams']['maxNormalDelta']<.001
                    assert initial['stream']['loadedBytes']<=initial['stream']['maxResidentPayloadBytes']
                    assert initial['roads']['residentBytes']<=initial['roads']['residentLimit']
                    assert initial['engineering']['httpActual']<=initial['engineering']['httpLimit']
                    if name=='paris':
                        # Focus leaves the coordinate inputs through normal canvas
                        # interaction; this is not a start-walking button.
                        await page.locator('#viewport').click(position={'x':700,'y':550})
                        original={c['key']:c['geometryId'] for c in initial['roads']['cells']}
                        await walk(page,'ArrowRight',70,timeout=180000);forward=await ready();probe['forward']=forward
                        assert forward['stream']['installed']>initial['stream']['installed']
                        assert forward['player']['state']['grounded']
                        await walk(page,'ArrowLeft',70,timeout=180000);back=await ready();probe['back']=back
                        found={c['key']:c['geometryId'] for c in back['roads']['cells']}
                        retained=set(original)&set(found)
                        assert retained and all(found[k]==original[k] for k in retained)
                        assert back['roads']['reused']>0
                        assert back['stream']['loadedBytes']<=back['stream']['maxResidentPayloadBytes']
                        assert back['roads']['residentBytes']<=back['roads']['residentLimit']
                        await page.keyboard.press('Escape');await page.locator('#diagnostics').evaluate('(e)=>e.open=true')
                        for _ in range(3):await page.click('#rebase')
                        await page.wait_for_timeout(400);after=await ready()
                        assert {c['key']:c['geometryId'] for c in after['roads']['cells']}==found
                        assert after['terrain']['seams']['maxGapMeters']<.001
                        report['checks'].append('real-70m-walk-return-and-three-rebases-preserve-cohort-ground-and-road-identities')
                    await page.locator('#diagnostics').evaluate('(e)=>e.open=true')
                    await page.click('#overview');await page.screenshot(path=str(OUTPUT/f'{name}.png'))
                    probe.update(success=True,attempts=len(requests)-begin)
                    assert not errors and not http_errors and not unexpected
                finally:
                    try:
                        probe['lastStatus']=await page.text_content('#status')
                        probe['lastState']=await page.evaluate(STATE)
                    except Exception:pass
                    probe['attempts']=len(requests)-begin
                    await context.close()
            assert len(report['probes'])==5 and all(x['success'] for x in report['probes'])
            assert any(x['initial']['engineering']['modifiedSamples']>0 and x['initial']['engineering']['maxDeltaMeters']>1e-4 for x in report['probes'])
            assert not errors and not http_errors and not unexpected
            report['checks'].extend(['five-real-geographic-probes-publish-complete-bounded-cohorts',
                'real-dem-earthwork-is-nonzero-and-remains-explicitly-estimated',
                'all-reported-cell-seams-remain-below-one-millimetre'])
            report['success']=True
        finally:
            report.update(pageErrors=errors,httpErrors=http_errors,unexpected=unexpected,observedAttempts=len(requests),
                          roadAttempts=sum('mapbox.mapbox-streets-v8' in x for x in requests))
            (OUTPUT/'summary.json').write_text(json.dumps(report,indent=2));await browser.close()
    print(json.dumps({k:report[k] for k in ['mode','success','checks','observedAttempts','roadAttempts']}))

if __name__=='__main__':asyncio.run(run())
