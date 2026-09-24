import assert from 'node:assert/strict';
import test from 'node:test';
import { stationChoices } from '../web/static/station-selection.mjs';

const station = (line, coordinates = [139.766685, 35.680965], properties = {}) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates },
  properties: { N05_011: '東京', N05_002: line, N05_003: '運営者', N05_005b: '1950', N05_005e: '9999', ...properties },
});

test('coincident routes remain selectable while duplicates and nearby stations are excluded', () => {
  const first = station('東北線');
  const second = station('東海道線');
  const nearby = station('別の駅', [139.7668, 35.681]);
  const duplicate = structuredClone(first);
  assert.deepEqual(stationChoices(first, [second, duplicate, first, nearby]), [duplicate, second]);
});

test('rendered points resolve to their original coordinates before grouping', () => {
  const first = station('東北線');
  const second = station('東海道線');
  const rendered = station('東北線', [139.7667, 35.681]);
  assert.deepEqual(stationChoices(rendered, [first, second]), [first, second]);
  assert.deepEqual(stationChoices(first, [first, second]), [first, second], 'search uses the same choices before tiles render');
});

test('multiple points on one route resolve to the closest original station location', () => {
  const near = station('東海道線');
  const other = station('東海道線', [139.765384, 35.681732]);
  const shared = station('東北線');
  assert.deepEqual(stationChoices(station('東海道線', [139.7667, 35.681]), [other, near, shared]), [near, shared]);
});

test('world copies and tiny coordinate differences do not hide coincident choices', () => {
  const first = station('東北線');
  const second = station('東海道線', [139.766687, 35.680967]);
  const rendered = station('東北線', [139.766685 + 360, 35.680965]);
  assert.deepEqual(stationChoices(rendered, [first, second]), [first, second]);
});

test('different historical periods and operators remain separate choices', () => {
  const old = station('路線', undefined, { N05_005e: '2003', N05_003: '旧運営者' });
  const current = station('路線', undefined, { N05_005b: '2004' });
  const period = station('路線', undefined, { N05_005b: '1980' });
  assert.deepEqual(stationChoices(current, [old, current, period]), [current, old, period]);
});

test('missing or non-point features do not enter a station choice list', () => {
  const first = station('東北線');
  const line = { geometry: { type: 'LineString', coordinates: [[139, 35], [140, 36]] } };
  assert.deepEqual(stationChoices(first, [null, line, station('invalid', [NaN, 35])]), [first]);
  assert.deepEqual(stationChoices(line, [first]), []);
});
