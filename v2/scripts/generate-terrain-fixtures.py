"""Independent vertex references. Requires pyproj==3.7.2; not needed to run tests."""
from pathlib import Path
import json
import math
import pyproj

cart = pyproj.Transformer.from_crs(4979, 4978, always_xy=True)
fixtures = []
# Non-boundary origins; exact tile corners/centre and an internal non-grid point.
for lon, lat in [(2.35, 48.86), (-5.81, 35.76), (0.01, 0.01), (179.9999, 75)]:
    level = 17
    n = 2**level
    x = math.floor((lon + 180) / 360 * n)
    y = math.floor((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    for col, row in [(0,0),(32,0),(0,32),(32,32),(16,16),(7,21)]:
        u, v = (x + col/32) / n, (y + row/32) / n
        plon = ((u*360) % 360) - 180
        plat = math.degrees(math.atan(math.sinh(math.pi*(1-2*v))))
        fixtures.append({'cell':[level,x,y], 'column':col, 'row':row,
                         'ecefMeters':cart.transform(plon,plat,0)})
payload={'provenance':{'pyproj':pyproj.__version__, 'proj':pyproj.proj_version_str,
    'crs':'EPSG:4979 -> EPSG:4978; longitude latitude ellipsoidHeight',
    'source':'https://proj.org/en/stable/operations/conversions/cart.html'},'vertices':fixtures}
path=Path(__file__).resolve().parents[1]/'tests/fixtures/proj-terrain.json'
path.write_text(json.dumps(payload,separators=(',',':'))+'\n')
print(f'{len(fixtures)} independent ECEF fixtures written')
