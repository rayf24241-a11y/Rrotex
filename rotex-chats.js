/* ROTEX chat store + open — file backup, no Firebase required */
(function () {
  'use strict';

  var STORAGE_KEY = 'rotex_chats';
  var ACTIVE_KEY = 'rotex_active_chat';

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function ago(ts) {
    var ms = typeof ts === 'number' ? ts : (ts && ts.seconds ? ts.seconds * 1000 : Number(ts));
    if (!ms || Number.isNaN(ms)) return '';
    var d = Date.now() - ms, m = Math.floor(d / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  function readLocal() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw || raw === '[]') return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(function (c) { return c && c.id; }) : [];
    } catch {
      return [];
    }
  }

  function writeLocal(chats, activeId) {
    if (!Array.isArray(chats)) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(chats.slice(0, 50)));
      if (activeId) localStorage.setItem(ACTIVE_KEY, activeId);
      else if (!chats.length) localStorage.removeItem(ACTIVE_KEY);
    } catch (_) {}
  }

  async function persistStore(chats, activeId) {
    writeLocal(chats, activeId);
    if (window.rotexDesktop && window.rotexDesktop.saveChatsBackup) {
      try { await window.rotexDesktop.saveChatsBackup(chats || [], activeId); } catch (_) {}
    }
  }

  async function deleteChatById(id) {
    if (!id) return;
    var chats = readLocal().filter(function (c) { return c.id !== id; });
    var active = localStorage.getItem(ACTIVE_KEY);
    if (active === id) {
      active = chats[0] ? chats[0].id : null;
    }
    await persistStore(chats, active);
    if (typeof window.__rotexDeleteFirestoreChat === 'function') {
      try { await window.__rotexDeleteFirestoreChat(id); } catch (_) {}
    }
    renderEditorSidebar(chats, active);
    renderProjectsGrid(chats);
    if (active) openChat(active);
    else {
      var msgs = document.getElementById('rxAiMessages');
      var bar = document.getElementById('rxActiveChatBar');
      if (bar) bar.style.display = 'none';
      if (msgs) {
        msgs.innerHTML = '<div class="ai-welcome-msg"><p><strong>ROTEX AI</strong></p><p>What are you working on?</p></div>';
      }
    }
  }

  function bindDeleteButtons(root) {
    if (!root) return;
    root.querySelectorAll('.rx-chat-del, .cc-del').forEach(function (btn) {
      btn.onclick = function (e) {
        e.preventDefault();
        e.stopPropagation();
        var delId = btn.getAttribute('data-id');
        if (delId) deleteChatById(delId);
      };
    });
  }

  async function loadStore() {
    var chats = [];
    var active = localStorage.getItem(ACTIVE_KEY) || null;
    if (window.rotexDesktop && window.rotexDesktop.getChatsBackup) {
      try {
        var data = await window.rotexDesktop.getChatsBackup();
        if (data && data.chats && data.chats.length) {
          chats = data.chats;
          active = data.activeChat || active;
          writeLocal(chats, active);
        }
      } catch (_) {}
    }
    if (!chats.length) {
      chats = readLocal();
      if (chats.length && window.rotexDesktop && window.rotexDesktop.saveChatsBackup) {
        try { await window.rotexDesktop.saveChatsBackup(chats, active); } catch (_) {}
      }
    }
    if (active && !chats.some(function (c) { return c.id === active; })) {
      chats.unshift({
        id: active,
        uid: 'local',
        title: 'Recovered Chat',
        projectMode: 'Roblox',
        projectName: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: 'Fast',
        preview: '',
        messageCount: 0,
      });
      await persistStore(chats, active);
    }
    return { chats: chats, activeChat: active };
  }

  function unlockComposer() {
    var overlay = document.getElementById('rxStudioConnectOverlay');
    if (overlay) overlay.classList.remove('visible');
    ['rxEpOverlay', 'epOverlay'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.remove('open');
    });
    try { sessionStorage.setItem('rotex_studio_overlay_ok', '1'); } catch (_) {}
    var inp = document.getElementById('rxAiInput');
    if (inp) {
      inp.disabled = false;
      inp.placeholder = 'Ask ROTEX…';
    }
  }

  function showChatInPanel(chat) {
    var msgs = document.getElementById('rxAiMessages');
    if (!msgs || !chat) return false;
    unlockComposer();
    var bar = document.getElementById('rxActiveChatBar');
    var label = document.getElementById('rxActiveChatLabel');
    if (bar && label) {
      bar.style.display = 'block';
      label.textContent = chat.projectName || chat.title || 'Chat';
    }
    if (!chat.messages || !chat.messages.length) {
      var mode = chat.projectMode ? ' · ' + chat.projectMode : '';
      var name = chat.projectName || chat.title ? ' — ' + (chat.projectName || chat.title) : '';
      msgs.innerHTML =
        '<div class="ai-welcome-msg" id="rxWelcomeMsg">' +
        '<p><strong>ROTEX AI' + esc(mode) + esc(name) + '</strong></p>' +
        '<p>What are you working on? I can write code, debug, explain, refactor, and plan.</p>' +
        '</div>';
    } else {
      msgs.innerHTML = '';
      chat.messages.forEach(function (m) {
        var div = document.createElement('div');
        div.className = 'ai-msg ' + (m.role === 'user' ? 'ai-msg-user' : 'ai-msg-assistant');
        if (typeof window.rotexRenderChatMessage === 'function') {
          window.rotexRenderChatMessage(div, m.role, m.content);
        } else {
          div.style.whiteSpace = 'pre-wrap';
          div.textContent = m.content;
        }
        msgs.appendChild(div);
      });
      msgs.scrollTop = msgs.scrollHeight;
    }
    var sel = document.getElementById('rxProjectMode');
    if (sel && chat.projectMode) {
      if (!Array.from(sel.options).some(function (o) { return o.value === chat.projectMode; })) {
        var opt = document.createElement('option');
        opt.value = chat.projectMode;
        opt.textContent = chat.projectMode;
        sel.appendChild(opt);
      }
      try { sel.value = chat.projectMode; } catch (_) {}
    }
    document.querySelectorAll('.rx-chat-item').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-id') === chat.id);
    });
    var inp = document.getElementById('rxAiInput');
    if (inp) inp.focus();
    return true;
  }

  function renderEditorSidebar(chats, activeId) {
    var list = document.getElementById('rxChatList');
    if (!list) return;
    if (!chats.length) {
      list.innerHTML = '<div class="rx-chat-empty">No chats yet.<br>Hit <strong>New Chat</strong> to start.</div>';
      return;
    }
    list.innerHTML =
      '<div class="rx-chat-section">Recent</div>' +
      chats.map(function (c) {
        var active = c.id === activeId ? ' active' : '';
        return (
          '<div class="rx-chat-item' + active + '" data-id="' + esc(c.id) + '">' +
          '<div class="rx-chat-icon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
          '<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg></div>' +
          '<div class="rx-chat-info"><div class="rx-chat-name">' + esc(c.title || 'New Chat') + '</div>' +
          (c.updatedAt ? '<div class="rx-chat-time">' + ago(c.updatedAt) + '</div>' : '') +
          '</div>' +
          '<button class="rx-chat-del" data-id="' + esc(c.id) + '" title="Delete">' +
          '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">' +
          '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>'
        );
      }).join('');
    list.querySelectorAll('.rx-chat-item').forEach(function (el) {
      el.onclick = function (e) {
        if (e.target.closest('.rx-chat-del')) return;
        var id = el.getAttribute('data-id');
        if (id) openChat(id);
      };
    });
    bindDeleteButtons(list);
  }

  function renderProjectsGrid(chats) {
    var g = document.getElementById('chatsGrid');
    if (!g) return;
    if (!chats.length) {
      g.innerHTML =
        '<div class="empty"><div class="empty-title">No chats yet</div>' +
        '<div class="empty-sub">Hit "New Chat" to start</div></div>';
      return;
    }
    g.innerHTML = chats.map(function (c) {
      return (
        '<div class="chat-card" data-id="' + esc(c.id) + '">' +
        '<div class="cc-name">' + esc(c.title || 'New Chat') + '</div>' +
        '<div class="cc-footer"><span class="cc-time">' + (c.updatedAt ? ago(c.updatedAt) : '') + '</span>' +
        '<span class="cc-model" style="color:var(--yellow);font-weight:700;">Open chat →</span></div>' +
        '<button class="cc-del" data-id="' + esc(c.id) + '" title="Delete">×</button></div>'
      );
    }).join('');
    g.querySelectorAll('.chat-card').forEach(function (card) {
      card.onclick = function (e) {
        if (e.target.closest('.cc-del')) return;
        var id = card.getAttribute('data-id');
        if (!id) return;
        localStorage.setItem(ACTIVE_KEY, id);
        window.location.href = 'editor.html';
      };
    });
    bindDeleteButtons(g);
  }

  function findChat(id, chats) {
    if (!id) return null;
    var list = chats || readLocal();
    var chat = list.find(function (c) { return c.id === id; });
    return chat || null;
  }

  function openChat(id) {
    if (!id) return;
    localStorage.setItem(ACTIVE_KEY, id);
    unlockComposer();
    if (typeof window.__rotexSwitchChat === 'function') {
      try { window.__rotexSwitchChat(id); } catch (_) {}
    }
    var chat = findChat(id);
    if (chat) showChatInPanel(chat);
  }

  async function openActiveChat() {
    var data = await loadStore();
    renderEditorSidebar(data.chats, data.activeChat);
    renderProjectsGrid(data.chats);
    if (data.activeChat) openChat(data.activeChat);
  }

  async function init() {
    var local = readLocal();
    var active = localStorage.getItem(ACTIVE_KEY);
    if (local.length) {
      renderEditorSidebar(local, active);
      renderProjectsGrid(local);
      if (active) {
        var c = findChat(active, local);
        if (c) showChatInPanel(c);
      }
    }
    await openActiveChat();
    setTimeout(openActiveChat, 800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.rotexOpenChat = openChat;
  window.rotexPersistChats = persistStore;
  window.rotexReadChats = readLocal;
  window.rotexDeleteChatById = deleteChatById;
  window.rotexRefreshChatLists = function (chats, activeId) {
    renderEditorSidebar(chats, activeId);
    renderProjectsGrid(chats);
  };
})();
