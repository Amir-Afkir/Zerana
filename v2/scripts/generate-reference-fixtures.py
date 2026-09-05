"""Optional fixture regeneration: Python 3 + pyproj==3.7.2 / PROJ 9.5.1.
Not used by the normal test run. Reference values come from PROJ, NOT the TS code.
"""
from pathlib import Path
import json
import random
import pyproj

rng = random.Random(20260905)
to_ecef = pyproj.Transformer.from_crs('EPSG:4979', 'EPSG:4978', always_xy=True)
base = [(0,0,0),(90,0,0),(-90,0,0),(180,0,0),(0,90,0),(0,-90,0),
        (2.35,48.86,35),(-5.81,35.76,50),(139.69,35.68,70),
        (179.9999,-40,20),(-179.9999,40,20),(45,89.999999,5),(-130,-89.999999,-500),
        (10,45,-12000),(0,0,100000000),(120,60,100000000)]
base += [(rng.uniform(-180,180), rng.uniform(-89.99,89.99), rng.uniform(-11000,40000000)) for _ in range(16)]
ecef_cases = [{'geodeticDegMeters': list(p), 'ecefMeters': list(to_ecef.transform(*p))} for p in base]
enu_cases=[]
for lon,lat,h in [(0,0,0),(2.35,48.86,35),(-5.81,35.76,50),(139.69,35.68,70),(179.999,75,10),(-179.999,-60,20)]:
    pipeline=f'+proj=pipeline +step +proj=cart +ellps=WGS84 +step +proj=topocentric +ellps=WGS84 +lon_0={lon} +lat_0={lat} +h_0={h}'
    transformer=pyproj.Transformer.from_pipeline(pipeline)
    p=[lon+0.0003,lat+0.0004,h+17]
    enu_cases.append({'originDegMeters':[lon,lat,h], 'pointDegMeters':p, 'enuMeters':list(transformer.transform(*p))})
geod=pyproj.Geod(ellps='WGS84')
steps=[]
for lon,lat in [(0,0),(2.35,48.86),(-5.81,35.76),(139.69,35.68),(179.999999,75),(-179.999999,-60),(45,89.9)]:
    for bearing in (0,90):
        lon2,lat2,_=geod.fwd(lon,lat,bearing,1)
        steps.append({'originDegMeters':[lon,lat,0], 'pointDegMeters':[lon2,lat2,0], 'bearingDeg':bearing})
fixture={'provenance':{'generator':'scripts/generate-reference-fixtures.py', 'pyproj':pyproj.__version__, 'proj':pyproj.proj_version_str,
 'crsInput':'EPSG:4979 (always_xy: longitude, latitude, ellipsoid height)', 'crsOutput':'EPSG:4978',
 'referenceUrls':['https://proj.org/en/stable/operations/conversions/cart.html','https://proj.org/en/stable/operations/conversions/topocentric.html'],
 'randomSeed':20260905}, 'ecef':ecef_cases,'enu':enu_cases,'oneMeterGeodesics':steps}
path=Path(__file__).resolve().parent.parent/'tests/fixtures/proj-wgs84.json'
path.write_text(json.dumps(fixture,separators=(',',':'))+'\n')
print(f'{len(ecef_cases)} ECEF, {len(enu_cases)} ENU, {len(steps)} independent one-metre cases')
