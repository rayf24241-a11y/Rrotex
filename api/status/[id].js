const { getAuthUserId } = require('../_lib/clerk-auth');
const { adjustBalance, getJob, setJob } = require('../_lib/credits-store');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const userId = await getAuthUserId(req);
  if (!userId) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'Sign in required.' }));
    return;
  }

  const jobId = (req.query && req.query.id) || '';
  if (!jobId) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Missing job id.' }));
    return;
  }

  const jobMeta = await getJob(jobId);
  if (!jobMeta || jobMeta.userId !== userId) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Job not found.' }));
    return;
  }

  const apiUrl = process.env.N8_SPEED_API_URL;
  const apiKey = process.env.N8_SPEED_API_KEY;
  let upstream;
  try {
    upstream = await fetch(`${apiUrl.replace(/\/+$/, '')}/status/${encodeURIComponent(jobId)}`, {
      headers: { 'X-API-Key': apiKey },
    });
  } catch (err) {
    console.error('N8 Speed /status request failed:', err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'Generation service is temporarily unavailable.' }));
    return;
  }
  const data = await upstream.json().catch(() => ({}));

  let balance;
  if (data.status === 'error' && jobMeta.status === 'charged') {
    balance = await adjustBalance(userId, jobMeta.cost);
    jobMeta.status = 'refunded';
    await setJob(jobId, jobMeta);
  }

  res.statusCode = 200;
  res.end(JSON.stringify(Object.assign({}, data, balance !== undefined ? { balance, refunded: true } : {})));
};
