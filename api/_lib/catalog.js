// Single source of truth for ROTEX cloud models.
// Only these four models are enabled right now.

const MODELS = {
  fast: {
    name: 'Fast',
    providerName: 'Groq Llama 3.1 8B Instant',
    maker: 'groq',
    logo: 'F',
    tier: 'free',
    access: 'Free',
    inputTexTokens: 0.05,
    outputTexTokens: 0.08,
    multiplier: 2,
    route: 'groq-only',
    groqModel: process.env.GROQ_FAST_MODEL || 'llama-3.1-8b-instant',
    blurb: 'Fast Groq model for quick fixes and short answers.',
    maxTokens: 1024,
    proMaxTokens: 2048,
  },
  balanced: {
    name: 'Balanced',
    providerName: 'Groq Qwen3 32B',
    maker: 'groq',
    logo: 'B',
    tier: 'free',
    access: 'Free limited',
    inputTexTokens: 0.29,
    outputTexTokens: 0.59,
    multiplier: 2,
    route: 'groq-only',
    groqModel: process.env.GROQ_BALANCED_MODEL || 'qwen/qwen3-32b',
    blurb: 'Balanced Groq model for regular coding help.',
    maxTokens: 1536,
    proMaxTokens: 4096,
    freeDailyCap: 20,
  },
  smart: {
    name: 'Smart',
    providerName: 'Groq Llama 3.3 70B Versatile',
    maker: 'groq',
    logo: 'S',
    tier: 'free',
    access: 'Free small test',
    inputTexTokens: 0.59,
    outputTexTokens: 0.79,
    multiplier: 2,
    route: 'groq-only',
    groqModel: process.env.GROQ_SMART_MODEL || 'llama-3.3-70b-versatile',
    blurb: 'Smart Groq model for harder debugging and planning.',
    maxTokens: 1024,
    proMaxTokens: 4096,
    freeDailyCap: 5,
  },
  'pro-smart': {
    name: 'Pro Smart',
    providerName: 'Claude Haiku 4.5',
    maker: 'claude',
    logo: 'H',
    tier: 'pro',
    access: 'Pro only',
    inputTexTokens: 1,
    outputTexTokens: 5,
    multiplier: 3.2,
    expensive: true,
    route: 'anthropic-first',
    envModel: 'CLAUDE_HAIKU_MODEL',
    anthropicModel: 'claude-haiku-4-5',
    orModel: process.env.OPENROUTER_HAIKU_MODEL || 'anthropic/claude-haiku-4.5',
    blurb: 'Claude Haiku for Pro users. Costs more TexTokens.',
    maxTokens: 4096,
    proMaxTokens: 8192,
  },
};

const MODEL_ALIASES = {
  groq: 'fast',
  llama: 'fast',
  llama8b: 'fast',
  'llama-3-1-8b': 'fast',
  'llama-3.1-8b': 'fast',
  qwen: 'balanced',
  qwen3: 'balanced',
  'qwen3-32b': 'balanced',
  'qwen-32b': 'balanced',
  'llama-70b': 'smart',
  'llama-3-3-70b': 'smart',
  'llama-3.3-70b': 'smart',
  claude: 'pro-smart',
  haiku: 'pro-smart',
  'claude-haiku': 'pro-smart',
  'claude-haiku-4-5': 'pro-smart',
  'pro-haiku': 'pro-smart',
  'gbt': 'fast',
  'gpt': 'fast',
  'gpt-5-5': 'pro-smart',
  'gbt-5-5': 'pro-smart',
  'grok': 'smart',
  'grok-3-4': 'smart',
  'claude-sonnet': 'pro-smart',
  'claude-opus': 'pro-smart',
};

const DEFAULT_MODEL_ID = 'fast';

function resolveModelId(id) {
  if (MODELS[id]) return id;
  if (MODEL_ALIASES[id] && MODELS[MODEL_ALIASES[id]]) return MODEL_ALIASES[id];
  return DEFAULT_MODEL_ID;
}

function publicCatalog() {
  return Object.entries(MODELS).map(([id, m]) => ({
    id,
    name: m.name,
    providerName: m.providerName || '',
    maker: m.maker,
    logo: m.logo,
    tier: m.tier,
    access: m.access || m.tier,
    inputTexTokens: m.inputTexTokens ?? 0,
    outputTexTokens: m.outputTexTokens ?? 0,
    multiplier: m.multiplier ?? 0,
    blurb: m.blurb,
    localOnly: Boolean(m.localOnly),
    best: Boolean(m.best),
  }));
}

module.exports = { MODELS, MODEL_ALIASES, DEFAULT_MODEL_ID, resolveModelId, publicCatalog };
