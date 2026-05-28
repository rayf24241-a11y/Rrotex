const AdmZip = require('adm-zip');

const MODELS = {
  'rod-1': {
    name: 'Rod _ 1',
    provider: 'groq',
    providerModel: 'llama-3.1-8b-instant',
    purpose: 'everyday tasks',
    temperature: 0.65,
    maxTokens: 700,
  },
  'rod-thinking': {
    name: 'Rod thinking',
    provider: 'groq',
    providerModel: 'llama-3.3-70b-versatile',
    purpose: 'harder tasks',
    temperature: 0.55,
    maxTokens: 1100,
  },
  'rod-brain': {
    name: 'Rod brain',
    provider: 'anthropic',
    providerModel: process.env.CLAUDE_HAIKU_MODEL || process.env.ANTHROPIC_HAIKU_MODEL || 'claude-haiku-4-5-20251001',
    purpose: 'smart everyday help',
    temperature: 0.45,
    maxTokens: 1100,
  },
  'tex-0': {
    name: 'Tex 0',
    provider: 'deepseek',
    providerModel: 'deepseek-chat',
    purpose: 'code',
    temperature: 0.35,
    maxTokens: 1200,
  },
  'tex-1-5': {
    name: 'Tex 1.5',
    provider: 'deepseek',
    providerModel: 'deepseek-reasoner',
    purpose: 'complex code',
    temperature: 0.25,
    maxTokens: 1600,
  },
  'tex-2-5': {
    name: 'Tex 2.5',
    provider: 'anthropic',
    providerModel: process.env.CLAUDE_OPUS_MODEL || process.env.ANTHROPIC_OPUS_MODEL || 'claude-opus-4-7',
    purpose: 'pro complex code',
    temperature: 0.25,
    maxTokens: 1800,
  },
  'treesearch-q': {
    name: 'Treesearch _ q',
    provider: 'groq',
    providerModel: 'llama-3.3-70b-versatile',
    purpose: 'research only',
    temperature: 0.4,
    maxTokens: 1200,
  },
};

