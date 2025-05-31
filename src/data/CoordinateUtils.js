export default {
  // Convertit lat/lon en coordonnées tile (x, y) pour un zoom donné
  latLonToTile: function (lon, lat, zoom) {
    const x = Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
    const y = Math.floor(
      ((1 -
        Math.log(
          Math.tan((lat * Math.PI) / 180) +
            1 / Math.cos((lat * Math.PI) / 180)
        ) /
          Math.PI) /
        2) *
        Math.pow(2, zoom)
    );
    return { x, y };
  },

  // Convertit coordonnées tile (x, y) en lat/lon au coin supérieur gauche
  tileToLatLon: function (x, y, zoom) {
    const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, zoom);
    const lon = (x / Math.pow(2, zoom)) * 360 - 180;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { lon, lat };
  },

  // Calcule la bounding box (lat/lon) d’une tile
  tileBounds: function (x, y, zoom) {
    const nw = this.tileToLatLon(x, y, zoom);
    const se = this.tileToLatLon(x + 1, y + 1, zoom);
    return {
      north: nw.lat,
      west: nw.lon,
      south: se.lat,
      east: se.lon,
    };
  },

  // Convertit lat/lon en coordonnées locales dans un chunk de taille chunkSize
  latLonToLocal: function (lon, lat, chunkBounds, chunkSize) {
    const width = chunkBounds.east - chunkBounds.west;
    const height = chunkBounds.north - chunkBounds.south;

    const x = ((lon - chunkBounds.west) / width) * chunkSize;
    const z = ((chunkBounds.north - lat) / height) * chunkSize;

    return { x, z };
  }
};