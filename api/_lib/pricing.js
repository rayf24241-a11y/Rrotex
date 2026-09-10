// Server is the only source of truth for cost -- never trust a client-sent
// price. Base model generation scales with polygon count (target_faces):
//   image -> 3d: 5 credits (min polys) up to 10 credits (max polys)
//   text  -> 3d: 10 credits (min polys) up to 15 credits (max polys)
// Texture is a separate action applied AFTER a model exists (N8 Speed has no
// dedicated texture endpoint, so it's really a full regeneration with
// texture:true under the hood) -- flat 10 credits regardless of poly count.
const MIN_FACES = 1000;
const MAX_FACES = 200000;
const TEXTURE_COST = 10;

function computeModelCost({ hasImage, targetFaces }) {
  let faces = Number(targetFaces);
  if (!Number.isFinite(faces)) faces = MIN_FACES;
  faces = Math.max(MIN_FACES, Math.min(MAX_FACES, faces));
  const ratio = (faces - MIN_FACES) / (MAX_FACES - MIN_FACES);
  const base = hasImage ? 5 + ratio * 5 : 10 + ratio * 5;
  return Math.round(base);
}

// How many models a single Batch-tab click can generate at once, by plan.
// null = unlimited. No real subscription purchase flow exists yet, so
// `plan` is always 'free' in practice until that's wired up.
const BATCH_LIMITS = { free: 1, pro: 5, business: 10, pro_plus: null };

function getBatchLimit(plan) {
  return Object.prototype.hasOwnProperty.call(BATCH_LIMITS, plan) ? BATCH_LIMITS[plan] : BATCH_LIMITS.free;
}

module.exports = { computeModelCost, TEXTURE_COST, MIN_FACES, MAX_FACES, BATCH_LIMITS, getBatchLimit };
