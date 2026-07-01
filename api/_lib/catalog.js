// Single source of truth for ROTEX cloud models.

const MODELS = {
  'texbrain-thinking': {
    name: 'TexBrain Thinking-beta',
    providerName: 'TexBrain Thinking-beta',
    maker: 'multi',
    logo: 'T',
    tier: 'free',
    access: 'Free',
    inputTexTokens: 0.8,
    outputTexTokens: 2.4,
    multiplier: 2,
    freeDailyCap: 25,
    route: 'tb-thinking',
    vision: true,
    thinkingModel: process.env.TB_THINKING_MODEL || process.env.TB_CODE_MODEL || process.env.TB_GPT_MODEL || 'qwen/qwen3-coder:free',
    thinkingFallbacks: ['meta-llama/llama-3.3-70b-instruct:free', 'openai/gpt-oss-120b:free', 'qwen/qwen3-coder:free', 'nvidia/nemotron-3-super-120b-a12b:free'],
    blurb: 'Stronger Roblox-focused planning, code, and Studio-edit reasoning under TexBrain Thinking-beta.',
    temperature: 0.2,
    maxTokens: 6144,
    proMaxTokens: 12288,
  },
  'pro-smart': {
    name: 'Claude Haiku',
    providerName: 'Claude Haiku 4.5',
    maker: 'claude',
    logo: 'H',
    tier: 'free',
    access: 'Free',
    inputTexTokens: 3.2,
    outputTexTokens: 16,
    multiplier: 1,
    freeDailyCap: 5,
    expensive: true,
    route: 'anthropic-first',
    envModel: 'CLAUDE_HAIKU_MODEL',
    anthropicModel: process.env.CLAUDE_HAIKU_PINNED_MODEL || 'claude-haiku-4-5-20251001',
    orModel: process.env.OPENROUTER_HAIKU_MODEL || 'anthropic/claude-haiku-4-5-20251001',
    blurb: 'Claude Haiku for higher quality answers. Costs more TexTokens.',
    maxTokens: 4096,
    proMaxTokens: 8192,
  },
  'google-flash': {
    name: 'Google Flash',
    providerName: 'Gemini 2.5 Flash',
    maker: 'google',
    logo: 'G',
    tier: 'free',
    access: 'Free',
    inputTexTokens: 2.4,
    outputTexTokens: 9.6,
    multiplier: 1,
    freeDailyCap: 15,
    route: 'openrouter',
    orModel: process.env.GOOGLE_FLASH_MODEL || process.env.GEMINI_FLASH_MODEL || 'google/gemini-2.5-flash',
    blurb: 'Google Gemini Flash for smart code and chat.',
    vision: false,
    temperature: 0.35,
    maxTokens: 4096,
    proMaxTokens: 8192,
  },
};

const MODEL_ALIASES = {
  groq: 'texbrain-thinking',
  llama: 'texbrain-thinking',
  fast: 'texbrain-thinking',
  balanced: 'texbrain-thinking',
  smart: 'texbrain-thinking',
  tb: 'texbrain-thinking',
  'tb-thinking': 'texbrain-thinking',
  'texbrain-thinking': 'texbrain-thinking',
  google: 'google-flash',
  gemini: 'google-flash',
  flash: 'google-flash',
  'google-flash': 'google-flash',
  'gemini-flash': 'google-flash',
  'gemini-2.5-flash': 'google-flash',
  claude: 'pro-smart',
  haiku: 'pro-smart',
  'claude-haiku': 'pro-smart',
  'claude-haiku-4-5': 'pro-smart',
  'claude-haiku-4-5-20251001': 'pro-smart',
  'pro-haiku': 'pro-smart',
  'pro-smart': 'pro-smart',
  'claude-haiku-latest': 'pro-smart',
};

const DEFAULT_MODEL_ID = 'texbrain-thinking';

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
