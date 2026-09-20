import { MIN_YEAR, MAX_YEAR, DEFAULT_VIEW, readState, writeState } from './state.mjs';
import { createDatasetLoader, searchFeatures } from './data.mjs';
import { createRailwayMap } from './map.mjs';
import { createMobilePanel } from './mobile-panel.mjs';

const $ = id => document.getElementById(id);
const state = readState(window.location.search);
const loader = createDatasetLoader();
const numberFormat = new Intl.NumberFormat('ja-JP');
let railwayMap;
let mobilePanel;
let data;
let loadedYear;
let requestController;
let debounceTimer;
let messageTimer;
let requestGeneration = 0;
let searchMatches = [];

function eraLabel(year) {
  if (year === null) return 'すべての年代を重ねて表示';
  // Boundaries are expressed by calendar year, just like the dataset filter.
  if (year === 2019) return '平成31年 / 令和元年';
  if (year === 1989) return '昭和64年 / 平成元年';
  if (year > 2019) return `令和${year - 2018}年`;
  if (year > 1989) return `平成${year - 1988}年`;
  return `昭和${year - 1925}年`;
}

function updateYearControls() {
  const all = state.year === null;
  $('singleYear').hidden = all;
  $('allYearsLabel').hidden = !all;
  $('yearInput').value = state.year ?? MAX_YEAR;
  $('eraLabel').textContent = eraLabel(state.year);
  $('yearSlider').value = state.year ?? MAX_YEAR;
  $('yearSlider').style.setProperty('--progress', `${((state.year ?? MAX_YEAR) - MIN_YEAR) / (MAX_YEAR - MIN_YEAR) * 100}%`);
  $('yearSlider').setAttribute('aria-valuetext', all ? '全期間。操作すると年を選択します' : `${state.year}年`);
  $('previousYear').disabled = !all && state.year <= MIN_YEAR;
  $('nextYear').disabled = !all && state.year >= MAX_YEAR;
  $('previousDecade').disabled = !all && state.year <= MIN_YEAR;
  $('nextDecade').disabled = !all && state.year >= MAX_YEAR;
  $('allYears').setAttribute('aria-pressed', String(all));
  $('allYears').textContent = all ? '2024年に戻る' : '全期間を見る';
  document.querySelectorAll('[data-year]').forEach(button => {
    button.setAttribute('aria-pressed', String(Number(button.dataset.year) === state.year));
  });
}

function syncURL() {
  if (railwayMap) state.view = railwayMap.getView();
  const url = new URL(window.location.href);
  url.search = writeState(state).toString();
  history.replaceState(null, '', url);
}

function showMessage(message, { retry = false, temporary = false } = {}) {
  clearTimeout(messageTimer);
  $('messageText').textContent = message;
  $('retry').hidden = !retry;
  $('message').hidden = false;
  if (temporary) messageTimer = setTimeout(() => { $('message').hidden = true; }, 5000);
}

function setLoading(loading) {
  const displayYear = loading || !data ? state.year : loadedYear;
  const label = displayYear === null ? '全期間' : `${displayYear}年`;
  $('mapYear').textContent = loading && data && loadedYear !== state.year ? `${label}へ切替中` : `${label}の鉄道`;
  $('loadingIndicator').hidden = !loading;
  document.querySelector('.map-section').classList.toggle('is-loading', loading);
  $('map').setAttribute('aria-busy', String(loading));
  $('railCount').textContent = loading ? '—' : numberFormat.format(data?.railroads.features.length ?? 0);
  $('stationCount').textContent = loading ? '—' : numberFormat.format(data?.stations.features.length ?? 0);
}

function chooseYear(year, delayed = false) {
  clearTimeout(debounceTimer);
  state.year = year === null ? null : Math.max(MIN_YEAR, Math.min(MAX_YEAR, Math.trunc(year)));
  // Invalidate immediately, even while the next slider value is being debounced.
  requestController?.abort();
  requestGeneration++;
  updateYearControls();
  syncURL();
  setLoading(true);
  renderSearch();
  if (delayed) debounceTimer = setTimeout(loadData, 200);
  else loadData();
}

