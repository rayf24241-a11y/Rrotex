import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  linkWithCredential,
  onAuthStateChanged,
  PhoneAuthProvider,
  RecaptchaVerifier,
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
const appShell = document.querySelector('#appShell');
const messagesEl = document.querySelector('#messages');
const composer = document.querySelector('#composer');
const messageInput = document.querySelector('#messageInput');
const newChatButton = document.querySelector('#newChatButton');
const googleButton = document.querySelector('#googleButton');
const googleButtonText = document.querySelector('#googleButtonText');
const signOutButton = document.querySelector('#signOutButton');
const phoneVerifyButton = document.querySelector('#phoneVerifyButton');
const pcShareButton = document.querySelector('#pcShareButton');
const planStatus = document.querySelector('#planStatus');
const saveStatus = document.querySelector('#saveStatus');
const syncStatus = document.querySelector('#syncStatus');
const creditStatus = document.querySelector('#creditStatus');
const upgradeButton = document.querySelector('#upgradeButton');
const proPage = document.querySelector('#proPage');
const closeProPageButton = document.querySelector('#closeProPageButton');
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
const phoneDialog = document.querySelector('#phoneDialog');
const phoneStatus = document.querySelector('#phoneStatus');
const phoneInput = document.querySelector('#phoneInput');
const phoneCodeWrap = document.querySelector('#phoneCodeWrap');
const phoneCodeInput = document.querySelector('#phoneCodeInput');
const sendPhoneCodeButton = document.querySelector('#sendPhoneCodeButton');
const confirmPhoneCodeButton = document.querySelector('#confirmPhoneCodeButton');
const skipPhoneButton = document.querySelector('#skipPhoneButton');

const storageKey = 'rotex:web:v2';
const pendingActivationKey = 'rotex:pending-activation';
const creditPlans = {
  normal: { daily: 0.3, weekly: 0.9, monthly: 1.5 },
  limited: { daily: 0.1, weekly: 0.3, monthly: 0.5 },
  pro: { daily: 2.5, weekly: 5, monthly: 5 },
};
const freeComputerMessagesPerDay = 3;
const connectableServices = ['Google Drive', 'GitHub', 'PC'];
const deviceRole = detectDeviceRole();
let state = loadState();
let auth = null;
let db = null;
let currentUser = null;
let cloudReady = false;
let saveTimer = null;
let phoneVerifier = null;
let phoneConfirmation = null;

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
        await handleCheckoutReturn();
      } else {
        localStorage.removeItem(storageKey);
        state = normalizeState({});
      }
      render();
      if (shouldAskPhone()) {
        window.setTimeout(openPhoneDialog, 350);
      }
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
  const pro = Boolean(value.pro);
  const phoneVerified = Boolean(value.phoneVerified);
  const phoneSkipped = Boolean(value.phoneSkipped);
  const creditUsage = normalizeCreditUsage(value.creditUsage, pro, value.credits, { phoneVerified, phoneSkipped });

  return {
    activeModel: value.activeModel || 'rod-1',
    computerMode: Boolean(value.computerMode),
    pro,
    phoneVerified,
    phoneSkipped,
    creditUsage,
    computerUsage: normalizeComputerUsage(value.computerUsage),
    computerConnections: Array.isArray(value.computerConnections)
      ? value.computerConnections.filter((item) => connectableServices.includes(item))
      : [],
    pcBridge: normalizePcBridge(value.pcBridge),
    activeChatId: value.activeChatId || chats[0].id,
    credits: remainingMonthlyCredits(pro, creditUsage),
    chats,
  };
}

function normalizeCreditUsage(value, pro, oldCredits, accountState = state) {
  const plan = pro ? creditPlans.pro : activeFreePlan(accountState);
  const today = dayKey();
  const week = weekKey();
  const month = monthKey();
  const legacyMonthSpent = typeof oldCredits === 'number'
    ? Math.max(0, plan.monthly - Math.min(plan.monthly, Math.max(0, oldCredits)))
    : 0;
  return {
    day: today,
    week,
    month,
    daySpent: value?.day === today ? Math.max(0, Number(value.daySpent) || 0) : 0,
    weekSpent: value?.week === week ? Math.max(0, Number(value.weekSpent) || 0) : 0,
    monthSpent: value?.month === month ? Math.max(0, Number(value.monthSpent) || legacyMonthSpent) : 0,
  };
}

