const { getAuthUserId } = require('./_lib/clerk-auth');
const { getBalance, adjustBalance, getPlan, setJob } = require('./_lib/credits-store');
const { TEXTURE_COST } = require('./_lib/pricing');

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

// Adds texture to an already-generated model. Prefers N8 Speed's dedicated
// POST /texture/{job_id} (textures the exact shape already shown, no new
// random model) over resubmitting /generate with texture:true. Falls back
// to the old /generate-based path only when there's no job id to texture, or
// when the upstream job has aged out of its ~24h window (404) -- in which
// case this really is a fresh regeneration from the original prompt/image,
// not the same model, and the response says so via same_model:false.
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const userId = await getAuthUserId(req);
  if (!userId) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'Sign in required.' }));
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Invalid request body.' }));
    return;
  }

  const jobId = typeof body.job_id === 'string' ? body.job_id : '';
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const imageB64 = typeof body.image_b64 === 'string' ? body.image_b64 : '';
  const hasImage = imageB64.length > 0;
  const targetFaces = typeof body.target_faces === 'number' ? body.target_faces : undefined;

  if (!jobId && !prompt && !hasImage) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Generate a model first.' }));
    return;
  }

  const cost = TEXTURE_COST;
  const balance = await getBalance(userId);
  if (balance < cost) {
    res.statusCode = 402;
    res.end(JSON.stringify({
      error: 'insufficient_credits',
      message: `You need ${cost} credits for this. You have ${balance}.`,
      required: cost,
      balance,
    }));
    return;
  }

  const apiUrl = process.env.N8_SPEED_API_URL;
  const apiKey = process.env.N8_SPEED_API_KEY;
  if (!apiUrl || !apiKey) {
    console.error('N8 Speed misconfigured: missing N8_SPEED_API_URL/N8_SPEED_API_KEY');
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'Generation service is temporarily unavailable.' }));
    return;
  }
  const baseUrl = apiUrl.replace(/\/+$/, '');
  const plan = await getPlan(userId);

  let upstream = null;
  let sameModel = true;

  if (jobId) {
    const textureBody = { plan };
    if (targetFaces !== undefined) textureBody.target_faces = targetFaces;
    try {
      upstream = await fetch(`${baseUrl}/texture/${encodeURIComponent(jobId)}`, {
        method: 'POST',
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(textureBody),
      });
    } catch (err) {
      console.error('N8 Speed /texture request failed:', err);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Generation service is temporarily unavailable.' }));
      return;
    }
    if (upstream.status === 404) {
      upstream = null; // job expired past its ~24h window -- fall back below
    }
  }

  if (!upstream) {
    if (!prompt && !hasImage) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'That model has expired and can no longer be textured directly. Generate a new one.' }));
      return;
    }
    sameModel = false;
    const upstreamBody = { texture: true, plan };
    if (prompt) upstreamBody.prompt = prompt;
    if (hasImage) upstreamBody.image_b64 = imageB64;
    if (targetFaces !== undefined) upstreamBody.target_faces = targetFaces;
    try {
      upstream = await fetch(`${baseUrl}/generate`, {
        method: 'POST',
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(upstreamBody),
      });
    } catch (err) {
      console.error('N8 Speed /generate (texture fallback) request failed:', err);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Generation service is temporarily unavailable.' }));
      return;
    }
  }

  if (upstream.status === 401) {
    console.error('N8 Speed rejected our API key (401) -- check N8_SPEED_API_KEY.');
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'Generation service is temporarily unavailable.' }));
    return;
  }

  const upstreamData = await upstream.json().catch(() => ({}));

  if (upstream.status === 400) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: upstreamData.message || 'Invalid generation request.' }));
    return;
  }

  if (!upstream.ok) {
    console.error('N8 Speed unexpected status', upstream.status, upstreamData);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'Generation service is temporarily unavailable.' }));
    return;
  }

  const newJobId = upstreamData.job_id;
  const newBalance = await adjustBalance(userId, -cost);
  await setJob(newJobId, { userId, cost, status: 'charged' });

  res.statusCode = 200;
  res.end(JSON.stringify({
    job_id: newJobId,
    queue_position: upstreamData.queue_position,
    message: upstreamData.message,
    cost,
    balance: newBalance,
    same_model: sameModel,
  }));
};
