// Build replaces these constants with a content-derived version and complete shell.
const VERSION = '__SHELL_VERSION__';
const SHELL = __SHELL_FILES__;
const SHELL_HASHES = __SHELL_HASHES__;
const CACHE = `location3-shell-${VERSION}`;
let ensuringShell;

async function responseMatches(response, url) {
  if (!response?.ok || !SHELL_HASHES[url]) return false;
  const bytes = await crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer());
  const digest = [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
  return digest === SHELL_HASHES[url];
}

async function missingShellFiles(cache) {
  const checked = await Promise.all(SHELL.map(async url => ({ url, present: await responseMatches(await cache.match(url), url) })));
  return checked.filter(entry => !entry.present).map(entry => entry.url);
}

// An active worker alone does not prove that its files still exist in storage.
// Verify the exact installed version, repairing only from matching network bytes.
function ensureShell() {
  ensuringShell ??= (async () => {
    const cache = await caches.open(CACHE);
    const missing = await missingShellFiles(cache);
    if (missing.length === 0) return;
    await Promise.all(missing.map(url => cache.delete(url)));
    const replacements = await Promise.all(missing.map(async url => {
      const response = await fetch(new Request(url, { cache: 'reload' }));
      if (!response.ok) throw new Error('画面データを保存できません。通信状況を確認して再試行してください。');
      if (!await responseMatches(response, url)) {
        throw new Error('画面データの版が変わっています。オンラインでページを再読み込みしてから保存してください。');
      }
      return { url, response };
    }));
    for (const { url, response } of replacements) {
      // /index.html is canonicalized to / by both Go and Cloudflare. A response
      // with redirected=true cannot satisfy a navigation with redirect=manual.
      await cache.put(url, new Response(response.body, { status: response.status, headers: response.headers }));
    }
    if ((await missingShellFiles(cache)).length > 0) throw new Error('画面データの保存を確認できませんでした。もう一度お試しください。');
  })().finally(() => { ensuringShell = undefined; });
  return ensuringShell;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    await ensureShell();
    await self.skipWaiting();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type !== 'ENSURE_SHELL' || !event.ports?.[0]) return;
  const port = event.ports[0];
  event.waitUntil((async () => {
    try {
      await ensureShell();
      port.postMessage({ ok: true, version: VERSION });
    } catch (error) {
      port.postMessage({ ok: false, error: error?.name === 'QuotaExceededError'
        ? '画面を保存する空き容量が足りません。保存済みの地域を削除してから再試行してください。'
        : error?.message || '画面データを保存できませんでした。通信状況を確認してください。' });
    } finally { port.close(); }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await self.clients.claim();
    for (const name of await caches.keys()) {
      if (name.startsWith('location3-shell-') && name !== CACHE) await caches.delete(name);
    }
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match('/index.html')) ?? fetch(request)));
  } else if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(url.pathname)) ?? fetch(request)));
  }
  // Map archives and railway snapshots are stored only by the explicit Save action.
});
