// ROTEX Roblox Dev Mode: deterministic planning metadata and prompt blocks.
// This is intentionally local/instant. It gives Claude Haiku and Google Flash
// a structured Roblox workflow without adding a second slow model call.

const PROJECT_MEMORY_SCHEMA = {
  project_name: '',
  platform: 'Roblox',
  genre: '',
  game_description: '',
  user_skill_level: 'beginner',
  current_features: [],
  planned_features: [],
  scripts_created: [],
  localscripts_created: [],
  modulescripts_created: [],
  remoteevents_created: [],
  remotefunctions_created: [],
  folders_created: [],
  ui_created: [],
  workspace_objects: [],
  datastores: [],
  gamepasses: [],
  developer_products: [],
  bugs_fixed: [],
  known_errors: [],
  coding_style: 'simple, clean, commented',
  preferred_response_style: 'clear, direct, step-by-step',
};

const FEATURE_TEMPLATES = [
  'Leaderstats',
  'Coins/currency',
  'Shop UI',
  'Inventory system',
  'Gamepass system',
  'Developer product system',
  'DataStore save/load',
  'Round system',
  'Team system',
  'Ability/powers system',
  'Cooldown system',
  'Fireball ability',
  'Ice ability',
  'Lightning ability',
  'Door/keycard system',
  'NPC dialogue',
  'Quest system',
  'Teleport system',
  'Main menu',
  'Loading screen',
  'Settings menu',
  'Mobile controls',
  'Sprint system',
  'Health/damage system',
  'Admin commands',
  'Pet system',
  'Tool system',
  'ProximityPrompt interaction',
  'Daily rewards',
  'Codes/redeem system',
];

const CODE_REVIEW_CHECKLIST = {
  has_setup_steps: true,
  has_correct_script_locations: true,
  has_remoteevent_setup: true,
  has_server_validation: true,
  has_testing_steps: true,
  has_common_bugs: true,
  uses_real_roblox_apis: true,
  does_not_trust_client: true,
  beginner_friendly: true,
  not_too_short: true,
};

const UI_CATEGORY_LAYOUT = {
  Roblox: [
    'Roblox Scripter',
    'Bug Fixer',
    'UI Builder',
    'Game Systems',
    'DataStore Saver',
    'Gamepass Helper',
    'Prompt Builder',
    'Code Reviewer',
    'Studio Setup Helper',
    'Model Import Helper',
  ],
  Unity: [
    'Unity C# Helper',
    'Unity VR Helper',
    'Multiplayer Helper',
    'Bug Fixer',
  ],
  General: [
    '3D Model Helper',
    'Game Idea Helper',
    'Dev Business Helper',
    'Portfolio/Commission Helper',
  ],
};

const UI_VISIBILITY_GUARANTEE = [
  'ROBLOX UI VISIBILITY GUARANTEE:',
  '- UI that should appear on screen must be owned by exactly one LocalScript, preferably at StarterPlayer/StarterPlayerScripts/FeatureName.client.lua unless the existing owner is in StarterGui.',
  '- Runtime UI code must parent the ScreenGui to player:WaitForChild("PlayerGui"), not Workspace, ServerScriptService, or ReplicatedStorage.',
  '- ScreenGui must have Enabled = true, ResetOnSpawn = false for persistent HUD/shop/menu UI, IgnoreGuiInset chosen intentionally, DisplayOrder high enough to be visible, and ZIndexBehavior = Enum.ZIndexBehavior.Sibling.',
  '- Every visible Frame/TextLabel/TextButton/ImageLabel must have non-zero Size, on-screen Position/AnchorPoint, BackgroundTransparency less than 1 when it needs a visible panel, TextColor3 with contrast, and ZIndex not buried behind the panel.',
  '- If rebuilding UI from a LocalScript, destroy the previous ScreenGui with the same name before creating a new one so duplicate bars/shops do not stack.',
  '- For toggled UI, wire the open/close function to a real TextButton, keybind, ProximityPrompt, or RemoteEvent. A hidden panel with no connected opener is a broken UI.',
  '- For new visual UI, prefer ROTEX create_ui studio-actions to create real StarterGui ScreenGui trees immediately, then add a .client.lua LocalScript only for behavior. This prevents runtime-only scripts from looking like they did nothing in Studio edit mode.',
  '- For bug reports like "not showing", "invisible", "button does nothing", "still two bars", or "it did not change", fix the existing owner script and delete stale duplicate owners instead of creating a second copy.',
  '- Never use Workspace Parts, create_model, roblox-model, or Toolbox assets as GUI. Those are world objects, not ScreenGui UI.',
].join('\n');

