"""Automatic lab UX, staged colliders, progressive imagery and bounded walking.

Default: intercept all provider requests with deterministic fixtures. Live mode is
an explicit release opt-in, limits actual Mapbox requests and never logs a token.
"""
import asyncio
import functools
import hashlib
import http.server
import json
import math
import os
from pathlib import Path
import shutil
import tempfile
import threading
import time
from urllib.parse import urlsplit, parse_qs, urlencode, urlunsplit
from playwright.async_api import async_playwright
from provider_smoke import png, QuietHandler
from roads_smoke import mvt

ROOT = Path(__file__).resolve().parents[2]
LIVE = os.getenv('ZERANA_LIVE_STREAM') == '1'
OUTPUT = ROOT / 'browser-results' / ('experience-live' if LIVE else 'experience')
MAX_LIVE_REQUESTS = 96


def query(url, **values):
    p = urlsplit(url)
    q = {k: v[-1] for k, v in parse_qs(p.query).items()}
    q.update(values)
    return urlunsplit((p.scheme, p.netloc, p.path, urlencode(q), p.fragment))


async def walk(page, key, distance, timeout=60000):
    begin = await page.evaluate('window.__ZERANA_PLAYER_DEBUG__.state.ecefPosition')
    await page.keyboard.down('ShiftLeft')
    await page.keyboard.down(key)
    try:
        await page.wait_for_function('''args => { const s=window.__ZERANA_PLAYER_DEBUG__;
          if(s.runtimeError) throw Error(s.runtimeError);
          const p=s.state.ecefPosition,a=args.start;
          return Math.hypot(p.xMeters-a.xMeters,p.yMeters-a.yMeters,p.zMeters-a.zMeters)>args.distance;
        }''', arg={'start': begin, 'distance': distance}, timeout=timeout)
    finally:
        await page.keyboard.up(key)
        await page.keyboard.up('ShiftLeft')


