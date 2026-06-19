import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import {
  createUserWithEmailAndPassword,
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  linkWithCredential,
  onAuthStateChanged,
  PhoneAuthProvider,
  RecaptchaVerifier,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  updateProfile,
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
    id: 'gbt',
    name: 'GBT',
    short: 'OpenRouter GPT',
    api: 'ROTEX',
    cost: 0.004,
    computerCost: 0.012,
    logo: 'G',
    maker: 'gbt',
    description: 'Fast GPT model through OpenRouter.',
  },
  {
    id: 'groq',
    name: 'Groq',
    short: 'Fast',
    api: 'ROTEX',
    cost: 0.002,
    computerCost: 0.01,
    logo: 'Q',
    maker: 'groq',
    description: 'Fast model routed through OpenRouter.',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    short: 'Google',
    api: 'ROTEX',
    cost: 0.003,
    computerCost: 0.01,
    logo: 'Ge',
    maker: 'gemini',
    description: 'Google model through OpenRouter.',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    short: 'Code',
    api: 'ROTEX',
    cost: 0.004,
    computerCost: 0.012,
    logo: 'D',
    maker: 'deepseek',
    description: 'Coding and general work through OpenRouter.',
  },
  {
    id: 'claude-sonnet',
    name: 'Claude Sonnet',
    short: 'Expensive careful',
    api: 'ROTEX',
    cost: 0.4,
    computerCost: 0.8,
    logo: 'CS',
    maker: 'claude',
    proOnly: true,
    description: 'Expensive Pro model for careful project work and bigger fixes.',
  },
  {
    id: 'claude-opus',
    name: 'Claude Opus',
    short: 'Most expensive',
    api: 'ROTEX',
    cost: 0.75,
    computerCost: 1.5,
    logo: 'CO',
    maker: 'claude',
    proOnly: true,
    description: 'Most expensive Claude option for hard architecture, debugging, and agent planning.',
  },
  {
    id: 'grok-3-4',
    name: 'Grok 3.4',
    short: 'Expensive reasoning',
    api: 'ROTEX',
    cost: 0.45,
    computerCost: 0.9,
    logo: 'X',
    maker: 'grok',
    proOnly: true,
    description: 'Expensive Pro reasoning model for broad context and hard decisions.',
  },
  {
    id: 'gbt-5-5',
    name: 'GBT 5.5',
    short: 'Expensive smart',
    api: 'ROTEX',
    cost: 0.7,
    computerCost: 1.4,
    logo: 'G5',
    maker: 'gbt',
    proOnly: true,
    description: 'Very expensive Pro smart model for frontier-level tasks.',
  },
  {
    id: 'deepseek-smart',
    name: 'DeepSeek Smartest',
    short: 'Smartest DeepSeek',
    api: 'ROTEX',
    cost: 0.3,
    computerCost: 0.6,
    logo: 'DS',
    maker: 'deepseek',
    proOnly: true,
    description: 'Expensive Pro DeepSeek model for the smartest code and reasoning tasks.',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    short: 'Local',
    api: 'Local',
    cost: 0,
    computerCost: 0,
    logo: 'O',
    maker: 'ollama',
    localOnly: true,
    description: 'Runs on your own PC with Ollama. Free and private.',
  },
];

const modelAliases = {
  'llama-3-3-70b': 'groq',
  'deepseek-v3': 'deepseek',
  'deepseek-r1': 'deepseek-smart',
  'deepseek-smart': 'deepseek-smart',
  'deepseek-smartest': 'deepseek-smart',
  'gemini-flash-lite': 'gemini',
  'gemini-flash': 'gemini',
  'gemini-pro': 'gemini',
  'gpt-4o-mini': 'gbt',
  'gpt-4o': 'gbt',
  'gpt-5-1': 'gbt-5-5',
  'gpt-5-1-codex': 'gbt-5-5',
  'gpt-5-2': 'gbt-5-5',
  'gpt-5-5': 'gbt-5-5',
  'gbt-5.5': 'gbt-5-5',
  'o3': 'gbt',
  'o4-mini': 'gbt',
  claude: 'claude-sonnet',
  'claude-haiku': 'claude-sonnet',
  'claude-sonnet': 'claude-sonnet',
  'claude-opus': 'claude-opus',
  'claude-fable': 'claude-sonnet',
  grok: 'grok-3-4',
  'grok-3.4': 'grok-3-4',
  'qwen-flash': 'gbt',
  'qwen-max': 'gbt',
  codestral: 'gbt',
  'mistral-large': 'gbt',
  'rod-1': 'groq',
  'rod-thinking': 'deepseek',
  'rod-brain': 'claude-sonnet',
  'tex-0': 'deepseek',
  'tex-1-5': 'claude-sonnet',
  'tex-2': 'gbt-5-5',
  'tex-2-5': 'claude-opus',
  'treesearch-q': 'deepseek-smart',
  'ron-1-lite': 'groq',
  'ron-1-hard': 'deepseek',
  'rreas-2-1': 'deepseek',
  'rtrox-cheap': 'claude-sonnet',
  'rtrox-1-8': 'claude-sonnet',
  'rtrox-3': 'claude-opus',
  'rtrox-hard': 'claude-opus',
};

function resolveClientModelId(id) {
  const resolved = modelAliases[id] || id;
  return models.some((model) => model.id === resolved) ? resolved : models[0].id;
}

const chatList = document.querySelector('#chatList');
const appShell = document.querySelector('#appShell');
const sidebar = document.querySelector('#sidebar');
const mobileMenuButton = document.querySelector('#mobileMenuButton');
const mobileSidebarBackdrop = document.querySelector('#mobileSidebarBackdrop');
const mobileNewChatButton = document.querySelector('#mobileNewChatButton');
const messagesEl = document.querySelector('#messages');
const composer = document.querySelector('#composer');
const messageInput = document.querySelector('#messageInput');
const attachmentTray = document.querySelector('#attachmentTray');
const attachmentInput = document.querySelector('#attachmentInput');
const folderInput = document.querySelector('#folderInput');
const attachButton = document.querySelector('#attachButton');
const attachMenu = document.querySelector('#attachMenu');
const attachFilesButton = document.querySelector('#attachFilesButton');
const attachFolderButton = document.querySelector('#attachFolderButton');
const newChatButton = document.querySelector('#newChatButton');
const teamupEntry = document.querySelector('#teamupEntry');
const teamupCreditStatus = document.querySelector('#teamupCreditStatus');
const googleButton = document.querySelector('#googleButton');
const googleButtonText = document.querySelector('#googleButtonText');
const accountMenu = document.querySelector('#accountMenu');
const accountMenuLogout = document.querySelector('#accountMenuLogout');
const accountMenuUpgrade = document.querySelector('#accountMenuUpgrade');
const planStatus = document.querySelector('#planStatus');
const saveStatus = document.querySelector('#saveStatus');
const syncStatus = document.querySelector('#syncStatus');
const creditStatus = document.querySelector('#creditStatus');
const upgradeButton = document.querySelector('#upgradeButton');
const accountPage = document.querySelector('#accountPage');
const accountBackBtn = document.querySelector('#accountBackBtn');
const closeAccountBtn = document.querySelector('#closeAccountBtn');
const acctAvatar = document.querySelector('#acctAvatar');
const acctName = document.querySelector('#acctName');
const acctEmail = document.querySelector('#acctEmail');
const acctPlanBadge = document.querySelector('#acctPlanBadge');
const acctUpgradeBlock = document.querySelector('#acctUpgradeBlock');
const acctAccountBlock = document.querySelector('#acctAccountBlock');
const accountSignOutBtn = document.querySelector('#accountSignOutBtn');
const authPage = document.querySelector('#authPage');
const authBackButton = document.querySelector('#authBackButton');
const authTitle = document.querySelector('#authTitle');
const authStatus = document.querySelector('#authStatus');
const authMethodStep = document.querySelector('#authMethodStep');
const authEmailStep = document.querySelector('#authEmailStep');
const authCodeStep = document.querySelector('#authCodeStep');
const authGoogleButton = document.querySelector('#authGoogleButton');
const chooseEmailButton = document.querySelector('#chooseEmailButton');
const authEmailInput = document.querySelector('#authEmailInput');
const authCodeInput = document.querySelector('#authCodeInput');
const sendEmailCodeButton = document.querySelector('#sendEmailCodeButton');
const emailLoginButton = document.querySelector('#emailLoginButton');
const backToEmailButton = document.querySelector('#backToEmailButton');
const profileFields = document.querySelector('#profileFields');
const profileNameInput = document.querySelector('#profileNameInput');
const profileNicknameInput = document.querySelector('#profileNicknameInput');
const saveProfileButton = document.querySelector('#saveProfileButton');
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
const phoneStatus = document.querySelector('#phoneStatus');
const phoneInput = document.querySelector('#phoneInput');
const phoneCodeWrap = document.querySelector('#phoneCodeWrap');
const phoneCodeInput = document.querySelector('#phoneCodeInput');
const sendPhoneCodeButton = document.querySelector('#sendPhoneCodeButton');
const confirmPhoneCodeButton = document.querySelector('#confirmPhoneCodeButton');
const skipPhoneButton = document.querySelector('#skipPhoneButton');
const phoneVerifyBadge = document.querySelector('#phoneVerifyBadge');
const newComputerChatButton = document.querySelector('#newComputerChatButton');
const computerChatList = document.querySelector('#computerChatList');
const personalityDialog = document.querySelector('#personalityDialog');
const personalityOptions = document.querySelectorAll('.personality-option');
const teamupDialog = document.querySelector('#teamupDialog');
const teamupStatus = document.querySelector('#teamupStatus');
const teamupBotA = document.querySelector('#teamupBotA');
const teamupBotB = document.querySelector('#teamupBotB');
const makeTeamupRoomButton = document.querySelector('#makeTeamupRoomButton');

