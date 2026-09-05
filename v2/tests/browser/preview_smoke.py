"""Verify the combined Pages site, optionally against live Mapbox.
Default: local HTTP and NO Mapbox calls. ZERANA_MOCK_MAPBOX=1 uses PNG fixtures.
Live: ZERANA_PREVIEW_URL=https://amir-afkir.github.io/Zerana/v2/
      ZERANA_LIVE_MAPBOX=1; at most 48 provider attempts, one Paris patch.
No HAR/traces, raw URLs, credentials, provider response bodies or console text are saved.
"""
import asyncio
import functools
import hashlib
import http.server
import json
import math
import os
from pathlib import Path
import re
import shutil
import tempfile
import threading
from urllib.parse import urlsplit
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[3]
OUTPUT = ROOT / 'v2' / 'browser-results' / 'preview'
MAX_PROVIDER_ATTEMPTS = 48

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

def require(condition, code):
    if not condition:
        raise RuntimeError(code)

async def run(preview_url):
    live = os.environ.get('ZERANA_LIVE_MAPBOX') == '1'
    mocked = os.environ.get('ZERANA_MOCK_MAPBOX') == '1'
    require(not (live and mocked), 'CONFLICTING_TEST_MODES')
    expected = os.environ.get('ZERANA_EXPECTED_SHA', '')
    origin = urlsplit(preview_url)
    require(origin.path == '/Zerana/v2/', 'INVALID_PREVIEW_PATH')
    if live:
        require(origin.scheme == 'https' and origin.netloc == 'amir-afkir.github.io', 'LIVE_TEST_REQUIRES_PAGES_ORIGIN')
    site_url = f'{origin.scheme}://{origin.netloc}/Zerana/'
    report = {'mode': 'LIVE_MAPBOX' if live else 'MOCKED_MAPBOX' if mocked else 'NO_PROVIDER',
              'providerAttemptLimit': MAX_PROVIDER_ATTEMPTS, 'checks': [], 'providerAttempts': 0,
              'pageErrorCount': 0, 'unexpectedRequestCount': 0, 'httpFailureCount': 0}
    OUTPUT.mkdir(parents=True, exist_ok=True)
    try:
        async with async_playwright() as p:
            options = {'headless': True, 'args': ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']}
            if os.environ.get('CHROMIUM_PATH'):
                options['executable_path'] = os.environ['CHROMIUM_PATH']
            browser = await p.chromium.launch(**options)
            context = await browser.new_context(viewport={'width': 1440, 'height': 980}, service_workers='block')
            page = await context.new_page()
            page.on('pageerror', lambda _: report.update(pageErrorCount=report['pageErrorCount'] + 1))
            permitted_provider = False
            async def route_request(route):
                target = urlsplit(route.request.url)
                if target.scheme in ('data', 'blob') or (target.scheme, target.netloc) == (origin.scheme, origin.netloc):
                    await route.continue_()
                    return
                if target.scheme == 'https' and target.netloc == 'api.mapbox.com' and permitted_provider:
                    report['providerAttempts'] += 1
                    if report['providerAttempts'] > MAX_PROVIDER_ATTEMPTS:
                        await route.abort()
                        return
                    if mocked:
                        from provider_smoke import png
                        if target.path.endswith('.json'):
                            await route.fulfill(headers={'access-control-allow-origin': '*'}, content_type='application/json', body=json.dumps({'attribution': '© Mapbox · données de test'}))
                        else:
                            dem = '/mapbox.terrain-rgb/' in target.path
                            await route.fulfill(headers={'access-control-allow-origin': '*'}, content_type='image/png', body=png((1, 150, 136) if dem else (46, 123, 89)))
                    else:
                        await route.continue_()
                    return
                report['unexpectedRequestCount'] += 1
                await route.abort()
            await context.route('**/*', route_request)
            def response_seen(response):
                if response.status >= 400:
                    report['httpFailureCount'] += 1
            page.on('response', response_seen)

            # Retries concern CDN propagation only; never retry the live provider scenario.
            manifest = None
            for _ in range(12):
                response = await context.request.get(site_url + 'deployment-manifest.json', headers={'Cache-Control': 'no-cache'})
                if response.ok:
                    candidate = await response.json()
                    if not expected or candidate.get('commit') == expected:
                        manifest = candidate
                        break
                await asyncio.sleep(5)
            require(manifest is not None, 'DEPLOYED_COMMIT_NOT_VISIBLE')
            require(manifest['legacyCommit'] == '0e06c350b6c3d07699600e0003609790d60661c4', 'LEGACY_IDENTITY_CHANGED')
            require(manifest['previewPrefix'] == '/Zerana/v2/', 'PREVIEW_IDENTITY_INVALID')
            report['commit'] = manifest['commit']
            info_response = await context.request.get(preview_url + 'build-info.json')
            require(info_response.ok, 'BUILD_INFO_UNAVAILABLE')
            info = await info_response.json()
            require(info['commit'] == manifest['commit'], 'MIXED_SITE_VERSIONS')
            for name in ['index.html', 'v2/index.html', 'models/DefaultAvatarPC.glb']:
                response = await context.request.get(site_url + name)
                require(response.ok, 'SITE_RESOURCE_MISSING')
                digest = hashlib.sha256(await response.body()).hexdigest()
                require(digest == manifest['files'][name], 'DEPLOYED_RESOURCE_HASH_MISMATCH')
            report['checks'].append('both-entrypoints-and-legacy-avatar-match-built-hashes')

            response = await page.goto(site_url, wait_until='networkidle')
            require(response is not None and response.ok, 'LEGACY_ROUTE_UNAVAILABLE')
            require(await page.locator('#root form').count() == 1, 'LEGACY_ADDRESS_FORM_NOT_RENDERED')
            require(report['pageErrorCount'] == 0, 'LEGACY_JAVASCRIPT_ERROR')
            report['checks'].append('legacy-address-form-renders')
            await page.goto(preview_url + ('&' if '?' in preview_url else '?') + 'lab=manual', wait_until='networkidle')
            await page.wait_for_function('document.body.dataset.ready === "1"')
            snap = await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__')
            require(snap['buildSha'] == manifest['commit'], 'STALE_PREVIEW_JAVASCRIPT')
            require(report['providerAttempts'] == report['unexpectedRequestCount'] == 0, 'DEFAULT_MADE_EXTERNAL_REQUESTS')
            require(snap['providerReport'] is None, 'DEFAULT_MUST_BE_SYNTHETIC')
            require(await page.locator('.preview-nav a').get_attribute('href') == '../', 'RETURN_LINK_INVALID')
            report['checks'].append('synthetic-default-no-provider-even-with-site-token')
            await page.select_option('#side', '3')
            await page.click('#build')
            await page.wait_for_function('document.body.dataset.ready === "2"')
            snap = await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__')
            require(snap['cellCount'] == 9 and snap['seams']['edgePairs'] == 12, 'SYNTHETIC_GRID_INVALID')
            require(snap['seams']['maxGapMeters'] < .001, 'SYNTHETIC_SEAM_ERROR')
            report['checks'].append('nine-synthetic-cells-on-published-prefix')
            await page.screenshot(path=str(OUTPUT / 'preview-synthetic.png'))

            if live or mocked:
                # No token is written to the input: this exercises the compiled public-site fallback.
                require(snap['siteTokenConfigured'], 'PUBLIC_SITE_TOKEN_NOT_CONFIGURED')
                await page.select_option('#source-mode', 'mapbox')
                require(await page.input_value('#mapbox-token') == '', 'CREDENTIAL_INPUT_NOT_EMPTY')
                await page.click('#build')
                await page.wait_for_function('!document.getElementById("build").disabled')
                require('VERTICAL_DATUM_UNRESOLVED' in await page.inner_text('#status'), 'DATUM_GATE_MISSING')
                require(report['providerAttempts'] == 0, 'DATUM_GATE_SENT_NETWORK_REQUESTS')
                report['checks'].append('unresolved-datum-gate-before-provider-access')
                await page.check('#allow-preview')
                permitted_provider = True
                await page.click('#build')
                await page.wait_for_function('!document.getElementById("build").disabled', timeout=90000)
                snap = await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__')
                if not snap.get('providerReport'):
                    # Retain only an allowlisted error code, never arbitrary DOM/error text.
                    status = await page.inner_text('#status')
                    match = re.search(r'\b(?:PROVIDER_[A-Z_]+|VERTICAL_DATUM_UNRESOLVED|PUBLIC_MAPBOX_TOKEN_REQUIRED)\b', status)
                    report['providerFailure'] = match.group(0) if match else 'PROVIDER_LOAD_FAILED'
                    raise RuntimeError('PROVIDER_LIVE_OR_FIXTURE_CHECK_FAILED')
                require(0 < report['providerAttempts'] <= MAX_PROVIDER_ATTEMPTS, 'PROVIDER_BUDGET_EXCEEDED')
                require(snap['cellCount'] == snap['texturedCells'] == 9, 'TEXTURED_PATCH_INCOMPLETE')
                require(snap['altitudeAuthority'] == 'preview-only', 'UNCERTIFIED_HEIGHT_PROMOTED')
                require(snap['providerReport']['verticalReference'] == 'UNRESOLVED_DATUM_PREVIEW', 'VERTICAL_LABEL_MISSING')
                require(snap['seams']['mismatchedKeys'] == 0 and snap['seams']['maxGapMeters'] < .001, 'RASTER_SEAMS_INVALID')
                require(await page.locator('#provider-attribution').inner_text(), 'ATTRIBUTION_MISSING')
                before = snap
                await page.click('#rebase')
                after = await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__')
                require(after['geometryIds'] == before['geometryIds'], 'REBASE_REBUILT_GEOMETRY')
                require(after['markerEcef'] == before['markerEcef'], 'REBASE_MOVED_GEOGRAPHIC_MARKER')
                require(math.dist(after['markerNdc'], before['markerNdc']) < 1e-5, 'REBASE_MOVED_SCREEN_MARKER')
                require(await page.evaluate('localStorage.length + sessionStorage.length') == 0, 'UNEXPECTED_CREDENTIAL_STORAGE')
                # Only permit safe diagnostics selected field by field.
                report['sample'] = {key: snap[key] for key in ['cellCount', 'texturedCells', 'altitudeAuthority', 'seams', 'markerHeightMeters']}
                report['sample']['snapshotId'] = snap['providerReport']['snapshotId']
                report['sample']['evidence'] = snap['providerReport']['evidence']
                report['sample']['elevationZoom'] = snap['providerReport']['elevationZoom']
                report['sample']['imageryZoom'] = snap['providerReport']['imageryZoom']
                report['checks'].append('nine-textured-cells-site-token-and-rebase')
                label = 'TEST LIVE : vraies tuiles Mapbox, altitude non certifiée.' if live else 'TEST SIMULÉ : PNG de contrôle, pas du relief réel.'
                await page.locator('.intro').evaluate('(element, text) => element.textContent = text', label)
                await page.screenshot(path=str(OUTPUT / ('preview-live-mapbox.png' if live else 'preview-fixtures.png')))
            require(report['pageErrorCount'] == 0, 'UNHANDLED_JAVASCRIPT_ERRORS')
            require(report['unexpectedRequestCount'] == 0, 'UNEXPECTED_EXTERNAL_REQUESTS')
            require(report['httpFailureCount'] == 0, 'HTTP_ERRORS_OBSERVED')
            report['success'] = True
            await browser.close()
    except Exception as error:
        report['success'] = False
        # Exception type is sufficient; Playwright exception messages may include URLs/credentials.
        report['failureType'] = type(error).__name__
        if isinstance(error, RuntimeError) and re.fullmatch(r'[A-Z_]+', str(error)):
            report['failureCode'] = str(error)
    finally:
        (OUTPUT / 'summary.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, indent=2))
    return report['success']

if __name__ == '__main__':
    url = os.environ.get('ZERANA_PREVIEW_URL')
    if url:
        success = asyncio.run(run(url))
    else:
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copytree(ROOT / 'dist', Path(tmp) / 'Zerana')
            handler = functools.partial(QuietHandler, directory=tmp)
            server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                success = asyncio.run(run(f'http://127.0.0.1:{server.server_port}/Zerana/v2/'))
            finally:
                server.shutdown()
    raise SystemExit(0 if success else 1)
