const AdmZip = require('adm-zip');
const { verifyProPass, signProPass } = require('./_lib/propass.js');
const { MODELS, resolveModelId } = require('./_lib/catalog.js');
const { userHasActiveProSubscription } = require('./_lib/stripe.js');
const {
  checkCreditSafety,
  estimateTexTokens,
  insufficientCreditsError,
  logUsage,
  onInsufficientCredits,
} = require('./_lib/credit-safety.js');
// ── Server-authoritative usage (Firestore, inlined to stay under Vercel's
// function limit). Stored at users/{uid}/billing/usage, written with the user's
// own ID token. Fail-open: any failure returns null and the caller falls back
// to the in-memory limiter.
const FREE_MONTHLY = 1_000_000;
const PRO_MONTHLY  = 20_000_000;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'rotex-e0be7';
function _usageDocUrl(uid) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(FIREBASE_PROJECT_ID)}/databases/(default)/documents/users/${encodeURIComponent(uid)}/billing/usage`;
}
function _fsNum(field) { if (!field) return 0; return Math.max(0, Math.floor(Number(field.integerValue ?? field.doubleValue ?? 0) || 0)); }
function _fsStr(field) { return field?.stringValue || ''; }
function _dayKey()   { return new Date().toISOString().slice(0, 10); }
function _monthKey() { return new Date().toISOString().slice(0, 7); }
async function readUsage(uid, authToken) {
  if (!uid || !authToken || !FIREBASE_PROJECT_ID) return null;
  try {
    const res = await fetch(_usageDocUrl(uid), { headers: { Authorization: `Bearer ${authToken}` } });
    if (res.status === 404) return { dayUsed: 0, monthUsed: 0 };
    if (!res.ok) return null;
    const doc = await res.json();
    const f = doc.fields || {};
    return {
      dayUsed:   _fsStr(f.dayKey)   === _dayKey()   ? _fsNum(f.dayUsed)   : 0,
      monthUsed: _fsStr(f.monthKey) === _monthKey() ? _fsNum(f.monthUsed) : 0,
    };
  } catch { return null; }
}
async function addUsage(uid, authToken, amount) {
  if (!uid || !authToken || !FIREBASE_PROJECT_ID || !(amount > 0)) return;
  try {
    const cur = (await readUsage(uid, authToken)) || { dayUsed: 0, monthUsed: 0 };
    const body = { fields: {
      dayKey:    { stringValue: _dayKey() },
      dayUsed:   { integerValue: String(cur.dayUsed + amount) },
      monthKey:  { stringValue: _monthKey() },
      monthUsed: { integerValue: String(cur.monthUsed + amount) },
      updatedAt: { timestampValue: new Date().toISOString() },
    } };
    const mask = ['dayKey', 'dayUsed', 'monthKey', 'monthUsed', 'updatedAt'].map((k) => 'updateMask.fieldPaths=' + k).join('&');
    await fetch(`${_usageDocUrl(uid)}?${mask}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch { /* fail-open */ }
}

// Best-effort abuse protection. In-memory, so it resets on cold starts —
// it stops casual abuse of the open endpoint, not a determined attacker.
const FREE_DAILY_TEXTOKENS = 150_000;
const freeTokenCounters  = new Map();
const proCounters = new Map();

// Multi-account detection — tracks IP → Set<uid> and normalizedEmail → firstUid.
// Prevents users from making multiple accounts to farm free TexTokens.
const ipUidRegistry    = new Map(); // `${ip}:${date}` → Set<uid>
const emailUidRegistry = new Map(); // `${normalizedEmail}:${date}` → uid

function normalizeGmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return '';
  const lower = email.toLowerCase();
  const at = lower.lastIndexOf('@');
  const domain = lower.slice(at + 1);
  const local  = lower.slice(0, at);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return local.split('+')[0].replace(/\./g, '') + '@gmail.com';
  }
  return lower;
}

// Returns true if this request looks like a multi-account abuse attempt.
function isMultiAccount(ip, uid, email) {
  // Only fire for authenticated users (uid !== ip means they have a real Firebase UID)
  if (!uid || uid === 'unknown' || uid === ip) return false;
  const d = _today();

  // 1) Email normalization check (Gmail dot/plus tricks)
  const norm = normalizeGmail(email);
  if (norm) {
    const eKey = `${norm}:${d}`;
    const firstUid = emailUidRegistry.get(eKey);
    if (!firstUid) {
      emailUidRegistry.set(eKey, uid);
      if (emailUidRegistry.size > 5000) emailUidRegistry.clear();
    } else if (firstUid !== uid) {
      return true; // same Gmail base address, different account
    }
  }

  // 2) IP multi-account check (same IP, 2+ distinct Firebase UIDs today)
  const iKey = `${ip}:${d}`;
  let uidSet = ipUidRegistry.get(iKey);
  if (!uidSet) {
    uidSet = new Set();
    ipUidRegistry.set(iKey, uidSet);
    if (ipUidRegistry.size > 3000) ipUidRegistry.clear();
  }
  uidSet.add(uid);
  return uidSet.size > 1; // two or more accounts on the same IP today
}
const GROQ_BUSY_TEXT = 'That model is busy right now. Try TexBrain Thinking-beta or Claude Haiku while it cools down.';
const OPENROUTER_OUT_TEXT = 'AI is busy right now. Please retry in a few seconds.';

function _today() { return new Date().toISOString().slice(0, 10); }

function noTokensText(proPass, isPro, hasPurchased) {
  if (proPass && !isPro) {
    return "Your Pro pass could not be verified. Please sign out and back in, or refresh your Pro subscription at rrotex.com/pro.";
  }
  if (hasPurchased) {
    return "You've used all your TexTokens for today. Buy more at rrotex.com/tokens.";
  }
  return "You've used your 150k free TexTokens daily limit. Come back tomorrow, or buy more at rrotex.com/tokens.";
}

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

// ── Request-frequency limiter (anti-spam) ───────────────────────────────────
// Throttles rapid-fire requests per IP, independent of the TexToken budget.
// Two windows: a short burst guard and a per-minute cap. In-memory, so it
// resets on cold starts, but it blocks sustained hammering on a warm instance.
const reqWindows = new Map(); // ip → number[] of request timestamps (ms)
const REQ_PER_MIN = 30;          // max requests in a rolling 60s window
const REQ_BURST = 8;             // max requests in a rolling 10s window
const REQ_BURST_WINDOW = 10_000;

function checkRequestRate(ip, opts = {}) {
  const now = Date.now();
  let arr = reqWindows.get(ip);
  if (!arr) {
    arr = [];
    reqWindows.set(ip, arr);
    if (reqWindows.size > 5000) reqWindows.clear();
  }
  while (arr.length && now - arr[0] > 60_000) arr.shift(); // drop entries >60s old
  const burstLimit = opts.dev ? 80 : opts.relaxed ? 28 : REQ_BURST;
  const minuteLimit = opts.dev ? 240 : opts.relaxed ? 90 : REQ_PER_MIN;
  const inBurst = arr.reduce((c, t) => c + (now - t < REQ_BURST_WINDOW ? 1 : 0), 0);
  if (inBurst >= burstLimit) {
    return { ok: false, retry: Math.ceil(REQ_BURST_WINDOW / 1000) };
  }
  if (arr.length >= minuteLimit) {
    return { ok: false, retry: Math.max(1, Math.ceil((60_000 - (now - arr[0])) / 1000)) };
  }
  arr.push(now);
  return { ok: true };
}

