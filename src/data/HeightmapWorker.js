// Web Worker script (à charger via Blob / URL.createObjectURL)
// Ce fichier sera chargé dans un worker, donc pas d’accès DOM ou imports normaux.

self.onmessage = function (e) {
  const { requestId, heightmapData, originalSize, targetSize, scaleFactor } = e.data;

  try {
    // heightmapData = Uint8ClampedArray ou Uint8Array (RGB triplet par pixel)
    // originalSize = taille originale (ex: 64)
    // targetSize = taille cible (ex: 512)
    // scaleFactor = facteur d’échelle vertical

    const interpolated = new Float32Array(targetSize * targetSize);

    const scale = (originalSize - 1) / (targetSize - 1);

    for (let y = 0; y < targetSize; y++) {
      const yOrig = y * scale;
      const y0 = Math.floor(yOrig);
      const y1 = Math.min(y0 + 1, originalSize - 1);
      const dy = yOrig - y0;

      for (let x = 0; x < targetSize; x++) {
        const xOrig = x * scale;
        const x0 = Math.floor(xOrig);
        const x1 = Math.min(x0 + 1, originalSize - 1);
        const dx = xOrig - x0;

        // Récupérer les indices dans heightmapData (en RGB)
        const i00 = (y0 * originalSize + x0) * 3;
        const i10 = (y0 * originalSize + x1) * 3;
        const i01 = (y1 * originalSize + x0) * 3;
        const i11 = (y1 * originalSize + x1) * 3;

        // Décoder hauteur depuis RGB
        const decodeHeight = (r, g, b) => (-10000 + (r * 256 * 256 + g * 256 + b) * 0.1) / scaleFactor;

        const h00 = decodeHeight(heightmapData[i00], heightmapData[i00 + 1], heightmapData[i00 + 2]);
        const h10 = decodeHeight(heightmapData[i10], heightmapData[i10 + 1], heightmapData[i10 + 2]);
        const h01 = decodeHeight(heightmapData[i01], heightmapData[i01 + 1], heightmapData[i01 + 2]);
        const h11 = decodeHeight(heightmapData[i11], heightmapData[i11 + 1], heightmapData[i11 + 2]);

        // Interpolation bilinéaire
        const h0 = h00 + dx * (h10 - h00);
        const h1 = h01 + dx * (h11 - h01);
        const h = h0 + dy * (h1 - h0);

        interpolated[y * targetSize + x] = h;
      }
    }

    self.postMessage({ requestId, heightmap: interpolated }, [interpolated.buffer]);
  } catch (error) {
    self.postMessage({ requestId, error: error.message });
  }
};