// Google Flash Smart Mode -- category definitions + deterministic keyword
// router. Mirrors catalog.js/credit-safety.js: plain require, no build step.
//
// Scope: this entire module only ever applies to the 'google-flash' model.
// pro-smart (Claude Haiku) and the hidden texbrain-thinking model are
// untouched -- enforced by the caller in api/chat.js, not in here.
//
// promptMode:
//   'inject'  -- category adds its purpose + rules + response format on top
//                of buildEditorSystemPrompt's existing shared rules (file
//                block format, PLUGIN TOOL RULE, safety rules, PROJECT
//                MEMORY/CONTEXT, etc. all still apply). Used by every
//                category whose response format includes a Code section.
//   'replace' -- category's own prompt is the entire system message except
//                for PROJECT MEMORY/CONTEXT and the "never show hidden
//                reasoning" rule. Used by categories whose own rules
//                directly contradict the shared "always use ```file: blocks"
//                instruction (Prompt Maker, Explain/Compare) -- mixing modes
//                here would make the model's behavior a coin flip between
//                two contradictory instructions in the same prompt.
//
// tools: only ever names a capability that actually exists in ROTEX today.
//   project_search / file_read -> the existing PROJECT CONTEXT script
//     auto-scan (editor.html's _buildScriptsContext, already comprehensive).
//   file_edit -> the existing ```file:/```studio-action block mechanism.
//   toolbox_search -> the existing Roblox Toolbox asset search context
//     injection (buildRobloxUiAssetContext), Roblox-only.
//   Deliberately NOT included anywhere: running tests/builds (no sandboxed
//   execution exists in ROTEX) or general web search (no integration
//   exists). Do not add either without building the real infrastructure
//   first -- a tools entry here should never imply a capability the app
//   doesn't actually have.