// ── TexBrain handler (inlined here to stay under Vercel's 12-function limit) ──
// Strips BOM / non-printable-ASCII and surrounding quotes/whitespace from an API
// key. A leading BOM (U+FEFF) in an env var makes the HTTP Authorization header
// throw "Cannot convert argument to a ByteString".
function cleanKey(v) {
  return String(v || '').replace(/[^\x21-\x7E]/g, '').replace(/^['"]|['"]$/g, '');
}
const OR_KEY = cleanKey(process.env.OPENROUTER_API_KEY);
const TB_MAX_CONCURRENT = 5;
let tbActiveCalls = 0;

function tbVerifyToken(authToken) {
  if (!authToken || typeof authToken !== 'string') return { ok: false };
  try {
    // Firebase ID tokens: iss = https://securetoken.google.com/<projectId>,
    // aud = <projectId>, sub = uid. The previous check required iss to contain
    // "firebase" — which a real Firebase token never does — so it rejected
    // everyone. Decode as base64url (JWT payloads use base64url).
    const payload = JSON.parse(Buffer.from(authToken.split('.')[1] || '', 'base64url').toString('utf8'));
    if (!payload.sub) return { ok: false };
    const iss = String(payload.iss || '');
    if (!iss.includes('securetoken.google.com') && !iss.includes('firebase')) return { ok: false };
    return { ok: true, uid: payload.sub };
  } catch { return { ok: false }; }
}

function tbBuildSystemPrompt(projectMode, mode) {
  const engineGuides = {
    Roblox: `SPECIALTY: Roblox game development — Luau scripting, LocalScript/Script/ModuleScript, RemoteEvents, RemoteFunctions, DataStoreService, TweenService, RunService, and Roblox Studio.\n\nKEY RULES FOR ROBLOX:\n- Use task.wait(n) NOT wait(n). Use task.spawn() NOT spawn(). Use task.delay() NOT delay().\n- RemoteEvents MUST be created by a server Script first; LocalScripts use :WaitForChild("EventName", 10) to find them.\n- Always use :WaitForChild("Name", 10) with a timeout before accessing cross-script instances.\n- Wrap every DataStore call in pcall.\n- LocalScripts CANNOT access ServerScriptService. Use ReplicatedStorage for shared assets.\n- game.Players.LocalPlayer is nil on the server — only use it inside LocalScripts.\n- Touched fires constantly — debounce with a table keyed by player.\n- Character loads async; use player.CharacterAdded:Wait() before accessing the character.\n- Use Humanoid:TakeDamage(amount) not Humanoid.Health = 0.\n- Always :Disconnect() connections when done.\n\nFor casual or off-topic messages, respond naturally in 1-2 sentences without code.`,
    Unity: 'SPECIALTY: Unity game development — C# scripting, MonoBehaviour lifecycle, Unity APIs, GameObjects, Rigidbody physics, Animator, NavMeshAgent, Input System, TextMeshPro. Cache GetComponent in Awake. Use Coroutines for async sequences. Never hallucinate Unity APIs.',
    Blender: 'SPECIALTY: Blender 3D — Python/bpy scripting, modeling, geometry nodes, shaders (Cycles/EEVEE), rigging, animation, and rendering. Use bpy.data over bpy.ops. bmesh for geometry editing.',
    'Roblox+Blender': 'SPECIALTY: Roblox game development (Luau) and Blender 3D (bpy) for creating assets for Roblox games. Same Roblox rules apply. For Blender: apply transforms before FBX export, Y-up, FBX Units Scale.',
    'Unity+Blender': 'SPECIALTY: Unity (C#) and Blender 3D (bpy) for creating assets for Unity projects. Apply all transforms in Blender before export. Normal maps from Blender are OpenGL; Unity needs DirectX — flip the G channel.',
  };
  const engineFocus = engineGuides[(projectMode || 'Roblox').trim()] || engineGuides['Roblox'];
  const modeInstructions = {
    agent: 'AGENT MODE: Output the smallest complete fix. Every code change MUST be in a ```file:ServiceName/path/ScriptName.lua block.',
    supreme: 'SUPER AGENT MODE: Deeper multi-step edits. Every code change MUST be in a ```file:ServiceName/path/ScriptName.lua block.',
  };
  const codeInstruction = (mode === 'agent' || mode === 'supreme')
    ? `MANDATORY OUTPUT RULE: You MUST output a \`\`\`file:ServiceName/ScriptName.lua code block for EVERY change. No exceptions. Do NOT say "here is the code", "you can add", "I would modify" — just output the block. If you write prose instead of a file block, you have failed. The file block IS the output.`
    : `OUTPUT RULE: When writing or modifying any script, ALWAYS output it inside a \`\`\`file:ServiceName/ScriptName.lua block. Never show code outside a file block. Never say "paste this" or "add this" — output the block directly.`;
  return [
    'You are TexBrain, a senior Roblox game developer AI inside the ROTEX desktop app. You write complete, production-quality Luau code and apply it directly to Roblox Studio.',
    engineFocus,
    codeInstruction,
    'STUDIO LIVE APPLY: File blocks are INSTANTLY written to the open Roblox Studio project. The user never copies anything. Output the block = it gets applied.',
    'You receive live project context in system messages (script paths, script source, selected objects). Use the EXACT paths from context when modifying existing scripts.',
    'RESPONSE FORMAT: One short sentence describing the change, then the file block(s). Nothing else. No bullet points, no step-by-step explanations, no "Note:" sections.',
    'GREETINGS / QUESTIONS ONLY: If the user is just chatting or asking a question with no code needed, reply in 1-2 sentences. No file block.',
    engineFocus.includes('Roblox') ? 'ROBLOX RULES: task.wait/task.spawn/task.delay (never deprecated versions). RemoteEvents created server-side first. WaitForChild with timeout. pcall on DataStore. Debounce Touched. Disconnect connections when done. LocalPlayer only in LocalScripts.' : '',
    'MODIFY RULE: If the script already exists in project context, output the COMPLETE modified file at the SAME path. Do not output a partial snippet.',
    'PATH FORMAT: ServiceName/ScriptName.lua — e.g. ServerScriptService/MyScript.lua, StarterPlayer/StarterPlayerScripts/ClientUI.lua, ReplicatedStorage/Modules/Utils.lua',
    'FILE BLOCK FORMAT (only valid format):\n```file:ServerScriptService/Example.lua\n-- full script here\n```',
    'COMPLETENESS: Every file block must be a full, runnable script. Zero placeholders. Zero "-- your code here". Zero "-- etc".',
    modeInstructions[mode] || '',
  ].filter(Boolean).join('\n');
}

const GROQ_KEY = cleanKey(process.env.GROQ_API_KEY);

async function tbGroqPost(model, messages, maxTokens, timeoutMs = 30000) {
  const postData = JSON.stringify({ model, messages, temperature: 0.1, max_tokens: maxTokens || 8192, stream: false });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      body: postData,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Groq HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

async function tbOrPost(endpoint, body) {
  const postData = JSON.stringify(body);
  const res = await fetch(`https://openrouter.ai/api/v1${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OR_KEY}`,
      'HTTP-Referer': 'https://rrotex.com',
      'X-Title': 'ROTEX TexBrain',
    },
    body: postData,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// If the model returned plain ```lua blocks (ignoring the file: format instruction),
// try to infer the correct path from context and upgrade them to ```file: blocks.
function tbFixPlainLuaBlocks(text, contextMsgs, lastUserMsg) {
  // Already has a file: block — nothing to fix
  if (/```file:/.test(text)) return text;
  // No code block at all — nothing to fix
  if (!/```(?:lua|luau)?\s*\n/.test(text)) return text;

  // Extract script paths mentioned in context system messages
  const contextText = contextMsgs.map(m => String(m.content || '')).join('\n');
  const pathMatches = [];
  // Match patterns like "StarterPlayer/StarterPlayerScripts/Stamina.lua" or "ServerScriptService/Stamina"
  const pathRe = /\b((?:ServerScriptService|ReplicatedStorage|StarterPlayer\/StarterPlayerScripts|StarterPlayer\/StarterCharacterScripts|StarterGui|Workspace|ServerStorage|StarterPack)\/[\w/]+(?:\.lua|\.luau)?)/g;
  let m;
  while ((m = pathRe.exec(contextText)) !== null) pathMatches.push(m[1]);

  // Also check the user message for explicit script names
  const userPathMatch = lastUserMsg.match(/\b((?:ServerScriptService|ReplicatedStorage|StarterPlayer|StarterGui|Workspace|ServerStorage)\/[\w/]+(?:\.lua)?)/);
  if (userPathMatch) pathMatches.unshift(userPathMatch[1]);

  // Pick the best candidate — prefer the one most relevant to the user's request
  let inferredPath = pathMatches[0] || null;

  // If no path found from context, try to infer from script name mentioned in text or user msg
  if (!inferredPath) {
    // Match compound names like "StaminaSystem", "JumpScript", etc.
    const compoundMatch = text.match(/(?:script|Script)\s+[`"']?([\w]+(?:Script|Handler|System|UI|Controller|Bar|Manager|GUI)?)[`"']?/i)
      || lastUserMsg.match(/\b([\w]+(?:Script|Handler|System|UI|Controller|Bar|Manager|GUI|Stamina|Jump|Movement|Player|Leaderboard|Shop|Inventory|Health|Quest|Chat|Kill|Kill|Spawn|Weapon|Tool)[\w]*)\b/i);
    if (compoundMatch) {
      const name = compoundMatch[1];
      const isLocal = /UI|Client|Player|Stamina|Jump|Camera|Input|Bar|GUI|Inventory|Shop|Health/i.test(name);
      const service = isLocal ? 'StarterPlayer/StarterPlayerScripts' : 'ServerScriptService';
      inferredPath = `${service}/${name}.lua`;
    }
  }

  // Last resort: extract any noun phrase from "make/create/add/build a <name>" pattern
  if (!inferredPath) {
    const makeMatch = lastUserMsg.match(/(?:make|create|add|build|write|give me)\s+(?:a\s+|an\s+)?([a-z][\w\s]{1,30}?)(?:\s+script|\s+system|\s+ui|\s+bar|\s+gui|\s+leaderboard)?(?:\s+for|\s+that|\s+which|$)/i);
    if (makeMatch) {
      const rawName = makeMatch[1].trim().replace(/\s+/g, '');
      const Name = rawName.charAt(0).toUpperCase() + rawName.slice(1);
      const isLocal = /stamina|health|bar|gui|ui|shop|inventory|camera|client|jump|sprint|speed/i.test(rawName);
      const service = isLocal ? 'StarterPlayer/StarterPlayerScripts' : 'ServerScriptService';
      inferredPath = `${service}/${Name}.lua`;
    }
  }

  if (!inferredPath) return text; // can't infer — leave as-is

  // Ensure path has .lua extension
  if (!/\.(lua|luau)$/.test(inferredPath)) inferredPath += '.lua';

  // Replace plain ```lua / ```luau / ``` code blocks with ```file: blocks
  let count = 0;
  const fixed = text.replace(/```(?:lua|luau)?\s*\n([\s\S]*?)```/g, (_, code) => {
    const path = count === 0 ? inferredPath : inferredPath.replace(/\.lua$/, `_${count}.lua`);
    count++;
    return '```file:' + path + '\n' + code + '```';
  });
  return fixed;
}

async function handleTexBrain(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }

  const { authToken, messages = [], projectMode = 'Roblox', mode = '' } = req.body || {};
  if (!tbVerifyToken(authToken).ok) { res.status(401).json({ error: 'Please sign in to use TexBrain.' }); return; }
  if (!OR_KEY) { res.status(500).json({ error: 'TexBrain is not configured.' }); return; }
  if (tbActiveCalls >= TB_MAX_CONCURRENT) { res.status(429).json({ error: 'Too many people are using TexBrain right now (beta). Try again in a moment!' }); return; }

  tbActiveCalls++;
  try {
    const normalized = (messages || []).map(m => ({
      role: m.role,
      content: Array.isArray(m.content) ? m.content.filter(p => p.type === 'text').map(p => p.text).join('\n') : (m.content || ''),
    }));
    // Pass ALL system messages as context (project scripts, studio state, etc.)
    const contextMsgs = normalized.filter(m => m.role === 'system').slice(-3);
    const history = normalized.filter(m => m.role !== 'system').slice(-10);
    const lastUserMsg = history.filter(m => m.role === 'user').slice(-1)[0]?.content || '';

    const workerMessages = [
      { role: 'system', content: tbBuildSystemPrompt(projectMode, mode) },
      ...contextMsgs,
      ...history,
    ];

    const MAVERICK = 'meta-llama/llama-4-maverick-17b-128e-instruct';
    const FAST = 'llama-3.3-70b-versatile';
    const isCodeMode = mode === 'agent' || mode === 'supreme';
    // A response is "usable" in code mode only if it actually contains code to apply.
    const hasCodeBlock = (t) => /```\s*file:/i.test(t) || /```(?:lua|luau)\b/i.test(t);

    let text = '', usedModel = 'groq/' + FAST;

    // 1. Try Groq. In code mode, lead with the smarter Maverick (it reliably emits
    //    ```file: blocks); weak/fast 3.3-70b often replies with prose-only and nothing
    //    gets applied. In plain chat, lead with the fast 3.3-70b.
    if (GROQ_KEY) {
      const groqCandidates = isCodeMode
        ? [
            { model: MAVERICK, timeout: 45000 },
            { model: FAST, timeout: 22000 },
          ]
        : [
            { model: FAST, timeout: 25000 },
            { model: MAVERICK, timeout: 40000 },
          ];
      for (const { model: gm, timeout } of groqCandidates) {
        try {
          const result = await tbGroqPost(gm, workerMessages, 8192, timeout);
          const t = result.choices?.[0]?.message?.content?.trim();
          if (t) {
            text = t; usedModel = 'groq/' + gm;
            // In code mode keep trying a smarter model if we only got prose.
            if (!isCodeMode || hasCodeBlock(t)) break;
          }
        } catch (e) { /* try next */ }
      }
    }

    // 2. OpenRouter free models as fallback
    if (!text && OR_KEY) {
      const candidates = [
        'meta-llama/llama-3.3-70b-instruct:free',
        'qwen/qwen3-coder:free',
        'openai/gpt-oss-120b:free',
        'nvidia/nemotron-3-super-120b-a12b:free',
      ];
      for (const m of candidates) {
        try {
          const result = await tbOrPost('/chat/completions', { model: m, temperature: 0.15, top_p: 0.9, max_tokens: 4096, messages: workerMessages });
          const t = result.choices?.[0]?.message?.content?.trim();
          if (t) { text = t; usedModel = m; if (!isCodeMode || hasCodeBlock(t)) break; }
        } catch (e) { /* try next */ }
      }
    }
    if (!text) {
      res.status(503).json({ error: 'TexBrain models are busy right now. Try again in a moment, or use Claude Haiku.' });
      return;
    }

    // 3. Code mode but the model still only described the change (no code block at all)?
    //    Force ONE explicit retry that demands ONLY the file block. This is the exact
    //    failure the user hit ("Adding a stamina bar..." with no script).
    if (GROQ_KEY && isCodeMode && !hasCodeBlock(text)) {
      try {
        const retryMessages = [
          ...workerMessages,
          { role: 'assistant', content: text },
          { role: 'user', content: 'You described the change but output NO code. Now output ONLY the complete ```file:Service/Name.lua code block(s) with the full working script inside. No prose, no explanation — just the file block(s).' },
        ];
        const result = await tbGroqPost(MAVERICK, retryMessages, 8192, 38000);
        const t = result.choices?.[0]?.message?.content?.trim();
        if (t && hasCodeBlock(t)) {
          // Keep the original one-line description, then the forced code block(s).
          text = text + '\n\n' + t;
          usedModel += '+retry';
        }
      } catch (e) { /* keep original text */ }
    }

    // Normalize: strip spaces after "file:" that some models insert (```file: Path → ```file:Path)
    text = text.replace(/```\s*file:\s+/g, '```file:');

    // Post-process: if the model used plain ```lua blocks instead of ```file: blocks,
    // infer the script path from context and rewrite them so the client can apply them.
    text = tbFixPlainLuaBlocks(text, contextMsgs, lastUserMsg);

    // Estimate token cost so the client can deduct TexTokens accurately
    const tbCost = Math.max(1, Math.ceil((text.length + lastUserMsg.length) / 400));
    res.status(200).json({ text, model: usedModel, usage: { textokens_charged: tbCost } });
  } catch (err) {
    res.status(500).json({ error: `TexBrain error: ${err.message}` });
  } finally {
    tbActiveCalls--;
  }
}

async function handleBillingSync(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { uid = '', authToken = '', localBalance = null } = req.body || {};
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) { res.status(200).json({ ok: false, error: 'firebase_not_configured' }); return; }

  // Verify token (lightweight decode)
  let tokenUid = '';
  try {
    const payload = JSON.parse(Buffer.from(authToken.split('.')[1], 'base64').toString());
    tokenUid = payload.sub || '';
  } catch {}
  if (!tokenUid || tokenUid !== uid) { res.status(401).json({ ok: false, error: 'auth_expired', message: 'Sign in again to sync billing.' }); return; }

  const docUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/users/${encodeURIComponent(uid)}/billing/textokens`;
  let cloudBalance = 0;
  const getRes = await fetch(docUrl, { headers: { Authorization: `Bearer ${authToken}` } });
  if (getRes.ok) {
    const doc = await getRes.json();
    const f = doc.fields?.balance;
    cloudBalance = Math.max(0, Math.floor(Number(f?.integerValue ?? f?.doubleValue ?? 0) || 0));
  } else if (getRes.status !== 404) {
    const err = await getRes.json().catch(() => ({}));
    res.status(getRes.status).json({ ok: false, error: 'firestore_read_failed', message: err.error?.message || 'Could not read billing balance.' });
    return;
  }

  const local = Math.max(0, Math.floor(Number(localBalance) || 0));
  const best = Math.max(cloudBalance, local);
  if (best > cloudBalance) {
    await fetch(`${docUrl}?updateMask.fieldPaths=balance&updateMask.fieldPaths=updatedAt`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { balance: { integerValue: String(best) }, updatedAt: { timestampValue: new Date().toISOString() } } }),
    }).catch(() => {});
  }
  res.status(200).json({ ok: true, balance: best, cloudBalance });
}

module.exports = async function handler(request, response) {
  // Route sub-paths to inlined handlers (keeps under Vercel's 12-function limit)
  if (request.url && request.url.includes('/texbrain')) {
    return handleTexBrain(request, response);
  }
  if (request.url && request.url.includes('/billing-sync')) {
    return handleBillingSync(request, response);
  }

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

  const ip = ipFromRequest(request) || 'unknown';

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
    projectMode = '',
    texTokensLeft = null,
    superAgent = false,
  } = request.body || {};

  const modelId = resolveModelId(model);
  const selected = MODELS[modelId];
  let proPayload = verifyProPass(proPass);
  const quickClaim = _decodeJwtPayload(authToken);
  const quickIsDev = quickClaim?.email === 'rayf24241@gmail.com';
  const relaxedRate = selected.route === 'tb-thinking' || quickIsDev || Boolean(proPayload);
  const rate = checkRequestRate(ip, { relaxed: relaxedRate, dev: quickIsDev });
  if (!rate.ok) {
    response.setHeader('Retry-After', String(rate.retry));
    response.status(429).json({
      error: 'rate_limited',
      text: `Slow down — too many requests. Try again in ${rate.retry}s.`,
    });
    return;
  }

  const authResult = await verifyFirebaseToken(authToken); // optional: logged-in users get cloud sync, guests can still chat

  let isPro = Boolean(proPayload);

  // If the signed Pro pass is stale/invalid, fall back to Stripe verification for
  // authenticated users. This handles secret rotations or passes signed in a
  // different environment without breaking legitimate Pro users.
  if (!isPro && authResult.ok) {
    const hasSubscription = await userHasActiveProSubscription(authResult.uid, authResult.email, '');
    if (hasSubscription) {
      isPro = true;
    }
  }

  // Emergency fallback: if the Pro pass signature is invalid but the payload still
  // decodes to a UID with an active Stripe subscription, trust the subscription.
  // This is a temporary safety net for existing users whose pass was signed with a
  // rotated or different PRO_PASS_SECRET. It does not grant Pro access to arbitrary
  // UIDs — the UID must have an active Stripe subscription.
  if (!isPro && proPass) {
    try {
      const body = proPass.split('.', 2)[0];
      const decodedPayload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (decodedPayload?.uid) {
        const hasSubscription = await userHasActiveProSubscription(decodedPayload.uid, '', '');
        if (hasSubscription) {
          isPro = true;
        }
      }
    } catch {}
  }

  const userId = proPayload?.uid || authResult.uid || ipFromRequest(request) || 'unknown';
  const userEmail = authResult.email || '';
  // Dev recognition. The normal path uses the verified (unexpired) token email.
  // Fallback: if the token is expired but its EMAIL claim is the dev's, verify the
  // token's cryptographic signature (ignoring expiry) so the dev stays free even
  // on a stale token, with no re-login. A forged token fails the signature check.
  let isDev = userEmail === 'rayf24241@gmail.com';
  if (!isDev && authToken) {
    const claim = _decodeJwtPayload(authToken);
    if (claim && claim.email === 'rayf24241@gmail.com') {
      isDev = await verifyDevTokenSignature(authToken);
    }
  }

  // Server-side Pro enforcement - locked models reject without a valid pass.
  if (selected.tier === 'pro' && !isPro && !isDev) {
    response.status(402).json({
      error: 'pro_required',
      text: `${selected.name} is a Pro model. Go Pro on rrotex.com to unlock it.`,
    });
    return;
  }

  // Multi-account: free alt accounts get 0 tokens. Pro accounts are unaffected.
  const linkedMultiAccount = !isDev && isMultiAccount(ip, userId, userEmail);

  // ── Server-authoritative usage (Firestore, persists across cold starts) ──
  // Read once; used for both the monthly cap and the daily cap below. Fail-open:
  // if Firestore is unreachable we fall back to the in-memory limiter.
  const isAuthUser = authResult.ok && authResult.uid && userId === authResult.uid;
  const serverUsage = (isAuthUser && !isDev) ? await readUsage(authResult.uid, authToken) : null;
  request._serverUsage = serverUsage;
  request._isAuthUser = isAuthUser;

  // Monthly cap (free 1M, Pro 20M). Only enforced when we have a real reading.
  if (!isDev && serverUsage) {
    const monthlyLimit = isPro ? PRO_MONTHLY : FREE_MONTHLY;
    if (serverUsage.monthUsed >= monthlyLimit) {
      response.status(402).json({
        error: 'no_textokens',
        text: isPro
          ? "You've used your 20M monthly TexTokens. They reset next month, or add a pack at rrotex.com/tokens."
          : "You've used your 1M monthly free TexTokens. Upgrade to Pro for 20M/month at rrotex.com/pro.",
      });
      return;
    }
  }

  // TexToken daily budget for free users (150k/day base). Dev account is exempt.
  // Authenticated users who have purchased extra TexTokens get an extended daily
  // cap equal to their purchased balance (up to 10M/day max). Once that balance
  // is spent, they fall back to the base 150k limit next day.
  // Both the per-user key AND the per-IP key are checked — whichever is more
  // restrictive wins. This makes multi-accounting pointless: all accounts on
  // the same IP share a single pool.
  if (!isPro && !isDev) {
    if (linkedMultiAccount) {
      response.status(402).json({
        error: 'no_textokens',
        text: 'Multiple accounts detected from the same person. Only one free account is allowed — this account has 0 TexTokens. Sign in with your original account, or upgrade to Pro at rrotex.com/pro.',
      });
      return;
    }

    const freeKey = userId !== 'unknown' ? `uid:${userId}` : `ip:${ip}`;
    const ipKey   = `ip:${ip}`;
    const usedByKey = getFreeTokensUsed(freeKey);
    const usedByIp  = getFreeTokensUsed(ipKey);
    // Prefer the persistent Firestore daily count; fall back to the in-memory
    // counters when Firestore is unavailable (fail-open).
    const usedToday = serverUsage
      ? Math.max(serverUsage.dayUsed, usedByKey, usedByIp)
      : Math.max(usedByKey, usedByIp);

    // Authenticated users with purchased tokens get an extended daily cap.
    // We trust their client-reported balance only when they have a valid Firebase
    // token (authResult.ok) so unauthenticated callers can't fake a higher limit.
    const isAuth = authResult.ok && userId !== 'unknown' && userId !== ip;
    const clientBalance = isAuth ? Math.max(0, Number(texTokensLeft) || 0) : 0;
    const effectiveDailyLimit = clientBalance > FREE_DAILY_TEXTOKENS
      ? Math.min(clientBalance, 10_000_000)
      : FREE_DAILY_TEXTOKENS;

    if (usedToday >= effectiveDailyLimit) {
      const hasPurchased = effectiveDailyLimit > FREE_DAILY_TEXTOKENS;
      response.status(402).json({
        error: 'no_textokens',
        text: noTokensText(proPass, isPro, hasPurchased),
      });
      return;
    }
    // Store keys and effective limit on request for post-estimate deduction below
    request._freeKey = freeKey;
    request._ipKey   = ipKey;
    request._effectiveDailyLimit = effectiveDailyLimit;
  }

  if (!isPro && !isDev && selected.freeDailyCap) {
    const used = bumpCounter(proCounters, `${ip}:${modelId}`);
    if (used > selected.freeDailyCap) {
      response.status(429).json({
        error: 'rate_limited',
        text: 'You are out of TexTokens. Upgrade to Pro or add more TexTokens to continue.',
      });
      return;
    }
  }

  let maxTokens = isPro ? (selected.proMaxTokens || selected.maxTokens) : selected.maxTokens;
  // Agent / Super Agent run on stronger models and need room to write complete,
  // multi-file solutions. Streaming is used in the editor, so larger caps are safe.
  if (superAgent) maxTokens = Math.max(maxTokens, 16000);
  else if (agent) maxTokens = Math.max(maxTokens, 12000);
  const isEditor = mode === 'editor';
  const modelGuide = buildModelGuide();
  const cleanAttachments = normalizeAttachments(attachments);
  const hasImages = cleanAttachments.some((item) => item.kind === 'image');
  const connectionStatus = summarizeConnections(computerConnections, pcBridge);
  const perMessageCap = isEditor ? 24000 : 8000;
  const lastMessageCap = isEditor ? 64000 : 16000;
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
  const robloxAssetContext = isEditor
    ? await buildRobloxUiAssetContext(lastUser?.content || '')
    : '';

  if (isEditor) {
    cleanMessages.unshift({
      role: 'system',
      content: buildEditorSystemPrompt(
        selected,
        agent,
        robloxAssetContext ? `${projectContext}\n\n${robloxAssetContext}` : projectContext,
        isPro,
        projectMode,
        superAgent,
      ),
    });
  } else {
    cleanMessages.unshift({
      role: 'system',
      content: [
        'You are ROTEX AI, the assistant inside the ROTEX desktop and web app for game developers. ROTEX is primarily used for Roblox game development.',
        buildEngineSection(projectMode || 'Roblox'),
        'Keep all replies short and direct. Answer the actual question — no intros, no "Great question!", no capability lists, no marketing. 2-4 sentences max for simple questions.',
        'Never output hidden reasoning, chain-of-thought, scratchpad text, or tags such as <think>, </think>, <analysis>, or </analysis>. Output only the final useful answer.',
        'Never start a response with "Certainly", "Sure", "Of course", "Absolutely", or similar filler.',
        'Use Markdown in your responses: **bold** for emphasis, `code` for inline code, fenced code blocks for multi-line code.',
        'When asked what models are available or to list the models, output EXACTLY these two lines and nothing else — no intro, no outro:\n**TexBrain Thinking-beta** (Free, 2.4x TexTokens/output token) — Balanced\n**Claude Haiku** (Claude Haiku 4.5, Free, 16x TexTokens/output token) — Expensive',
        `You are currently running as: **${selected.name}** (${selected.providerName}). Be honest about what model you are — never claim to be a different model.`,
        `ROTEX model ranking: 1st Claude Haiku (best quality) → 2nd TexBrain Thinking-beta (balanced Roblox-focused model). If asked which is best: Claude Haiku. If asked which is cheaper: TexBrain Thinking-beta.`,
        `ROTEX model data (internal): ${modelGuide}`,
        'ROTEX is a desktop and web AI app primarily for Roblox game developers. Website: rrotex.com. Free plan: 150k TexTokens/day, 1M/month, one account per person. Pro: $20/month, 20M TexTokens/month, 1M/day, agent mode, 5 projects. Extra packs: $2.50 per 1M TexTokens.',
        'When asked about pricing or plans, give a plain short answer. No table unless the user asks for one.',
        hasImages && selected.route !== 'anthropic-first' ? `An image-reading backend is reading the attachment for ${selected.name}; still answer as ${selected.name}.` : '',
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

  const providerCall = resolveProviderCall(selected, cleanMessages, { agent, superAgent });
  if (!providerCall) {
    const noProviderText = selected.route === 'tb-thinking'
      ? 'TexBrain is starting up. Try again in a few seconds.'
      : 'servers are down';
    response.status(500).json({
      error: 'backend_unavailable',
      text: noProviderText,
    });
    return;
  }

  const estimate = estimateTexTokens(selected, cleanMessages, maxTokens, { agent, superAgent });

  // Enforce free daily TexToken budget now that we have an accurate estimate.
  if (!isPro && !isDev && request._freeKey) {
    const usedByKey = getFreeTokensUsed(request._freeKey);
    const usedByIp  = request._ipKey ? getFreeTokensUsed(request._ipKey) : 0;
    const usedToday = Math.max(usedByKey, usedByIp);
    const effectiveDailyLimit = request._effectiveDailyLimit || FREE_DAILY_TEXTOKENS;
    if (usedToday + estimate.textokens > effectiveDailyLimit) {
      const hasPurchased = effectiveDailyLimit > FREE_DAILY_TEXTOKENS;
      response.status(402).json({
        error: 'no_textokens',
        text: noTokensText(proPass, isPro, hasPurchased),
      });
      return;
    }
    addFreeTokensUsed(request._freeKey, estimate.textokens);
    // Also charge the IP-level pool so multiple accounts on the same IP share the quota
    if (request._ipKey && request._ipKey !== request._freeKey) {
      addFreeTokensUsed(request._ipKey, estimate.textokens);
    }
  }

  // Persist usage to Firestore for ALL authenticated accounts (free and Pro) so
  // the daily + monthly counters survive cold starts and enforce the monthly cap.
  // Fire-and-forget, fail-open — never blocks the response.
  if (!isDev && request._isAuthUser && authResult.uid && estimate.textokens > 0) {
    addUsage(authResult.uid, authToken, estimate.textokens).catch(() => {});
  }

  // Never trust client-provided texTokensLeft for non-Pro users.
  // Free user budget is already enforced above via freeTokenCounters (server-side).
  // Use undefined (not null) so checkCreditSafety skips the TexToken check —
  // Number(null)=0 would wrongly block free users who still have budget.
  // Pro users have a verified proPass, so their client value is used to enforce
  // their own plan limits (the server trusts the pass, not the number).
  const trustedTexTokensLeft = undefined;

  const safety = await checkCreditSafety({
    selected,
    provider: providerCall.provider,
    model: selected.providerName || selected.name,
    userId,
    estimate,
    texTokensLeft: trustedTexTokensLeft,
    isPro: isPro && !isDev,
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

  // Mint a long-lived Pro pass for the verified dev account so it stays free even
  // after the Firebase ID token expires (no Stripe). The client persists it and
  // sends it on later requests, so the dev is recognized as Pro without a live token.
  const devPass = isDev
    ? signProPass({ uid: authResult.uid || userId, plan: 'pro', exp: Date.now() + 3650 * 24 * 60 * 60 * 1000 })
    : '';

  try {
    if (stream) {
      await streamResponse(response, providerCall, cleanMessages, cleanAttachments, selected, maxTokens, {
        userId,
        estimate,
        agent,
        superAgent,
        devPass,
      });
    } else {
      const result = await completeResponse(providerCall, cleanMessages, cleanAttachments, selected, maxTokens, hasImages, {
        userId,
        estimate,
        agent,
        superAgent,
      });
      response.status(200).json({ model: selected.name, text: result.text, usage: result.usage, devPass });
    }
  } catch (error) {
    console.error('ROTEX backend provider failed', {
      model: selected.name,
      provider: providerCall.provider,
      message: error?.message || String(error),
    });
    const lowCredit = insufficientCreditsError(error);
    const publicText = error?.publicText
      || (lowCredit && selected.route === 'anthropic-first' ? OPENROUTER_OUT_TEXT : '')
      || (selected.route === 'tb-thinking' ? 'TexBrain is busy for a moment. Try again in a few seconds.' : 'servers are down');
    const publicError = error?.publicError || (lowCredit ? 'provider_credits_empty' : 'backend_unavailable');
    if (stream && response.headersSent) {
      sseWrite(response, {
        error: publicError,
        text: publicText,
      });
      sseWrite(response, {
        done: true,
        usage: {
          input_tokens: context.estimate.inputTokens,
          output_tokens: context.estimate.outputTokens,
          textokens_charged: context.estimate.textokens,
        },
      });
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

function buildEngineSection(projectMode) {
  const mode = (projectMode || '').trim();
  if (!mode || mode === 'General') return '';
  const guides = {

    Roblox: `ENGINE FOCUS — Roblox Studio (Luau)
You are an expert Roblox developer. The user is building a Roblox game inside Roblox Studio. Everything you write should work within the Roblox ecosystem.

LANGUAGE: Luau (a typed superset of Lua 5.1). Use type annotations where helpful: local x: number = 0. Avoid standard Lua libraries that Roblox sandboxes away (io, os.execute, etc.).

SCRIPT TYPES:
- Script (server-side, runs in ServerScriptService or ServerStorage — never replicate sensitive logic to clients)
- LocalScript (client-side, runs in StarterPlayerScripts, StarterCharacterScripts, StarterGui — handles UI and local effects)
- ModuleScript (shared code, required by both sides; put shared modules in ReplicatedStorage, server-only modules in ServerStorage)

KEY SERVICES (always get via game:GetService):
- Players — player added/removed, character spawning, UserId
- DataStoreService — persistent player data (GlobalDataStore, OrderedDataStore); always pcall saves/loads; use UpdateAsync over SetAsync for safety. NOTE: DataStoreService is DISABLED in Roblox Studio by default. To test DataStore code in Studio, the user must go to Game Settings > Security > Enable Studio Access to API Services. Always mention this when writing DataStore code.
- ReplicatedStorage — shared instances and RemoteEvents/RemoteFunctions
- ServerScriptService — server Scripts
- TweenService — smooth animations on any property; use TweenInfo with EasingStyle/Direction
- RunService — Heartbeat (server/client physics step), RenderStepped (client pre-render), Stepped
- UserInputService — keyboard/mouse/touch on the client; check UserInputType
- ContextActionService — bind named actions to input combos, mobile buttons appear automatically
- HttpService — JSON encode/decode; HTTP requests from the server only (must be enabled in Studio settings)
- MessagingService — cross-server communication (pub/sub, up to 1 MB payload)
- MemoryStoreService — fast shared state across servers (leaderboards, matchmaking queues)
- MarketplaceService — prompt purchases (game passes, developer products, premium)
- CollectionService — tag instances with labels and iterate tagged objects efficiently
- PhysicsService — collision groups; set which groups collide with which
- PathfindingService — NPC navigation with :CreatePath(), :ComputeAsync(), :GetWaypoints()
- SoundService — global audio settings, audio groups
- Lighting — time of day, atmosphere, weather effects

REMOTES (always in ReplicatedStorage):
- RemoteEvent: server→client with :FireClient(player,...) / :FireAllClients(...); client→server with :FireServer(...)
- RemoteFunction: two-way call; avoid using from server→client (can hang if client disconnects)
- Always validate all data received on the server — clients can send anything

DATA PERSISTENCE PATTERN:
\`\`\`luau
local DS = game:GetService("DataStoreService")
local store = DS:GetDataStore("PlayerData")
Players.PlayerAdded:Connect(function(player)
    local ok, data = pcall(function() return store:GetAsync(player.UserId) end)
    if ok and data then -- restore data end
end)
Players.PlayerRemoving:Connect(function(player)
    local ok, err = pcall(function() store:SetAsync(player.UserId, playerData[player]) end)
    if not ok then warn(err) end
end)
\`\`\`

ROBLOX-SPECIFIC GOTCHAS:
- Never invent Roblox APIs, services, events, or properties. If you need a custom RemoteEvent/BindableEvent, create it in the file block before using it. Do not reference fake members like ReplicatedStorage.OnGameStart unless the project context confirms it exists.
- There is no general "game start" event. Server startup: code runs when the Script loads. Players joining: Players.PlayerAdded. Character spawn: player.CharacterAdded.
- RemoteEvents MUST be created on the server first. Server Script creates it in ReplicatedStorage; LocalScript uses :WaitForChild("EventName", 10) to get it. Never assume a RemoteEvent exists.
- Always use :WaitForChild("Name", 10) with a timeout when accessing cross-script instances. A plain index that doesn't exist returns nil silently and errors later.
- LocalScripts CANNOT access ServerScriptService. Put shared assets in ReplicatedStorage.
- ModuleScript state is per-VM: one shared instance for all server Scripts, one for all LocalScripts. Key per-player data by player object, not globals.
- Touched fires multiple times per second — debounce with a table keyed by player: local db = {}; part.Touched:Connect(function(hit) local p = Players:GetPlayerFromCharacter(hit.Parent); if not p or db[p] then return end; db[p] = true; task.delay(1, function() db[p] = nil end) end).
- Character loads async. After PlayerAdded fires, character may not exist yet. Always use player.CharacterAdded:Wait() before accessing the character model.
- Humanoid.Health = 0 kills instantly and ignores ForceField. Use Humanoid:TakeDamage(amount) instead.
- Destroy() removes AND disconnects everything. Never reference a destroyed instance.
- task.wait / task.spawn / task.delay are correct modern APIs. wait() / spawn() / delay() are deprecated — never use them.
- Always store :Connect() return values and call :Disconnect() when done to prevent memory leaks.
- game.Players.LocalPlayer is nil on the server. Only use it in LocalScripts.
- RunService:IsServer() / :IsClient() lets a ModuleScript branch correctly for each side.
- If displaying user-entered text to other players, filter it with TextService:FilterStringAsync() on the server first.
- ProximityPrompt: place it inside any Part; listen on server with ProximityPrompt.Triggered:Connect(function(player) ... end).
- Tween pattern: local ts = game:GetService("TweenService"); local tw = ts:Create(part, TweenInfo.new(duration, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), {CFrame = targetCFrame}); tw:Play().
- HumanoidRootPart access: local hrp = char:WaitForChild("HumanoidRootPart", 5); if not hrp then return end.

COMMON RUNTIME ERRORS AND FIXES:
- "attempt to index nil" — something wasn't WaitForChild'd or LocalPlayer was used on server. Add a nil guard.
- "DataStore request was added to queue" — DataStore rate limit hit; add pcall and retry logic, or use UpdateAsync with exponential backoff.
- "Unable to cast value to Object" — wrong argument type passed to a Roblox API; check expected types.
- "X is not a valid member of Y" — typo in service or instance name, or the instance hasn't been created yet.

STUDIO WORKFLOW: ALWAYS output Lua using \`\`\`file:ServiceName/path/Script.lua\`\`\` blocks so ROTEX can apply them directly to Studio. Use the service name as the root folder (e.g. \`ServerScriptService/Leaderstats.lua\`, \`ReplicatedStorage/Modules/Inventory.lua\`). Never output a plain \`\`\`lua block for code that belongs in a Studio file.`,

    'Roblox+Blender': `ENGINE FOCUS — Roblox Studio (Luau) + Blender
You are an expert in both Roblox game development and Blender 3D asset creation, specializing in the pipeline between them.

ROBLOX SIDE (same as standalone Roblox mode — see below for Luau details):
Language is Luau. Use game:GetService(). Server Scripts in ServerScriptService, LocalScripts in StarterGui/StarterPlayerScripts, ModuleScripts in ReplicatedStorage. RemoteEvents for client↔server. DataStoreService with pcall for persistence. task.spawn/task.wait instead of deprecated equivalents.

BLENDER SIDE (Python bpy scripting):
- bpy.context.object — the active object; bpy.context.selected_objects — selection
- bpy.ops — operators (often context-sensitive; prefer bpy.data + direct manipulation for scripts)
- bpy.data.meshes, bpy.data.objects, bpy.data.materials — the main data blocks
- Edit mode via bpy.ops.object.mode_set(mode='EDIT'), then use bmesh for geometry manipulation
- Geometry Nodes: add a modifier via obj.modifiers.new(name, 'NODES'); set node group inputs via modifier[identifier]

BLENDER → ROBLOX ASSET PIPELINE:
1. MODELING: Keep poly count reasonable — Roblox renders many parts; ~1k–5k tris per prop is typical. Apply all transforms (Ctrl+A → All Transforms) before export.
2. TEXTURES: Bake to image textures (Cycles bake or EEVEE with a bake add-on). Use power-of-two sizes (512×512, 1024×1024, 2048×2048). Export as PNG.
3. EXPORT FBX: File → Export → FBX. Settings: Apply Scalings = FBX Units Scale, Forward = -Z Forward, Up = Y Up, uncheck "Add Leaf Bones" for meshes without rigs.
4. ROBLOX IMPORT: In Studio, use the Asset Manager or drag-and-drop the FBX. MeshParts are created automatically. Assign the texture as a Decal or SurfaceAppearance (PBR).
5. SURFACE APPEARANCE (PBR): Use ColorMap (albedo), NormalMap, MetalnessMap, RoughnessMap for realistic materials. SurfaceAppearance replaces the Part Material.
6. RIGGED CHARACTERS: Export with armature, check "Add Leaf Bones" OFF, import as R15-compatible rig for custom avatars.

COMMON PITFALLS:
- Non-applied scale in Blender causes incorrect sizing in Roblox — always apply transforms
- Roblox uses Y-up; Blender is Z-up — the FBX exporter handles this with the correct settings above
- Double-sided materials: Roblox renders both sides of a mesh face by default; remove internal geometry to save draw calls
- Large triangle counts will hit Roblox's MeshPart polygon limits — use LODs or simplify
- UV maps must be within 0–1 range for textures to map correctly`,

    Unity: `ENGINE FOCUS — Unity (C#)
You are an expert Unity developer. The user is building a Unity game. All code should be C# targeting Unity's API.

CORE CONCEPTS:
- GameObjects are containers; Components add behavior. Every MonoBehaviour is a Component.
- Transform holds position, rotation, scale. Use transform.localPosition for parent-relative coordinates.
- The Scene is the root of the hierarchy. Prefabs are reusable templates saved as assets.
- Physics: Rigidbody (3D) / Rigidbody2D (2D) drive physics. Colliders define shape. Kinematic Rigidbodies are moved via script, not physics.
- Unity uses a left-handed Y-up coordinate system.

MONOBEHAVIOUR LIFECYCLE ORDER:
Awake → OnEnable → Start → FixedUpdate (physics) → Update (frame) → LateUpdate (camera, post-process) → OnDisable → OnDestroy
- Awake: runs even if the component is disabled; use for initialization that doesn't depend on other objects
- Start: runs after all Awakes; safe to reference other initialized components
- FixedUpdate: physics-safe; use for Rigidbody forces (Time.fixedDeltaTime is constant)
- Update: per-frame input and logic (Time.deltaTime for frame-rate independence)
- LateUpdate: runs after all Updates; ideal for camera follow

COMMON UNITY PATTERNS:
\`\`\`csharp
// Singleton pattern
public class GameManager : MonoBehaviour {
    public static GameManager Instance { get; private set; }
    void Awake() {
        if (Instance != null) { Destroy(gameObject); return; }
        Instance = this;
        DontDestroyOnLoad(gameObject);
    }
}

// Coroutine
IEnumerator DelayedAction(float delay) {
    yield return new WaitForSeconds(delay);
    DoSomething();
}
StartCoroutine(DelayedAction(2f));

// Event system
public static event Action<int> OnScoreChanged;
OnScoreChanged?.Invoke(newScore);
\`\`\`

KEY UNITY SYSTEMS:
- Input System (new): use InputAction assets and PlayerInput component; InputAction.ReadValue<Vector2>()
- Physics: Physics.Raycast(), Physics.OverlapSphere(); layers filter what gets hit
- Animation: Animator component with a controller; use animator.SetBool/SetTrigger/SetFloat; Animation Rigging for procedural IK
- NavMesh: bake NavMesh in Window → AI → Navigation; NavMeshAgent component drives movement
- UI (uGUI): Canvas → Panel → Image/Text/Button hierarchy; RectTransform for layout; use TextMeshPro (TMP) for text
- UI Toolkit (UIElements): UXML + USS for editor tools and runtime UI in newer projects
- ScriptableObjects: data containers not tied to a scene; create via [CreateAssetMenu]
- Addressables: async asset loading system; avoids Resources.Load() in large projects
- Unity Events: serializable callbacks in the Inspector; great for designer-driven logic
- Physics Layers: set in Edit → Project Settings → Physics; GetLayerMask by name

PERFORMANCE TIPS:
- Cache component references in Awake/Start (GetComponent is slow in Update)
- Use object pooling instead of Instantiate/Destroy in hot paths
- Mark static geometry as Static for batching and occlusion culling
- Physics queries (Raycast, etc.) are expensive; limit calls per frame
- Use [SerializeField] private instead of public to keep the Inspector clean without breaking encapsulation
- String.Format and concatenation generate GC; use StringBuilder or string interpolation sparingly in Update

COMPILE ERRORS TO WATCH:
- CS0246: type not found — missing using directive or namespace
- CS0103: name does not exist — typo or out-of-scope variable
- NullReferenceException: component not found or destroyed; always null-check references`,

    'Unity+Blender': `ENGINE FOCUS — Unity (C#) + Blender
You are an expert in both Unity game development and Blender 3D asset creation, specializing in the art pipeline between them.

UNITY SIDE (same depth as standalone Unity mode):
C# MonoBehaviours. Lifecycle: Awake→Start→FixedUpdate→Update→LateUpdate. Cache GetComponent in Awake. Use Rigidbody for physics. Coroutines for async sequences. ScriptableObjects for data. NavMeshAgent for AI. Input System for controls. TextMeshPro for UI text. Addressables for large asset sets. Pool objects instead of Instantiate/Destroy per frame.

BLENDER SIDE:
Language: Python (bpy). bpy.context.object is the active object. bpy.ops are context-sensitive operators. Prefer bpy.data for scripting (more stable than ops). Use bmesh for geometry manipulation inside Edit mode. Geometry Nodes for procedural modeling. Cycles/EEVEE for rendering/baking.

BLENDER → UNITY PIPELINE:
1. SCALE: Blender default unit = 1m. Unity also uses meters. Work in Blender at real-world scale for correct Unity import.
2. TRANSFORMS: Apply All Transforms (Ctrl+A → All Transforms) before export to prevent scale/rotation surprises.
3. EXPORT FBX:
   - Forward: -Z Forward, Up: Y Up (Unity is Y-up, Blender is Z-up — these settings fix the axis)
   - Apply Scalings: FBX Units Scale
   - For rigged characters: include Armature, check "Add Leaf Bones" OFF
4. UNITY IMPORT SETTINGS (Model tab):
   - Scale Factor: 1 (if you applied scale in Blender)
   - Import Normals: Import (to keep Blender-baked normals)
   - Generate Lightmap UVs: check for static environment meshes
5. MATERIALS:
   - URP/HDRP: use Lit shader; PBR maps: Albedo, Normal, Metallic+Smoothness (packed in R+A channels), Emission
   - Bake maps in Blender (Cycles): Diffuse→Albedo, Normal→Normal, Roughness→Smoothness (invert)
   - Metallic map: R channel = metallic value; A channel (in Unity's Metallic map) = smoothness
6. ANIMATIONS:
   - Export actions as NLA strips or use the "All Actions" bake option in FBX export
   - In Unity, set Animation Type to Humanoid for avatar retargeting, Generic for custom rigs
   - Use Animation Rigging package for runtime IK on top of imported animations

COMMON PITFALLS:
- Not applying scale/rotation in Blender → everything imports rotated 90° or at wrong scale
- Normal map baked in Blender is OpenGL convention; Unity HDRP/URP expect DirectX — flip the G channel in Unity's Normal Map Import Settings
- Multiple UV channels: Blender UV0 = main texture, UV1 = lightmap; make sure names match or set explicitly in Unity's Model import
- Shapekeys (blendshapes) export fine via FBX; use SkinnedMeshRenderer in Unity to drive them`,

    Blender: `ENGINE FOCUS — Blender (Python / bpy)
You are an expert Blender artist and Python (bpy) scripter. Help the user with everything Blender: modeling, scripting, shaders, rendering, animation, rigging, and geometry nodes.

BPY SCRIPTING BASICS:
\`\`\`python
import bpy, bmesh, mathutils

# Active object and mesh
obj  = bpy.context.active_object
mesh = obj.data  # bpy.types.Mesh

# Edit-mode geometry with bmesh
bm = bmesh.from_edit_mesh(mesh)
for v in bm.verts:
    v.co.z += 0.1
bmesh.update_edit_mesh(mesh)

# Object-mode bmesh (from data)
bm2 = bmesh.new()
bm2.from_mesh(mesh)
bm2.to_mesh(mesh)
bm2.free()

# Create a new object
mesh_data = bpy.data.meshes.new("MyMesh")
obj2 = bpy.data.objects.new("MyObj", mesh_data)
bpy.context.collection.objects.link(obj2)
\`\`\`

KEY BPY AREAS:
- bpy.context — active scene, object, mode, area; changes with the UI state
- bpy.data — all data blocks: .objects, .meshes, .materials, .images, .actions, .node_groups
- bpy.ops — operator calls (mimic menu actions); require correct context; prefer bpy.data when possible for stability
- bpy.types — type definitions; use for type hints and isinstance() checks
- mathutils — Vector, Matrix, Quaternion, Euler; e.g. mathutils.Vector((1,0,0))

MODES:
- OBJECT mode: transform, link/unlink objects, apply modifiers
- EDIT mode: vertex/edge/face selection, mesh editing, bmesh operations
- SCULPT mode: brushes, multires
- Switch via: bpy.ops.object.mode_set(mode='EDIT')

MATERIALS & SHADERS (node-based):
\`\`\`python
mat = bpy.data.materials.new("MyMat")
mat.use_nodes = True
nodes = mat.node_tree.nodes
links = mat.node_tree.links
bsdf  = nodes.get("Principled BSDF")
bsdf.inputs["Base Color"].default_value = (1, 0, 0, 1)  # Red
# Link an image texture
tex_node = nodes.new("ShaderNodeTexImage")
tex_node.image = bpy.data.images.load("/path/to/image.png")
links.new(tex_node.outputs["Color"], bsdf.inputs["Base Color"])
\`\`\`
Principled BSDF inputs: Base Color, Metallic, Roughness, Normal, Emission Color, Alpha, IOR, Subsurface.
Cycles = path-trace (physically accurate). EEVEE = rasterized (real-time preview, faster).

GEOMETRY NODES:
- Add a Geometry Nodes modifier: obj.modifiers.new("GN", 'NODES')
- Node groups live in bpy.data.node_groups
- Set inputs via: modifier["Input_X"] = value (use the identifier, not the label)
- Common nodes: Join Geometry, Instance on Points, Set Position, Attribute Statistic, Mesh to Points, Curve to Mesh

RIGGING & ANIMATION:
- Armature: bpy.data.armatures; bones in edit mode, pose bones in pose mode
- Keyframes: obj.keyframe_insert(data_path="location", frame=1)
- Action: bpy.data.actions; NLA editor stacks actions
- Drivers: property driven by another property or Python expression (obj.driver_add("location", 0))
- Shape Keys (blendshapes): obj.shape_key_add(name="Basis"); key_blocks["MyKey"].value = 0.5

RENDERING:
- bpy.context.scene.render.engine = 'CYCLES' or 'BLENDER_EEVEE_NEXT'
- Render: bpy.ops.render.render(write_still=True)
- Output: scene.render.filepath = "/tmp/render.png"; scene.render.image_settings.file_format = 'PNG'
- Baking (Cycles): bpy.ops.object.bake(type='DIFFUSE') — requires UV map and image texture node selected

COMMON SCRIPTING PATTERNS:
- Deselect all: bpy.ops.object.select_all(action='DESELECT')
- Select by name: bpy.data.objects["Cube"].select_set(True); bpy.context.view_layer.objects.active = ...
- Apply modifier: bpy.ops.object.modifier_apply(modifier="Subdivision")
- Iterate scene objects: for obj in bpy.context.scene.objects: ...`,

    Supabase: `ENGINE FOCUS — Supabase (PostgreSQL + TypeScript): You are a Supabase expert. Help with Supabase tables, Row Level Security (RLS), policies, PostgREST REST API, Edge Functions (Deno/TypeScript), Auth (magic link, OAuth, JWTs), Storage buckets, Realtime subscriptions, and the Supabase JavaScript/TypeScript client library. You also know SQL, PostgreSQL functions, triggers, and extensions (pgvector, pg_cron, etc.). If the user asks something unrelated to Supabase or backend/database development, briefly acknowledge but redirect.`,
  };
  return guides[mode] || `ENGINE FOCUS: You are specialized in ${mode}. Focus your answers on ${mode} topics and game development. Redirect unrelated questions.`;
}

function buildEditorSystemPrompt(selected, agent, projectContext, isPro, projectMode, superAgent = false) {
  const projectContextText = String(projectContext || '');
  const askMode = /ROTEX UI MODE:\s*ASK/i.test(projectContextText);
  const planMode = /ROTEX UI MODE:\s*PLAN/i.test(projectContextText);
  const parts = [
    'You are ROTEX AI, the coding assistant inside the ROTEX desktop app chat.',
    `You are running as the **${selected.name}** model (${selected.providerName}).`,
    'You are a world-class expert Roblox/Luau engineer. Think the whole problem through before you write a single line: what the user actually wants, exactly which Roblox services/instances/events own that behavior, every edge case (respawn, multiple players, exploits, mobile, cleanup), and the simplest correct design. Then write production-quality Luau that runs first try.',
    'Reason silently, output confidently. Internally plan step by step, but never show that reasoning — only output the final, complete solution. Prefer one correct, complete answer over several half-ideas. If you are unsure of an exact API, use only members you are certain exist; never invent Roblox APIs.',
    'Quality bar: correct client/server boundaries, RemoteEvents created and WaitForChild-ed, debounces keyed per-player, connections disconnected, task.wait/task.spawn (never the deprecated globals), pcall around DataStore/HttpService, and sensible defaults. Match the existing code style and names from PROJECT CONTEXT.',
    buildEngineSection(projectMode || 'Roblox'),
    'Output only what is needed. No preamble ("Sure!", "Here\'s how...", "Let me help you..."), no closing filler ("Let me know if you need anything else", "Hope this helps!"). Start with the answer — code first, one short explanation line after only if the code alone is not enough.',
    'Do NOT generate code for greetings, casual conversation, or questions that do not ask for code. If the user says "hi", "thanks", or asks a question, respond conversationally in 1-2 sentences. Never attach a code block to a casual message.',
    'Write COMPLETE, RUNNABLE code every time. File blocks must contain the full file — no placeholders, no "-- your logic here", no "-- rest of code", no "...", no truncation of any kind. Every function must be fully implemented. If the file is long, write every line.',
    'Format responses clearly: use bullet points for multiple items, numbered steps for sequences. Avoid walls of text. Keep explanations tight — one sentence per point. Never use markdown headers (##) inside chat responses.',
    'Never output hidden reasoning, chain-of-thought, scratchpad text, or tags such as <think>, </think>, <analysis>, or </analysis>. Output only the final useful answer.',
    'STRICT API ACCURACY: Only use documented, real APIs. Never invent Roblox service members, Unity methods, or Blender bpy calls. Before writing any RemoteEvent name or Instance path, check the PROJECT CONTEXT to confirm it already exists, or create it explicitly in the code.',
    'AGENT DECISION PROTOCOL: classify the user request as one of: answer-only, plan-only, create, modify, remove/disable, debug, inspect, or verify. Then perform only that class. Do not drift into a different class. If the user already gave a direct command, execute it instead of asking setup questions that PROJECT CONTEXT can answer.',
    'REASON BEFORE ACTING: silently analyze every request in three steps before answering: (1) INTENT — what does the user actually want? (2) CONTEXT — which existing scripts, events, or instances already own this behavior? (3) IMPACT — what could this change break? Use the answers to pick the smallest correct action.',
    'PROJECT CONTEXT PROTOCOL: scan PROJECT CONTEXT for matching script names, paths, RemoteEvents, ScreenGuis, Tools, camera/input scripts, and previous ROTEX-created scripts. Prefer modifying/removing exact matches over creating new scripts.',
    'REAL UPDATE RULE: the user judges success by the live Roblox Studio game changing. In Agent/Super Agent, do not only explain or paste code. Output executable file/studio-action/roblox-model blocks that ROTEX can apply through the plugin, then keep visible text short.',
    'VISIBLE CHAT RULE: In Agent/Super Agent, the user-facing message must NOT contain Lua source code, JSON action payloads, or markdown code fences. Put all code/action/model JSON only inside executable file/studio-action/roblox-model blocks. ROTEX hides those blocks and applies them. Visible text should be a plain sentence like "I am updating the stamina UI now."',
    'ROBLOX PATH PROTOCOL: file paths must start with a real Roblox root: ServerScriptService, ReplicatedStorage, StarterPlayer, StarterGui, Workspace, ServerStorage, or StarterPack. For StarterPlayerScripts use StarterPlayer/StarterPlayerScripts/Name.client.lua.',
    'OUTPUT PROTOCOL: In Agent/Super Agent, output hidden executable blocks first. Use file blocks for source changes and studio-action blocks for deletion/property/model actions. Do not output plain code that cannot be applied.',
    'SELF-CHECK PROTOCOL before final output: check whether the blocks actually satisfy the user request, whether removal requests remove/disable instead of recreate, whether client/server placement is correct, whether cleanup exists, and whether all referenced Instances are created or WaitForChild-ed.',
    'You are not a code dispenser. In Agent/Super Agent mode, your job is to make the user\'s actual game state correct. Decide whether the task requires creating, updating, deleting, disabling, selecting, or setting a property, then output the exact hidden file/studio-action blocks needed.',
    'Before changing a Roblox feature, identify the script/path from PROJECT CONTEXT that owns the behavior. If the user asks to undo/remove/turn off a feature, prefer deleting or disabling the owning script instead of writing replacement code.',
    'Never claim something is fixed unless your output includes an executable file block or studio-action block that would actually make the change. If the right action is unclear, ask one short question instead of pretending.',
    'For camera/control/input tasks, reason about LocalScript placement carefully. Client-only behavior belongs under StarterPlayer/StarterPlayerScripts or StarterCharacterScripts; server Scripts cannot control LocalPlayer camera.',
    'For existing Roblox scripts, preserve unrelated code. Modify only the script that owns the requested behavior. Do not create duplicate scripts with similar names unless the user asked for a new separate system.',
    'If a requested feature needs both setup and cleanup, include cleanup: disconnect RBXScriptConnections, restore CameraType/MouseBehavior when disabling, handle respawn/CharacterAdded, and avoid permanent locked state.',
    'When fixing a bug: identify the root cause in exactly one sentence (e.g. "The debounce table was keyed by part, not by player, so two players touching simultaneously both triggered."), then output the corrected file block with no further explanation.',
    'When the user pastes an error: read the full stack trace, identify the exact line and type of error (nil reference, missing child, rate limit, etc.), explain in one sentence why it happened, then give the fix.',
    'When adding a feature: output all modified file blocks directly. Output every file that needs to change — never leave one out. If adding something that requires both a server Script and a LocalScript, output both.',
    'Read PROJECT CONTEXT before writing anything. If the user\'s project already has a script at a path, modify that exact script — do not create a duplicate. Match the existing variable names, RemoteEvent names, function names, and coding style from their project.',
    'When writing Roblox Lua: always use task.wait(n) not wait(n), task.spawn() not spawn(), task.delay() not delay() — the task library is faster and non-deprecated. Always wrap DataStore calls in pcall. Always use :WaitForChild("Name", 10) with a timeout when accessing cross-script instances.',
    'ROBLOX LIFECYCLE RULES: CharacterAdded can fire multiple times per player (respawns). Never assume the character exists at the top of a LocalScript; wait for it or use CharacterAdded. PlayerRemoving/Destroying events must disconnect custom loops to avoid errors.',
    'ROBLOX SECURITY RULES: validate all RemoteEvent/RemoteFunction payloads on the server. Never trust the client for damage, currency, inventory, or moderation. Use server authority for game-state changes.',
    'ROBLOX PERFORMANCE RULES: avoid busy loops without task.wait(). Disconnect event connections when systems are disabled. Use :WaitForChild with timeouts instead of infinite waits. Cache expensive lookups like GetService or FindFirstChild.',
    'ERROR INTELLIGENCE: when a Studio error is reported, trace it backward from the failing line to the source. Common patterns: nil from LocalPlayer on server → script is a Script, not LocalScript; "attempt to index nil with X" → missing WaitForChild or wrong path; "HTTP 401" → bad plugin token; "not a valid member" → typo or wrong service.',
    'SMART DUPLICATION CHECK: before creating a new script, search PROJECT CONTEXT for existing scripts with similar names or behavior. If found, modify the existing one and use studio-action delete_instance to remove duplicates if necessary.',
    'DUPLICATE UI/SYSTEM FIX RULE: if the user says there are two bars, duplicate buttons, duplicate stamina/sprint UI, duplicate health UI, or "make only one", do not only edit the newest script. Search PROJECT CONTEXT for every script and ScreenGui that creates that UI, keep exactly one owner, and output studio-action delete_instance blocks for stale UI scripts/ScreenGuis plus the corrected owner file.',
    'STAMINA/SPRINT SPECIFIC RULE: if fixing duplicate stamina bars, inspect paths containing Stamina, Sprint, Bar, UI, Gui, StarterGui, StarterPlayerScripts, and PlayerGui. Prefer one LocalScript owner under StarterPlayer/StarterPlayerScripts or StarterGui, and delete/disable duplicate StaminaUI/SprintUI scripts or ScreenGuis.',
    'SMART CHANGE SCOPING: only change files that must change. If the user asks for a UI tweak, do not rewrite unrelated game systems. If the user asks for a bug fix, do not add features. Keep diffs minimal and correct.',
    'SMART NAMING: reuse existing variable names, RemoteEvent names, and function names from PROJECT CONTEXT. Do not introduce new naming conventions unless the project is empty.',
    'SMART DEFAULTS: when a value is missing from context, choose sensible, safe defaults. Prefer existing project constants over invented ones. Document defaults only if they materially affect behavior.',
    'AUTO-FIX OVERRIDE: if the user message starts with "[AUTO-FIX]", the user is asking you to fix a Studio runtime error that was detected automatically. Start your response with exactly "Oh! Roblox sent a error, let me fix it..." on its own line, then diagnose the error using the PROJECT CONTEXT and output the fix. This is the only exception to the no-preamble rule.',
    askMode ? 'ASK MODE HARD RULE: Do not output code blocks, file blocks, patches, commands, or implementation snippets. Ask mode can answer questions and explain concepts only. If the user asks you to make/edit/fix/build something, tell them to switch to Agent or Super Agent mode to edit the game.' : '',
    planMode ? 'PLAN MODE HARD RULE: Do not output code blocks, file blocks, patches, commands, or implementation snippets. Return a concise numbered plan only. Mention that Agent or Super Agent can execute it.' : '',
    (!askMode && !planMode) ? 'When changing code for a specific file, ALWAYS use a hidden executable file block: start with ```file:relative/path.ext on its own line, then the COMPLETE new file contents, then a closing ``` line. Do not duplicate that code in normal visible chat text.' : '',
    (!askMode && !planMode) ? 'The file block header must contain ONLY the path. Put the code on the next line. Correct:\n```file:ServerScriptService/Example.lua\nprint("hello")\n```\nWrong: ```file:ServerScriptService/Example.lua print("hello")```.' : '',
    (!askMode && !planMode) ? 'For small inline snippets that are not meant to replace a file, use normal ```lang code fences instead.' : '',
    'If PROJECT CONTEXT says the Roblox Studio plugin is CONNECTED, treat Studio as connected even if older chat messages suggest otherwise.',
    (!askMode && !planMode) ? 'When the user asks you to make/create/add/fix anything in Roblox, ALWAYS output the Lua code in a ```file:ServiceName/path/ScriptName.lua block — not a plain ```lua block. Use service names as the root folder: ServerScriptService, ReplicatedStorage, StarterPlayer, StarterGui, Workspace, ServerStorage, StarterPack. ROTEX auto-applies file blocks to Studio when connected, and shows them ready-to-apply when not. Never tell the user to paste code manually.' : '',
    (!askMode && !planMode) ? 'For client scripts under StarterPlayerScripts, use paths like ```file:StarterPlayer/StarterPlayerScripts/FirstPersonCamera.client.lua, not ```file:StarterPlayerScripts/FirstPersonCamera.client.lua.' : '',
    (!askMode && !planMode) ? 'When the user asks to remove, undo, turn off, disable, or get out of a feature, do NOT rewrite the same feature back in. Delete or disable the script that causes it. Use a studio-action block when deletion or property edits are the right operation.' : '',
    (!askMode && !planMode) ? 'Studio action blocks are hidden from the user and executed by the ROTEX Roblox plugin. Format exactly:\n```studio-action\n{"type":"delete_instance","path":"StarterPlayer/StarterPlayerScripts/FirstPersonCamera"}\n```\nAllowed action types: delete_instance with path, set_property with path/property/value, select_instances with paths, create_model with model JSON, terrain_edit with operation/position/size/radius/material, lighting_set with properties, and create_ui_image with screenGui/name/image/position/size. Use delete_instance for removing scripts such as first-person camera scripts.' : '',
    (!askMode && !planMode) ? 'Common removal examples: "get out of first person" should delete or disable the first-person LocalScript; "remove sprint" should delete/disable the sprint script and any UI it created; "stop the GUI" should disable or delete the ScreenGui/LocalScript, not add another script that fights it.' : '',
    (!askMode && !planMode) ? 'Duplicate UI example: if the user says "there are still 2 bars" after a stamina/sprint change, output delete_instance actions for the extra StaminaUI/SprintUI ScreenGui/LocalScript paths and update the remaining sprint/stamina script so it creates or controls only one bar.' : '',
    (!askMode && !planMode) ? 'After file/studio-action blocks, do not add fake success claims. The desktop app reports Studio results. Keep any human text to one short sentence about what the change is intended to do.' : '',
    (!askMode && !planMode) ? 'PLUGIN TOOL RULE: for model/geometry requests, use roblox-model or create_model. For terrain requests, use terrain_edit. For lighting/time/atmosphere requests, use lighting_set. For existing parts, use set_property. For UI art/images/icons, use ROBLOX UI IMAGE ASSET SEARCH results with create_ui_image or ImageLabel/ImageButton Image = rbxassetid://id. Do not write a Lua script when a plugin action directly edits the scene more reliably.' : '',
    (!askMode && !planMode) ? 'ROBLOX UI QUALITY RULE: Roblox UI should look polished and game-ready: use a clear hierarchy, consistent spacing, UIScale, UICorner, UIStroke, UIGradient, padding, hover/click feedback where relevant, mobile-safe sizes, readable contrast, and only one owner script. Prefer clean modern panels over raw default Frames. If the user asks for classic/simple/normal, make it restrained but still aligned and readable.' : '',
    'To create 3D models/parts in Studio, use a ```roblox-model block with JSON. Example:\n```roblox-model\n{"name":"Castle","parent":"Workspace","parts":[{"name":"Base","size":[20,1,20],"position":[0,0,0],"color":[128,128,128],"material":"SmoothPlastic","anchored":true},{"name":"Wall","size":[20,10,1],"position":[0,5,-10],"color":[110,110,110],"material":"SmoothPlastic","anchored":true}]}\n```\nROTEX sends this to Studio which creates the real 3D objects. Each part can have: name, size[x,y,z], position[x,y,z], rotation[x,y,z] degrees, color[r,g,b], material (SmoothPlastic/Neon/Glass/Wood/Marble/Metal/Concrete/Fabric/ForceField/Granite/Grass/Ice/Sand/Slate), shape (Block/Ball/Cylinder), anchored, transparency, cancollide, scripts[{name,source}]. The model can also have a top-level "scripts" array for scripts attached to the Model itself.',
    'Terrain action example:\n```studio-action\n{"type":"terrain_edit","operation":"fill_block","position":[0,0,0],"size":[80,12,80],"material":"Grass"}\n```\nLighting action example:\n```studio-action\n{"type":"lighting_set","properties":{"ClockTime":18,"Brightness":2,"Ambient":[90,90,110],"OutdoorAmbient":[120,120,140]}}\n```',
    'UI image action example:\n```studio-action\n{"type":"create_ui_image","screenGui":"MainHud","name":"CoinIcon","image":"rbxassetid://123456789","position":[0,16,0,16],"size":[0,40,0,40]}\n```',
    'The PROJECT CONTEXT below contains the full source of all scripts in the user\'s game (auto-scanned when Studio connected), plus any recent Studio errors or selection data. Read them to understand the existing codebase before suggesting changes. When modifying existing scripts, reference the exact script path from the context and output a file block for it.'
  ].filter(Boolean);
  if (agent) {
    parts.push(
      'AGENT MODE is ON. You are an expert Roblox engineer. Think through the FULL solution before writing — what the user actually wants, which scripts own that behavior, what could break — then deliver code that is correct and complete on the first try. No half-measures, no placeholders, no "you could also...".',
      'AGENT MODE is ON. Be smart, direct, and execution-focused. Use PROJECT CONTEXT to choose the most likely correct path, then output the exact file/studio-action blocks needed.',
      'AGENT ANALYSIS LOOP: (1) identify the exact user intent, (2) scan PROJECT CONTEXT for the owning script or existing pattern, (3) decide create/modify/delete/disable, (4) produce the smallest complete change, (5) verify it does not conflict with existing scripts.',
      'Agent should solve normal one-step and two-step tasks: create a feature, modify an existing script, remove an unwanted script, or fix an obvious bug. Do not over-plan; do the smallest complete change that satisfies the request.',
      'Before the file/studio-action blocks, write one short intent line only when it helps. After the blocks, write at most one sentence on how to test.',
      'If multiple files are clearly required, output all of them. If the request is ambiguous but one safe default exists, choose the safe default and implement it.',
      'When fixing an error from the Studio output, reproduce the error mentally: which script, which line, which variable is nil or wrong, and why. Then output the exact fix with no extra chatter.',
      'Agent must not create duplicate systems. If a similar feature exists, modify it. If a stale conflicting script exists, delete it with a studio-action block.',
      'Ask a question only when acting could damage unrelated systems or when PROJECT CONTEXT has no usable target and no safe default path exists.',
    );
  }
  if (superAgent) {
    parts.push(
      'SUPER AGENT MODE is ON. You are the most capable Roblox architect available — reason far more deeply than Agent before acting. Map the entire problem, every script and system it touches, every edge case and failure mode, then produce a flawless, production-ready solution. Aim to be dramatically more thorough and correct than a normal agent: nothing missing, nothing broken, nothing left for the user to finish.',
      'SUPER AGENT MODE is ON. You are 5x deeper than Agent. Do not stop at the first obvious edit. Run a full five-pass workflow and produce a complete, conflict-free, production-ready result.',
      'SUPER AGENT PASS 1 — INTENT & ARCHITECTURE: restate the user request in technical terms. Identify the game systems involved (combat, economy, UI, movement, inventory, etc.). Determine whether this is a create, modify, remove, debug, or refactor task. Name the expected outcome in one sentence.',
      'SUPER AGENT PASS 2 — CONTEXT MAPPING: scan every script, ScreenGui, RemoteEvent, RemoteFunction, Tool, ModuleScript, camera/input controller, and previous ROTEX-created object in PROJECT CONTEXT. Build a mental map of what owns the requested behavior and what could conflict. List relevant paths explicitly.',
      'SUPER AGENT PASS 3 — CONFLICT & DUPLICATION DETECTION: find any scripts that duplicate the requested behavior or would fight the change. For removal/disable tasks, identify the feature owner. For bug fixes, identify the root cause and any duplicate scripts that would reintroduce it. Plan studio-action delete_instance or set_property blocks for stale/conflicting instances.',
      'SUPER AGENT PASS 4 — COMPLETE EXECUTION: output every file block and studio-action block required. Include server authority, client feedback, RemoteEvents, validation, cleanup, sensible defaults, and error handling. For client systems include respawn/CharacterAdded handling. For server systems include payload validation. Never output half a feature.',
      'SUPER AGENT PASS 5 — VERIFICATION & EDGE CASES: mentally test the change. Check respawns, multiple players, nil characters, missing children, event leaks, permanent camera/input locks, duplicate logic, and incorrect Script vs LocalScript placement. Verify every referenced Instance is created or WaitForChild-ed. If any risk remains, add a guard.',
      'SUPER AGENT PRODUCTION CHECKLIST before final output: (a) request intent satisfied, (b) no duplicate or conflicting behavior, (c) correct Roblox service roots, (d) correct Script/LocalScript/ModuleScript placement, (e) no invented APIs, (f) no missing RemoteEvents, (g) cleanup/disconnects present, (h) server validates client input, (i) no permanent camera/input lock, (j) every file block is complete.',
      'For bug reports, fix the root cause and remove any duplicate script that would keep reintroducing the bug. For removal requests, aggressively delete/disable the feature owner instead of writing code that fights it.',
      'For feature requests, prefer a complete working vertical slice over a tiny partial snippet: include server authority, client feedback, RemoteEvents, validation, cleanup, and sensible defaults when relevant.',
      'Super Agent may touch more files than Agent when needed, but every touched file must be necessary. If safe completion is impossible from context, ask one concise blocking question and name the exact missing fact.',
      'When the user provides a Studio error or runtime output, treat it as the primary signal. Diagnose the exact line and root cause, then produce a fix and verify it cannot happen again with the same inputs.',
    );
  }
  if (projectContext) {
    parts.push(`PROJECT CONTEXT:\n${String(projectContext).slice(0, isPro ? 48000 : 16000)}`);
  }
  return parts.join('\n');
}

async function buildRobloxUiAssetContext(userText) {
  const text = String(userText || '');
  if (!/\b(ui|gui|hud|image|icon|button|menu|shop|inventory|health|stamina|coin|gem|logo|thumbnail|picture|asset)\b/i.test(text)) {
    return '';
  }
  const query = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'game ui icon';
  const urls = [
    `https://apis.roblox.com/toolbox-service/v1/marketplace/13?keyword=${encodeURIComponent(query)}&limit=8`,
    `https://apis.roblox.com/toolbox-service/v1/marketplace/13?keyword=${encodeURIComponent(query + ' icon')}&limit=8`,
  ];
  const ids = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3500) });
      if (!res.ok) continue;
      const data = await res.json();
      for (const item of Array.isArray(data?.data) ? data.data : []) {
        const id = String(item?.id || '').replace(/\D/g, '');
        if (id && !ids.includes(id)) ids.push(id);
        if (ids.length >= 8) break;
      }
    } catch {}
    if (ids.length >= 8) break;
  }
  if (!ids.length) return '';
  return [
    'ROBLOX UI IMAGE ASSET SEARCH:',
    `Query: ${query}`,
    'Use these as ImageLabel/ImageButton Image values when helpful. Prefer rbxassetid://<id>.',
    ids.map((id, index) => `${index + 1}. rbxassetid://${id}`).join('\n'),
    'If none fit, build a polished UI with Frames/UIStroke/UIGradient/UICorner and do not invent fake asset IDs.',
  ].join('\n');
}

