/** Public client credentials only. Errors never contain a token or request URL. */
export function isPublicMapboxToken(value) {
  return typeof value === 'string' && /^pk\.[A-Za-z0-9._-]+$/.test(value.trim());
}
export function resolveMapboxToken(manual, configured) {
  const token = String(manual || '').trim() || String(configured || '').trim();
  if (!isPublicMapboxToken(token)) throw new Error('PUBLIC_MAPBOX_TOKEN_REQUIRED');
  return token;
}
