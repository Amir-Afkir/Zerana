export function getRequestedQuality() {
  try {
    const params = new URLSearchParams(window.location.search);
    const q = (params.get('q') || '').toLowerCase();
    if (q === 'low' || q === 'med' || q === 'high') return q;
  } catch {
    // ignore
  }
  return null;
}

export function detectQualityTier() {
  const deviceMemory = Number(navigator.deviceMemory) || 4;
  const cores = Number(navigator.hardwareConcurrency) || 4;
  const isCoarsePointer = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

  // Conservative defaults: prefer stability on mobile.
  if (isCoarsePointer && deviceMemory <= 2) return 'low';
  if (isCoarsePointer || deviceMemory <= 4 || cores <= 4) return 'med';
  return 'high';
}

export function getQualitySettings() {
  const forced = getRequestedQuality();
  const tier = forced || detectQualityTier();
  const dpr = window.devicePixelRatio || 1;

  if (tier === 'low') {
    return {
      tier,
      pixelRatio: 1,
      maxConcurrentTerrain: 3,
      maxConcurrentDetails: 1,
      buildingsRadius: 3,
      treesRadius: 1,
      overpassRadius: 1,
      disposeOnHide: true,
      mapboxCacheSize: 48,
      maxBuildings: 350,
      maxTrees: 180
    };
  }

  if (tier === 'med') {
    return {
      tier,
      pixelRatio: Math.min(dpr, 1.25),
      maxConcurrentTerrain: 4,
      maxConcurrentDetails: 2,
      buildingsRadius: 3,
      treesRadius: 1,
      overpassRadius: 1,
      disposeOnHide: true,
      mapboxCacheSize: 72,
      maxBuildings: 550,
      maxTrees: 260
    };
  }

  return {
    tier,
    pixelRatio: Math.min(dpr, 1.5),
    maxConcurrentTerrain: 6,
    maxConcurrentDetails: 3,
    buildingsRadius: 3,
    treesRadius: 2,
    overpassRadius: 1,
    disposeOnHide: false,
    mapboxCacheSize: 96,
    maxBuildings: 900,
    maxTrees: 360
  };
}