const storageKey = 'rotex:web:v2';
const pendingActivationKey = 'rotex:pending-activation';
const pendingAuthReasonKey = 'rotex:pending-auth-reason';
const creditPlans = {
  normal: { daily: 0.3, weekly: 0.9, monthly: 1.5 },
  limited: { daily: 0.1, weekly: 0.3, monthly: 0.5 },
  pro: { daily: 1, weekly: 10, monthly: 10 },
};
const freeComputerMessagesPerDay = 3;
const weeklyTeamupTokens = 10000;
const connectableServices = ['Google Drive', 'GitHub'];
const personalities = {
  normal: 'Normal: direct, useful, friendly, no big intro.',
  fast: 'Fast: short answers first, no fluff.',
  coder: 'Coder: practical implementation help, precise steps, code when useful.',
  chill: 'Chill: casual, simple, but still helpful.',
};
const deviceRole = detectDeviceRole();
let state = loadState();
let auth = null;
let db = null;
let currentUser = null;
let cloudReady = false;
let saveTimer = null;
let phoneVerifier = null;
let phoneConfirmation = null;
let authReason = localStorage.getItem(pendingAuthReasonKey) || 'account';
let emailCodeToken = '';
let accountView = 'account';
let pendingAttachments = [];
let suppressProfileClick = false;
let suppressAccountMenuClick = false;
const ProOverrideEmails = new Set(['rayf24241@gmail.com']);
const maxAttachments = 30;
const readableExtensions = new Set(['txt', 'md', 'json', 'js', 'ts', 'tsx', 'jsx', 'html', 'css', 'py', 'csv', 'xml', 'yml', 'yaml', 'bat', 'ps1', 'java', 'c', 'cpp', 'cs', 'go', 'rs', 'php', 'rb', 'sql', 'env', 'gitignore']);

initFirebase();
applyPendingActivation();
ensureFreshProPass();
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
        if (needsProfile()) {
          openAuthPage(authReason, true);
        } else if (authReason === 'upgrade') {
          closeAuthPage();
          await startUpgrade();
        } else {
          closeAuthPage();
        }
      } else {
        localStorage.removeItem(storageKey);
        state = normalizeState({});
      }
      render();
    });

    // Handle redirect sign-in result (fires after signInWithRedirect completes)
    try {
      await getRedirectResult(auth);
    } catch (error) {
      console.warn('Redirect result error:', error);
    }
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
  const accountState = { phoneVerified, phoneSkipped };
  const creditUsage = normalizeCreditUsage(value.creditUsage, pro, value.credits, accountState);
  const plan = pro ? creditPlans.pro : activeFreePlan(accountState);

  return {
    activeModel: resolveClientModelId(value.activeModel || 'gbt'),
    computerMode: Boolean(value.computerMode),
    pro,
    phoneVerified,
    phoneSkipped,
    profile: normalizeProfile(value.profile),
    creditUsage,
    computerUsage: normalizeComputerUsage(value.computerUsage),
    teamupUsage: normalizeTeamupUsage(value.teamupUsage),
    teamupRooms: Array.isArray(value.teamupRooms) ? value.teamupRooms.slice(0, 1).map(normalizeTeamupRoom).filter(Boolean) : [],
    computerConnections: Array.isArray(value.computerConnections)
      ? value.computerConnections.filter((item) => connectableServices.includes(item))
      : [],
    pcBridge: normalizePcBridge(value.pcBridge),
    activeChatId: value.activeChatId || chats[0].id,
    credits: Math.max(0, plan.monthly - (Number(creditUsage.monthSpent) || 0)),
    chats,
  };
}

function normalizeTeamupRoom(value) {
  const botA = resolveClientModelId(value?.botA || 'deepseek');
  const botB = resolveClientModelId(value?.botB || 'gbt');
  if (botA === botB) return { id: value?.id || crypto.randomUUID(), botA, botB: botA === 'gbt' ? 'deepseek' : 'gbt' };
  return { id: value?.id || crypto.randomUUID(), botA, botB };
}

