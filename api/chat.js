const AdmZip = require('adm-zip');
const { verifyProPass, signProPass } = require('./_lib/propass.js');
const { MODELS, resolveModelId } = require('./_lib/catalog.js');
const { userHasActiveProSubscription } = require('./_lib/stripe.js');
const { CATEGORIES, routeCategory, THINKING_LEVEL_TO_EFFORT } = require('./_lib/categories.js');
const { buildRobloxDevModeBrief } = require('./_lib/roblox-dev-mode.js');
const { handlePluginBridge } = require('./_lib/plugin-bridge-core.js');
const tokenWallet = require('./_lib/token-wallet.js');
const accountGuard = require('./_lib/account-guard.js');
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
// Server-authoritative purchased TexToken balance. Read from Firestore with the
// user's own ID token -- the request body's texTokensLeft is NEVER trusted for
// entitlement, so a user can't inflate their daily cap by sending a fake number.
// Fail-safe: any error returns 0 (base free tier), never an inflated cap.
async function readBalance(uid, authToken) {
  if (!uid || !authToken || !FIREBASE_PROJECT_ID) return 0;
  try {
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(FIREBASE_PROJECT_ID)}/databases/(default)/documents/users/${encodeURIComponent(uid)}/billing/textokens`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${authToken}` } });
    if (!res.ok) return 0;
    const doc = await res.json();
    return _fsNum(doc.fields?.balance);
  } catch { return 0; }
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

// 3D modeling (roblox-model / create_model) creates real, persistent geometry
// in the game rather than just editing a script -- a distinct, higher-value
// capability that carries a premium on top of normal token-based pricing.
// Applied uniformly across TexBrain, Claude Haiku, and Google Flash.
const MODELING_COST_MULTIPLIER = 1.5;

// Best-effort abuse protection. In-memory, so it resets on cold starts —
// it stops casual abuse of the open endpoint, not a determined attacker.
const FREE_DAILY_TEXTOKENS = 150_000;
let _warnedNoWallet = false; // one-time warn when KV wallet isn't configured
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
const OPENROUTER_OUT_TEXT = 'The selected AI route failed after trying backup models. Try again now, or switch models for this message.';
const PROVIDER_FAILED_TEXT = 'The AI provider failed this request after trying fallback models. Your OpenRouter balance is not the problem. Try again now, or switch models for this message.';

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
  const isCode = mode === 'agent' || mode === 'supreme';
  const engine = (projectMode || 'Roblox').trim();

  const unityRules = engine.includes('Unity') ? `\nUnity C# rules: cache GetComponent in Awake, use Coroutines for async, no missing UnityEngine APIs.` : '';
  const blenderRules = engine.includes('Blender') ? `\nBlender bpy rules: prefer bpy.data over bpy.ops, bmesh for geometry, apply transforms before export.` : '';

  if (isCode && engine.includes('Roblox')) {
    return `You are a senior Roblox Luau engineer inside ROTEX. Your job is to build WHATEVER the user asks for -- health bars, mana, XP, inventory, shops, quest systems, NPCs, combat, leaderboards, tools, terrain, vehicles, minigames, admin commands, anything. Do not assume every request is about stamina or sprinting; that only comes up below because it's a compact way to demonstrate the required lifecycle pattern, not because it's the thing you build. Read the user's actual request and build exactly that, with the same quality bar.

OUTPUT FORMAT — required every time:
One sentence describing what you made or changed.
\`\`\`file:StarterPlayer/StarterPlayerScripts/FeatureName.lua
-- full working Luau code
\`\`\`

FILE PATHS:
- Client (GUI / HUD / bars / input / camera / any player-facing feature) → StarterPlayer/StarterPlayerScripts/Name.lua
- Server (game logic / datastores / kills / admin) → ServerScriptService/Name.lua
- Shared (modules / events) → ReplicatedStorage/Modules/Name.lua
If modifying an existing script, use the EXACT path from the project context above.
One file per feature. Do NOT split a client feature into separate UI + logic files.

REWRITE RULE: If the existing script in project context is missing the player.Character pre-check OR has a nil-check error in RunService, rewrite it completely from scratch using the correct pattern below. Do not preserve broken lifecycle code.

LIFECYCLE PATTERN — this example happens to be a stamina bar, but the SAME structure (character pre-check, CharacterAdded hook, nil-guarded Heartbeat, input handling) applies to any client feature: health bars, mana, hunger, cooldown UI, ability meters, whatever the user actually asked for. Copy the STRUCTURE, not the stamina-specific variable names:
\`\`\`lua
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")
local player = Players.LocalPlayer
local humanoid = nil

local MAX_STAMINA = 100
local DRAIN = 20
local REGEN = 10
local SPRINT_SPEED = 24
local WALK_SPEED = 16
local stamina = MAX_STAMINA
local sprinting = false
local exhausted = false

-- GUI
local gui = Instance.new("ScreenGui")
gui.Name = "StaminaGui"
gui.ResetOnSpawn = false
gui.Parent = player:WaitForChild("PlayerGui")
local bg = Instance.new("Frame", gui)
bg.Size = UDim2.new(0, 200, 0, 14)
bg.Position = UDim2.new(0, 20, 1, -40)
bg.BackgroundColor3 = Color3.fromRGB(30, 30, 30)
bg.BorderSizePixel = 0
Instance.new("UICorner", bg).CornerRadius = UDim.new(0, 7)
local fill = Instance.new("Frame", bg)
fill.Size = UDim2.new(1, 0, 1, 0)
fill.BackgroundColor3 = Color3.fromRGB(60, 200, 80)
fill.BorderSizePixel = 0
Instance.new("UICorner", fill).CornerRadius = UDim.new(0, 7)

-- CORRECT character pattern: check existing character FIRST
local function onCharacter(char)
    humanoid = char:WaitForChild("Humanoid")
    humanoid.WalkSpeed = WALK_SPEED
    stamina = MAX_STAMINA
    exhausted = false
end
if player.Character then onCharacter(player.Character) end
player.CharacterAdded:Connect(onCharacter)

-- Input (never disconnect inside these handlers)
UserInputService.InputBegan:Connect(function(i, gp) if not gp and i.KeyCode == Enum.KeyCode.LeftShift then sprinting = true end end)
UserInputService.InputEnded:Connect(function(i) if i.KeyCode == Enum.KeyCode.LeftShift then sprinting = false end end)

RunService.Heartbeat:Connect(function(dt)
    if not humanoid then return end  -- ALWAYS nil-check
    local isSprinting = sprinting and not exhausted
    if isSprinting then
        stamina = math.max(0, stamina - DRAIN * dt)
        if stamina == 0 then exhausted = true end
    else
        stamina = math.min(MAX_STAMINA, stamina + REGEN * dt)
        if stamina >= 20 then exhausted = false end
    end
    humanoid.WalkSpeed = isSprinting and SPRINT_SPEED or WALK_SPEED
    local r = stamina / MAX_STAMINA
    fill.Size = UDim2.new(r, 0, 1, 0)
    fill.BackgroundColor3 = exhausted and Color3.fromRGB(200,50,50) or r < 0.3 and Color3.fromRGB(220,150,30) or Color3.fromRGB(60,200,80)
end)
\`\`\`

LUAU RULES:
- task.wait / task.spawn / task.delay only — never wait() / spawn() / delay()
- RemoteEvents: create on server in ReplicatedStorage, access on client with :WaitForChild("Name", 10)
- pcall all DataStore calls. Humanoid:TakeDamage(n) not Health = 0.
- Zero placeholders. Full runnable script every time.

MANDATORY PROJECT SEARCH PASS: before writing a single line of code, actually work through the project context in order — (1) does a script already own this feature under ANY name variant (Shop/ShopUI/ShopSystem are the same thing)? (2) what naming conventions, RemoteEvent names, and module structure does this project already use, so new code matches instead of introducing a second style? (3) are there existing modules/services this feature should build on rather than duplicate (an existing DataStore wrapper, an existing RemoteEvents folder, an existing state-management pattern)? Do not skip this because the request seems simple — a fast wrong answer that ignores existing project structure is worse than a slower correct one. Take the time this requires.

ROBLOX SYSTEM PATTERNS — apply the correct idiom for whatever the user actually asks for (combat, economy, NPCs, building, minigames, admin, quests, all equally in scope, not just UI bars):
- COMBAT/DAMAGE: server owns the hit — client fires a RemoteEvent on swing/shoot, server validates range/cooldown/line-of-sight with a debounce table keyed by attacker, then calls Humanoid:TakeDamage. Never trust a client-reported damage number or hit result.
- ECONOMY/CURRENCY: a server-side table keyed by player (or a leaderstats IntValue) is the source of truth. Purchases go through a RemoteEvent the server validates (enough currency, item exists) before deducting and granting — never let the client just set its own currency display and assume it's real. Persist with DataStoreService, pcall'd, using UpdateAsync for anything incremented (not overwritten) to survive concurrent saves.
- NPCS: PathfindingService:CreatePath() + ComputeAsync() + GetWaypoints(), walk a Humanoid to each waypoint with MoveTo() and wait for MoveToFinished or a timeout (never a blind task.wait). Dialogue/interaction via ProximityPrompt is simpler and more reliable than click-detection for NPC conversations.
- BUILDING/PLACEMENT: a client-side preview part (CanCollide false, semi-transparent, following the mouse/camera raycast, snapped to a grid with math.floor(pos/gridSize)*gridSize) that only becomes a real, collidable, server-confirmed part when placement is confirmed via RemoteEvent — the server validates the position isn't overlapping/out of bounds before creating the real part.
- ROUND-BASED/MINIGAMES: an explicit state machine (e.g. "Waiting", "Starting", "InRound", "Ending") as a single source of truth (a StringValue or module-level variable), driven by a server loop, with all clients reading state via RemoteEvent/attribute changes rather than each client guessing independently.
- ADMIN/MODERATION: gate every admin RemoteEvent on the SERVER by checking the calling player's UserId against an admin list — never trust a client-side "is admin" flag, since the client can be freely modified.

"REVAMP"/"OVERHAUL"/"UPDATE"/"IMPROVE"/"POLISH" RULE: these words mean the user wants a SUBSTANTIAL change, not a minimal diff. A trivial or cosmetic-only edit while claiming you "revamped" or "updated" it is a lie -- meaningfully improve structure, completeness, visuals (spacing, corners, hover feedback, readable contrast, not raw default Frames), and robustness, then describe what actually changed. Your output competes directly with dedicated Roblox AI coding tools -- match or exceed that bar every time, no placeholders, no half-finished features.

DUPLICATE/BUG-REPORT RULE — critical for "buggy", "late", "two of them", "another one" reports:
If the user reports a visual bug (a bar/GUI appears late, flickers, or a second copy shows up underneath/behind the first), the cause is almost always TWO scripts creating the same GUI. Scan the project context for EVERY script whose name or created ScreenGui overlaps with the reported feature (e.g. "Stamina", "StaminaUI", "StaminaSystem", "StaminaBar" are all the same feature under different names). Keep exactly ONE owner script, output its corrected file block, and output a studio-action delete_instance block for every other one — even names that don't look identical. "It spawns in late" from an old duplicate still running its own WaitForChild chain is a symptom of this, not something to patch with more waiting.

"I CAN'T SEE IT" / "IT'S NOT SHOWING UP" RULE: this means an EXISTING feature has a VISIBILITY bug, NOT that it needs to be rebuilt from scratch. NEVER create a new script/GUI for this report. Find the EXISTING owner script in PROJECT CONTEXT (by feature name -- Shop/ShopUI/ShopGui/ShopSystem are the same feature) and diagnose the actual cause in that script, most commonly: ScreenGui.Enabled left false, the Frame/GUI parented somewhere other than PlayerGui, zero Size or a Position that puts it off-screen, ZIndex/SiblingIndex buried behind another GUI, ResetOnSpawn wiping it on respawn, or an open/toggle function that's defined but never actually connected to a button or keybind so it never runs. Output ONE corrected file block for the existing script with the specific bug fixed. If a genuine duplicate is ALSO found while investigating, delete the duplicate too -- but the primary fix is repairing the existing owner, not adding a new one.

3D MODELING: To place actual parts/geometry in the 3D world (not scripts), use a roblox-model block instead of a file block:
\`\`\`roblox-model
{"name":"Castle","parent":"Workspace","parts":[{"name":"Base","class":"Part","size":[20,1,20],"position":[0,0,0],"color":[128,128,128],"material":"SmoothPlastic","anchored":true},{"name":"Wall","class":"Part","size":[20,10,1],"position":[0,5,-10],"rotation":[0,0,0],"material":"SmoothPlastic","anchored":true}]}
\`\`\`
Each part: name, class (Part/MeshPart/SpawnLocation — default Part), size[x,y,z], position[x,y,z], rotation[x,y,z] degrees, color[r,g,b], material (SmoothPlastic/Neon/Glass/Wood/Marble/Metal/Concrete/Fabric/ForceField/Granite/Grass/Ice/Sand/Slate), shape (Block/Ball/Cylinder, Part class only), anchored, transparency, cancollide. This creates real Instances in Studio — never fake this with a Lua script that runs Instance.new at runtime unless the user specifically wants it spawned dynamically at play time.

STARTING ITEMS / TOOL MODELS ("make a model for a sword", "spawn with a sword", "give everyone a tool"): NEVER use roblox-model/create_model for a Tool — it always wraps its parts inside a generic Model instance, not a Tool, so the result is a decorative object in StarterPack that is NOT equippable and nothing appears in the player's hand or Backpack. A Tool MUST be built with Instance.new("Tool") in a Lua script, with a part literally named "Handle" as its direct child (required for grip). To make it actually look like the requested item instead of a plain block, add extra visual parts welded to the Handle: use Instance.new("WeldConstraint") between Handle and each extra part, and CFrame the extra parts relative to Handle's CFrame BEFORE parenting them.
\`\`\`lua
local tool = Instance.new("Tool")
tool.Name = "Sword"
tool.RequiresHandle = true
tool.CanBeDropped = true

local handle = Instance.new("Part")
handle.Name = "Handle"
handle.Size = Vector3.new(0.4, 3, 0.4)
handle.Color = Color3.fromRGB(60, 60, 60)
handle.Material = Enum.Material.Metal
handle.CanCollide = false
handle.Parent = tool

local blade = Instance.new("Part")
blade.Name = "Blade"
blade.Size = Vector3.new(0.2, 3.5, 0.6)
blade.Color = Color3.fromRGB(200, 200, 210)
blade.Material = Enum.Material.Metal
blade.CanCollide = false
blade.CFrame = handle.CFrame * CFrame.new(0, 3, 0)
blade.Parent = tool

local weld = Instance.new("WeldConstraint")
weld.Part0 = handle
weld.Part1 = blade
weld.Parent = handle

tool.Parent = game:GetService("StarterPack")
\`\`\`
A Tool placed directly (not nested inside anything) in StarterPack automatically clones into every player's Backpack on spawn — do not use a PlayerAdded script unless the user wants conditional/one-time granting. Give the Tool real Equipped/Activated behavior matching what the user asked for (swing animation, damage on touch, etc.) — never leave it as a static prop with no function.

DELETION: If asked to delete/remove a script:
\`\`\`studio-action
{"type":"delete_instance","path":"StarterPlayer/StarterPlayerScripts/ScriptName"}
\`\`\`

Only skip the file block if the user asks a pure question — then reply in 1-2 sentences.`;
  }

  if (isCode) {
    return `You are a code-writing assistant for ${engine} inside ROTEX. Write complete, working scripts in file blocks.
\`\`\`file:ServiceName/ScriptName.lua
-- full working code
\`\`\`
${unityRules}${blenderRules}
Full runnable code every time. Zero placeholders.`;
  }

  // Ask / Plan mode — no code output expected
  return `You are a helpful ${engine} game development assistant inside ROTEX. Answer questions, explain concepts, and help plan features. Keep responses short and direct. Do not output code blocks unless the user specifically asks to see code.`;
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

