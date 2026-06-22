// Single source of truth for ROTEX cloud models.

const MODELS = {
  'texbrain-thinking': {
    name: 'TexBrain thinking-β',
    providerName: 'gpt-oss-120b · Cohere · Qwen3 Coder',
    maker: 'multi',
    logo: 'T',
    tier: 'free',
    access: 'Free',
    inputTexTokens: 0.1,
    outputTexTokens: 0.3,
    multiplier: 2,
    route: 'tb-thinking',
    vision: true,
    // env vars for each sub-model (operator configures actual IDs)
    chatModel:  process.env.TB_GPT_MODEL    || 'openai/gpt-4o-mini',
    codeModel:  process.env.TB_CODE_MODEL   || 'cohere/command-r-plus-08-2024',
    testModel:  process.env.TB_TEST_MODEL   || 'qwen/qwen3-coder-480b-a35b-instruct',
    blurb: 'Multi-model pipeline: gpt-oss-120b for chat, Cohere for code, Qwen3 for testing.',
    maxTokens: 4096,
    proMaxTokens: 8192,
  },
  'pro-smart': {
    name: 'Claude Haiku',
    providerName: 'Claude Haiku 4.5',
    maker: 'claude',
    logo: 'H',
    tier: 'free',
    access: 'Free',
    inputTexTokens: 1,
    outputTexTokens: 5,
    multiplier: 3.2,
    expensive: true,
    route: 'anthropic-first',
    envModel: 'CLAUDE_HAIKU_MODEL',
    anthropicModel: 'claude-haiku-4-5',
    orModel: process.env.OPENROUTER_HAIKU_MODEL || 'anthropic/claude-haiku-4.5',
    blurb: 'Claude Haiku for higher quality answers. Costs more TexTokens.',
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
  claude: 'pro-smart',
  haiku: 'pro-smart',
  'claude-haiku': 'pro-smart',
  'claude-haiku-4-5': 'pro-smart',
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
