# ADR-003 — Raster providers, sampling, and unresolved vertical datums

Date: 2026-09-05. Scope: isolated V2 laboratory, stacked on PR #2.
Status: proposed for review; production and the supplied architecture reference are unchanged.

## Evidence

Mapbox documents mixed vertical datums in Terrain-RGB, including NAVD88, EGM96
and Ordnance Datum Newlyn; a per-pixel datum is not exposed. It warns that forcing
one geoid transformation can introduce inaccuracies. The encoding step is 0.1 m;
it is NOT an assertion of 0.1 m survey accuracy. Real data resolution is limited
to the equivalent of z15 at 256 pixels. [1][2]

## Decision

1. Decode native PNG RGB bytes to scalar heights BEFORE interpolation.
2. Source tiles and simulation cells are independent: DEM <= z15/256 pixels,
   imagery <= z18 in this bounded laboratory (not a claim about provider maximum).
3. Use global pixel centres `p = uv * (tileSize * 2^zoom) - 0.5`.
   Bilinear taps cross source tile boundaries; X wraps, Y clamps ONLY at the
   outer Mercator coverage edge. A missing active tap is an error, never zero.
4. Include one mesh-sample halo for terrain normals. Imagery includes a texture
   gutter, no mipmaps, and geographically identical boundary samples.
5. Interpolate imagery in linear-light RGB, encode the output texture as sRGB.
   Texture row 0 is South, UV v=1 is North, flipY=false.
6. Treat 401/403 as terminal auth/restriction errors. Retry 429/5xx at most once,
   respect bounded Retry-After; timeout 12 s/request, at most four active requests,
   maximum 64 planned tile requests plus two TileJSON metadata requests.
7. Retain the last valid scene on provider failure or cancellation. Late results
   never replace it. No token in source, storage, manifests or diagnostic reports.
8. Keep snapshot hashes of received tile bytes, keyed by layer and canonical XYZ.
   A snapshot identifies what was received; it is not a provider release date or
   a proof of simultaneous acquisition. No IndexedDB/service-worker data cache.
9. Obtain provider text attribution via TileJSON and render only safe text/HTTPS
   links. Include the unchanged official Mapbox logo. [3][4]

## Vertical authority (normative within this stage)

The default strict path accepts a declared WGS84 ellipsoidal dataset, or a known
orthometric datum with an explicitly matching, evidenced geoid correction.
The sign is `h = H + N`. Correction coverage belongs to the supplied correction
function; it must throw outside its supported area. No real geoid grid is shipped
in this stage; test corrections are explicitly synthetic fixtures.

Mapbox's mixed datum fails this strict path with `VERTICAL_DATUM_UNRESOLVED`.
It must NOT be relabelled EGM96 or WGS84 because a tile looks visually correct.

### Explicit, isolated visualization exception

To make the real raster adapter inspectable before a globally referenced elevation
source is selected, the lab offers an unchecked-by-default consent box. Only after
this explicit opt-in can raw source heights be used as *approximate placement*
on the ellipsoid. This is NOT a datum transformation and does not produce
canonical absolute elevation.

The approximation carries `UNRESOLVED_DATUM_PREVIEW`, provenance `estimated`,
and packet `altitudeAuthority: preview-only`. Both the source adapter and the
TerrainSampler require explicit permission. The scene badge and diagnostics stay
visible and are not cleared by an unsuccessful reload. Synthetic mode remains the
default and makes no provider requests. No automatic fallback switches a strict
request to preview mode. A future canonical runtime MUST reject these packets.
The internal ECEF/GeoAnchor values of this preview are estimated placements, not
measurements. Seam tolerances characterize numerical continuity only.

This narrowly documented exception does not alter the supplied reference file,
and must not be silently promoted into the final world engine. Before production
V2 with absolute heights, select a source with a documented vertical reference
and implement/validate its appropriate transformation, or approve an explicit
product-level approximate-height policy separately.

## Ocean and missing data

Only a 404 JSON response whose exact message is `Tile does not exist` from the
Terrain-RGB endpoint is interpreted as Mapbox's documented zero-elevation water
case. It is counted and flagged in evidence. Other 404s, transparent PNG pixels,
malformed content and missing neighbour tiles remain errors. This water handling
does not add bathymetry or confer WGS84 altitude authority. [2]

## Verification / limits

32 raster unit tests cover byte carries, pixel centres, cross-tile interpolation,
wrap, missing data, source ownership, budgets, known-datum correction sign,
preview opt-in, 9-cell seams and colour orientation. Existing tests are retained.
Browser integration tests use generated PNG responses on intercepted Mapbox URLs:
they test the pipeline, NOT live provider availability or the user's credentials.
No real API request or charge is needed for CI. No live geographic screenshot is
claimed. The browser adapter is intentionally bounded and main-thread based;
worker offloading, persistent cache, streaming, mixed LOD and GPU performance
validation remain subsequent milestones. Production is not changed by this PR.

## Sources checked on 2026-09-05

[1] https://docs.mapbox.com/data/tilesets/reference/mapbox-terrain-rgb-v1/
[2] https://docs.mapbox.com/data/tilesets/guides/access-elevation-data/
[3] https://docs.mapbox.com/api/maps/raster-tiles/
[4] https://docs.mapbox.com/help/dive-deeper/attribution/
[5] https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap

Logo source: mapbox/mapbox-gl-js, src/css/svg/mapboxgl-ctrl-logo.svg,
Git blob `3d24c610eb9ee68dcd1864354582856227b721e5`, unchanged.
The logo is used only for attribution of Mapbox data; it is not Zerana branding.