async function tbOrPost(endpoint, body, timeoutMs = 25000) {
  const postData = JSON.stringify(body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://openrouter.ai/api/v1${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OR_KEY}`,
        'HTTP-Referer': 'https://rrotex.com',
        'X-Title': 'ROTEX TexBrain',
      },
      body: postData,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

// ─── ROTEX Free Planner Coach + Living Project Spec ─────────────────────────
// A free-model pre-pass that runs BEFORE the main model call and produces two
// things in one response:
//   1. A structured per-request PLAN (REAL GOAL / MODE / TODO PLAN /
//      IMPORTANT CONTEXT / VERIFY BEFORE FINAL) -- the real implementation of
//      the "hidden ROTEX Free Planner Coach" the category prompts reference.
//   2. The living PROJECT SPEC (# TITLE + * bullets) that turns a rough ask
//      ("I want a fighting game!") into a design brief and keeps it UPDATED
//      (not regenerated, not blindly appended) as scope grows. The spec is
//      persisted per-chat client-side and round-trips through every request.
// Hard-capped at 9s and fail-open on every error path, so it can never
// block or degrade the main response. usage is deliberately discarded --
// this is a free-model call and must never touch TexToken cost accounting.
const PROJECT_SPEC_CAP = 4000; // matches the projectMemory cap in buildEditorSystemPrompt
const PLANNER_PLAN_CAP = 3000;

function buildPlannerPrompt(currentSpec, userMessage, projectMode) {
  const spec = String(currentSpec || '').trim().slice(0, PROJECT_SPEC_CAP);
  const message = String(userMessage || '').trim().slice(0, 4000);
  return [
    {
      role: 'system',
      content: [
        'You are the ROTEX Free Planner Coach: a hidden planning AI that tells the main coding AI exactly what to do. For every user request, create a plan using these 5 upgrades:',
        '1. Understand the real goal: explain what the user is actually trying to do in 1-2 sentences. If they are vague, make the best safe assumption and continue.',
        '2. Break it into steps: a short numbered TODO list. Each step simple, clear, and in the correct order.',
        '3. Choose the right mode. Pick exactly one: Roblox coding, Unity coding, Website coding, UI/design, Debugging, AI app builder, Asset/model help, Business/plans, General answer.',
        '4. Add context the main AI needs: the important details, files, scripts, bugs, tools, limits, and style it should remember. Do not include useless info.',
        '5. Check before finishing: a verification checklist so the main AI can test its work, find bugs, and improve the answer before sending it.',
        'You ALSO maintain the living PROJECT SPEC: a Markdown design brief for the whole project (one "# TITLE" line then "* bullet" lines, one short feature per bullet).',
        'Spec rules: if the message introduces NO new project scope (a question, bug report, or tweak to something already listed), return the CURRENT SPEC completely unchanged, character for character. If it introduces new scope, merge it in -- add or rewrite affected bullets, keep unrelated bullets exactly as they were, never append duplicates. If CURRENT SPEC is empty and the message describes something to build, create a fresh spec with a short # TITLE and 2-6 bullets capturing only what was actually said. If CURRENT SPEC is empty and nothing is being built, output (none) for that section.',
        'Output EXACTLY this format, nothing else -- no preamble, no closing remarks, no code fences, no <think> tags:',
        'REAL GOAL:\n[what the user wants]\n\nMODE:\n[chosen mode]\n\nTODO PLAN:\n1. [step]\n2. [step]\n3. [step]\n\nIMPORTANT CONTEXT:\n- [detail]\n- [detail]\n\nVERIFY BEFORE FINAL:\n- Does it actually solve what the user asked for?\n- Did it use the right mode (code vs prompt vs plan vs advice)?\n- Is it beginner-friendly and not too long?\n- Does it say where each file/script goes?\n- Are any files, scripts, or steps missing?\n- Could it break Roblox/Unity/website code?\n- Did it avoid guessing, and offer a better option if one exists?\n- Is the final answer ready to paste/use?\n\nPROJECT SPEC:\n# TITLE\n* bullet\n* bullet',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `PROJECT ENGINE: ${String(projectMode || 'Roblox')}\n\nCURRENT SPEC:\n${spec || '(none yet)'}\n\nUSER'S LATEST MESSAGE:\n${message}\n\nNow create the plan for this user request.`,
    },
  ];
}

// Never throws; on ANY failure (timeout, HTTP error, empty or shape-invalid
// output) returns { plan: '', spec: <unchanged current spec> }.
async function generatePlannerBrief(currentSpec, userMessage, projectMode) {
  const fallbackSpec = String(currentSpec || '').trim().slice(0, PROJECT_SPEC_CAP);
  const fallback = { plan: '', spec: fallbackSpec };
  try {
    const result = await tbOrPost('/chat/completions', {
      model: process.env.PROJECT_SPEC_MODEL || 'qwen/qwen3-coder:free',
      messages: buildPlannerPrompt(fallbackSpec, userMessage, projectMode),
      max_tokens: 1200,
      temperature: 0.3,
    }, 9000);
    const text = String(result?.choices?.[0]?.message?.content || '').trim();
    if (!text) return fallback;

    // Split the spec section off the end of the plan. Each half is shape-
    // gated independently, so a malformed half is dropped without losing
    // the good half -- never inject junk into the main model's prompt.
    const splitAt = text.search(/^PROJECT SPEC:\s*$/m);
    const planPart = (splitAt === -1 ? text : text.slice(0, splitAt)).trim();
    const specPart = (splitAt === -1 ? '' : text.slice(splitAt).replace(/^PROJECT SPEC:\s*/m, '')).trim();

    const plan = /^REAL GOAL:/m.test(planPart) && /^MODE:/m.test(planPart) && /^TODO PLAN:/m.test(planPart)
      ? planPart.slice(0, PLANNER_PLAN_CAP)
      : '';
    const spec = specPart && /^#\s+\S/m.test(specPart) && /^\*\s+\S/m.test(specPart)
      ? specPart.slice(0, PROJECT_SPEC_CAP)
      : fallbackSpec;
    return { plan, spec };
  } catch {
    return fallback;
  }
}

// If the model returned plain ```lua blocks (ignoring the file: format instruction),
// try to infer the correct path from context and upgrade them to ```file: blocks.
function tbFixPlainLuaBlocks(text, contextMsgs, lastUserMsg) {
  // Already has a COMPLETE, well-formed file: block — nothing to fix. Must
  // match the client's actual extraction regex (closing fence required), not
  // just check for the substring "```file:" anywhere in the text. A model can
  // ramble into a malformed, unclosed ```file: fragment after an otherwise
  // valid plain ```lua block (seen live: llama-3.3-70b-versatile trailed off
  // mid-response into "```file:Path\nOne sentence describing..." with no
  // closing fence) -- the loose check let that garbage fragment block this
  // fixer from ever converting the real, complete ```lua block, so nothing
  // got applied to Studio even though the code itself was correct.
  if (/```file:[^\n`]+\n[\s\S]*?```/.test(text)) return text;
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
    // Match compound names like "StaminaSystem", "JumpScript", etc. The
    // "script <word>" pattern has no required suffix, so on a rambling
    // sentence like "a script that spawns..." it happily captures the filler
    // word "that" as the script name (seen live: ServerScriptService/that.lua).
    // Reject common filler/stop words so it falls through to a better guess.
    const FILLER_WORDS = /^(?:that|this|it|which|who|what|to|a|an|the|and|for|with|so|is|are|will|can|should)$/i;
    let compoundMatch = text.match(/(?:script|Script)\s+[`"']?([\w]+(?:Script|Handler|System|UI|Controller|Bar|Manager|GUI)?)[`"']?/i);
    if (compoundMatch && FILLER_WORDS.test(compoundMatch[1])) compoundMatch = null;
    compoundMatch = compoundMatch
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

  // This route is dispatched purely by URL path (see the handler at the
  // bottom of this file), not through resolveModelId(), so hiding TexBrain
  // from the model catalog alone doesn't stop a direct request here. Same
  // enabled: false gate as resolveModelId -- this is the actual server-side
  // enforcement; a tampered client or a raw request against this endpoint
  // can't bypass it.
  if (MODELS['texbrain-thinking']?.enabled === false) {
    res.status(404).json({ error: 'TexBrain is not currently available.' });
    return;
  }

  const { authToken, messages = [], projectMode = 'Roblox', mode = '', proPass = '' } = req.body || {};
  const tbAuth = tbVerifyToken(authToken);
  if (!tbAuth.ok) { res.status(401).json({ error: 'Please sign in to use TexBrain.' }); return; }
  if (!OR_KEY && !GROQ_KEY) { res.status(500).json({ error: 'TexBrain is not configured.' }); return; }
  if (tbActiveCalls >= TB_MAX_CONCURRENT) { res.status(429).json({ error: 'Too many people are using TexBrain right now (beta). Try again in a moment!' }); return; }

  // Free-plan daily request cap (distinct from the TexToken budget): this handler
  // is a separate code path from the main /api/chat handler's freeDailyCap check
  // above, so texbrain-thinking needs its own enforcement here. Pro subscribers
  // and the dev account are exempt.
  const tbIsPro = Boolean(verifyProPass(proPass));
  const tbEmail = _decodeJwtPayload(authToken)?.email || '';
  const tbIsDev = tbEmail === 'rayf24241@gmail.com';
  const tbCap = MODELS['texbrain-thinking'].freeDailyCap;
  if (!tbIsPro && !tbIsDev && tbCap) {
    const tbUsed = bumpCounter(proCounters, `${ipFromRequest(req)}:texbrain-thinking`);
    if (tbUsed > tbCap) {
      res.status(429).json({ error: `You've used your ${tbCap} free TexBrain requests today. Come back tomorrow, or upgrade to Pro at rrotex.com/pro.` });
      return;
    }
  }

  tbActiveCalls++;
  try {
    const normalized = (messages || []).map(m => ({
      role: m.role,
      content: Array.isArray(m.content) ? m.content.filter(p => p.type === 'text').map(p => p.text).join('\n') : (m.content || ''),
    }));
    // Pass ALL system messages as context (project scripts, studio state, etc.)
    const contextMsgs = normalized.filter(m => m.role === 'system').slice(-3);
    const history = normalized.filter(m => m.role !== 'system').slice(-20);
    const lastUserMsg = history.filter(m => m.role === 'user').slice(-1)[0]?.content || '';

    const workerMessages = [
      { role: 'system', content: tbBuildSystemPrompt(projectMode, mode) },
      ...contextMsgs,
      ...history,
    ];

    // Groq first: fastest inference available, and openai/gpt-oss-120b is
    // Groq's current flagship model (Kimi K2 was deprecated on Groq in favor
    // of it as of March 2026 — do not reintroduce a moonshotai/kimi-k2-*
    // model id here without checking console.groq.com/docs/deprecations).
    // OpenRouter free models are the resilience fallback if Groq is
    // rate-limited, down, or GROQ_API_KEY has no credits.
    const GROQ_CODE1 = 'openai/gpt-oss-120b';
    const GROQ_CODE2 = 'llama-3.3-70b-versatile';
    const GROQ_TALK  = 'llama-3.3-70b-versatile';
    const TB_TALK  = 'google/gemma-3-27b-it:free';
    const TB_CODE1 = 'qwen/qwen3-coder:free';
    const TB_CODE2 = 'deepseek/deepseek-v3-0324:free';
    const TB_UI    = 'meta-llama/llama-3.3-70b-instruct:free';
    // Super Agent mode's prompt asks for a "5-pass deep workflow", but until
    // now the underlying model never actually changed from Agent mode's fast
    // models -- more prompt text on the same fast model doesn't produce
    // genuinely deeper reasoning. deepseek-r1 is currently the strongest free
    // reasoning model on OpenRouter; only worth the latency for Supreme mode,
    // where users already expect a slower, more thorough pass. Timeout is
    // capped well under the 90s Vercel function limit (see vercel.json) to
    // leave room for the rest of the cascade if it doesn't pan out.
    const TB_REASONING = 'deepseek/deepseek-r1:free';
    const isCodeMode = mode === 'agent' || mode === 'supreme';
    const isSupreme = mode === 'supreme';

    // Accept any code block: ```file:, ```lua, ```luau, or bare ``` with code inside.
    const hasCodeBlock = (t) => /```(?:\s*file:|\s*lua\b|\s*luau\b|\s*\n)/i.test(t);

    let text = '', usedModel = '', usedUsage = null;
    const tbErrors = [];

    // 8000 max_tokens (not 12000): several free-tier providers hard-cap
    // completion length or total context (prompt + completion) well below
    // 12000 and error out rather than truncate, which silently failed every
    // candidate in the cascade at once. 8000 is still generous for one script.
    const orCall = (model, msgs, maxTok = 8000, timeoutMs = 25000) =>
      tbOrPost('/chat/completions', { model, temperature: 0.2, top_p: 0.95, max_tokens: maxTok, messages: msgs }, timeoutMs);
    const groqCall = (model, msgs, maxTok = 8000, timeoutMs = 20000) =>
      tbGroqPost(model, msgs, maxTok, timeoutMs);

    // 1. Groq — fast first attempt for both Agent and Super Agent. A single
    //    candidate only (not looping into llama-3.3-70b): the explicit,
    //    confirmed decision here is that BOTH modes should take real time to
    //    reach for a genuinely stronger model rather than settling for the
    //    first fast response, so this is deliberately a quick opening probe,
    //    not the primary path.
    if (GROQ_KEY) {
      try {
        const result = await groqCall(isCodeMode ? GROQ_CODE1 : GROQ_TALK, workerMessages, isCodeMode ? 8000 : 6000);
        const t = sanitizeAssistantText(result.choices?.[0]?.message?.content?.trim());
        if (t) { text = t; usedModel = 'groq/' + (isCodeMode ? GROQ_CODE1 : GROQ_TALK); usedUsage = result.usage || null; }
      } catch (e) { tbErrors.push(`groq/${GROQ_CODE1}: ${e?.message || e}`); }
    }

    // 1.3/1.5. Agent AND Super Agent: qwen3-coder (the full 480B parameter
    //      model, confirmed via openrouter.ai/qwen/qwen3-coder:free -- ~4x
    //      bigger than gpt-oss-120b), then a genuine reasoning pass
    //      (deepseek-r1). Explicit product decision: both modes should take
    //      the time to reach for real capability instead of settling for
    //      whatever the fast Groq attempt produced. Agent gets shorter
    //      timeouts than Supreme so it isn't waiting as long, but still
    //      genuinely tries the same bigger models, not just more prompt text
    //      on a fast one.
    if (isCodeMode && (!text || !hasCodeBlock(text))) {
      try {
        const result = await orCall(TB_CODE1, workerMessages, 8000, isSupreme ? 30000 : 22000);
        const t = sanitizeAssistantText(result.choices?.[0]?.message?.content?.trim());
        if (t && hasCodeBlock(t)) { text = t; usedModel = TB_CODE1; usedUsage = result.usage || null; }
      } catch (e) { tbErrors.push(`or/${TB_CODE1}: ${e?.message || e}`); }
    }
    // max_tokens is 16000, not the usual 8000: R1 is a reasoning model -- it
    // spends a real chunk of its output budget on internal <think>
    // chain-of-thought BEFORE the final answer. Capping it at the same 8000
    // ceiling as fast models risked truncating mid-thought, before it ever
    // reached the actual code block.
    if (isCodeMode && (!text || !hasCodeBlock(text))) {
      try {
        const result = await orCall(TB_REASONING, workerMessages, 16000, isSupreme ? 45000 : 32000);
        const t = sanitizeAssistantText(result.choices?.[0]?.message?.content?.trim());
        if (t && hasCodeBlock(t)) { text = t; usedModel = TB_REASONING; usedUsage = result.usage || null; }
      } catch (e) { tbErrors.push(`or/${TB_REASONING}: ${e?.message || e}`); }
    }

    // 2. Resilience fallbacks -- TB_CODE1 (qwen3-coder) already tried above
    //    for both modes, not repeated here. GROQ_CODE2 restores a fast
    //    Groq-based option for when specifically gpt-oss-120b is
    //    unavailable but Groq itself is fine.
    if (!text || (isCodeMode && !hasCodeBlock(text))) {
      if (!isCodeMode) {
        try {
          const result = await orCall(TB_TALK, workerMessages, 6000);
          const t = sanitizeAssistantText(result.choices?.[0]?.message?.content?.trim());
          if (t) { text = t; usedModel = TB_TALK; usedUsage = result.usage || null; }
        } catch (e) { tbErrors.push(`or/${TB_TALK}: ${e?.message || e}`); }
      } else {
        if (GROQ_KEY) {
          try {
            const result = await groqCall(GROQ_CODE2, workerMessages, 8000);
            const t = sanitizeAssistantText(result.choices?.[0]?.message?.content?.trim());
            if (t) { text = t; usedModel = 'groq/' + GROQ_CODE2; usedUsage = result.usage || null; }
          } catch (e) { tbErrors.push(`groq/${GROQ_CODE2}: ${e?.message || e}`); }
        }
        const codeCandidates = [TB_CODE2, TB_UI];
        for (const m of codeCandidates) {
          try {
            const result = await orCall(m, workerMessages);
            const t = sanitizeAssistantText(result.choices?.[0]?.message?.content?.trim());
            if (t) { text = t; usedModel = m; usedUsage = result.usage || null; if (hasCodeBlock(t)) break; }
          } catch (e) { tbErrors.push(`or/${m}: ${e?.message || e}`); }
        }
      }
    }

    if (!text && tbErrors.length) console.error('[TexBrain] all candidates failed:', tbErrors.join(' | '));

    if (!text) {
      res.status(503).json({ error: 'TexBrain models are busy right now. Try again in a moment, or use Claude Haiku.' });
      return;
    }

    // Still no code block? Force a stripped retry with the best coder. Must
    // still include contextMsgs (PROJECT CONTEXT / existing scripts) -- a
    // bare "output a file block" instruction with only the user's raw
    // message is useless for a context-dependent follow-up like "I can't see
    // it, fix it": the model has no way to know what "it" even refers to
    // without the existing script in front of it, so it fails every time,
    // producing the exact "On hold: nothing was edited" symptom.
    if (isCodeMode && !hasCodeBlock(text)) {
      try {
        const retryPrompt = [
          { role: 'system', content: `Output ONLY a file block. Nothing else.\nFormat:\n\`\`\`file:ServiceName/ScriptName.lua\n-- code here\n\`\`\`\nUse PROJECT CONTEXT below to identify which existing script the request refers to.` },
          ...contextMsgs,
          { role: 'user', content: lastUserMsg },
        ];
        const result = GROQ_KEY
          ? await groqCall(GROQ_CODE1, retryPrompt, 8192)
          : await orCall(TB_CODE1, retryPrompt, 8192);
        const t = sanitizeAssistantText(result.choices?.[0]?.message?.content?.trim());
        if (t && hasCodeBlock(t)) { text = text + '\n\n' + t; usedModel += '+retry'; }
      } catch (e) { /* keep original text */ }
    }

    // Normalize: strip spaces after "file:" that some models insert (```file: Path → ```file:Path)
    text = text.replace(/```\s*file:\s+/g, '```file:');

    // Post-process: if the model used plain ```lua blocks instead of ```file: blocks,
    // infer the script path from context and rewrite them so the client can apply them.
    text = tbFixPlainLuaBlocks(text, contextMsgs, lastUserMsg);

    // TexToken cost: use the SAME (input*inputTexTokens + output*outputTexTokens)*multiplier
    // formula as the main /api/chat endpoint (see credit-safety.js estimateTexTokens /
    // logProviderUsage), driven by texbrain-thinking's catalog pricing. Prefer real
    // prompt/completion token counts from the provider response over a rough character
    // estimate. A meaningful floor (not the old chars/400 formula, which charged single
    // digits per request) ensures usage actually draws down the daily TexToken budget.
    const tbModel = MODELS['texbrain-thinking'];
    const inputCharsEstimate = workerMessages.map(m => String(m.content || '')).join('\n').length;
    const realInputTok = usedUsage?.prompt_tokens ?? Math.max(1, Math.ceil(inputCharsEstimate / 4));
    const realOutputTok = usedUsage?.completion_tokens ?? Math.max(1, Math.ceil(text.length / 4));
    let tbCost = (realInputTok * (tbModel.inputTexTokens || 1) + realOutputTok * (tbModel.outputTexTokens || 1)) * (tbModel.multiplier || 1);
    // Kept in sync with the doubled agent/superAgent multipliers in
    // estimateTexTokens/logProviderUsage even though this path is currently
    // unreachable by real users (TexBrain is hidden -- see
    // project_texbrain_dead_path memory) so it isn't a silent landmine if
    // ever re-enabled.
    if (mode === 'agent') tbCost *= 4;
    if (mode === 'supreme') tbCost *= 8;
    // 3D modeling (roblox-model / create_model) is a distinct, higher-value
    // capability -- it creates real, persistent geometry in the game, not just
    // a script edit -- so it carries a premium on top of the normal token cost
    // even though bigger models already cost more via output size alone.
    if (/```\s*roblox-model\b/i.test(text)) tbCost *= MODELING_COST_MULTIPLIER;
    tbCost = Math.max(isCodeMode ? 5000 : 3000, Math.ceil(tbCost));

    // Persist this spend server-side (same mechanism the main /api/chat handler
    // uses) so the client's balance display doesn't get silently overwritten.
    // The client's window.rotexTokens.spend() only updates localStorage; the
    // displayed balance actually reads window.__rotexServerUsage (Firestore)
    // whenever it's populated, and refreshBillingFromCloud() re-fetches it
    // every 2 minutes / on focus / before the next message. Without writing
    // TexBrain's cost into that same server-side counter, the next refresh
    // pulls back the OLD dayUsed value and the balance appears to not move at
    // all -- exactly "my textokens arent going down".
    if (!tbIsDev) {
      const tbIp = ipFromRequest(req);
      const tbFreeKey = tbAuth.uid ? `uid:${tbAuth.uid}` : `ip:${tbIp}`;
      addFreeTokensUsed(tbFreeKey, tbCost);
      const tbIpKey = `ip:${tbIp}`;
      if (tbIpKey !== tbFreeKey) addFreeTokensUsed(tbIpKey, tbCost);
      if (tbAuth.uid) addUsage(tbAuth.uid, authToken, tbCost).catch(() => {});
    }

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
  if (request.url && request.url.includes('/plugin-bridge')) {
    return handlePluginBridge(request, response);
  }
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
    projectMemory = '',
    projectSpec = '',
    projectMode = '',
    texTokensLeft = null,
    superAgent = false,
    category: categoryOverride = 'auto',
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

  // (Removed) An old "emergency fallback" trusted the UID decoded from the
  // UNSIGNED pass body and granted Pro if that UID had a Stripe subscription --
  // meaning anyone who knew a paying user's Firebase UID could get Pro on their
  // own request. The authenticated-identity path above (authResult.uid +
  // userHasActiveProSubscription) already recovers legitimate Pro users whose
  // signed pass is stale, without ever trusting an unsigned, caller-supplied UID.

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

  // Login required to chat: guests can't use the editor/chat surface at all.
  // (Uses mode directly -- the isEditor const is declared later in this handler.)
  if (mode === 'editor' && !isAuthUser && !isDev) {
    response.status(401).json({
      error: 'login_required',
      text: 'Please log in to chat with ROTEX. Sign in to continue.',
    });
    return;
  }

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
    // One account per person: the FIRST free account seen on this device (IP)
    // or Gmail base address permanently claims it in KV -- any later account is
    // blocked for good, so making more accounts never works. Only the original
    // account can chat for free. Pro/dev are exempt (checked above), so a
    // paying customer on a shared connection is never locked out. Falls back to
    // the in-memory same-IP/Gmail check when KV isn't configured.
    let blocked = linkedMultiAccount;
    if (accountGuard.guardEnabled()) {
      const ipOwner = await accountGuard.claimOwner('ip', ip, userId);
      const emailOwner = userEmail
        ? await accountGuard.claimOwner('email', normalizeGmail(userEmail), userId)
        : { enforced: false, allowed: true };
      blocked = (ipOwner.enforced && !ipOwner.allowed) || (emailOwner.enforced && !emailOwner.allowed);
    }
    if (blocked) {
      response.status(403).json({
        error: 'account_blocked',
        text: 'This device already has a ROTEX account. Only your first account can chat for free — sign in with that one, or go Pro at rrotex.com/pro to use another account.',
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
    // The balance is fully SERVER-AUTHORITATIVE: it lives in the KV wallet
    // (token-wallet.js), a server-only store the user cannot write. The
    // client-sent texTokensLeft is never trusted. If KV isn't configured we
    // fall back to the Firestore read (still ignores the request body, just
    // not yet tamper-proof against a direct Firestore write) and warn once.
    const isAuth = authResult.ok && userId !== 'unknown' && userId !== ip;
    let serverBalance = 0;
    if (isAuth) {
      if (tokenWallet.walletEnabled()) {
        serverBalance = await tokenWallet.getBalance(authResult.uid);
        if (serverBalance === null) {
          // First time this user is seen by the wallet -- migrate their
          // existing purchased balance from Firestore exactly once.
          const legacy = await readBalance(authResult.uid, authToken);
          await tokenWallet.seed(authResult.uid, legacy);
          serverBalance = legacy;
        }
        request._walletDraw = serverBalance > FREE_DAILY_TEXTOKENS;
      } else {
        if (!_warnedNoWallet) { _warnedNoWallet = true; console.warn('[wallet] KV not configured — TexToken balance falls back to Firestore (add Vercel KV for a tamper-proof wallet).'); }
        serverBalance = await readBalance(authResult.uid, authToken);
      }
    }
    const effectiveDailyLimit = serverBalance > FREE_DAILY_TEXTOKENS
      ? Math.min(serverBalance, 10_000_000)
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
  if (superAgent) maxTokens = Math.max(maxTokens, 24000);
  else if (agent) maxTokens = Math.max(maxTokens, 16000);
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
  // Roblox Toolbox search is a Roblox-only concept -- skip the network
  // round-trip entirely for Unity/Web projects instead of injecting
  // irrelevant Roblox asset context into their prompts. An empty projectMode
  // still counts as Roblox (the desktop editor's default when nothing is
  // selected).
  const isRobloxProject = !projectMode || /roblox/i.test(String(projectMode));
  const robloxAssetContext = isEditor && isRobloxProject
    ? await buildRobloxUiAssetContext(lastUser?.content || '')
    : '';

  // Google Flash Smart Mode: category routing, scoped to google-flash only
  // (Claude Haiku and the hidden TexBrain model are untouched). Auto uses
  // the deterministic keyword router (routeCategory); an explicit override
  // from the client skips routing and uses that category directly.
  const resolvedCategory = isEditor && modelId === 'google-flash'
    ? (categoryOverride !== 'auto' && CATEGORIES[categoryOverride]
        ? CATEGORIES[categoryOverride]
        : CATEGORIES[routeCategory(lastUser?.content || '', { projectMode }).category])
    : null;

  // ROTEX Free Planner Coach pre-pass: runs for every real google-flash
  // editor request (the user-facing default model), skipping only trivial
  // greetings and the 'replace'-mode categories (Prompt Maker/Fast Explain
  // are deliberately lean prompts that don't consume the plan). Awaited here
  // so the result rides in the same system prompt built just below;
  // generatePlannerBrief never throws and hard-caps at 9s, so the
  // google-flash cascade's timeout budget under Vercel's 90s ceiling stays
  // safe. Other models (Claude Haiku, TexBrain) are untouched.
  const trivialMessage = /^\s*(hi|hello|hey|yo|ok|okay|thanks|thank you|cool|nice|yes|no|lol|bruh|uhm|hmm)[.!?\s]*$/i.test(String(lastUser?.content || ''));
  const plannerEligible = isEditor
    && modelId === 'google-flash'
    && !trivialMessage
    && String(lastUser?.content || '').trim().length >= 8
    && (!resolvedCategory || resolvedCategory.promptMode !== 'replace');
  let projectSpecText = String(projectSpec || '').trim().slice(0, PROJECT_SPEC_CAP);
  let plannerPlanText = '';
  let projectSpecGenerated = false;
  if (plannerEligible) {
    const brief = await generatePlannerBrief(projectSpecText, lastUser?.content || '', projectMode);
    plannerPlanText = brief.plan;
    projectSpecText = brief.spec;
    projectSpecGenerated = true;
  }

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
        projectMemory,
        resolvedCategory,
        lastUser?.content || '',
        projectSpecText,
        plannerPlanText,
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
        'ROTEX is a desktop and web AI app primarily for Roblox game developers. Website: rrotex.com. Free plan: 150k TexTokens/day, 1M/month, one account per person. Pro: $20 one-time purchase for 30 days (not a subscription — buy again to keep it), 20M TexTokens/30 days, 1M/day, agent mode, 5 projects. Extra packs: $2.50 per 1M TexTokens.',
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
      : 'The selected AI provider is not configured on the ROTEX backend.';
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
    // Deplete the KV wallet when this user is drawing on purchased balance
    // (cap raised above the free tier). Server-side spend = the wallet is the
    // single source of truth; the old client-side balance decrement no longer
    // gates anything. Fire-and-forget, fail-safe.
    if (request._walletDraw && authResult.uid) {
      tokenWallet.spend(authResult.uid, estimate.textokens).catch(() => {});
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
        category: resolvedCategory,
        devPass,
        isDev,
        authToken,
        authUid: authResult.uid,
        freeKey: request._freeKey,
        ipKey: request._ipKey,
        projectSpec: projectSpecGenerated ? projectSpecText : '',
        projectSpecGenerated,
      });
    } else {
      const result = await completeResponse(providerCall, cleanMessages, cleanAttachments, selected, maxTokens, hasImages, {
        userId,
        estimate,
        agent,
        superAgent,
        category: resolvedCategory,
      });
      response.status(200).json({ model: selected.name, category: resolvedCategory?.id || null, text: result.text, usage: result.usage, devPass });
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
      || (selected.route === 'tb-thinking' ? 'TexBrain is busy for a moment. Try again in a few seconds.' : PROVIDER_FAILED_TEXT);
    const publicError = error?.publicError || (lowCredit ? 'provider_credits_empty' : 'backend_unavailable');
    if (stream && response.headersSent) {
      sseWrite(response, {
        error: publicError,
        text: publicText,
      });
      sseWrite(response, {
        done: true,
        usage: {
          input_tokens: estimate.inputTokens,
          output_tokens: estimate.outputTokens,
          textokens_charged: estimate.textokens,
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
- Character loads async. After PlayerAdded fires, character may not exist yet. ALWAYS use this pattern at the top of every LocalScript that needs the character:
  \`\`\`lua
  local function onCharacter(char)
      local humanoid = char:WaitForChild("Humanoid")
      -- setup here
  end
  if player.Character then onCharacter(player.Character) end
  player.CharacterAdded:Connect(onCharacter)
  \`\`\`
  Never hook CharacterAdded alone — the character is already loaded when a LocalScript first runs.
- Always nil-check humanoid/character before accessing properties in RunService loops: \`if not humanoid then return end\`.
- Never disconnect InputBegan/InputEnded connections inside those same handlers — only disconnect in CharacterRemoving or PlayerRemoving.
- CharacterAdded fires every respawn — reset all state variables inside the handler, not at the top of the script.
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

// Gemini's real context window is >1M tokens (confirmed live against
// OpenRouter's model metadata) -- shared by both buildEditorSystemPrompt's
// normal 'inject' path and the leaner category 'replace' path below, so a
// future tuning of these tiers can't update one and silently miss the
// other.
function projectContextCap(agent, superAgent, isPro) {
  return superAgent ? (isPro ? 160000 : 60000)
    : agent ? (isPro ? 110000 : 42000)
    : (isPro ? 64000 : 24000);
}

function buildEditorSystemPrompt(selected, agent, projectContext, isPro, projectMode, superAgent = false, projectMemory = '', category = null, userText = '', projectSpec = '', plannerPlan = '') {
  const projectContextText = String(projectContext || '');
  const projectMemoryText = String(projectMemory || '').trim().slice(0, 4000);
  const projectSpecText = String(projectSpec || '').trim().slice(0, PROJECT_SPEC_CAP);
  const plannerPlanText = String(plannerPlan || '').trim().slice(0, PLANNER_PLAN_CAP);
  const askMode = /ROTEX UI MODE:\s*ASK/i.test(projectContextText);
  const planMode = /ROTEX UI MODE:\s*PLAN/i.test(projectContextText);

  // Google Flash Smart Mode 'replace' categories (Prompt Maker,
  // Explain/Compare): their own rules directly contradict the shared
  // "always use ```file: blocks" instructions built below (Prompt Maker
  // explicitly must not emit file blocks; Explain/Compare is a discussion
  // answer, not an edit). Mixing the two would leave two contradictory
  // instructions in the same prompt, so 'replace' categories skip the
  // whole shared-rules build and get a leaner, category-only prompt
  // instead -- still with PROJECT MEMORY/CONTEXT (both still useful for a
  // good prompt or a grounded comparison) and the one universal rule that
  // has nothing to do with code output.
  if (category && category.promptMode === 'replace') {
    const leanParts = [
      category.systemPrompt,
      category.responseFormat?.length ? `Structure your response with these sections in order: ${category.responseFormat.join(', ')}.` : '',
      'Never output hidden reasoning, chain-of-thought, scratchpad text, or tags such as <think>, </think>, <analysis>, or </analysis>. Output only the final answer.',
      projectMemoryText ? `PROJECT MEMORY (durable facts you already learned about this project/user across earlier sessions):\n${projectMemoryText}` : '',
      projectSpecText ? `PROJECT SPEC (living design brief for this project -- keep it in mind, but the user's latest message always takes priority if it conflicts):\n${projectSpecText}` : '',
      projectContext ? `PROJECT CONTEXT:\n${String(projectContext).slice(0, projectContextCap(agent, superAgent, isPro))}` : '',
    ];
    return leanParts.filter(Boolean).join('\n\n');
  }

  const parts = [
    'You are ROTEX Roblox Dev Mode, the Roblox development brain inside the ROTEX desktop app chat.',
    `You are running as the **${selected.name}** model (${selected.providerName}).`,
    buildRobloxDevModeBrief({ userText, projectMode, selectedModelName: selected.name, categoryId: category?.id || null }),
    'You are a world-class expert Roblox/Luau engineer. Think the whole problem through before you write a single line: what the user actually wants, exactly which Roblox services/instances/events own that behavior, every edge case (respawn, multiple players, exploits, mobile, cleanup), and the simplest correct design. Then write production-quality Luau that runs first try.',
    'ROTEX ROBLOX DEV MODE WORKFLOW: understand the game idea, break big requests into concrete Roblox tasks, ask only required questions, choose safe defaults when context is enough, then generate the exact implementation the coding/editing agent needs. Include Studio setup mentally every time: what belongs in ReplicatedStorage, ServerScriptService, StarterGui, StarterPlayerScripts, Workspace, ServerStorage, StarterPack, plus every Script, LocalScript, ModuleScript, RemoteEvent, RemoteFunction, Folder, UI object, Part, terrain edit, and Lighting change needed.',
    'PROJECT MEMORY STRUCTURE: remember durable project facts only -- game name, genre, current features, already-created scripts, folder structure, RemoteEvents/RemoteFunctions, UI names, player stats, bugs already fixed, user skill level, and whether the project is Roblox, Unity, or both. Use this memory to avoid rebuilding duplicate systems and to match existing names.',
    'SCRIPT PLACEMENT BRAIN: Script = server logic; LocalScript = client/UI/input/camera logic; ModuleScript = reusable shared/server module; RemoteEvent = one-way client/server signal; RemoteFunction = request/response; ReplicatedStorage = shared remotes/modules; ServerStorage = server-only assets; ServerScriptService = server scripts; StarterGui = UI; StarterPlayerScripts = client scripts; Workspace = live world/map objects. Never trust the client for important game logic.',
    'TEMPLATE LIBRARY MINDSET: for common Roblox features, use proven complete patterns instead of tiny snippets: main menu, shop UI, inventory, currency, leaderstats, safe DataStore saving/loading with pcall/autosave/PlayerRemoving, gamepasses, developer products, round systems, teams, powers/abilities, cooldowns, quests, NPC dialogue, teleports, doors/keycards, admin panels, loading screens, and mobile buttons.',
    'DEV MODE CHECKLIST: before final output, verify multiplayer safety, server validation, clear RemoteEvent names, correct Script/LocalScript/ModuleScript placement, all required objects created or WaitForChild-ed, no bad infinite loops, Play Solo and multiplayer test compatibility, and whether the user must create any parts/UI first. If this is an error report, explain the broken line/root cause in one sentence, fix it, and include practical test steps.',
    'TOOLBOX MAP-ONLY RULE: Roblox Toolbox search and insert_toolbox_model are ONLY for static map/world/environment building assets such as terrain decorations, buildings, roads, rocks, trees, lobby props, arenas, islands, and level dressing. Never use Toolbox for scripts, UI/icons/HUD art, tools/weapons/items, NPC logic, shops, inventory, currency, game systems, or anything that needs trusted gameplay behavior.',
    'SLOW-SMART INTERNAL WORK RULE: do not rush. Spend extra internal time before output on Roblox edit requests. Privately do at least these passes: (1) classify intent, (2) map existing owners in PROJECT CONTEXT, (3) identify every conflicting/duplicate script or UI, (4) design the client/server architecture, (5) decide exact paths and action blocks, (6) check Roblox API correctness, (7) simulate Play Solo plus two-player multiplayer, (8) check cleanup/respawn/mobile/exploit cases, (9) verify the output will actually edit Studio, not just explain. Never show these passes; only show the final concise answer and hidden executable blocks.',
    'ROTEX FREE PLANNER COACH: before the main answer, privately act like a free internal planning AI is telling you exactly what to do. This coach is hidden and must never be mentioned to the user. It must create an internal instruction list for the coding model: classify the request as answer/create/modify/remove/debug/verify, identify the exact owner scripts/instances from PROJECT CONTEXT, decide every required file/action path, choose server/client/remotes/UI/DataStore placement, detect duplicate or stale scripts, choose plugin actions vs file blocks, and define the test checks. The final answer must follow that internal coach plan.',
    'FREE PLANNER EXECUTION CONTRACT: for Agent/Super Agent edit requests, the coach must force a real Studio-applicable result: complete hidden file blocks, valid studio-action JSON, roblox-model/terrain/lighting actions, or one concise blocking question if acting would be unsafe. The coach must reject plain promises, fake success, visible Lua dumps, duplicate feature rewrites, and any "fixed it" answer without executable changes.',
    'FREE PLANNER QUALITY ESCALATION: in Agent mode, the coach should make the model slow down enough to find the correct owner and produce a complete safe change. In Super Agent mode, the coach should expand the review to the whole affected system: remove duplicates, add missing remotes/modules/UI, preserve existing behavior, polish UI/UX, and check security, respawn, mobile, multiplayer, and cleanup before final output.',
    'NO DUMB GENERIC ANSWERS: never answer Agent/Super Agent requests like a generic Roblox chatbot. Do not say you cannot see the game when PROJECT CONTEXT contains scanned scripts/instances. Do not ask the user to paste code or manually make objects if the plugin can create/edit them. Do not repeat advice; produce the exact edit. If the user says "it did not work", change your diagnosis and search for the true owner/duplicate instead of resending the same fix.',
    'EXACT OWNER RULE: when changing existing behavior, never assume the newest or most obvious script is the owner. Search names, UI labels, RemoteEvent names, comments, and behavior patterns in PROJECT CONTEXT. If multiple scripts could own it, update the true owner and delete/disable stale duplicates. If the user says "it did not change", assume you edited the wrong owner or missed a duplicate and fix that, not the same file again blindly.',
    'ROBLOX STUDIO REALITY RULE: a change is not done unless one of these is true: a complete file block changes the owning script, a studio-action deletes/sets/selects/inserts the exact instance, or a roblox-model/terrain/lighting action creates the requested world change. Plain text promises do nothing. For Agent/Super Agent, executable blocks are mandatory for edit requests.',
    'DEEP UI RULE: for UI requests, build a real polished ScreenGui system, not a raw rectangle. Include UIScale for screen sizes, UIListLayout/UIPadding when useful, UICorner/UIStroke/UIGradient, readable contrast, sensible anchors, mobile-safe touch sizes, ZIndex ordering, ResetOnSpawn choice, and exactly one owner script. If the user asks for simple/classic, keep it clean and restrained, but still professional and visible.',
    'VISIBLE UI TOOL RULE: to make UI appear immediately in Studio/StarterGui, prefer a create_ui studio-action that creates the actual ScreenGui tree in StarterGui, then add a .client.lua LocalScript only for behavior such as opening, closing, buying, keybinds, or animations. This is more reliable than only creating UI from a runtime script. Never use create_model/roblox-model for UI.',
    'UI MUST SHOW RULE: any on-screen Roblox UI must be created/controlled by a LocalScript, preferably at StarterPlayer/StarterPlayerScripts/FeatureName.client.lua. Runtime UI should parent ScreenGui to player:WaitForChild("PlayerGui"), set Enabled = true, ResetOnSpawn = false for persistent HUD/shop/menu UI, ZIndexBehavior = Sibling, DisplayOrder high enough, and create non-zero on-screen sizes. Destroy any old ScreenGui with the same name before recreating it. If a panel starts hidden, connect a real opener button/keybind/prompt/RemoteEvent in the same solution.',
    'UI BUGFIX RULE: if the user says the UI does not show, button does nothing, panel is hidden, there are two bars, or "it did not change", do not create another duplicate UI. Find the existing owner script/ScreenGui in PROJECT CONTEXT, fix that owner, and output delete_instance actions for stale duplicates. Common causes to check: wrong Script class instead of LocalScript, parented to the wrong service, ScreenGui.Enabled false, Frame.Visible false, zero Size, off-screen Position, low ZIndex/DisplayOrder, ResetOnSpawn wiping it, missing PlayerGui WaitForChild, or opener function never connected.',
    'DEEP DEBUG RULE: for bug reports, do not merely patch the symptom. Infer the user-visible failure, trace to the responsible script/path, explain the root cause in one sentence, then output the corrected owner file plus delete/disable actions for any duplicate scripts that would keep the bug alive. Add guards so the same nil/missing-instance/respawn/multiplayer issue cannot happen again.',
    'DEEP GAMEPLAY RULE: for gameplay systems, always decide authority boundaries first. Server owns currency, inventory, damage, purchases, rewards, admin, DataStores, and round state. Client owns camera, input, UI display, animations, local effects, and requests. Use RemoteEvents/RemoteFunctions only with server validation and clear names. Never let the client decide important results.',
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
    'VISIBLE CHAT RULE: In Agent/Super Agent, the user-facing message must NOT contain Lua source code, JSON action payloads, or markdown code fences. Put all code/action/model JSON only inside executable file/studio-action/roblox-model blocks. ROTEX hides those blocks and applies them. Visible text should be a plain sentence describing the actual change, e.g. "I am updating the inventory UI now." or "I am adding the NPC shop now." -- describe what THIS request needs, not a fixed example.',
    'ROBLOX PATH PROTOCOL: file paths must start with a real Roblox root: ServerScriptService, ReplicatedStorage, StarterPlayer, StarterGui, Workspace, ServerStorage, or StarterPack. For StarterPlayerScripts use StarterPlayer/StarterPlayerScripts/Name.client.lua.',
    'OUTPUT PROTOCOL: In Agent/Super Agent, output hidden executable blocks first. Use file blocks for source changes and studio-action blocks for deletion/property/model actions. Do not output plain code that cannot be applied.',
    'SELF-CHECK PROTOCOL before final output: check whether the blocks actually satisfy the user request, whether removal requests remove/disable instead of recreate, whether client/server placement is correct, whether cleanup exists, and whether all referenced Instances are created or WaitForChild-ed.',
    'FINAL ANSWER QUALITY GATE: before sending, mentally reject your draft if any of these are true: it creates a duplicate feature, it edits a likely wrong path, it leaves an old conflicting script alive, it uses a fake Roblox API, it puts LocalPlayer logic in a server Script, it trusts the client for important state, it references objects that are never created, it omits cleanup, it hides plain Lua in visible chat, or it says done without an executable block.',
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
    'MANDATORY PROJECT SEARCH PASS: before writing a single line of code, actually work through PROJECT CONTEXT in order -- (1) does a script already own this feature under ANY name variant (Shop/ShopUI/ShopSystem are the same thing)? (2) what naming conventions, RemoteEvent names, and module structure does this project already use, so new code matches instead of introducing a second style? (3) are there existing modules/services this feature should build on rather than duplicate (an existing DataStore wrapper, an existing RemoteEvents folder, an existing state-management pattern)? Do not skip this because the request seems simple -- a fast wrong answer that ignores existing project structure is worse than a slower correct one. Take the time this requires.',
    'DUPLICATE UI/SYSTEM FIX RULE: applies to ANY feature -- health, mana, XP, ammo, quest tracker, shop, inventory, minimap, cooldown display, not just stamina/sprint. If the user says there are two bars, duplicate buttons, duplicate UI, or "make only one", do not only edit the newest script. Search PROJECT CONTEXT for every script and ScreenGui that creates that feature under ANY name variant (e.g. Health/HealthUI/HealthSystem/HealthBar are the same feature), keep exactly one owner, and output studio-action delete_instance blocks for stale UI scripts/ScreenGuis plus the corrected owner file. Prefer one LocalScript owner under StarterPlayer/StarterPlayerScripts or StarterGui.',
    '"I CAN\'T SEE IT" / "IT\'S NOT SHOWING UP" RULE: this means an EXISTING feature has a VISIBILITY bug, NOT that it needs to be rebuilt from scratch. NEVER create a new script/GUI in response to this report. Find the EXISTING owner script in PROJECT CONTEXT (by feature name -- Shop/ShopUI/ShopGui/ShopSystem are the same feature) and diagnose the actual cause in that script: ScreenGui.Enabled left false, the Frame/GUI parented somewhere other than PlayerGui, zero Size or an off-screen Position, ZIndex/SiblingIndex buried behind another GUI, ResetOnSpawn wiping it on respawn, or an open/toggle function defined but never connected to a button or keybind so it never runs. Output ONE corrected file block for the existing script with the specific cause fixed, not a second copy of the feature.',
    'SMART CHANGE SCOPING: match the diff size to what the user actually asked for, not always the smallest possible one. "Fix", "tweak", "adjust" -> minimal, surgical diff, do not rewrite unrelated systems. "Revamp", "overhaul", "update", "improve", "make it better", "polish" -> the user explicitly wants a substantial change; a trivial or cosmetic-only diff while claiming you "revamped" or "updated" it is a lie. For those requests, meaningfully improve structure, completeness, visuals, and robustness -- then say what actually changed, not a generic "I updated it".',
    'QUALITY BAR: your output competes directly with dedicated Roblox AI tools (e.g. auto-syncing code generators). Match or exceed that bar every time: complete, runnable features with no placeholders, polished UI (spacing, corners, hover feedback, readable contrast) not raw default Frames, correct client/server architecture, and cleanup/respawn handling. A user should never need to ask "is that really it?" after a revamp request.',
    'ROBLOX SYSTEM PATTERNS -- apply the correct idiom for whatever the user actually asks for (combat, economy, NPCs, building, minigames, admin, quests, all equally in scope, not just UI bars). COMBAT/DAMAGE: server owns the hit -- client fires a RemoteEvent on swing/shoot, server validates range/cooldown/line-of-sight with a debounce table, then Humanoid:TakeDamage; never trust a client-reported damage number. ECONOMY/CURRENCY: a server-side table or leaderstats IntValue is the source of truth; purchases go through a server-validated RemoteEvent, never a client-set display value; persist with DataStoreService, pcall\'d, UpdateAsync for anything incremented. NPCS: PathfindingService:CreatePath/ComputeAsync/GetWaypoints, Humanoid:MoveTo() per waypoint waiting for MoveToFinished (never a blind task.wait); ProximityPrompt for dialogue/interaction. BUILDING/PLACEMENT: client-side ghost preview (CanCollide false, grid-snapped) that only becomes a real server-confirmed part on placement, validated server-side for overlap/bounds. ROUND-BASED/MINIGAMES: an explicit state machine (Waiting/Starting/InRound/Ending) driven server-side, clients read state via RemoteEvent/attribute, never guess independently. ADMIN/MODERATION: gate every admin RemoteEvent server-side against a UserId allowlist, never trust a client-side "is admin" flag.',
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
    (!askMode && !planMode) ? 'Studio action blocks are hidden from the user and executed by the ROTEX Roblox plugin. Format exactly:\n```studio-action\n{"type":"delete_instance","path":"StarterPlayer/StarterPlayerScripts/FirstPersonCamera"}\n```\nAllowed action types: delete_instance with path, set_property with path/property/value, select_instances with paths, create_model with model JSON, insert_toolbox_model with assetId/parent/name/position (inserts a REAL community-made map/world-building asset from ROBLOX TOOLBOX MODEL SEARCH results, requires Studio plugin v3.0+), terrain_edit with operation/position/size/radius/material, lighting_set with properties, create_ui with a StarterGui ScreenGui tree, and create_ui_image with screenGui/name/image/position/size. Use delete_instance for removing scripts such as first-person camera scripts.' : '',
    (!askMode && !planMode) ? 'Common removal examples: "get out of first person" should delete or disable the first-person LocalScript; "remove sprint" should delete/disable the sprint script and any UI it created; "stop the GUI" should disable or delete the ScreenGui/LocalScript, not add another script that fights it.' : '',
    (!askMode && !planMode) ? 'Duplicate UI example (applies to any feature, not just stamina): if the user says "there are still 2 bars" after a change to ANY meter/HUD element (health, mana, XP, stamina, whatever), output delete_instance actions for the extra ScreenGui/LocalScript paths and update the remaining script so it creates or controls only one instance of that feature.' : '',
    (!askMode && !planMode) ? 'After file/studio-action blocks, do not add fake success claims. The desktop app reports Studio results. Keep any human text to one short sentence about what the change is intended to do.' : '',
    (!askMode && !planMode) ? 'PLUGIN TOOL RULE: if a ROBLOX TOOLBOX MODEL SEARCH result is present in context and it genuinely matches a map/world/environment-building request, PREFER outputting an insert_toolbox_model studio-action with that real assetId over building primitive Part geometry -- it produces a much higher-quality map prop than create_model can. For static map decoration/geometry requests with no good Toolbox match, use roblox-model/create_model or terrain_edit instead. EXCEPTION: never use roblox-model/create_model/insert_toolbox_model for a Tool/weapon/item the player equips or spawns with -- Toolbox models and create_model both produce a plain Model, not a Tool, producing a non-equippable prop. Build Tools with an Instance.new("Tool") Lua script instead (see STARTING ITEMS / TOOL MODELS rule). Never use Toolbox for UI art/images/icons, scripts, NPC logic, shops, inventory, currency, or game systems. For UI, build real ScreenGui objects or use create_ui_image only when an existing asset ID is already known. For lighting/time/atmosphere requests, use lighting_set. For existing parts, use set_property. Do not write a Lua script when a plugin action directly edits the scene more reliably.' : '',
    (!askMode && !planMode) ? 'ROBLOX UI QUALITY RULE: Roblox UI should look polished and game-ready: use a clear hierarchy, consistent spacing, UIScale, UICorner, UIStroke, UIGradient, padding, hover/click feedback where relevant, mobile-safe sizes, readable contrast, and only one owner script. Prefer clean modern panels over raw default Frames. If the user asks for classic/simple/normal, make it restrained but still aligned and readable.' : '',
    (!askMode && !planMode) ? 'ROBLOX UI VISIBILITY RULE: on-screen UI (a shop panel, HUD, inventory, menu, health bar, etc.) means a real ScreenGui built with Instance.new("ScreenGui")/Frame/TextLabel/ImageLabel etc. in a Lua script, or the create_ui_image studio-action for a single image/icon -- NEVER roblox-model or create_model for UI: those create 3D Parts in the 3D world, not GUI, and produce something that is not UI at all no matter how it is arranged. Before finishing any response that creates or edits UI, verify: the ScreenGui is parented under StarterGui (or PlayerGui at runtime), ScreenGui.Enabled is true (never left false), ResetOnSpawn is set correctly for the feature (usually false so it survives respawn), every Frame/Label has a real non-zero Size and an on-screen Position, and ZIndex/LayoutOrder does not bury it behind another GUI. Skipping this check is the single most common way generated UI ends up invisible.' : '',
    (!askMode && !planMode) ? 'CREATE_UI ACTION RULE: for new visual UI, output a create_ui studio-action so the UI exists in StarterGui immediately. Use replace:true to remove the old ScreenGui with the same name. Use elements/children with classes Frame, TextLabel, TextButton, ImageLabel, ImageButton, ScrollingFrame, UICorner, UIStroke, UIGradient, UIPadding, UIListLayout, UIGridLayout, UIScale. If the UI needs behavior, also output a StarterPlayer/StarterPlayerScripts/*.client.lua file that finds the ScreenGui in PlayerGui and wires the buttons.' : '',
    (!askMode && !planMode) ? 'ROBLOX UI FILE PATH RULE: for new UI/HUD/menu/shop/inventory/client-input work, use a LocalScript file path ending in .client.lua, normally ```file:StarterPlayer/StarterPlayerScripts/FeatureName.client.lua. Do not output UI code as ServerScriptService/*.lua, and do not use a plain .lua file name for client UI unless modifying an existing LocalScript path from PROJECT CONTEXT.' : '',
    (!askMode && !planMode) ? 'ROBLOX UI OWNER TEMPLATE: inside the LocalScript, get Players.LocalPlayer, wait for PlayerGui, destroy the previous ScreenGui of the same name, create ScreenGui with Enabled=true, ResetOnSpawn=false, IgnoreGuiInset chosen intentionally, ZIndexBehavior=Sibling, DisplayOrder=50+, add UIScale for mobile, then create visible children with real Size/Position and connected button/keybind behavior. This template is mandatory for newly-created UI so it actually appears in Play Solo.' : '',
    'To create 3D models/parts in Studio, use a ```roblox-model block with JSON. Example:\n```roblox-model\n{"name":"Castle","parent":"Workspace","parts":[{"name":"Base","size":[20,1,20],"position":[0,0,0],"color":[128,128,128],"material":"SmoothPlastic","anchored":true},{"name":"Wall","size":[20,10,1],"position":[0,5,-10],"color":[110,110,110],"material":"SmoothPlastic","anchored":true}]}\n```\nROTEX sends this to Studio which creates the real 3D objects. Each part can have: name, size[x,y,z], position[x,y,z], rotation[x,y,z] degrees, color[r,g,b], material (SmoothPlastic/Neon/Glass/Wood/Marble/Metal/Concrete/Fabric/ForceField/Granite/Grass/Ice/Sand/Slate), shape (Block/Ball/Cylinder), anchored, transparency, cancollide, scripts[{name,source}]. The model can also have a top-level "scripts" array for scripts attached to the Model itself.',
    'STARTING ITEMS / TOOL MODELS ("make a model for a sword", "spawn with a sword", "give everyone a tool"): NEVER use roblox-model/create_model for a Tool -- it always wraps its parts inside a generic Model instance, not a Tool, so the result is a decorative object in StarterPack that is NOT equippable and nothing appears in the player\'s hand or Backpack. A Tool MUST be built with Instance.new("Tool") in a Lua script, with a part literally named "Handle" as its direct child (required for grip). To make it actually look like the requested item instead of a plain block, add extra visual parts welded to the Handle:\n```lua\nlocal tool = Instance.new("Tool")\ntool.Name = "Sword"\ntool.RequiresHandle = true\ntool.CanBeDropped = true\n\nlocal handle = Instance.new("Part")\nhandle.Name = "Handle"\nhandle.Size = Vector3.new(0.4, 3, 0.4)\nhandle.Color = Color3.fromRGB(60, 60, 60)\nhandle.Material = Enum.Material.Metal\nhandle.CanCollide = false\nhandle.Parent = tool\n\nlocal blade = Instance.new("Part")\nblade.Name = "Blade"\nblade.Size = Vector3.new(0.2, 3.5, 0.6)\nblade.Color = Color3.fromRGB(200, 200, 210)\nblade.Material = Enum.Material.Metal\nblade.CanCollide = false\nblade.CFrame = handle.CFrame * CFrame.new(0, 3, 0)\nblade.Parent = tool\n\nlocal weld = Instance.new("WeldConstraint")\nweld.Part0 = handle\nweld.Part1 = blade\nweld.Parent = handle\n\ntool.Parent = game:GetService("StarterPack")\n```\nA Tool placed directly (not nested inside anything) in StarterPack automatically clones into every player\'s Backpack on spawn -- do not use a PlayerAdded script unless the user wants conditional/one-time granting. Give the Tool real Equipped/Activated behavior matching what the user asked for (swing animation, damage on touch, etc.) -- never leave it as a static prop with no function.',
    'Terrain action example:\n```studio-action\n{"type":"terrain_edit","operation":"fill_block","position":[0,0,0],"size":[80,12,80],"material":"Grass"}\n```\nLighting action example:\n```studio-action\n{"type":"lighting_set","properties":{"ClockTime":18,"Brightness":2,"Ambient":[90,90,110],"OutdoorAmbient":[120,120,140]}}\n```',
    'UI image action example:\n```studio-action\n{"type":"create_ui_image","screenGui":"MainHud","name":"CoinIcon","image":"rbxassetid://123456789","position":[0,16,0,16],"size":[0,40,0,40]}\n```',
    'Visible UI action example:\n```studio-action\n{"type":"create_ui","screenGui":"ShopGui","replace":true,"resetOnSpawn":false,"displayOrder":60,"elements":[{"class":"Frame","name":"Panel","anchorPoint":[0.5,0.5],"position":[0.5,0,0.5,0],"size":[0,420,0,300],"backgroundColor":[18,22,32],"children":[{"class":"UICorner","radius":12},{"class":"UIStroke","color":[255,214,10],"thickness":2,"transparency":0.2},{"class":"TextLabel","name":"Title","position":[0,20,0,16],"size":[1,-40,0,36],"backgroundTransparency":1,"text":"Shop","textColor":[255,255,255],"textSize":24},{"class":"TextButton","name":"CloseButton","position":[1,-52,0,14],"size":[0,36,0,36],"backgroundColor":[255,71,87],"text":"X","textColor":[255,255,255],"textSize":18,"children":[{"class":"UICorner","radius":8}]}]}]}\n```',
    'Toolbox model insert action example for map/world-building only (only use a real assetId from ROBLOX TOOLBOX MODEL SEARCH results, never invent one):\n```studio-action\n{"type":"insert_toolbox_model","assetId":123456789,"parent":"Workspace","name":"ForestTree","position":[0,5,0]}\n```',
    'The PROJECT CONTEXT below contains the full source of all scripts in the user\'s game (auto-scanned when Studio connected), plus any recent Studio errors or selection data. Read them to understand the existing codebase before suggesting changes. When modifying existing scripts, reference the exact script path from the context and output a file block for it.'
  ].filter(Boolean);
  if (agent) {
    parts.push(
      'AGENT MODE is ON. You are an expert Roblox engineer. Think through the FULL solution before writing — what the user actually wants, which scripts own that behavior, what could break — then deliver code that is correct and complete on the first try. No half-measures, no placeholders, no "you could also...".',
      'AGENT MODE is ON. Be smart, direct, and execution-focused. Use PROJECT CONTEXT to choose the most likely correct path, then output the exact file/studio-action blocks needed.',
      'AGENT ANALYSIS LOOP: (1) identify the exact user intent, (2) scan PROJECT CONTEXT for the owning script or existing pattern, (3) decide create/modify/delete/disable, (4) produce the smallest complete change, (5) verify it does not conflict with existing scripts.',
      'AGENT QUALITY FLOOR: act like a careful senior Roblox developer, not a snippet bot. For every edit request, produce at least one real executable block unless the request is purely conversational. If the request is a bug fix, include the owner file and any needed delete_instance actions. If the request is a feature, include every required server/client/remotes/UI piece. If the request is removal, delete or disable the exact owner.',
      'AGENT DOES NOT GUESS BLINDLY: if PROJECT CONTEXT contains scripts, use names and contents from context. If the user says "still broken" or "did not change", assume a missed duplicate or owner mismatch and search broader by synonyms before editing again.',
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
      'SUPER AGENT PASS 6 - POLISH & UX: if UI, make it visually strong and responsive; if gameplay, make feedback clear; if map/building, use terrain/lighting/model actions appropriately; if economy/data, make persistence safe. Include sensible defaults that make the feature feel finished.',
      'SUPER AGENT PASS 7 - APPLYABILITY AUDIT: verify every output block uses a path/action ROTEX can apply. File paths must use real service roots. Deletions must target concrete paths. Studio actions must be valid JSON. Do not rely on visible prose for anything that must change Studio.',
      'SUPER AGENT EXTRA STANDARD: be meaningfully deeper than Agent. If a robust solution needs multiple files, remotes, cleanup actions, or stale-script deletion, include all of them. If there are duplicates or likely hidden owners, fix the whole system instead of one obvious file. If UI is involved, make it polished, visible, mobile-safe, and owned by exactly one script.',
    );
  }
  if (projectMemoryText) {
    parts.push(`PROJECT MEMORY (durable facts you already learned about this project/user across earlier sessions -- trust these, do not re-derive or contradict them without a clear reason):\n${projectMemoryText}`);
  }
  if (!askMode && !planMode) {
    parts.push(
      'PROJECT MEMORY UPDATES (this is how ROTEX gets smarter without any model training -- by saving lessons that improve FUTURE answers): when you learn something durable that will help you answer better next time for THIS project or user, append a hidden block at the very end of your response:\n```project-memory\n- one short fact per line, under 100 characters each\n```\nSave ONLY these kinds of lessons:\n- Project facts: engine (Roblox / Unity / website), genre or core loop, an existing system and the script that owns it, a naming/architecture convention actually in use.\n- User preferences: e.g. "User likes beginner-friendly answers", "User wants copy-paste prompts, not long explanations", "User wants scripts plus exactly where to put them".\n- Corrections (SELF-UPDATE): when the user corrects you, save the rule that stops the mistake from happening again. Examples: user says "No, I mean Roblox not Unity" -> save "When user mentions gamepasses/Robux/StarterGui, default to Roblox unless they clearly say Unity"; user says "I want a prompt, not code" -> save "When user asks for a prompt, output a copy-paste prompt first, not a long explanation".\nUse this RARELY -- only for something that genuinely changes a future answer. Never save one-off request details, never duplicate a fact already in PROJECT MEMORY, and never mention this block to the user.',
    );
  }
  // Living Project Spec: an auto-generated/updated design brief (# TITLE +
  // * bullets) produced by generateProjectSpec from the user's raw messages.
  // Placed after PROJECT MEMORY (same durable, cross-session project-identity
  // family) and before PROJECT CONTEXT (the raw current code), so the model
  // reads the high-level vision right before the low-level implementation
  // state. Explicitly subordinate to the user's latest message -- a stale or
  // slightly-off bullet must never override what was just asked for.
  if (projectSpecText) {
    parts.push(`PROJECT SPEC (living design brief for this project -- keep it in mind, but the user's latest message always takes priority if it conflicts):\n${projectSpecText}`);
  }
  // The real Free Planner Coach output for THIS request (see
  // generatePlannerBrief): a pre-computed REAL GOAL / MODE / TODO PLAN /
  // IMPORTANT CONTEXT / VERIFY BEFORE FINAL brief from a separate fast model.
  // Placed after the durable SPEC and before the raw code CONTEXT: vision,
  // then this turn's plan, then the implementation state.
  if (plannerPlanText) {
    parts.push(`ROTEX FREE PLANNER COACH PLAN (hidden pre-computed plan for THIS request -- follow it, run its VERIFY BEFORE FINAL checklist on your draft, and never mention this plan to the user; the user's own message wins on any conflict):\n${plannerPlanText}`);
  }
  if (projectContext) {
    // Gemini's real context window is >1M tokens (confirmed live against
    // OpenRouter's model metadata) -- the old 16k/48k character caps here
    // were chopping most non-trivial projects (each script alone can
    // already eat 3-8k characters) down to a handful of scripts before the
    // model ever saw the rest, directly undermining the "MANDATORY PROJECT
    // SEARCH PASS" instruction above: it can't search context that was
    // already truncated away. Scaled up for everyone, and further for
    // Agent/Super Agent specifically, since that's exactly when a full view
    // of the project matters most (finding the real owner script, existing
    // patterns to reuse, everything the search-pass rule asks for).
    parts.push(`PROJECT CONTEXT:\n${String(projectContext).slice(0, projectContextCap(agent, superAgent, isPro))}`);
  }
  // Google Flash Smart Mode 'inject' categories (everything except Prompt
  // Maker/Explain-Compare, see the 'replace' branch above): add the
  // category's own purpose + rules on top of everything already built --
  // the shared file-block format, safety, and quality rules above still
  // apply, this only adds what's specific to the detected task.
  if (category && category.promptMode !== 'replace') {
    parts.push(category.systemPrompt);
    if (category.responseFormat?.length) {
      parts.push(`Structure your response with these sections in order: ${category.responseFormat.join(', ')}.`);
    }
  }
  return parts.join('\n');
}

// Roblox toolbox-service marketplace category IDs (Roblox's standard
// AssetType numeric IDs, confirmed empirically against the live API):
// 13 = Decal/Image, 10 = Model (real 3D assets).
async function toolboxSearch(categoryId, query, limit) {
  const ids = [];
  try {
    const url = `https://apis.roblox.com/toolbox-service/v1/marketplace/${categoryId}?keyword=${encodeURIComponent(query)}&limit=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3500) });
    if (!res.ok) return ids;
    const data = await res.json();
    for (const item of Array.isArray(data?.data) ? data.data : []) {
      const id = String(item?.id || '').replace(/\D/g, '');
      if (id && !ids.includes(id)) ids.push(id);
      if (ids.length >= limit) break;
    }
  } catch {}
  return ids;
}

function isRobloxMapBuildRequest(userText) {
  const text = String(userText || '').toLowerCase();
  const buildVerb = /\b(make|create|build|add|generate|design|decorate|insert|place|put|spawn|fill|populate)\b/.test(text);
  const mapNoun = /\b(map|maps|world|terrain|environment|level|lobby|arena|island|biome|forest|city|town|village|dungeon|obby|parkour|baseplate|zone|landscape|street|road|building|buildings|house|houses|castle|cave|mountain|spawn area|spawn zone|decor|decoration|scenery|props|rocks|trees)\b/.test(text);
  const toolboxIntent = /\b(toolbox|asset|assets|model|models|prop|props)\b/.test(text);
  const gameplayOnly = /\b(script|local ?script|module ?script|remoteevent|remotefunction|ui|gui|hud|button|menu|shop|inventory|currency|leaderstats|gamepass|developer product|tool|weapon|sword|gun|npc logic|dialogue|quest|admin|datastore|save|load)\b/.test(text);
  return buildVerb && mapNoun && (toolboxIntent || /\b(tree|trees|rock|rocks|building|buildings|road|roads|house|houses|castle|cave|mountain|forest|city|town|arena|lobby|island|decoration|scenery|props)\b/.test(text)) && !gameplayOnly;
}

async function buildRobloxUiAssetContext(userText) {
  const text = String(userText || '');
  const wantsMapToolbox = isRobloxMapBuildRequest(text);
  if (!wantsMapToolbox) return '';

  const query = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'game asset';

  const sections = [];

  const wantsMapImage = /\b(decal|texture|sign|poster|billboard|banner|logo|image)\b/i.test(text);
  if (wantsMapImage) {
    const imageIds = [
      ...(await toolboxSearch(13, query, 8)),
      ...(await toolboxSearch(13, query + ' texture', 8)),
    ].filter((v, i, a) => a.indexOf(v) === i).slice(0, 8);
    if (imageIds.length) {
      sections.push([
        'ROBLOX MAP DECAL/TEXTURE ASSET SEARCH (map/world-building only):',
        `Query: ${query}`,
        'Use these only for map signs, billboards, decals, or textures when helpful. Prefer rbxassetid://<id>.',
        imageIds.map((id, i) => `${i + 1}. rbxassetid://${id}`).join('\n'),
      ].join('\n'));
    }
  }

  if (wantsMapToolbox) {
    const modelIds = await toolboxSearch(10, query, 8);
    if (modelIds.length) {
      sections.push([
        'ROBLOX TOOLBOX MODEL SEARCH (map/world-building assets only):',
        `Query: ${query}`,
        'Use these only for static Workspace map/environment assets. Do not use them for scripts, UI, tools/weapons, NPC logic, shops, inventory, currency, or game systems.',
        'To insert one of these into the map, use a studio-action block (NOT roblox-model, which only builds primitive Parts):',
        '```studio-action',
        `{"type":"insert_toolbox_model","assetId":${modelIds[0]},"parent":"Workspace","position":[0,5,0]}`,
        '```',
        'Available asset IDs from this search (pick the one that best matches the request, not necessarily the first):',
        modelIds.map((id, i) => `${i + 1}. ${id}`).join('\n'),
        'Content is community-made and unverified -- if the result seems clearly wrong for the request, fall back to building with roblox-model/Instance.new instead of inserting a bad match.',
      ].join('\n'));
    }
  }

  if (!sections.length) {
    return 'ROBLOX TOOLBOX MAP SEARCH: no good map/world asset results found -- build the map with terrain_edit, roblox-model/create_model, or normal Roblox parts instead of inventing fake asset IDs.';
  }
  return sections.join('\n\n');
}