module.exports = async function handler(request, response) {
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { authToken = '', model = 'rod-1', messages = [], computerMode = false, computerConnections = [], pcBridge = {}, personality = '', attachments = [] } = request.body || {};
  // Auth is optional — logged-in users get cloud sync, guests can still chat
  const authResult = await verifyFirebaseToken(authToken);

  const selected = MODELS[model] || MODELS['rod-1'];
  const modelGuide = buildModelGuide();
  const cleanAttachments = normalizeAttachments(attachments);
  const hasImages = cleanAttachments.some((item) => item.kind === 'image');
  const connectionStatus = summarizeConnections(computerConnections, pcBridge);
  const cleanMessages = messages
    .filter((message) => message && ['user', 'assistant', 'system'].includes(message.role))
    .slice(-18)
    .map((message) => ({
      role: message.role,
      content: String(message.text || message.content || '').slice(0, 8000),
    }));
  const lastUser = [...cleanMessages].reverse().find((message) => message.role === 'user');
  if (lastUser && cleanAttachments.length) {
    lastUser.content = `${lastUser.content}\n\n${attachmentPrompt(cleanAttachments, selected.provider === 'anthropic')}`.slice(0, 16000);
  }

  cleanMessages.unshift({
    role: 'system',
    content: [
      'You are a ROTEX web assistant.',
      'Chat naturally. Never answer with a giant capability list, marketing pitch, or "I am your assistant" intro. If asked what you can do, answer in 1-3 casual sentences.',
      'Do not use bold headings like "Main capabilities" or "Current setup" unless the user specifically asks for a formatted list.',
      `ROTEX model lineup: ${modelGuide}`,
      `Current selected model: ${selected.name}. If the user asks which model is best, compare these ROTEX model names only, not provider names.`,
      hasImages && selected.provider !== 'anthropic' ? `An image-reading backend is reading the attachment for ${selected.name}; still answer as ${selected.name}.` : '',
      'You can create clear Markdown tables when they help compare choices, pricing, limits, plans, or model abilities.',
      'You can write code in fenced Markdown code blocks with the language name so the app can show it cleanly.',
      'You can create multiple downloadable files and folders. For a folder, use file blocks with paths like ```file:project/src/app.js. For binary/image files, use ```file:name.ext;base64 and put only base64 content inside. If the user asks for a zip, create multiple file blocks and the app can zip them together.',
      'If the user asks for a website zip or a bunch of website files, make a sensible starter website immediately unless critical details are missing. Include index.html, styles.css, script.js, README.md, and an images/ folder with SVG images such as images/logo.svg or images/hero.svg when images are requested.',
      'You can make images as SVG files directly. Use paths like ```file:images/hero.svg and write valid SVG markup inside.',
      'If the user uploaded an image or asset and asks for a website/folder/zip, reference that uploaded file in the generated code using its path or an images/assets path. The app will include uploaded assets in the downloadable bundle.',
      'The conversation may include a compact summary of older messages. Treat it as memory and continue from the recent messages.',
      personality ? `Chat style: ${String(personality).slice(0, 700)}.` : '',
      connectionStatus,
      'If the user asks whether GitHub, Google Drive, PC, or another ROTEX connection worked, answer from the ROTEX connection status above. Do not say you cannot check it when that status is provided.',
      'You can generate downloadable files for the user. When asked for any file (code, text, data, etc.), wrap it exactly like this: start with ```file:filename.ext on its own line, then the file contents, then a closing ``` line. The user will see a download button. Always use this format when producing files.',
      'You can read files and images the user attaches in chat when their content is provided. Do not claim you cannot see an attachment that is listed in the prompt.',
      'You cannot directly access, read, or modify files already on the user\'s device unless they attach them or use approved computer-mode connections.',
      computerMode
        ? `Computer mode is on. Before any external-work action, ask the user to connect one of these services: ${Array.isArray(computerConnections) && computerConnections.length ? computerConnections.join(', ') : 'Google Drive, GitHub, or Connect PC'}. PC pairing status: ${pcBridge?.connected ? 'connected' : 'not connected'}. PC folder status: ${pcBridge?.folderReady ? `approved folder ${pcBridge.folderName || ''}` : 'no approved folder'}. You may mention that real PC file reads/writes require the connected PC page/helper to stay open and must ask for approval before reading or changing files.`
        : 'Computer mode is off. Do not ask for external service access unless the user explicitly asks about connecting apps.',
    ].join(' '),
  });

  if (model === 'treesearch-q') {
    cleanMessages.unshift({
      role: 'system',
      content: 'You are Treesearch _ q. Focus on research, comparison, and explanation. Do not create, edit, delete, or rename files.',
    });
  }

  try {
    let text = '';
    if (selected.provider === 'anthropic' || hasImages) {
      text = await callAnthropic({
        apiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY,
        model: selected.provider === 'anthropic' ? selected.providerModel : supportedVisionModel(),
        messages: cleanMessages,
        attachments: cleanAttachments,
        temperature: selected.temperature,
        maxTokens: selected.maxTokens,
      });
    } else if (selected.provider === 'deepseek') {
      text = await callOpenAiCompatible({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseUrl: 'https://api.deepseek.com/chat/completions',
        model: selected.providerModel,
        messages: cleanMessages,
        temperature: selected.temperature,
        maxTokens: selected.maxTokens,
      });
    } else {
      text = await callOpenAiCompatible({
        apiKey: process.env.GROQ_API_KEY,
        baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
        model: selected.providerModel,
        messages: cleanMessages,
        temperature: selected.temperature,
        maxTokens: selected.maxTokens,
      });
    }

    response.status(200).json({ model: selected.name, text });
  } catch (error) {
    console.error('ROTEX backend provider failed', {
      model: selected.name,
      provider: selected.provider,
      message: error?.message || String(error),
    });
    response.status(500).json({
      error: 'backend_unavailable',
      text: `${selected.name} could not answer right now. Try again in a moment, or switch to another ROTEX model for this message.`,
    });
  }
};

function buildModelGuide() {
  return Object.values(MODELS)
    .map((item) => `${item.name}: ${item.purpose}`)
    .join('; ');
}

function supportedVisionModel() {
  return process.env.CLAUDE_HAIKU_MODEL || process.env.ANTHROPIC_HAIKU_MODEL || 'claude-haiku-4-5-20251001';
}

function normalizeAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).map((item) => {
    const kind = item?.kind === 'image' ? 'image' : item?.kind === 'zip' ? 'zip' : 'file';
    const content = String(item?.content || '').slice(0, kind === 'image' || kind === 'zip' ? 4000000 : 12000);
    return {
      name: String(item?.name || 'attachment').slice(0, 100),
      path: String(item?.path || item?.name || 'attachment').slice(0, 180),
      type: String(item?.type || 'application/octet-stream').slice(0, 80),
      kind,
      size: Number(item?.size) || 0,
      content,
      zipText: kind === 'zip' ? readZipText(content) : '',
    };
  }).filter((item) => item.content);
}