function normalizeProfile(value) {
  return {
    name: typeof value?.name === 'string' ? value.name.slice(0, 24) : '',
    usernameKey: typeof value?.usernameKey === 'string' ? value.usernameKey.slice(0, 32) : '',
    nickname: typeof value?.nickname === 'string' ? value.nickname.slice(0, 24) : '',
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

function isMobileLayout() {
  return window.matchMedia?.('(max-width: 920px)').matches || deviceRole === 'phone';
}

function setMobileLayout() {
  document.body.classList.toggle('mobile-layout', isMobileLayout());
  if (!isMobileLayout()) {
    closeMobileSidebar();
  }
}

function openMobileSidebar() {
  if (!isMobileLayout()) return;
  document.body.classList.add('mobile-sidebar-open');
  mobileMenuButton?.setAttribute('aria-expanded', 'true');
  if (mobileSidebarBackdrop) mobileSidebarBackdrop.hidden = false;
}

function closeMobileSidebar() {
  document.body.classList.remove('mobile-sidebar-open');
  mobileMenuButton?.setAttribute('aria-expanded', 'false');
  if (mobileSidebarBackdrop) mobileSidebarBackdrop.hidden = true;
}

function normalizeComputerUsage(value) {
  const today = dayKey();
  if (!value || value.day !== today) {
    return { day: today, count: 0 };
  }
  return { day: today, count: Number(value.count) || 0 };
}

function normalizeTeamupUsage(value) {
  const week = weekKey();
  if (!value || value.week !== week) {
    return { week, spent: 0 };
  }
  return { week, spent: Math.max(0, Number(value.spent) || 0) };
}

function applyCreditRefill() {
  state.creditUsage = normalizeCreditUsage(state.creditUsage, state.pro, state.credits, state);
  state.credits = remainingMonthlyCredits(state.pro, state.creditUsage);
}

function applyComputerUsageReset() {
  state.computerUsage = normalizeComputerUsage(state.computerUsage);
  state.teamupUsage = normalizeTeamupUsage(state.teamupUsage);
}

function persistState() {
  applyCreditRefill();
  applyComputerUsageReset();
  applyAccountOverrides();
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
    const planWasChanged = applyAccountOverrides();
    localStorage.setItem(storageKey, JSON.stringify(state));
    if (planWasChanged) {
      await setDoc(doc(db, 'users', currentUser.uid, 'chatState', 'main'), {
        ...state,
        updatedAt: serverTimestamp(),
      });
    }
  } else {
    applyAccountOverrides();
    await setDoc(doc(db, 'users', currentUser.uid, 'chatState', 'main'), {
      ...state,
      updatedAt: serverTimestamp(),
    });
  }
  setCloudStatus('Synced');
}

function applyAccountOverrides() {
  const email = currentUser?.email?.toLowerCase?.() || '';
  if (!ProOverrideEmails.has(email) || state.pro) return false;
  state.pro = true;
  state.creditUsage = normalizeCreditUsage(state.creditUsage, true, state.credits, state);
  state.credits = remainingMonthlyCredits(true, state.creditUsage);
  return true;
}

function needsProfile() {
  return currentUser && !state.profile?.usernameKey;
}

function openAuthPage(reason = 'account', forceProfile = false) {
  authReason = reason;
  localStorage.setItem(pendingAuthReasonKey, reason);
  appShell.hidden = true;
  accountPage.hidden = true;
  authPage.hidden = false;
  window.location.hash = 'authPage';
  if (currentUser && (forceProfile || needsProfile())) {
    showAuthStep('profile');
    return;
  }
  showAuthStep('method');
}

function closeAuthPage() {
  authPage.hidden = true;
  appShell.hidden = false;
  localStorage.removeItem(pendingAuthReasonKey);
  if (window.location.hash === '#authPage') {
    history.pushState('', document.title, window.location.pathname + window.location.search);
  }
}

function openAccountPage(focusUpgrade = false) {
  accountView = focusUpgrade ? 'upgrade' : 'account';
  closeAccountMenu();
  authPage.hidden = true;
  appShell.hidden = true;
  accountPage.hidden = false;
  window.location.hash = focusUpgrade ? 'pro' : 'account';
  renderAccount();
  window.scrollTo({ top: 0, left: 0 });
  if (focusUpgrade && !isMobileLayout()) {
    acctUpgradeBlock?.scrollIntoView({ block: 'center' });
  }
}

function closeAccountPage() {
  accountPage.hidden = true;
  appShell.hidden = false;
  window.scrollTo({ top: 0, left: 0 });
  if (window.location.hash === '#account' || window.location.hash === '#pro') {
    history.pushState('', document.title, window.location.pathname + window.location.search);
  }
}

function toggleAccountMenu() {
  if (!accountMenu) return;
  accountMenu.hidden = !accountMenu.hidden;
}

function closeAccountMenu() {
  if (accountMenu) accountMenu.hidden = true;
}

function openAccountMenuAction(focusUpgrade = false) {
  openAccountPage(focusUpgrade);
}

function handleProfileAction(event) {
  event.preventDefault();
  event.stopPropagation();
  if (currentUser) {
    toggleAccountMenu();
  } else {
    openAuthPage('account');
  }
}

function handleAccountMenuAction(event, focusUpgrade = false) {
  event.preventDefault();
  event.stopPropagation();
  openAccountMenuAction(focusUpgrade);
}

async function logOutCurrentAccount(event) {
  event?.preventDefault();
  event?.stopPropagation();
  closeAccountMenu();
  closeAccountPage();
  if (auth) await signOut(auth);
}

async function signInWithGoogleFromAuth() {
  if (!auth) {
    authStatus.textContent = 'Firebase is starting, try again in a second.';
    return;
  }
  try {
    authStatus.textContent = 'Opening Google login...';
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (error) {
    const code = error?.code || '';
    if (code === 'auth/popup-blocked' || code === 'auth/popup-closed-by-user') {
      try {
        authStatus.textContent = 'Redirecting to Google...';
        await signInWithRedirect(auth, new GoogleAuthProvider());
      } catch (redirectError) {
        authStatus.textContent = firebaseAuthMessage(redirectError, 'Google login could not start.');
      }
    } else {
      authStatus.textContent = firebaseAuthMessage(error, 'Google login could not start.');
    }
  }
}

function showAuthStep(step) {
  authMethodStep.hidden = step !== 'method';
  authEmailStep.hidden = step !== 'email';
  authCodeStep.hidden = step !== 'code';
  profileFields.hidden = step !== 'profile';

  // Back button: hidden on method step, shown on all others
  if (authBackButton) {
    authBackButton.hidden = step === 'method';
    authBackButton.onclick = step === 'code'
      ? () => showAuthStep('email')
      : () => showAuthStep('method');
  }

  if (step === 'method') {
    authTitle.textContent = 'Log in';
    authStatus.textContent = 'Choose how you want to sign in.';
  }
  if (step === 'email') {
    authTitle.textContent = 'Email login';
    authStatus.textContent = 'Enter your email and ROTEX will send a code.';
    authEmailInput.focus();
  }
  if (step === 'code') {
    authTitle.textContent = 'Check email';
    authStatus.textContent = 'Type the code ROTEX sent you.';
    authCodeInput.focus();
  }
  if (step === 'profile') {
    authTitle.textContent = 'Finish account';
    authStatus.textContent = 'Pick a name and nickname for your ROTEX account.';
    profileNameInput.value = state.profile?.name || currentUser?.displayName || '';
    profileNicknameInput.value = state.profile?.nickname || '';
    profileNameInput.focus();
  }
}

async function sendEmailCodeNotice() {
  const email = authEmailInput.value.trim();
  if (!email.includes('@')) {
    authStatus.textContent = 'Enter your email first.';
    return;
  }
  try {
    sendEmailCodeButton.disabled = true;
    authStatus.textContent = 'Sending code...';
    const response = await fetch('/api/send-email-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await response.json();
    if (!data.ok) {
      authStatus.textContent = data.message || 'ROTEX could not send that code.';
      return;
    }
    emailCodeToken = data.token;
    authCodeInput.value = '';
    showAuthStep('code');
    if (data.devCode) {
      authStatus.textContent = `${data.message} Code: ${data.devCode}`;
    }
  } catch {
    authStatus.textContent = 'Email codes are not ready yet.';
  } finally {
    sendEmailCodeButton.disabled = false;
  }
}

async function continueEmailLogin() {
  if (!auth) {
    authStatus.textContent = 'Firebase is not configured yet. Add Firebase env vars in Vercel.';
    return;
  }
  const email = authEmailInput.value.trim();
  const code = authCodeInput.value.trim();
  if (!email.includes('@')) {
    authStatus.textContent = 'Enter a real email.';
    return;
  }
  if (!emailCodeToken) {
    authStatus.textContent = 'Send a code first.';
    showAuthStep('email');
    return;
  }
  if (code.length < 6) {
    authStatus.textContent = 'Type the 6 digit email code.';
    return;
  }
  try {
    emailLoginButton.disabled = true;
    authStatus.textContent = 'Verifying code...';
    const verifyResponse = await fetch('/api/verify-email-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code, token: emailCodeToken }),
    });
    const verified = await verifyResponse.json();
    if (!verified.ok) {
      authStatus.textContent = verified.message || 'That code is wrong or expired.';
      return;
    }
    authStatus.textContent = 'Logging in...';
    await signInWithEmailAndPassword(auth, email, verified.sessionPassword);
  } catch (error) {
    if (error?.code !== 'auth/invalid-credential' && error?.code !== 'auth/user-not-found') {
      authStatus.textContent = firebaseAuthMessage(error, 'Email login failed.');
      emailLoginButton.disabled = false;
      return;
    }
    try {
      authStatus.textContent = 'Creating email account...';
      const verifyResponse = await fetch('/api/verify-email-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code, token: emailCodeToken }),
      });
      const verified = await verifyResponse.json();
      if (!verified.ok) {
        authStatus.textContent = verified.message || 'That code is wrong or expired.';
        return;
      }
      await createUserWithEmailAndPassword(auth, email, verified.sessionPassword);
    } catch (createError) {
      authStatus.textContent = firebaseAuthMessage(createError, 'Email signup failed.');
    }
  } finally {
    emailLoginButton.disabled = false;
  }
}

async function saveProfile() {
  if (!currentUser) {
    authStatus.textContent = 'Log in first.';
    return;
  }
  const name = profileNameInput.value.trim();
  // Auto-fill nickname from first name if left blank
  const nickname = profileNicknameInput.value.trim() || name.split(' ')[0];
  const usernameKey = normalizeUsername(name);
  if (!usernameKey || usernameKey.length < 3) {
    authStatus.textContent = 'Pick a name with at least 3 letters or numbers.';
    return;
  }
  try {
    saveProfileButton.disabled = true;
    state.profile = { name, usernameKey, nickname };
    state.phoneSkipped = true;
    await updateProfile(currentUser, { displayName: name });
    persistState();
    // Save to Firestore if available (non-blocking — don't block login on failure)
    if (db) {
      try {
        const usernameRef = doc(db, 'usernames', usernameKey);
        const usernameSnap = await getDoc(usernameRef);
        if (usernameSnap.exists() && usernameSnap.data()?.uid !== currentUser.uid) {
          authStatus.textContent = 'That name is taken. Pick another.';
          saveProfileButton.disabled = false;
          return;
        }
        await setDoc(usernameRef, { uid: currentUser.uid, name, nickname, updatedAt: serverTimestamp() });
      } catch (firestoreError) {
        console.warn('Firestore save failed (continuing anyway):', firestoreError.message);
      }
    }
    authStatus.textContent = 'Account ready.';
    if (authReason === 'upgrade') {
      closeAuthPage();
      await startUpgrade();
    } else {
      closeAuthPage();
      render();
    }
  } catch (error) {
    authStatus.textContent = firebaseAuthMessage(error, 'Could not save that profile.');
  } finally {
    saveProfileButton.disabled = false;
  }
}

function normalizeUsername(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32);
}

function shouldAskPhone() {
  return false;
}

function openPhoneDialog() {
  if (!currentUser) {
    openAuthPage('account');
    return;
  }
  openAuthPage(authReason, true);
  phoneStatus.textContent = 'Add a phone number to keep normal free credits, or skip for lower free credits.';
  phoneCodeWrap.hidden = true;
  confirmPhoneCodeButton.hidden = true;
  sendPhoneCodeButton.hidden = false;
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
  } catch (error) {
    if (error?.code === 'auth/provider-already-linked' || error?.code === 'auth/credential-already-in-use') {
      state.phoneVerified = true;
      state.phoneSkipped = false;
      persistState();
      render();
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
  phoneStatus.textContent = 'Phone skipped. Lower free credits are active.';
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
  if (code === 'auth/email-already-in-use') {
    return 'That email already has a ROTEX account. Use the original email code to log in.';
  }
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password') {
    return 'That email code is not right for this account.';
  }
  if (code === 'auth/weak-password') {
    return 'Use an email code with at least 6 characters.';
  }
  if (code === 'auth/invalid-action-code') {
    return 'Firebase said the requested action is invalid. Refresh, use the live domain, and check authorized domains.';
  }
  return error?.message || fallback;
}

function activeChat() {
  const visibleChats = hasProAccess() ? state.chats : state.chats.filter((chat) => !chat.teamup);
  return visibleChats.find((chat) => chat.id === state.activeChatId) || visibleChats[0] || state.chats[0];
}

function activeModel() {
  return models.find((model) => model.id === state.activeModel) || models[0];
}

function hasProAccess() {
  return Boolean(currentUser && state.pro);
}

function isModelLocked(model) {
  return Boolean(model?.proOnly && !hasProAccess());
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
  const model = activeModel();
  if (isModelLocked(model)) {
    state.activeModel = 'gbt';
    return;
  }
  if (!state.computerMode || model.computerCost !== null) return;
  state.activeModel = 'deepseek';
}

function setCloudStatus(text) {
  syncStatus.textContent = text;
}

