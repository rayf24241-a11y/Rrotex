const MODELS = {
  'rod-1': {
    name: 'Rod _ 1',
    api: 'Groq llama-3.1-8b-instant',
    purpose: 'everyday tasks',
  },
  'rod-thinking': {
    name: 'Rod thinking',
    api: 'Groq llama-3.3-70b-versatile',
    purpose: 'harder tasks',
  },
  'tex-0': {
    name: 'Tex 0',
    api: 'DeepSeek chat',
    purpose: 'code',
  },
  'tex-1-5': {
    name: 'Tex 1.5',
    api: 'DeepSeek chat/reasoner',
    purpose: 'complex code',
  },
  'treesearch-q': {
    name: 'Treesearch _ q',
    api: 'DeepSeek reasoner',
    purpose: 'research only',
  },
};

module.exports = async function handler(request, response) {
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { model = 'rod-1', messages = [] } = request.body || {};
  const selected = MODELS[model] || MODELS['rod-1'];
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');

  response.status(200).json({
    model: selected.name,
    text: `${selected.name} is routed for ${selected.purpose} through ${selected.api}. Real provider keys are the next backend step. You said: "${String(lastUser?.text || '').slice(0, 240)}"`,
  });
};
