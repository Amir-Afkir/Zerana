"""Stage 9 road kernel: real MVT decode in a real worker, all providers mocked.
No road generation is triggered on open; road snapshot is explicit and bounded.
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

ROOT=Path(__file__).resolve().parents[2]
OUTPUT=ROOT/'browser-results'/'roads'

def varint(n):
    result=bytearray()
    while n>=128:
        result.append((n&127)|128);n>>=7
    result.append(n)
    return bytes(result)

def field(tag,wire,data):
    return varint(tag*8+wire)+(varint(len(data))+data if wire==2 else varint(data))

def mvt():
    keys=['class','type','structure','layer','oneway','surface']
    values=['street','residential','none',0,'false','paved','path','footway','bridge',1]
    output=field(1,2,b'road')+field(15,0,2)+field(5,0,4096)
    for key in keys:output+=field(3,2,key.encode())
    for v in values:output+=field(4,2,field(5,0,v) if isinstance(v,int) else field(1,2,v.encode()))
    def line(points,tags):
        g=[];x=y=0
        for i,(xx,yy) in enumerate(points):
            if i==0:g.append(9)
            if i==1:g.append((len(points)-1)*8+2)
            dx=xx-x;dy=yy-y;g.extend([2*dx if dx>=0 else -2*dx-1,2*dy if dy>=0 else -2*dy-1]);x=xx;y=yy
        return field(2,2,field(1,0,0)+field(3,0,2)+field(2,2,b''.join(varint(t) for t in tags))+field(4,2,b''.join(varint(n) for n in g)))
    for n in [1024,2048,3072]:
        output+=line([[-100,n],[2048,n],[4196,n]],[0,0,1,1,2,2,3,3,4,4,5,5])
        output+=line([[n,-100],[n,2048],[n,4196]],[0,6,1,7,2,2,3,3,4,4,5,5])
    output+=line([[0,0],[2048,2048],[4096,4096]],[0,0,1,1,2,8,3,9,4,4,5,5])
    return field(3,2,output)

async def run(base):
    OUTPUT.mkdir(parents=True,exist_ok=True)
    report={'mode':'PUBLISHED_ROAD_KERNEL_MOCKED' if os.getenv('ZERANA_PREVIEW_URL') else 'BUILT_ROAD_KERNEL_MOCKED','checks':[]}
    errors=[];unexpected=[];http_errors=[];roads=[];workers=[]
    state={'auth':False,'blocked':False};gate=asyncio.Event();gate.set()
    async with async_playwright() as p:
        options={'headless':True,'args':['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']}
        if os.getenv('CHROMIUM_PATH'):options['executable_path']=os.environ['CHROMIUM_PATH']
        browser=await p.chromium.launch(**options)
        context=await browser.new_context(viewport={'width':1440,'height':1000},service_workers='block')
        page=await context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
        async def intercept(route):
            parts=urlsplit(route.request.url)
            if parts.hostname=='api.mapbox.com':
                is_road='mapbox.mapbox-streets-v8' in parts.path
                if is_road:roads.append(parts.path)
                try:
                    if is_road and state['blocked']:await asyncio.wait_for(gate.wait(),20)
                    if is_road and state['auth']:await route.fulfill(headers={'access-control-allow-origin':'*'},status=401,body='{}',content_type='application/json')
                    elif parts.path.endswith('.json'):
                        await route.fulfill(headers={'access-control-allow-origin':'*'},content_type='application/json',body=json.dumps({'scheme':'xyz','maxzoom':16,'modified':123,'attribution':'© <a href="https://www.mapbox.com/about/maps">Mapbox</a> © <a href="https://www.openstreetmap.org/copyright/">OpenStreetMap</a>','vector_layers':[{'id':'road'}]}))
                    elif is_road:await route.fulfill(headers={'access-control-allow-origin':'*'},content_type='application/x-protobuf',body=mvt())
                    else:await route.fulfill(headers={'access-control-allow-origin':'*'},content_type='image/png',body=png((1,150,136) if 'terrain-rgb/' in parts.path else (40,90,75)))
                except Exception:pass
                return
            if parts.netloc!=urlsplit(base).netloc:unexpected.append(parts.hostname);await route.abort();return
            if 'road.worker-' in parts.path:workers.append(parts.path)
            await route.continue_()
        await context.route('**/*',intercept)
        page.on('response',lambda r:http_errors.append(r.status) if r.status>=400 and not (r.status==401 and 'mapbox-streets-v8' in r.url) else None)
        async def build():
            await page.click('#build');await page.wait_for_function('!document.getElementById("build").disabled',timeout=60000)
        async def load():
            await page.click('#road-load');await page.wait_for_function('window.__ZERANA_ROADS_DEBUG__.state !== "loading"',timeout=60000)
            assert await page.evaluate('window.__ZERANA_ROADS_DEBUG__.state')=='ready',await page.evaluate('window.__ZERANA_ROADS_DEBUG__')
            await page.click('#overview')
        try:
            await page.goto(base+'?lab=manual',wait_until='networkidle')
            await page.wait_for_function('document.body.dataset.ready === "1"')
            expected=os.getenv('ZERANA_EXPECTED_SHA')
            if expected:assert await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.buildSha')==expected
            report['commit']=await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.buildSha')
            assert not roads and not workers
            report['checks'].append('no-road-request-or-worker-on-open')
            await page.select_option('#side','2');await page.select_option('#profile','waves');await build()
            before=await page.evaluate('window.__ZERANA_PLAYER_DEBUG__')
            await load()
            first=await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.roadCells')
            debug=await page.evaluate('window.__ZERANA_ROADS_DEBUG__')
            assert workers and len(first)==4 and debug['summary']['debugSegments']>0 and not roads
            assert debug['summary']['topologyAuthority']=='cartographic-not-routable'
            assert debug['summary']['deferredStructures']>0
            assert await page.evaluate('window.__ZERANA_PLAYER_DEBUG__.colliderCount')==before['colliderCount']
            report['checks'].append('synthetic-four-cells-worker-debug-without-new-collider')
            await page.click('#overview')
            await page.screenshot(path=str(OUTPUT/'roads-synthetic.png'))
            ids=[c['geometryId'] for c in first]
            for _ in range(3):await page.click('#rebase')
            assert [c['geometryId'] for c in await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.roadCells')]==ids
            report['checks'].append('road-geometry-identities-preserved-after-rebases')
            await page.uncheck('#road-visible');assert all(not c['visible'] for c in await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.roadCells'))
            await page.check('#road-visible')
            count=await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.geometries')
            for _ in range(3):await load()
            assert await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.geometries')==count
            report['checks'].append('visibility-toggle-and-repeated-snapshot-resource-disposal')
            await page.select_option('#source-mode','mapbox');await page.check('#allow-preview');await page.fill('#mapbox-token','pk.road-fixture');await build()
            assert not roads
            await load();n=len(roads)
            assert n<=17 and n>1
            live=await page.evaluate('window.__ZERANA_ROADS_DEBUG__')
            assert live['summary']['sourceZoom']==16 and live['summary']['source']=='mapbox'
            assert live['httpCharged']==n and live['httpCharged']<=32
            await load();assert len(roads)==n
            assert await page.evaluate('window.__ZERANA_ROADS_DEBUG__.summary.cacheHits')>0
            assert await page.locator('#attribution').is_visible()
            report['mockedProvider']=live
            report['checks'].append('binary-MVT-decoded-in-worker-tilejson-overzoom-cache-and-quota')
            await page.evaluate('document.querySelector(".intro").textContent="DIAGNOSTIC AUTOMATISÉ : axes et satellite simulés, pas des routes réelles."')
            await page.click('#overview');await page.screenshot(path=str(OUTPUT/'roads-mocked.png'))
            await build();stable=await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.geometryIds');state['auth']=True
            await page.click('#road-load');await page.wait_for_function('window.__ZERANA_ROADS_DEBUG__.state === "error"')
            assert await page.evaluate('window.__ZERANA_ROADS_DEBUG__.error')=='ROAD_PROVIDER_AUTH'
            assert stable==await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.geometryIds')
            report['checks'].append('road-provider-error-does-not-delete-valid-terrain')
            state['auth']=False;await build();state['blocked']=True;gate.clear()
            await page.click('#road-load');await page.wait_for_timeout(150)
            await page.select_option('#source-mode','synthetic');await build();gate.set();state['blocked']=False
            await page.wait_for_timeout(1100)
            assert await page.evaluate('window.__ZERANA_ROADS_DEBUG__.state')=='idle'
            assert not await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.roadCells')
            report['checks'].append('late-network-result-cannot-attach-to-new-world')
            await load();await page.evaluate('window.dispatchEvent(new Event("pagehide"))')
            assert await page.evaluate('window.__ZERANA_ROADS_DEBUG__.state')=='disposed'
            report['checks'].append('world-disposal-stops-road-worker-and-resources')
            assert not errors,errors;assert not unexpected,unexpected;assert not http_errors,http_errors
            report.update(success=True,pageErrors=errors,unexpectedRequests=unexpected,httpErrors=http_errors,providerResponses='ALL_MOCKED')
        except Exception as error:
            report.update(success=False,failure=str(error),pageErrors=errors,unexpectedRequests=unexpected,httpErrors=http_errors)
            try:
                report['lastRoad']=await page.evaluate('window.__ZERANA_ROADS_DEBUG__')
                await page.screenshot(path=str(OUTPUT/'failure.png'))
            except Exception:pass
            raise
        finally:
            (OUTPUT/'summary.json').write_text(json.dumps(report,indent=2));await browser.close()
    print(json.dumps({'success':report['success'],'checks':report['checks']}))

if __name__=='__main__':
    url=os.getenv('ZERANA_PREVIEW_URL')
    if url:asyncio.run(run(url))
    else:
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copytree(ROOT.parent/'dist',Path(tmp)/'Zerana')
            server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(QuietHandler,directory=tmp))
            threading.Thread(target=server.serve_forever,daemon=True).start()
            try:asyncio.run(run(f'http://127.0.0.1:{server.server_port}/Zerana/v2/'))
            finally:server.shutdown()
