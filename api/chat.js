const AdmZip = require('adm-zip');
const { verifyProPass } = require('./_lib/propass.js');
const { MODELS, resolveModelId } = require('./_lib/catalog.js');
const {
  checkCreditSafety,
  estimateTexTokens,
  insufficientCreditsError,
  logUsage,
  onInsufficientCredits,
} = require('./_lib/credit-safety.js');

// Best-effort abuse protection. In-memory, so it resets on cold starts —
// it stops casual abuse of the open endpoint, not a determined attacker.
const FREE_DAILY_TEXTOKENS = 100_000;
const freeTokenCounters  = new Map();
const proCounters = new Map();
const GROQ_BUSY_TEXT = 'This AI is being used too much. Please use a different AI and go to this one later.';
const OPENROUTER_OUT_TEXT = 'ai is being used to much! please purchase pro to bypass this!';

function _today() { return new Date().toISOString().slice(0, 10); }

function getFreeTokensUsed(key) {
  const e = freeTokenCounters.get(key);
  return (e && e.date === _today()) ? e.used : 0;
}

function addFreeTokensUsed(key, amount) {
  const d = _today();
  const e = freeTokenCounters.get(key);
  if (!e || e.date !== d) {
    freeTokenCounters.set(key, { date: d, used: amount });
    if (freeTokenCounters.size > 5000) freeTokenCounters.clear();
  } else {
    e.used = (e.used || 0) + amount;
  }
}

function bumpCounter(map, key) {
  const d = _today();
  const e = map.get(key);
  if (!e || e.date !== d) {
    map.set(key, { date: d, count: 1 });
    if (map.size > 5000) map.clear();
    return 1;
  }
  e.count += 1;
  return e.count;
}

