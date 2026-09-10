const { getAuthUserId } = require('./_lib/clerk-auth');
const { getBalance, adjustBalance, getPlan, setJob } = require('./_lib/credits-store');
const { computeModelCost } = require('./_lib/pricing');

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

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const imageB64 = typeof body.image_b64 === 'string' ? body.image_b64 : '';
  const hasImage = imageB64.length > 0;
  const targetFaces = typeof body.target_faces === 'number' ? body.target_faces : undefined;

  if (!prompt && !hasImage) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'A prompt or an image is required.' }));
    return;
  }

  const cost = computeModelCost({ hasImage, targetFaces });
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

  const plan = await getPlan(userId);
  // Base model pass is always untextured -- texture is a separate paid
  // action (see api/texture.js) applied after a model exists.
  const upstreamBody = { texture: false, plan };
  if (prompt) upstreamBody.prompt = prompt;
  if (hasImage) upstreamBody.image_b64 = imageB64;
  if (targetFaces !== undefined) upstreamBody.target_faces = targetFaces;

  let upstream;
  try {
    upstream = await fetch(`${apiUrl.replace(/\/+$/, '')}/generate`, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(upstreamBody),
    });
  } catch (err) {
    console.error('N8 Speed /generate request failed:', err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'Generation service is temporarily unavailable.' }));
    return;
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

  const jobId = upstreamData.job_id;
  const newBalance = await adjustBalance(userId, -cost);
  await setJob(jobId, { userId, cost, status: 'charged' });

  res.statusCode = 200;
  res.end(JSON.stringify({
    job_id: jobId,
    queue_position: upstreamData.queue_position,
    message: upstreamData.message,
    cost,
    balance: newBalance,
  }));
};
