// Single source of truth for ROTEX cloud models.

const MODELS = {
  'texbrain-thinking': {
    name: 'TexBrain Thinking-beta',
    providerName: 'TexBrain Thinking-beta',
    maker: 'multi',
    logo: 'T',
    tier: 'free',
    access: 'Free',
    // Hidden from the app/website (see the model picker in editor.html and
    // index.html), but the entry is kept here for later. enabled: false is
    // the actual server-side gate -- it's enforced in resolveModelId() below
    // AND at the top of handleTexBrain() in api/chat.js (a separate route
    // that doesn't go through resolveModelId at all), so hiding it from the
    // UI can't be bypassed by tampered client code, a direct API call, or a
    // stale localStorage value pointing at it.
    enabled: false,
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
    providerName: 'Gemini 3.5 Flash',
    maker: 'google',
    logo: 'G',
    tier: 'free',
    access: 'Free',
    // Scaled 5x/3.6x from the old 2.4/9.6 to match gemini-3.5-flash's real
    // OpenRouter price ratio vs gemini-2.5-flash ($1.50 vs $0.30 per 1M
    // input, $9.00 vs $2.50 per 1M output -- confirmed live against
    // OpenRouter's model metadata, not estimated). Keeps freeDailyCap
    // meaning roughly the same real-dollar ceiling it meant before the
    // model swap, instead of silently permitting ~5x more spend per free
    // user per day at the old rate.
    inputTexTokens: 12,
    outputTexTokens: 35,
    multiplier: 1,
    freeDailyCap: 15,
    route: 'openrouter',
    // Primary: gemini-3.5-flash (confirmed live via OpenRouter's public
    // model API -- released 2026-05-19, real model, not a guess). Fallback
    // to 2.5 Flash is handled as a second attempt in resolveProviderCall,
    // not here -- this env-overridable default is only the PRIMARY attempt.
    orModel: process.env.GOOGLE_FLASH_MODEL || process.env.GEMINI_FLASH_MODEL || 'google/gemini-3.5-flash',
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
  'gemini-3.5-flash': 'google-flash',
  claude: 'pro-smart',
  haiku: 'pro-smart',
  'claude-haiku': 'pro-smart',
  'claude-haiku-4-5': 'pro-smart',
  'claude-haiku-4-5-20251001': 'pro-smart',
  'pro-haiku': 'pro-smart',
  'pro-smart': 'pro-smart',
  'claude-haiku-latest': 'pro-smart',
};

// TexBrain hidden from the app (model picker + website) for now -- kept in
// MODELS below so handleTexBrain's pricing logic and the backend route still
// work if it's ever re-enabled. Google Flash is the default in the meantime.
const DEFAULT_MODEL_ID = 'google-flash';

function resolveModelId(id) {
  // A disabled model (enabled: false) is treated as not found -- this is the
  // actual server-side enforcement for hiding a model, not just leaving it
  // out of the client UI. A tampered client, stale localStorage value, or a
  // request crafted directly against the API cannot resolve to a disabled
  // model this way; it silently falls through to DEFAULT_MODEL_ID instead.
  if (MODELS[id] && MODELS[id].enabled !== false) return id;
  if (MODEL_ALIASES[id] && MODELS[MODEL_ALIASES[id]] && MODELS[MODEL_ALIASES[id]].enabled !== false) return MODEL_ALIASES[id];
  return DEFAULT_MODEL_ID;
}

function publicCatalog() {
  return Object.entries(MODELS)
    .filter(([, m]) => m.enabled !== false)
    .map(([id, m]) => ({
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