module.exports = async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (request.method === 'OPTIONS') {
    response.status(204).end();
    return;
  }
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const {
    authToken = '',
    model = 'gbt',
    messages = [],
    computerMode = false,
    computerConnections = [],
    pcBridge = {},
    personality = '',
    attachments = [],
    proPass = '',
    stream = false,
    mode = 'chat',
    agent = false,
    projectContext = '',
    texTokensLeft = null,
    superAgent = false,
  } = request.body || {};

  const authResult = await verifyFirebaseToken(authToken); // optional: logged-in users get cloud sync, guests can still chat

  const proPayload = verifyProPass(proPass);
  const isPro = Boolean(proPayload);

  const modelId = resolveModelId(model);
  const selected = MODELS[modelId];
  const userId = proPayload?.uid || authResult.uid || ipFromRequest(request) || 'unknown';

  // Server-side Pro enforcement - locked models reject without a valid pass.
  if (selected.tier === 'pro' && !isPro) {
    response.status(402).json({
      error: 'pro_required',
      text: `${selected.name} is a Pro model. Go Pro on rrotex.com to unlock it.`,
    });
    return;
  }

  const ip = ipFromRequest(request);

  // TexToken daily budget for free users (100k/day per IP).
  // We pre-deduct the estimate; if the request fails the tokens stay deducted
  // (conservative, prevents abuse via retries).
  if (!isPro) {
    const freeKey = userId !== 'unknown' ? `uid:${userId}` : `ip:${ip}`;
    const usedToday = getFreeTokensUsed(freeKey);
    // We don't have the estimate yet, so do a quick pre-check assuming ~2k min cost
    if (usedToday >= FREE_DAILY_TEXTOKENS) {
      response.status(402).json({
        error: 'no_textokens',
        text: "You've used your 100k free TexTokens for today. Come back tomorrow, or buy more on rrotex.com/tokens.",
      });
      return;
    }
    // Store key on request for post-estimate deduction below
    request._freeKey = freeKey;
  }

  if (!isPro && selected.freeDailyCap) {
    const used = bumpCounter(proCounters, `${ip}:${modelId}`);
    if (used > selected.freeDailyCap) {
      response.status(429).json({
        error: 'rate_limited',
        text: 'You are out of TexTokens. Upgrade to Pro or add more TexTokens to continue.',
      });
      return;
    }
  }

  const maxTokens = isPro ? (selected.proMaxTokens || selected.maxTokens) : selected.maxTokens;
  const isEditor = mode === 'editor';
  const modelGuide = buildModelGuide();
  const cleanAttachments = normalizeAttachments(attachments);
  const hasImages = cleanAttachments.some((item) => item.kind === 'image');
  const connectionStatus = summarizeConnections(computerConnections, pcBridge);
  const perMessageCap = isEditor ? 16000 : 8000;
  const lastMessageCap = isEditor ? 48000 : 16000;
  const cleanMessages = messages
    .filter((message) => message && ['user', 'assistant', 'system'].includes(message.role))
    .slice(isEditor ? -24 : -18)
    .map((message) => ({
      role: message.role,
      content: String(message.text || message.content || '').slice(0, perMessageCap),
    }));
  const lastUser = [...cleanMessages].reverse().find((message) => message.role === 'user');
  if (lastUser) {
    const original = messages
      .filter((message) => message && message.role === 'user')
      .map((message) => String(message.text || message.content || ''))
      .pop() || '';
    lastUser.content = original.slice(0, lastMessageCap);
    if (cleanAttachments.length) {
      lastUser.content = `${lastUser.content}\n\n${attachmentPrompt(cleanAttachments, selected.route === 'anthropic-first')}`.slice(0, lastMessageCap + 16000);
    }
  }

  if (isEditor) {
    cleanMessages.unshift({
      role: 'system',
      content: buildEditorSystemPrompt(selected, agent, projectContext, isPro),
    });
  } else {
    cleanMessages.unshift({
      role: 'system',
      content: [
        'You are a ROTEX web assistant.',
        'Chat naturally. Never answer with a giant capability list, marketing pitch, or "I am your assistant" intro. If asked what you can do, answer in 1-3 casual sentences.',
        'Do not use bold headings like "Main capabilities" or "Current setup" unless the user specifically asks for a formatted list.',
        `ROTEX model lineup: ${modelGuide}`,
        `Current selected model: ${selected.name}. If the user asks which model is best, compare these ROTEX model names only, not provider names.`,
        hasImages && selected.route !== 'anthropic-first' ? `An image-reading backend is reading the attachment for ${selected.name}; still answer as ${selected.name}.` : '',
        'You can create clear Markdown tables when they help compare choices, pricing, limits, plans, or model abilities.',
        'You can write code in fenced Markdown code blocks with the language name so the app can show it cleanly.',
        'You can create multiple downloadable files and folders. For a folder, use file blocks with paths like ```file:project/src/app.js. For binary/image files, use ```file:name.ext;base64 and put only base64 content inside. If the user asks for a zip, create multiple file blocks and the app can zip them together.',
        'If the user asks for a website zip or a bunch of website files, make a sensible starter website immediately unless critical details are missing. Include index.html, styles.css, script.js, README.md, and an images/ folder with SVG images such as images/logo.svg or images/hero.svg when images are requested.',
        'You can make images as SVG files directly. Use paths like ```file:images/hero.svg and write valid SVG markup inside.',
        'If the user uploaded an image or asset and asks for a website/folder/zip, reference that uploaded file in the generated code using its path or an images/assets path. The app will include uploaded assets in the downloadable bundle.',
        'The conversation may include a compact summary of older messages. Treat it as memory and continue from the recent messages.',
        personality ? `Chat style: ${String(personality).slice(0, 700)}.` : '',
        connectionStatus,
        'If the user asks whether GitHub, Google Drive, or another ROTEX connection worked, answer from the ROTEX connection status above. Do not say you cannot check it when that status is provided.',
        'You can generate downloadable files for the user. When asked for any file (code, text, data, etc.), wrap it exactly like this: start with ```file:filename.ext on its own line, then the file contents, then a closing ``` line. The user will see a download button. Always use this format when producing files.',
        'You can read files and images the user attaches in chat when their content is provided. Do not claim you cannot see an attachment that is listed in the prompt.',
        'You cannot directly access, read, or modify files already on the user\'s device unless they attach them or use approved computer-mode connections.',
        computerMode
          ? `Computer mode is on. Before any external-work action, ask the user to connect one of these services: ${Array.isArray(computerConnections) && computerConnections.length ? computerConnections.join(', ') : 'Google Drive or GitHub'}. Do not ask for PC pairing from the website computer-mode picker.`
          : 'Computer mode is off. Do not ask for external service access unless the user explicitly asks about connecting apps.',
      ].filter(Boolean).join(' '),
    });
  }

  const providerCall = resolveProviderCall(selected, hasImages);
  if (!providerCall) {
    response.status(500).json({
      error: 'backend_unavailable',
      text: 'servers are down',
    });
    return;
  }

  const estimate = estimateTexTokens(selected, cleanMessages, maxTokens, { agent, superAgent });

  // Enforce free daily TexToken budget now that we have an accurate estimate.
  if (!isPro && request._freeKey) {
    const usedToday = getFreeTokensUsed(request._freeKey);
    if (usedToday + estimate.textokens > FREE_DAILY_TEXTOKENS) {
      response.status(402).json({
        error: 'no_textokens',
        text: "You've used your 100k free TexTokens for today. Come back tomorrow, or buy more on rrotex.com/tokens.",
      });
      return;
    }
    addFreeTokensUsed(request._freeKey, estimate.textokens);
  }

  const safety = await checkCreditSafety({
    selected,
    provider: providerCall.provider,
    model: selected.providerName || selected.name,
    userId,
    estimate,
    texTokensLeft,
  });
  if (!safety.ok) {
    logUsage({
      user_id: userId,
      model: selected.name,
      input_tokens: estimate.inputTokens,
      output_tokens: 0,
      real_provider_cost: 0,
      textokens_charged: 0,
      status: safety.error,
    });
    response.status(safety.error === 'no_textokens' ? 402 : 503).json({ error: safety.error, text: safety.text });
    return;
  }

  try {
    if (stream) {
      await streamResponse(response, providerCall, cleanMessages, cleanAttachments, selected, maxTokens, {
        userId,
        estimate,
        agent,
        superAgent,
      });
    } else {
      const result = await completeResponse(providerCall, cleanMessages, cleanAttachments, selected, maxTokens, hasImages, {
        userId,
        estimate,
        agent,
        superAgent,
      });
      response.status(200).json({ model: selected.name, text: result.text, usage: result.usage });
    }
  } catch (error) {
    console.error('ROTEX backend provider failed', {
      model: selected.name,
      provider: providerCall.provider,
      message: error?.message || String(error),
    });
    const lowCredit = insufficientCreditsError(error);
    const publicText = error?.publicText || (lowCredit ? 'Too many requests right now. Please retry later or upgrade/add TexTokens.' : 'servers are down');
    const publicError = error?.publicError || (lowCredit ? 'provider_credits_empty' : 'backend_unavailable');
    if (stream && response.headersSent) {
      sseWrite(response, {
        error: publicError,
        text: publicText,
      });
      sseWrite(response, { done: true });
      response.end();
      return;
    }
    if (lowCredit) {
      await onInsufficientCredits({ provider: providerCall.provider, model: selected.name, userId, estimate });
    }
    logUsage({
      user_id: userId,
      model: selected.name,
      input_tokens: estimate.inputTokens,
      output_tokens: 0,
      real_provider_cost: 0,
      textokens_charged: 0,
      status: lowCredit ? 'provider_insufficient_credits' : 'failed',
    });
    response.status(error?.publicStatus || (lowCredit ? 503 : 500)).json({
      error: publicError,
      text: publicText,
    });
  }
};

