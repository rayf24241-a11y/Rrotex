// Single source of truth for ROTEX cloud models.
// Cloud models route through OpenRouter. Ollama is local-only in the client.

const MODELS = {
  claude: {
    name: 'Claude',
    maker: 'claude',
    logo: 'C',
    tier: 'pro',
    cost: 0.06,
    computerCost: 0.14,
    route: 'anthropic-first',
    anthropicModel: 'claude-sonnet-4-5',
    orModel: 'anthropic/claude-sonnet-4.5',
    blurb: 'Claude through your Claude key first, with OpenRouter backup.',
    maxTokens: 8192,
    proMaxTokens: 8192,
  },
  gbt: {
    name: 'GBT',
    maker: 'gbt',
    logo: 'G',
    tier: 'free',
    cost: 0.004,
    computerCost: 0.012,
    route: 'openrouter',
    orModel: 'openai/gpt-4o-mini',
    blurb: 'Fast OpenAI GPT model through OpenRouter.',
    maxTokens: 2048,
    proMaxTokens: 4096,
  },
  grok: {
    name: 'Grok',
    maker: 'grok',
    logo: 'X',
    tier: 'pro',
    cost: 0.015,
    computerCost: 0.04,
    route: 'openrouter',
    orModel: 'x-ai/grok-4.3',
    blurb: 'Grok through OpenRouter for reasoning and broad context.',
    maxTokens: 4096,
    proMaxTokens: 8192,
  },
  groq: {
    name: 'Groq',
    maker: 'groq',
    logo: 'Q',
    tier: 'free',
    cost: 0.002,
    computerCost: 0.01,
    route: 'openrouter',
    orModel: 'meta-llama/llama-3.3-70b-instruct',
    blurb: 'Fast model routed through OpenRouter.',
    maxTokens: 2048,
    proMaxTokens: 4096,
  },
  gemini: {
    name: 'Gemini',
    maker: 'gemini',
    logo: 'Ge',
    tier: 'free',
    cost: 0.003,
    computerCost: 0.01,
    route: 'openrouter',
    orModel: 'google/gemini-2.5-flash-lite',
    blurb: 'Gemini through OpenRouter for quick answers and long context.',
    maxTokens: 2048,
    proMaxTokens: 4096,
  },
  deepseek: {
    name: 'DeepSeek',
    maker: 'deepseek',
    logo: 'D',
    tier: 'free',
    cost: 0.004,
    computerCost: 0.012,
    route: 'openrouter',
    orModel: 'deepseek/deepseek-chat',
    blurb: 'DeepSeek through OpenRouter for coding and general work.',
    maxTokens: 2048,
    proMaxTokens: 8192,
  },
};

const LOCAL_MODELS = {
  ollama: {
    name: 'Ollama',
    maker: 'ollama',
    logo: 'O',
    tier: 'free',
    cost: 0,
    computerCost: 0,
    blurb: 'Local model running on your own PC.',
    localOnly: true,
  },
};

const MODEL_ALIASES = {
  'llama-3-3-70b': 'groq',
  'deepseek-v3': 'deepseek',
  'deepseek-r1': 'deepseek',
  'gemini-flash-lite': 'gemini',
  'gemini-flash': 'gemini',
  'gemini-pro': 'gemini',
  'gpt-4o-mini': 'gbt',
  'gpt-4o': 'gbt',
  'gpt-5-1': 'gbt',
  'gpt-5-1-codex': 'gbt',
  'gpt-5-2': 'gbt',
  'o3': 'gbt',
  'o4-mini': 'gbt',
  'claude-haiku': 'claude',
  'claude-sonnet': 'claude',
  'claude-opus': 'claude',
  'claude-fable': 'claude',
  'qwen-flash': 'gbt',
  'qwen-max': 'gbt',
  codestral: 'gbt',
  'mistral-large': 'gbt',
  'rod-1': 'groq',
  'rod-thinking': 'deepseek',
  'rod-brain': 'claude',
  'tex-0': 'deepseek',
  'tex-1-5': 'claude',
  'tex-2': 'gbt',
  'tex-2-5': 'claude',
  'treesearch-q': 'deepseek',
  'ron-1-lite': 'groq',
  'ron-1-hard': 'deepseek',
  'rreas-2-1': 'deepseek',
  'rtrox-cheap': 'claude',
  'rtrox-1-8': 'claude',
  'rtrox-3': 'claude',
  'rtrox-hard': 'claude',
};

const DEFAULT_MODEL_ID = 'gbt';

function resolveModelId(id) {
  if (MODELS[id]) return id;
  if (MODEL_ALIASES[id] && MODELS[MODEL_ALIASES[id]]) return MODEL_ALIASES[id];
  return DEFAULT_MODEL_ID;
}

function publicCatalog() {
  return Object.entries({ ...MODELS, ...LOCAL_MODELS }).map(([id, m]) => ({
    id,
    name: m.name,
    maker: m.maker,
    logo: m.logo,
    tier: m.tier,
    cost: m.cost,
    computerCost: m.computerCost ?? null,
    blurb: m.blurb,
    localOnly: Boolean(m.localOnly),
    best: Boolean(m.best),
  }));
}

module.exports = { MODELS, LOCAL_MODELS, MODEL_ALIASES, DEFAULT_MODEL_ID, resolveModelId, publicCatalog };
