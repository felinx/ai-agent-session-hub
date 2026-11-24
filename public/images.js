const DIRECT_IMAGE_RE = /^(?:https?:\/\/|data:image\/)/i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

// 会话里的图片多为相对 cwd 的本地路径，浏览器无法直接读取；交给后端只读接口。
export function resolveImageSource(sessionKey, src) {
  const source = String(src ?? '').trim();
  if (!source) return null;
  if (DIRECT_IMAGE_RE.test(source)) return source;
  if (SCHEME_RE.test(source)) return null;
  if (!sessionKey) return null;
  return `/api/session/asset?key=${encodeURIComponent(sessionKey)}&path=${encodeURIComponent(source)}`;
}
