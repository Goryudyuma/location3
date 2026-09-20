import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import worker from "./index.ts";
import { PayloadCache } from "./payload-cache.ts";

const railKey = "N05-24_RailroadSection2.geojson";
const stationKey = "N05-24_Station2.geojson";
const fixtures = new Map(await Promise.all([railKey, stationKey].map(async (key) => [
  key, await readFile(new URL(`../internal/server/testdata/${key}`, import.meta.url), "utf8"),
])));

function fixtureEnv(get) {
  const reads = [];
  return {
    reads,
    DATA_BUCKET: {
      async get(key) {
        reads.push(key);
        if (get) return get(key);
        return { text: async () => fixtures.get(key) };
      },
    },
    ASSETS: { fetch: async () => new Response("static asset") },
  };
}

function request(path, env, method = "GET") {
  return worker.fetch(new Request(`https://example.test${path}`, { method }), env);
}

test("dates are strict calendar dates, with no R2 reads for invalid input", async () => {
  const env = fixtureEnv();
  for (const date of ["0000-01-01", "1900-02-29", "2023-02-29", "2024-02-30", "2024-04-31", "2024-13-01", "2024-01-00", "2024-1-01", "2024-01-1", "2024", "2024-01-01T00:00:00Z", "not a date"]) {
    const response = await request(`/api/railroads?date=${encodeURIComponent(date)}`, env);
    assert.equal(response.status, 400, date);
  }
  assert.deepEqual(env.reads, []);
  for (const date of ["", "  ", " 2024-02-29 ", "2000-02-29", "0001-01-01", "9999-12-31"]) {
    const response = await request(`/api/railroads?date=${encodeURIComponent(date)}`, env);
    assert.equal(response.status, 200, date);
    assert.equal(response.headers.get("X-Filter-Year"), date.trim() ? String(Number(date.trim().slice(0, 4))) : null);
  }
});

test("year boundaries, sentinel values, and active railway names match the Go fixtures", async () => {
  const env = fixtureEnv();
  const cases = [
    ["/api/railroads", ["historic", "modern", "boundary", "unknown", "malformed"]],
    ["/api/railroads?date=1899-12-31", ["unknown", "malformed"]],
    ["/api/railroads?date=1900-01-01", ["historic", "unknown", "malformed"]],
    ["/api/railroads?date=1950-01-01", ["historic", "boundary", "unknown", "malformed"]],
    ["/api/railroads?date=1950-12-31", ["historic", "boundary", "unknown", "malformed"]],
    ["/api/railroads?date=1951-01-01", ["modern", "unknown", "malformed"]],
    ["/api/stations", ["old-station", "modern-station", "boundary-station", "orphan-station", "nameless-station", "closed-station"]],
    ["/api/stations?date=1899-01-01", []],
    ["/api/stations?date=1950-01-01", ["old-station", "boundary-station"]],
    ["/api/stations?date=1951-01-01", ["modern-station"]],
  ];
  for (const [path, ids] of cases) {
    const response = await request(path, env);
    assert.equal(response.status, 200, path);
    const body = await response.json();
    assert.deepEqual(body.features.map((feature) => feature.id), ids, path);
    assert.equal(body.type, "FeatureCollection");
    assert.ok(body.name);
    const historic = body.features.find((feature) => feature.id === "historic");
    if (historic) assert.equal(historic.sourceNote, "preserve foreign members");
    assert.equal(response.headers.get("X-Feature-Count"), String(ids.length));
    const head = await request(path, env, "HEAD");
    assert.equal(head.status, 200);
    assert.deepEqual([...head.headers], [...response.headers]);
    assert.equal(await head.text(), "");
  }
  assert.deepEqual(env.reads, [railKey, stationKey]);
});

test("failed R2 requests and malformed objects can be retried", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const firstResult of ["throw", "missing", "invalid JSON", "missing features"]) {
    let attempts = 0;
    const env = fixtureEnv(async (key) => {
      if (attempts++ === 0) {
        if (firstResult === "throw") throw new Error("temporary R2 failure");
        if (firstResult === "missing") return null;
        return { text: async () => firstResult === "invalid JSON" ? "broken JSON" : "{}" };
      }
      return { text: async () => fixtures.get(key) };
    });
    assert.equal((await request("/api/railroads?date=1950-01-01", env)).status, 500, firstResult);
    const retry = await request("/api/railroads?date=1950-01-01", env);
    assert.equal(retry.status, 200, firstResult);
    assert.equal((await retry.json()).features.length, 4);
    assert.equal(attempts, 2);
  }
});

test("station requests recover when the railway lookup fails", async (t) => {
  t.mock.method(console, "error", () => {});
  let railAttempts = 0;
  const env = fixtureEnv(async (key) => {
    if (key === railKey && railAttempts++ === 0) throw new Error("temporary railway failure");
    return { text: async () => fixtures.get(key) };
  });
  assert.equal((await request("/api/stations?date=1950-01-01", env)).status, 500);
  const retry = await request("/api/stations?date=1950-01-01", env);
  assert.equal(retry.status, 200);
  assert.deepEqual((await retry.json()).features.map((feature) => feature.id), ["old-station", "boundary-station"]);
  assert.deepEqual(env.reads, [stationKey, railKey, railKey]);
});

test("concurrent requests share a dataset load and separate bindings stay isolated", async () => {
  const env = fixtureEnv();
  const responses = await Promise.all(Array.from({ length: 5 }, () => request("/api/railroads?date=1950-01-01", env)));
  assert.ok(responses.every((response) => response.status === 200));
  assert.deepEqual(env.reads, [railKey]);

  const otherEnv = fixtureEnv(async () => ({ text: async () => '{"type":"FeatureCollection","features":[]}' }));
  const otherResponse = await request("/api/railroads?date=1950-01-01", otherEnv);
  assert.deepEqual((await otherResponse.json()).features, []);
  assert.deepEqual(otherEnv.reads, [railKey]);
});

test("GET and HEAD are supported and other paths are passed to static assets", async () => {
  const env = fixtureEnv();
  const response = await request("/api/railroads", env, "POST");
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "GET, HEAD");
  assert.deepEqual(env.reads, []);
  assert.equal(await (await request("/app.js", env)).text(), "static asset");
});

test("response cache evicts the least recently used year and respects the memory budget", () => {
  const payload = (body) => ({ body, count: 1 });
  const cache = new PayloadCache(2, 12);
  cache.set("1950", payload("ab"));
  cache.set("1960", payload("cd"));
  assert.equal(cache.get("1950").body, "ab");
  cache.set("1970", payload("ef"));
  assert.equal(cache.get("1960"), undefined);
  assert.equal(cache.get("1950").body, "ab");
  cache.set("1980", payload("abcde"));
  assert.equal(cache.get("1950"), undefined);
  assert.equal(cache.get("1970"), undefined);
  assert.equal(cache.get("1980").body, "abcde");
  cache.set("huge", payload("1234567"));
  assert.equal(cache.get("huge"), undefined);
  assert.equal(cache.get("1980").body, "abcde");
  cache.set("1980", payload("a"));
  cache.set("1990", payload("bcdef"));
  assert.equal(cache.get("1980").body, "a");
  assert.equal(cache.get("1990").body, "bcdef");
});
