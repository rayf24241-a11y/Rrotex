import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import {
  doc,
  getDoc,
  getFirestore,
  increment,
  serverTimestamp,
  setDoc,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import {
  createUserWithEmailAndPassword,
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithRedirect,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';

const signedOutCard = document.querySelector('#signedOutCard');
const signedInCard = document.querySelector('#signedInCard');
const googleLogin = document.querySelector('#googleLogin');
const emailLogin = document.querySelector('#emailLogin');
const emailSignup = document.querySelector('#emailSignup');
const signOutButton = document.querySelector('#signOutButton');
const checkoutButton = document.querySelector('#checkoutButton');
const emailInput = document.querySelector('#emailInput');
const passwordInput = document.querySelector('#passwordInput');
const authMessage = document.querySelector('#authMessage');
const checkoutMessage = document.querySelector('#checkoutMessage');
const creditAmount = document.querySelector('#creditAmount');
const creditPreview = document.querySelector('#creditPreview');
const creditCheckoutButton = document.querySelector('#creditCheckoutButton');
const creditMessage = document.querySelector('#creditMessage');
const tokenBalance = document.querySelector('#tokenBalance');
const currentPlan = document.querySelector('#currentPlan');
const authState = document.querySelector('#authState');
const accountName = document.querySelector('#accountName');
const accountEmail = document.querySelector('#accountEmail');

let auth = null;
let db = null;
let currentUser = null;
let creditBalance = 0;

init();

async function init() {
  try {
    const response = await fetch('/api/firebase-config');
    const config = await response.json();
    if (!config.configured) {
      setAuthMessage('Firebase is not configured yet. Add Firebase env vars in Vercel.', true);
      authState.textContent = 'Firebase not configured';
      return;
    }

    const app = initializeApp(config.firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    await getRedirectResult(auth).catch((error) => {
      setAuthMessage(firebaseMessage(error, 'Google login could not finish.'), true);
    });

    onAuthStateChanged(auth, async (user) => {
      currentUser = user;
      renderUser(user);
      if (user) {
        await loadCreditBalance(user);
        await handleCheckoutReturn(user);
        await handleCreditCheckoutReturn(user);
        maybeShowDesktopConnect(user);
      } else {
        creditBalance = readLocalCredits();
        renderCredits();
      }
    });
  } catch (error) {
    setAuthMessage('Could not start Firebase login. Refresh and try again.', true);
    authState.textContent = 'Firebase error';
  }
}

function renderUser(user) {
  signedOutCard.hidden = Boolean(user);
  signedInCard.hidden = !user;
  authState.textContent = user ? 'Signed in' : 'Not signed in';
  accountName.textContent = user?.displayName || user?.email || 'Not signed in';
  accountEmail.textContent = user?.email || 'Use Google or email to continue.';
  renderPlan();
}

googleLogin.addEventListener('click', async () => {
  if (!auth) return setAuthMessage('Firebase is still loading. Try again in a second.', true);
  setAuthMessage('Redirecting to Google...');
  await signInWithRedirect(auth, new GoogleAuthProvider()).catch((error) => {
    setAuthMessage(firebaseMessage(error, 'Google login could not start.'), true);
  });
});

emailLogin.addEventListener('click', async () => {
  await emailAuth('login');
});

emailSignup.addEventListener('click', async () => {
  await emailAuth('signup');
});

signOutButton.addEventListener('click', async () => {
  if (auth) await signOut(auth);
});

checkoutButton.addEventListener('click', async () => {
  if (!currentUser) {
    setCheckoutMessage('Log in or sign up before buying Pro.', true);
    return;
  }
  checkoutButton.disabled = true;
  setCheckoutMessage('Opening Stripe...');
  try {
    const response = await fetch('/api/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: currentUser.uid, email: currentUser.email || '' }),
    });
    const data = await response.json();
    if (data.url) {
      window.location.href = data.url;
      return;
    }
    setCheckoutMessage(data.message || 'Stripe checkout could not start.', true);
  } catch {
    setCheckoutMessage('Could not reach Stripe checkout. Try again.', true);
  } finally {
    checkoutButton.disabled = false;
  }
});

creditAmount.addEventListener('input', renderCreditPreview);

creditCheckoutButton.addEventListener('click', async () => {
  if (!currentUser) {
    setCreditMessage('Log in or sign up before buying TexTokens.', true);
    return;
  }
  const dollars = normalizedCreditDollars();
  if (!dollars) {
    setCreditMessage('Choose a whole dollar amount from $5 to $500.', true);
    return;
  }
  creditCheckoutButton.disabled = true;
  setCreditMessage('Opening Stripe...');
  try {
    const response = await fetch('/api/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: currentUser.uid, email: currentUser.email || '', kind: 'credits', dollars }),
    });
    const data = await response.json();
    if (data.url) {
      window.location.href = data.url;
      return;
    }
    setCreditMessage(data.message || 'Stripe credit checkout could not start.', true);
  } catch {
    setCreditMessage('Could not reach Stripe checkout. Try again.', true);
  } finally {
    creditCheckoutButton.disabled = false;
  }
});

async function emailAuth(mode) {
  if (!auth) return setAuthMessage('Firebase is still loading. Try again in a second.', true);
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  if (!email || password.length < 6) {
    setAuthMessage('Enter an email and a password with at least 6 characters.', true);
    return;
  }
  setAuthMessage(mode === 'signup' ? 'Creating account...' : 'Logging in...');
  try {
    if (mode === 'signup') {
      await createUserWithEmailAndPassword(auth, email, password);
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
  } catch (error) {
    setAuthMessage(firebaseMessage(error, mode === 'signup' ? 'Could not create account.' : 'Could not log in.'), true);
  }
}

async function handleCheckoutReturn(user) {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('session_id');
  if (params.get('checkout') !== 'success' || !sessionId) return;

  setCheckoutMessage('Verifying Pro...');
  try {
    const response = await fetch('/api/verify-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, uid: user.uid }),
    });
    const data = await response.json();
    if (data.verified && data.proPass) {
      localStorage.setItem('rotex_pro_pass', data.proPass);
      setCheckoutMessage('Pro is active on this account.');
      history.replaceState('', document.title, '/account#pro');
      maybeShowDesktopConnect(currentUser);
    } else {
      setCheckoutMessage(data.message || 'Checkout could not be verified yet.', true);
    }
  } catch {
    setCheckoutMessage('Could not verify checkout. Refresh and try again.', true);
  }
}

async function handleCreditCheckoutReturn(user) {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('session_id');
  if (params.get('credits') !== 'success' || !sessionId) return;

  const appliedKey = `rotex_credit_session_${sessionId}`;
  if (localStorage.getItem(appliedKey)) {
    setCreditMessage('Those TexTokens were already added.');
    history.replaceState('', document.title, '/account#credits');
    return;
  }

  setCreditMessage('Verifying TexToken purchase...');
  try {
    const response = await fetch('/api/verify-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, uid: user.uid }),
    });
    const data = await response.json();
    if (!data.verified) {
      setCreditMessage(data.message || 'Credit checkout could not be verified yet.', true);
      return;
    }
    await addCredits(user, data.texTokens, sessionId);
    localStorage.setItem(appliedKey, '1');
    setCreditMessage(`Added ${formatTokens(data.texTokens)} TexTokens.`);
    history.replaceState('', document.title, '/account');
  } catch {
    setCreditMessage('Could not verify credit checkout. Refresh and try again.', true);
  }
}

