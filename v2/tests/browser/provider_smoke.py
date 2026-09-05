"""Exercise the built HTTP subpath with mocked Mapbox responses. No real token/API spend.
Run from repository root: python v2/tests/browser/provider_smoke.py
ZERANA_DEMO_DIR / CHROMIUM_PATH are optional local test overrides.
"""
import asyncio
import functools
import http.server
import json
import math
import os
from pathlib import Path
import shutil
import struct
import tempfile
import threading
import zlib
from urllib.parse import urlsplit
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'browser-results' / 'raster'

def png(rgb):
    def chunk(kind, payload):
        return struct.pack('>I', len(payload)) + kind + payload + struct.pack('>I', zlib.crc32(kind + payload))
    row = b'\0' + bytes(rgb) * 256
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 256, 256, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(row * 256)) + chunk(b'IEND', b''))

def expected_ecef(height):
    # Independent analytic fixture for the fixed Paris test location.
    phi, lam = math.radians(48.86), math.radians(2.35)
    a, f = 6378137.0, 1 / 298.257223563
    e2 = f * (2 - f)
    n = a / math.sqrt(1 - e2 * math.sin(phi) ** 2)
    return ((n + height) * math.cos(phi) * math.cos(lam),
            (n + height) * math.cos(phi) * math.sin(lam),
            (n * (1 - e2) + height) * math.sin(phi))

def assert_marker_height(snapshot, height):
    marker = snapshot['markerEcef']
    actual = (marker['xMeters'], marker['yMeters'], marker['zMeters'])
    assert math.dist(actual, expected_ecef(height)) < 0.001, 'Native image decoding changed numeric elevation'

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

