/** De-duplicate provider credits, never remove an unknown required credit.
 * Only text and HTTPS links are copied from the untrusted TileJSON HTML. */
export function renderAttribution(container, values) {
  const entries = new Map();
  const add = (label, href = null) => {
    label = label.replace(/\s+/g, ' ').trim();
    if (!label || /^[©|·,\s]+$/.test(label)) return;
    let url;
    if (href) {
      try { url = new URL(href); } catch { return; }
      if (url.protocol === 'http:') url.protocol = 'https:';
      if (url.protocol !== 'https:') return;
    }
    const name = label.replace(/^©\s*/, '').toLowerCase();
    let key = `${label}|${url?.href || ''}`;
    if (name === 'mapbox') { key = 'mapbox'; label = '© Mapbox'; }
    if (name === 'openstreetmap' || name === 'openstreetmap contributors') { key = 'osm'; label = '© OpenStreetMap'; }
    if (name === 'maxar') { key = 'maxar'; label = '© Maxar'; }
    if (name === 'improve this map') key = 'feedback';
    if (!entries.has(key)) entries.set(key, {label, href:url?.href});
  };
  for (const value of values) {
    const parsed = new DOMParser().parseFromString(value, 'text/html');
    const visit = node => {
      if (node.nodeType === Node.TEXT_NODE) { add(node.textContent); return; }
      if (node.nodeName === 'A') { add(node.textContent, node.getAttribute('href')); return; }
      if (['SCRIPT','STYLE','IFRAME','OBJECT'].includes(node.nodeName)) return;
      for (const child of node.childNodes) visit(child);
    };
    visit(parsed.body);
  }
  // Minimum credits for our terrain/satellite combination, including fallback
  // for a provider response with only a partial attribution fixture.
  if (!entries.has('mapbox')) add('© Mapbox', 'https://www.mapbox.com/about/maps');
  if (!entries.has('osm')) add('© OpenStreetMap', 'https://www.openstreetmap.org/copyright/');
  if (!entries.has('maxar')) add('© Maxar', 'https://www.maxar.com/');
  if (!entries.has('feedback')) add('Improve this map', 'https://apps.mapbox.com/feedback/');
  container.replaceChildren(...[...entries.values()].flatMap(({label, href}, i) => {
    const node = document.createElement(href ? 'a' : 'span'); node.textContent = label;
    if (href) { node.href = href; node.rel = 'noopener noreferrer'; node.target = '_blank'; }
    return i ? [document.createTextNode(' · '), node] : [node];
  }));
}
