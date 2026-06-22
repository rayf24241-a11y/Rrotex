(() => {
  'use strict';

  const redirect = () => {
    try { document.body.innerHTML = ''; } catch {}
    window.location.replace('/');
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