function pickTbThinkingModel(selected) {
  return selected.thinkingModel || selected.chatModel || selected.codeModel || selected.testModel;
}

function resolveProviderCall(selected, cleanMessages, opts = {}) {
  const anthropicKey = cleanKey(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY);
  const openRouterKey = cleanKey(process.env.OPENROUTER_API_KEY);
  const groqKey = cleanKey(process.env.GROQ_API_KEY);
  const attempts = [];

  // The user's selected model is authoritative in every mode, including
  // Agent/Super Agent. There used to be a silent override here that tried
  // Claude Sonnet/Opus first whenever Agent mode was on, regardless of which
  // model was selected -- meaning picking "Google Flash" in Agent mode
  // actually ran (and billed) Claude Sonnet, never touching Gemini. Removed:
  // whatever model is picked is what runs, in every mode.

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
    const primaryOpenRouterModel = opts.superAgent && selected.route === 'openrouter'
      ? (process.env.GOOGLE_FLASH_SUPER_MODEL || 'google/gemini-flash-latest')
      : selected.orModel;
    attempts.push({
      provider: 'openrouter',
      providerModel: primaryOpenRouterModel,
      apiKey: openRouterKey,
      baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
      // Keep Google Flash non-reasoning in production streaming. The old
      // reasoning probe could sit for ~55s before sending useful output and
      // pushed Vercel requests into responseStatusCode=0 timeouts. Reliability
      // beats hidden thinking here; the Roblox Dev Mode prompt carries the
      // workflow, and fallbacks handle provider failures.
      reasoningCapable: false,
    });
  }

  // Google Flash: 3.5 Flash primary (above) -> 2.5 Flash fallback ->
  // Flash Lite fallback -> free resilience fallbacks. 2.5 Flash and Flash
  // Lite exist as distinct attempts because they are still real Gemini
  // models -- a quality/speed step down from 3.5 Flash, not a full downgrade
  // to a generic free model.
  //
  // Deliberately reasoningCapable: false here, even though 2.5 Flash also
  // supports reasoning: with 3 attempts, Agent/Super Agent probes every
  // non-final attempt (see streamResponse), and a reasoning-active probe
  // gets a 55s timeout. Two reasoning-active probes (55+55=110s) already
  // exceeds the 90s Vercel function ceiling before the third, final attempt
  // even starts. Keeping only the primary reasoning-capable budgets to
  // 55s (primary) + 28s (this fallback, fast non-reasoning probe) + the
  // final qwen attempt (unbounded but historically fast) -- fits inside
  // 90s with real margin. Do not flip this to true without re-budgeting
  // every attempt's timeout.
  if (selected.route === 'openrouter' && openRouterKey) {
    attempts.push({
      provider: 'openrouter',
      providerModel: process.env.GOOGLE_FLASH_SECONDARY_MODEL || 'google/gemini-2.5-flash',
      apiKey: openRouterKey,
      baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
      reasoningCapable: false,
    });
  }

  if (selected.route === 'openrouter' && openRouterKey) {
    attempts.push({
      provider: 'openrouter',
      providerModel: process.env.GOOGLE_FLASH_LITE_MODEL || 'google/gemini-2.5-flash-lite',
      apiKey: openRouterKey,
      baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
      reasoningCapable: false,
    });
  }

  // Quality fallback for Agent/Super Agent: after the real Google Flash
  // attempts, try direct Claude before dropping into generic resilience
  // models. This keeps edit tasks from falling too quickly onto weaker
  // backups that tend to chat instead of producing Studio actions.
  if (selected.route === 'openrouter' && anthropicKey && (opts.agent || opts.superAgent)) {
    attempts.push({
      provider: 'anthropic',
      providerModel: process.env.CLAUDE_HAIKU_PINNED_MODEL || 'claude-haiku-4-5-20251001',
      apiKey: anthropicKey,
    });
  }

  // Resilience fallback for Google Flash: without this, a transient
  // OpenRouter/Gemini failure across paid attempts above (rate limit, brief
  // outage, or a paid route running low on balance) took the whole model down
  // too easily. These free-tier models are last-resort backups.
  if (selected.route === 'openrouter' && openRouterKey) {
    const fallbackModels = [
      process.env.GOOGLE_FLASH_FALLBACK_GEMINI || 'google/gemini-flash-latest',
      process.env.GOOGLE_FLASH_FALLBACK_MODEL || 'qwen/qwen3-coder',
      process.env.GOOGLE_FLASH_FALLBACK_MODEL_2 || 'deepseek/deepseek-chat-v3.1',
      process.env.GOOGLE_FLASH_FALLBACK_MODEL_3 || 'z-ai/glm-4.5-air',
      process.env.GOOGLE_FLASH_FALLBACK_MODEL_4 || 'openai/gpt-4.1-mini',
      process.env.GOOGLE_FLASH_FALLBACK_MODEL_5 || 'mistralai/mistral-small-3.2-24b-instruct',
    ].filter(Boolean);
    const seenModels = new Set(attempts.map(a => a.providerModel));
    for (const model of fallbackModels) {
      if (seenModels.has(model)) continue;
      seenModels.add(model);
      attempts.push({
        provider: 'openrouter',
        providerModel: model,
        apiKey: openRouterKey,
        baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
      });
    }
  }

  // Last-resort non-OpenRouter fallbacks for Google Flash. The app should not
  // strand the user with "AI is busy" just because OpenRouter returns a
  // transient credit/rate/provider error across every routed model. These keep
  // Agent/Super Agent usable by falling through to direct provider keys when
  // they exist.
  if (selected.route === 'openrouter' && anthropicKey && !attempts.some(a => a.provider === 'anthropic')) {
    attempts.push({
      provider: 'anthropic',
      providerModel: process.env.CLAUDE_HAIKU_PINNED_MODEL || 'claude-haiku-4-5-20251001',
      apiKey: anthropicKey,
    });
  }

  if (selected.route === 'openrouter' && groqKey) {
    attempts.push({
      provider: 'groq',
      providerModel: process.env.GOOGLE_FLASH_GROQ_FALLBACK_MODEL || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      apiKey: groqKey,
      baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
    });
  }

  return attempts.length ? { provider: selected.route, attempts } : null;
}

