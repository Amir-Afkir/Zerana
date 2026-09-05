"""Explicit delivery-only live check. Maximum 48 total Mapbox attempts.
No token or query is retained. Not a performance/coverage certification.
"""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
from playwright.async_api import async_playwright

async def run():
    base=os.environ['ZERANA_PREVIEW_URL'];expected=os.environ['ZERANA_EXPECTED_SHA']
    output=Path(__file__).resolve().parents[2]/'browser-results'/'roads-live';output.mkdir(parents=True,exist_ok=True)
    report={'mode':'LIVE_MAPBOX_ROAD_KERNEL','success':False};requests=[];errors=[];http_errors=[];unexpected=[]
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True,args=['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
        context=await browser.new_context(viewport={'width':1440,'height':1000},service_workers='block');page=await context.new_page()
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.on('response',lambda r:http_errors.append({'path':urlsplit(r.url).path,'status':r.status}) if r.status>=400 else None)
        async def intercept(route):
            parts=urlsplit(route.request.url)
            if parts.hostname=='api.mapbox.com':
                if len(requests)>=48:unexpected.append('live-budget');await route.abort();return
                requests.append(parts.path)
            elif parts.netloc!=urlsplit(base).netloc:unexpected.append(parts.hostname);await route.abort();return
            await route.continue_()
        await context.route('**/*',intercept)
        try:
            await page.goto(base+'?lab=manual',wait_until='networkidle')
            await page.wait_for_function('document.body.dataset.ready === "1"')
            assert await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.buildSha')==expected
            await page.select_option('#level','17');await page.select_option('#source-mode','mapbox');await page.check('#allow-preview')
            await page.click('#build');await page.wait_for_function('!document.getElementById("build").disabled',timeout=60000)
            assert await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.providerReport !== null')
            await page.click('#road-load')
            await page.wait_for_function('["ready","error"].includes(window.__ZERANA_ROADS_DEBUG__.state)',timeout=60000)
            result=await page.evaluate('window.__ZERANA_ROADS_DEBUG__')
            report['road']=result
            assert result['state']=='ready',result
            assert result['summary']['fragments']>0 and result['summary']['debugSegments']>0
            assert result['summary']['source']=='mapbox' and result['httpCharged']<=32
            assert not errors and not http_errors and not unexpected
            await page.click('#overview');await page.screenshot(path=str(output/'roads-live.png'))
            report.update(success=True,commit=expected,mapboxAttempts=len(requests),roadAttempts=result['httpCharged'])
        finally:
            report.update(pageErrors=errors,httpErrors=http_errors,unexpectedRequests=unexpected)
            (output/'summary.json').write_text(json.dumps(report,indent=2));await browser.close()
    print(json.dumps({'success':report['success'],'mapboxAttempts':report['mapboxAttempts'],'roadAttempts':report['roadAttempts']}))

if __name__=='__main__':asyncio.run(run())
