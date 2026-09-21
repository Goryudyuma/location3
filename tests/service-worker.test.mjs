import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const origin = 'https://location3.example';
const bodies = new Map([['/index.html', '<title>Offline map</title>'], ['/app.mjs', 'export const version = 1;']]);
const hashes = Object.fromEntries([...bodies].map(([url, body]) => [url, createHash('sha256').update(body).digest('hex')]));
const template = await readFile(new URL('../web/static/service-worker.mjs', import.meta.url), 'utf8');
const script = template.replace('__SHELL_VERSION__', 'fixture-version')
  .replace('__SHELL_FILES__', JSON.stringify([...bodies.keys()]))
  .replace('__SHELL_HASHES__', JSON.stringify(hashes));

function harness({ cached = bodies, network = bodies, failWrite = false, redirected = false } = {}) {
  const entries = new Map([...cached].map(([url, body]) => [url, new Response(body)]));
  const listeners = new Map();
  const fetched = [];
  let activated = false;
  const key = request => new URL(typeof request === 'string' ? request : request.url, origin).pathname;
  const cache = {
    async match(request) { return entries.get(key(request))?.clone(); },
    async delete(request) { return entries.delete(key(request)); },
    async put(request, response) {
      if (failWrite) throw new DOMException('Quota exceeded', 'QuotaExceededError');
      entries.set(key(request), response.clone());
    },
  };
  const self = {
    location: { origin },
    addEventListener(name, listener) { listeners.set(name, listener); },
    async skipWaiting() { activated = true; },
    clients: { async claim() {} },
  };
  vm.runInNewContext(script, {
    self, crypto: webcrypto, Uint8Array, Response,
    Request: class extends Request { constructor(input, options) { super(new URL(input, origin), options); } },
    caches: { async open() { return cache; }, async keys() { return ['location3-shell-fixture-version']; } },
    fetch: async request => {
      const path = key(request);
      fetched.push(path);
      class RedirectedResponse extends Response {
        get redirected() { return true; }
        clone() { return new RedirectedResponse(network.get(path)); }
      }
      return network.has(path) ? new (redirected ? RedirectedResponse : Response)(network.get(path)) : new Response('Unavailable', { status: 503 });
    },
  });
  async function install() {
    let completion;
    listeners.get('install')({ waitUntil(promise) { completion = promise; } });
    await completion;
  }
  async function ensure() {
    let completion, response, closed = false;
    const port = { postMessage(value) { response = value; }, close() { closed = true; } };
    listeners.get('message')({ data: { type: 'ENSURE_SHELL' }, ports: [port], waitUntil(promise) { completion = promise; } });
    await completion;
    assert.equal(closed, true);
    return response;
  }
  return { entries, fetched, network, install, ensure, get activated() { return activated; } };
}

test('canonical index redirects are normalized before offline navigation caching', async () => {
  const worker = harness({ cached: new Map(), redirected: true });
  await worker.install();
  const index = worker.entries.get('/index.html');
  assert.equal(index.redirected, false);
  assert.equal(await index.text(), bodies.get('/index.html'));
});

test('installation activates only after all shell files match the build hashes', async () => {
  const worker = harness({ cached: new Map() });
  await worker.install();
  assert.equal(worker.activated, true);
  assert.deepEqual(worker.fetched.sort(), [...bodies.keys()].sort());
  const response = await worker.ensure();
  assert.equal(response.ok, true);
  assert.equal(response.version, 'fixture-version');
  assert.equal(worker.fetched.length, 2);
});

test('failed shell installation never activates the worker or stores unverified files', async () => {
  const worker = harness({ cached: new Map(), network: new Map([['/index.html', bodies.get('/index.html')]]) });
  await assert.rejects(worker.install());
  assert.equal(worker.activated, false);
  assert.equal(worker.entries.size, 0);
});

test('an existing active shell needs no network when all cached bytes verify', async () => {
  const worker = harness({ network: new Map() });
  assert.equal((await worker.ensure()).ok, true);
  assert.deepEqual(worker.fetched, []);
});

test('missing files are repaired and verified before acknowledging offline readiness', async () => {
  const worker = harness({ cached: new Map([['/index.html', bodies.get('/index.html')]]) });
  assert.equal((await worker.ensure()).ok, true);
  assert.deepEqual(worker.fetched, ['/app.mjs']);
  assert.equal(await worker.entries.get('/app.mjs').text(), bodies.get('/app.mjs'));
});

test('same-size cached corruption is detected and repaired', async () => {
  const cached = new Map(bodies);
  cached.set('/app.mjs', 'x'.repeat(bodies.get('/app.mjs').length));
  const worker = harness({ cached });
  assert.equal((await worker.ensure()).ok, true);
  assert.deepEqual(worker.fetched, ['/app.mjs']);
});

test('a different deployment cannot repair the installed shell with incompatible module bytes', async () => {
  const network = new Map(bodies);
  network.set('/app.mjs', 'export const version = 2;');
  const worker = harness({ cached: new Map([['/index.html', bodies.get('/index.html')]]), network });
  const response = await worker.ensure();
  assert.equal(response.ok, false);
  assert.match(response.error, /版が変わっています/);
  assert.equal(worker.entries.has('/app.mjs'), false);
});

test('failed repair is reported, and a later retry can succeed', async () => {
  const network = new Map();
  const worker = harness({ cached: new Map([['/index.html', bodies.get('/index.html')]]), network });
  assert.equal((await worker.ensure()).ok, false);
  network.set('/app.mjs', bodies.get('/app.mjs'));
  assert.equal((await worker.ensure()).ok, true);
  assert.deepEqual(worker.fetched, ['/app.mjs', '/app.mjs']);
});

test('cache quota errors cannot acknowledge a ready shell', async () => {
  const worker = harness({ cached: new Map(), failWrite: true });
  const response = await worker.ensure();
  assert.equal(response.ok, false);
  assert.match(response.error, /空き容量/);
});

test('concurrent readiness requests share one repair and both wait for it', async () => {
  const worker = harness({ cached: new Map() });
  const responses = await Promise.all([worker.ensure(), worker.ensure()]);
  assert.ok(responses.every(response => response.ok));
  assert.deepEqual(worker.fetched.sort(), [...bodies.keys()].sort());
});