async function completeResponse(providerCall, cleanMessages, cleanAttachments, selected, maxTokens, hasImages, context) {
  // See streamResponse's matching comment: Agent/Super Agent expect an actual
  // edit, so a non-final attempt that comes back with no file/studio-action
  // block should be retried against the next attempt rather than accepted.
  const wantsCode = Boolean((context.agent || context.superAgent) && isLikelyStudioEditRequest(cleanMessages));
  const errors = [];
  let bestNoBlockResult = null;
  for (let attemptIndex = 0; attemptIndex < providerCall.attempts.length; attemptIndex++) {
    const attempt = providerCall.attempts[attemptIndex];
    const acceptable = (result) => !wantsCode || acceptableStudioResponse(result.text, cleanMessages, context);
    const reasoning = reasoningFor(attempt, context.agent, context.superAgent, context.category);
    try {
      if (attempt.provider === 'anthropic') {
        const anthropicRequest = {
          apiKey: attempt.apiKey,
          model: attempt.providerModel,
          messages: cleanMessages,
          attachments: cleanAttachments,
          temperature: codeTemperature(selected, context.agent, context.superAgent),
          maxTokens: effectiveMaxTokens(attempt, maxTokens, reasoning),
        };
        try {
          const result = await callAnthropic(anthropicRequest);
          if (!acceptable(result)) {
            bestNoBlockResult ||= result;
            const issues = responseQualityIssues(result.text, cleanMessages, context);
            errors.push(`${attempt.provider}/${attempt.providerModel}: ${issues.join('; ') || 'weak Studio edit'}, trying next model`);
            continue;
          }
          logProviderUsage(result, selected, context, 'completed');
          return result;
        } catch (imageError) {
          if (!hasImages || !/process image|image/i.test(imageError?.message || '')) {
            throw imageError;
          }
          const result = await callAnthropic({ ...anthropicRequest, attachments: [] });
          if (!acceptable(result)) {
            bestNoBlockResult ||= result;
            const issues = responseQualityIssues(result.text, cleanMessages, context);
            errors.push(`${attempt.provider}/${attempt.providerModel}: ${issues.join('; ') || 'weak Studio edit'}, trying next model`);
            continue;
          }
          logProviderUsage(result, selected, context, 'completed');
          return result;
        }
      }
      const result = await callOpenAiCompatible({
        apiKey: attempt.apiKey,
        baseUrl: attempt.baseUrl,
        model: attempt.providerModel,
        messages: cleanMessages,
        temperature: codeTemperature(selected, context.agent, context.superAgent),
        maxTokens: effectiveMaxTokens(attempt, maxTokens, reasoning),
        reasoning,
      });
      if (!acceptable(result)) {
        bestNoBlockResult ||= result;
        const issues = responseQualityIssues(result.text, cleanMessages, context);
        errors.push(`${attempt.provider}/${attempt.providerModel}: ${issues.join('; ') || 'weak Studio edit'}, trying next model`);
        continue;
      }
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
        // Try the next attempt whenever one exists, not just for tb-thinking --
        // google-flash's route now also carries a resilience fallback (see
        // resolveProviderCall), so a paid-route credit/balance error should
        // not short-circuit past it.
        if (attemptIndex < providerCall.attempts.length - 1) {
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
        throw selected.route === 'tb-thinking'
          ? publicProviderError('texbrain_busy', 'TexBrain is busy for a moment. Try again in a few seconds.', 503)
          : publicProviderError('provider_busy', `${selected.name} is busy for a moment. Try again in a few seconds.`, 503);
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
  if (bestNoBlockResult && !wantsCode) {
    logProviderUsage(bestNoBlockResult, selected, context, 'completed_no_block_fallback');
    return bestNoBlockResult;
  }
  if (bestNoBlockResult && wantsCode) {
    const repairAttempt = providerCall.attempts[providerCall.attempts.length - 1];
    const issues = responseQualityIssues(bestNoBlockResult.text, cleanMessages, context);
    const repaired = repairAttempt
      ? await repairExecutableResponse(repairAttempt, cleanMessages, bestNoBlockResult.text, selected, maxTokens, context, issues).catch(() => null)
      : null;
    if (repaired?.text && acceptableStudioResponse(repaired.text, cleanMessages, context)) {
      logProviderUsage(repaired, selected, context, 'completed_repaired_executable');
      return repaired;
    }
    throw publicProviderError('no_executable_change', 'The AI answered without a real Roblox Studio edit, so ROTEX rejected that weak response. Try again or switch to Super Agent.', 503);
  }
  throw new Error(errors.join('\n') || 'All providers failed');
}

// ─── Streaming ────────────────────────────────────────────────────────

function sseWrite(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// A studio-action/roblox-model fence existing is a decent enough signal on
// its own (the client's own JSON/type validation for those is the real gate,
// and duplicating it here isn't worth the drift risk). A ```file: block is
// different and worth checking more carefully: the client's
// _extractStudioFiles additionally requires the path to start with a real
// Roblox service root (editor.html's VALID_ROOT) before it will apply
// anything -- a response that "has a file: block" by this function's
// old definition but used an invalid/invented root (or no root at all)
// would pass this check, get accepted as final, and then still fail
// client-side with "did not receive an executable Studio change", which
// looks identical to the model not trying at all. Mirroring that root
// check here means a genuinely bad path gets retried against the next
// attempt instead of being accepted as a false-positive success.
const VALID_ROBLOX_ROOT = /^(ServerScriptService|ReplicatedStorage|StarterPlayer|StarterPlayerScripts|StarterCharacterScripts|StarterGui|Workspace|ServerStorage|StarterPack|Lighting|SoundService|Teams|Players|TextChatService|Chat)[./\\]/i;
function normalizeRobloxFilePathForGate(rawPath) {
  let path = String(rawPath || '').trim().replace(/^['"`]+|['"`]+$/g, '');
  path = path.replace(/^game:GetService\(["']([^"']+)["']\)[./\\]?/i, '$1/');
  path = path.replace(/^game[./\\]/i, '');
  path = path.replace(/^workspace[./\\]/i, 'Workspace/');
  const ext = (path.match(/(\.(?:client|server|module)?\.?lua)$/i) || [])[1] || '';
  let base = ext ? path.slice(0, -ext.length) : path;
  if (!/[\/\\]/.test(base)) base = base.replace(/\./g, '/');
  return (base + ext).replace(/\\/g, '/');
}
function hasStudioCodeBlock(text) {
  const t = String(text || '');
  if (/```\s*(?:studio-action|roblox-model)/i.test(t)) return true;
  const fileRe = /```\s*file:\s*([^\n`]+)/gi;
  let match;
  while ((match = fileRe.exec(t))) {
    const path = normalizeRobloxFilePathForGate(match[1]);
    if (VALID_ROBLOX_ROOT.test(path)) return true;
  }
  return false;
}

function latestUserText(messages) {
  const lastUser = [...(messages || [])].reverse().find((message) => message?.role === 'user');
  return String(lastUser?.content || '');
}

function extractStudioFileBlocks(text) {
  const files = [];
  const re = /```\s*file:\s*([^\n`]+)\n([\s\S]*?)```|```\s*file:\s*([^\s`]+)\s+([\s\S]*?)```/gi;
  let match;
  while ((match = re.exec(String(text || '')))) {
    const path = normalizeRobloxFilePathForGate(match[1] || match[3] || '');
    const content = String(match[2] ?? match[4] ?? '');
    files.push({ path, content });
  }
  return files;
}

function responseQualityIssues(text, messages, context = {}) {
  const issues = [];
  if (!((context.agent || context.superAgent) && isLikelyStudioEditRequest(messages))) return issues;
  if (!hasStudioCodeBlock(text)) {
    issues.push('No executable ROTEX file/studio-action/roblox-model block was produced.');
    return issues;
  }

  const userText = latestUserText(messages).toLowerCase();
  const files = extractStudioFileBlocks(text);
  const uiLikeRequest = /\b(ui|gui|hud|screen|menu|button|panel|frame|shop|inventory|toolbar|hotbar|bar|meter|health|stamina|mana|xp|coin|cash|display|visible|invisible|not showing|can't see|cant see|doesn'?t show|won'?t show)\b/i.test(userText);
  const bugLikeRequest = /\b(fix|debug|bug|broken|error|not working|doesn'?t work|didn'?t work|still|duplicate|two\s+\w+|2\s+\w+|not showing|invisible|can'?t see|wrong|failed)\b/i.test(userText);

  if (uiLikeRequest) {
    const isRemovalRequest = /\b(remove|delete|disable|turn\s+off|get\s+rid|stop)\b/i.test(userText);
    const hasCreateUiAction = /```\s*studio-action[\s\S]*"type"\s*:\s*"create_ui"/i.test(String(text || ''));
    const needsUiBehaviorScript = /\b(open|close|toggle|click|button|press|key|keyboard|mobile|buy|purchase|equip|use|select|claim|redeem|interact|prompt)\b/i.test(userText);
    const uiFiles = files.filter((file) => /ScreenGui|GuiObject|TextButton|TextLabel|ImageLabel|ImageButton|Frame|ScrollingFrame|PlayerGui|StarterGui|UIScale|UICorner|UIStroke|UIGradient/i.test(file.content)
      || /^StarterGui\//i.test(file.path)
      || /^StarterPlayer\/StarterPlayerScripts\//i.test(file.path)
      || /^StarterPlayer\/StarterCharacterScripts\//i.test(file.path));
    const hasClientUiOwner = uiFiles.some((file) => {
      const path = file.path;
      return /^StarterPlayer\/StarterPlayerScripts\/.+\.client\.lua$/i.test(path)
        || /^StarterPlayer\/StarterCharacterScripts\/.+\.client\.lua$/i.test(path)
        || /^StarterGui\//i.test(path);
    });
    if (!isRemovalRequest && !hasCreateUiAction && !hasClientUiOwner) {
      issues.push('UI work must include a LocalScript owner, normally StarterPlayer/StarterPlayerScripts/FeatureName.client.lua, or modify an existing StarterGui LocalScript.');
    }
    if (hasCreateUiAction && needsUiBehaviorScript && !hasClientUiOwner) {
      issues.push('Interactive UI created with create_ui also needs a LocalScript owner to wire button/keybind behavior.');
    }
    if (uiFiles.some((file) => /^ServerScriptService\//i.test(file.path))) {
      issues.push('UI code was placed under ServerScriptService; on-screen UI must run on the client in a LocalScript.');
    }
    const joinedUi = uiFiles.map((file) => file.content).join('\n');
    if (/ScreenGui/i.test(joinedUi)) {
      if (!/PlayerGui/i.test(joinedUi) && !uiFiles.some((file) => /^StarterGui\//i.test(file.path))) {
        issues.push('ScreenGui creation must parent to player:WaitForChild("PlayerGui") at runtime, unless modifying an existing StarterGui script.');
      }
      if (!/ResetOnSpawn\s*=\s*false/i.test(joinedUi)) {
        issues.push('ScreenGui should set ResetOnSpawn = false for persistent HUD/shop/menu UI.');
      }
      if (!/Enabled\s*=\s*true/i.test(joinedUi)) {
        issues.push('ScreenGui should explicitly set Enabled = true so the UI actually shows.');
      }
      if (!/DisplayOrder\s*=/i.test(joinedUi) && !/ZIndex/i.test(joinedUi)) {
        issues.push('UI should set DisplayOrder or ZIndex so it is not hidden behind other GUI.');
      }
      if (!/UDim2\.new\s*\(/i.test(joinedUi)) {
        issues.push('UI elements need real non-zero UDim2 sizes/positions.');
      }
    }
    if (/\b(not showing|invisible|can't see|cant see|doesn'?t show|won'?t show|still|duplicate|two\s+\w+|2\s+\w+|didn'?t work|didn'?t change)\b/i.test(userText)) {
      if (!/delete_instance/i.test(text) && !/\bDestroy\s*\(/i.test(joinedUi)) {
        issues.push('Visibility/duplicate UI fixes should remove stale duplicate ScreenGuis or owner scripts, not just create another copy.');
      }
    }
  }

  if (bugLikeRequest) {
    if (/fixed|done|updated/i.test(text) && !hasStudioCodeBlock(text)) {
      issues.push('Bug fix claims must include executable changes, not a plain success claim.');
    }
    if (files.some((file) => /while\s+true\s+do/i.test(file.content) && !/task\.wait\s*\(/i.test(file.content))) {
      issues.push('Infinite loops must include task.wait to avoid freezing Studio.');
    }
    if (files.some((file) => /Players\.LocalPlayer/i.test(file.content) && /^ServerScriptService\//i.test(file.path))) {
      issues.push('LocalPlayer is nil on the server; LocalPlayer code must be in a LocalScript.');
    }
  }

  return issues;
}

function acceptableStudioResponse(text, messages, context = {}) {
  if (!((context.agent || context.superAgent) && isLikelyStudioEditRequest(messages))) return true;
  return responseQualityIssues(text, messages, context).length === 0;
}

async function repairExecutableResponse(attempt, cleanMessages, badText, selected, maxTokens, context, qualityIssues = []) {
  const repairMessages = [
    ...cleanMessages,
    {
      role: 'assistant',
      content: String(badText || '').slice(0, 12000),
    },
    {
      role: 'user',
      content: [
        'ROTEX EXECUTABLE REPAIR PASS:',
        'Your previous answer did not contain a valid hidden Studio edit block, so Roblox Studio changed nothing.',
        qualityIssues.length ? 'It also failed these quality checks:\n- ' + qualityIssues.join('\n- ') : '',
        'Rewrite the answer now as executable ROTEX blocks only.',
        'Use complete ```file:Service/path/Name.lua blocks, valid ```studio-action JSON blocks, or ```roblox-model JSON blocks.',
        'Do not explain. Do not apologize. Do not give visible Lua outside file blocks.',
        'If the request requires a script, choose the correct Roblox service root and output the full file.',
        'For UI/HUD/menu/shop/inventory/client-input code, use a LocalScript path ending in .client.lua, normally StarterPlayer/StarterPlayerScripts/FeatureName.client.lua, and create ScreenGui under PlayerGui at runtime.',
        'If the broken request says UI does not show, fix the existing owner script and delete duplicates; do not create a second unrelated UI.',
        'If the request is remove/disable/change a property, output studio-action JSON.',
      ].filter(Boolean).join('\n'),
    },
  ];
  const repairMaxTokens = Math.min(Math.max(maxTokens || 8000, 8000), 14000);
  const temperature = 0.1;
  const result = attempt.provider === 'anthropic'
    ? await callAnthropic({
        apiKey: attempt.apiKey,
        model: attempt.providerModel,
        messages: repairMessages,
        attachments: [],
        temperature,
        maxTokens: repairMaxTokens,
        timeoutMs: 30000,
      })
    : await callOpenAiCompatible({
        apiKey: attempt.apiKey,
        baseUrl: attempt.baseUrl,
        model: attempt.providerModel,
        messages: repairMessages,
        temperature,
        maxTokens: repairMaxTokens,
        timeoutMs: 30000,
      });
  if (!acceptableStudioResponse(result.text, cleanMessages, context)) {
    throw new Error('repair did not produce executable block');
  }
  return result;
}

function isLikelyStudioEditRequest(messages) {
  const lastUser = [...(messages || [])].reverse().find((message) => message?.role === 'user');
  const text = String(lastUser?.content || '').toLowerCase();
  if (!text.trim()) return false;
  if (/^\s*(hi|hello|hey|yo|ok|okay|thanks|thank you|cool|nice|yes|no|lol|bruh|uhm|hmm)[.!?\s]*$/i.test(text)) return false;
  if (/\b(make|create|build|add|put|insert|spawn|generate|write|code|script|implement|fix|debug|repair|update|change|edit|modify|replace|remove|delete|disable|enable|turn\s+(?:on|off)|get\s+(?:out|rid)|set|move|resize|color|colour|polish|revamp|improve|connect|hook\s*up|wire\s*up|verify|test)\b/i.test(text)) return true;
  if (/\b(broken|bug|error|not working|doesn'?t work|didn'?t work|still|stuck|missing|duplicate|two\s+\w+|2\s+\w+|invisible|not showing|won'?t|can'?t)\b/i.test(text)) return true;
  if (/^\s*\[auto-fix\]/i.test(text)) return true;
  return false;
}

// Agent/Super Agent push maxTokens up to 16000-24000 (see the maxTokens
// calculation above) for the PAID primary model, which handles it fine. But
// a resilience/retry fallback attempt can land on a free-tier (":free")
// OpenRouter model, and those hard-cap completion length and ERROR OUT
// (not truncate) well below that -- the exact bug already diagnosed and
// fixed for TexBrain's own cascade (see its 8000-not-12000 comment). Apply
// the same cap here so a fallback attempt doesn't fail for the same reason.
//
// reasoning !== undefined means this attempt is spending real tokens on
// internal thinking BEFORE it writes the actual file/studio-action block --
// those thinking tokens draw from the same max_tokens ceiling as the
// completion (confirmed by the "On hold: did not receive an executable
// Studio change" failures that started right after reasoning was enabled --
// a request that used most of its budget thinking could be cut off before
// ever completing a ```file: block, which reads identically to "the model
// didn't try"). Give reasoning-active attempts a much larger ceiling so
// thinking can never crowd out the actual output; Gemini 3.5 Flash supports
// up to 65536 completion tokens, confirmed live via OpenRouter's model
// metadata, so there's plenty of headroom below that hard limit.
function effectiveMaxTokens(attempt, maxTokens, reasoning) {
  if (/:free\b/i.test(attempt.providerModel || '')) return Math.min(maxTokens, 8000);
  if (reasoning?.effort === 'high') return Math.max(maxTokens, 32000);
  if (reasoning?.effort === 'medium') return Math.max(maxTokens, 24000);
  return maxTokens;
}

// Requests real thinking/reasoning tokens from a reasoning-capable attempt
// (currently just google/gemini-3.5-flash, see resolveProviderCall's
// reasoningCapable flag) instead of a single fast pass -- confirmed live
// against OpenRouter's model metadata that "reasoning" is a supported
// parameter for this model. exclude:true means the thinking tokens are
// billed and used but never sent back in the response, matching the
// existing "never output hidden reasoning" rule -- callers here only ever
// read .content, never .reasoning, so this is belt-and-suspenders.
// Scoped to Agent/Super Agent: plain chat doesn't need the extra latency
// or the real per-token reasoning cost (billed by OpenRouter separately
// from completion tokens) for a quick question.
// category is optional (Google Flash Smart Mode) -- when present, its
// thinkingLevel drives reasoning REGARDLESS of Agent/Super Agent mode, on
// top of the existing agent/superAgent-driven reasoning below (whichever is
// stronger wins). This is a deliberate behavior change: thinking level is
// about what the TASK needs, not which editing-mode toggle is active -- a
// hard Roblox debugging question asked in plain Ask mode should still get
// real reasoning even though Ask mode won't emit file edits.
function reasoningFor(attempt, agent, superAgent, category) {
  if (!attempt.reasoningCapable) return undefined;
  const categoryEffort = category ? THINKING_LEVEL_TO_EFFORT[category.thinkingLevel] : undefined;
  if (superAgent || categoryEffort === 'high') return { effort: 'high', exclude: true };
  if (agent || categoryEffort === 'medium') return { effort: 'medium', exclude: true };
  return undefined;
}

// Editing/fixing code benefits from a lower, more deterministic temperature
// than open-ended chat -- TexBrain's own cascade already settled on 0.2 for
// its coding calls (see TB_CODE1/TB_REASONING usage above). Google Flash was
// pinned at a flat 0.35 regardless of mode; lower it further for Agent/Super
// Agent specifically, where correctness matters more than variety. Plain
// chat keeps the model's normal temperature unchanged.
function codeTemperature(selected, agent, superAgent) {
  const base = modelTemperature(selected);
  if (superAgent) return Math.min(base, 0.15);
  if (agent) return Math.min(base, 0.25);
  return base;
}

async function streamResponse(response, providerCall, cleanMessages, cleanAttachments, selected, maxTokens, context) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  sseWrite(response, {
    model: selected.name,
    category: context.category?.id || null,
    devPass: context.devPass || '',
    // Living Project Spec: the finished (possibly updated) design brief for
    // this turn, so the client can persist it per-chat. null when the spec
    // pre-pass didn't run (non-builder category) or produced nothing.
    spec: context.projectSpec || null,
    specUpdated: Boolean(context.projectSpecGenerated),
  });
  const donePayload = () => ({
    done: true,
    usage: {
      input_tokens: context.estimate.inputTokens,
      output_tokens: context.estimate.outputTokens,
      textokens_charged: context.estimate.textokens,
    },
  });
  const heartbeat = setInterval(() => {
    try { sseWrite(response, { ping: Date.now() }); } catch {}
  }, 10000);
  response.on?.('close', () => clearInterval(heartbeat));

  // Agent/Super Agent expect an actual file/studio-action edit, not just a
  // reply. The editor UI already hides raw streamed text behind a static
  // "Working on task.." placeholder for these requests (see editor.html's
  // isTaskStatus rendering), so buffering a non-final attempt instead of
  // streaming it live costs nothing visible -- and it means a response that
  // came back successfully but with no actual edit (model just chatted) can
  // be retried against the next attempt instead of being shown as final.
  // This is the same hasCodeBlock-retry idea TexBrain's cascade already
  // proved out, now applied on the path Google Flash/Claude Haiku actually
  // run (TexBrain itself is hidden from the model picker and unreachable by
  // real users).
  const wantsCode = Boolean((context.agent || context.superAgent) && isLikelyStudioEditRequest(cleanMessages));

  const errors = [];
  let bestNoBlockText = '';
  for (let attemptIndex = 0; attemptIndex < providerCall.attempts.length; attemptIndex++) {
    const attempt = providerCall.attempts[attemptIndex];
    const isLastAttempt = attemptIndex === providerCall.attempts.length - 1;
    try {
      let fullText = '';
      let streamedLive = false;
      const reasoning = reasoningFor(attempt, context.agent, context.superAgent, context.category);
      const attemptMaxTokens = effectiveMaxTokens(attempt, maxTokens, reasoning);
      const temperature = codeTemperature(selected, context.agent, context.superAgent);
      // A reasoning-active attempt has a much bigger maxTokens ceiling (see
      // effectiveMaxTokens) and spends real wall-clock time thinking before
      // it writes anything -- 28s was tuned for a fast, non-reasoning probe
      // and was cutting these off mid-generation. Still leaves room for the
      // fallback attempt afterward within the 90s Vercel function limit.
      const probeTimeoutMs = reasoning ? 55000 : 28000;
      const shouldProbeForExecutableBlock = wantsCode && !isLastAttempt && attempt.provider !== 'openrouter';
      if (shouldProbeForExecutableBlock) {
        const probe = attempt.provider === 'anthropic'
          ? await callAnthropic({ apiKey: attempt.apiKey, model: attempt.providerModel, messages: cleanMessages, attachments: cleanAttachments, temperature, maxTokens: attemptMaxTokens, timeoutMs: probeTimeoutMs })
          : await callOpenAiCompatible({ apiKey: attempt.apiKey, baseUrl: attempt.baseUrl, model: attempt.providerModel, messages: cleanMessages, temperature, maxTokens: attemptMaxTokens, timeoutMs: probeTimeoutMs, reasoning });
        const probeIssues = responseQualityIssues(probe.text, cleanMessages, context);
        if (probeIssues.length) {
          if (!bestNoBlockText && probe.text) bestNoBlockText = probe.text;
          errors.push(`${attempt.provider}/${attempt.providerModel}: ${probeIssues.join('; ') || 'weak Studio edit'}, trying next model`);
          continue;
        }
        sseWrite(response, { d: probe.text });
        fullText = probe.text;
      } else if (attempt.provider === 'anthropic') {
        streamedLive = true;
        fullText = await streamAnthropic(response, attempt, cleanMessages, cleanAttachments, selected, attemptMaxTokens, temperature, 70000);
      } else {
        streamedLive = true;
        fullText = await streamOpenAiCompatible(response, attempt, cleanMessages, selected, attemptMaxTokens, reasoning, temperature, 70000);
      }
      const qualityIssues = wantsCode ? responseQualityIssues(fullText, cleanMessages, context) : [];
      if (wantsCode && qualityIssues.length) {
        if (!isLastAttempt && !streamedLive) {
          if (!bestNoBlockText && fullText) bestNoBlockText = fullText;
          errors.push(`${attempt.provider}/${attempt.providerModel}: ${qualityIssues.join('; ') || 'weak Studio edit'}, trying next model`);
          continue;
        }
        const repaired = await repairExecutableResponse(attempt, cleanMessages, fullText, selected, maxTokens, context, qualityIssues).catch(() => null);
        if (repaired?.text && acceptableStudioResponse(repaired.text, cleanMessages, context)) {
          sseWrite(response, { d: '\n' + repaired.text });
          fullText += '\n' + repaired.text;
        } else {
          throw publicProviderError('no_executable_change', 'The AI answered with a weak Roblox Studio edit, so ROTEX rejected it before marking the task done. Try again or switch to Super Agent.', 503);
        }
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
      // The base charge above was estimated and persisted BEFORE this response
      // was generated (see estimateTexTokens's caller), since the estimate has
      // to run before knowing what the model will produce. It can't know in
      // advance whether the response includes a roblox-model block, so the
      // modeling premium (MODELING_COST_MULTIPLIER) has to be applied here,
      // after streaming, as an additional charge on the DELTA only.
      if (!context.isDev && /```\s*roblox-model\b/i.test(fullText)) {
        const extraCharge = Math.ceil(context.estimate.textokens * (MODELING_COST_MULTIPLIER - 1));
        if (extraCharge > 0) {
          if (context.freeKey) addFreeTokensUsed(context.freeKey, extraCharge);
          if (context.ipKey && context.ipKey !== context.freeKey) addFreeTokensUsed(context.ipKey, extraCharge);
          if (context.authUid && context.authToken) addUsage(context.authUid, context.authToken, extraCharge).catch(() => {});
        }
      }
      sseWrite(response, donePayload());
      clearInterval(heartbeat);
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
        // Try the next attempt whenever one exists, not just for tb-thinking --
        // google-flash's route now also carries a resilience fallback (see
        // resolveProviderCall), so a paid-route credit/balance error should
        // not short-circuit past it.
        if (attemptIndex < providerCall.attempts.length - 1) {
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
        throw selected.route === 'tb-thinking'
          ? publicProviderError('texbrain_busy', 'TexBrain is busy for a moment. Try again in a few seconds.', 503)
          : publicProviderError('provider_busy', `${selected.name} is busy for a moment. Try again in a few seconds.`, 503);
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

  if (bestNoBlockText && !wantsCode) {
    sseWrite(response, { d: bestNoBlockText });
    logUsage({
      user_id: context.userId,
      model: selected.name,
      input_tokens: context.estimate.inputTokens,
      output_tokens: context.estimate.outputTokens,
      real_provider_cost: context.estimate.providerCostUsd,
      textokens_charged: context.estimate.textokens,
      status: 'completed_stream_no_block_fallback',
    });
    sseWrite(response, donePayload());
    clearInterval(heartbeat);
    response.end();
    return;
  }

  if (bestNoBlockText && wantsCode) {
    const repairAttempt = providerCall.attempts[providerCall.attempts.length - 1];
    const issues = responseQualityIssues(bestNoBlockText, cleanMessages, context);
    const repaired = repairAttempt
      ? await repairExecutableResponse(repairAttempt, cleanMessages, bestNoBlockText, selected, maxTokens, context, issues).catch(() => null)
      : null;
    if (repaired?.text && acceptableStudioResponse(repaired.text, cleanMessages, context)) {
      sseWrite(response, { d: repaired.text });
      logUsage({
        user_id: context.userId,
        model: selected.name,
        input_tokens: context.estimate.inputTokens,
        output_tokens: context.estimate.outputTokens,
        real_provider_cost: context.estimate.providerCostUsd,
        textokens_charged: context.estimate.textokens,
        status: 'completed_stream_repaired_executable',
      });
      sseWrite(response, donePayload());
      clearInterval(heartbeat);
      response.end();
      return;
    }
    clearInterval(heartbeat);
    throw publicProviderError('no_executable_change', 'The AI answered without a real Roblox Studio edit, so ROTEX rejected that weak response. Try again or switch to Super Agent.', 503);
  }

  clearInterval(heartbeat);
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

async function streamOpenAiCompatible(response, providerCall, messages, selected, maxTokens, reasoning, temperature, timeoutMs = 70000) {
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
      temperature: temperature ?? modelTemperature(selected),
      max_tokens: maxTokens,
      stream: true,
      ...(reasoning ? { reasoning } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!providerResponse.ok) {
    throw new Error(await providerResponse.text());
  }

  let fullText = '';
  for await (const event of readSseEvents(providerResponse.body)) {
    if (event === '[DONE]') break;
    try {
      const parsed = JSON.parse(event);
      const delta = parsed.choices?.[0]?.delta?.content;
      if (delta) { sseWrite(response, { d: delta }); fullText += delta; }
    } catch { /* ignore malformed keep-alive chunks */ }
  }
  return fullText;
}

async function streamAnthropic(response, providerCall, messages, attachments, selected, maxTokens, temperature, timeoutMs = 70000) {
  const body = buildAnthropicBody(providerCall.providerModel, messages, attachments, temperature ?? modelTemperature(selected), maxTokens);
  body.stream = true;

  const providerResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': providerCall.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!providerResponse.ok) {
    throw new Error(await providerResponse.text());
  }

  let fullText = '';
  for await (const event of readSseEvents(providerResponse.body)) {
    try {
      const parsed = JSON.parse(event);
      if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
        sseWrite(response, { d: parsed.delta.text });
        fullText += parsed.delta.text;
      }
      if (parsed.type === 'error') {
        throw new Error(parsed.error?.message || 'Anthropic stream error');
      }
    } catch (err) {
      if (err instanceof SyntaxError) continue; // partial/non-JSON line
      throw err;
    }
  }
  return fullText;
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

async function callOpenAiCompatible({ apiKey, baseUrl, model, messages, temperature = 0.7, maxTokens = 900, timeoutMs, reasoning }) {
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
      ...(reasoning ? { reasoning } : {}),
    }),
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
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

async function callAnthropic({ apiKey, model, messages, attachments = [], temperature = 0.7, maxTokens = 900, timeoutMs }) {
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
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
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
  // Doubled (was 2x/4x) -- must stay in sync with estimateTexTokens's
  // matching *= 4 / *= 8 (api/_lib/credit-safety.js), which is what gates
  // whether a request is allowed to run at all before this actual charge is
  // ever computed.
  if (context.agent) charged *= 4;
  if (context.superAgent) charged *= 8;
  // 3D modeling premium (see MODELING_COST_MULTIPLIER) -- same rule as TexBrain.
  if (/```\s*roblox-model\b/i.test(result.text || '')) charged *= MODELING_COST_MULTIPLIER;
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
