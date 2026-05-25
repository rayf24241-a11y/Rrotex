import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import {
  doc,
  getDoc,
  getFirestore,
  serverTimestamp,
  setDoc,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

const models = [
  {
    id: 'rod-1',
    name: 'Rod _ 1',
    short: 'Everyday',
    api: 'Groq llama-3.1-8b-instant',
    cost: 0.001,
    description: 'Everyday tasks, quick answers, normal chat, and simple work.',
  },
  {
    id: 'rod-thinking',
    name: 'Rod thinking',
    short: 'Hard tasks',
    api: 'Groq llama-3.3-70b-versatile',
    cost: 0.004,
    description: 'Harder tasks that need more reasoning, planning, and careful answers.',
  },
  {
    id: 'tex-0',
    name: 'Tex 0',
    short: 'Code',
    api: 'DeepSeek chat',
    cost: 0.007,
    description: 'Code help, debugging, implementation, and file-aware project work.',
  },
  {
    id: 'tex-1-5',
    name: 'Tex 1.5',
    short: 'Complex code',
    api: 'DeepSeek chat/reasoner',
    cost: 0.015,
    description: 'Complex code, larger builds, deeper architecture, and tougher fixes.',
  },
  {
    id: 'treesearch-q',
    name: 'Treesearch _ q',
    short: 'Research',
    api: 'Groq llama-3.3-70b-versatile',
    cost: 0.002,
    description: 'Research mode for searching, comparing, and explaining. It cannot create files.',
  },
];

const chatList = document.querySelector('#chatList');
const messagesEl = document.querySelector('#messages');
const composer = document.querySelector('#composer');
const messageInput = document.querySelector('#messageInput');
const newChatButton = document.querySelector('#newChatButton');
const googleButton = document.querySelector('#googleButton');
const googleButtonText = document.querySelector('#googleButtonText');
const signOutButton = document.querySelector('#signOutButton');
const saveStatus = document.querySelector('#saveStatus');
const syncStatus = document.querySelector('#syncStatus');
const creditStatus = document.querySelector('#creditStatus');
const modelButton = document.querySelector('#modelButton');
const modelMenu = document.querySelector('#modelMenu');
const selectedModelName = document.querySelector('#selectedModelName');
const selectedModelShort = document.querySelector('#selectedModelShort');

const storageKey = 'rotex:web:v2';
const freeCreditAmount = 0.003;
const refillEveryMs = 3 * 24 * 60 * 60 * 1000;
let state = loadState();
let auth = null;
let db = null;
let currentUser = null;
let cloudReady = false;
let saveTimer = null;

initFirebase();
render();

async function initFirebase() {
  try {
    const response = await fetch('/api/firebase-config');
    const config = await response.json();
    if (!config.configured) {
      setCloudStatus('Local mode');
      return;
    }

    const app = initializeApp(config.firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    cloudReady = true;
    setCloudStatus('Firebase ready');

    onAuthStateChanged(auth, async (user) => {
      currentUser = user;
      if (user) {
        await loadCloudState();
      }
      render();
    });
  } catch (error) {
    console.warn('Firebase unavailable:', error);
    setCloudStatus('Local mode');
  }
}

function loadState() {
  const saved = localStorage.getItem(storageKey);
  if (saved) {
    try {
      return normalizeState(JSON.parse(saved));
    } catch {}
  }
  return normalizeState({});
}

function normalizeState(value) {
  const firstChatId = crypto.randomUUID();
  const chats = Array.isArray(value.chats) && value.chats.length > 0
    ? value.chats
    : [{ id: firstChatId, title: 'New ROTEX chat', createdAt: Date.now(), messages: [] }];

  return {
    activeModel: value.activeModel || 'rod-1',
    activeChatId: value.activeChatId || chats[0].id,
    credits: typeof value.credits === 'number' ? value.credits : freeCreditAmount,
    nextRefillAt: typeof value.nextRefillAt === 'number' ? value.nextRefillAt : Date.now() + refillEveryMs,
    chats,
  };
}

function applyCreditRefill() {
  if (Date.now() < state.nextRefillAt) return;
  state.credits = freeCreditAmount;
  state.nextRefillAt = Date.now() + refillEveryMs;
}

function persistState() {
  applyCreditRefill();
  localStorage.setItem(storageKey, JSON.stringify(state));
  if (!currentUser || !db) return;

  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    try {
      await setDoc(doc(db, 'users', currentUser.uid, 'chatState', 'main'), {
        ...state,
        updatedAt: serverTimestamp(),
      });
      setCloudStatus('Saved');
    } catch (error) {
      console.error(error);
      setCloudStatus('Save failed');
    }
  }, 450);
}

async function loadCloudState() {
  if (!currentUser || !db) return;
  setCloudStatus('Syncing');
  const snap = await getDoc(doc(db, 'users', currentUser.uid, 'chatState', 'main'));
  if (snap.exists()) {
    state = normalizeState(snap.data());
    localStorage.setItem(storageKey, JSON.stringify(state));
  } else {
    await setDoc(doc(db, 'users', currentUser.uid, 'chatState', 'main'), {
      ...state,
      updatedAt: serverTimestamp(),
    });
  }
  setCloudStatus('Synced');
}

function activeChat() {
  return state.chats.find((chat) => chat.id === state.activeChatId) || state.chats[0];
}

function activeModel() {
  return models.find((model) => model.id === state.activeModel) || models[0];
}

function setCloudStatus(text) {
  syncStatus.textContent = text;
}

