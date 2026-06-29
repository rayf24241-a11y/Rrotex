/* ROTEX desktop — persist sign-in across updates (localStorage + file backup) */
(function () {
  'use strict';
  const KEY = 'rotex_desktop_auth';
  const MIRROR = 'rotex_desktop_auth_mirror';

  function persist(auth) {
    if (!auth?.uid) return null;
    const data = {
      uid: String(auth.uid),
      email: String(auth.email || ''),
      name: String(auth.name || auth.displayName || ''),
      exp: String(Date.now() + 365 * 24 * 60 * 60 * 1000),
      token: String(auth.token || ''),
      refreshToken: String(auth.refreshToken || ''),
    };
    const serialized = JSON.stringify(data);
    try {
      localStorage.setItem(KEY, serialized);
      localStorage.setItem(MIRROR, serialized);
    } catch {}
    if (window.rotexDesktop?.persistDesktopAuth) {
      window.rotexDesktop.persistDesktopAuth(data).catch(() => {});
    }
    return data;
  }

  function restoreSync() {
    let raw = null;
    try { raw = localStorage.getItem(KEY); } catch {}
    if (!raw) {
      try { raw = localStorage.getItem(MIRROR); } catch {}
    }
    if (!raw) return null;
    try {
      const auth = JSON.parse(raw);
      if (!auth?.uid) return null;
      return persist(auth);
    } catch {
      return null;
    }
  }

  async function ensureRestored() {
    const cached = restoreSync();
    if (cached?.uid) return cached;
    if (window.rotexDesktop?.getAuthBackup) {
      try {
        const fileAuth = await window.rotexDesktop.getAuthBackup();
        if (fileAuth?.uid) return persist(fileAuth);
      } catch {}
    }
    return restoreSync();
  }

  window.rotexDesktopAuth = { persist, restore: restoreSync, ensureRestored };
})();
