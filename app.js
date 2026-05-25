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
    computerCost: null,
    description: 'Everyday tasks, quick answers, normal chat, and simple work.',
  },
  {
    id: 'rod-thinking',
    name: 'Rod thinking',
    short: 'Hard tasks',
    api: 'Groq llama-3.3-70b-versatile',
    cost: 0.004,
    computerCost: 0.01,
    description: 'Harder tasks that need more reasoning, planning, and careful answers.',
  },
  {
    id: 'tex-0',
    name: 'Tex 0',
    short: 'Code',
    api: 'DeepSeek chat',
    cost: 0.007,
    computerCost: 0.04,
    description: 'Code help, debugging, implementation, and file-aware project work.',
  },
  {
    id: 'tex-1-5',
    name: 'Tex 1.5',
    short: 'Complex code',
    api: 'DeepSeek chat/reasoner',
    cost: 0.015,
    computerCost: 0.07,
    description: 'Complex code, larger builds, deeper architecture, and tougher fixes.',
  },
  {
    id: 'treesearch-q',
    name: 'Treesearch _ q',
    short: 'Research',
    api: 'Groq llama-3.3-70b-versatile',
    cost: 0.002,
    computerCost: null,
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
const pcShareButton = document.querySelector('#pcShareButton');
const saveStatus = document.querySelector('#saveStatus');
const syncStatus = document.querySelector('#syncStatus');
const creditStatus = document.querySelector('#creditStatus');
const upgradeButton = document.querySelector('#upgradeButton');
const chatPanel = document.querySelector('#chatPanel');
const modeEyebrow = document.querySelector('#modeEyebrow');
const modeTitle = document.querySelector('#modeTitle');
const modeSubtitle = document.querySelector('#modeSubtitle');
const computerEntry = document.querySelector('#computerEntry');
const computerEntrySub = document.querySelector('#computerEntrySub');
const computerWorkspace = document.querySelector('#computerWorkspace');
const connectorCards = document.querySelectorAll('.connector-card');
const modelButton = document.querySelector('#modelButton');
const modelMenu = document.querySelector('#modelMenu');
const selectedModelName = document.querySelector('#selectedModelName');
const selectedModelShort = document.querySelector('#selectedModelShort');
const upgradeDialog = document.querySelector('#upgradeDialog');
const checkoutButton = document.querySelector('#checkoutButton');
const connectDialog = document.querySelector('#connectDialog');
const connectOptions = document.querySelectorAll('.connect-option');
const pcDialog = document.querySelector('#pcDialog');
const pcPairStatus = document.querySelector('#pcPairStatus');
const pcPairCode = document.querySelector('#pcPairCode');
const pcCodeInput = document.querySelector('#pcCodeInput');
const pcFolderStatus = document.querySelector('#pcFolderStatus');
const makePcCodeButton = document.querySelector('#makePcCodeButton');
const pairPcButton = document.querySelector('#pairPcButton');
const choosePcFolderButton = document.querySelector('#choosePcFolderButton');
const disconnectPcButton = document.querySelector('#disconnectPcButton');

const storageKey = 'rotex:web:v2';
const pendingActivationKey = 'rotex:pending-activation';
const freeCreditAmount = 0.3;
const refillEveryMs = 3 * 24 * 60 * 60 * 1000;
const freeComputerMessagesPerDay = 3;
const connectableServices = ['Google Drive', 'GitHub', 'PC'];
let state = loadState();
let auth = null;
let db = null;
let currentUser = null;
let cloudReady = false;
let saveTimer = null;

initFirebase();
applyPendingActivation();
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
    computerMode: Boolean(value.computerMode),
    pro: Boolean(value.pro),
    computerUsage: normalizeComputerUsage(value.computerUsage),
    computerConnections: Array.isArray(value.computerConnections)
      ? value.computerConnections.filter((item) => connectableServices.includes(item))
      : [],
    pcBridge: normalizePcBridge(value.pcBridge),
    activeChatId: value.activeChatId || chats[0].id,
    credits: typeof value.credits === 'number' ? Math.max(value.credits, value.credits <= 0.003 ? freeCreditAmount : value.credits) : freeCreditAmount,
    nextRefillAt: typeof value.nextRefillAt === 'number' ? value.nextRefillAt : Date.now() + refillEveryMs,
    chats,
  };
}

function normalizePcBridge(value) {
  return {
    code: typeof value?.code === 'string' ? value.code.slice(0, 3) : '',
    connected: Boolean(value?.connected),
    folderName: typeof value?.folderName === 'string' ? value.folderName.slice(0, 120) : '',
    folderReady: Boolean(value?.folderReady),
    createdAt: typeof value?.createdAt === 'number' ? value.createdAt : 0,
    pairedAt: typeof value?.pairedAt === 'number' ? value.pairedAt : 0,
  };
}