const FORGE_GRADE_OPERATING_LOOP = [
  'FORGE-GRADE ROTEX OPERATING LOOP:',
  '- Act like a Roblox Studio feature builder, not a prompt rewriter and not a snippet bot.',
  '- Internally run five roles before every Agent/Super Agent edit: Architect, Studio Mapper, UI/UX Builder, Security Reviewer, Applyability Auditor.',
  '- Architect: define the real user-visible outcome and choose create/modify/remove/debug/verify.',
  '- Studio Mapper: identify the exact existing owner scripts, ScreenGuis, RemoteEvents, Tools, folders, terrain, lighting, or Workspace instances from PROJECT CONTEXT before creating anything new.',
  '- UI/UX Builder: if UI is involved, create a visible, polished, responsive ScreenGui tree with sane anchors, UIScale, DisplayOrder, and connected behavior. A hidden panel, unconnected button, or runtime-only UI that cannot be seen in Studio edit view is not good enough.',
  '- Security Reviewer: server owns currency, purchases, inventory, rewards, damage, cooldowns, admin, DataStores, teleports, and round state. Client owns input, camera, animation, local visual effects, and UI display only.',
  '- Applyability Auditor: every edit must be expressed as hidden ROTEX executable blocks with real service roots and valid Studio action JSON. Plain text promises do not change Studio.',
  '- Verification: mentally test Play Solo, respawn, mobile screen sizes, and two-player multiplayer. If the user says it still did not change, assume wrong owner, duplicate script, hidden GUI, or failed action verification and repair that instead of repeating yourself.',
].join('\n');

const FORGE_GUI_ASSET_STANDARD = [
  'FORGE-STYLE ROBLOX UI STANDARD:',
  '- For "make UI" requests, produce a complete UI set, not one raw Frame: root ScreenGui, main container, title/text, buttons, states, close/open behavior when relevant, padding/layout, visual hierarchy, and mobile scaling.',
  '- Use game-ready visual details: readable contrast, consistent spacing, UICorner, UIStroke, UIGradient only when tasteful, shadows via subtle extra frames only when needed, and text sizes that fit on desktop and mobile.',
  '- Prefer create_ui studio-actions for visible StarterGui objects, then add exactly one LocalScript owner for behavior. If the UI is already in PROJECT CONTEXT, modify that existing owner and delete/disable duplicates.',
  '- If the user requests images/icons and a Roblox asset id is already available from context/tool results, use create_ui_image. Do not invent asset ids. Toolbox is for physical Workspace models/props/objects (map dressing, furniture, vehicles, weapons/characters as models, decorations, etc.), NOT for ScreenGui UI/icons.',
  '- If a UI does not show, fix visibility/root cause first: PlayerGui/StarterGui parent, Enabled, Visible, DisplayOrder/ZIndex, non-zero Size, on-screen Position, ResetOnSpawn, LocalScript placement, and connected opener controls.',
].join('\n');

const STUDIO_APPLYABILITY_CONTRACT = [
  'STUDIO APPLYABILITY CONTRACT:',
  '- Agent and Super Agent are not allowed to answer an edit request with only advice.',
  '- If the plugin/context is available, output executable blocks that ROTEX can queue: ```file:Service/path.lua, ```studio-action JSON, or ```roblox-model JSON.',
  '- If a task needs deletion or cleanup, include delete_instance/set_property actions for the exact stale paths.',
  '- If the model cannot identify a safe target after reading context, ask one short blocking question and say what exact missing target is needed.',
  '- Never say "done", "fixed", "updated", or "created" unless an executable block in the same answer would actually perform that change.',
].join('\n');

