import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './index.ts';

const entry = (hash, count) => ({ path: `/datasets/${hash.repeat(64)}.geojson`, count });
const manifest = {
  version: 1,
  all: { railroads: entry('a', 10), stations: entry('b', 20) },
  periods: [
    { startYear: 1, railroads: entry('c', 0), stations: entry('d', 0) },
    { startYear: 1950, railroads: entry('e', 4), stations: entry('f', 8) },
    { startYear: 1967, railroads: entry('1', 5), stations: entry('2', 9) },
    { startYear: 2025, railroads: entry('3', 6), stations: entry('4', 10) },
  ],
};
const manifestPath = '/datasets/manifest.json';
const assetBody = path => `GeoJSON bytes for ${path}`;

function fixtureEnv({ index = manifest, fetchAsset, fetchManifest } = {}) {
  const requests = [];
  return {
    requests,
    ASSETS: {
      async fetch(request) {
        requests.push(request);
        const path = new URL(request.url).pathname;
        if (path === manifestPath) {
          return fetchManifest ? fetchManifest(request) : Response.json(index);
        }
        if (!path.startsWith('/datasets/')) return new Response('static asset');
        if (fetchAsset) return fetchAsset(request);
        return new Response(request.method === 'HEAD' ? null : assetBody(path), {
          headers: { 'Content-Type': 'application/octet-stream', ETag: '"fixture"', 'Content-Length': '123' },
        });
      },
    },
  };
}

function request(path, env, method = 'GET', headers) {
  return worker.fetch(new Request(`https://l3.063.jp${path}`, { method, headers }), env);
}

function paths(env) {
  return env.requests.map(request => new URL(request.url).pathname);
}

test('strict calendar dates reject invalid input before any asset access', async () => {
  const env = fixtureEnv();
  for (const date of ['0000-01-01', '1900-02-29', '2023-02-29', '2024-02-30', '2024-04-31', '2024-13-01', '2024-01-00', '2024-1-01', '2024-01-1', '2024', '2024-01-01T00:00:00Z', 'not a date']) {
    assert.equal((await request(`/api/railroads?date=${encodeURIComponent(date)}`, env)).status, 400, date);
  }
  assert.deepEqual(env.requests, []);
  for (const date of ['', '  ', ' 2024-02-29 ', '2000-02-29', '0001-01-01', '9999-12-31']) {
    const response = await request(`/api/railroads?date=${encodeURIComponent(date)}`, env);
    assert.equal(response.status, 200, date);
    assert.equal(response.headers.get('X-Filter-Year'), date.trim() ? String(Number(date.trim().slice(0, 4))) : null);
  }
});

test('all dates and period boundaries select the matching precomputed asset', async () => {
  const env = fixtureEnv();
  const cases = [
    ['', manifest.all, null],
    ['?date=', manifest.all, null],
    ['?date=0001-01-01', manifest.periods[0], '1'],
    ['?date=1949-12-31', manifest.periods[0], '1949'],
    ['?date=1950-01-01', manifest.periods[1], '1950'],
    ['?date=1966-01-01', manifest.periods[1], '1966'],
    ['?date=1966-12-31', manifest.periods[1], '1966'],
    ['?date=1967-01-01', manifest.periods[2], '1967'],
    ['?date=2024-12-31', manifest.periods[2], '2024'],
    ['?date=2025-01-01', manifest.periods[3], '2025'],
    ['?date=9999-12-31', manifest.periods[3], '9999'],
  ];
  for (const [query, pair, year] of cases) {
    for (const kind of ['railroads', 'stations']) {
      const response = await request(`/api/${kind}${query}`, env);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), assetBody(pair[kind].path));
      assert.equal(response.headers.get('Content-Type'), 'application/geo+json');
      assert.equal(response.headers.get('Cache-Control'), 'public, max-age=300');
      assert.equal(response.headers.get('X-Feature-Count'), String(pair[kind].count));
      assert.equal(response.headers.get('X-Filter-Year'), year);
      assert.equal(response.headers.get('ETag'), '"fixture"');
      assert.equal(response.headers.get('Content-Length'), '123');
      const head = await request(`/api/${kind}${query}`, env, 'HEAD');
      assert.equal(head.status, 200);
      assert.deepEqual([...head.headers], [...response.headers]);
      assert.equal(await head.text(), '');
      assert.equal(env.requests.at(-1).method, 'HEAD');
    }
  }
  assert.equal(paths(env).filter(path => path === manifestPath).length, 1);
});