function pickTbThinkingModel(selected) {
  return selected.thinkingModel || selected.chatModel || selected.codeModel || selected.testModel;
}

function resolveProviderCall(selected, cleanMessages, opts = {}) {
  const anthropicKey = cleanKey(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY);
  const openRouterKey = cleanKey(process.env.OPENROUTER_API_KEY);
  const groqKey = cleanKey(process.env.GROQ_API_KEY);
  const attempts = [];

  // Agent / Super Agent run on the strongest available Claude models so they
  // reason and plan far better than the base chat models. Super Agent uses the
  // most capable model (Opus); Agent uses a strong, faster model (Sonnet).
  // These are tried first; the model's normal attempts below act as fallback.
  if (anthropicKey && (opts.agent || opts.superAgent)) {
    const smartModel = opts.superAgent
      ? (process.env.ROTEX_SUPERAGENT_MODEL || 'claude-opus-4-8')
      : (process.env.ROTEX_AGENT_MODEL || 'claude-sonnet-4-6');
    attempts.push({
      provider: 'anthropic',
      providerModel: smartModel,
      apiKey: anthropicKey,
    });
  }

  if (selected.route === 'tb-thinking' && groqKey) {
    attempts.push({
      provider: 'groq',
      providerModel: process.env.TB_GROQ_MODEL || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      apiKey: groqKey,
      baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
    });
  }

  if (selected.route === 'tb-thinking' && openRouterKey) {
    const primaryModel = pickTbThinkingModel(selected, cleanMessages || []);
    const fallbacks = selected.thinkingFallbacks || [];
    const allModels = [primaryModel, ...fallbacks.filter(m => m !== primaryModel)];
    for (const m of allModels) {
      if (!m) continue;
      attempts.push({
        provider: 'openrouter',
        providerModel: m,
        apiKey: openRouterKey,
        baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
      });
    }
  }

  // Fallback: if OpenRouter fails for tb-thinking, use Anthropic Haiku
  if (selected.route === 'tb-thinking' && anthropicKey) {
    attempts.push({
      provider: 'anthropic',
      providerModel: process.env.CLAUDE_HAIKU_PINNED_MODEL || 'claude-haiku-4-5-20251001',
      apiKey: anthropicKey,
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
  for (let attemptIndex = 0; attemptIndex < providerCall.attempts.length; attemptIndex++) {
    const attempt = providerCall.attempts[attemptIndex];
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
        if (attemptIndex < providerCall.attempts.length - 1) {
          errors.push(`${attempt.provider}: ${error?.message || error}`);
          continue;
        }
        throw publicProviderError('groq_busy', GROQ_BUSY_TEXT, 429);
      }
      if (attempt.provider === 'openrouter' && insufficientCreditsError(error)) {
        if (selected.route === 'tb-thinking' && attemptIndex < providerCall.attempts.length - 1) {
          errors.push(`${attempt.provider}: ${error?.message || error}`);
          continue;
        }
        if (selected.route === 'tb-thinking') {
          throw publicProviderError('texbrain_busy', 'TexBrain is busy for a moment. Try again in a few seconds.', 503);
        }
        throw publicProviderError('openrouter_credits_empty', OPENROUTER_OUT_TEXT, 503);
      }
      if (attempt.provider === 'openrouter' && groqBusyError(error)) {
        if (attemptIndex < providerCall.attempts.length - 1) {
          errors.push(`${attempt.provider}: ${error?.message || error}`);
          continue;
        }
        throw publicProviderError('texbrain_busy', 'TexBrain is busy for a moment. Try again in a few seconds.', 503);
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
  sseWrite(response, { model: selected.name, devPass: context.devPass || '' });

  const errors = [];
  for (let attemptIndex = 0; attemptIndex < providerCall.attempts.length; attemptIndex++) {
    const attempt = providerCall.attempts[attemptIndex];
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
        if (attemptIndex < providerCall.attempts.length - 1) {
          errors.push(`${attempt.provider}: ${error?.message || error}`);
          continue;
        }
        throw publicProviderError('groq_busy', GROQ_BUSY_TEXT, 429);
      }
      if (attempt.provider === 'openrouter' && insufficientCreditsError(error)) {
        if (selected.route === 'tb-thinking' && attemptIndex < providerCall.attempts.length - 1) {
          errors.push(`${attempt.provider}: ${error?.message || error}`);
          continue;
        }
        if (selected.route === 'tb-thinking') {
          throw publicProviderError('texbrain_busy', 'TexBrain is busy for a moment. Try again in a few seconds.', 503);
        }
        throw publicProviderError('openrouter_credits_empty', OPENROUTER_OUT_TEXT, 503);
      }
      if (attempt.provider === 'openrouter' && groqBusyError(error)) {
        if (attemptIndex < providerCall.attempts.length - 1) {
          errors.push(`${attempt.provider}: ${error?.message || error}`);
          continue;
        }
        throw publicProviderError('texbrain_busy', 'TexBrain is busy for a moment. Try again in a few seconds.', 503);
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
    .map((item) => `${item.name} (${item.providerName}, ${item.access}, ${item.outputTexTokens * (item.multiplier || 1)}x TexTokens/output token): ${item.blurb}`)
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

// Decodes a JWT payload without verifying (cheap pre-check).
function _decodeJwtPayload(token) {
  try {
    const p = String(token).split('.')[1];
    return JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch { return null; }
}

// Verifies a Firebase ID token's RS256 signature against Google's public certs,
// IGNORING expiry. Used only to keep the dev account recognized on a stale token.
// Checks aud + iss so only tokens minted for this Firebase project pass.
async function verifyDevTokenSignature(token) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) return false;
  try {
    const [h, p, s] = String(token).split('.');
    if (!h || !p || !s) return false;
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (payload.aud !== projectId) return false;
    if (payload.iss !== `https://securetoken.google.com/${projectId}`) return false;
    const certsRes = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
    if (!certsRes.ok) return false;
    const certs = await certsRes.json();
    const cert = certs[header.kid];
    if (!cert) return false;
    const crypto = require('crypto');
    return crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), cert, Buffer.from(s, 'base64url'));
  } catch { return false; }
}

async function verifyFirebaseToken(authToken) {
  if (!authToken) {
    return { ok: false };
  }

  const projectId = FIREBASE_PROJECT_ID;

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
    text: sanitizeAssistantText(data.choices?.[0]?.message?.content || 'No response text returned.'),
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
    text: sanitizeAssistantText(text),
    usage: {
      inputTokens: data.usage?.input_tokens || 0,
      outputTokens: data.usage?.output_tokens || 0,
    },
  };
}

function sanitizeAssistantText(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/<analysis>[\s\S]*?(?:<\/analysis>|$)/gi, '')
    .replace(/<\/?(think|analysis)>/gi, '')
    .trim();
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
