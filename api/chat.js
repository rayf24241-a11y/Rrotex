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

  const { authToken = '', model = 'rod-1', messages = [], computerMode = false, computerConnections = [], pcBridge = {}, personality = '' } = request.body || {};
  // Auth is optional — logged-in users get cloud sync, guests can still chat
  const authResult = await verifyFirebaseToken(authToken);

  const selected = MODELS[model] || MODELS['rod-1'];
  const cleanMessages = messages
    .filter((message) => message && ['user', 'assistant', 'system'].includes(message.role))
    .slice(-18)
    .map((message) => ({
      role: message.role,
      content: String(message.text || message.content || '').slice(0, 8000),
    }));

  cleanMessages.unshift({
    role: 'system',
    content: [
      'You are a ROTEX web assistant.',
      'Chat naturally. Do not start with a giant capability list, identity speech, or "I am your assistant" intro unless the user asks what you can do. Keep normal answers short and useful.',
      personality ? `Chat style: ${String(personality).slice(0, 700)}.` : '',
      'You CAN generate downloadable files for the user. When asked for any file (code, text, data, etc.), wrap it exactly like this: start with ```file:filename.ext on its own line, then the file contents, then a closing ``` line. The user will see a download button. Always use this format when producing files — never just paste raw code when a file was asked for.',
      'You cannot directly access, read, or modify files already on the user\'s device.',
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
    const text = selected.provider === 'deepseek'
      ? await callOpenAiCompatible({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseUrl: 'https://api.deepseek.com/chat/completions',
        model: selected.providerModel,
        messages: cleanMessages,
        temperature: selected.temperature,
        maxTokens: selected.maxTokens,
      })
      : await callOpenAiCompatible({
        apiKey: process.env.GROQ_API_KEY,
        baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
        model: selected.providerModel,
        messages: cleanMessages,
        temperature: selected.temperature,
        maxTokens: selected.maxTokens,
      });

    response.status(200).json({ model: selected.name, text });
  } catch (error) {
    response.status(500).json({
      error: 'backend_unavailable',
      text: `${selected.name} is set to ${selected.providerModel}, but the server key is missing or the provider failed. Add GROQ_API_KEY and DEEPSEEK_API_KEY in Vercel.`,
    });
  }
};

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