function normalizePcBridge(value) {
  return {
    code: typeof value?.code === 'string' ? value.code.slice(0, 3) : '',
    connected: Boolean(value?.connected),
    requesterRole: value?.requesterRole === 'phone' ? 'phone' : '',
    connectedRole: value?.connectedRole === 'pc' ? 'pc' : '',
    folderName: typeof value?.folderName === 'string' ? value.folderName.slice(0, 120) : '',
    folderReady: Boolean(value?.folderReady),
    createdAt: typeof value?.createdAt === 'number' ? value.createdAt : 0,
    pairedAt: typeof value?.pairedAt === 'number' ? value.pairedAt : 0,
  };
}

function detectDeviceRole() {
  const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches;
  const narrowScreen = window.matchMedia?.('(max-width: 760px)').matches;
  const mobileUserAgent = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  return coarsePointer && (narrowScreen || mobileUserAgent) ? 'phone' : 'pc';
}

function normalizeComputerUsage(value) {
  const today = dayKey();
  if (!value || value.day !== today) {
    return { day: today, count: 0 };
  }
  return { day: today, count: Number(value.count) || 0 };
}

function applyCreditRefill() {
  state.creditUsage = normalizeCreditUsage(state.creditUsage, state.pro, state.credits, state);
  state.credits = remainingMonthlyCredits(state.pro, state.creditUsage);
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

function shouldAskPhone() {
  return currentUser && !state.pro && !state.phoneVerified && !state.phoneSkipped;
}

function openPhoneDialog() {
  if (!currentUser) return;
  phoneStatus.textContent = 'Verify once to keep normal free credits. You can skip, but free credits drop to $0.100 daily.';
  phoneCodeWrap.hidden = true;
  confirmPhoneCodeButton.hidden = true;
  sendPhoneCodeButton.hidden = false;
  if (!phoneDialog.open) {
    phoneDialog.showModal();
  }
}

function ensurePhoneVerifier() {
  if (phoneVerifier) return phoneVerifier;
  phoneVerifier = new RecaptchaVerifier(auth, 'phoneRecaptcha', {
    size: 'invisible',
    callback: () => {},
  });
  return phoneVerifier;
}

async function sendPhoneCode() {
  if (!auth || !currentUser) {
    phoneStatus.textContent = 'Log in with Google first.';
    return;
  }
  const phoneNumber = phoneInput.value.trim();
  if (!phoneNumber.startsWith('+') || phoneNumber.length < 8) {
    phoneStatus.textContent = 'Use full format, like +15555555555.';
    return;
  }
  try {
    sendPhoneCodeButton.disabled = true;
    phoneStatus.textContent = 'Sending code...';
    const provider = new PhoneAuthProvider(auth);
    phoneConfirmation = await provider.verifyPhoneNumber(phoneNumber, ensurePhoneVerifier());
    phoneStatus.textContent = 'Code sent. Type the 6 digits from your text.';
    phoneCodeWrap.hidden = false;
    confirmPhoneCodeButton.hidden = false;
    sendPhoneCodeButton.hidden = true;
    phoneCodeInput.focus();
  } catch (error) {
    phoneStatus.textContent = firebaseAuthMessage(error, 'Phone verification could not start. Make sure Phone is enabled in Firebase Authentication.');
    resetPhoneVerifier();
  } finally {
    sendPhoneCodeButton.disabled = false;
  }
}

async function confirmPhoneCode() {
  if (!phoneConfirmation || !currentUser) {
    phoneStatus.textContent = 'Send a code first.';
    return;
  }
  const code = phoneCodeInput.value.trim();
  if (code.length < 6) {
    phoneStatus.textContent = 'Type the 6 digit code.';
    return;
  }
  try {
    confirmPhoneCodeButton.disabled = true;
    phoneStatus.textContent = 'Verifying...';
    const credential = PhoneAuthProvider.credential(phoneConfirmation, code);
    await linkWithCredential(currentUser, credential);
    state.phoneVerified = true;
    state.phoneSkipped = false;
    state.creditUsage = normalizeCreditUsage(state.creditUsage, state.pro, state.credits, state);
    persistState();
    render();
    phoneStatus.textContent = 'Phone verified. Normal free credits are active.';
    phoneDialog.close();
  } catch (error) {
    if (error?.code === 'auth/provider-already-linked' || error?.code === 'auth/credential-already-in-use') {
      state.phoneVerified = true;
      state.phoneSkipped = false;
      persistState();
      render();
      phoneDialog.close();
      return;
    }
    phoneStatus.textContent = firebaseAuthMessage(error, 'That code did not work. Try again.');
  } finally {
    confirmPhoneCodeButton.disabled = false;
  }
}

function skipPhoneVerification() {
  state.phoneVerified = false;
  state.phoneSkipped = true;
  state.creditUsage = normalizeCreditUsage(state.creditUsage, state.pro, state.credits, state);
  persistState();
  render();
  phoneDialog.close();
}

function resetPhoneVerifier() {
  try {
    phoneVerifier?.clear();
  } catch {}
  phoneVerifier = null;
}

function firebaseAuthMessage(error, fallback) {
  const code = error?.code || '';
  if (code === 'auth/operation-not-allowed') {
    return 'Enable this sign-in method in Firebase Authentication first.';
  }
  if (code === 'auth/unauthorized-domain') {
    return 'Add this website domain to Firebase Authentication authorized domains.';
  }
  if (code === 'auth/invalid-phone-number') {
    return 'That phone number needs country code format, like +15555555555.';
  }
  if (code === 'auth/too-many-requests') {
    return 'Too many tries right now. Wait a little and try again.';
  }
  if (code === 'auth/popup-closed-by-user') {
    return 'Login was closed before it finished.';
  }
  if (code === 'auth/invalid-action-code') {
    return 'Firebase said the requested action is invalid. Refresh, use the live domain, and check authorized domains.';
  }
  return error?.message || fallback;
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
    const row = document.createElement('div');
    row.className = `chat-row${chat.id === state.activeChatId ? ' active' : ''}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chat-item';
    button.innerHTML = `<span>${escapeHtml(chat.title)}</span><small>${chat.messages.length}</small>`;
    button.addEventListener('click', () => {
      state.activeChatId = chat.id;
      closeComputerMode();
      persistState();
      render();
    });
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'delete-chat';
    deleteButton.setAttribute('aria-label', `Delete ${chat.title}`);
    deleteButton.textContent = 'X';
    deleteButton.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteChat(chat.id);
    });
    row.append(button, deleteButton);
    chatList.appendChild(row);
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
        <p>${model.api}. Costs ${formatMoney(activeCost())} per message${state.computerMode ? ' in computer mode' : ''}. Free limits are ${formatMoney(activeFreePlan().daily)} daily, ${formatMoney(activeFreePlan().weekly)} weekly, and ${formatMoney(activeFreePlan().monthly)} monthly.</p>
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
  creditStatus.textContent = `${formatMoney(remainingDailyCredits())} today / ${formatMoney(remainingMonthlyCredits())} month`;
  renderConnectOptions();
  renderModeShell();
  if (currentUser) {
    googleButtonText.textContent = currentUser.displayName || currentUser.email || 'Google account';
    planStatus.textContent = state.pro ? 'Pro' : 'Normal';
    planStatus.hidden = false;
    phoneVerifyButton.hidden = state.pro || state.phoneVerified;
    phoneVerifyButton.textContent = state.phoneSkipped ? 'Verify phone for more credits' : 'Verify phone';
    signOutButton.hidden = false;
    saveStatus.textContent = state.phoneVerified
      ? `Phone verified. Chats sync with Firebase for ${currentUser.email || 'this account'}.`
      : `Phone not verified. Free credits are ${formatMoney(activeFreePlan().daily)} daily.`;
  } else if (cloudReady) {
    googleButtonText.textContent = 'Log in or sign up';
    planStatus.textContent = 'Normal';
    planStatus.hidden = true;
    phoneVerifyButton.hidden = true;
    signOutButton.hidden = true;
    saveStatus.textContent = 'Sign in with Google to save chats with Firebase.';
  } else {
    googleButtonText.textContent = 'Firebase not configured';
    planStatus.textContent = 'Normal';
    planStatus.hidden = true;
    phoneVerifyButton.hidden = true;
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

  if (!currentUser) {
    alert('Log in with Google to use ROTEX credits and chat.');
    if (auth) {
      try {
        await signInWithPopup(auth, new GoogleAuthProvider());
      } catch (error) {
        alert(firebaseAuthMessage(error, 'Google login could not start.'));
      }
    }
    return;
  }

  if (shouldAskPhone()) {
    openPhoneDialog();
    return;
  }

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
  if (!canSpendCredits(cost)) {
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

  spendCredits(cost);
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
    const authToken = await currentUser.getIdToken();
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authToken,
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
  appShell.hidden = true;
  proPage.hidden = false;
  window.location.hash = 'pro';
}

function closeProPage() {
  proPage.hidden = true;
  appShell.hidden = false;
  if (window.location.hash === '#pro') {
    history.pushState('', document.title, window.location.pathname + window.location.search);
  }
}

function deleteChat(chatId) {
  const deletingActive = state.activeChatId === chatId;
  state.chats = state.chats.filter((chat) => chat.id !== chatId);
  if (state.chats.length === 0) {
    const id = crypto.randomUUID();
    state.chats = [{ id, title: 'New ROTEX chat', createdAt: Date.now(), messages: [] }];
    state.activeChatId = id;
  } else if (deletingActive) {
    state.activeChatId = state.chats[0].id;
  }
  persistState();
  render();
}

async function continueCheckout() {
  if (!currentUser) {
    alert('Log in with Google before upgrading so ROTEX can apply Pro to your account.');
    return;
  }
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

async function handleCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('session_id');
  if (params.get('checkout') !== 'success' || !sessionId || !currentUser) return;

  setCloudStatus('Verifying Pro');
  try {
    const response = await fetch('/api/verify-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, uid: currentUser.uid }),
    });
    const data = await response.json();
    if (!data.verified) {
      alert(data.message || 'Checkout could not be verified yet.');
      return;
    }
    state.pro = true;
    state.stripeSubscriptionId = data.subscriptionId || state.stripeSubscriptionId || '';
    state.creditUsage = normalizeCreditUsage({}, true, creditPlans.pro.monthly);
    state.credits = remainingMonthlyCredits(true, state.creditUsage);
    persistState();
    setCloudStatus('Pro active');
    history.replaceState('', document.title, window.location.pathname);
    closeProPage();
    render();
  } catch (error) {
    alert('ROTEX could not verify Stripe yet. Try refreshing after Stripe redirects back.');
  }
}

function formatMoney(value) {
  return `$${Number(value).toFixed(3)}`;
}

function activeCreditPlan(pro = state.pro) {
  return pro ? creditPlans.pro : activeFreePlan();
}

function activeFreePlan(value = state) {
  return value?.phoneVerified ? creditPlans.normal : creditPlans.limited;
}

function remainingDailyCredits(pro = state.pro, usage = state.creditUsage) {
  const plan = activeCreditPlan(pro);
  return Math.max(0, plan.daily - (Number(usage?.daySpent) || 0));
}

function remainingWeeklyCredits(pro = state.pro, usage = state.creditUsage) {
  const plan = activeCreditPlan(pro);
  return Math.max(0, plan.weekly - (Number(usage?.weekSpent) || 0));
}

function remainingMonthlyCredits(pro = state.pro, usage = state.creditUsage) {
  const plan = activeCreditPlan(pro);
  return Math.max(0, plan.monthly - (Number(usage?.monthSpent) || 0));
}

function canSpendCredits(cost) {
  applyCreditRefill();
  return (
    remainingDailyCredits() + 0.0000001 >= cost &&
    remainingWeeklyCredits() + 0.0000001 >= cost &&
    remainingMonthlyCredits() + 0.0000001 >= cost
  );
}

function spendCredits(cost) {
  state.creditUsage.daySpent += cost;
  state.creditUsage.weekSpent += cost;
  state.creditUsage.monthSpent += cost;
  state.credits = remainingMonthlyCredits();
}

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function weekKey() {
  const date = new Date();
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const dayNumber = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start.getTime()) / 86400000) + 1;
  const weekNumber = Math.ceil((dayNumber + start.getUTCDay()) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNumber).padStart(2, '0')}`;
}

function monthKey() {
  return new Date().toISOString().slice(0, 7);
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
  if (deviceRole === 'phone' && state.pcBridge.connected) {
    pcPairStatus.textContent = 'Your phone is connected to a PC. Use the PC page to approve folders or disable access here anytime.';
  } else if (deviceRole === 'pc' && state.pcBridge.connected) {
    pcPairStatus.textContent = 'PC connected. Keep this page open on the PC when you want ROTEX to work with approved files.';
  } else if (deviceRole === 'phone' && state.pcBridge.code) {
    pcPairStatus.textContent = 'Code ready. Type it on your PC from Settings / Share. This blocks phone-to-phone pairing.';
  } else if (deviceRole === 'pc' && state.pcBridge.code) {
    pcPairStatus.textContent = 'Type this code on your PC from Settings > Share to finish pairing.';
  } else if (deviceRole === 'pc') {
    pcPairStatus.textContent = 'Open ROTEX on your phone first and make a code. This blocks PC-to-PC pairing.';
  } else {
    pcPairStatus.textContent = 'Make a 3 digit code on your phone, then type it on your PC from Settings / Share.';
  }
  pcPairCode.textContent = state.pcBridge.code || '---';
  pcFolderStatus.textContent = state.pcBridge.folderReady
    ? `Approved PC folder: ${state.pcBridge.folderName || 'selected folder'}`
    : 'No PC folder approved yet. On the PC, connect first, then choose a folder.';
  makePcCodeButton.hidden = deviceRole !== 'phone';
  pcCodeInput.hidden = deviceRole !== 'pc';
  pairPcButton.hidden = deviceRole !== 'pc';
  choosePcFolderButton.hidden = deviceRole !== 'pc';
  choosePcFolderButton.disabled = deviceRole !== 'pc' || !state.pcBridge.connected;
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
  if (deviceRole === 'pc') {
    pcCodeInput.focus();
  }
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
  button.addEventListener('click', async () => {
    const value = button.dataset.connect;
    const provider = button.dataset.provider;
    if (value === 'all') {
      state.computerConnections = [...connectableServices];
      announceActivation('Google Drive, GitHub, and PC');
    } else if (value === 'PC') {
      activateService('PC');
      openPcDialog();
    } else if (state.computerConnections.includes(value)) {
      setConnection(value, false);
    } else if (provider) {
      setConnection(value, true);
    } else {
      activateService(value);
    }
    persistState();
    render();
    if (provider) {
      await startProviderConnect(provider);
    }
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
  if (deviceRole !== 'phone') {
    pcPairStatus.textContent = 'Make the code from your phone. PC-to-PC pairing is blocked.';
    return;
  }
  state.pcBridge = {
    code: String(Math.floor(100 + Math.random() * 900)),
    connected: false,
    requesterRole: 'phone',
    connectedRole: '',
    folderName: '',
    folderReady: false,
    createdAt: Date.now(),
  };
  activateService('PC', false);
  persistState();
  render();
  openPcDialog();
});

pairPcButton.addEventListener('click', () => {
  if (deviceRole !== 'pc') {
    pcPairStatus.textContent = 'Enter the code from your PC. Phone-to-phone pairing is blocked.';
    return;
  }
  if (state.pcBridge.requesterRole !== 'phone') {
    pcPairStatus.textContent = 'Make a fresh code on your phone first. PC-to-PC pairing is blocked.';
    return;
  }
  const typedCode = pcCodeInput.value.trim();
  if (!state.pcBridge.code || typedCode !== state.pcBridge.code) {
    pcPairStatus.textContent = 'That code does not match. Check the 3 digits and try again.';
    return;
  }
  state.pcBridge.connected = true;
  state.pcBridge.connectedRole = 'pc';
  state.pcBridge.pairedAt = Date.now();
  activateService('PC', false);
  announceActivation('PC');
  persistState();
  render();
  openPcDialog();
});

choosePcFolderButton.addEventListener('click', async () => {
  if (deviceRole !== 'pc') {
    pcPairStatus.textContent = 'Folders can only be approved on the connected PC.';
    return;
  }
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
    const response = await fetch(`/api/connect/${provider}`, { cache: 'no-store' });
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
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (error) {
    alert(firebaseAuthMessage(error, 'Google login could not start.'));
  }
});

signOutButton.addEventListener('click', async () => {
  if (auth) await signOut(auth);
});

phoneVerifyButton.addEventListener('click', openPhoneDialog);
sendPhoneCodeButton.addEventListener('click', sendPhoneCode);
confirmPhoneCodeButton.addEventListener('click', confirmPhoneCode);
skipPhoneButton.addEventListener('click', skipPhoneVerification);
upgradeButton.addEventListener('click', startUpgrade);
closeProPageButton.addEventListener('click', closeProPage);
checkoutButton.addEventListener('click', continueCheckout);

if (window.location.hash === '#pro') {
  startUpgrade();
}

document.addEventListener('contextmenu', (event) => event.preventDefault());
document.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if (key === 'f12' || (event.ctrlKey && event.shiftKey && ['i', 'j', 'c'].includes(key)) || (event.ctrlKey && key === 'u')) {
    event.preventDefault();
  }
});
