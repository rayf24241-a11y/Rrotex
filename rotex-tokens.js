/* ROTEX — TexToken balance: purchased wallet + free daily allowance (display total) */
(function () {
  'use strict';

  // Internal units. 1 displayed TexToken = 30,000 internal units (matches
  // TT_UNIT in api/chat.js). All math/storage stays internal; only formatTT
  // converts for display, so every balance readout site-wide re-denominated
  // in one place.
  var TT_UNIT = 30000;
  var FREE_DAILY_BASE = 30 * TT_UNIT;   // "30 TexTokens/day"
  var PRO_DAILY_BASE  = 100 * TT_UNIT;  // "100 TexTokens/day"
  var FREE_MONTHLY    = 200 * TT_UNIT;  // "200 TexTokens/month"
  var PRO_MONTHLY     = 1000 * TT_UNIT; // "1000 TexTokens/month" (profit-guard ceiling)

  // Keep in sync with USAGE_EPOCH in api/chat.js. When the server-side usage
  // is reset for everyone (epoch bump), browsers still hold the OLD local
  // spent-today counter -- which made balances show 0 right after a reset.
  // Clearing the local counter once per epoch makes the display reflect the
  // reset immediately, even before the server sync lands.
  var SPEND_EPOCH = 'r4';
  try {
    if (localStorage.getItem('rotex_spend_epoch') !== SPEND_EPOCH) {
      localStorage.removeItem('rotex_textokens_spent_today');
      localStorage.removeItem('rotex_textokens_spent_date');
      localStorage.setItem('rotex_spend_epoch', SPEND_EPOCH);
    }
  } catch (_) {}

  // Matches the server's _dayKey()/_today() exactly (api/chat.js): UTC
  // calendar date, not the browser's local timezone. This local fallback
  // path (used only when window.__rotexServerUsage isn't populated yet)
  // previously used toDateString() -- local time -- which rolls over at a
  // different moment than the server's UTC-based reset, so the free
  // allowance could appear to refill at an inconsistent time depending on
  // the user's timezone instead of a single, predictable clock time for
  // everyone.
  function _utcDayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  function isProUser() {
    try {
      var pass = localStorage.getItem('rotex_pro_pass') || '';
      if (!pass) return false;
      var body = pass.split('.', 2)[0];
      var payload = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
      return payload && payload.plan === 'pro' && Number(payload.exp) > Date.now();
    } catch (_) { return false; }
  }

  function getDailyAllowance() {
    return isProUser() ? PRO_DAILY_BASE : FREE_DAILY_BASE;
  }

  // Converts an INTERNAL amount to displayed TexTokens ("5", "3.2", "0.4").
  // One decimal below 100, whole numbers above; sub-0.05 non-zero amounts
  // show as "0.1" so a real remaining balance never displays as zero.
  function formatTT(n) {
    n = Math.max(0, Number(n) || 0);
    var tt = n / TT_UNIT;
    if (tt === 0) return '0';
    if (tt >= 100) return String(Math.round(tt));
    var s = (Math.max(tt, 0.1)).toFixed(1).replace(/\.0$/, '');
    return s;
  }

  function getPurchased() {
    return Math.max(0, Math.floor(Number(localStorage.getItem('rotex_textokens_balance') || 0)));
  }

  // Server-authoritative usage (set by editor.html's billing sync), or null.
  function getServerUsage() {
    var u = window.__rotexServerUsage;
    return (u && typeof u === 'object') ? u : null;
  }

  function getSpentToday() {
    var su = getServerUsage();
    if (su) return Math.max(0, Math.floor(Number(su.dayUsed) || 0));
    var today = _utcDayKey();
    var spentDate = localStorage.getItem('rotex_textokens_spent_date');
    return spentDate === today ? Math.max(0, Math.floor(Number(localStorage.getItem('rotex_textokens_spent_today') || 0))) : 0;
  }

  function getFreeRemaining() {
    return Math.max(0, getDailyAllowance() - getSpentToday());
  }

  // Monthly remaining, from the server. Free: 25 TT/month. Pro: 350 TT/month.
  // Returns null if server usage is unknown.
  function getMonthlyRemaining() {
    var su = getServerUsage();
    if (!su) return null;
    var limit = isProUser() ? (Number(su.proMonthly) || PRO_MONTHLY) : (Number(su.freeMonthly) || FREE_MONTHLY);
    return Math.max(0, limit - (Number(su.monthUsed) || 0));
  }

  function getTotalAvailable() {
    return getFreeRemaining() + getPurchased();
  }

  function savePurchased(balance) {
    var bal = Math.max(0, Math.floor(Number(balance) || 0));
    localStorage.setItem('rotex_textokens_balance', String(bal));
    if (window.rotexDesktop && window.rotexDesktop.saveTokensBackup) {
      window.rotexDesktop.saveTokensBackup(bal).catch(function () {});
    }
    refreshBalanceDisplay();
  }

  function spend(amount) {
    var charge = Math.max(0, Math.ceil(Number(amount) || 0));
    if (!charge) {
      refreshBalanceDisplay();
      return { charged: 0, freeSpent: 0, purchasedSpent: 0, purchased: getPurchased(), freeRemaining: getFreeRemaining() };
    }

    var today = _utcDayKey();
    var currentSpent = getSpentToday();
    var dailyAllowance = getDailyAllowance();
    var freeRemaining = Math.max(0, dailyAllowance - currentSpent);
    var freeSpend = Math.min(charge, freeRemaining);
    var purchasedSpend = Math.max(0, charge - freeSpend);
    var nextSpent = currentSpent + freeSpend;
    var nextPurchased = Math.max(0, getPurchased() - purchasedSpend);

    localStorage.setItem('rotex_textokens_spent_date', today);
    localStorage.setItem('rotex_textokens_spent_today', String(nextSpent));
    savePurchased(nextPurchased);
    refreshBalanceDisplay();

    return {
      charged: charge,
      freeSpent: freeSpend,
      purchasedSpent: purchasedSpend,
      purchased: nextPurchased,
      freeRemaining: getFreeRemaining(),
    };
  }

  async function syncFromBackup() {
    var localBal = getPurchased();
    if (window.rotexDesktop && window.rotexDesktop.getTokensBackup) {
      try {
        var fileBal = await window.rotexDesktop.getTokensBackup();
        var best = Math.max(fileBal || 0, localBal);
        if (best !== localBal) savePurchased(best);
        else if (localBal > (fileBal || 0)) savePurchased(localBal);
        return best;
      } catch (_) {}
    }
    return localBal;
  }

  function refreshBalanceDisplay() {
    var el = document.getElementById('rxTokenBalance');
    if (!el) return;
    var free = getFreeRemaining();
    var purchased = getPurchased();
    var total = free + purchased;
    el.textContent = formatTT(total) + ' TT';
    var monthly = getMonthlyRemaining();
    var parts = [];
    if (purchased > 0) parts.push(formatTT(purchased) + ' purchased');
    parts.push(formatTT(free) + ' free today');
    if (monthly != null) parts.push(formatTT(monthly) + ' left this month');
    el.title = parts.join(' · ');
  }

  async function init() {
    await syncFromBackup();
    refreshBalanceDisplay();
    // Watch for UTC day rollover on the existing 30s tick instead of relying
    // on editor.html's separate 120s refreshBillingFromCloud poll -- without
    // this, the free-allowance display could show a stale pre-reset value
    // for up to 2 minutes after midnight UTC before self-correcting. The
    // moment the day key changes, force an immediate re-fetch of the real
    // server-side dayUsed value (via window.rotexFetchServerUsage, already
    // exposed by editor.html) so the reset is visible right away, not on the
    // next scheduled poll.
    var lastSeenDayKey = _utcDayKey();
    setInterval(function () {
      var nowKey = _utcDayKey();
      if (nowKey !== lastSeenDayKey) {
        lastSeenDayKey = nowKey;
        if (typeof window.rotexFetchServerUsage === 'function') {
          window.rotexFetchServerUsage().catch(function () {});
        }
      }
      refreshBalanceDisplay();
    }, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.rotexTokens = {
    FREE_DAILY: FREE_DAILY_BASE,
    PRO_DAILY: PRO_DAILY_BASE,
    getDailyAllowance: getDailyAllowance,
    isProUser: isProUser,
    formatTT: formatTT,
    getPurchased: getPurchased,
    getSpentToday: getSpentToday,
    getFreeRemaining: getFreeRemaining,
    getMonthlyRemaining: getMonthlyRemaining,
    getTotalAvailable: getTotalAvailable,
    savePurchased: savePurchased,
    spend: spend,
    syncFromBackup: syncFromBackup,
    refreshBalanceDisplay: refreshBalanceDisplay,
  };
})();
