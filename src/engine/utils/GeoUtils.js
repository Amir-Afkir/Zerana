export function latLonToTile(lon, lat, zoom) {
  const x = Math.floor((lon + 180) / 360 * Math.pow(2, zoom));
  const y = Math.floor(
    (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 *
      Math.pow(2, zoom)
  );
  return { x, y };
}

// Fractional (non floored) tile coordinates at a given zoom. Useful to map lat/lon -> local tile space.
export function latLonToTileFloat(lon, lat, zoom) {
  const x = (lon + 180) / 360 * Math.pow(2, zoom);
  const y =
    (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 *
    Math.pow(2, zoom);
  return { x, y };
}

export function tileToLatLon(x, y, zoom) {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, zoom);
  const lon = (x / Math.pow(2, zoom)) * 360 - 180;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lon, lat };
}

export function getTileBounds(tileX, tileY, zoom) {
  const nw = tileToLatLon(tileX, tileY, zoom);
  const se = tileToLatLon(tileX + 1, tileY + 1, zoom);
  return {
    nwLat: nw.lat,
    nwLon: nw.lon,
    seLat: se.lat,
    seLon: se.lon
  };
}

export function calcScaleFactor(latitude, zoom, chunkSize) {
  if (isNaN(latitude) || isNaN(zoom) || isNaN(chunkSize)) return NaN;
  const earthCircumference = 40075017;
  const tileWidthMeters = earthCircumference * Math.cos(latitude * Math.PI / 180) / Math.pow(2, zoom);
  return tileWidthMeters / chunkSize;
}
