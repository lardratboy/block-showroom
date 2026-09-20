/* TABS — the bottom panel's tab strip. Pure DOM: every `.tab` button
   shows the `.page` whose data-page matches its data-tab. The last tab is
   remembered in localStorage so a reload lands where you were; storage
   may be unavailable (private window), so every access is guarded. */
const STORAGE_KEY = 'showroom.panelTab';

export function initTabs(panel){
  const tabs  = [...panel.querySelectorAll('.tab')];
  const pages = [...panel.querySelectorAll('.page')];

  function show(name){
    tabs.forEach(t => {
      const on = t.dataset.tab === name;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    pages.forEach(p => p.classList.toggle('on', p.dataset.page === name));
    try { localStorage.setItem(STORAGE_KEY, name); } catch (_) { /* storage blocked */ }
  }

  tabs.forEach(t => t.addEventListener('click', () => show(t.dataset.tab)));

  let initial = tabs[0].dataset.tab;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (tabs.some(t => t.dataset.tab === saved)) initial = saved;
  } catch (_) { /* storage blocked */ }
  show(initial);
  return show;
}