async def run(base_url):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    report = {'mode': 'MOCKED_PROVIDER_RESPONSES_NOT_LIVE_MAPBOX', 'scenarios': []}
    state = {'mode': 'ok', 'requests': [], 'retried': False}
    page_errors = []
    async with async_playwright() as p:
        options = {'headless': True, 'args': ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']}
        if os.environ.get('CHROMIUM_PATH'):
            options['executable_path'] = os.environ['CHROMIUM_PATH']
        browser = await p.chromium.launch(**options)
        page = await browser.new_page(viewport={'width': 1440, 'height': 980})
        page.on('pageerror', lambda err: page_errors.append(str(err)))
        async def route_provider(route):
            path = urlsplit(route.request.url).path
            state['requests'].append(path)  # Never retain query strings / credentials.
            is_metadata = path.endswith('.json')
            is_dem = 'terrain-rgb/' in path
            headers = {'access-control-allow-origin': '*'}
            if state['mode'] == 'auth':
                await route.fulfill(status=401, headers=headers, content_type='application/json', body='{"message":"Unauthorized"}')
                return
            if state['mode'] == 'slow':
                await asyncio.sleep(.8)
            if is_metadata:
                await route.fulfill(headers=headers, content_type='application/json', body=json.dumps({
                    'attribution': '© <a href="https://www.mapbox.com/">Mapbox</a> <img src=x onerror="window.bad=true">'
                }))
                return
            if is_dem and state['mode'] in ('missing', 'water'):
                message = 'Tile does not exist' if state['mode'] == 'water' else 'Tile not found'
                await route.fulfill(status=404, headers=headers, content_type='application/json', body=json.dumps({'message': message}))
                return
            if is_dem and state['mode'] == 'retry' and not state['retried']:
                state['retried'] = True
                await route.fulfill(status=429, headers={**headers, 'retry-after': '0.05'}, content_type='text/plain', body='retry')
                return
            if is_dem and state['mode'] == 'bad-image':
                await route.fulfill(headers=headers, content_type='text/html', body='<html>Not an image</html>')
                return
            # Known Mapbox sample h=407.2 m, encoded without any canvas ambiguity.
            data = png((1, 150, 136)) if is_dem else png((46, 123, 89))
            await route.fulfill(headers=headers, content_type='image/png', body=data)
        await page.route('https://api.mapbox.com/**', route_provider)
        await page.goto(base_url, wait_until='networkidle')
        await page.wait_for_function('document.body.dataset.ready === "1"')
        assert not state['requests'], 'Synthetic default must not request provider data'
        report['scenarios'].append('synthetic-default-no-provider-requests')
        await page.select_option('#source-mode', 'mapbox')
        await page.fill('#mapbox-token', 'pk.offline-fixture-token')
        await page.click('#build')
        await page.wait_for_function('!document.getElementById("build").disabled')
        assert 'VERTICAL_DATUM_UNRESOLVED' in await page.inner_text('#status')
        assert not state['requests']
        report['scenarios'].append('strict-datum-gate-before-network')
        await page.check('#allow-preview')
        await page.fill('#mapbox-token', 'sk.must-not-be-sent')
        await page.click('#build')
        await page.wait_for_function('!document.getElementById("build").disabled')
        assert not state['requests']
        report['scenarios'].append('secret-token-rejected-before-network')
        await page.fill('#mapbox-token', 'pk.offline-fixture-token')
        await page.select_option('#side', '3')
        async def load(mode='ok'):
            state['mode'] = mode
            previous = await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.revision')
            await page.click('#build')
            await page.wait_for_function('!document.getElementById("build").disabled', timeout=30000)
            return previous, await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__')
        before, snap = await load()
        assert snap['revision'] > before, await page.inner_text('#status')
        assert snap['cellCount'] == snap['texturedCells'] == 9
        assert_marker_height(snap, 407.2)
        assert snap['altitudeAuthority'] == 'preview-only'
        assert snap['providerReport']['verticalReference'] == 'UNRESOLVED_DATUM_PREVIEW'
        assert snap['providerReport']['elevationZoom'] == 15 and snap['providerReport']['imageryZoom'] == 17
        assert snap['seams']['mismatchedKeys'] == 0 and snap['seams']['maxGapMeters'] < .001
        assert len(snap['providerReport']['snapshotId']) == 64
        assert await page.locator('#provider-attribution img').count() == 0
        assert await page.evaluate('window.bad !== true')
        assert 'offline-fixture-token' not in json.dumps(snap)
        report['scenarios'].append('nine-textured-cells-png-decode-zoom-split-guarded-preview')
        report['sample'] = snap
        await page.evaluate('document.querySelector(".intro").textContent="TEST AUTOMATISÉ : tuiles PNG simulées, pas une capture de relief réel."')
        await page.screenshot(path=str(OUTPUT / 'provider-fixtures.png'))
        baseline_geometries = snap['geometries']
        for mode in ['auth', 'missing', 'bad-image']:
            before, failed = await load(mode)
            assert failed['revision'] == before
            assert failed['geometryIds'] == snap['geometryIds']
            report['scenarios'].append(mode + '-preserves-last-valid-scene')
        before, water = await load('water')
        assert water['revision'] > before and water['providerReport']['waterFallbackCount'] > 0
        assert water['altitudeAuthority'] == 'preview-only'
        assert_marker_height(water, 0.0)
        report['scenarios'].append('documented-water-404-only-explicit-fallback')
        state['retried'] = False
        before, retry = await load('retry')
        assert retry['revision'] > before and state['retried']
        report['scenarios'].append('429-bounded-retry')
        for _ in range(2):
            _, snap = await load()
            assert snap['geometries'] == baseline_geometries
        report['scenarios'].append('repeat-loads-no-geometry-growth-in-sampled-cycles')
        state['mode'] = 'slow'
        before = await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.revision')
        await page.click('#build')
        await page.click('#cancel-load')
        await page.wait_for_function('!document.getElementById("build").disabled')
        await page.wait_for_timeout(1200)
        assert await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.revision') == before
        assert 'annulé' in await page.inner_text('#status')
        report['scenarios'].append('cancel-rejects-late-results-and-retains-scene')
        assert await page.evaluate('localStorage.length + sessionStorage.length') == 0
        assert not page_errors, page_errors
        report['pageErrors'] = page_errors
        report['requestCountIncludingMocks'] = len(state['requests'])
        (OUTPUT / 'summary.json').write_text(json.dumps(report, indent=2))
        await browser.close()
    print(json.dumps({'scenarios': report['scenarios'], 'pageErrors': page_errors}, indent=2))

if __name__ == '__main__':
    source = Path(os.environ.get('ZERANA_DEMO_DIR', ROOT / 'demo-dist'))
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / 'Zerana' / 'v2'
        shutil.copytree(source, target)
        handler = functools.partial(QuietHandler, directory=tmp)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            asyncio.run(run(f'http://127.0.0.1:{server.server_port}/Zerana/v2/'))
        finally:
            server.shutdown()
