// Netlify serverless function — auth.js
// Passwords live ONLY in Netlify env vars. Never commit real passwords to GitHub.
//
// Required env vars (set in Netlify Dashboard → Site → Environment variables):
//   PASSWORD_EMILIE        manager account
//   PASSWORD_THAO
//   PASSWORD_TUNG
//
// Optional — override brand access per user:
//   BRANDS_THAO=sb,hian,expat
//   BRANDS_TUNG=sb
//
// To add a new user: add PASSWORD_NEWUSERNAME in Netlify env vars. No code change needed.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: 'Bad request' }; }

  const { user, password } = body;
  if (!user || !password) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing credentials' }) };
  }

  const envKey = 'PASSWORD_' + user.toUpperCase();
  const storedPassword = process.env[envKey];

  if (!storedPassword) {
    return { statusCode: 401, body: JSON.stringify({ error: 'User not found' }) };
  }
  if (password !== storedPassword) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Wrong password' }) };
  }

  // Default brand access — override anytime via BRANDS_USERNAME env var
  const defaultBrands = {
    emilie: ['sb', 'hian', 'expat', 'snack'],
    thao:   ['sb'],
    tung:   ['sb', 'hian', 'expat'],
  };
  const brandsEnv = process.env['BRANDS_' + user.toUpperCase()];
  const brands = brandsEnv
    ? brandsEnv.split(',').map(b => b.trim())
    : (defaultBrands[user] || ['sb']);
  const role = user === 'emilie' ? 'manager' : 'staff';

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, role, brands }),
  };
};