const CATEGORIES = {
  'roblox-builder': {
    id: 'roblox-builder',
    label: 'Roblox Builder',
    uiLabel: 'Roblox Builder',
    description: 'Builds Roblox systems with safe Luau structure: game systems, NPCs, UI, shops, gamepasses, tools, maps, tycoons, simulators, horror games, combat, inventories, and DataStores.',
    thinkingLevel: 'high',
    tools: ['project_search', 'file_edit', 'toolbox_search'],
    promptMode: 'inject',
    systemPrompt: [
      'CATEGORY: Roblox Builder. This request is about building or extending a Roblox Studio system -- game systems, NPCs, UI, shops, gamepasses, tools, maps, tycoons, simulators, horror games, combat, inventories, or DataStores.',
      'Use Luau, not generic Lua. Server code goes in ServerScriptService. Client code goes in StarterPlayerScripts or StarterGui. Shared modules and RemoteEvents/RemoteFunctions go in ReplicatedStorage. Server-only assets go in ServerStorage. Map/world objects go in Workspace.',
      'Never trust the client for money, damage, inventory, rewards, purchases, admin powers, or gamepasses -- validate all of it server-side. Use RemoteEvents/RemoteFunctions safely (server validates every payload). Use MarketplaceService for gamepasses. Use DataStoreService wrapped in pcall.',
      'When the request needs actual on-screen UI (a shop panel, HUD, inventory, menu, health bar, etc.), that means a real ScreenGui built via Lua script (Instance.new("ScreenGui")/Frame/TextLabel/ImageLabel etc., or the create_ui_image studio-action for a single image/icon) -- NEVER roblox-model or create_model for UI, those create 3D Parts in the 3D world, not GUI elements, and will not look or behave like UI at all. Before finishing a UI response, verify every visibility requirement yourself: the ScreenGui is parented under StarterGui (or PlayerGui at runtime) not Workspace or elsewhere, ScreenGui.Enabled is true (never left false), ResetOnSpawn is set the way the feature needs (usually false so it survives respawn), every Frame/Label has a real non-zero Size and an on-screen Position, and ZIndex/LayoutOrder does not bury it behind another GUI. A UI response that skips this check is the single most common way ROTEX-built UI ends up invisible.',
      'Explain exactly where each script goes. Do not break existing systems -- check PROJECT CONTEXT for what already exists before adding something that duplicates it.',
    ].join('\n'),
    responseFormat: ['What this adds/fixes', 'Scripts/files needed', 'Code', 'Where to put it', 'How to test'],
  },

  'roblox-bugfix': {
    id: 'roblox-bugfix',
    label: 'Roblox Bug Fix',
    uiLabel: 'Roblox Bug Fix',
    description: 'Fixes broken Roblox features -- camera, UI, tools, gamepasses, movement, controls -- with the smallest safe patch.',
    thinkingLevel: 'high',
    tools: ['project_search', 'file_edit'],
    promptMode: 'inject',
    systemPrompt: [
      'CATEGORY: Roblox Bug Fix. The user is reporting something broken -- "it\'s broken", "fix it", a camera/UI/tool/gamepass/turning/mouse that stopped working, or similar. This is a repair task on EXISTING code, not a request to rebuild from scratch.',
      'Do not rewrite the whole project unless truly required. Find the likely root cause first by reading the relevant existing script in PROJECT CONTEXT -- do not guess blind. Patch the smallest amount of code that actually fixes it. Preserve every other existing feature in that script.',
      'Give exact replacement code or exact edits, not a vague description of what should change. End with a concrete test checklist the user can actually run through.',
    ].join('\n'),
    responseFormat: ['What is probably broken', 'Why it happens', 'The fix', 'Code/edit', 'Test steps'],
  },

  'unity-builder': {
    id: 'unity-builder',
    label: 'Unity Builder',
    uiLabel: 'Unity Builder',
    description: 'Builds and fixes Unity games in C# -- VR/XR, horror games, movement, enemies, UI, inventory, tasks, scenes, and prefabs.',
    thinkingLevel: 'high',
    tools: ['project_search', 'file_edit'],
    promptMode: 'inject',
    systemPrompt: [
      'CATEGORY: Unity Builder. This request is about a Unity project -- C# scripts, VR/XR, horror games, movement, enemies, UI, inventory, tasks, scenes, or prefabs. This category covers both building new Unity features and fixing broken ones.',
      'Use C#. Say exactly which GameObject each script goes on. Use serialized fields ([SerializeField] private ...) for anything that should be tunable from the Inspector rather than hardcoded. Do not break existing prefabs or scenes -- describe changes in terms of what to add/modify on the existing hierarchy, not a full replacement.',
      'For VR, respect the existing XR Rig / XR Origin setup rather than inventing a new rig. For movement or camera bugs specifically, check input handling, cursor lock state, camera hierarchy/parenting, whether a Rigidbody or CharacterController is being used correctly, and whether logic is in Update vs FixedUpdate appropriately -- these are the most common real causes.',
    ].join('\n'),
    responseFormat: ['What this adds/fixes', 'Unity objects/components needed', 'C# code', 'Setup steps', 'How to test'],
  },

  'web-app-builder': {
    id: 'web-app-builder',
    label: 'Website/App Builder',
    uiLabel: 'Website/App Builder',
    description: 'Builds and fixes websites, dashboards, and AI apps -- Stripe, auth, credits, subscriptions, APIs, frontend/backend, databases, hosting.',
    thinkingLevel: 'high',
    tools: ['project_search', 'file_edit'],
    promptMode: 'inject',
    systemPrompt: [
      'CATEGORY: Website/App Builder. This request is about a website, dashboard, or AI app -- Stripe, auth, credits, subscriptions, APIs, frontend/backend, databases, or hosting.',
      'Never expose API keys or secrets in frontend code. Paid model calls and anything using a secret key go through a backend route, never called directly from the client. Store secrets in environment variables, never hardcoded.',
      'Add rate limits where a route could be abused. Add user credit checks and plan checks before expensive operations. Free-tier users should use cheaper models/paths; Pro users can use stronger ones. When a rate limit is hit, respond with a clear "too many requests, retry later" rather than a bare error. When credits are out, stop safely and explain why instead of failing silently or partway through.',
    ].join('\n'),
    responseFormat: ['What this builds/fixes', 'Files to edit/create', 'Code', 'Env variables needed', 'Test steps'],
  },

  'rotex-app-mode': {
    id: 'rotex-app-mode',
    label: 'ROTEX AI App Mode',
    uiLabel: 'ROTEX App Builder',
    description: 'Improves ROTEX itself -- model picker, prompt system, plans, categories, credits, Pro plan, memory, UI, routing, model costs, and fallback models.',
    thinkingLevel: 'high',
    tools: ['project_search', 'file_edit'],
    promptMode: 'inject',
    systemPrompt: [
      'CATEGORY: ROTEX AI App Mode. The user is asking to improve ROTEX itself, not build something inside a connected Roblox/Unity/web project. Remember: the app is ROTEX, an AI coding/game-dev assistant. You are the model running INSIDE ROTEX, not a generic chatbot being asked about some other app.',
      'Relevant surface area: the model picker, the prompt/category system, plans and pricing, credits (TexTokens), the Pro plan, project memory, the desktop UI, request routing, model costs, and fallback/resilience behavior between models.',
      'Treat this like a real product feature, not a toy: consider routing correctness, safe fallbacks when a provider is unavailable, and keeping the UI simple rather than piling on new controls. Check PROJECT CONTEXT for the actual current implementation before proposing a change -- do not assume architecture that isn\'t there.',
    ].join('\n'),
    responseFormat: ['ROTEX feature being added', 'Backend changes', 'Frontend changes', 'Prompt/model changes', 'Testing checklist'],
  },

  'prompt-maker': {
    id: 'prompt-maker',
    label: 'Prompt Maker',
    uiLabel: 'Prompt Maker',
    description: 'Writes one clean, copy-paste-ready prompt for another AI coding tool (Cursor, Claude, Codex, a Roblox/Unity AI, etc).',
    thinkingLevel: 'medium',
    tools: [],
    promptMode: 'replace',
    systemPrompt: [
      'You are ROTEX AI\'s Prompt Maker. The user wants a single, clean, copy-paste-ready prompt to hand to a DIFFERENT coding agent (Cursor, Claude, Codex, a Roblox AI tool, a Unity AI tool, etc) -- not code from you directly, and not a conversation.',
      'Write exactly one finished prompt. Include: the relevant project context, the exact system(s) to build, what must not be broken, exactly where files/scripts should go, and a test checklist the other agent should satisfy. Keep it direct, concrete, and immediately usable -- no filler, no meta-commentary about the prompt itself unless a short clarifying note is genuinely needed.',
      'Output ONLY the finished prompt (in a plain text block is fine for readability), plus a short note only if something essential was ambiguous and you made a reasonable assumption worth flagging. Do not output ```file: code blocks or studio-action blocks -- you are never editing anything directly in this category.',
    ].join('\n'),
    responseFormat: ['The finished prompt'],
  },

  'explain-compare': {
    id: 'explain-compare',
    label: 'Explain/Compare',
    uiLabel: 'Fast Explain',
    description: 'Quick, direct answers to "which is better", "how hard is this", "is this worth it", "what should I use" style questions.',
    thinkingLevel: 'low',
    tools: [],
    promptMode: 'replace',
    systemPrompt: [
      'You are ROTEX AI answering a quick comparison/explanation question -- "which is better", "how hard is this", "is this worth it", "what should I use", "how much can this do", or similar. This is not a build or fix request.',
      'Answer directly first, in the first sentence -- do not bury the answer. Keep the wording simple. Use a concrete example where it actually clarifies something. Do not pad the response or restate the question back. End with one clear recommendation.',
      'Do not output ```file: code blocks or studio-action blocks in this category unless a tiny inline snippet is the clearest way to illustrate a point -- this is a discussion answer, not an edit.',
    ].join('\n'),
    responseFormat: ['Direct answer', 'Why', 'Best choice', 'What to do next'],
  },

  'general-coding': {
    id: 'general-coding',
    label: 'General Coding',
    uiLabel: 'General Coding',
    description: 'Python, JavaScript, TypeScript, HTML, CSS, Node, APIs, databases, automation, and other non-game coding.',
    thinkingLevel: 'medium',
    tools: ['project_search', 'file_edit'],
    promptMode: 'inject',
    systemPrompt: [
      'CATEGORY: General Coding. This request is general-purpose coding outside the Roblox/Unity/website-builder categories -- Python, JavaScript, TypeScript, HTML, CSS, Node, APIs, databases, or automation.',
      'Give working code, not pseudocode. Explain exactly where it goes (file/module). Keep the code clean and idiomatic for the language in use. Add real error handling for failure cases that can actually occur, not speculative ones. Never hardcode or expose secrets/keys. Add test steps the user can actually run.',
    ].join('\n'),
    responseFormat: ['What this does/fixes', 'Code', 'Where it goes', 'Test steps'],
  },
};

