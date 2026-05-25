const models = [
  {
    id: 'rod-1',
    name: 'Rod _ 1',
    short: 'Everyday',
    description: 'Everyday tasks, quick answers, normal chat, and simple work.',
  },
  {
    id: 'rod-thinking',
    name: 'Rod thinking',
    short: 'Hard tasks',
    description: 'Harder tasks that need more reasoning, planning, and careful answers.',
  },
  {
    id: 'tex-0',
    name: 'Tex 0',
    short: 'Code',
    description: 'Code help, debugging, implementation, and file-aware project work.',
  },
  {
    id: 'tex-1-5',
    name: 'Tex 1.5',
    short: 'Complex code',
    description: 'Complex code, larger builds, deeper architecture, and tougher fixes.',
  },
  {
    id: 'treesearch-q',
    name: 'Treesearch _ q',
    short: 'Research',
    description: 'Research mode for searching, comparing, and explaining. It cannot create files.',
  },
];

const chatList = document.querySelector('#chatList');
const messagesEl = document.querySelector('#messages');
const modelStrip = document.querySelector('#modelStrip');
const composer = document.querySelector('#composer');
const messageInput = document.querySelector('#messageInput');
const newChatButton = document.querySelector('#newChatButton');
const googleButton = document.querySelector('#googleButton');
const googleButtonText = document.querySelector('#googleButtonText');
const loginDialog = document.querySelector('#loginDialog');
const emailInput = document.querySelector('#emailInput');
const saveLoginButton = document.querySelector('#saveLoginButton');
const saveStatus = document.querySelector('#saveStatus');
const checkoutButton = document.querySelector('#checkoutButton');

const storageKey = 'rotex:web:v1';
let state = loadState();

function loadState() {
  const saved = localStorage.getItem(storageKey);
  if (saved) {
    try {
      return JSON.parse(saved);
    } catch {}
  }

  const firstChatId = crypto.randomUUID();
  return {
    userEmail: '',
    activeModel: 'rod-1',
    activeChatId: firstChatId,
    chats: [
      {
        id: firstChatId,
        title: 'New ROTEX chat',
        createdAt: Date.now(),
        messages: [],
      },
    ],
  };
}

function saveState() {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

function activeChat() {
  return state.chats.find((chat) => chat.id === state.activeChatId) || state.chats[0];
}

function activeModel() {
  return models.find((model) => model.id === state.activeModel) || models[0];
}

function renderModels() {
  modelStrip.innerHTML = '';
  models.forEach((model) => {
    const button = document.createElement('button');
    button.className = `model-button${model.id === state.activeModel ? ' active' : ''}`;
    button.type = 'button';
    button.innerHTML = `<div><strong>${model.name}</strong><span>${model.short}</span></div>`;
    button.addEventListener('click', () => {
      state.activeModel = model.id;
      saveState();
      render();
    });
    modelStrip.appendChild(button);
  });
}

function renderChats() {
  chatList.innerHTML = '';
  state.chats.forEach((chat) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `chat-item${chat.id === state.activeChatId ? ' active' : ''}`;
    button.innerHTML = `<span>${chat.title}</span><small>${chat.messages.length}</small>`;
    button.addEventListener('click', () => {
      state.activeChatId = chat.id;
      saveState();
      render();
    });
    chatList.appendChild(button);
  });
}

function renderMessages() {
  const chat = activeChat();
  messagesEl.innerHTML = '';

  if (!chat || chat.messages.length === 0) {
    messagesEl.innerHTML = `
      <div class="empty-state">
        <p class="eyebrow">Ready</p>
        <h2>${activeModel().name}</h2>
        <p>${activeModel().description}</p>
      </div>
    `;
    return;
  }

  chat.messages.forEach((message) => {
    const item = document.createElement('div');
    item.className = `message ${message.role}`;
    item.innerHTML = `<span class="message-meta">${message.role === 'user' ? 'You' : message.model}</span>${escapeHtml(message.text)}`;
    messagesEl.appendChild(item);
  });
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderAccount() {
  if (state.userEmail) {
    googleButtonText.textContent = state.userEmail;
    saveStatus.textContent = 'Signed in test profile. Chats save locally under this browser.';
  } else {
    googleButtonText.textContent = 'Log in or sign up';
    saveStatus.textContent = 'Chats save on this device until Google sync is connected.';
  }
}

function render() {
  renderModels();
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
  saveState();
  render();
  messageInput.focus();
}

function sendMessage(text) {
  const chat = activeChat();
  const model = activeModel();
  const clean = text.trim();
  if (!clean || !chat) return;

  chat.messages.push({ role: 'user', text: clean, model: 'You' });
  if (chat.title === 'New ROTEX chat') {
    chat.title = clean.length > 28 ? `${clean.slice(0, 28)}...` : clean;
  }

  chat.messages.push({
    role: 'assistant',
    model: model.name,
    text: `${model.name} is selected for this chat. The live ROTEX backend is the next step, so this web demo is saving the conversation shell right now.`,
  });

  saveState();
  render();
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

newChatButton.addEventListener('click', createChat);

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

googleButton.addEventListener('click', () => {
  emailInput.value = state.userEmail;
  loginDialog.showModal();
  emailInput.focus();
});

saveLoginButton.addEventListener('click', () => {
  const email = emailInput.value.trim();
  if (!email) return;
  state.userEmail = email;
  saveState();
  loginDialog.close();
  render();
});

checkoutButton.addEventListener('click', () => {
  alert('Stripe test checkout will connect through the backend next.');
});

render();