async function loadCreditBalance(user) {
  creditBalance = readLocalCredits();
  renderCredits();
  if (!db || !user) return;
  try {
    const ref = doc(db, 'users', user.uid, 'billing', 'textokens');
    const snap = await getDoc(ref);
    const cloudCredits = Number(snap.data()?.balance || 0);
    if (Number.isFinite(cloudCredits)) {
      creditBalance = Math.max(creditBalance, cloudCredits);
      writeLocalCredits(creditBalance);
      renderCredits();
    }
  } catch {
    setCreditMessage('Signed in. Cloud TexToken sync is not available yet, so this device will remember purchases.', true);
  }
}

async function addCredits(user, amount, sessionId) {
  creditBalance += amount;
  writeLocalCredits(creditBalance);
  renderCredits();
  if (!db || !user) return;
  try {
    const ref = doc(db, 'users', user.uid, 'billing', 'textokens');
    await setDoc(ref, {
      balance: increment(amount),
      updatedAt: serverTimestamp(),
      lastStripeSession: sessionId,
    }, { merge: true });
    await loadCreditBalance(user);
  } catch {
    setCreditMessage('TexTokens were added on this device. Cloud sync needs Firestore rules/admin setup.', true);
  }
}

function normalizedCreditDollars() {
  const dollars = Math.floor(Number(creditAmount.value));
  if (!Number.isFinite(dollars) || dollars < 5 || dollars > 500) return 0;
  return dollars;
}