const CATEGORY_ORDER = Object.keys(CATEGORIES);

// thinkingLevel -> the reasoning-effort vocabulary reasoningFor()/
// effectiveMaxTokens() already use in api/chat.js. 'low' deliberately maps
// to no reasoning at all (not a 'low' effort string) -- OpenRouter's
// reasoning param accepting a literal 'low' value for this model isn't
// verified with a real authenticated call, and "no reasoning" is already a
// safe, proven code path. Not worth the unverified risk for a minor
// effort-tier distinction.
const THINKING_LEVEL_TO_EFFORT = {
  low: undefined,
  medium: 'medium',
  high: 'high',
};

// Deterministic, free, instant keyword classifier -- NOT a second LLM call.
// Every routing rule below is a direct transcription of the user's own
// "if the user says X, choose Y" spec, which is itself entirely
// keyword-based. Adding a real model call here would add a full extra
// round-trip of latency and a second billed request to reimplement logic
// that's already fully specified as if/else on substrings.
//
// Rule order encodes priority (first match wins), resolving overlaps the
// user's flat list doesn't explicitly order:
//   1. Prompt Maker phrasing ("make me a prompt", "write a prompt for") and
//      Explain/Compare phrasing ("which is better", "how much", "is it
//      good") checked FIRST. These describe the TASK TYPE the user wants
//      (a prompt to hand off, or a quick comparison), independent of which
//      domain the request happens to mention -- "write me a prompt for a
//      login system" is a Prompt Maker request even though "login" would
//      otherwise match Website/App Builder; checking domain keywords first
//      would wrongly grab it.
//   2. ROTEX-specific terms (branded, unambiguous) next.
//   3. Unity terms -- Unity Builder covers both building AND fixing Unity
//      issues in one category (there's no separate "Unity Bug Fix"), so an
//      explicit Unity signal should win over generic "broken" language
//      even though Roblox bug-fix is checked before Roblox Builder below.
//   4. Website/app terms -- checked after ROTEX since "credits"/"app" show
//      up in both the ROTEX and Website rule lists, and ROTEX's own
//      terminology is the more specific signal when both are present.
//   5. Roblox + broken/bugged language -> Roblox Bug Fix. Checked before
//      plain Roblox Builder terms so "my roblox tool is broken" routes to
//      the bug-fix category, not the builder category. Roblox is treated
//      as the default domain for bare "broken" language with no other
//      domain signal, since Roblox Bug Fix is the only dedicated bug-fix
//      category and this is a Roblox-first app.
//   6. Roblox Builder terms.
//   7. Default: General Coding.
//
// Regex note: most alternations below use a LEADING \b only, not a
// trailing one -- Roblox/Unity/Website terms have common plural/suffixed
// forms in real usage ("gamepasses", "tycoons", "prefabs", "dashboards",
// "subscriptions") that a blanket \b(...)\b around the whole group would
// silently fail to match (the trailing \b requires a boundary right after
// the shortest alternative, breaking on anything longer sharing that
// prefix). Short, acronym-style terms prone to appearing as substrings of
// unrelated words (api, vr, xr, npc) keep full \b...\b wrapping instead.
function routeCategory(userText, context = {}) {
  const text = String(userText || '').toLowerCase();

  const has = (re) => re.test(text);
  const PROMPT_MAKER_RE = /\b(make (me )?a prompt|write (me )?a prompt|give me a prompt|prompt (for|to give))\b/;
  const EXPLAIN_RE = /\b(which is better|which one is better|how (hard|much)|is (it|this) (worth|good)|what should i use|how good is|is .+ (hard|easy|worth it) to\b)/;
  const ROTEX_RE = /\b(rotex|model picker|google flash|texbrain|free plan|pro plan|team ?up|teamup)\b/;
  const UNITY_RE = /\b(unity|c#|gameobject|monobehaviour|prefab|xr rig|xr origin)|\bvr\b|\bxr\b/;
  const WEBSITE_RE = /\b(website|web app|stripe|dashboard|login|backend|frontend|vercel|supabase|subscription)|\bapi\b/;
  const BROKEN_RE = /\b(broken|bugged|not working|doesn'?t work|stopped working|can'?t turn|won'?t work|glitch(ed|ing)?|fix (it|this|the|my))\b/;
  const ROBLOX_RE = /\b(roblox|luau|studio|gamepass|game ?pass|datastore|remoteevent|remotefunction|tycoon|simulator|obby|leaderstat)|\bnpc\b/;

  // ROTEX already knows which engine the user is working in via the
  // project's selected engine mode (editor.html's #rxProjectMode /
  // api/chat.js's projectMode parameter) -- this was previously accepted as
  // a context parameter but never actually read, which meant a Unity
  // project with a generic message ("add a flashlight system", "the enemy
  // AI feels broken" -- no literal "unity"/"c#"/"broken"-defaults-to-Roblox
  // override) silently never routed to Unity Builder at all.
  const isUnityProject = String(context.projectMode || '').toLowerCase() === 'unity';
  const isRobloxProject = String(context.projectMode || '').toLowerCase() === 'roblox';

  let category = 'general-coding';
  if (has(PROMPT_MAKER_RE)) category = 'prompt-maker';
  else if (has(EXPLAIN_RE)) category = 'explain-compare';
  else if (has(ROTEX_RE)) category = 'rotex-app-mode';
  else if (has(UNITY_RE)) category = 'unity-builder';
  else if (has(WEBSITE_RE)) category = 'web-app-builder';
  // Explicit Roblox keyword present: bug-fix language wins over plain
  // builder (checked together, not as two separate branches, so the
  // "no explicit keyword at all" fallback below can't accidentally get
  // short-circuited by the old, broader !has(WEBSITE_RE) check).
  else if (has(ROBLOX_RE)) category = has(BROKEN_RE) ? 'roblox-bugfix' : 'roblox-builder';
  // No explicit domain keyword anywhere -- fall back to the project's own
  // known engine. Unity Builder covers both build and fix for Unity (no
  // separate "Unity Bug Fix" category exists). Roblox is still the
  // assumed default for bare "broken" language when the project mode
  // itself isn't known to be Unity, since this is a Roblox-first app and
  // Roblox Bug Fix is the only dedicated bug-fix category.
  else if (isUnityProject) category = 'unity-builder';
  else if (has(BROKEN_RE)) category = 'roblox-bugfix';
  else if (isRobloxProject) category = 'roblox-builder';

  const cat = CATEGORIES[category];
  const riskyRe = /\b(datastore|money|currency|robux|purchase|gamepass|admin|payment|credit card|api key|secret)\b/;

  return {
    app: 'ROTEX',
    category,
    task_type: has(BROKEN_RE) ? 'fix' : category === 'prompt-maker' ? 'prompt' : category === 'explain-compare' ? 'explain' : 'build',
    project_type: category === 'roblox-builder' || category === 'roblox-bugfix' ? 'roblox'
      : category === 'unity-builder' ? 'unity'
      : category === 'web-app-builder' || category === 'rotex-app-mode' ? 'web'
      : 'unknown',
    needs_files: cat.tools.includes('file_edit'),
    needs_web: cat.tools.includes('toolbox_search'),
    risk_level: has(riskyRe) ? 'high' : cat.promptMode === 'replace' ? 'low' : 'medium',
    thinking_level: cat.thinkingLevel,
    should_use_tools: cat.tools.length > 0,
    response_style: cat.promptMode === 'replace' ? 'short' : 'detailed',
    reason: `matched ${category} via keyword rules`,
  };
}

module.exports = { CATEGORIES, CATEGORY_ORDER, THINKING_LEVEL_TO_EFFORT, routeCategory };
