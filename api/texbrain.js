const https = require('https');

const OR_KEY = process.env.OPENROUTER_API_KEY || '';
const OR_BASE = 'https://openrouter.ai/api/v1';
const MAX_CONCURRENT = 5;
let activeCalls = 0;

// Models by role
const MODEL_CODER   = 'qwen/qwen3-coder:free';          // 480B MoE — best free coder
const MODEL_CHAT    = 'mistralai/magistral-medium-2509'; // free reasoning — chat/thinking
const MODEL_CODER2  = 'meta-llama/llama-3.3-70b-instruct:free'; // fallback coder
const MODEL_IMAGE   = 'black-forest-labs/flux-1-schnell:free';  // free image gen

// Lightweight Firebase ID token verification.
async function verifyFirebaseToken(authToken) {
  if (!authToken) return { ok: false };
  try {
    const payload = JSON.parse(Buffer.from(authToken.split('.')[1], 'base64').toString());
    if (!payload.sub || !payload.aud || !payload.iss?.includes('firebase')) return { ok: false };
    return { ok: true, uid: payload.sub, email: payload.email || '' };
  } catch {
    return { ok: false };
  }
}

function buildSystemPrompt(projectMode, mode) {
  const engineGuides = {
    Roblox: `SPECIALTY: Roblox game development — Luau scripting, LocalScript/Script/ModuleScript, RemoteEvents, RemoteFunctions, DataStoreService, TweenService, RunService, and Roblox Studio.

KEY RULES FOR ROBLOX:
- Use task.wait(n) NOT wait(n). Use task.spawn() NOT spawn(). Use task.delay() NOT delay(). The deprecated versions are slow and banned.
- RemoteEvents MUST be created by a server Script first; LocalScripts use :WaitForChild("EventName", 10) to find them.
- Always use :WaitForChild("Name", 10) with a timeout before accessing cross-script instances.
- Wrap every DataStore call in pcall — they fail sometimes and will crash your script if unguarded.
- LocalScripts CANNOT access ServerScriptService. Use ReplicatedStorage for shared assets.
- game.Players.LocalPlayer is nil on the server — only use it inside LocalScripts.
- Touched fires constantly — debounce with a table keyed by player to prevent spam.
- Character loads async; use player.CharacterAdded:Wait() before accessing the character.
- Use Humanoid:TakeDamage(amount) not Humanoid.Health = 0 (respects ForceField).
- Always :Disconnect() connections when done to prevent memory leaks.

For casual or off-topic messages, respond naturally in 1-2 sentences without code.`,
    Unity: 'SPECIALTY: Unity game development — C# scripting, MonoBehaviour lifecycle (Awake→Start→FixedUpdate→Update→LateUpdate), Unity APIs, GameObjects, Rigidbody physics, Animator, NavMeshAgent, Input System, TextMeshPro. Cache GetComponent in Awake. Use Coroutines for async sequences. Never hallucinate Unity APIs that do not exist. For casual messages, respond naturally in 1-2 sentences without code.',
    Blender: 'SPECIALTY: Blender 3D — Python/bpy scripting, modeling, geometry nodes, shaders (Cycles/EEVEE), rigging, animation, and rendering. Use bpy.data over bpy.ops for stability in scripts. bmesh for geometry editing in Edit mode. For casual messages, respond naturally in 1-2 sentences without code.',
    'Roblox+Blender': 'SPECIALTY: Roblox game development (Luau) and Blender 3D (bpy) for creating assets for Roblox games. Same Roblox rules apply (task.wait, WaitForChild, pcall DataStores). For Blender: apply transforms before FBX export, Y-up, FBX Units Scale. For casual messages, respond naturally in 1-2 sentences without code.',
    'Unity+Blender': 'SPECIALTY: Unity (C#) and Blender 3D (bpy) for creating assets for Unity projects. Apply all transforms in Blender before export. Normal maps from Blender are OpenGL; Unity HDRP/URP needs DirectX — flip the G channel. For casual messages, respond naturally in 1-2 sentences without code.',
  };
  const engine = (projectMode || 'Roblox').trim();
  const engineFocus = engineGuides[engine] || engineGuides['Roblox'];

  const modeInstructions = {
    agent: 'AGENT MODE: you may edit the project. Output the smallest complete fix. Use existing scripts when possible; avoid duplicates. Every code change MUST be in a ```file:ServiceName/path/ScriptName.lua block. If you write code outside a file block, ROTEX cannot apply it to Roblox Studio.',
    supreme: 'SUPER AGENT MODE: you may perform deeper multi-step edits. Inspect for conflicts, update or delete owning scripts, add missing server/client pieces, create RemoteEvents if needed, include cleanup, and verify the final behavior does not fight itself. Every code change MUST be in a ```file:ServiceName/path/ScriptName.lua block. If you write code outside a file block, ROTEX cannot apply it to Roblox Studio.',
  };
  const modeInstruction = modeInstructions[mode] || '';

  return [
    'You are TexBrain, the ROTEX AI coding assistant.',
    engineFocus,
    'You receive live ROTEX Studio context: script paths, source snippets, selected instances, experience name, and plugin status. Treat that context as your view of the project. If the context is present, do not say you cannot see the project.',
    'You cannot directly inspect raw pixels or screenshots unless their content is described in text.',
    'Classify every request first: answer-only, plan-only, create, modify, remove/disable, debug, inspect, or verify. Then perform exactly that class. Do not ask questions you can answer from the provided context.',
    'For non-coding greetings or casual chat, reply in 1–2 sentences and never attach code.',
    'THINKING PROTOCOL: reason step by step about the simplest correct design, edge cases (respawn, multiple players, exploits, mobile, cleanup), and the exact Roblox services that own the behavior. Keep this reasoning internal; output only the final solution.',
    'ROBLOX QUALITY BAR: correct client/server boundaries, RemoteEvents created server-side and WaitForChild-ed by clients, debounces keyed per-player, connections disconnected, task.wait/task.spawn (never deprecated globals), pcall around DataStore/HttpService, and sensible defaults. Use only documented APIs you are certain exist; never invent Roblox members.',
    'MODIFY-EXISTING RULE: if the project context already contains a script that owns the behavior, modify or delete that exact script. Do not create duplicates with similar names.',
    'REMOVAL RULE: if the user says remove, undo, turn off, disable, stop, or get out of something, delete or disable the owning script, or clearly say which script should be deleted/disabled. Never rewrite the feature back in.',
    'PATH FORMAT: use ServiceName/path/ScriptName.lua. Valid roots: ServerScriptService, ReplicatedStorage, StarterPlayer/StarterPlayerScripts, StarterGui, Workspace, ServerStorage, StarterPack. StarterPlayerScripts must be under StarterPlayer/StarterPlayerScripts/Name.client.lua.',
    'CLEANUP RULE: long-running behavior must disconnect events, handle respawns, restore CameraType/MouseBehavior when disabling camera systems, and avoid leaving players stuck.',
    'CODE COMPLETENESS: every file must be runnable with no placeholders like "-- rest of code" or "...". Implement every function fully.',
    'FILE-BLOCK RULE: when you write or modify Roblox Lua scripts, EVERY code change MUST be wrapped in ```file:ServiceName/path/ScriptName.lua blocks. Do NOT use plain ```lua or ```luau blocks — ROTEX cannot apply those. Use exactly this format (the path must be on the same line as the opening backticks):\n```file:ServerScriptService/DashSystem.lua\n-- complete code here\n```\nYou may output multiple file blocks in one response. After the file blocks, keep any explanation to one sentence.',
    'Before finalizing, self-check: does the solution match the request, are client/server boundaries correct, is cleanup present, and is every referenced Instance created or accessed with WaitForChild?',
    modeInstruction,
  ].filter(Boolean).join('\n');
}

function orPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const req = https.request({
      hostname: 'openrouter.ai',
      path: `/api/v1${endpoint}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Authorization': `Bearer ${OR_KEY}`,
        'HTTP-Referer': 'https://rrotex.com',
        'X-Title': 'ROTEX TexBrain',
      },
    }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`OpenRouter HTTP ${res.statusCode}: ${d.slice(0, 400)}`));
          return;
        }
        try { resolve(JSON.parse(d)); } catch { reject(new Error(`parse error — raw: ${d.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(postData);
    req.end();
  });
}

// Detect if the user's last message is asking for an image
function isImageRequest(text) {
  return /\b(generate|create|draw|make|render|show)\b.{0,40}\b(image|picture|photo|illustration|art|logo|icon|sprite|texture)\b/i.test(text)
    || /\b(image|picture|photo|illustration|art|logo|icon|sprite|texture)\b.{0,40}\b(of|for|showing|with)\b/i.test(text);
}

// Pick model based on request type and mode
function pickModel(lastUserMsg, mode) {
  const coding = /\b(script|code|lua|luau|function|class|bug|fix|debug|create|make|add|remove|delete|disable|modify|update|implement|build|system|tool|gui|ui|camera|event|remote|datastore)\b/i.test(lastUserMsg);
  if (coding || mode === 'agent' || mode === 'supreme') return MODEL_CODER;
  return MODEL_CHAT;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }

  const { authToken, messages = [], projectMode = 'Roblox', mode = '' } = req.body || {};
  const auth = await verifyFirebaseToken(authToken);
  if (!auth.ok) {
    res.status(401).json({ error: 'Please sign in to use TexBrain.' });
    return;
  }

  if (!OR_KEY) {
    res.status(500).json({ error: 'TexBrain is not configured. Contact support.' });
    return;
  }

  if (activeCalls >= MAX_CONCURRENT) {
    res.status(429).json({ error: 'Too many people are using TexBrain right now (beta). Try again in a moment!' });
    return;
  }
  activeCalls++;

  try {
    const normalizedMessages = (messages || []).map(m => ({
      role: m.role,
      content: Array.isArray(m.content)
        ? m.content.filter(p => p.type === 'text').map(p => p.text).join('\n')
        : m.content,
    }));

    const contextMessages = normalizedMessages
      .filter(m => m.role === 'system' && /\b(Studio|PROJECT SCRIPTS|CURRENTLY SELECTED|Plugin|Experience)\b/i.test(String(m.content || '')))
      .slice(-2);
    const history = normalizedMessages.filter(m => m.role !== 'system').slice(-8);
    const lastUserMsg = history.filter(m => m.role === 'user').slice(-1)[0]?.content || '';

    // Image generation path
    if (isImageRequest(lastUserMsg)) {
      const imgResult = await orPost('/images/generations', {
        model: MODEL_IMAGE,
        prompt: lastUserMsg,
        n: 1,
        size: '1024x1024',
      });
      const url = imgResult?.data?.[0]?.url;
      if (url) {
        res.status(200).json({ text: `![Generated image](${url})`, model: MODEL_IMAGE });
      } else {
        res.status(200).json({ text: '(Image generation returned no result)', model: MODEL_IMAGE });
      }
      return;
    }

    const model = pickModel(lastUserMsg, mode);
    const systemPrompt = buildSystemPrompt(projectMode, mode);

    // Optional: clarify coding tasks with the fast model before main call
    let clarified = lastUserMsg;
    const isCodingTask = /\b(make|create|add|fix|debug|build|implement|change|update|remove|delete|disable|turn off|get out of|undo|script|camera|gui|ui|tool|system)\b/i.test(lastUserMsg);
    if (isCodingTask) {
      try {
        const clarifyRes = await orPost('/chat/completions', {
          model: MODEL_CODER2,
          temperature: 0.1,
          max_tokens: 120,
          messages: [
            { role: 'system', content: `You are a code task clarifier for a ${projectMode} developer. Restate the user's request as a precise technical task in 1-2 sentences. Preserve removal/disable/undo intent exactly; never turn "remove/disable/get out of" into "create/add". Do not answer it. Output only the restated task.` },
            { role: 'user', content: lastUserMsg },
          ],
        });
        clarified = clarifyRes.choices?.[0]?.message?.content?.trim() || lastUserMsg;
      } catch { /* fallback to original */ }
    }

    const workerMessages = [
      { role: 'system', content: systemPrompt },
      ...contextMessages,
      ...history.slice(0, -1),
      { role: 'user', content: clarified },
    ];

    let result = await orPost('/chat/completions', {
      model,
      temperature: 0.2,
      top_p: 0.8,
      max_tokens: 4096,
      messages: workerMessages,
    });

    // Fallback to MODEL_CODER2 if primary model fails or returns empty
    const text = result.choices?.[0]?.message?.content?.trim();
    if (!text) {
      result = await orPost('/chat/completions', {
        model: MODEL_CODER2,
        temperature: 0.2,
        top_p: 0.8,
        max_tokens: 4096,
        messages: workerMessages,
      });
    }

    const finalText = result.choices?.[0]?.message?.content?.trim() || '(no response)';
    const usedModel = result.model || model;
    res.status(200).json({ text: finalText, model: usedModel });
  } catch (err) {
    res.status(500).json({ error: `TexBrain error: ${err.message}` });
  } finally {
    activeCalls--;
  }
};