module.exports.config = { supportsResponseStreaming: true };

function buildEditorSystemPrompt(selected, agent, projectContext, isPro) {
  const parts = [
    'You are ROTEX AI, the coding assistant inside the ROTEX code editor (a VS Code-style editor).',
    `You are running as the ${selected.name} model.`,
    'Be direct and practical. Answer code questions with working code. Keep explanations short and put them after the code.',
    'When showing code changes for a specific file, ALWAYS use a file block: start with ```file:relative/path.ext on its own line, then the COMPLETE new file contents, then a closing ``` line. The editor shows the user a diff and an Apply button for each file block.',
    'Never use placeholder comments like "rest of the code stays the same" inside file blocks — file blocks must contain the complete file.',
    'For small inline snippets that are not meant to replace a file, use normal ```lang code fences instead.',
  ];
  if (agent) {
    parts.push(
      'AGENT MODE is ON. You may propose changes to multiple files in one reply: output one file block per file that needs to change (created, rewritten, or updated).',
      'Before the file blocks, write a one-line plan of what you are changing and why. After the blocks, write at most 2 sentences on how to test.',
      'Use the PROJECT CONTEXT below to keep paths and imports consistent with the real project structure.',
    );
  }
  if (projectContext) {
    parts.push(`PROJECT CONTEXT:\n${String(projectContext).slice(0, isPro ? 24000 : 8000)}`);
  }
  return parts.join('\n');
}