async function loadData() {
  if (!railwayMap) return;
  const generation = ++requestGeneration;
  requestController?.abort();
  const controller = new AbortController();
  requestController = controller;
  const requestedYear = state.year;
  setLoading(true);
  $('message').hidden = true;
  $('loadStatus').textContent = `${requestedYear === null ? '全期間' : `${requestedYear}年`}のデータを読み込んでいます`;
  try {
    const result = await loader.load(requestedYear, { signal: controller.signal });
    if (controller.signal.aborted || generation !== requestGeneration) return;
    await railwayMap.setData(result, controller.signal);
    if (controller.signal.aborted || generation !== requestGeneration) return;
    data = result;
    loadedYear = requestedYear;
    setLoading(false);
    renderSearch();
    const counts = `路線 ${numberFormat.format(data.railroads.features.length)}件、駅 ${numberFormat.format(data.stations.features.length)}件`;
    $('loadStatus').textContent = `${$('mapYear').textContent}。${counts}`;
    if (!data.railroads.features.length && !data.stations.features.length) {
      showMessage('この年代のデータはありません。別の年を選んでみてください。');
    }
  } catch (error) {
    if (controller.signal.aborted || generation !== requestGeneration) return;
    console.error('Dataset load failed:', error);
    setLoading(false);
    $('loadStatus').textContent = 'データを読み込めませんでした';
    showMessage('データを読み込めませんでした。通信状況を確認して再試行してください。', { retry: true });
  }
}

function setLayers() {
  state.railroads = $('railroadsToggle').checked;
  state.stations = $('stationsToggle').checked;
  railwayMap?.setVisibility(state);
  syncURL();
  if (!state.railroads && !state.stations) showMessage('路線と駅の表示をオフにしています。', { temporary: true });
}

function renderSearch() {
  const query = $('searchInput').value.trim();
  $('clearSearch').hidden = !query;
  $('searchResults').replaceChildren();
  searchMatches = [];
  if (loadedYear !== state.year || !data) {
    $('searchHint').textContent = 'データの読み込み後に検索できます';
    return;
  }
  if (!query) {
    $('searchHint').textContent = `${state.year === null ? '全期間' : `${state.year}年`}の駅・路線から探せます`;
    return;
  }
  searchMatches = searchFeatures(data, query);
  $('searchHint').textContent = searchMatches.length ? `候補 ${searchMatches.length}件 · 選ぶと地図で表示` : '見つかりませんでした。別の名前や年代をお試しください。';
  for (const [index, result] of searchMatches.entries()) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'search-result';
    button.dataset.result = String(index);
    const kind = document.createElement('span');
    kind.className = 'result-kind';
    kind.textContent = result.kind === 'station' ? '駅' : '路線';
    const content = document.createElement('span');
    content.className = 'result-content';
    const name = document.createElement('span');
    name.className = 'result-name';
    name.textContent = result.name;
    const detail = document.createElement('span');
    detail.className = 'result-detail';
    detail.textContent = [result.kind === 'station' ? result.line : '', result.operator].filter(Boolean).join(' · ');
    content.append(name, detail);
    button.append(kind, content);
    item.append(button);
    $('searchResults').append(item);
  }
}

function selectResult(index) {
  const result = searchMatches[index];
  if (!result) return;
  if (result.kind === 'station') $('stationsToggle').checked = true;
  else $('railroadsToggle').checked = true;
  setLayers();
  $('searchInput').blur();
  mobilePanel.close();
  // Allow the map's ResizeObserver to see the closed panel before fitting.
  requestAnimationFrame(() => requestAnimationFrame(() => railwayMap.focusResult(result)));
}

async function shareMap() {
  syncURL();
  const url = window.location.href;
  if (navigator.share) {
    try {
      await navigator.share({ title: '鉄道の時間地図', url });
      return;
    } catch (error) {
      if (error.name === 'AbortError') return;
    }
  }
  $('shareUrl').value = url;
  $('copyStatus').textContent = '';
  $('shareDialog').showModal();
}

