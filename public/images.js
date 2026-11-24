const DIRECT_IMAGE_RE = /^(?:https?:\/\/|data:image\/)/i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

// Most session images are local paths relative to the cwd, which the browser cannot read directly;
// they are routed through the read-only backend endpoint instead.
export function resolveImageSource(sessionKey, src) {
  const source = String(src ?? '').trim();
  if (!source) return null;
  if (DIRECT_IMAGE_RE.test(source)) return source;
  if (SCHEME_RE.test(source)) return null;
  if (!sessionKey) return null;
  return `/api/session/asset?key=${encodeURIComponent(sessionKey)}&path=${encodeURIComponent(source)}`;
}