function renderModelMenu() {
  ensureComputerModel();
  const chat = activeChat();
  if (chat?.teamup) {
    const botA = models.find((item) => item.id === chat.teamup.botA) || models[1];
    const botB = models.find((item) => item.id === chat.teamup.botB) || models[2];
    selectedModelName.textContent = 'Teamup';
    selectedModelShort.textContent = `${botA.name} + ${botB.name}`;
    modelButton.classList.add('teamup-locked');
    modelButton.setAttribute('aria-disabled', 'true');
    modelMenu.innerHTML = '';
    closeModelMenu();
    return;
  }
  modelButton.classList.remove('teamup-locked');
  modelButton.removeAttribute('aria-disabled');
  const model = activeModel();
  selectedModelName.textContent = model.name;
  selectedModelShort.textContent = state.computerMode ? 'Computer mode' : model.short;
  modelMenu.innerHTML = '';

  const basicModels = models.filter((item) => !item.proOnly);
  const ProModels = models.filter((item) => item.proOnly);

  renderModelGroup('Basic', basicModels);
  renderModelGroup('Pro', ProModels);
}

function renderModelGroup(label, groupModels) {
  if (!groupModels.length) return;
  const group = document.createElement('div');
  group.className = 'model-group';
  group.innerHTML = `<div class="model-group-label">${label}</div>`;

  groupModels.forEach((item) => {
    const proLocked = isModelLocked(item);
    const disabled = proLocked || (state.computerMode && item.computerCost === null);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `model-option${item.id === state.activeModel ? ' active' : ''}${disabled ? ' disabled' : ''}`;
    const status = proLocked ? 'Pro only' : disabled ? 'Not in computer mode' : `Best for: ${item.short.toLowerCase()}`;
    button.innerHTML = `
      <span class="model-logo model-logo-${item.maker || item.id}" aria-hidden="true">${item.logo || item.name[0]}</span>
      <span class="model-option-copy">
        <strong>${item.name}${item.proOnly ? '<em>Pro only</em>' : ''}</strong>
        <span>${item.description}</span>
        <span>${status}</span>
      </span>`;
    button.addEventListener('click', () => {
      if (proLocked) {
        closeModelMenu();
        startUpgrade();
        return;
      }
      if (disabled) return;
      state.activeModel = item.id;
      closeModelMenu();
      persistState();
      render();
    });
    group.appendChild(button);
  });

  modelMenu.appendChild(group);
}