function renderModelMenu() {
  const model = activeModel();
  selectedModelName.textContent = model.name;
  selectedModelShort.textContent = model.short;
  modelMenu.innerHTML = '';

  models.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `model-option${item.id === state.activeModel ? ' active' : ''}`;
    button.innerHTML = `<strong>${item.name}</strong><span>${item.description}</span><span>${formatMoney(item.cost)} per message</span>`;
    button.addEventListener('click', () => {
      state.activeModel = item.id;
      closeModelMenu();
      persistState();
      render();
    });
    modelMenu.appendChild(button);
  });
}

function renderChats() {
  chatList.innerHTML = '';
  state.chats.forEach((chat) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `chat-item${chat.id === state.activeChatId ? ' active' : ''}`;
    button.innerHTML = `<span>${escapeHtml(chat.title)}</span><small>${chat.messages.length}</small>`;
    button.addEventListener('click', () => {
      state.activeChatId = chat.id;
      persistState();
      render();
    });
    chatList.appendChild(button);
  });
}

function renderMessages() {
  const chat = activeChat();
  const model = activeModel();
  messagesEl.innerHTML = '';

  if (!chat || chat.messages.length === 0) {
    messagesEl.innerHTML = `
      <div class="empty-state">
        <p class="eyebrow">Ready</p>
        <h2>${model.name}</h2>
        <p>${model.description}</p>
        <p>${model.api}. Costs ${formatMoney(model.cost)} per message. Normal users refill to ${formatMoney(freeCreditAmount)} every 3 days.</p>
      </div>
    `;
    return;
  }

  chat.messages.forEach((message) => {
    const item = document.createElement('div');
    item.className = `message ${message.role}`;
    item.innerHTML = `<span class="message-meta">${message.role === 'user' ? 'You' : escapeHtml(message.model)}</span>${escapeHtml(message.text)}`;
    messagesEl.appendChild(item);
  });
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderAccount() {
  applyCreditRefill();
  creditStatus.textContent = `${formatMoney(state.credits)} credits`;
  if (currentUser) {
    googleButtonText.textContent = currentUser.displayName || currentUser.email || 'Google account';
    signOutButton.hidden = false;
    saveStatus.textContent = `Chats sync with Firebase for ${currentUser.email || 'this account'}.`;
  } else if (cloudReady) {
    googleButtonText.textContent = 'Log in or sign up';
    signOutButton.hidden = true;
    saveStatus.textContent = 'Sign in with Google to save chats with Firebase.';
  } else {
    googleButtonText.textContent = 'Firebase not configured';
    signOutButton.hidden = true;
    saveStatus.textContent = 'Add Firebase env vars in Vercel to enable Google login.';
  }
}

function render() {
  applyCreditRefill();
  renderModelMenu();
  renderChats();
  renderMessages();
  renderAccount();
}

function createChat() {
  const id = crypto.randomUUID();
  state.chats.unshift({
    id,
    title: 'New ROTEX chat',
    createdAt: Date.now(),
    messages: [],
  });
  state.activeChatId = id;
  persistState();
  render();
  messageInput.focus();
}

async function sendMessage(text) {
  const chat = activeChat();
  const model = activeModel();
  const clean = text.trim();
  if (!clean || !chat) return;

  applyCreditRefill();
  if (state.credits + 0.0000001 < model.cost) {
    chat.messages.push({
      role: 'assistant',
      model: 'ROTEX credits',
      text: `You are out of credits for ${model.name}. Normal users refill to ${formatMoney(freeCreditAmount)} every 3 days. This model costs ${formatMoney(model.cost)} per message.`,
    });
    persistState();
    render();
    return;
  }

  state.credits = Math.max(0, state.credits - model.cost);
  chat.messages.push({ role: 'user', text: clean, model: 'You' });
  if (chat.title === 'New ROTEX chat') {
    chat.title = clean.length > 32 ? `${clean.slice(0, 32)}...` : clean;
  }
  persistState();
  render();

  const pending = { role: 'assistant', model: model.name, text: 'Thinking...' };
  chat.messages.push(pending);
  render();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model.id,
        messages: chat.messages.filter((message) => message.text !== 'Thinking...'),
      }),
    });
    const data = await response.json();
    pending.text = data.text || 'ROTEX backend is online, but no response came back.';
  } catch (error) {
    pending.text = 'ROTEX backend could not respond yet. Check Vercel env keys when real AI is connected.';
  }

  persistState();
  render();
}

function formatMoney(value) {
  return `$${Number(value).toFixed(3)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function toggleModelMenu() {
  const open = !modelMenu.classList.contains('open');
  modelMenu.classList.toggle('open', open);
  modelMenu.setAttribute('aria-hidden', String(!open));
  modelButton.setAttribute('aria-expanded', String(open));
}

function closeModelMenu() {
  modelMenu.classList.remove('open');
  modelMenu.setAttribute('aria-hidden', 'true');
  modelButton.setAttribute('aria-expanded', 'false');
}

newChatButton.addEventListener('click', createChat);
modelButton.addEventListener('click', toggleModelMenu);

document.addEventListener('click', (event) => {
  if (!modelMenu.contains(event.target) && !modelButton.contains(event.target)) {
    closeModelMenu();
  }
});

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage(messageInput.value);
  messageInput.value = '';
});

messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

googleButton.addEventListener('click', async () => {
  if (!auth) {
    alert('Firebase is not configured yet. Add the Firebase env vars in Vercel first.');
    return;
  }
  await signInWithPopup(auth, new GoogleAuthProvider());
});

signOutButton.addEventListener('click', async () => {
  if (auth) await signOut(auth);
});