function bindEvents() {
  $('yearSlider').addEventListener('input', event => chooseYear(Number(event.target.value), true));
  $('yearSlider').addEventListener('change', event => chooseYear(Number(event.target.value)));
  $('yearInput').addEventListener('change', event => {
    const value = Number(event.target.value);
    if (event.target.value.trim() === '' || !Number.isFinite(value)) updateYearControls();
    else chooseYear(value);
  });
  $('yearInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') event.target.blur();
  });
  $('previousYear').addEventListener('click', () => chooseYear((state.year ?? MAX_YEAR) - 1));
  $('nextYear').addEventListener('click', () => chooseYear((state.year ?? MAX_YEAR - 1) + 1));
  $('previousDecade').addEventListener('click', () => chooseYear((state.year ?? MAX_YEAR) - 10));
  $('nextDecade').addEventListener('click', () => chooseYear((state.year ?? MAX_YEAR - 10) + 10));
  $('allYears').addEventListener('click', () => chooseYear(state.year === null ? MAX_YEAR : null));
  document.querySelectorAll('[data-year]').forEach(button => button.addEventListener('click', () => chooseYear(Number(button.dataset.year))));
  $('railroadsToggle').addEventListener('change', setLayers);
  $('stationsToggle').addEventListener('change', setLayers);
  $('searchInput').addEventListener('input', renderSearch);
  $('searchInput').addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && searchMatches.length) selectResult(0);
    if (event.key === 'ArrowDown') { event.preventDefault(); $('searchResults').querySelector('button')?.focus(); }
    if (event.key === 'Escape') { $('searchInput').value = ''; renderSearch(); }
  });
  $('searchResults').addEventListener('click', event => {
    const button = event.target.closest('[data-result]');
    if (button) selectResult(Number(button.dataset.result));
  });
  $('clearSearch').addEventListener('click', () => {
    $('searchInput').value = '';
    renderSearch();
    $('searchInput').focus();
  });
  $('retry').addEventListener('click', loadData);
  $('resetView').addEventListener('click', () => railwayMap.resetView());
  $('zoomIn').addEventListener('click', () => railwayMap.zoomIn());
  $('zoomOut').addEventListener('click', () => railwayMap.zoomOut());
  $('locate').addEventListener('click', () => {
    if (!navigator.geolocation) { showMessage('このブラウザでは現在地を取得できません。', { temporary: true }); return; }
    $('locate').disabled = true;
    showMessage('現在地を確認しています…');
    navigator.geolocation.getCurrentPosition(position => {
      $('locate').disabled = false;
      $('message').hidden = true;
      railwayMap.showLocation(position.coords.latitude, position.coords.longitude);
    }, () => {
      $('locate').disabled = false;
      showMessage('現在地を取得できませんでした。ブラウザの位置情報設定をご確認ください。', { temporary: true });
    }, { timeout: 10000, maximumAge: 60000 });
  });
  $('share').addEventListener('click', shareMap);
  $('copyLink').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('shareUrl').value);
      $('copyStatus').textContent = 'リンクをコピーしました';
    } catch {
      $('shareUrl').select();
      $('copyStatus').textContent = '選択したリンクをコピーしてください';
    }
  });
}

function init() {
  mobilePanel = createMobilePanel();
  updateYearControls();
  $('railroadsToggle').checked = state.railroads;
  $('stationsToggle').checked = state.stations;
  if (!window.L) {
    showMessage('地図を読み込めませんでした。通信状況を確認してページを再読み込みしてください。');
    document.querySelectorAll('button, input').forEach(control => { control.disabled = true; });
    return;
  }
  railwayMap = createRailwayMap($('map'), state.view ?? DEFAULT_VIEW, view => {
    state.view = view;
    syncURL();
  });
  railwayMap.setVisibility(state);
  if (!state.view) railwayMap.resetView();
  bindEvents();
  syncURL();
  loadData();
}

// Both the CDN script and module must finish before map initialization.
if (document.readyState === 'complete') init();
else window.addEventListener('load', init, { once: true });