function renderCreditPreview() {
  const dollars = normalizedCreditDollars();
  const tokens = dollars ? Math.floor((dollars / 2.5) * 1_000_000) : 0;
  creditPreview.textContent = dollars ? `${formatTokens(tokens)} TexTokens` : 'Choose $5–$500';
}

function renderCredits() {
  tokenBalance.textContent = `${formatTokens(creditBalance)} TexTokens`;
  renderPlan();
}

function renderPlan() {
  if (!currentPlan) return;
  const pass = localStorage.getItem('rotex_pro_pass') || '';
  let pro = false;
  try {
    const payload = JSON.parse(atob(pass.split('.', 2)[0].replace(/-/g, '+').replace(/_/g, '/')));
    pro = payload.plan === 'pro' && Number(payload.exp) > Date.now();
  } catch { /* no active pass */ }
  currentPlan.textContent = pro ? 'Pro' : 'Free';
}

function readLocalCredits() {
  return Math.max(0, Math.floor(Number(localStorage.getItem('rotex_textokens_balance') || 0)));
}

function writeLocalCredits(amount) {
  localStorage.setItem('rotex_textokens_balance', String(Math.max(0, Math.floor(amount))));
}

function formatTokens(value) {
  const amount = Math.max(0, Math.floor(Number(value) || 0));
  if (amount >= 1000000) {
    const millions = amount / 1000000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  return amount.toLocaleString();
}

async function maybeShowDesktopConnect(user) {
  const proPass = localStorage.getItem('rotex_pro_pass') || '';
  if (!proPass || !user) return;
  const btn = document.getElementById('connectDesktopBtn');
  if (btn) btn.style.display = '';
}

document.getElementById('connectDesktopBtn')?.addEventListener('click', async () => {
  const proPass = localStorage.getItem('rotex_pro_pass') || '';
  if (!currentUser || !proPass) return;
  const msg = document.getElementById('connectDesktopMsg');
  try {
    const token = await currentUser.getIdToken().catch(() => '');
    const params = new URLSearchParams({
      uid:    currentUser.uid,
      email:  currentUser.email || '',
      name:   currentUser.displayName || '',
      exp:    String(Date.now() + 365 * 24 * 60 * 60 * 1000),
      token,
      proPass,
    });
    window.location.href = `rotex://auth?${params.toString()}`;
    if (msg) msg.textContent = 'Opening ROTEX Desktop…';
  } catch {
    if (msg) msg.textContent = 'Could not open desktop app.';
  }
});

function setAuthMessage(text, error = false) {
  authMessage.textContent = text;
  authMessage.classList.toggle('error', error);
}

function setCheckoutMessage(text, error = false) {
  checkoutMessage.textContent = text;
  checkoutMessage.classList.toggle('error', error);
}

function setCreditMessage(text, error = false) {
  creditMessage.textContent = text;
  creditMessage.classList.toggle('error', error);
}

function firebaseMessage(error, fallback) {
  const code = error?.code || '';
  if (code === 'auth/unauthorized-domain') return 'Add this domain in Firebase Authentication authorized domains.';
  if (code === 'auth/operation-not-allowed') return 'Enable this sign-in method in Firebase Authentication.';
  if (code === 'auth/email-already-in-use') return 'That email already has an account. Use Log In.';
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password') return 'Email or password is not right.';
  if (code === 'auth/popup-closed-by-user') return 'Google login was closed before finishing.';
  return error?.message || fallback;
}