async def run(url):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    report = {'mode': 'LIVE_MAPBOX_EXPERIENCE' if LIVE else 'MOCKED_AUTOMATIC_EXPERIENCE', 'checks': []}
    errors, http_errors, unexpected, requests, worker_paths = [], [], [], [], []
    state = {'block_images': False, 'forbid_provider': False}
    gate = asyncio.Event()
    gate.set()
    async with async_playwright() as p:
        options = {'headless': True, 'args': ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-precise-memory-info']}
        if os.getenv('CHROMIUM_PATH'):
            options['executable_path'] = os.environ['CHROMIUM_PATH']
        browser = await p.chromium.launch(**options)
        context = await browser.new_context(viewport={'width': 1440, 'height': 1000}, service_workers='block')
        page = await context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        async def route_request(route):
            parts = urlsplit(route.request.url)
            if parts.hostname == 'api.mapbox.com':
                if state['forbid_provider']:
                    unexpected.append('provider-in-synthetic-mode')
                    await route.abort()
                    return
                if LIVE:
                    if len(requests) >= MAX_LIVE_REQUESTS:
                        unexpected.append('live-request-cap-reached')
                        await route.abort()
                        return
                    expected_token = os.getenv('ZERANA_EXPECTED_TOKEN_SHA256')
                    token = parse_qs(parts.query).get('access_token', [''])[0]
                    if expected_token and hashlib.sha256(token.encode()).hexdigest() != expected_token:
                        unexpected.append('configured-token-fingerprint-mismatch')
                        await route.abort()
                        return
                requests.append(parts.path)  # Never retain the query / access token.
                if LIVE:
                    await route.continue_()
                    return
                try:
                    if state['block_images'] and 'mapbox.satellite/' in parts.path:
                        await asyncio.wait_for(gate.wait(), 40)
                    if parts.path.endswith('.json'):
                        credit = '© <a href="https://www.mapbox.com/about/maps">Mapbox</a> <a href="https://www.mapbox.com/contribute/">Improve this map</a> '
                        credit += '© <a href="https://www.openstreetmap.org/copyright/">OpenStreetMap</a> © <a href="https://www.maxar.com/">Maxar</a>'
                        await route.fulfill(content_type='application/json', body=json.dumps({'attribution': credit,'scheme':'xyz','maxzoom':16,'modified':123,'vector_layers':[{'id':'road'}]}), headers={'access-control-allow-origin': '*'})
                    elif 'mapbox.mapbox-streets-v8/' in parts.path:
                        await route.fulfill(content_type='application/x-protobuf',body=mvt(),headers={'access-control-allow-origin':'*'})
                    else:
                        await route.fulfill(content_type='image/png', body=png((1,150,136) if 'terrain-rgb/' in parts.path else (70,130,100)), headers={'access-control-allow-origin': '*'})
                except Exception:
                    pass  # An intentional worker cancellation can precede the response.
                return
            if parts.netloc != urlsplit(url).netloc:
                unexpected.append(parts.hostname)
                await route.abort()
                return
            if 'terrain.worker-' in parts.path:
                worker_paths.append(parts.path)
            await route.continue_()
        await context.route('**/*', route_request)
        page.on('response', lambda r: http_errors.append({'status': r.status, 'path': urlsplit(r.url).path}) if r.status >= 400 else None)
        try:
            await page.goto(query(url, level='19'), wait_until='domcontentloaded')
            await page.wait_for_function('window.__ZERANA_PLAYER_DEBUG__?.active && window.__ZERANA_STREAM_DEBUG__?.active', timeout=60000)
            expected = os.getenv('ZERANA_EXPECTED_SHA')
            if expected:
                assert await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.buildSha') == expected
            report['commit'] = await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.buildSha')
            assert await page.input_value('#source-mode') == 'mapbox'
            assert not await page.locator('#world-options').evaluate('(e)=>e.open')
            assert not await page.locator('#diagnostics').evaluate('(e)=>e.open')
            assert not await page.locator('#player-toggle').is_visible()
            assert not await page.locator('#stream-toggle').is_visible()
            report['checks'].append('site-token-default-mapbox-automatic-stream-and-player-collapsed-tools')
            if not LIVE:
                state['block_images'] = True
                gate.clear()
            await page.wait_for_function('window.__ZERANA_STREAM_DEBUG__.preparedBvhAdoptions>=8 && !window.__ZERANA_STREAM_DEBUG__.waitingForWindow', timeout=60000)
            stream = await page.evaluate('window.__ZERANA_STREAM_DEBUG__')
            assert stream['mainThreadBvhBuildCount'] == 1, stream
            assert stream['preparedBvhAdoptions'] >= 8 and worker_paths
            if not LIVE:
                assert stream['imageryInstalled'] == 0, stream
                report['checks'].append('terrain-and-collision-ready-while-imagery-deliberately-delayed')
                state['block_images'] = False
                gate.set()
            await page.wait_for_function('window.__ZERANA_STREAM_DEBUG__.imageryInstalled>=1', timeout=60000)
            report['checks'].append('new-cell-bvhs-built-in-worker-validated-and-adopted')
            # Direct keyboard input, no click on a walk/start button.
            await walk(page, 'ArrowUp', 6)
            await page.keyboard.press('Escape')
            assert not await page.evaluate('window.__ZERANA_PLAYER_DEBUG__.active')
            await walk(page, 'ArrowUp', 6)
            assert await page.evaluate('window.__ZERANA_PLAYER_DEBUG__.active')
            report['checks'].append('walk-and-keyboard-resume-without-walk-button')
            labels = await page.locator('#provider-attribution a').all_text_contents()
            for label in ['© Mapbox', '© OpenStreetMap', '© Maxar', 'Improve this map']:
                assert labels.count(label) == 1, labels
            assert await page.locator('#attribution .mapbox-logo img').count() == 1
            assert await page.locator('#attribution').is_visible()
            report['checks'].append('single-visible-legible-provider-credit-strip-no-duplicates')
            # Keep every assertion on real input and served runtime diagnostics.
            await walk(page, 'ArrowUp', 60, timeout=90000)
            await page.keyboard.press('Escape')
            stream = await page.evaluate('window.__ZERANA_STREAM_DEBUG__')
            player = await page.evaluate('window.__ZERANA_PLAYER_DEBUG__')
            assert player['state']['grounded'] and player['runtimeError'] is None
            assert stream['preparedBvhAdoptions'] > 8 and stream['mainThreadBvhBuildCount'] == 1
            assert stream['httpCharged'] <= stream['httpLimit'] and stream['residentPayloadBytes'] <= stream['maxResidentPayloadBytes']
            report['stream'] = stream
            report['checks'].append('walking-real-cells-with-progressive-images-and-bounded-quota')
            await page.screenshot(path=str(OUTPUT/'experience.png'))
            if not LIVE:
                # Independent non-network soak. Force-GC probes are for retention
                # analysis only; they are not included in performance comparisons.
                await page.goto(query(url, source='synthetic', level='19'), wait_until='domcontentloaded')
                await page.wait_for_function('window.__ZERANA_STREAM_DEBUG__?.active && !window.__ZERANA_STREAM_DEBUG__?.waitingForWindow && window.__ZERANA_PLAYER_DEBUG__?.active', timeout=45000)
                state['forbid_provider'] = True
                cdp = await context.new_cdp_session(page)
                seconds = int(os.getenv('ZERANA_SOAK_SECONDS', '120'))
                assert 30 <= seconds <= 300
                samples = []
                start = time.monotonic()
                for segment in range(4):
                    key = 'ArrowUp' if segment % 2 == 0 else 'ArrowDown'
                    await page.keyboard.down('ShiftLeft'); await page.keyboard.down(key)
                    await page.wait_for_timeout(seconds*1000/4)
                    await page.keyboard.up(key); await page.keyboard.up('ShiftLeft')
                    await cdp.send('HeapProfiler.collectGarbage')
                    heap = await cdp.send('Runtime.getHeapUsage')
                    stream = await page.evaluate('window.__ZERANA_STREAM_DEBUG__')
                    player = await page.evaluate('window.__ZERANA_PLAYER_DEBUG__')
                    assert player['runtimeError'] is None and player['state']['grounded']
                    assert stream['active'] and stream['cells'] <= 64
                    assert stream['trackedResidentKeys'] <= stream['cells']
                    assert stream['residentPayloadBytes'] <= 32*1048576 and stream['cacheBytes'] <= 16*1048576
                    assert stream['mainThreadBvhBuildCount'] == 1
                    samples.append({'wallSeconds': time.monotonic()-start, 'heapAfterGC': heap, 'stream': stream})
                assert samples[-1]['heapAfterGC']['usedSize'] <= samples[0]['heapAfterGC']['usedSize']*1.75 + 16*1048576
                report['soak'] = {'wallSeconds': time.monotonic()-start, 'samples': samples, 'scope': 'bounded two-minute browser sample, not a multi-hour heap/VRAM proof'}
                report['checks'].append('timed-synthetic-out-and-back-soak-with-bounded-residency-and-post-gc-probes')
                await page.keyboard.press('Escape')
            assert not errors, errors
            assert not http_errors, http_errors
            assert not unexpected, unexpected
            report.update({'success': True, 'pageErrors': errors, 'httpFailures': http_errors,
                'unexpectedRequests': unexpected, 'providerRequests': len(requests),
                'providerResponses': 'REAL_BOUNDED' if LIVE else 'ALL_MOCKED'})
        except Exception as error:
            report.update({'success': False, 'failure': str(error), 'pageErrors': errors,
                'httpFailures': http_errors, 'unexpectedRequests': unexpected, 'providerRequests': len(requests)})
            try:
                report['lastStream'] = await page.evaluate('window.__ZERANA_STREAM_DEBUG__')
                report['lastPlayer'] = await page.evaluate('window.__ZERANA_PLAYER_DEBUG__')
                await page.screenshot(path=str(OUTPUT/'failure.png'))
            except Exception:
                pass
            raise
        finally:
            gate.set()
            (OUTPUT/'summary.json').write_text(json.dumps(report, indent=2))
            await browser.close()
    print(json.dumps({'success': report['success'], 'checks': report['checks'], 'providerResponses': report['providerResponses'], 'providerRequests': len(requests)}))


if __name__ == '__main__':
    published = os.getenv('ZERANA_PREVIEW_URL')
    if published:
        asyncio.run(run(published))
    else:
        assert not LIVE, 'Live tests run only on the deployed domain'
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copytree(ROOT.parent/'dist', Path(tmp)/'Zerana')
            server = http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(QuietHandler,directory=tmp))
            threading.Thread(target=server.serve_forever,daemon=True).start()
            try:
                asyncio.run(run(f'http://127.0.0.1:{server.server_port}/Zerana/v2/'))
            finally:
                server.shutdown()