function normalizeComputerUsage(value) {
  const today = dayKey();
  if (!value || value.day !== today) {
    return { day: today, count: 0 };
  }
  return { day: today, count: Number(value.count) || 0 };
}

function applyCreditRefill() {
  if (Date.now() < state.nextRefillAt) return;
  state.credits = freeCreditAmount;
  state.nextRefillAt = Date.now() + refillEveryMs;
}

function applyComputerUsageReset() {
  state.computerUsage = normalizeComputerUsage(state.computerUsage);
}

function persistState() {
  applyCreditRefill();
  applyComputerUsageReset();
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

function activeCost() {
  const model = activeModel();
  return state.computerMode ? (model.computerCost ?? model.cost) : model.cost;
}

function computerMessagesLeft() {
  applyComputerUsageReset();
  return Math.max(0, freeComputerMessagesPerDay - state.computerUsage.count);
}

function ensureComputerModel() {
  if (!state.computerMode || activeModel().computerCost !== null) return;
  state.activeModel = 'rod-thinking';
}

function setCloudStatus(text) {
  syncStatus.textContent = text;
}

function renderModelMenu() {
  ensureComputerModel();
  const model = activeModel();
  selectedModelName.textContent = model.name;
  selectedModelShort.textContent = state.computerMode ? 'Computer mode' : model.short;
  modelMenu.innerHTML = '';

  models.forEach((item) => {
    const disabled = state.computerMode && item.computerCost === null;
    const price = state.computerMode ? item.computerCost : item.cost;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `model-option${item.id === state.activeModel ? ' active' : ''}${disabled ? ' disabled' : ''}`;
    button.innerHTML = `<strong>${item.name}</strong><span>${item.description}</span><span>${disabled ? 'Not in computer mode' : `${formatMoney(price)} per message${state.computerMode ? ' ICM' : ''}`}</span>`;
    button.addEventListener('click', () => {
      if (disabled) return;
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
      closeComputerMode();
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
        <p>${model.api}. Costs ${formatMoney(activeCost())} per message${state.computerMode ? ' in computer mode' : ''}. Normal users refill to ${formatMoney(freeCreditAmount)} every 3 days.</p>
      </div>
    `;
    return;
  }

  chat.messages.forEach((message) => {
    const item = document.createElement('div');
    item.className = `message ${message.role}`;
    const downloads = message.role === 'assistant' ? extractDownloadFiles(message.text) : [];
    const visibleText = downloads.length ? stripDownloadBlocks(message.text) : message.text;
    item.innerHTML = `<span class="message-meta">${message.role === 'user' ? 'You' : escapeHtml(message.model)}</span>${escapeHtml(visibleText)}`;
    if (message.action === 'upgrade') {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'message-action';
      button.textContent = 'Upgrade';
      button.addEventListener('click', startUpgrade);
      item.appendChild(button);
    }
    if (downloads.length) {
      item.appendChild(renderDownloadList(downloads));
    }
    messagesEl.appendChild(item);
  });
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderAccount() {
  applyCreditRefill();
  applyComputerUsageReset();
  creditStatus.textContent = `${formatMoney(state.credits)} credits`;
  renderConnectOptions();
  renderModeShell();
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
  applyComputerUsageReset();
  renderModelMenu();
  renderChats();
  renderMessages();
  renderAccount();
}

function renderModeShell() {
  chatPanel.classList.toggle('computer-panel', state.computerMode);
  computerWorkspace.classList.toggle('active', state.computerMode);
  computerEntry.classList.toggle('active', state.computerMode);
  computerEntry.setAttribute('aria-pressed', String(state.computerMode));
  modeEyebrow.textContent = state.computerMode ? 'ROTEX computer' : 'ROTEX web';
  modeTitle.textContent = state.computerMode ? 'Computer mode' : 'Chat with ROTEX';
  modeSubtitle.textContent = state.computerMode
    ? 'Workspace connections and approvals live here.'
    : 'Fast chat, code, and research with ROTEX.';
  computerEntrySub.textContent = state.computerMode ? 'Open workspace' : 'Connect apps';
  connectorCards.forEach((card) => {
    const value = card.dataset.connect;
    const active = value === 'all'
      ? connectableServices.every((item) => state.computerConnections.includes(item))
      : state.computerConnections.includes(value);
    card.classList.toggle('active', active);
  });
  renderPcBridge();
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
  const clean = text.trim();
  if (!clean || !chat) return;

  applyCreditRefill();
  applyComputerUsageReset();
  ensureComputerModel();
  const model = activeModel();
  const cost = activeCost();
  if (state.computerMode && !state.pro && computerMessagesLeft() <= 0) {
    chat.messages.push({
      role: 'assistant',
      model: 'ROTEX Pro',
      text: 'Free computer mode limit reached for today. Upgrade?',
      action: 'upgrade',
    });
    persistState();
    render();
    return;
  }
  if (state.credits + 0.0000001 < cost) {
    chat.messages.push({
      role: 'assistant',
      model: 'ROTEX credits',
      text: 'your out of credits, upgrade?',
      action: 'upgrade',
    });
    persistState();
    render();
    return;
  }

  state.credits = Math.max(0, state.credits - cost);
  if (state.computerMode && !state.pro) {
    state.computerUsage.count += 1;
  }
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
        computerMode: state.computerMode,
        computerConnections: state.computerConnections,
        pcBridge: state.pcBridge,
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

async function startUpgrade() {
  if (!upgradeDialog.open) {
    upgradeDialog.showModal();
  }
}

async function continueCheckout() {
  try {
    const response = await fetch('/api/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uid: currentUser?.uid || '',
        email: currentUser?.email || '',
      }),
    });
    const data = await response.json();
    if (data.url) {
      window.location.href = data.url;
      return;
    }
    alert(data.message || 'Stripe is not configured yet. Make a Stripe product/price and send me the Price ID.');
  } catch {
    alert('Stripe checkout is not ready yet. Make the Stripe product and send me the Price ID.');
  }
}

function formatMoney(value) {
  return `$${Number(value).toFixed(3)}`;
}

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function renderConnectOptions() {
  connectOptions.forEach((button) => {
    const value = button.dataset.connect;
    const active = value === 'all'
      ? connectableServices.every((item) => state.computerConnections.includes(item))
      : state.computerConnections.includes(value);
    button.classList.toggle('active', active);
  });
}

function renderPcBridge() {
  if (state.pcBridge.connected) {
    pcPairStatus.textContent = 'PC connected. Keep this page open on the PC when you want ROTEX to work with approved files.';
  } else if (state.pcBridge.code) {
    pcPairStatus.textContent = 'Type this code on your PC from Settings > Share to finish pairing.';
  } else {
    pcPairStatus.textContent = 'Make a 3 digit code on your phone, then type it on your PC from Settings > Share.';
  }
  pcPairCode.textContent = state.pcBridge.code || '---';
  pcFolderStatus.textContent = state.pcBridge.folderReady
    ? `Approved PC folder: ${state.pcBridge.folderName || 'selected folder'}`
    : 'No PC folder approved yet. On the PC, connect first, then choose a folder.';
  choosePcFolderButton.disabled = !state.pcBridge.connected;
  disconnectPcButton.disabled = !state.pcBridge.connected && !state.pcBridge.code;
}

function announceActivation(service) {
  const chat = activeChat();
  if (!chat) return;
  chat.messages.push({
    role: 'assistant',
    model: 'ROTEX computer',
    text: `you activated ${service}`,
  });
}

function activateService(service, announce = true) {
  setConnection(service, true);
  if (announce) {
    announceActivation(service);
  }
}

function applyPendingActivation() {
  const service = localStorage.getItem(pendingActivationKey);
  if (!service || !connectableServices.includes(service)) return;
  localStorage.removeItem(pendingActivationKey);
  activateService(service);
  persistState();
}

function extractDownloadFiles(text) {
  const files = [];
  const pattern = /```file:([^\n\r]+)\r?\n([\s\S]*?)```/g;
  let match = pattern.exec(text);
  while (match) {
    const name = safeFileName(match[1]);
    if (name) {
      files.push({ name, content: match[2].replace(/\s+$/, '') });
    }
    match = pattern.exec(text);
  }
  return files;
}

function stripDownloadBlocks(text) {
  return text.replace(/```file:([^\n\r]+)\r?\n([\s\S]*?)```/g, '').trim();
}

function safeFileName(value) {
  return String(value).trim().replace(/[<>:"/\\|?*]/g, '-').slice(0, 80);
}

function renderDownloadList(files) {
  const list = document.createElement('div');
  list.className = 'download-list';
  files.forEach((file) => {
    const link = document.createElement('a');
    link.className = 'download-file';
    link.download = file.name;
    link.href = URL.createObjectURL(new Blob([file.content], { type: 'text/plain' }));
    link.textContent = `Download ${file.name}`;
    list.appendChild(link);
  });
  return list;
}

function openPcDialog() {
  renderPcBridge();
  if (!pcDialog.open) {
    pcDialog.showModal();
  }
  pcCodeInput.focus();
}

function setConnection(value, enabled) {
  if (enabled && !state.computerConnections.includes(value)) {
    state.computerConnections = [...state.computerConnections, value];
  }
  if (!enabled) {
    state.computerConnections = state.computerConnections.filter((item) => item !== value);
  }
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

function closeComputerMode() {
  state.computerMode = false;
  closeModelMenu();
  if (connectDialog.open) {
    connectDialog.close();
  }
  if (pcDialog.open) {
    pcDialog.close();
  }
}

newChatButton.addEventListener('click', () => {
  closeComputerMode();
  createChat();
});
modelButton.addEventListener('click', toggleModelMenu);
computerEntry.addEventListener('click', () => {
  state.computerMode = !state.computerMode;
  ensureComputerModel();
  if (state.computerMode && state.computerConnections.length === 0) {
    connectDialog.showModal();
  }
  persistState();
  render();
});

connectOptions.forEach((button) => {
  button.addEventListener('click', () => {
    const value = button.dataset.connect;
    if (value === 'all') {
      state.computerConnections = [...connectableServices];
      announceActivation('Google Drive, GitHub, and PC');
    } else if (value === 'PC') {
      activateService('PC');
      openPcDialog();
    } else if (state.computerConnections.includes(value)) {
      setConnection(value, false);
    } else {
      activateService(value);
    }
    persistState();
    render();
  });
});

connectorCards.forEach((button) => {
  button.addEventListener('click', async () => {
    const value = button.dataset.connect;
    const provider = button.dataset.provider;
    if (value === 'all') {
      state.computerConnections = [...connectableServices];
      announceActivation('Google Drive, GitHub, and PC');
    } else if (value === 'PC') {
      activateService('PC');
      persistState();
      render();
      openPcDialog();
      return;
    } else {
      setConnection(value, true);
    }
    persistState();
    render();
    if (provider === 'all') {
      connectDialog.showModal();
      return;
    }
    await startProviderConnect(provider);
  });
});

makePcCodeButton.addEventListener('click', () => {
  state.pcBridge = {
    code: String(Math.floor(100 + Math.random() * 900)),
    connected: false,
    createdAt: Date.now(),
  };
  activateService('PC', false);
  persistState();
  render();
  openPcDialog();
});

pairPcButton.addEventListener('click', () => {
  const typedCode = pcCodeInput.value.trim();
  if (!state.pcBridge.code || typedCode !== state.pcBridge.code) {
    pcPairStatus.textContent = 'That code does not match. Check the 3 digits and try again.';
    return;
  }
  state.pcBridge.connected = true;
  state.pcBridge.pairedAt = Date.now();
  activateService('PC', false);
  announceActivation('PC');
  persistState();
  render();
  openPcDialog();
});

choosePcFolderButton.addEventListener('click', async () => {
  if (!state.pcBridge.connected) {
    pcPairStatus.textContent = 'Connect this PC with the 3 digit code first.';
    return;
  }
  if (!window.showDirectoryPicker) {
    pcPairStatus.textContent = 'Folder access needs desktop Chrome or Edge. This browser cannot approve a PC folder.';
    return;
  }
  try {
    const folder = await window.showDirectoryPicker({ mode: 'readwrite' });
    state.pcBridge.folderName = folder.name;
    state.pcBridge.folderReady = true;
    activateService('PC', false);
    announceActivation(`PC folder ${folder.name}`);
    persistState();
    render();
    openPcDialog();
  } catch (error) {
    pcPairStatus.textContent = 'Folder approval was cancelled.';
  }
});

disconnectPcButton.addEventListener('click', () => {
  state.pcBridge = normalizePcBridge({});
  setConnection('PC', false);
  pcCodeInput.value = '';
  persistState();
  render();
  openPcDialog();
});

pcShareButton.addEventListener('click', () => {
  openPcDialog();
});

connectDialog.addEventListener('close', () => {
  if (state.computerMode && state.computerConnections.length === 0) {
    state.computerMode = false;
    persistState();
    render();
  }
});

async function startProviderConnect(provider) {
  try {
    const response = await fetch(`/api/connect/${provider}`);
    const data = await response.json();
    if (data.url) {
      window.location.href = data.url;
      return;
    }
    alert(data.message || `${provider} is not configured yet.`);
  } catch {
    alert(`${provider} connect is not ready yet.`);
  }
}

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

upgradeButton.addEventListener('click', startUpgrade);
checkoutButton.addEventListener('click', continueCheckout);

document.addEventListener('contextmenu', (event) => event.preventDefault());
document.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if (key === 'f12' || (event.ctrlKey && event.shiftKey && ['i', 'j', 'c'].includes(key)) || (event.ctrlKey && key === 'u')) {
    event.preventDefault();
  }
});