function renderChats() {
  chatList.innerHTML = '';
  const visibleChats = hasProAccess() ? state.chats : state.chats.filter((chat) => !chat.teamup);
  if (!hasProAccess() && activeChat()?.teamup && visibleChats[0]) {
    state.activeChatId = visibleChats[0].id;
  }
  visibleChats.forEach((chat) => {
    const row = document.createElement('div');
    row.className = `chat-row${chat.id === state.activeChatId ? ' active' : ''}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chat-item';
    button.innerHTML = `<span>${escapeHtml(chat.title)}</span><small>${chat.teamup ? 'teamup' : chat.personality || chat.messages.length}</small>`;
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
  const model = chat?.teamup ? teamupDisplayModel(chat) : activeModel();
  messagesEl.innerHTML = '';

  if (!chat || chat.messages.length === 0) {
    messagesEl.innerHTML = chat?.teamup
      ? `
        <div class="empty-state teamup-empty-state">
          <p class="eyebrow">Private Teamup room</p>
          <h2>Two models. One stronger answer.</h2>
          <p class="empty-lead">${model.name} will work together and return one useful response.</p>
        </div>
      `
      : `
        <div class="empty-state">
          <p class="eyebrow">${state.computerMode ? 'ROTEX computer mode' : 'ROTEX AI workspace'}</p>
          <h2>${state.computerMode ? 'Bring ROTEX into your work.' : 'Chat, build, and research in one place.'}</h2>
          <p class="empty-lead">${state.computerMode
            ? 'Connect Google Drive or GitHub, then ask ROTEX to help with your project.'
            : 'Choose a ROTEX model, attach your work, and turn ideas into useful answers or downloadable files.'}</p>
          <div class="empty-proof" aria-label="ROTEX features">
            <span>${models.length} real models</span>
            <span>Files, folders, and images</span>
            <span>Saved chats</span>
          </div>
          <div class="starter-grid" aria-label="Try ROTEX">
            <button class="starter-prompt" type="button" data-starter-prompt="Help me turn an idea into a clear plan.">
              <strong>Plan an idea</strong>
              <span>Get a useful next-step plan</span>
            </button>
            <button class="starter-prompt" type="button" data-starter-prompt="Help me build a clean website for my idea.">
              <strong>Build something</strong>
              <span>Start a project or debug code</span>
            </button>
            <button class="starter-prompt" type="button" data-starter-prompt="Compare my options and recommend the best one in a table.">
              <strong>Research options</strong>
              <span>Compare choices clearly</span>
            </button>
          </div>
          <div class="empty-footer">
            <span><strong>${model.name}</strong> is selected for ${model.short.toLowerCase()}.</span>
            <button type="button" data-open-Pro>Explore Pro</button>
          </div>
        </div>
      `;
    return;
  }

  chat.messages.forEach((message) => {
    const item = document.createElement('div');
    item.className = `message ${message.role}`;
    const downloads = message.role === 'assistant' ? extractDownloadFiles(message.text) : [];
    const bundledDownloads = downloads.length ? mergeRecentUploadedAssets(chat, message, downloads) : downloads;
    const safeText = normalizeAssistantText(message.text, message.model);
    const visibleText = bundledDownloads.length ? stripDownloadBlocks(safeText) : safeText;
    const meta = document.createElement('span');
    meta.className = 'message-meta';
    meta.textContent = message.role === 'user' ? 'You' : message.model;
    item.appendChild(meta);
    item.appendChild(message.role === 'assistant' ? renderRichMessage(visibleText) : renderPlainMessage(visibleText));
    if (Array.isArray(message.attachments) && message.attachments.length) {
      item.appendChild(renderAttachmentList(message.attachments));
    }
    if (message.action === 'upgrade') {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'message-action';
      button.textContent = 'Upgrade';
      button.addEventListener('click', startUpgrade);
      item.appendChild(button);
    }
    if (bundledDownloads.length) {
      item.appendChild(renderDownloadList(bundledDownloads));
    }
    messagesEl.appendChild(item);
  });
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function teamupDisplayModel(chat) {
  const botA = models.find((item) => item.id === chat?.teamup?.botA) || models[1];
  const botB = models.find((item) => item.id === chat?.teamup?.botB) || models[2];
  return {
    name: `${botA.name} + ${botB.name}`,
    description: 'Your two selected ROTEX models work together and return one final answer.',
    short: 'Teamup',
  };
}

function renderAccount() {
  applyCreditRefill();
  applyComputerUsageReset();
  creditStatus.textContent = `${remainingCreditPercent()}% credits`;
  renderConnectOptions();
  renderModeShell();
  if (currentUser) {
    googleButtonText.textContent = state.profile?.nickname || state.profile?.name || currentUser.displayName || currentUser.email || 'Google account';
    planStatus.textContent = state.pro ? 'Pro' : 'Normal';
    planStatus.hidden = false;
    if (state.pro) {
      saveStatus.textContent = `Pro active. Chats sync with Firebase for ${currentUser.email || 'this account'}.`;
    } else {
      saveStatus.textContent = state.phoneVerified
        ? `Phone verified. Chats sync with Firebase for ${currentUser.email || 'this account'}.`
        : 'Phone not verified. Verify your phone to restore the normal free limit.';
    }
  } else if (cloudReady) {
    googleButtonText.textContent = 'Log in or sign up';
    planStatus.textContent = 'Normal';
    planStatus.hidden = true;
    closeAccountMenu();
    saveStatus.textContent = 'Sign in with Google to save chats with Firebase.';
  } else {
    googleButtonText.textContent = 'Firebase not configured';
    planStatus.textContent = 'Normal';
    planStatus.hidden = true;
    closeAccountMenu();
    saveStatus.textContent = 'Add Firebase env vars in Vercel to enable Google login.';
  }

  if (!accountPage) return;
  if (teamupEntry) teamupEntry.hidden = !hasProAccess();
  teamupCreditStatus.textContent = `${remainingTeamupTokens().toLocaleString()} weekly tokens`;
  const displayName = state.profile?.name || currentUser?.displayName || currentUser?.email || 'Not signed in';
  const nickname = state.profile?.nickname || displayName;
  acctAvatar.textContent = currentUser ? nickname.trim().charAt(0).toUpperCase() || 'R' : '?';
  acctName.textContent = currentUser ? displayName : 'Not signed in';
  acctEmail.textContent = currentUser?.email || 'Log in to save chats and Pro.';
  acctPlanBadge.textContent = state.pro ? 'Pro' : 'Normal';
  acctPlanBadge.classList.toggle('pro', state.pro);
  acctAccountBlock.hidden = accountView !== 'account';
  acctUpgradeBlock.hidden = accountView !== 'upgrade';
  checkoutButton.disabled = Boolean(state.pro);
  checkoutButton.textContent = state.pro ? 'Already have Pro' : 'Go Pro - $20 / month';
  accountSignOutBtn.hidden = !currentUser;
  if (phoneVerifyBadge) {
    phoneVerifyBadge.textContent = state.phoneVerified ? 'Verified' : 'Not verified';
    phoneVerifyBadge.classList.toggle('pro', state.phoneVerified);
  }
}

function renderComputerChats() {
  if (!computerChatList) return;
  const computerChats = state.chats.filter((c) => c.computer);
  computerChatList.innerHTML = '';
  if (computerChats.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'cw-empty';
    empty.textContent = 'No computer chats yet. Press + New to start one.';
    computerChatList.appendChild(empty);
    return;
  }
  computerChats.forEach((chat) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `cw-item${chat.id === state.activeChatId ? ' active' : ''}`;
    btn.textContent = chat.title;
    btn.title = chat.title;
    btn.addEventListener('click', () => {
      state.activeChatId = chat.id;
      persistState();
      render();
    });
    computerChatList.appendChild(btn);
  });
}

function render() {
  applyCreditRefill();
  applyComputerUsageReset();
  populateTeamupSelectors();
  renderModelMenu();
  renderChats();
  renderMessages();
  renderAccount();
  renderComputerChats();
}

function populateTeamupSelectors() {
  if (!teamupBotA || !teamupBotB) return;
  if (!teamupBotA.options.length) {
    models.filter((model) => !model.localOnly).forEach((model) => {
      const optionA = new Option(model.name, model.id);
      const optionB = new Option(model.name, model.id);
      teamupBotA.add(optionA);
      teamupBotB.add(optionB);
    });
    teamupBotA.value = 'deepseek';
    teamupBotB.value = 'gbt';
  }
  updateTeamupSelectors();
}

function updateTeamupSelectors(changed = '') {
  if (!teamupBotA || !teamupBotB) return;
  const fallback = models.find((model) => model.id !== teamupBotA.value)?.id || models[0]?.id;
  if (teamupBotA.value === teamupBotB.value) {
    if (changed === 'bot-b') {
      teamupBotA.value = models.find((model) => model.id !== teamupBotB.value)?.id || models[0]?.id;
    } else if (fallback) {
      teamupBotB.value = fallback;
    }
  }
  [...teamupBotA.options].forEach((option) => {
    option.disabled = option.value === teamupBotB.value;
  });
  [...teamupBotB.options].forEach((option) => {
    option.disabled = option.value === teamupBotA.value;
  });
}

function renderModeShell() {
  chatPanel.classList.toggle('computer-panel', state.computerMode);
  computerWorkspace.classList.toggle('active', state.computerMode);
  computerEntry.classList.toggle('active', state.computerMode);
  computerEntry.setAttribute('aria-pressed', String(state.computerMode));
  modeEyebrow.textContent = state.computerMode ? 'ROTEX computer' : 'ROTEX web';
  modeTitle.textContent = state.computerMode ? 'Computer mode' : 'Chat with ROTEX';
  modeSubtitle.textContent = state.computerMode
    ? 'Connect Google Drive or GitHub, then bring ROTEX into your work.'
    : 'Ask questions, attach your work, and build with a focused ROTEX model.';
  computerEntrySub.textContent = state.computerMode ? 'Open workspace' : 'Connect apps';
  connectorCards.forEach((card) => {
    const value = card.dataset.connect;
    const active = state.computerConnections.includes(value);
    card.classList.toggle('active', active);
  });
}

function createChat(personality = 'normal') {
  const id = crypto.randomUUID();
  state.chats.unshift({
    id,
    title: `${personality[0].toUpperCase()}${personality.slice(1)} chat`,
    createdAt: Date.now(),
    personality,
    messages: [],
  });
  state.activeChatId = id;
  persistState();
  render();
  messageInput.focus();
}

function createTeamupRoom() {
  if (!hasProAccess()) {
    startUpgrade();
    return;
  }
  if (state.teamupRooms.length >= 1) {
    teamupStatus.textContent = 'Pro includes 1 mini private teamup room. Opening your room.';
    const room = state.teamupRooms[0];
    const existing = state.chats.find((chat) => chat.teamup?.id === room.id);
    if (existing) {
      state.activeChatId = existing.id;
    } else {
      const chat = { id: crypto.randomUUID(), title: 'Teamup room', createdAt: Date.now(), teamup: room, messages: [] };
      state.chats.unshift(chat);
      state.activeChatId = chat.id;
    }
    teamupDialog.close();
    persistState();
    render();
    return;
  }
  const botA = teamupBotA.value;
  const botB = teamupBotB.value;
  if (botA === botB) {
    teamupStatus.textContent = 'Pick two different models for a teamup room.';
    updateTeamupSelectors();
    return;
  }
  const room = { id: crypto.randomUUID(), botA, botB };
  const chat = {
    id: crypto.randomUUID(),
    title: 'Teamup room',
    createdAt: Date.now(),
    teamup: room,
    messages: [],
  };
  state.teamupRooms = [room];
  state.chats.unshift(chat);
  state.activeChatId = chat.id;
  teamupDialog.close();
  persistState();
  render();
}

async function sendMessage(text) {
  const chat = activeChat();
  const clean = text.trim();
  const attachments = pendingAttachments.slice();
  if ((!clean && !attachments.length) || !chat) return;
  if (chat.teamup) {
    await sendTeamupMessage(chat, clean);
    return;
  }

  applyCreditRefill();
  applyComputerUsageReset();
  ensureComputerModel();
  const model = activeModel();
  const cost = activeCost();
  if (!model.localOnly && shouldAskPhone()) {
    openPhoneDialog();
    return;
  }
  if (isModelLocked(model)) {
    chat.messages.push({
      role: 'assistant',
      model: 'ROTEX Pro',
      text: `${model.name} is Pro only. Upgrade?`,
      action: 'upgrade',
    });
    persistState();
    render();
    return;
  }
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
      text: "You're out of credits. Upgrade?",
      action: 'upgrade',
    });
    persistState();
    render();
    return;
  }

  spendCredits(cost);
  if (state.computerMode && !state.pro && !model.localOnly) {
    state.computerUsage.count += 1;
  }
  const userText = clean || `Attached ${attachments.length} file${attachments.length === 1 ? '' : 's'}.`;
  chat.messages.push({ role: 'user', text: userText, model: 'You', attachments: attachments.map(publicAttachment), assetAttachments: attachments.map(bundleAttachment).filter(Boolean) });
  pendingAttachments = [];
  renderAttachments();
  if (chat.title === 'New ROTEX chat') {
    chat.title = userText.length > 32 ? `${userText.slice(0, 32)}...` : userText;
  }

  const localStatus = localConnectionAnswer(userText);
  if (localStatus) {
    chat.messages.push({ role: 'assistant', model: model.name, text: localStatus });
    persistState();
    render();
    return;
  }

  persistState();
  render();

  const pending = { role: 'assistant', model: model.name, text: 'Thinking...' };
  chat.messages.push(pending);
  render();

  try {
    if (model.localOnly) {
      pending.text = await callLocalOllama(buildApiMessages(chat));
      persistState();
      render();
      return;
    }

    const authToken = currentUser ? await currentUser.getIdToken() : '';
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authToken,
        proPass: getProPass(),
        model: model.id,
        computerMode: state.computerMode,
        computerConnections: state.computerConnections,
        pcBridge: state.pcBridge,
        personality: personalities[chat.personality || 'normal'],
        attachments,
        messages: buildApiMessages(chat),
        stream: true,
      }),
    });

    const contentType = response.headers.get('content-type') || '';
    if (response.ok && response.body && contentType.includes('text/event-stream')) {
      // Stream SSE chunks into the pending assistant message as they arrive.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let streamed = '';
      let streamError = '';
      let scheduled = false;
      const flushRender = () => {
        scheduled = false;
        pending.text = streamed || 'Thinking...';
        renderMessages();
      };
      const scheduleRender = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(flushRender);
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split('\n\n');
        buf = events.pop() || '';
        for (const event of events) {
          const dataLine = event.split('\n').find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          let payload;
          try { payload = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
          if (payload.d) { streamed += payload.d; scheduleRender(); }
          if (payload.error) streamError = payload.text || 'The model had trouble answering.';
        }
      }
      pending.text = streamed || streamError || 'ROTEX backend is online, but no response came back.';
    } else {
      const data = await response.json();
      pending.text = data.text || 'ROTEX backend is online, but no response came back.';
    }
  } catch (error) {
    pending.text = 'servers are down';
  }

  persistState();
  render();
}

function localConnectionAnswer(text) {
  const lower = text.toLowerCase();
  const asksStatus = /\b(check|connected|connect|success|worked|status|did)\b/.test(lower);
  if (!asksStatus) return '';

  const targets = [
    ['github', 'GitHub'],
    ['google drive', 'Google Drive'],
    ['drive', 'Google Drive'],
  ];
  const found = targets.find(([needle]) => lower.includes(needle));
  if (!found) return '';

  const service = found[1];
  const connected = state.computerConnections.includes(service);
  return connected
    ? `${service} is connected successfully.`
    : `${service} is not connected yet.`;
}

async function callLocalOllama(messages) {
  const model = localStorage.getItem('rotex_ollama_model') || 'llama3.1';
  try {
    const response = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: messages
          .filter((message) => ['user', 'assistant', 'system'].includes(message.role))
          .slice(-18)
          .map((message) => ({
            role: message.role,
            content: String(message.text || '').slice(0, 8000),
          })),
        stream: false,
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    return data.message?.content?.trim() || 'Ollama responded with no text.';
  } catch {
    return [
      'Ollama is local, so ROTEX needs permission to reach it on your PC.',
      '',
      'Install Ollama, run `ollama pull llama3.1`, then allow browser access:',
      '`setx OLLAMA_ORIGINS "*"`',
      '',
      'Restart Ollama after that, then try the Ollama model again.',
    ].join('\n');
  }
}

function buildApiMessages(chat) {
  const cleanMessages = (chat?.messages || [])
    .filter((message) => message.text !== 'Thinking...' && !/^Teamup is thinking|is combining the teamup answer/.test(message.text))
    .map((message) => ({
      role: message.role,
      text: message.text,
      model: message.model,
    }));
  if (cleanMessages.length <= 18) return cleanMessages;
  const older = cleanMessages.slice(0, -14);
  const recent = cleanMessages.slice(-14);
  return [
    {
      role: 'system',
      text: `Compact conversation summary: ${compactConversation(older)}`,
      model: 'ROTEX memory',
    },
    ...recent,
  ];
}

function compactConversation(messages) {
  return messages
    .slice(-24)
    .map((message) => `${message.role === 'user' ? 'User' : message.model || 'ROTEX'}: ${String(message.text || '').replace(/\s+/g, ' ').slice(0, 240)}`)
    .join(' | ')
    .slice(0, 4000);
}

async function sendTeamupMessage(chat, clean) {
  if (!hasProAccess()) {
    chat.messages.push({ role: 'assistant', model: 'ROTEX Pro', text: 'Teamup rooms are Pro only. Upgrade?', action: 'upgrade' });
    persistState();
    render();
    return;
  }
  applyComputerUsageReset();
  const tokenCost = estimateTeamupTokens(clean);
  if (remainingTeamupTokens() < tokenCost) {
    chat.messages.push({ role: 'assistant', model: 'Teamup credits', text: 'Teamup tokens are out for this week. They refill to 10,000 next week.' });
    persistState();
    render();
    return;
  }
  state.teamupUsage.spent += tokenCost;
  chat.messages.push({ role: 'user', text: clean, model: 'You' });
  if (chat.title === 'Teamup room') {
    chat.title = clean.length > 30 ? `${clean.slice(0, 30)}...` : clean;
  }
  const botA = models.find((model) => model.id === chat.teamup.botA) || models[1];
  const botB = models.find((model) => model.id === chat.teamup.botB) || models[2];
  const pending = { role: 'assistant', model: `${botA.name} + ${botB.name}`, text: 'Teamup is thinking together...' };
  chat.messages.push(pending);
  persistState();
  render();

  await sleep(900);
  const draft = await getTeamupReply(chat, botA, botB, clean, 'Make a short private draft for your partner. Do not create downloadable files yet.');
  pending.text = `${botB.name} is combining the teamup answer...`;
  render();
  await sleep(700);
  const final = await getTeamupReply(
    chat,
    botB,
    botA,
    clean,
    `Your partner ${botA.name} drafted this:\n${draft}\n\nMake ONE final answer for the user. The bots should feel like they worked together, but only output one response. If the user asked for a downloadable file, create exactly one file block.`
  );
  pending.model = 'Teamup';
  pending.text = enforceRepeatedFileRequest(final, clean);
  persistState();
  render();
}

function enforceRepeatedFileRequest(answer, requestText) {
  const match = String(requestText || '').match(/\b(?:says?|write|repeat|contains?)\s+["']?([^"',.?!\n]+?)["']?\s+(?:in\s+it\s+)?(?:x\s*)?(\d{1,4})\s+times?\b/i)
    || String(requestText || '').match(/\b["']?([^"',.?!\n]+?)["']?\s+(?:x\s*)?(\d{1,4})\s+times?\b/i);
  if (!match) return answer;
  const phrase = match[1].trim();
  const count = Math.min(1000, Math.max(1, Number(match[2]) || 0));
  if (!phrase || !count) return answer;
  return String(answer || '').replace(/```file:([^\n\r]+)\r?\n[\s\S]*?```/, (_block, rawName) => {
    const name = safeFileName(rawName) || 'output.txt';
    return `\`\`\`file:${name}\n${Array.from({ length: count }, () => phrase).join('\n')}\n\`\`\``;
  });
}