function resolveProviderCall(selected) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const attempts = [];

  if (selected.route === 'groq-only' && groqKey) {
    attempts.push({
      provider: 'groq',
      providerModel: selected.groqModel,
      apiKey: groqKey,
      baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
    });
  }

  if (selected.route === 'anthropic-first' && anthropicKey) {
    attempts.push({
      provider: 'anthropic',
      providerModel: resolveAnthropicModel(selected),
      apiKey: anthropicKey,
    });
  }

  if (openRouterKey && selected.orModel) {
    attempts.push({
      provider: 'openrouter',
      providerModel: selected.orModel,
      apiKey: openRouterKey,
      baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    });
  }

  return attempts.length ? { provider: selected.route, attempts } : null;
}

async function completeResponse(providerCall, cleanMessages, cleanAttachments, selected, maxTokens, hasImages, context) {
  const errors = [];
  for (const attempt of providerCall.attempts) {
    try {
      if (attempt.provider === 'anthropic') {
        const anthropicRequest = {
          apiKey: attempt.apiKey,
          model: attempt.providerModel,
          messages: cleanMessages,
          attachments: cleanAttachments,
          temperature: modelTemperature(selected),
          maxTokens,
        };
        try {
          const result = await callAnthropic(anthropicRequest);
          logProviderUsage(result, selected, context, 'completed');
          return result;
        } catch (imageError) {
          if (!hasImages || !/process image|image/i.test(imageError?.message || '')) {
            throw imageError;
          }
          const result = await callAnthropic({ ...anthropicRequest, attachments: [] });
          logProviderUsage(result, selected, context, 'completed');
          return result;
        }
      }
      const result = await callOpenAiCompatible({
        apiKey: attempt.apiKey,
        baseUrl: attempt.baseUrl,
        model: attempt.providerModel,
        messages: cleanMessages,
        temperature: modelTemperature(selected),
        maxTokens,
      });
      logProviderUsage(result, selected, context, 'completed');
      return result;
    } catch (error) {
      if (attempt.provider === 'anthropic' && insufficientCreditsError(error)) {
        await onInsufficientCredits({
          provider: attempt.provider,
          model: selected.name,
          userId: context.userId,
          estimate: context.estimate,
          reason: 'Anthropic ran out; switching to OpenRouter',
        });
        errors.push(`${attempt.provider}: ${error?.message || error}`);
        continue;
      }
      if (attempt.provider === 'groq' && (insufficientCreditsError(error) || groqBusyError(error))) {
        throw publicProviderError('groq_busy', GROQ_BUSY_TEXT, 429);
      }
      if (attempt.provider === 'openrouter' && insufficientCreditsError(error)) {
        throw publicProviderError('openrouter_credits_empty', OPENROUTER_OUT_TEXT, 503);
      }
      if (insufficientCreditsError(error)) {
        await onInsufficientCredits({
          provider: attempt.provider,
          model: selected.name,
          userId: context.userId,
          estimate: context.estimate,
        });
        throw error;
      }
      errors.push(`${attempt.provider}: ${error?.message || error}`);
    }
  }
  throw new Error(errors.join('\n') || 'All providers failed');
}

