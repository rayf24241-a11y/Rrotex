const MODELS = {
  'rod-1': {
    name: 'Rod _ 1',
    provider: 'groq',
    providerModel: 'llama-3.1-8b-instant',
    purpose: 'everyday tasks',
  },
  'rod-thinking': {
    name: 'Rod thinking',
    provider: 'groq',
    providerModel: 'llama-3.3-70b-versatile',
    purpose: 'harder tasks',
  },
  'tex-0': {
    name: 'Tex 0',
    provider: 'deepseek',
    providerModel: 'deepseek-chat',
    purpose: 'code',
  },
  'tex-1-5': {
    name: 'Tex 1.5',
    provider: 'deepseek',
    providerModel: 'deepseek-chat',
    purpose: 'complex code',
  },
  'treesearch-q': {
    name: 'Treesearch _ q',
    provider: 'groq',
    providerModel: 'llama-3.3-70b-versatile',
    purpose: 'research only',
  },
};

module.exports = async function handler(request, response) {
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { authToken = '', model = 'rod-1', messages = [], computerMode = false, computerConnections = [], pcBridge = {} } = request.body || {};
  const authResult = await verifyFirebaseToken(authToken);
  if (!authResult.ok) {
    response.status(401).json({
      error: 'login_required',
      text: 'Log in with Google to use ROTEX credits and chat.',
    });
    return;
  }

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
      'You cannot create, edit, delete, rename, upload, download, or directly modify the user\'s existing files from this website.',
      'If the user asks you to edit files, explain that direct file editing is disabled.',
      'If the user asks for a downloadable file, generate it with this exact wrapper: an opening line ```file:filename.ext, then the file contents on following lines, then a closing ``` line. Keep normal explanation outside the file block.',
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
      })
      : await callOpenAiCompatible({
        apiKey: process.env.GROQ_API_KEY,
        baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
        model: selected.providerModel,
        messages: cleanMessages,
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

async function callOpenAiCompatible({ apiKey, baseUrl, model, messages }) {
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
      temperature: 0.7,
      max_tokens: 900,
    }),
  });

  if (!providerResponse.ok) {
    const body = await providerResponse.text();
    throw new Error(body);
  }

  const data = await providerResponse.json();
  return data.choices?.[0]?.message?.content || 'No response text returned.';
}
