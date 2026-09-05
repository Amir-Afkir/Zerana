"""Exercise actual keyboard input and the metric player on the built Pages subpath.
No Mapbox calls. Set ZERANA_PLAYER_URL for the deployed synthetic preview.
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

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'browser-results' / 'player'

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

def xyz(state):
    p = state['state']['ecefPosition']
    return [p['xMeters'], p['yMeters'], p['zMeters']]

async def run(url):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    report = {'mode': 'PUBLISHED_SYNTHETIC' if os.environ.get('ZERANA_PLAYER_URL') else 'BUILT_SYNTHETIC',
              'scenarios': [], 'pageErrors': [], 'httpErrors': [], 'externalRequests': []}
    async with async_playwright() as p:
        opts = {'headless': True, 'args': ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']}
        if os.environ.get('CHROMIUM_PATH'):
            opts['executable_path'] = os.environ['CHROMIUM_PATH']
        browser = await p.chromium.launch(**opts)
        page = await browser.new_page(viewport={'width': 1440, 'height': 1100})
        page.on('pageerror', lambda error: report['pageErrors'].append(str(error)))
        page.on('response', lambda response: report['httpErrors'].append({'path': urlsplit(response.url).path, 'status': response.status}) if response.status >= 400 else None)
        origin = urlsplit(url).netloc
        async def route(request):
            target = urlsplit(request.request.url)
            if target.scheme in ('http', 'https') and target.netloc != origin:
                report['externalRequests'].append(target.netloc + target.path)
                await request.abort()
            else:
                await request.continue_()
        await page.route('**/*', route)
        async def snapshot():
            return await page.evaluate('window.__ZERANA_PLAYER_DEBUG__')
        async def steps(count):
            before = (await snapshot())['steps']
            await page.wait_for_function('(n) => window.__ZERANA_PLAYER_DEBUG__.steps >= n', arg=before+count, timeout=45000)
        async def build():
            previous = await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.revision')
            await page.click('#build')
            await page.wait_for_function('(n) => window.__ZERANA_TERRAIN_DEBUG__.revision > n && !document.getElementById("build").disabled', arg=previous, timeout=45000)
            assert (await snapshot())['available'], await page.inner_text('#player-status')
        try:
            await page.goto(url, wait_until='networkidle')
            await page.wait_for_function('document.body.dataset.ready === "1"')
            if os.environ.get('ZERANA_EXPECTED_SHA'):
                assert await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.buildSha') == os.environ['ZERANA_EXPECTED_SHA']
            await page.select_option('#side', '3')
            await build()
            assert (await snapshot())['active'] is False
            report['scenarios'].append('no-automatic-movement-or-provider-request')
            await page.uncheck('#wireframe')
            await page.click('#player-toggle')
            start = await snapshot()
            assert start['active'] and start['state']['grounded']
            assert start['heightMeters'] == 1.8 and start['radiusMeters'] == .3
            assert all(abs(v-1) < 1e-10 for v in start['scale'])
            await page.keyboard.down('ArrowRight')
            await steps(45)
            await page.keyboard.up('ArrowRight')
            walked = await snapshot()
            assert 2 < math.dist(xyz(start), xyz(walked)) < 8
            assert walked['state']['grounded']
            report['scenarios'].append('native-keyboard-movement-ground-contact-and-fixed-scale')
            await page.keyboard.down('Space')
            await page.wait_for_function('!window.__ZERANA_PLAYER_DEBUG__.state.grounded')
            await steps(20)
            airborne = await snapshot()
            phi, lam = math.radians(48.86), math.radians(2.35)
            up = [math.cos(phi)*math.cos(lam), math.cos(phi)*math.sin(lam), math.sin(phi)]
            rise = sum((a-b)*n for a, b, n in zip(xyz(airborne), xyz(walked), up))
            assert rise > .4, rise
            await page.keyboard.up('Space')
            await page.wait_for_function('window.__ZERANA_PLAYER_DEBUG__.state.grounded', timeout=15000)
            report['scenarios'].append('jump-and-grounded-landing')
            canvas = await page.locator('#viewport canvas').bounding_box()
            heading = (await snapshot())['state']['headingRad']
            x, y = canvas['x']+canvas['width']*.55, canvas['y']+canvas['height']*.45
            await page.mouse.move(x, y)
            await page.mouse.down()
            await page.mouse.move(x+75, y+15, steps=5)
            await page.mouse.up()
            await steps(2)
            assert abs((await snapshot())['state']['headingRad']-heading) > .1
            report['scenarios'].append('drag-to-look-camera')
            await page.select_option('#player-threshold', '32')
            await page.locator('#viewport canvas').focus()
            await page.keyboard.down('Shift')
            await page.keyboard.down('ArrowUp')
            await steps(320)
            await page.keyboard.up('ArrowUp')
            await page.keyboard.up('Shift')
            moved = await snapshot()
            assert moved['rebases'] >= 1
            assert moved['runtimeError'] is None and all(abs(v-1) < 1e-10 for v in moved['scale'])
            report['scenarios'].append('automatic-rebase-while-moving')
            await page.keyboard.press('Escape')
            await page.wait_for_timeout(150)
            before = await snapshot()
            geometry_ids = await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.geometryIds')
            await page.screenshot(path=str(OUTPUT / 'player-before-rebase.png'))
            for _ in range(4):
                await page.click('#rebase')
            after = await snapshot()
            report['beforeRebase'] = before
            report['afterRebase'] = after
            await page.screenshot(path=str(OUTPUT / 'player-after-rebase.png'))
            assert xyz(before) == xyz(after)
            assert before['state']['velocityEcefMetersPerSecond'] == after['state']['velocityEcefMetersPerSecond']
            assert math.dist(before['footNdc'], after['footNdc']) < 1e-6
            assert math.dist(list(before['cameraEcef'].values()), list(after['cameraEcef'].values())) < 1e-6
            assert before['geometryId'] == after['geometryId']
            assert geometry_ids == await page.evaluate('window.__ZERANA_TERRAIN_DEBUG__.geometryIds')
            assert after['triangleCount'] == before['triangleCount']
            await page.screenshot(path=str(OUTPUT / 'player-after-rebase.png'))
            report['scenarios'].append('manual-rebases-preserve-global-state-screen-pose-and-geometry')
            await page.click('#player-toggle')
            await page.keyboard.down('ArrowRight')
            await steps(3)
            await page.evaluate('window.dispatchEvent(new Event("blur"))')
            paused = await snapshot()
            await page.wait_for_timeout(350)
            assert not (await snapshot())['active']
            assert (await snapshot())['steps'] == paused['steps']
            await page.keyboard.up('ArrowRight')
            report['scenarios'].append('blur-pauses-clears-input-and-prevents-catch-up')
            # A small, exactly centred patch makes the physical boundary test bounded.
            level = 21
            tx = math.floor((2.35+180)/360 * 2**level)
            ty = math.floor((1-math.asinh(math.tan(math.radians(48.86)))/math.pi)/2 * 2**level)
            lon = (tx+.5)/2**level*360-180
            lat = math.degrees(math.atan(math.sinh(math.pi*(1-2*(ty+.5)/2**level))))
            await page.fill('#longitude', str(lon)); await page.fill('#latitude', str(lat))
            await page.select_option('#level', str(level)); await page.select_option('#side', '1')
            await page.select_option('#profile', 'flat')
            await build()
            await page.click('#player-toggle')
            await page.keyboard.down('ArrowRight')
            await steps(140)
            boundary = await snapshot()
            assert boundary['state']['boundaryBlocked'] and boundary['state']['grounded']
            assert boundary['runtimeError'] is None
            await page.keyboard.up('ArrowRight')
            report['scenarios'].append('loaded-patch-boundary-prevents-void-fall')
            await page.keyboard.press('Escape')
            for _ in range(3):
                await page.click('#player-respawn')
                await steps(2)
                await page.keyboard.press('Escape')
                assert (await snapshot())['geometryId'] == boundary['geometryId']
                assert (await snapshot())['colliderCount'] == 1
            report['scenarios'].append('respawn-reuses-render-and-collision-resources')
            report['sample'] = moved
            report['beforeRebase'] = before
            report['afterRebase'] = after
            assert not report['pageErrors'] and not report['httpErrors'] and not report['externalRequests'], report
            await page.evaluate('window.dispatchEvent(new Event("pagehide"))')
            assert (await snapshot())['disposed']
            report['scenarios'].append('pagehide-disposes-listeners-player-and-colliders')
            report['success'] = True
        finally:
            (OUTPUT / 'summary.json').write_text(json.dumps(report, indent=2))
            await browser.close()
    print(json.dumps({'success': report.get('success', False), 'scenarios': report['scenarios']}, indent=2))

if __name__ == '__main__':
    if os.environ.get('ZERANA_PLAYER_URL'):
        asyncio.run(run(os.environ['ZERANA_PLAYER_URL']))
    else:
        source = Path(os.environ.get('ZERANA_DEMO_DIR', ROOT / 'demo-dist'))
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copytree(source, Path(tmp) / 'Zerana' / 'v2')
            server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=tmp))
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            try:
                asyncio.run(run(f'http://127.0.0.1:{server.server_port}/Zerana/v2/'))
            finally:
                server.shutdown()
