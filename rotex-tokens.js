/* ROTEX — TexToken balance: purchased wallet + free daily allowance (display total) */
(function () {
  'use strict';

  var FREE_DAILY_BASE = 150000;
  var PRO_DAILY_BASE = 1000000;

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

  function formatTT(n) {
    n = Math.max(0, Math.floor(Number(n) || 0));
    if (n >= 1_000_000) {
      var m = n / 1_000_000;
      var s = Number.isInteger(m) ? String(m) : m.toFixed(2).replace(/\.?0+$/, '');
      return s + 'M';
    }
    if (n >= 1_000) return Math.round(n / 1_000) + 'K';
    return String(n);
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
    var today = new Date().toDateString();
    var spentDate = localStorage.getItem('rotex_textokens_spent_date');
    return spentDate === today ? Math.max(0, Math.floor(Number(localStorage.getItem('rotex_textokens_spent_today') || 0))) : 0;
  }

  function getFreeRemaining() {
    return Math.max(0, getDailyAllowance() - getSpentToday());
  }

  // Free 1M / Pro 20M monthly cap remaining, from the server. null if unknown.
  function getMonthlyRemaining() {
    var su = getServerUsage();
    if (!su) return null;
    var limit = isProUser() ? (Number(su.proMonthly) || 20000000) : (Number(su.freeMonthly) || 1000000);
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

    var today = new Date().toDateString();
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
    setInterval(function () {
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
