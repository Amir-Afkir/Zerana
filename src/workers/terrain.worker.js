const controllers = new Map();

self.onmessage = async (event) => {
  const { requestId, tileUrl, type, options } = event.data;

  if (type === 'abort') {
    const controller = controllers.get(requestId);
    if (controller) controller.abort();
    controllers.delete(requestId);
    return;
  }

  const controller = new AbortController();
  controllers.set(requestId, controller);

  try {
    const response = await fetch(tileUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`Download failed: ${response.statusText}`);

    if (type === 'image') {
      const blob = await response.blob();
      const imageBitmap = await createImageBitmap(blob);
      const maxSize = options?.maxSize;
      if (
        Number.isFinite(maxSize) &&
        maxSize > 0 &&
        (imageBitmap.width > maxSize || imageBitmap.height > maxSize)
      ) {
        const canvas = new OffscreenCanvas(maxSize, maxSize);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imageBitmap, 0, 0, maxSize, maxSize);
        if (imageBitmap.close) imageBitmap.close();
        const resized = await createImageBitmap(canvas);
        self.postMessage({ requestId, imageBitmap: resized }, [resized]);
      } else {
        self.postMessage({ requestId, imageBitmap }, [imageBitmap]);
      }
      return;
    }

    if (type === 'heightmap') {
      const blob = await response.blob();
      const imageBitmap = await createImageBitmap(blob);

      const originalSize = 64;
      let targetSize = Number.isFinite(options?.targetSize) ? options.targetSize : 512;
      targetSize = targetSize | 0;
      // Guardrails: keep memory bounded and avoid degenerate sizes.
      if (targetSize < 32) targetSize = 32;
      if (targetSize > 512) targetSize = 512;
      const scaleFactor = options?.scaleFactor || 1;

      const canvas = new OffscreenCanvas(originalSize, originalSize);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(imageBitmap, 0, 0, originalSize, originalSize);

      const imageData = ctx.getImageData(0, 0, originalSize, originalSize);
      const pixels = new Uint8Array(imageData.data.buffer);

      const heightmapOriginal = new Float32Array(originalSize * originalSize);
      for (let i = 0, p = 0; i < heightmapOriginal.length; i++, p += 4) {
        const r = pixels[p];
        const g = pixels[p + 1];
        const b = pixels[p + 2];
        const heightValue = r * 256 * 256 + g * 256 + b;
        heightmapOriginal[i] = (-10000 + heightValue * 0.1) / scaleFactor;
      }

      const x0Array = new Uint16Array(targetSize);
      const x1Array = new Uint16Array(targetSize);
      const dxArray = new Float32Array(targetSize);
      const scale = (originalSize - 1) / (targetSize - 1);

      for (let x = 0; x < targetSize; x++) {
        const xOrig = x * scale;
        const x0 = Math.floor(xOrig);
        x0Array[x] = x0;
        x1Array[x] = Math.min(x0 + 1, originalSize - 1);
        dxArray[x] = xOrig - x0;
      }

      const heightmap = new Float32Array(targetSize * targetSize);
      for (let y = 0; y < targetSize; y++) {
        const yOrig = y * scale;
        const y0 = Math.floor(yOrig);
        const y1 = Math.min(y0 + 1, originalSize - 1);
        const dy = yOrig - y0;

        const rowOffset0 = y0 * originalSize;
        const rowOffset1 = y1 * originalSize;

        for (let x = 0; x < targetSize; x++) {
          const x0 = x0Array[x];
          const x1 = x1Array[x];
          const dx = dxArray[x];

          const h00 = heightmapOriginal[rowOffset0 + x0];
          const h10 = heightmapOriginal[rowOffset0 + x1];
          const h01 = heightmapOriginal[rowOffset1 + x0];
          const h11 = heightmapOriginal[rowOffset1 + x1];

          const h0 = h00 + dx * (h10 - h00);
          const h1 = h01 + dx * (h11 - h01);
          heightmap[y * targetSize + x] = h0 + dy * (h1 - h0);
        }
      }

      if (imageBitmap.close) imageBitmap.close();
      self.postMessage({ requestId, heightmap }, [heightmap.buffer]);
      return;
    }

    throw new Error(`Unsupported type: ${type}`);
  } catch (error) {
    if (error.name !== 'AbortError') {
      self.postMessage({ requestId, error: error.message });
    }
  } finally {
    controllers.delete(requestId);
  }
};
