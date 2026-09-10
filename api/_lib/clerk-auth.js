// Verifies the Clerk session token the browser sends as `Authorization:
// Bearer <token>` (obtained client-side via `Clerk.session.getToken()`).
// Dynamic import because @clerk/backend is ESM-only and this file is CJS.
async function getAuthUserId(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;

  try {
    const { verifyToken } = await import('@clerk/backend');
    const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
    return payload.sub || null;
  } catch (err) {
    return null;
  }
}

module.exports = { getAuthUserId };