function attachmentPrompt(attachments, canReadImages) {
  const lines = attachments.map((item, index) => {
    const base = `${index + 1}. ${item.path || item.name} (${item.type || item.kind}, ${item.size || 0} bytes)`;
    if (item.kind === 'image') {
      return `${base}: ${canReadImages ? 'image attached for visual reading.' : 'image attached, but this selected model can only see the file name/type.'}`;
    }
    if (item.kind === 'zip') {
      return `${base}: zip archive contents:\n${item.zipText || 'No readable text files found in this zip.'}`;
    }
    if (item.content.startsWith('data:')) {
      return `${base}: binary file attached. The model can see the name, path, type, and size.`;
    }
    return `${base}:\n${item.content.slice(0, 4000)}`;
  });
  return `User attached files:\n${lines.join('\n\n')}`;
}

function readZipText(dataUrl) {
  try {
    const base64 = String(dataUrl || '').split(',', 2)[1] || '';
    if (!base64) return '';
    const zip = new AdmZip(Buffer.from(base64, 'base64'));
    return zip.getEntries()
      .filter((entry) => !entry.isDirectory)
      .slice(0, 20)
      .map((entry) => {
        const name = entry.entryName;
        if (!isReadablePath(name)) return `${name}: binary or unsupported file`;
        return `${name}:\n${entry.getData().toString('utf8').slice(0, 3000)}`;
      })
      .join('\n\n')
      .slice(0, 12000);
  } catch (error) {
    return `Could not read zip: ${error?.message || 'unknown error'}`;
  }
}

function isReadablePath(name) {
  return /\.(txt|md|json|js|ts|tsx|jsx|html|css|py|csv|xml|yml|yaml|bat|ps1|java|c|cpp|cs|go|rs|php|rb|sql|env|gitignore)$/i.test(name);
}

function summarizeConnections(computerConnections, pcBridge) {
  const services = ['Google Drive', 'GitHub', 'PC'];
  const connected = Array.isArray(computerConnections)
    ? [...new Set(computerConnections.filter((item) => services.includes(item)))]
    : [];
  const missing = services.filter((service) => !connected.includes(service));
  const pcFolder = pcBridge?.folderReady
    ? `yes${pcBridge.folderName ? ` (${pcBridge.folderName})` : ''}`
    : 'no';

  return [
    `ROTEX connection status: connected services: ${connected.length ? connected.join(', ') : 'none'}.`,
    `Not connected: ${missing.length ? missing.join(', ') : 'none'}.`,
    `PC paired: ${pcBridge?.connected ? 'yes' : 'no'}.`,
    `PC folder approved: ${pcFolder}.`,
  ].join(' ');
}

async function verifyFirebaseToken(authToken) {
  if (!authToken) {
    return { ok: false };
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) {
    return { ok: false };
  }

  try {
    const result = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(authToken)}`);
    if (!result.ok) {
      return { ok: false };
    }

    const token = await result.json();
    return {
      ok: token.aud === projectId && token.sub,
      uid: token.sub || '',
      email: token.email || '',
    };
  } catch {
    return { ok: false };
  }
}

async function callOpenAiCompatible({ apiKey, baseUrl, model, messages, temperature = 0.7, maxTokens = 900 }) {
  if (!apiKey) {
    throw new Error('Missing provider key');
  }

  const providerResponse = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
  });

  if (!providerResponse.ok) {
    const body = await providerResponse.text();
    throw new Error(body);
  }

  const data = await providerResponse.json();
  return data.choices?.[0]?.message?.content || 'No response text returned.';
}

async function callAnthropic({ apiKey, model, messages, attachments = [], temperature = 0.7, maxTokens = 900 }) {
  if (!apiKey) {
    throw new Error('Missing Anthropic key');
  }

  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const chatMessages = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
  const imageParts = attachments
    .filter((item) => item.kind === 'image' && item.content.startsWith('data:image/'))
    .map((item) => {
      const [meta, data] = item.content.split(',', 2);
      const mediaType = (meta.match(/^data:(.*?);base64$/) || [])[1] || item.type || 'image/png';
      return {
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data },
      };
    });
  if (imageParts.length) {
    const lastUser = [...chatMessages].reverse().find((message) => message.role === 'user');
    if (lastUser) {
      lastUser.content = [{ type: 'text', text: String(lastUser.content || '') }, ...imageParts];
    }
  }

  const body = {
    model,
    system,
    messages: chatMessages.length ? chatMessages : [{ role: 'user', content: 'Hello' }],
    max_tokens: maxTokens,
  };
  if (!/opus-4-7|opus-4-6|sonnet-4-6/.test(model)) {
    body.temperature = temperature;
  }

  const providerResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!providerResponse.ok) {
    const body = await providerResponse.text();
    throw new Error(body);
  }

  const data = await providerResponse.json();
  return Array.isArray(data.content)
    ? data.content.map((part) => part.text || '').join('').trim()
    : 'No response text returned.';
}