test('GeoJSON is forwarded as an untouched stream, including encoding and length headers', async () => {
  let pulls = 0;
  const bytes = new Uint8Array([31, 139, 8, 0, 1, 2, 3, 4]);
  const body = new ReadableStream({
    pull(controller) {
      pulls++;
      controller.enqueue(bytes);
      controller.close();
    },
  }, { highWaterMark: 0 });
  const asset = new Response(body, {
    headers: { 'Content-Encoding': 'gzip', 'Content-Length': String(bytes.length), ETag: '"compressed"', Vary: 'Accept-Encoding' },
  });
  for (const method of ['text', 'json', 'arrayBuffer', 'bytes', 'blob']) {
    Object.defineProperty(asset, method, { value() { throw new Error(`payload ${method} must not be called`); } });
  }
  const env = fixtureEnv({ fetchAsset: () => asset });
  const response = await request('/api/railroads?date=1966-01-01&unexpected=query', env, 'GET', {
    'Accept-Encoding': 'gzip', 'If-None-Match': '"old"', Range: 'bytes=0-10',
  });
  assert.equal(response.status, 200);
  assert.equal(response.body, body);
  assert.equal(pulls, 0);
  assert.equal(response.headers.get('Content-Encoding'), 'gzip');
  assert.equal(response.headers.get('Content-Length'), String(bytes.length));
  assert.equal(response.headers.get('Vary'), 'Accept-Encoding');
  assert.equal(response.headers.get('ETag'), '"compressed"');
  for (const internal of env.requests) {
    assert.equal(new URL(internal.url).origin, 'https://l3.063.jp');
    assert.equal(new URL(internal.url).search, '');
    assert.equal(internal.headers.get('If-None-Match'), new URL(internal.url).pathname === manifestPath ? null : '"old"');
    assert.equal(internal.headers.get('Range'), null);
  }
  assert.equal(env.requests.at(-1).headers.get('Accept-Encoding'), 'gzip');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.equal(pulls, 1);
});

test('conditional GET and HEAD preserve asset 304 validators without a response body', async () => {
  for (const kind of ['railroads', 'stations']) {
    for (const method of ['GET', 'HEAD']) {
      for (const validator of ['"fixture"', 'W/"fixture"', '"old", W/"fixture"', '*']) {
        const env = fixtureEnv({ fetchAsset(internal) {
          assert.equal(internal.method, method);
          assert.equal(internal.headers.get('If-None-Match'), validator);
          assert.equal(internal.headers.get('If-Modified-Since'), null);
          return new Response(null, {
            status: 304,
            headers: {
              ETag: '"fixture"', Vary: 'Accept-Encoding', 'Cache-Control': 'public, max-age=0',
              'Content-Length': '123', 'Content-Encoding': 'gzip',
            },
          });
        } });
        const response = await request(`/api/${kind}?date=1966-01-01`, env, method, {
          'If-None-Match': validator, 'If-Modified-Since': 'Thu, 01 Jan 2099 00:00:00 GMT',
        });
        assert.equal(response.status, 304);
        assert.equal(response.body, null);
        assert.equal(await response.text(), '');
        assert.equal(response.headers.get('ETag'), '"fixture"');
        assert.equal(response.headers.get('Vary'), 'Accept-Encoding');
        assert.equal(response.headers.get('Cache-Control'), 'public, max-age=300');
        assert.equal(response.headers.get('X-Feature-Count'), String(manifest.periods[1][kind].count));
        assert.equal(response.headers.get('X-Filter-Year'), '1966');
        assert.equal(response.headers.get('Content-Length'), null);
        assert.equal(response.headers.get('Content-Encoding'), null);
        assert.equal(env.requests[0].headers.get('If-None-Match'), null);
      }
    }
  }
});

test('date validators are forwarded only when If-None-Match is absent', async () => {
  const modified = 'Thu, 01 Jan 2026 00:00:00 GMT';
  for (const etag of [undefined, '"outdated"', '']) {
    const env = fixtureEnv({ fetchAsset(internal) {
      assert.equal(internal.headers.get('If-None-Match'), etag ?? null);
      assert.equal(internal.headers.get('If-Modified-Since'), etag === undefined ? modified : null);
      return etag === undefined
        ? new Response(null, { status: 304, headers: { 'Last-Modified': modified } })
        : new Response('updated dataset', { headers: { ETag: '"updated"' } });
    } });
    const headers = { 'If-Modified-Since': modified };
    if (etag !== undefined) headers['If-None-Match'] = etag;
    const response = await request('/api/stations', env, 'GET', headers);
    assert.equal(response.status, etag === undefined ? 304 : 200);
    assert.equal(await response.text(), etag === undefined ? '' : 'updated dataset');
    assert.equal(response.headers.get('X-Filter-Year'), null);
  }
});

test('asset 200 responses still honor weak, list and wildcard validators without reading the body', async () => {
  for (const method of ['GET', 'HEAD']) {
    for (const current of ['"current"', 'W/"current"']) {
      for (const validator of ['"current"', 'W/"current"', '"old,tag", W/"current"', ', "old",, "current", ', '*']) {
        let canceled = 0;
        const env = fixtureEnv({ fetchAsset() {
          return new Response(method === 'HEAD' ? null : new ReadableStream({
            pull() { throw new Error('304 must not read the GeoJSON'); },
            cancel() { canceled++; },
          }, { highWaterMark: 0 }), { headers: { ETag: current } });
        } });
        const response = await request('/api/stations?date=1966-01-01', env, method, { 'If-None-Match': validator });
        assert.equal(response.status, 304, `${current} / ${validator}`);
        assert.equal(response.body, null);
        assert.equal(response.headers.get('ETag'), current);
        assert.equal(canceled, method === 'GET' ? 1 : 0);
      }
    }
  }
});