async function getTeamupReply(chat, selfModel, partnerModel, clean, instruction) {
  try {
    const authToken = currentUser ? await currentUser.getIdToken() : '';
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authToken,
        proPass: getProPass(),
        model: selfModel.id,
        personality: `Teamup mini room. You are ${selfModel.name}. Work with ${partnerModel.name}. ${instruction} Be useful, concise, and do not introduce yourself unless asked. User request: ${clean}`,
        messages: buildApiMessages(chat).slice(-12),
      }),
    });
    const data = await response.json();
    return data.text || `${selfModel.name} had no response.`;
  } catch {
    return `${selfModel.name} could not respond yet.`;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startUpgrade() {
  openAccountPage(true);
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
  if (state.pro) return;
  if (!currentUser) {
    openAuthPage('upgrade');
    return;
  }
  if (needsProfile()) {
    openAuthPage('upgrade', true);
    return;
  }
  const originalText = checkoutButton.textContent;
  try {
    checkoutButton.disabled = true;
    checkoutButton.textContent = 'Opening Stripe...';
    const response = await fetch('/api/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uid: currentUser.uid,
        email: currentUser.email || '',
      }),
    });
    const data = await response.json();
    if (data.url) {
      window.location.href = data.url;
      return;
    }
    if (data.configured === false) {
      alert(data.message || 'Stripe is not configured yet. Add the Stripe env vars in Vercel.');
      return;
    }
    alert(data.message || 'Stripe checkout could not start.');
  } catch {
    alert('Could not reach the checkout server. Check your connection and try again.');
  } finally {
    checkoutButton.disabled = false;
    checkoutButton.textContent = originalText;
  }
}

// ─── Pro pass (shared with the editor via localStorage) ───────────────
const PRO_PASS_KEY = 'rotex_pro_pass';

function getProPass() {
  try { return localStorage.getItem(PRO_PASS_KEY) || ''; } catch { return ''; }
}

function setProPass(pass) {
  try { if (pass) localStorage.setItem(PRO_PASS_KEY, pass); } catch {}
}

function clearProPass() {
  try { localStorage.removeItem(PRO_PASS_KEY); } catch {}
}

function proPassExpiry(pass) {
  try {
    const body = pass.split('.', 2)[0];
    const payload = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
    return Number(payload.exp) || 0;
  } catch { return 0; }
}

async function ensureFreshProPass() {
  const pass = getProPass();
  if (!pass) return;
  const exp = proPassExpiry(pass);
  if (exp - Date.now() > 7 * 24 * 60 * 60 * 1000) return;
  try {
    const response = await fetch('/api/refresh-pro', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proPass: pass }),
    });
    const data = await response.json();
    if (data.refreshed && data.proPass) {
      setProPass(data.proPass);
    } else if (data.cancelled || exp < Date.now()) {
      clearProPass();
      if (state.pro) {
        state.pro = false;
        persistState();
        render();
      }
    }
  } catch { /* network issue — retry on next page load */ }
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
    if (data.proPass) setProPass(data.proPass);
    state.stripeSubscriptionId = data.subscriptionId || state.stripeSubscriptionId || '';
    state.creditUsage = normalizeCreditUsage({}, true, creditPlans.pro.monthly);
    state.credits = remainingMonthlyCredits(true, state.creditUsage);
    persistState();
    setCloudStatus('Pro active');
    history.replaceState('', document.title, window.location.pathname);
    closeAccountPage();
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

function remainingCreditPercent() {
  const monthly = activeCreditPlan().monthly;
  if (!monthly) return 0;
  return Math.max(0, Math.min(100, Math.round((remainingMonthlyCredits() / monthly) * 100)));
}

function remainingTeamupTokens() {
  state.teamupUsage = normalizeTeamupUsage(state.teamupUsage);
  return Math.max(0, weeklyTeamupTokens - (Number(state.teamupUsage.spent) || 0));
}

function estimateTeamupTokens(text) {
  const lower = text.toLowerCase();
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (/\b(architecture|complex|hard|full|entire|system|deploy)\b/.test(lower)) {
    return Math.min(4000, Math.max(800, words * 24));
  }
  if (/\b(repo|github|file|app|code|debug|build|fix|edit|implement)\b/.test(lower)) {
    return Math.min(700, Math.max(100, words * 10));
  }
  return Math.min(50, Math.max(1, Math.ceil(words * 2)));
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
    const active = state.computerConnections.includes(value);
    button.classList.toggle('active', active);
  });
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
  const pattern = /```(?:file|folder):([^\n\r]+)\r?\n([\s\S]*?)```/g;
  let match = pattern.exec(text);
  while (match) {
    const parsed = parseDownloadHeader(match[1]);
    const name = safeDownloadPath(parsed.name);
    if (name) {
      files.push({ name, content: match[2].replace(/\s+$/, ''), base64: parsed.base64 });
    }
    match = pattern.exec(text);
  }
  return files;
}

function stripDownloadBlocks(text) {
  return text.replace(/```(?:file|folder):([^\n\r]+)\r?\n([\s\S]*?)```/g, '').trim();
}