// ─── Streaming ────────────────────────────────────────────────────────

function sseWrite(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function streamResponse(response, providerCall, cleanMessages, cleanAttachments, selected, maxTokens, context) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  sseWrite(response, { model: selected.name });

  const errors = [];
  for (const attempt of providerCall.attempts) {
    try {
      if (attempt.provider === 'anthropic') {
        await streamAnthropic(response, attempt, cleanMessages, cleanAttachments, selected, maxTokens);
      } else {
        await streamOpenAiCompatible(response, attempt, cleanMessages, selected, maxTokens);
      }
      logUsage({
        user_id: context.userId,
        model: selected.name,
        input_tokens: context.estimate.inputTokens,
        output_tokens: context.estimate.outputTokens,
        real_provider_cost: context.estimate.providerCostUsd,
        textokens_charged: context.estimate.textokens,
        status: 'completed_stream_estimate',
      });
      sseWrite(response, { done: true });
      response.end();
      return;
    } catch (error) {
      if (attempt.provider === 'anthropic' && insufficientCreditsError(error)) {
        await onInsufficientCredits({
          provider: attempt.provider,
          model: selected.name,
          userId: context.userId,
          estimate: context.estimate,
          reason: 'Anthropic ran out; switching to OpenRouter',
        });
        errors.push(`${attempt.provider}: ${error?.message || error}`);
        continue;
      }
      if (attempt.provider === 'groq' && (insufficientCreditsError(error) || groqBusyError(error))) {
        throw publicProviderError('groq_busy', GROQ_BUSY_TEXT, 429);
      }
      if (attempt.provider === 'openrouter' && insufficientCreditsError(error)) {
        throw publicProviderError('openrouter_credits_empty', OPENROUTER_OUT_TEXT, 503);
      }
      if (insufficientCreditsError(error)) {
        await onInsufficientCredits({
          provider: attempt.provider,
          model: selected.name,
          userId: context.userId,
          estimate: context.estimate,
        });
        throw error;
      }
      errors.push(`${attempt.provider}: ${error?.message || error}`);
    }
  }

  throw new Error(errors.join('\n') || 'All providers failed');
}

function modelTemperature(selected) {
  return selected.temperature ?? 0.45;
}

function groqBusyError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return /rate.?limit|too many|overloaded|capacity|temporarily unavailable|try again|429|503|requests per minute|tokens per minute/.test(text);
}

function publicProviderError(code, text, status = 503) {
  const error = new Error(text);
  error.publicError = code;
  error.publicText = text;
  error.publicStatus = status;
  return error;
}

