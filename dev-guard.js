(() => {
  'use strict';

  // Local development only: never blank/redirect on localhost so the app is
  // debuggable while building it. Production (www.rrotex.com) is unaffected
  // and stays fully protected.
  const host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === '') return;

  const redirect = () => {
    // Blank the page hard so nothing sensitive stays inspectable.
    try { document.documentElement.innerHTML = '<body style="margin:0;background:#05070c"></body>'; } catch {}
    try { window.stop(); } catch {}
    // Only navigate away from sub-pages. On the home page ('/') a
    // location.replace('/') would reload into this same guard and loop
    // forever while devtools stays open, so there we just leave it blanked.
    const atRoot = location.pathname === '/' || /\/(index|app)\.html?$/i.test(location.pathname);
    if (!atRoot) { try { window.location.replace('/'); } catch {} }
  };

  // ── Block right-click context menu ──────────────────────────────
  document.addEventListener('contextmenu', e => { e.preventDefault(); return false; }, true);

  // ── Block dev-tool keyboard shortcuts ───────────────────────────
  document.addEventListener('keydown', e => {
    const c = e.ctrlKey || e.metaKey;
    const s = e.shiftKey;
    const a = e.altKey;
    const k = e.key;
    if (k === 'F12') { e.preventDefault(); e.stopPropagation(); return false; }
    if (c && s && /^[ijcIJC]$/.test(k)) { e.preventDefault(); e.stopPropagation(); return false; }
    if (c && a && /^[ijcIJC]$/.test(k)) { e.preventDefault(); e.stopPropagation(); return false; }
    if (c && /^[uU]$/.test(k)) { e.preventDefault(); e.stopPropagation(); return false; }
  }, true);

  // ── Window size check (catches docked devtools) ─────────────────
  const sizeCheck = () => {
    if (window.outerWidth - window.innerWidth > 160 || window.outerHeight - window.innerHeight > 160) {
      redirect();
    }
  };
  setInterval(sizeCheck, 1000);
  window.addEventListener('resize', sizeCheck);

  // ── Debugger timing (catches undocked devtools too) ─────────────
  // When devtools is open the JS engine pauses on `debugger`, making
  // the loop iteration take >100 ms. When closed it's a no-op (<1 ms).
  setInterval(() => {
    const t = performance.now();
    // eslint-disable-next-line no-debugger
    debugger;
    if (performance.now() - t > 100) redirect();
  }, 1000);

  // ── Console element getter (catches console panel being open) ────
  const _el = new Image();
  Object.defineProperty(_el, 'id', {
    get() { redirect(); return ''; },
  });
  setInterval(() => {
    console.log('%c', _el);
    console.clear();
  }, 2000);
})();