function safeFileName(value) {
  return String(value).trim().replace(/[<>:"/\\|?*]/g, '-').slice(0, 80);
}

function safeDownloadPath(value) {
  return String(value)
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => safeFileName(part))
    .filter(Boolean)
    .join('/')
    .slice(0, 180);
}

function parseDownloadHeader(value) {
  const parts = String(value || '').split(';').map((part) => part.trim()).filter(Boolean);
  return { name: parts[0] || 'download.txt', base64: parts.includes('base64') };
}

function renderDownloadList(files) {
  const list = document.createElement('div');
  list.className = 'download-list';
  files.forEach((file) => {
    const link = document.createElement('a');
    link.className = 'download-file';
    link.download = file.name.split('/').pop() || file.name;
    link.href = URL.createObjectURL(downloadBlob(file));
    link.textContent = `Download ${file.name}`;
    list.appendChild(link);
  });
  if (files.length > 1 || files.some((file) => file.name.includes('/'))) {
    const zipButton = document.createElement('button');
    zipButton.type = 'button';
    zipButton.className = 'download-file';
    zipButton.textContent = 'Download all as zip';
    zipButton.addEventListener('click', () => downloadFilesAsZip(files));
    list.appendChild(zipButton);
  }
  return list;
}

function downloadBlob(file) {
  if (file.base64) {
    return new Blob([base64ToBytes(file.content.replace(/\s+/g, ''))], { type: inferMime(file.name) });
  }
  return new Blob([file.content], { type: inferMime(file.name) });
}

async function downloadFilesAsZip(files) {
  if (!window.JSZip) return;
  const zip = new window.JSZip();
  files.forEach((file) => {
    zip.file(file.name, file.base64 ? base64ToBytes(file.content.replace(/\s+/g, '')) : file.content, { binary: file.base64 });
  });
  const blob = await zip.generateAsync({ type: 'blob' });
  const link = document.createElement('a');
  link.download = 'rotex-files.zip';
  link.href = URL.createObjectURL(blob);
  link.click();
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function inferMime(name) {
  if (/\.(png)$/i.test(name)) return 'image/png';
  if (/\.(jpe?g)$/i.test(name)) return 'image/jpeg';
  if (/\.(gif)$/i.test(name)) return 'image/gif';
  if (/\.(svg)$/i.test(name)) return 'image/svg+xml';
  if (/\.(zip)$/i.test(name)) return 'application/zip';
  return 'text/plain';
}

function renderAttachmentList(files) {
  const list = document.createElement('div');
  list.className = 'attachment-list';
  files.forEach((file) => {
    const chip = document.createElement('span');
    chip.className = 'attachment-chip';
    chip.textContent = `${file.kind === 'image' ? 'Image' : 'File'}: ${file.name}`;
    list.appendChild(chip);
  });
  return list;
}

function mergeRecentUploadedAssets(chat, assistantMessage, downloads) {
  const index = chat.messages.indexOf(assistantMessage);
  const priorMessages = index >= 0 ? chat.messages.slice(Math.max(0, index - 4), index).reverse() : [];
  const userWithAssets = priorMessages.find((message) => message.role === 'user' && Array.isArray(message.assetAttachments) && message.assetAttachments.length);
  if (!userWithAssets) return downloads;
  const assetFiles = userWithAssets.assetAttachments
    .map((file) => ({ ...file, name: assetBundlePath(file) }))
    .filter((file) => file.name && !downloads.some((download) => download.name === file.name));
  return assetFiles.length ? [...downloads, ...assetFiles] : downloads;
}

function assetBundlePath(file) {
  const original = safeDownloadPath(file.path || file.name);
  if (!original) return '';
  if (original.includes('/')) return original;
  if (file.kind === 'image' || /\.(png|jpe?g|gif|webp|svg)$/i.test(original)) return `images/${original}`;
  if (file.kind === 'zip') return `assets/${original}`;
  return `assets/${original}`;
}

function publicAttachment(file) {
  return {
    name: file.name,
    path: file.path,
    type: file.type,
    size: file.size,
    kind: file.kind,
  };
}

function bundleAttachment(file) {
  if (!file?.content) return null;
  const base64 = file.kind === 'image' || file.kind === 'zip' || String(file.content).startsWith('data:');
  return {
    name: file.name,
    path: file.path,
    type: file.type,
    size: file.size,
    kind: file.kind,
    base64,
    content: base64 ? dataUrlPayload(file.content) : file.content,
  };
}

function dataUrlPayload(value) {
  const text = String(value || '');
  return text.includes(',') ? text.split(',', 2)[1] : text;
}

async function handleAttachmentSelection(files) {
  const selected = Array.from(files || []).slice(0, maxAttachments - pendingAttachments.length);
  if (!selected.length) return;
  const loaded = await Promise.all(selected.map(readAttachment));
  pendingAttachments = [...pendingAttachments, ...loaded.filter(Boolean)].slice(0, maxAttachments);
  renderAttachments();
}

function renderAttachments() {
  if (!attachmentTray) return;
  attachmentTray.innerHTML = '';
  attachmentTray.hidden = pendingAttachments.length === 0;
  pendingAttachments.forEach((file, index) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'attachment-pill';
    chip.textContent = `${attachmentLabel(file)} ${file.path || file.name} x`;
    chip.addEventListener('click', () => {
      pendingAttachments.splice(index, 1);
      renderAttachments();
    });
    attachmentTray.appendChild(chip);
  });
}

function readAttachment(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    const path = safeDownloadPath(file.webkitRelativePath || file.name) || safeFileName(file.name) || 'attachment';
    const ext = path.split('.').pop()?.toLowerCase() || '';
    const kind = file.type.startsWith('image/') ? 'image' : ext === 'zip' || file.type === 'application/zip' ? 'zip' : 'file';
    const readable = kind === 'file' && (file.type.startsWith('text/') || readableExtensions.has(ext));
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const raw = String(reader.result || '');
      resolve({
        name: safeFileName(file.name) || 'attachment',
        path,
        type: file.type || 'application/octet-stream',
        size: file.size,
        kind,
        content: kind === 'image' || kind === 'zip' || !readable ? raw : raw.slice(0, 12000),
      });
    };
    if (kind === 'image' || kind === 'zip' || !readable) {
      reader.readAsDataURL(file);
    } else {
      reader.readAsText(file);
    }
  });
}

function attachmentLabel(file) {
  if (file.kind === 'image') return 'Image';
  if (file.kind === 'zip') return 'Zip';
  if (file.path && file.path.includes('/')) return 'Folder file';
  return 'File';
}

function normalizeAssistantText(text, modelName = 'ROTEX') {
  const value = String(text || '');
  if (/servers are down/i.test(value)) {
    return 'servers are down';
  }
  if (/backend key is missing|server environment keys|Check Vercel env keys/i.test(value)) {
    return 'servers are down';
  }
  return value;
}

function renderPlainMessage(text) {
  const span = document.createElement('span');
  span.className = 'message-text';
  span.textContent = text;
  return span;
}

function renderRichMessage(text) {
  const container = document.createElement('span');
  container.className = 'message-text rich-message';
  const parts = String(text || '').split(/```([a-zA-Z0-9_-]*)?\r?\n([\s\S]*?)```/g);
  parts.forEach((part, index) => {
    if (index % 3 === 0) {
      appendMarkdownText(container, part);
      return;
    }
    if (index % 3 === 1) return;
    const language = parts[index - 1] || 'text';
    container.appendChild(renderCodeBlock(part.replace(/\s+$/, ''), language));
  });
  return container;
}

function appendMarkdownText(container, text) {
  const lines = String(text || '').split(/\r?\n/);
  let paragraph = [];
  let index = 0;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const p = document.createElement('p');
    p.textContent = paragraph.join(' ').trim();
    if (p.textContent) container.appendChild(p);
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index];
    if (isMarkdownTableStart(lines, index)) {
      flushParagraph();
      const tableLines = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
        tableLines.push(lines[index]);
        index += 1;
      }
      container.appendChild(renderMarkdownTable(tableLines));
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
    } else {
      paragraph.push(line);
    }
    index += 1;
  }
  flushParagraph();
}

function isMarkdownTableStart(lines, index) {
  return /^\s*\|.*\|\s*$/.test(lines[index] || '') && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1] || '');
}

function renderMarkdownTable(lines) {
  const table = document.createElement('table');
  table.className = 'message-table';
  const rows = lines
    .filter((line, index) => index !== 1)
    .map((line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()));
  rows.forEach((cells, index) => {
    const tr = document.createElement('tr');
    cells.forEach((cell) => {
      const node = document.createElement(index === 0 ? 'th' : 'td');
      node.textContent = cell;
      tr.appendChild(node);
    });
    table.appendChild(tr);
  });
  const wrap = document.createElement('div');
  wrap.className = 'message-table-wrap';
  wrap.appendChild(table);
  return wrap;
}

function renderCodeBlock(code, language) {
  const wrap = document.createElement('div');
  wrap.className = 'code-block';
  const bar = document.createElement('div');
  bar.className = 'code-bar';
  const label = document.createElement('span');
  label.textContent = language || 'code';
  const actions = document.createElement('span');
  actions.className = 'code-actions';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy';
  copy.addEventListener('click', async () => {
    await navigator.clipboard?.writeText(code);
    copy.textContent = 'Copied';
    setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
  });
  const download = document.createElement('a');
  const ext = codeExtension(language);
  download.download = `rotex-code.${ext}`;
  download.href = URL.createObjectURL(new Blob([code], { type: 'text/plain' }));
  download.textContent = 'Download';
  actions.append(copy, download);
  bar.append(label, actions);
  const pre = document.createElement('pre');
  const codeNode = document.createElement('code');
  codeNode.textContent = code;
  pre.appendChild(codeNode);
  wrap.append(bar, pre);
  return wrap;
}

