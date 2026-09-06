/** Provider metadata only; no loader or decoder imported into the render thread. */
export const elevationReads=evidence=>(evidence||[]).filter(e=>e.layer==='elevation').map(e=>({layer:'elevation',tile:e.tile,sha256:e.sha256}));
