// The service worker (sw.js, written by tools/build-sw.mjs) and its update
// screen. When a new version of the app is installing over one that's already
// installed, an "Updating" card covers the app while the worker saves the new
// files for offline play: a cartridge fills as the files come in (the worker
// reports its progress), then it says "Updated" and fades. A first install
// (nothing cached yet) happens quietly behind the normal loading screen.

export function registerServiceWorker(appName) {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const sw = navigator.serviceWorker;
  const updating = !!sw.controller;                // an installed copy is running this page: a new worker is an update
  let card = null, giveUp = 0;

  const show = () => {
    if (card || !updating) return;
    card = document.createElement('div');
    card.id = 'updating';
    card.setAttribute('role', 'status');
    card.setAttribute('aria-live', 'polite');
    card.innerHTML = `<div class="card">
        <div class="update-cart"><div class="update-fill"></div><div class="update-label"></div></div>
        <div class="label">Updating</div>
        <div class="name"></div>
        <div class="detail">Saving the new version for offline play</div>
        <div class="bar"><div></div></div>
      </div>`;
    card.querySelector('.name').textContent = appName;
    document.body.append(card);
    requestAnimationFrame(() => card.classList.add('show'));
    giveUp = setTimeout(() => finish(false), 60000);   // never cover the app for long if something stalls
  };

  const progress = (done, total) => {
    show();
    if (!card || !total) return;
    const f = Math.min(1, done / total);
    card.querySelector('.update-fill').style.transform = `scaleY(${f})`;
    card.querySelector('.bar > div').style.transform = `scaleX(${f})`;
    card.querySelector('.detail').textContent = `Saving the new version for offline play · ${done} of ${total}`;
  };

  const finish = (ok) => {
    if (!card) return;
    clearTimeout(giveUp);
    const c = card;
    card = null;
    if (ok) {
      c.classList.add('done');
      c.querySelector('.label').textContent = 'Updated';
      c.querySelector('.detail').textContent = 'Ready, online or off';
      progressDone(c);
      setTimeout(() => c.classList.remove('show'), 900);
    } else c.classList.remove('show');
    setTimeout(() => c.remove(), 1300);
  };
  const progressDone = (c) => {
    c.querySelector('.update-fill').style.transform = 'scaleY(1)';
    c.querySelector('.bar > div').style.transform = 'scaleX(1)';
  };

  // The worker posts { type: 'sw-progress', done, total } while it installs and 'sw-active' when it takes over.
  sw.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'sw-progress') progress(m.done, m.total);
    else if (m.type === 'sw-active') finish(true);
  });

  const register = () => sw.register('sw.js').then((reg) => {
    const watch = (w) => {
      if (!w) return;
      show();
      w.addEventListener('statechange', () => {
        if (w.state === 'activated') finish(true);
        else if (w.state === 'redundant') finish(false);   // the update failed (offline partway): carry on as before
      });
    };
    watch(reg.installing);
    reg.addEventListener('updatefound', () => watch(reg.installing));
  }).catch(() => {});
  if (document.readyState === 'complete') register(); else window.addEventListener('load', register);
}