function ipFromRequest(request) {
  return String(request.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

function resolveAnthropicModel(selected) {
  return (selected.envModel && process.env[selected.envModel]) || selected.anthropicModel;
}

async function streamOpenAiCompatible(response, providerCall, messages, selected, maxTokens) {
  const providerResponse = await fetch(providerCall.baseUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${providerCall.apiKey}`,
      'Content-Type': 'application/json',
      ...(providerCall.provider === 'openrouter' ? openRouterHeaders() : {}),
    },
    body: JSON.stringify({
      model: providerCall.providerModel,
      messages,
      temperature: modelTemperature(selected),
      max_tokens: maxTokens,
      stream: true,
    }),
  });
  if (!providerResponse.ok) {
    throw new Error(await providerResponse.text());
  }

  for await (const event of readSseEvents(providerResponse.body)) {
    if (event === '[DONE]') break;
    try {
      const parsed = JSON.parse(event);
      const delta = parsed.choices?.[0]?.delta?.content;
      if (delta) sseWrite(response, { d: delta });
    } catch { /* ignore malformed keep-alive chunks */ }
  }
}

async function streamAnthropic(response, providerCall, messages, attachments, selected, maxTokens) {
  const body = buildAnthropicBody(providerCall.providerModel, messages, attachments, modelTemperature(selected), maxTokens);
  body.stream = true;

  const providerResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': providerCall.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!providerResponse.ok) {
    throw new Error(await providerResponse.text());
  }

  for await (const event of readSseEvents(providerResponse.body)) {
    try {
      const parsed = JSON.parse(event);
      if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
        sseWrite(response, { d: parsed.delta.text });
      }
      if (parsed.type === 'error') {
        throw new Error(parsed.error?.message || 'Anthropic stream error');
      }
    } catch (err) {
      if (err instanceof SyntaxError) continue; // partial/non-JSON line
      throw err;
    }
  }
}

// Parses an upstream SSE byte stream and yields each `data:` payload string.
async function* readSseEvents(bodyStream) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of bodyStream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) {
        yield trimmed.slice(5).trim();
      }
    }
  }
}

// ─── Shared helpers (attachments, prompts, providers) ────────────────

function buildModelGuide() {
  return Object.values(MODELS)
    .map((item) => `${item.name}: ${item.blurb}`)
    .join('; ');
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
      return `${base}: ${canReadImages ? 'image attached for visual reading.' : 'image attached, and the app will include it as an asset.'} Suggested bundle path: images/${safeAssetName(item.name)}.`;
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

function safeAssetName(name) {
  return String(name || 'image.png').replace(/[<>:"/\\|?*]/g, '-').slice(0, 80);
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
  const services = ['Google Drive', 'GitHub'];
  const connected = Array.isArray(computerConnections)
    ? [...new Set(computerConnections.filter((item) => services.includes(item)))]
    : [];
  const missing = services.filter((service) => !connected.includes(service));
  return [
    `ROTEX connection status: connected services: ${connected.length ? connected.join(', ') : 'none'}.`,
    `Not connected: ${missing.length ? missing.join(', ') : 'none'}.`,
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
      ...(baseUrl && baseUrl.includes('openrouter.ai') ? openRouterHeaders() : {}),
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
  return {
    text: data.choices?.[0]?.message?.content || 'No response text returned.',
    usage: {
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0,
    },
  };
}

function openRouterHeaders() {
  return {
    'HTTP-Referer': process.env.PUBLIC_SITE_URL || 'https://www.rrotex.com',
    'X-Title': 'ROTEX',
  };
}

function buildAnthropicBody(model, messages, attachments, temperature, maxTokens) {
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
  const imageParts = (attachments || [])
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
  // These models reject sampling params (temperature/top_p/top_k) with a 400.
  if (!/fable-5|opus-4-8|opus-4-7|opus-4-6|sonnet-4-6/.test(model)) {
    body.temperature = temperature;
  }
  return body;
}

async function callAnthropic({ apiKey, model, messages, attachments = [], temperature = 0.7, maxTokens = 900 }) {
  if (!apiKey) {
    throw new Error('Missing Anthropic key');
  }

  const body = buildAnthropicBody(model, messages, attachments, temperature, maxTokens);

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
  const text = Array.isArray(data.content)
    ? data.content.map((part) => part.text || '').join('').trim()
    : 'No response text returned.';
  return {
    text,
    usage: {
      inputTokens: data.usage?.input_tokens || 0,
      outputTokens: data.usage?.output_tokens || 0,
    },
  };
}

function logProviderUsage(result, selected, context, status) {
  const inputTokens = result.usage?.inputTokens || context.estimate.inputTokens;
  const outputTokens = result.usage?.outputTokens || context.estimate.outputTokens;
  let charged = (
    inputTokens * (selected.inputTexTokens || 1)
    + outputTokens * (selected.outputTexTokens || 1)
  ) * (selected.multiplier || 1);
  if (context.agent) charged *= 2;
  if (context.superAgent) charged *= 4;
  logUsage({
    user_id: context.userId,
    model: selected.name,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    real_provider_cost: charged / 1000000,
    textokens_charged: charged,
    status,
  });
}