test('stale and malformed validators return the current representation', async () => {
  for (const validator of ['"old"', 'w/"fixture"', 'fixture', '"fixture", garbage', '"fixture" "old"', '"fixture", *', '*, "fixture"', '"unterminated', '"bad tag"', '', ', ,']) {
    const env = fixtureEnv();
    const response = await request('/api/railroads', env, 'GET', { 'If-None-Match': validator });
    assert.equal(response.status, 200, validator);
    assert.equal(await response.text(), assetBody(manifest.all.railroads.path));
  }
});

test('failed manifest fetches and invalid manifests can be retried', async t => {
  t.mock.method(console, 'error', () => {});
  for (const failure of ['throw', '404', 'json', 'schema']) {
    let attempts = 0;
    const env = fixtureEnv({ fetchManifest() {
      if (attempts++ === 0) {
        if (failure === 'throw') throw new Error('temporary asset failure');
        if (failure === '404') return new Response('missing', { status: 404 });
        if (failure === 'json') return new Response('broken JSON');
        return Response.json({ version: 1 });
      }
      return Response.json(manifest);
    } });
    assert.equal((await request('/api/railroads?date=1966-01-01', env)).status, 500, failure);
    assert.equal((await request('/api/railroads?date=1966-01-01', env)).status, 200, failure);
    assert.equal(attempts, 2);
  }
});

test('invalid versions, period ordering, counts and paths are rejected', async t => {
  t.mock.method(console, 'error', () => {});
  const changes = [
    value => { value.version = 2; },
    value => { value.all.railroads.path = 'https://other.test/data.geojson'; },
    value => { value.all.stations.path = '/datasets/../secret'; },
    value => { value.all.stations.path = '/datasets/a.geojson'; },
    value => { value.all.railroads.count = -1; },
    value => { value.all.railroads.count = 1.5; },
    value => { value.all.railroads.count = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.periods = []; },
    value => { value.periods[0].startYear = 2; },
    value => { value.periods[1].startYear = 1; },
    value => { value.periods[2].startYear = 1949; },
    value => { value.periods[2].startYear = 1950.5; },
    value => { value.periods.at(-1).startYear = 10000; },
    value => { delete value.periods[1].stations; },
  ];
  for (const change of changes) {
    const index = structuredClone(manifest);
    change(index);
    const env = fixtureEnv({ index });
    assert.equal((await request('/api/stations?date=1966-01-01', env)).status, 500);
    assert.deepEqual(paths(env), [manifestPath]);
  }
});

test('failed dataset fetches retry without poisoning the successful manifest cache', async t => {
  t.mock.method(console, 'error', () => {});
  for (const failure of ['throw', '404', '206']) {
    let attempts = 0;
    const env = fixtureEnv({ fetchAsset(request) {
      if (attempts++ === 0) {
        if (failure === 'throw') throw new Error('temporary dataset failure');
        return new Response('missing or partial', { status: Number(failure) });
      }
      return new Response(assetBody(new URL(request.url).pathname));
    } });
    assert.equal((await request('/api/stations?date=1966-01-01', env)).status, 500, failure);
    const retry = await request('/api/stations?date=1966-01-01', env);
    assert.equal(retry.status, 200, failure);
    assert.equal(await retry.text(), assetBody(manifest.periods[1].stations.path));
    assert.equal(paths(env).filter(path => path === manifestPath).length, 1);
    assert.equal(attempts, 2);
  }
});

test('concurrent requests share one manifest and different asset bindings stay isolated', async () => {
  const env = fixtureEnv();
  const responses = await Promise.all([
    request('/api/railroads?date=1966-01-01', env),
    request('/api/stations?date=1966-01-01', env),
  ]);
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(paths(env).filter(path => path === manifestPath).length, 1);
  const otherIndex = structuredClone(manifest);
  otherIndex.periods[1].railroads = entry('9', 99);
  const otherEnv = fixtureEnv({ index: otherIndex });
  const other = await request('/api/railroads?date=1966-01-01', otherEnv);
  assert.equal(other.headers.get('X-Feature-Count'), '99');
  assert.equal(await other.text(), assetBody(entry('9', 99).path));
});

test('unsupported methods return Allow and static paths retain the original request', async () => {
  const env = fixtureEnv();
  const response = await request('/api/railroads', env, 'POST');
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('Allow'), 'GET, HEAD');
  assert.deepEqual(env.requests, []);
  const original = new Request('https://l3.063.jp/app.mjs?version=1');
  assert.equal(await (await worker.fetch(original, env)).text(), 'static asset');
  assert.equal(env.requests[0], original);
});