function codeExtension(language) {
  const map = { javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', html: 'html', css: 'css', json: 'json', python: 'py', py: 'py', bash: 'sh', shell: 'sh', text: 'txt' };
  return map[String(language || '').toLowerCase()] || 'txt';
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
  if (activeChat()?.teamup) {
    closeModelMenu();
    return;
  }
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

function closeAttachMenu() {
  if (attachMenu) {
    attachMenu.hidden = true;
  }
}

function toggleAttachMenu() {
  if (attachMenu) {
    attachMenu.hidden = !attachMenu.hidden;
  }
}

function closeComputerMode() {
  state.computerMode = false;
  closeModelMenu();
  if (connectDialog.open) {
    connectDialog.close();
  }
}

newChatButton.addEventListener('click', () => {
  closeComputerMode();
  closeMobileSidebar();
  personalityDialog.showModal();
});

mobileNewChatButton?.addEventListener('click', () => {
  closeComputerMode();
  closeMobileSidebar();
  personalityDialog.showModal();
});

mobileMenuButton?.addEventListener('click', () => {
  if (document.body.classList.contains('mobile-sidebar-open')) {
    closeMobileSidebar();
  } else {
    openMobileSidebar();
  }
});

mobileSidebarBackdrop?.addEventListener('click', closeMobileSidebar);
sidebar?.addEventListener('click', (event) => {
  if (event.target.closest?.('.chat-item, .chat-row, .brand, .computer-entry, .teamup-entry')) {
    closeMobileSidebar();
  }
});

personalityOptions.forEach((button) => {
  button.addEventListener('click', () => {
    closeComputerMode();
    createChat(button.dataset.personality || 'normal');
    personalityDialog.close();
  });
});

teamupEntry.addEventListener('click', () => {
  if (!hasProAccess()) {
    startUpgrade();
    return;
  }
  closeComputerMode();
  populateTeamupSelectors();
  teamupStatus.textContent = `Pro teamup ready. ${remainingTeamupTokens().toLocaleString()} weekly tokens left.`;
  teamupDialog.showModal();
});

makeTeamupRoomButton.addEventListener('click', createTeamupRoom);
teamupBotA.addEventListener('change', () => updateTeamupSelectors('bot-a'));
teamupBotB.addEventListener('change', () => updateTeamupSelectors('bot-b'));

modelButton.addEventListener('click', toggleModelMenu);
computerEntry.addEventListener('click', () => {
  state.computerMode = !state.computerMode;
  ensureComputerModel();
  persistState();
  render();
});

connectOptions.forEach((button) => {
  button.addEventListener('click', async () => {
    const provider = button.dataset.provider;
    if (provider) {
      await startProviderConnect(provider);
    }
  });
});

connectorCards.forEach((button) => {
  button.addEventListener('click', async () => {
    const provider = button.dataset.provider;
    await startProviderConnect(provider);
  });
});

newComputerChatButton?.addEventListener('click', () => {
  const id = crypto.randomUUID();
  state.chats.unshift({ id, title: 'Computer chat', createdAt: Date.now(), messages: [], computer: true });
  state.activeChatId = id;
  persistState();
  render();
  messageInput?.focus();
});

async function startProviderConnect(provider) {
  try {
    if (!provider) {
      alert('That connection is not ready yet.');
      return;
    }
    const response = await fetch(`/api/connect/${provider}`, { cache: 'no-store' });
    if (!response.ok) {
      alert(`${provider} connect failed with status ${response.status}.`);
      return;
    }
    const data = await response.json();
    if (data.url) {
      window.location.assign(data.url);
      return;
    }
    const details = data.redirect_uri ? ` Redirect URI: ${data.redirect_uri}` : '';
    alert(`${data.message || `${provider} is not configured yet.`}${details}`);
  } catch (error) {
    alert(`${provider} connect is not ready yet. ${error?.message || ''}`.trim());
  }
}

document.addEventListener('click', (event) => {
  const starterPrompt = event.target.closest?.('.starter-prompt');
  if (starterPrompt) {
    messageInput.value = starterPrompt.dataset.starterPrompt || '';
    messageInput.focus();
    return;
  }
  if (event.target.closest?.('[data-open-Pro]')) {
    openAccountPage(true);
    return;
  }
  const accountMenuAction = event.target.closest?.('#accountMenuLogout, #accountMenuUpgrade');
  if (accountMenuAction) {
    if (accountMenuAction.id === 'accountMenuLogout') {
      logOutCurrentAccount(event);
    } else {
      handleAccountMenuAction(event, true);
    }
    return;
  }

  const profileLink = event.target.closest?.('#googleButton');
  if (profileLink) {
    handleProfileAction(event);
    return;
  }
  if (event.target.closest?.('#accountMenu')) {
    return;
  }
  const upgradeClick = event.target.closest?.('#upgradeButton, .message-action');
  if (upgradeClick) {
    event.preventDefault();
    openAccountPage(true);
    return;
  }
  closeAccountMenu();
  if (!event.target.closest?.('#attachMenu') && !event.target.closest?.('#attachButton')) {
    closeAttachMenu();
  }
  if (!modelMenu.contains(event.target) && !modelButton.contains(event.target)) {
    closeModelMenu();
  }
});

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage(messageInput.value);
  messageInput.value = '';
});

attachButton?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  toggleAttachMenu();
});
attachFilesButton?.addEventListener('click', (event) => {
  event.preventDefault();
  closeAttachMenu();
  attachmentInput?.click();
});
attachFolderButton?.addEventListener('click', (event) => {
  event.preventDefault();
  closeAttachMenu();
  folderInput?.click();
});
attachmentInput?.addEventListener('change', async () => {
  await handleAttachmentSelection(attachmentInput.files);
  attachmentInput.value = '';
});
folderInput?.addEventListener('change', async () => {
  await handleAttachmentSelection(folderInput.files);
  folderInput.value = '';
});

messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (event.shiftKey) {
      const start = messageInput.selectionStart;
      const end = messageInput.selectionEnd;
      messageInput.value = `${messageInput.value.slice(0, start)}\n${messageInput.value.slice(end)}`;
      messageInput.selectionStart = start + 1;
      messageInput.selectionEnd = start + 1;
      return;
    }
    sendMessage(messageInput.value);
    messageInput.value = '';
  }
});

googleButton.addEventListener('pointerdown', (event) => {
  suppressProfileClick = true;
  handleProfileAction(event);
});
googleButton.addEventListener('click', (event) => {
  if (suppressProfileClick) {
    suppressProfileClick = false;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  handleProfileAction(event);
});

accountMenuLogout?.addEventListener('pointerdown', (event) => {
  suppressAccountMenuClick = true;
  logOutCurrentAccount(event);
});
accountMenuUpgrade?.addEventListener('pointerdown', (event) => {
  suppressAccountMenuClick = true;
  handleAccountMenuAction(event, true);
});
accountMenuLogout?.addEventListener('click', (event) => {
  if (suppressAccountMenuClick) {
    suppressAccountMenuClick = false;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  logOutCurrentAccount(event);
});
accountMenuUpgrade?.addEventListener('click', (event) => {
  if (suppressAccountMenuClick) {
    suppressAccountMenuClick = false;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  handleAccountMenuAction(event, true);
});

accountSignOutBtn?.addEventListener('click', async () => {
  closeAccountPage();
  if (auth) await signOut(auth);
});

closeAccountBtn?.addEventListener('click', closeAccountPage);
accountBackBtn?.addEventListener('click', closeAccountPage);
authGoogleButton.addEventListener('click', signInWithGoogleFromAuth);
chooseEmailButton.addEventListener('click', () => showAuthStep('email'));
sendEmailCodeButton.addEventListener('click', sendEmailCodeNotice);
emailLoginButton.addEventListener('click', continueEmailLogin);
backToEmailButton.addEventListener('click', () => showAuthStep('email'));
saveProfileButton.addEventListener('click', saveProfile);
sendPhoneCodeButton?.addEventListener('click', sendPhoneCode);
confirmPhoneCodeButton?.addEventListener('click', confirmPhoneCode);
skipPhoneButton?.addEventListener('click', skipPhoneVerification);
upgradeButton.addEventListener('click', startUpgrade);
checkoutButton.addEventListener('click', continueCheckout);

if (window.location.hash === '#authPage' || window.location.hash === '#login') {
  openAuthPage('account');
}

if (window.location.hash === '#pro') {
  startUpgrade();
}

if (window.location.hash === '#account') {
  openAccountPage(false);
}

window.addEventListener('hashchange', () => {
  if (window.location.hash === '#account') {
    openAccountPage(false);
  }
  if (window.location.hash === '#pro') {
    startUpgrade();
  }
  if (window.location.hash === '#authPage' || window.location.hash === '#login') {
    openAuthPage('account');
  }
});

setMobileLayout();
window.addEventListener('resize', setMobileLayout);

document.addEventListener('contextmenu', (event) => event.preventDefault());
document.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if (key === 'f12' || (event.ctrlKey && event.shiftKey && ['i', 'j', 'c'].includes(key)) || (event.ctrlKey && key === 'u')) {
    event.preventDefault();
  }
});