const VFX_GUIDE = [
  'ROBLOX VFX (VISUAL EFFECTS) — build these in Lua (Instance.new) or a studio-action; there is no VFX Toolbox, you script them:',
  '- The VFX objects are ParticleEmitter, Beam, Trail, Fire, Smoke, Sparkles, Explosion, and animated PointLight/SpotLight. Each is parented to a BasePart or an Attachment inside a part.',
  '- ParticleEmitter (put it in a Part or Attachment). Core props: Texture (an rbxassetid image — use a soft circle/glow id or leave default), Rate (constant stream) OR :Emit(n) for a one-shot burst, Lifetime = NumberRange.new(min,max), Speed = NumberRange.new, SpreadAngle = Vector2.new, Rotation, RotSpeed, Acceleration = Vector3 (gravity or rising smoke), Color = ColorSequence, Size = NumberSequence, Transparency = NumberSequence (ALWAYS end at 1 so particles fade out), LightEmission 0..1 (glow), LightInfluence 0 = full-bright.',
  '- Beam links two Attachments (Attachment0/Attachment1). Set Width0/Width1, Color = ColorSequence, Transparency = NumberSequence, CurveSize0/1 for bend, FaceCamera = true, and Texture + TextureSpeed + TextureLength for flowing lasers/lightning/magic tethers.',
  '- Trail needs Attachment0 + Attachment1 on a MOVING part (offset apart). Set Lifetime, Color, Transparency, WidthScale, FaceCamera, LightEmission. Use it for swords, projectiles, dashes.',
  '- ColorSequence.new(Color3...) or {ColorSequenceKeypoint.new(t,color),...}; NumberSequence.new(v) or {NumberSequenceKeypoint.new(t,value),...} with t from 0 to 1. Fade Transparency to 1 at t=1.',
  '- Glow/pulse: set LightEmission near 1 and add a PointLight; animate its Brightness/Range with TweenService. Explosions/hits: :Emit() a burst, then Debris:AddItem(part, lifetime) so it cleans itself up — never leave one-shot emitters running forever (performance).',
  '- Networking: purely cosmetic local VFX can run in a LocalScript; VFX everyone must see should be created on the server, or triggered by a RemoteEvent that runs a client-side VFX function on each player.',
].join('\n');

const ROBLOX_SYSTEM_PROMPTS = {
  claudeHaiku: [
    'You are ROTEX Roblox Dev Mode powered by Claude Haiku.',
    'You are an expert Roblox Studio assistant for Luau scripting, debugging, UI, game systems, RemoteEvents, DataStores, shops, leaderstats, gamepasses, and developer products.',
    'Give clear beginner-friendly answers. For code, always explain where each script goes.',
    'Never invent Roblox APIs. If unsure, avoid the API or say to verify it in Roblox Creator Hub.',
    'Never trust the client for important multiplayer logic. Validate currency, damage, rewards, cooldowns, inventory, purchases, and teleports on the server.',
    'When giving code, include setup steps, full code, testing steps, and common bugs.',
    FORGE_GRADE_OPERATING_LOOP,
    FORGE_GUI_ASSET_STANDARD,
    STUDIO_APPLYABILITY_CONTRACT,
    UI_VISIBILITY_GUARANTEE,
    VFX_GUIDE,
  ].join('\n'),
  geminiFlash: [
    'You are ROTEX Roblox Dev Mode powered by Gemini Flash.',
    'Your job is fast planning, classification, structured JSON, quality checking, and prompt improvement.',
    'Classify Roblox requests, create project plans, check missing setup steps, check script placement, check security rules, and review final answers.',
    'Never invent Roblox APIs. Flag risky code that trusts the client.',
    'Flag missing RemoteEvents, missing script locations, missing UI setup, missing testing steps, or vague instructions.',
    FORGE_GRADE_OPERATING_LOOP,
    FORGE_GUI_ASSET_STANDARD,
    STUDIO_APPLYABILITY_CONTRACT,
    UI_VISIBILITY_GUARANTEE,
    VFX_GUIDE,
  ].join('\n'),
};

