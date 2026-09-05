"""Serve the built demo under its real Pages prefix; no external requests allowed.

This is a Chromium/SwiftShader smoke test, not a hardware performance benchmark.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from urllib.parse import urlparse
import json
import math
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'browser-results'
OUTPUT.mkdir(exist_ok=True)
assert (ROOT / 'demo-dist/index.html').is_file(), 'Build the demo before running this test'

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

with TemporaryDirectory() as folder:
    serving = Path(folder)
    (serving / 'Zerana').mkdir()
    (serving / 'Zerana/v2').symlink_to(ROOT / 'demo-dist', target_is_directory=True)
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=folder))
    Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    observations, errors, external_requests, bad_responses = [], [], [], []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, args=[
                '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'])
            page = browser.new_page(viewport={'width':1440, 'height':1000}, device_scale_factor=1)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
            page.on('response', lambda response: bad_responses.append([response.url,response.status]) if response.status >= 400 else None)
            def allow_local(route):
                if urlparse(route.request.url).hostname == '127.0.0.1':
                    route.continue_()
                else:
                    external_requests.append(route.request.url)
                    route.abort()
            page.route('**/*', allow_local)
            page.goto(origin + '/Zerana/v2/?lab=manual', wait_until='networkidle')
            page.wait_for_function('Number(document.body.dataset.ready) >= 1', timeout=30000)
            def snapshot():
                return page.evaluate('window.__ZERANA_TERRAIN_DEBUG__')
            def build():
                before = snapshot()['revision']
                page.locator('#build').click()
                page.wait_for_function('(revision) => Number(document.body.dataset.ready) > revision', arg=before, timeout=30000)
                assert not page.locator('#status').evaluate('(el) => el.classList.contains("error")')
                value = snapshot()
                assert value['drawCalls'] > 0, 'Nothing was drawn'
                assert value['markerHeightMeters'] == 1.8
                assert value['seams']['mismatchedKeys'] == 0
                assert value['seams']['maxGapMeters'] < 0.001
                return value
            assert snapshot()['cellCount'] == 1
            page.screenshot(path=str(OUTPUT/'01-single-cell.png'))
            for side in ['2','3']:
                page.locator('#side').select_option(side)
                value = build()
                assert value['cellCount'] == int(side)**2
                assert value['seams']['edgePairs'] == 2*int(side)*(int(side)-1)
                observations.append(value)
            page.screenshot(path=str(OUTPUT/'02-nine-cells.png'))
            # Repeated disposal: compare exact geometry/texture counts for the same scene.
            baseline = snapshot()
            for side in ['1','3'] * 6:
                page.locator('#side').select_option(side)
                value = build()
                if side == '3':
                    assert value['geometries'] == baseline['geometries'], 'Geometry count grew'
                    assert value['textures'] == baseline['textures'], 'Texture count grew'
            for place in ['equator','antimeridian','north','tanger','tokyo']:
                page.locator('#place').select_option(place)
                observations.append(build())
            page.locator('#place').select_option('antimeridian')
            build()
            page.locator('#normals').check()
            page.screenshot(path=str(OUTPUT/'03-antimeridian-normals.png'))
            page.locator('#normals').uncheck()
            page.locator('#human').click()
            page.screenshot(path=str(OUTPUT/'04-human-scale.png'))
            before = snapshot()
            for _ in range(4):
                page.locator('#rebase').click()
            after = snapshot()
            assert after['rebases'] == 4
            assert after['markerEcef'] == before['markerEcef']
            assert after['geometryIds'] == before['geometryIds'], 'Rebase rebuilt geometry'
            assert after['bufferFirstVertices'] == before['bufferFirstVertices']
            assert math.dist(after['markerNdc'], before['markerNdc']) < 1e-5, 'Visible camera jump during rebase'
            page.screenshot(path=str(OUTPUT/'05-after-rebase.png'))
            # Coverage errors must be explicit and keep the last good scene.
            page.locator('#latitude').fill('90')
            page.locator('#build').click()
            page.wait_for_function('document.getElementById("status").classList.contains("error")')
            assert snapshot()['revision'] == after['revision']
            page.locator('#place').select_option('paris')
            page.locator('#profile').select_option('flat')
            build()
            assert not errors, errors
            assert not external_requests, external_requests
            assert not bad_responses, bad_responses
            (OUTPUT/'summary.json').write_text(json.dumps({
                'result':'passed', 'browser':'Chromium / SwiftShader',
                'scope':'static synthetic terrain; not streaming, DEM or physical GPU benchmark',
                'externalRequests':external_requests, 'pageErrors':errors, 'httpErrors':bad_responses,
                'observations':observations, 'afterRebase':after,
            }, indent=2)+'\n')
            browser.close()
            print('Browser smoke PASS: 1/4/9 cells, Pages paths, six locations, disposal cycles, rebase, coverage rejection')
    finally:
        (OUTPUT/'errors.json').write_text(json.dumps({'pageErrors':errors, 'externalRequests':external_requests, 'httpErrors':bad_responses},indent=2)+'\n')
        server.shutdown()
