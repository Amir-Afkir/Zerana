"""Actual worker/keyboard/IndexedDB streaming checks. Provider responses are fixtures,
never live Mapbox. A public URL additionally verifies the exact published commit.
"""
import asyncio
import functools
import http.server
import json
import math
import os
from pathlib import Path
import shutil
import tempfile
import threading
from urllib.parse import urlsplit
from playwright.async_api import async_playwright
from provider_smoke import png, QuietHandler

ROOT=Path(__file__).resolve().parents[2]
OUTPUT=ROOT/'browser-results'/'streaming'

async def run(url):
    OUTPUT.mkdir(parents=True,exist_ok=True)
    report={'mode':'PUBLISHED_STREAMING_WITH_MOCKED_MAPBOX' if os.getenv('ZERANA_PREVIEW_URL') else 'BUILT_STREAMING_WITH_MOCKED_MAPBOX','checks':[]}
    errors=[];unexpected=[];http_failures=[];workers=[];provider_paths=[]
    state={'delay':0,'auth':False}
    async with async_playwright() as p:
        options={'headless':True,'args':['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']}
        if os.getenv('CHROMIUM_PATH'):options['executable_path']=os.environ['CHROMIUM_PATH']
        browser=await p.chromium.launch(**options)
        context=await browser.new_context(viewport={'width':1440,'height':1050},service_workers='block')
        page=await context.new_page()
        page.on('pageerror',lambda error:errors.append(str(error)))
        async def intercept(route):
            parts=urlsplit(route.request.url)
            if parts.hostname=='api.mapbox.com':
                provider_paths.append(parts.path)
                if state['delay']:await asyncio.sleep(state['delay'])
                try:
                    if state['auth']:
                        await route.fulfill(status=401,content_type='application/json',body='{}',headers={'access-control-allow-origin':'*'})
                    elif parts.path.endswith('.json'):
                        await route.fulfill(content_type='application/json',body=json.dumps({'attribution':'© <a href="https://www.mapbox.com/">Mapbox</a>'}),headers={'access-control-allow-origin':'*'})
                    else:
                        await route.fulfill(content_type='image/png',body=png((1,150,136) if 'terrain-rgb/' in parts.path else (60,135,90)),headers={'access-control-allow-origin':'*'})
                except Exception:
                    pass  # A cancelled worker can disappear before the fixture finishes.
                return
            if parts.netloc!=urlsplit(url).netloc:
                unexpected.append(parts.hostname);await route.abort();return
            if 'terrain.worker-' in parts.path:workers.append(route.request.url)
            await route.continue_()
        await context.route('**/*',intercept)
        page.on('response',lambda response:http_failures.append(response.status) if response.status>=400 and urlsplit(response.url).hostname!='api.mapbox.com' else None)
        try:
            await page.goto(url + ('&' if '?' in url else '?') + 'lab=manual',wait_until='networkidle')
            await page.wait_for_function('document.body.dataset.ready === "1"')
            expected=os.getenv('ZERANA_EXPECTED_SHA')
            if expected:assert await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.buildSha')==expected
            assert not provider_paths and not workers
            assert not await page.locator('#stream-network-option').is_visible()
            assert not (await page.evaluate('window.__ZERANA_STREAM_DEBUG__'))['active']
            report['checks'].append('static-default-no-worker-no-provider')
            # A compact metre-defined window makes cell crossings observable quickly.
            await page.select_option('#level','19');await page.select_option('#profile','flat');await page.select_option('#side','1')
            await page.click('#build');await page.wait_for_function('!document.getElementById("build").disabled')
            assert await page.evaluate('window.__ZERANA_PLAYER_DEBUG__.available')
            await page.select_option('#stream-radius','small');await page.click('#stream-toggle')
            await page.wait_for_function('window.__ZERANA_STREAM_DEBUG__.installed >= 2',timeout=30000)
            assert workers and not provider_paths
            start=await page.evaluate('window.__ZERANA_PLAYER_DEBUG__.state.ecefPosition')
            await page.select_option('#player-threshold','32');await page.click('#player-toggle')
            await page.keyboard.down('ShiftLeft');await page.keyboard.down('ArrowUp')
            await page.wait_for_function('''start => {const p=window.__ZERANA_PLAYER_DEBUG__.state.ecefPosition;
              return Math.hypot(p.xMeters-start.xMeters,p.yMeters-start.yMeters,p.zMeters-start.zMeters)>115;}''',arg=start,timeout=90000)
            await page.keyboard.up('ArrowUp');await page.keyboard.up('ShiftLeft');await page.keyboard.press('Escape')
            await page.wait_for_timeout(700)
            stream=await page.evaluate('window.__ZERANA_STREAM_DEBUG__');player=await page.evaluate('window.__ZERANA_PLAYER_DEBUG__')
            assert stream['active'] and stream['installed']>=3 and stream['evicted']>0,stream
            assert stream['cells']<=stream['maxCells'] and stream['peakQueuedBytes']<=4*1024*1024
            assert stream['cacheBytes']<=16*1024*1024 and stream['cacheEntries']<=32
            assert player['state']['grounded'] and player['runtimeError'] is None and player['rebases']>0
            assert all(abs(v-1)<1e-8 for v in player['scale'])
            assert set(stream['pinnedKeys']).issubset(stream['renderedKeys'])
            assert stream['centerKey'] in stream['renderedKeys']
            report['walk']=stream;report['player']=player
            report['checks'].append('native-walk-beyond-original-cell-stream-evict-and-rebase')
            await page.screenshot(path=str(OUTPUT/'streaming-synthetic.png'))
            # Abort while current geometry remains available; no scene reset.
            await page.click('#stream-toggle')
            stopped_ids=await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.geometryIds')
            await page.wait_for_timeout(1000)
            assert stopped_ids==await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.geometryIds')
            assert not await page.evaluate('window.__ZERANA_STREAM_DEBUG__.active')
            report['checks'].append('stop-terminates-workers-without-removing-safe-terrain')
            # Rebuild the same small source to prove reuse through real IndexedDB.
            await page.click('#build');await page.wait_for_function('!document.getElementById("build").disabled')
            await page.click('#stream-toggle');await page.wait_for_function('window.__ZERANA_STREAM_DEBUG__.diskHits>0',timeout=30000)
            report['checks'].append('indexeddb-synthetic-reuse-after-session-recreation')
            await page.click('#stream-toggle')
            await page.click('#stream-clear');await page.wait_for_function('document.getElementById("stream-status").textContent.includes("vidé")')
            report['checks'].append('persistent-cache-can-be-cleared')
            # Mapbox UI still requires a new, explicit network consent for streaming.
            await page.select_option('#source-mode','mapbox');await page.check('#allow-preview')
            await page.fill('#mapbox-token','pk.streaming-fixture');await page.click('#build')
            await page.wait_for_function('!document.getElementById("build").disabled',timeout=30000)
            assert await page.evaluate('window.__ZERANA_PLAYER_DEBUG__.available')
            before=len(provider_paths);await page.click('#stream-toggle');await page.wait_for_timeout(300)
            assert len(provider_paths)==before and not await page.evaluate('window.__ZERANA_STREAM_DEBUG__.active')
            await page.check('#stream-network-consent');state['delay']=.1
            await page.click('#stream-toggle');await page.wait_for_function('window.__ZERANA_STREAM_DEBUG__.installed>=2',timeout=40000)
            mapbox=await page.evaluate('window.__ZERANA_STREAM_DEBUG__')
            assert mapbox['source']=='mapbox' and mapbox['httpActual']>0 and mapbox['httpCharged']<=256
            assert mapbox['diskHits']==0
            assert await page.evaluate('window.__ZERANA_PLAYER_DEBUG__.altitudeAuthority')=='preview-only'
            assert await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.seams.maxGapMeters')<.001
            begin=await page.evaluate('window.__ZERANA_PLAYER_DEBUG__.state.ecefPosition')
            await page.click('#player-toggle');await page.keyboard.down('ShiftLeft');await page.keyboard.down('ArrowUp')
            await page.wait_for_function('''a=>{const b=window.__ZERANA_PLAYER_DEBUG__.state.ecefPosition;return Math.hypot(a.xMeters-b.xMeters,a.yMeters-b.yMeters,a.zMeters-b.zMeters)>35;}''',arg=begin,timeout=45000)
            await page.keyboard.up('ArrowUp');await page.keyboard.up('ShiftLeft');await page.keyboard.press('Escape')
            assert await page.evaluate('window.__ZERANA_PLAYER_DEBUG__.state.grounded')
            assert await page.evaluate('window.__ZERANA_PLAYER_DEBUG__.runtimeError') is None
            report['checks'].append('slow-mocked-network-walks-across-cell-with-ground-support')
            report['mapboxFixture']=mapbox
            report['checks'].append('worker-mapbox-png-offscreen-decode-byte-cache-and-consent')
            # The grant is enforced inside the real worker, not merely as a UI count.
            if await page.evaluate('window.__ZERANA_STREAM_DEBUG__.active'):await page.click('#stream-toggle')
            await page.wait_for_timeout(300)
            state['delay']=0
            worker_url=workers[0]
            count_before=len(provider_paths)
            result=await page.evaluate('''url => new Promise((resolve,reject)=>{
              const w=new Worker(url,{type:'module'});const timer=setTimeout(()=>{w.terminate();reject(Error('worker timeout'));},15000);
              w.onmessage=e=>{clearTimeout(timer);w.terminate();resolve(e.data);};
              w.onerror=()=>{clearTimeout(timer);w.terminate();reject(Error('worker error'));};
              w.postMessage({kind:'build',ticket:{key:'quota',revision:999},job:{source:'mapbox',profile:'flat',
                id:{scheme:'web-mercator',level:19,x:265566,y:180362},subdivisions:32,allowPreview:true,
                token:'pk.streaming-fixture',httpGrant:2,persistent:false}});
            })''',worker_url)
            assert result['kind']=='error' and result['code']=='STREAM_HTTP_BUDGET' and result['attempts']==2,result
            assert len(provider_paths)-count_before==2
            report['checks'].append('actual-worker-enforces-two-attempt-network-grant')
            # A malformed grant must fail before network access too.
            count_before=len(provider_paths)
            result=await page.evaluate('''url => new Promise((resolve,reject)=>{
              const w=new Worker(url,{type:'module'});const timer=setTimeout(()=>{w.terminate();reject(Error('worker timeout'));},15000);
              w.onmessage=e=>{clearTimeout(timer);w.terminate();resolve(e.data);};
              w.onerror=()=>{clearTimeout(timer);w.terminate();reject(Error('worker error'));};
              w.postMessage({kind:'build',ticket:{key:'bad-quota',revision:1000},job:{source:'mapbox',profile:'flat',
                id:{scheme:'web-mercator',level:19,x:265566,y:180362},subdivisions:32,allowPreview:true,
                token:'pk.streaming-fixture',httpGrant:null,persistent:false}});
            })''',worker_url)
            assert result['kind']=='error' and result['code']=='STREAM_HTTP_BUDGET' and result['attempts']==0
            assert len(provider_paths)==count_before
            report['checks'].append('malformed-worker-quota-rejected-before-network')
            # A provider failure must preserve the last safe patch, not erase it.
            await page.click('#build');await page.wait_for_function('!document.getElementById("build").disabled',timeout=30000)
            stable_ids=await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.geometryIds')
            state['auth']=True
            await page.check('#stream-network-consent');await page.click('#stream-toggle')
            await page.wait_for_function('window.__ZERANA_STREAM_DEBUG__.error === "PROVIDER_AUTH"',timeout=30000)
            assert not await page.evaluate('window.__ZERANA_STREAM_DEBUG__.active')
            assert stable_ids==await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.geometryIds')
            assert await page.evaluate('window.__ZERANA_PLAYER_DEBUG__.available')
            state['auth']=False
            report['checks'].append('streaming-auth-failure-stops-and-preserves-loaded-terrain')
            # Pending background calls are not allowed to replace geometry after stop.
            if await page.evaluate('window.__ZERANA_STREAM_DEBUG__.active'):await page.click('#stream-toggle')
            old=await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.geometryIds');await page.wait_for_timeout(500)
            assert old==await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.geometryIds')
            await page.evaluate('document.querySelector(".intro").textContent="TEST AUTOMATISÉ : réponses Mapbox simulées, pas du relief réel."')
            await page.screenshot(path=str(OUTPUT/'streaming-mapbox-fixtures.png'))
            assert not errors,errors;assert not unexpected,unexpected;assert not http_failures,http_failures
            report.update({'success':True,'pageErrors':errors,'unexpectedRequests':unexpected,'httpFailures':http_failures,'providerResponses':'ALL_MOCKED','mockProviderRequests':len(provider_paths)})
        except Exception as error:
            report.update({'success':False,'failure':str(error),'pageErrors':errors,'unexpectedRequests':unexpected,'httpFailures':http_failures})
            try:
                report['lastStream']=await page.evaluate('window.__ZERANA_STREAM_DEBUG__');report['lastPlayer']=await page.evaluate('window.__ZERANA_PLAYER_DEBUG__')
                await page.screenshot(path=str(OUTPUT/'failure.png'))
            except Exception:pass
            raise
        finally:
            (OUTPUT/'summary.json').write_text(json.dumps(report,indent=2))
            await browser.close()
    print(json.dumps({'success':report['success'],'checks':report['checks'],'providerResponses':report['providerResponses']}))

if __name__=='__main__':
    published=os.getenv('ZERANA_PREVIEW_URL')
    if published:asyncio.run(run(published))
    else:
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copytree(ROOT.parent/'dist',Path(tmp)/'Zerana')
            server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(QuietHandler,directory=tmp))
            threading.Thread(target=server.serve_forever,daemon=True).start()
            try:asyncio.run(run(f'http://127.0.0.1:{server.server_port}/Zerana/v2/'))
            finally:server.shutdown()
