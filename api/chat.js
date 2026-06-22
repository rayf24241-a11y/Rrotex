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
const GROQ_BUSY_TEXT = 'That model is busy right now. Try Smart, Claude Haiku, or TexBrain while it cools down.';
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
    projectMode = '',
    texTokensLeft = null,
    superAgent = false,
  } = request.body || {};

  const authResult = await verifyFirebaseToken(authToken); // optional: logged-in users get cloud sync, guests can still chat

  const proPayload = verifyProPass(proPass);
  const isPro = Boolean(proPayload);

  const modelId = resolveModelId(model);
  const selected = MODELS[modelId];
  const userId = proPayload?.uid || authResult.uid || ipFromRequest(request) || 'unknown';
  const userEmail = authResult.email || '';
  const isDev = userEmail === 'rayf24241@gmail.com';

  // Server-side Pro enforcement - locked models reject without a valid pass.
  if (selected.tier === 'pro' && !isPro && !isDev) {
    response.status(402).json({
      error: 'pro_required',
      text: `${selected.name} is a Pro model. Go Pro on rrotex.com to unlock it.`,
    });
    return;
  }

  const ip = ipFromRequest(request);

  // Multi-account: free alt accounts get 0 tokens. Pro accounts are unaffected.
  const linkedMultiAccount = !isDev && isMultiAccount(ip, userId, userEmail);

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
    const usedToday = Math.max(usedByKey, usedByIp);

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
        text: hasPurchased
          ? "You've used all your TexTokens for today. Buy more at rrotex.com/tokens."
          : "You've used your 150k free TexTokens for today. Come back tomorrow, or buy more at rrotex.com/tokens.",
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
      content: buildEditorSystemPrompt(selected, agent, projectContext, isPro, projectMode),
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
        'When asked what models are available or to list the models, output EXACTLY these four lines and nothing else — no intro, no outro:\n**Fast** (Groq Llama 3.1 8B Instant, Free, 0.16x TexTokens/output token) — Cheap\n**Balanced** (Groq Qwen3 32B, Free limited, 1.18x TexTokens/output token) — Normal\n**Smart** (Groq Llama 3.3 70B Versatile, Free small test, 1.58x TexTokens/output token) — Normal\n**Claude Haiku** (Claude Haiku 4.5, Free, 16x TexTokens/output token) — Expensive',
        `You are currently running as: **${selected.name}** (${selected.providerName}). Be honest about what model you are — never claim to be a different model.`,
        `ROTEX model ranking, best to worst: 1st Claude Haiku (Claude Haiku 4.5) → 2nd Smart (Llama 3.3 70B) → 3rd Balanced (Qwen3 32B) → 4th Fast (Llama 3.1 8B). If asked which is best: Claude Haiku. If asked which is worst or least powerful: Fast.`,
        `ROTEX model data (internal): ${modelGuide}`,
        'ROTEX is a desktop and web AI app primarily for Roblox game developers. Website: rrotex.com. Free plan: 150k TexTokens/day, 1M/month, one account per person (multi-account detected and blocked), all models including Claude Haiku, with heavier models costing more TexTokens. Pro: $20/month, 40M TexTokens/month, agent mode, 5 projects. Extra packs: $2.50 per 1M TexTokens. TexToken rates — Fast: 0.16x output, Balanced: 1.18x output, Smart: 1.58x output, Claude Haiku: 16x output. Agent mode 2x cost, Super Agent 4x.',
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
  if (!isPro && !isDev && request._freeKey) {
    const usedByKey = getFreeTokensUsed(request._freeKey);
    const usedByIp  = request._ipKey ? getFreeTokensUsed(request._ipKey) : 0;
    const usedToday = Math.max(usedByKey, usedByIp);
    const effectiveDailyLimit = request._effectiveDailyLimit || FREE_DAILY_TEXTOKENS;
    if (usedToday + estimate.textokens > effectiveDailyLimit) {
      const hasPurchased = effectiveDailyLimit > FREE_DAILY_TEXTOKENS;
      response.status(402).json({
        error: 'no_textokens',
        text: hasPurchased
          ? "You've used all your TexTokens for today. Buy more at rrotex.com/tokens."
          : "You've used your 150k free TexTokens for today. Come back tomorrow, or buy more at rrotex.com/tokens.",
      });
      return;
    }
    addFreeTokensUsed(request._freeKey, estimate.textokens);
    // Also charge the IP-level pool so multiple accounts on the same IP share the quota
    if (request._ipKey && request._ipKey !== request._freeKey) {
      addFreeTokensUsed(request._ipKey, estimate.textokens);
    }
  }

  // Never trust client-provided texTokensLeft for non-Pro users.
  // Free user budget is already enforced above via freeTokenCounters (server-side).
  // Use undefined (not null) so checkCreditSafety skips the TexToken check —
  // Number(null)=0 would wrongly block free users who still have budget.
  // Pro users have a verified proPass, so their client value is used to enforce
  // their own plan limits (the server trusts the pass, not the number).
  const trustedTexTokensLeft = (isPro && !isDev) ? texTokensLeft : undefined;

  const safety = await checkCreditSafety({
    selected,
    provider: providerCall.provider,
    model: selected.providerName || selected.name,
    userId,
    estimate,
    texTokensLeft: trustedTexTokensLeft,
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
- Never invent Roblox APIs, services, events, or properties. If you need a custom RemoteEvent/BindableEvent, create it in the file block before using it. Do not use fake members like ReplicatedStorage.OnGameStart unless the project context shows that exact instance already exists.
- There is no general "game start" event in ReplicatedStorage. For server startup, code runs when the Script starts. For players joining, use Players.PlayerAdded. For character spawn, use player.CharacterAdded.
- RemoteEvents MUST be created on the server first. The correct pattern: a server Script creates the RemoteEvent in ReplicatedStorage, then LocalScripts use WaitForChild to find it. Never assume RemoteEvents exist before being created.
- WaitForChild() when accessing instances that may not exist yet (especially cross-script). Use :WaitForChild("Name", timeout) with a timeout for graceful failure.
- LocalScripts CANNOT read from ServerScriptService — use ReplicatedStorage for anything both sides need.
- ModuleScript state is shared per VM: all server Scripts share one instance of a server module, all LocalScripts share one instance of the client module. Do not store per-player state in a module unless it is keyed by player.
- Touched events fire many times per second — use a debounce table keyed by the touching part or player.
- Character is loaded async: player.CharacterAdded:Wait() or CharacterAppearanceLoaded. Never assume character exists when PlayerAdded fires.
- Destroy() removes an instance AND disconnects all its connections; don't use the object after.
- Humanoid.Health = 0 kills a character; use Humanoid:TakeDamage() to respect ForceField.
- Parts with Anchored = true are not affected by physics.
- Vector3, CFrame, Color3, UDim2, Enum values are value types — assign, don't mutate.
- Instance:FindFirstChildOfClass() is safer than direct name indexing.
- Use task.spawn / task.delay / task.wait instead of spawn / wait / delay (deprecated, slower).
- Always disconnect connections when no longer needed (store :Connect() return value and call :Disconnect()).
- game.Players.LocalPlayer is only accessible in LocalScripts. Using it in a Script returns nil.
- RunService:IsServer() / :IsClient() let a ModuleScript behave differently on each side.

STUDIO WORKFLOW: When the ROTEX plugin is connected, output Lua using \`\`\`file:ServiceName/path/Script.lua\`\`\` blocks so ROTEX can apply them directly to Studio. Use the service name as the root folder (e.g. \`ServerScriptService/Leaderstats.lua\`, \`ReplicatedStorage/Modules/Inventory.lua\`).`,

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

function buildEditorSystemPrompt(selected, agent, projectContext, isPro, projectMode) {
  const parts = [
    'You are ROTEX AI, the coding assistant inside the ROTEX desktop app chat.',
    `You are running as the **${selected.name}** model (${selected.providerName}).`,
    buildEngineSection(projectMode || 'Roblox'),
    'Output only what is needed. No preamble ("Sure!", "Here\'s how...", "Let me help you..."), no closing filler ("Let me know if you need anything else", "Hope this helps!"). Start with the answer — code first, one short explanation line after only if the code alone is not enough.',
    'Write COMPLETE, RUNNABLE code every time. File blocks must contain the full file — no placeholders, no "-- your logic here", no "-- rest of code", no "...", no truncation. Every function must be fully implemented.',
    'Format responses clearly: use bullet points for multiple items, numbered steps for sequences. Avoid walls of text. Keep explanations tight — one sentence per point.',
    'Never output hidden reasoning, chain-of-thought, scratchpad text, or tags such as <think>, </think>, <analysis>, or </analysis>. Output only the final useful answer.',
    'STRICT API ACCURACY: Before writing any API call, service name, event name, or property, verify it is real and documented. Never invent Roblox members, Unity methods, or Blender bpy calls. If unsure whether something exists, say so rather than guessing.',
    'When fixing a bug: state the root cause in one sentence, then output the fixed file block. Nothing else.',
    'When adding a feature: output all modified file blocks directly. Output every file that needs to change — do not leave any out. If a new script is needed alongside an existing one, output both.',
    'Read PROJECT CONTEXT before writing anything. If the user\'s project already has a script at a path, modify that exact script — do not create a duplicate at a different location. Match the existing variable names, RemoteEvent names, and coding patterns in their project.',
    'When showing code changes for a specific file, ALWAYS use a file block: start with ```file:relative/path.ext on its own line, then the COMPLETE new file contents, then a closing ``` line. The editor shows the user a diff and an Apply button for each file block.',
    'The file block header must contain ONLY the path. Put the code on the next line. Correct:\n```file:ServerScriptService/Example.lua\nprint("hello")\n```\nWrong: ```file:ServerScriptService/Example.lua print("hello")```.',
    'For small inline snippets that are not meant to replace a file, use normal ```lang code fences instead.',
    'If PROJECT CONTEXT says the Roblox Studio plugin is CONNECTED, treat Studio as connected even if older chat messages suggest otherwise.',
    'When the user asks you to make/create/add/fix anything in Roblox, ALWAYS output the Lua code in a ```file:ServiceName/path/ScriptName.lua block — not a plain ```lua block. Use service names as the root folder: ServerScriptService, ReplicatedStorage, StarterPlayer, StarterGui, Workspace, ServerStorage, StarterPack. ROTEX auto-applies file blocks to Studio when connected, and shows them ready-to-apply when not. Never tell the user to paste code manually.',
    'For client scripts under StarterPlayerScripts, use paths like ```file:StarterPlayer/StarterPlayerScripts/FirstPersonCamera.client.lua, not ```file:StarterPlayerScripts/FirstPersonCamera.client.lua.',
    'To create 3D models/parts in Studio, use a ```roblox-model block with JSON. Example:\n```roblox-model\n{"name":"Castle","parent":"Workspace","parts":[{"name":"Base","size":[20,1,20],"position":[0,0,0],"color":[128,128,128],"material":"SmoothPlastic","anchored":true},{"name":"Wall","size":[20,10,1],"position":[0,5,-10],"color":[110,110,110],"material":"SmoothPlastic","anchored":true}]}\n```\nROTEX sends this to Studio which creates the real 3D objects. Each part can have: name, size[x,y,z], position[x,y,z], rotation[x,y,z] degrees, color[r,g,b], material (SmoothPlastic/Neon/Glass/Wood/Marble/Metal/Concrete/Fabric/ForceField/Granite/Grass/Ice/Sand/Slate), shape (Block/Ball/Cylinder), anchored, transparency, cancollide, scripts[{name,source}]. The model can also have a top-level "scripts" array for scripts attached to the Model itself.',
    'The PROJECT CONTEXT below contains the full source of all scripts in the user\'s game (auto-scanned when Studio connected). Read them to understand the existing codebase before suggesting changes. When modifying existing scripts, reference the exact script path from the context and output a file block for it.',
  ].filter(Boolean);
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
