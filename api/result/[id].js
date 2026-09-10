const { getAuthUserId } = require('../_lib/clerk-auth');
const { getJob } = require('../_lib/credits-store');

module.exports = async function handler(req, res) {
  const userId = await getAuthUserId(req);
  if (!userId) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Sign in required.' }));
    return;
  }

  const jobId = (req.query && req.query.id) || '';
  const jobMeta = jobId ? await getJob(jobId) : null;
  if (!jobMeta || jobMeta.userId !== userId) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Job not found.' }));
    return;
  }

  const apiUrl = process.env.N8_SPEED_API_URL;
  const apiKey = process.env.N8_SPEED_API_KEY;
  let upstream;
  try {
    upstream = await fetch(`${apiUrl.replace(/\/+$/, '')}/result/${encodeURIComponent(jobId)}`, {
      headers: { 'X-API-Key': apiKey },
    });
  } catch (err) {
    console.error('N8 Speed /result request failed:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Generation service is temporarily unavailable.' }));
    return;
  }

  if (!upstream.ok) {
    res.statusCode = upstream.status === 404 ? 404 : 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Result not available yet.' }));
    return;
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  res.statusCode = 200;
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'model/gltf-binary');
  res.setHeader('Content-Disposition', `attachment; filename="${jobId}.glb"`);
  res.end(buf);
};
