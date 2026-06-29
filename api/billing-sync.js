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

  const { uid = '', authToken = '', localBalance = null } = request.body || {};
  const auth = await verifyFirebaseToken(authToken);
  if (!auth.ok || auth.uid !== uid) {
    response.status(401).json({ ok: false, error: 'auth_expired', message: 'Sign in again to sync billing.' });
    return;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) {
    response.status(200).json({ ok: false, error: 'firebase_not_configured' });
    return;
  }

  const docUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/users/${encodeURIComponent(uid)}/billing/textokens`;
  let cloudBalance = 0;
  const getRes = await fetch(docUrl, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  if (getRes.ok) {
    const doc = await getRes.json();
    cloudBalance = readFirestoreNumber(doc.fields?.balance);
  } else if (getRes.status !== 404) {
    const err = await getRes.json().catch(() => ({}));
    response.status(getRes.status).json({ ok: false, error: 'firestore_read_failed', message: err.error?.message || 'Could not read billing balance.' });
    return;
  }

  const local = Math.max(0, Math.floor(Number(localBalance) || 0));
  const best = Math.max(cloudBalance, local);
  if (best > cloudBalance) {
    await fetch(`${docUrl}?updateMask.fieldPaths=balance&updateMask.fieldPaths=updatedAt`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fields: {
          balance: { integerValue: String(best) },
          updatedAt: { timestampValue: new Date().toISOString() },
        },
      }),
    }).catch(() => {});
  }

  response.status(200).json({ ok: true, balance: best, cloudBalance });
};

async function verifyFirebaseToken(authToken) {
  if (!authToken || !process.env.FIREBASE_PROJECT_ID) return { ok: false };
  try {
    const result = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(authToken)}`);
    if (!result.ok) return { ok: false };
    const token = await result.json();
    return {
      ok: token.aud === process.env.FIREBASE_PROJECT_ID && Boolean(token.sub),
      uid: token.sub || '',
    };
  } catch {
    return { ok: false };
  }
}

function readFirestoreNumber(field) {
  if (!field) return 0;
  const raw = field.integerValue ?? field.doubleValue ?? 0;
  return Math.max(0, Math.floor(Number(raw) || 0));
}
