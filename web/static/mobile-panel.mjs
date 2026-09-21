const COMPACT_MEDIA = '(max-width: 760px), (max-height: 550px) and (orientation: landscape)';

/** Share the same controls between the desktop sidebar and the mobile dialog. */
export function createMobilePanel() {
  const $ = id => document.getElementById(id);
  const dialog = $('mobilePanel');
  const media = window.matchMedia(COMPACT_MEDIA);
  const openers = { search: $('openSearch'), settings: $('openSettings') };
  const searchContent = $('mobileSearchContent');
  const settingsContent = $('mobileSettingsContent');
  const searchInput = $('searchInput');
  const closeButton = $('closeMobilePanel');
  const placements = [
    ['.search-section', searchContent],
    ['.layers-section', settingsContent],
    ['.offline-section', settingsContent],
    ['.data-note', settingsContent],
    ['.year-presets', $('mobileYearPresets')],
    ['#allYears', $('mobileAllYearsSlot')],
  ].map(([selector, destination]) => {
    const node = document.querySelector(selector);
    const placeholder = document.createComment(`Desktop position: ${selector}`);
    node.before(placeholder);
    return { node, placeholder, destination };
  });
  let compact;
  let opener;
  let layoutWidth = window.innerWidth;

  function updateViewport() {
    const viewport = window.visualViewport;
    dialog.style.setProperty('--visual-height', `${viewport?.height ?? window.innerHeight}px`);
    dialog.style.setProperty('--visual-top', `${viewport?.offsetTop ?? 0}px`);
  }

  function resetExpanded() {
    Object.values(openers).forEach(button => button.setAttribute('aria-expanded', 'false'));
  }

  function restoreFocus() {
    // Never restore focus to the moved search input: that would reopen the keyboard.
    if (dialog.contains(document.activeElement)) document.activeElement.blur();
    if (media.matches && opener && !opener.disabled) opener.focus({ preventScroll: true });
  }

  function close() {
    if (!dialog.open) return;
    if (dialog.contains(document.activeElement)) document.activeElement.blur();
    dialog.close();
    resetExpanded();
    restoreFocus();
  }

  function updateLayout() {
    updateViewport();
    const widthChanged = window.innerWidth !== layoutWidth;
    layoutWidth = window.innerWidth;
    if (compact === media.matches && !widthChanged) return;
    // Height-only resizes include the software keyboard; keep the dialog open then.
    close();
    compact = media.matches;
    for (const { node, placeholder, destination } of placements) {
      if (compact) destination.append(node);
      else placeholder.after(node);
    }
  }

  function open(mode) {
    if (!media.matches) return;
    opener = openers[mode];
    searchContent.hidden = mode !== 'search';
    settingsContent.hidden = mode !== 'settings';
    $('mobilePanelTitle').textContent = mode === 'search' ? '駅・路線を探す' : '表示・保存';
    resetExpanded();
    opener.setAttribute('aria-expanded', 'true');
    updateViewport();
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('.mobile-panel-content').scrollTop = 0;
    // Keep focus inside this user gesture so mobile browsers can open the keyboard.
    if (mode === 'search') searchInput.focus({ preventScroll: true });
    else closeButton.focus({ preventScroll: true });
  }

  openers.search.addEventListener('click', () => open('search'));
  openers.settings.addEventListener('click', () => open('settings'));
  closeButton.addEventListener('click', close);
  $('backToMap').addEventListener('click', close);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    resetExpanded();
    restoreFocus();
  });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
  });
  media.addEventListener('change', updateLayout);
  window.addEventListener('resize', updateLayout);
  window.addEventListener('orientationchange', () => { close(); updateLayout(); });
  window.visualViewport?.addEventListener('resize', updateViewport);
  window.visualViewport?.addEventListener('scroll', updateViewport);
  resetExpanded();
  updateLayout();

  return { close, isCompact: () => media.matches };
}