function classifyRobloxRequest(userText, projectMode = 'Roblox') {
  const text = String(userText || '').toLowerCase();
  const has = (re) => re.test(text);
  const platform = has(/\bunity|c#|gameobject|prefab|photon|fusion|netcode|xr|vr\b/) ? 'Unity'
    : has(/\broblox|luau|studio|remoteevent|datastore|gamepass|leaderstats|startergui|workspace\b/) || String(projectMode).toLowerCase() === 'roblox' ? 'Roblox'
      : 'General';
  let category = 'non_dev_question';
  if (platform === 'Unity') category = has(/\bvr|xr|gorilla|photon|fusion|netcode\b/) ? 'unity_vr' : 'general_game_dev';
  else if (platform === 'Roblox') {
    if (has(/\b(prompt|tell claude|tell codex|cursor)\b/)) category = 'prompt_generation';
    else if (has(/\b(error|warn|stack|broken|bug|fix|not working|doesn'?t work|nil|attempt to|not a valid member)\b/)) category = 'bug_fixing';
    else if (has(/\b(ui|gui|button|frame|screen|menu|hud|shop panel|inventory panel)\b/)) category = 'ui';
    else if (has(/\b(gamepass|developer product|dev product|purchase|monetization|marketplaceservice)\b/)) category = 'monetization';
    else if (has(/\b(datastore|save|load|autosave|data store|player data)\b/)) category = 'datastore_saving';
    else if (has(/\b(remoteevent|remotefunction|multiplayer|server|client|replicatedstorage|exploit)\b/)) category = 'multiplayer_remotes';
    else if (has(/\b(map|model|mesh|meshpart|fbx|asset manager|terrain|building|lobby|prop)\b/)) category = 'map_modeling';
    else if (has(/\b(leaderstats|shop|inventory|round|team|power|ability|combat|quest|npc|teleport|door|tool|pet|daily reward|codes?)\b/)) category = 'game_system';
    else category = 'scripting';
  } else if (has(/\b(game|dev|3d|model|portfolio|commission|business)\b/)) {
    category = 'general_game_dev';
  }
  const needsCode = platform === 'Roblox' && !['prompt_generation', 'non_dev_question'].includes(category);
  return {
    platform,
    category,
    difficulty: has(/\bdatastore|monetization|combat|admin|multiplayer|inventory|round system\b/) ? 'advanced' : has(/\bui|leaderstats|sprint|tool\b/) ? 'intermediate' : 'beginner',
    needs_code: needsCode,
    needs_setup_steps: needsCode,
    needs_memory_update: needsCode || has(/\bremember this|game name|called|feature\b/),
    best_model: needsCode ? 'claude_haiku' : 'gemini_flash',
    second_pass_model: needsCode ? 'gemini_flash' : 'claude_haiku',
    should_ask_question: false,
    assumptions: platform === 'Roblox' ? ['This is for Roblox Studio multiplayer unless the user says otherwise.'] : [],
  };
}

function buildPromptBuilderFormat() {
  return [
    'PROMPT BUILDER FORMAT:',
    '## Context',
    '## Goal',
    '## Current setup',
    '## Roblox Studio objects needed',
    '## Script placement',
    '## Feature requirements',
    '## Security rules',
    '## Code quality rules',
    '## Testing checklist',
    '## Output required',
  ].join('\n');
}

function buildRobloxDevModeBrief({ userText, projectMode, selectedModelName, categoryId }) {
  const classification = classifyRobloxRequest(userText, projectMode);
  const modelPrompt = /claude/i.test(selectedModelName || '') ? ROBLOX_SYSTEM_PROMPTS.claudeHaiku : ROBLOX_SYSTEM_PROMPTS.geminiFlash;
  return [
    'ROTEX ROBLOX DEV MODE STRUCTURED PIPELINE:',
    `Request classifier JSON: ${JSON.stringify(classification)}`,
    `Active category: ${categoryId || 'auto'}`,
    modelPrompt,
    'Pipeline: classify request -> load project memory -> plan Roblox objects/scripts/remotes/UI -> check script placement -> generate answer/edit blocks -> hidden review checklist -> save useful memory.',
    'Required Roblox code answer sections when visible code is allowed: 1. What this does, 2. Create these things in Roblox Studio, 3. Where each script goes, 4. Code, 5. How to test, 6. Common bugs, 7. Next upgrades.',
    'For Agent/Super Agent, keep code/action JSON hidden in executable blocks and make visible text short, but still follow the same setup/security logic internally.',
    'Template library available: ' + FEATURE_TEMPLATES.join(', ') + '.',
    'Project memory JSON schema: ' + JSON.stringify(PROJECT_MEMORY_SCHEMA),
    'Hidden code review checklist: ' + JSON.stringify(CODE_REVIEW_CHECKLIST),
    FORGE_GRADE_OPERATING_LOOP,
    FORGE_GUI_ASSET_STANDARD,
    STUDIO_APPLYABILITY_CONTRACT,
    'Security rules: server owns currency, damage, rewards, inventory, gamepass ownership, cooldowns, teleport permission, admin, and DataStores. Client sends requests only.',
    UI_VISIBILITY_GUARANTEE,
    'Docs rule: never invent fake Roblox APIs. If unsure and docs context is unavailable, avoid the uncertain API or say to verify it in Roblox Creator Hub.',
    buildPromptBuilderFormat(),
  ].join('\n');
}

module.exports = {
  PROJECT_MEMORY_SCHEMA,
  FEATURE_TEMPLATES,
  CODE_REVIEW_CHECKLIST,
  UI_CATEGORY_LAYOUT,
  UI_VISIBILITY_GUARANTEE,
  FORGE_GRADE_OPERATING_LOOP,
  FORGE_GUI_ASSET_STANDARD,
  STUDIO_APPLYABILITY_CONTRACT,
  ROBLOX_SYSTEM_PROMPTS,
  classifyRobloxRequest,
  buildPromptBuilderFormat,
  buildRobloxDevModeBrief,
};
