"""Native-input checks of the published/built 3x3 window. Mapbox is ALWAYS mocked."""
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

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'browser-results' / 'sliding-window'

async def run(url):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    report = {'mode': 'PUBLISHED_SLIDING_WINDOW' if os.getenv('ZERANA_PREVIEW_URL') else 'BUILT_SLIDING_WINDOW', 'checks': []}
    errors, unexpected, http_failures, provider_requests = [], [], [], []
    state = {'delay': 0}
    async with async_playwright() as p:
        options = {'headless': True, 'args': ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']}
        if os.getenv('CHROMIUM_PATH'):
            options['executable_path'] = os.environ['CHROMIUM_PATH']
        browser = await p.chromium.launch(**options)
        context = await browser.new_context(viewport={'width': 1440, 'height': 1050}, service_workers='block')
        page = await context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('response', lambda r: http_failures.append(r.status) if r.status >= 400 else None)
        async def intercept(route):
            parts = urlsplit(route.request.url)
            if parts.hostname == 'api.mapbox.com':
                provider_requests.append(parts.path)
                if state['delay']:
                    await asyncio.sleep(state['delay'])
                try:
                    if parts.path.endswith('.json'):
                        await route.fulfill(content_type='application/json', body=json.dumps({'attribution': '© Mapbox'}), headers={'access-control-allow-origin': '*'})
                    else:
                        await route.fulfill(content_type='image/png', body=png((1,150,136) if 'terrain-rgb/' in parts.path else (60,135,90)), headers={'access-control-allow-origin': '*'})
                except Exception:
                    pass  # Cancellation can terminate a worker awaiting a fixture.
                return
            if parts.netloc != urlsplit(url).netloc:
                unexpected.append(parts.hostname)
                await route.abort()
                return
            await route.continue_()
        await context.route('**/*', intercept)
        async def snapshot():
            return await page.evaluate('({stream:window.__ZERANA_STREAM_DEBUG__,player:window.__ZERANA_PLAYER_DEBUG__,terrain:window.__ZERANA_TERRAIN_DEBUG__})')
        async def wait_window():
            await page.wait_for_function('window.__ZERANA_STREAM_DEBUG__.shownKeys.length === 9 && !window.__ZERANA_STREAM_DEBUG__.waitingForWindow', timeout=60000)
        async def walk(key, distance):
            start = await page.evaluate('window.__ZERANA_PLAYER_DEBUG__.state.ecefPosition')
            if not await page.evaluate('window.__ZERANA_PLAYER_DEBUG__.active'):
                await page.click('#player-toggle')
            await page.keyboard.down('ShiftLeft')
            await page.keyboard.down(key)
            try:
                await page.wait_for_function('''a => { const b=window.__ZERANA_PLAYER_DEBUG__.state.ecefPosition;
                  return Math.hypot(a.p.xMeters-b.xMeters,a.p.yMeters-b.yMeters,a.p.zMeters-b.zMeters)>a.d; }''', arg={'p':start,'d':distance}, timeout=120000)
            finally:
                await page.keyboard.up(key)
                await page.keyboard.up('ShiftLeft')
                await page.keyboard.press('Escape')
            await wait_window()
            await page.wait_for_function('Object.entries(window.__ZERANA_STREAM_DEBUG__.scheduler.states).every(([k,v]) => ![\"QUEUED\",\"GENERATING\",\"CPU_READY\"].includes(k) || v === 0)', timeout=60000)
            await page.wait_for_timeout(300)
        try:
            await page.goto(url + ('&' if '?' in url else '?') + 'lab=manual', wait_until='networkidle')
            await page.wait_for_function('document.body.dataset.ready === "1"')
            expected = os.getenv('ZERANA_EXPECTED_SHA')
            if expected:
                assert await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.buildSha') == expected
            assert not provider_requests
            assert await page.input_value('#stream-radius') == 'window'
            report['checks'].append('default-window-option-without-automatic-network-or-streaming')
            # Centre a small real geographic cell; only normal UI input is used.
            level = 21
            n = 2 ** level
            x = math.floor((2.35/360 + .5) * n)
            y = math.floor((1-math.asinh(math.tan(math.radians(48.86)))/math.pi)/2 * n)
            await page.select_option('#level', str(level))
            await page.fill('#longitude', str((x+.5)/n*360-180))
            await page.fill('#latitude', str(math.degrees(math.atan(math.sinh(math.pi*(1-2*(y+.5)/n))))))
            await page.select_option('#profile', 'flat')
            await page.select_option('#side', '1')
            await page.click('#build')
            await page.wait_for_function('!document.getElementById("build").disabled')
            await page.uncheck('#stream-cache')
            await page.click('#stream-toggle')
            await wait_window()
            initial = await snapshot()
            assert initial['stream']['mode'] == 'sliding-3x3'
            assert initial['player']['runtimeError'] is None
            initial_ids = {c['key']:c['geometryId'] for c in initial['terrain']['cellResources'] if c['visible']}
            assert len(initial_ids) == 9
            report['checks'].append('nine-ready-visible-cells-before-window-commit')
            await page.select_option('#player-threshold', '32')
            await walk('ArrowUp', 32)
            forward = await snapshot()
            assert forward['stream']['windowSwitches'] >= 2
            assert any(not c['visible'] for c in forward['terrain']['cellResources'])
            assert forward['player']['activeColliderCount'] == 9
            assert forward['player']['state']['grounded'] and forward['player']['runtimeError'] is None
            report['checks'].append('native-forward-walk-recentres-window-and-hides-recycled-cells')
            # Reverse using native input; recycled cells must keep their geometry identity.
            await walk('ArrowDown', 32)
            returned = await snapshot()
            now_ids = {c['key']:c['geometryId'] for c in returned['terrain']['cellResources'] if c['visible']}
            assert now_ids == initial_ids, (now_ids, initial_ids)
            assert returned['stream']['reused'] >= 3
            assert returned['stream']['bvhBuildCount'] == 1 + returned['stream']['installed']
            assert all(abs(s-1) < 1e-8 for s in returned['player']['scale'])
            assert not provider_requests
            report['return'] = returned['stream']
            report['checks'].append('native-reversal-restores-same-meshes-without-rebuilding-their-bvhs')
            # Hidden meshes must also follow floating-origin transforms.
            before = await snapshot()
            for _ in range(3):
                await page.click('#rebase')
            after = await snapshot()
            assert before['terrain']['geometryIds'] == after['terrain']['geometryIds']
            assert before['player']['state']['ecefPosition'] == after['player']['state']['ecefPosition']
            assert before['stream']['bvhBuildCount'] == after['stream']['bvhBuildCount']
            report['checks'].append('rebase-preserves-both-visible-and-recycled-resources')
            # Walk enough small cells to force real LRU eviction in the browser.
            await walk('ArrowUp', 130)
            far = await snapshot()
            assert far['stream']['evicted'] > 0, far['stream']
            assert len(far['stream']['recycledKeys']) <= 12
            assert far['stream']['cells'] <= 64
            assert far['stream']['residentPayloadBytes'] <= 32*1048576
            assert far['stream']['cacheBytes'] <= 16*1048576
            assert far['player']['activeColliderCount'] == 9
            assert far['player']['state']['grounded'] and far['player']['runtimeError'] is None
            assert set(far['stream']['pinnedKeys']).issubset(far['stream']['renderedKeys'])
            report['longerWalk'] = far['stream']
            report['checks'].append('real-cell-turnover-obeys-hot-cache-payload-and-residency-budgets')
            await page.screenshot(path=str(OUTPUT/'sliding-window-synthetic.png'))
            # At this point spawn is hidden. A rejected mode must preserve its reactivation hook.
            await page.click('#stream-toggle')
            await page.select_option('#stream-radius', 'normal')
            await page.click('#stream-toggle')
            assert not await page.evaluate('window.__ZERANA_STREAM_DEBUG__.active')
            assert 'choisis un niveau moins fin' in await page.inner_text('#stream-status')
            await page.click('#player-respawn')
            await page.keyboard.press('Escape')
            assert await page.evaluate('window.__ZERANA_PLAYER_DEBUG__.runtimeError') is None
            assert await page.evaluate('window.__ZERANA_PLAYER_DEBUG__.state.grounded')
            report['checks'].append('rejected-mode-preserves-presentation-and-safe-respawn')
            await page.select_option('#stream-radius', 'window')
            await page.click('#stream-toggle')
            await wait_window()
            respawn = await snapshot()
            assert respawn['player']['runtimeError'] is None and respawn['player']['state']['grounded']
            assert respawn['stream']['centerKey'] == initial['stream']['centerKey']
            report['checks'].append('hidden-pinned-spawn-is-reactivated-before-respawn')
            await page.click('#stream-toggle')
            stopped = await snapshot()
            await page.wait_for_timeout(600)
            assert stopped['terrain']['geometryIds'] == (await snapshot())['terrain']['geometryIds']
            assert stopped['stream']['workers']['created'] == stopped['stream']['workers']['terminated']
            report['checks'].append('stop-keeps-resident-world-and-terminates-workers')
            # Slow provider responses: retain the previous one-cell window until all nine are ready.
            await page.select_option('#level', '17')
            await page.select_option('#source-mode', 'mapbox')
            await page.fill('#mapbox-token', 'pk.sliding-fixture')
            await page.check('#allow-preview')
            await page.click('#build')
            await page.wait_for_function('!document.getElementById("build").disabled', timeout=60000)
            prior = await snapshot()
            assert prior['player']['available']
            await page.check('#stream-network-consent')
            state['delay'] = .25
            await page.click('#stream-toggle')
            await page.wait_for_function('window.__ZERANA_STREAM_DEBUG__.installed > 0 && window.__ZERANA_STREAM_DEBUG__.waitingForWindow', timeout=60000)
            pending = await snapshot()
            assert pending['stream']['shownKeys'] == prior['stream']['shownKeys']
            assert pending['player']['activeColliderCount'] == 1
            await wait_window()
            ready = await snapshot()
            assert ready['player']['altitudeAuthority'] == 'preview-only'
            assert ready['stream']['httpCharged'] <= 256
            assert ready['player']['activeColliderCount'] == 9
            assert ready['stream']['diskHits'] == 0
            report['checks'].append('slow-mocked-provider-retains-old-window-until-complete-and-keeps-datum-consent-quota')
            await page.click('#stream-toggle')
            assert not errors and not unexpected and not http_failures, (errors, unexpected, http_failures)
            report.update(success=True, pageErrors=errors, unexpectedRequests=unexpected, httpFailures=http_failures,
                          providerResponses='ALL_MOCKED', mockProviderRequests=len(provider_requests), commit=initial['terrain']['buildSha'])
        except Exception as error:
            report.update(success=False, failure=str(error), pageErrors=errors, unexpectedRequests=unexpected, httpFailures=http_failures)
            try:
                report['last'] = await snapshot()
                await page.screenshot(path=str(OUTPUT/'failure.png'))
            except Exception:
                pass
            raise
        finally:
            (OUTPUT/'summary.json').write_text(json.dumps(report, indent=2))
            await browser.close()
    print(json.dumps({'success': report['success'], 'checks': report['checks'], 'providerResponses': report['providerResponses']}))

if __name__ == '__main__':
    published = os.getenv('ZERANA_PREVIEW_URL')
    if published:
        asyncio.run(run(published))
    else:
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copytree(ROOT.parent/'dist', Path(tmp)/'Zerana')
            server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=tmp))
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                asyncio.run(run(f'http://127.0.0.1:{server.server_port}/Zerana/v2/'))
            finally:
                server.shutdown()
