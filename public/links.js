const LOCAL_ROOTS = [
  '/Users/', '/home/', '/tmp/', '/private/', '/var/', '/opt/', '/etc/',
  '/Volumes/', '/srv/', '/usr/', '/root/', '/mnt/'
];

function splitHref(href) {
  const index = href.indexOf('#');
  return index === -1 ? [href, ''] : [href.slice(0, index), href.slice(index + 1)];
}

export function isLocalFilePath(href) {
  const source = String(href ?? '').trim();
  if (!source) return false;
  const [filePart] = splitHref(source);
  if (!filePart) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(filePart)) return false;
  if (filePart.startsWith('//')) return false;
  if (filePart.startsWith('/')) {
    return LOCAL_ROOTS.some(root => filePart === root.slice(0, -1) || filePart.startsWith(root));
  }
  return true;
}

// 本地文件链接改走只读查看页；行号片段（#L58-L62）原样保留给查看页高亮。
export function viewerUrl(sessionKey, href) {
  if (!isLocalFilePath(href)) return null;
  const [filePart, fragment] = splitHref(String(href).trim());
  const params = new URLSearchParams({ path: filePart });
  if (sessionKey) params.set('session', sessionKey);
  return `/viewer.html?${params.toString()}${fragment ? '#' + fragment : ''}`;
}
