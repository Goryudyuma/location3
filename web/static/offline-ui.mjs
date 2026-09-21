import { planRegion, listPacks, downloadPack, removePack } from './offline-store.mjs';
import { invalidateBasemapCache, savedMapsOnly, setSavedMapsOnly } from './basemap.mjs';
import { boundsCovered } from './offline-coverage.mjs';

const MAX_PACK_BYTES = 200 * 1024 * 1024;
const mb = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function createOfflineControls(map, { closePanel, reloadData }) {
  const $ = id => document.getElementById(id);
  let plan;
  let preparing = 0;
  let controller;
  let packs = [];
  let registration;
  let updatePending = false;
  let failedBackground = false;
  const supported = 'serviceWorker' in navigator && 'caches' in globalThis && window.isSecureContext;

  function status(text) { $('offlineStatus').textContent = text; }

  function updateView() {
    const localOnly = savedMapsOnly() || navigator.onLine === false;
    const bounds = map.getBounds();
    const view = map.getView();
    const regions = packs.flatMap(pack => pack.archives).filter(a => a.regionKey);
    const inRegion = boundsCovered(bounds, regions.map(a => a.bounds));
    const badge = $('offlineBadge');
    badge.hidden = !localOnly && !failedBackground;
    badge.textContent = failedBackground && !localOnly ? '背景地図の通信を確認してください' : packs.length === 0 ? 'オフライン用の保存がありません' : view.zoom <= 8 || inRegion ? '保存した地図を表示中' : '保存範囲外の詳細地図は表示できません';
  }

  function busy(value) {
    $('prepareOffline').disabled = value || !supported;
    $('saveOffline').disabled = value;
    $('offlineName').disabled = value;
    $('offlineProgress').hidden = !value;
    $('offlinePacks').querySelectorAll('button').forEach(button => { button.disabled = value; });
  }

  async function renderPacks() {
    packs = await listPacks();
    $('offlinePacks').replaceChildren();
    for (const pack of packs) {
      const item = document.createElement('li');
      const info = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = pack.name;
      const size = document.createElement('span');
      size.className = 'hint';
      size.textContent = `${mb(pack.bytes)} · 全年代に対応`;
      info.append(name, size);
      const buttons = document.createElement('div');
      buttons.className = 'offline-pack-actions';
      const show = document.createElement('button');
      show.type = 'button'; show.className = 'button'; show.textContent = '地図へ';
      show.setAttribute('aria-label', `${pack.name}の地図を表示`);
      show.addEventListener('click', () => { closePanel(); map.fitBounds(pack.bounds); });
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'button'; remove.textContent = '削除';
      remove.setAttribute('aria-label', `${pack.name}の保存を削除`);
      remove.addEventListener('click', async () => {
        busy(true);
        try {
          await removePack(pack.id);
          invalidateBasemapCache();
          map.refreshBasemap();
          await renderPacks();
          plan = undefined;
          $('offlinePlan').hidden = true;
          status(`${pack.name}の保存を削除しました。`);
          reloadData();
        } catch (error) { status(error.message); }
        finally { busy(false); }
      });
      buttons.append(show, remove);
      item.append(info, buttons);
      $('offlinePacks').append(item);
    }
    updateView();
  }

  async function shellReady() {
    if (!supported) throw new Error('このブラウザでは保存機能が使えません。ChromeやSafariの通常モードで開いてください。');
    registration ??= navigator.serviceWorker.register('/service-worker.mjs', { type: 'module', updateViaCache: 'none' }).catch(error => { registration = undefined; throw error; });
    await registration;
    let timeout;
    const ready = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('画面の保存がまだ終わっていません。通信を確認してもう一度お試しください。')), 20000); }),
    ]).finally(() => clearTimeout(timeout));
    // An active worker alone is insufficient: the browser may have evicted its cache.
    await new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const finish = error => { clearTimeout(timeout); channel.port1.close(); error ? reject(error) : resolve(); };
      timeout = setTimeout(() => finish(new Error('画面の保存を確認できませんでした。ページを更新して再試行してください。')), 20000);
      channel.port1.onmessage = event => finish(event.data?.ok ? undefined : new Error(event.data?.error || '画面を保存できませんでした。通信状況を確認して再試行してください。'));
      ready.active.postMessage({ type: 'ENSURE_SHELL' }, [channel.port2]);
    });
  }

  $('prepareOffline').addEventListener('click', async () => {
    const generation = ++preparing;
    $('offlinePlan').hidden = true;
    $('prepareOffline').disabled = true;
    status('保存する範囲と容量を確認しています…');
    try {
      await shellReady();
      const candidate = await planRegion(map.getBounds());
      if (generation !== preparing) return;
      if (candidate.bytes > MAX_PACK_BYTES) throw new Error('この範囲は大きいため、地図を拡大して保存する地域を絞ってください（1地域200 MBまで）。');
      plan = candidate;
      const view = map.getView();
      $('offlineName').value = `北緯${view.lat.toFixed(2)}・東経${view.lng.toFixed(2)} 周辺`;
      $('offlineSize').textContent = `保存容量 ${mb(plan.bytes)}${Number.isFinite(plan.downloadBytes) ? ` ／ 追加ダウンロード ${mb(plan.downloadBytes)}` : ''}`;
      $('offlinePlan').hidden = false;
      status('この範囲でよければ、名前を付けて保存してください。');
      $('offlineName').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (error) { status(error.message); }
    finally { $('prepareOffline').disabled = !supported; }
  });

  $('saveOffline').addEventListener('click', async () => {
    if (!plan || controller) return;
    controller = new AbortController();
    busy(true);
    $('offlineProgressBar').value = 0;
    try {
      await shellReady();
      const saved = await downloadPack(plan, {
        name: $('offlineName').value.trim() || '保存した地域', signal: controller.signal,
        onProgress: progress => {
          $('offlineProgressBar').value = progress.totalBytes ? Math.min(1, progress.loadedBytes / progress.totalBytes) : 0;
          status(`保存中 ${mb(progress.loadedBytes)} / ${mb(progress.totalBytes)}。この画面を開いたままお待ちください。`);
        },
      });
      plan = undefined;
      $('offlinePlan').hidden = true;
      invalidateBasemapCache();
      failedBackground = false;
      await renderPacks();
      map.refreshBasemap();
      reloadData();
      status(`${saved.name}を保存しました。圏外でも地図・年代切替・駅検索を使えます。`);
    } catch (error) {
      status(error.name === 'AbortError' ? '保存を中止しました。保存済みの地域はそのまま使えます。' : error.message);
    } finally {
      controller = undefined;
      busy(false);
      if (updatePending) location.reload();
    }
  });
  $('cancelOffline').addEventListener('click', () => controller?.abort());
  $('savedMapsOnly').checked = savedMapsOnly();
  $('savedMapsOnly').addEventListener('change', () => {
    setSavedMapsOnly($('savedMapsOnly').checked);
    failedBackground = false;
    invalidateBasemapCache();
    map.refreshBasemap();
    updateView();
  });
  window.addEventListener('online', () => { failedBackground = false; map.refreshBasemap(); updateView(); });
  window.addEventListener('offline', updateView);
  window.addEventListener('basemap-unavailable', () => { failedBackground = true; updateView(); });
  // A new shell version is installed atomically; reload to keep modules consistent.
  let previousController = navigator.serviceWorker?.controller;
  navigator.serviceWorker?.addEventListener('controllerchange', () => {
    const nextController = navigator.serviceWorker.controller;
    if (previousController && nextController !== previousController) {
      if (controller) updatePending = true;
      else location.reload();
    }
    previousController = nextController;
  });
  if (supported) shellReady().catch(() => status('画面の保存を準備できませんでした。通信を確認して「この周辺を保存」をお試しください。'));
  else { $('prepareOffline').disabled = true; status('このブラウザではオフライン保存を利用できません。'); }
  renderPacks().catch(() => status('ブラウザの保存領域を利用できません。通常モードでお試しください。'));
  return { updateView };
}
