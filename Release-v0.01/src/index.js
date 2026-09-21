// The Vulcan — site + admin API on one Worker.
//
// Routes
//   GET  /api/content            public, all lists as one JSON blob
//   POST /api/login              { user, password } -> session cookie
//   POST /api/logout
//   GET  /api/admin/content      auth, same as /api/content plus meta
//   PUT  /api/admin/content      auth, { key, value } writes one list (+ backup)
//   POST /api/admin/rollback     auth, { key } restores the previous version
//   everything else              static files from ./public

const KEYS = ['fixtures', 'music', 'announcements', 'offers', 'drinks', 'hours'];

const DEFAULTS = {
  fixtures: [], music: [], announcements: [], offers: [], drinks: [],
  hours: [
    { day: 'Monday', open: '4pm', close: '12am' },
    { day: 'Tuesday', open: '4pm', close: '12am' },
    { day: 'Wednesday', open: '4pm', close: '12am' },
    { day: 'Thursday', open: '4pm', close: '12am' },
    { day: 'Friday', open: '2pm', close: '1am' },
    { day: 'Saturday', open: '2pm', close: '1am' },
    { day: 'Sunday', open: '2pm', close: '12am' }
  ]
};

const LIMITS = { fixtures: 12, music: 8, announcements: 2, offers: 40, drinks: 12, hours: 7 };
const MAX_FEATURED = 6;

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
  });

// --- session cookie: base64(payload).hex(hmac) -------------------------------

const enc = new TextEncoder();

async function sign(value, secret) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(value));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function makeToken(user, secret) {
  const payload = btoa(JSON.stringify({ u: user, exp: Date.now() + 12 * 60 * 60 * 1000 }));
  return payload + '.' + (await sign(payload, secret));
}

async function readToken(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if ((await sign(payload, secret)) !== sig) return null;
  try {
    const data = JSON.parse(atob(payload));
    return data.exp > Date.now() ? data : null;
  } catch { return null; }
}

function cookie(req, name) {
  const raw = req.headers.get('cookie') || '';
  const hit = raw.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return hit ? hit.slice(name.length + 1) : null;
}

// constant-time-ish compare so login timing does not leak the password
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// --- content -----------------------------------------------------------------

async function readList(env, key) {
  try {
    const raw = await env.VULCAN.get(key);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed : DEFAULTS[key];
  } catch {
    return DEFAULTS[key]; // a bad value never takes the site down
  }
}

async function readAll(env) {
  const out = {};
  await Promise.all(KEYS.map(async k => { out[k] = await readList(env, k); }));
  return out;
}

// Shape guard. Anything unexpected is rejected rather than stored.
function validate(key, value) {
  if (!Array.isArray(value)) return 'Expected a list';
  if (value.length > LIMITS[key]) return `Too many entries — ${LIMITS[key]} is the limit`;
  const str = v => typeof v === 'string' && v.length <= 200;
  const every = fn => value.every(fn);

  if (key === 'fixtures' && !every(r => str(r.day) && str(r.time) && str(r.match) && str(r.comp) && str(r.sport)))
    return 'Each fixture needs day, time, match, comp and sport';
  if (key === 'music' && !every(r => str(r.date) && str(r.act) && str(r.kind) && str(r.time)))
    return 'Each act needs date, act, kind and time';
  if (key === 'announcements' && !every(r => str(r.tag) && typeof r.text === 'string' && r.text.length <= 400))
    return 'Each announcement needs a label and text under 400 characters';
  if (key === 'offers') {
    if (!every(r => str(r.name) && str(r.price) && typeof r.featured === 'boolean'))
      return 'Each offer needs a name, price and featured flag';
    if (value.filter(r => r.featured).length > MAX_FEATURED)
      return `Only ${MAX_FEATURED} offers can be featured`;
  }
  if (key === 'drinks' && !every(r => str(r.title) && Array.isArray(r.items) && r.items.every(str)))
    return 'Each drinks category needs a title and a list of items';
  if (key === 'hours' && !every(r => str(r.day) && str(r.open) && str(r.close)))
    return 'Each day needs a day, open and close';
  return null;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    const secret = env.SESSION_SECRET || 'dev-only-secret';

    if (path === '/api/content' && req.method === 'GET') {
      return json(await readAll(env), 200, { 'cache-control': 'public, max-age=60' });
    }

    if (path === '/api/login' && req.method === 'POST') {
      const { user, password } = await req.json().catch(() => ({}));
      const ok = safeEqual(user || '', env.ADMIN_USER) && safeEqual(password || '', env.ADMIN_PASSWORD || '');
      if (!ok) return json({ error: 'Wrong username or password' }, 401);
      const token = await makeToken(env.ADMIN_USER, secret);
      return json({ ok: true, user: env.ADMIN_USER }, 200, {
        'set-cookie': `vulcan_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`
      });
    }

    if (path === '/api/logout' && req.method === 'POST') {
      return json({ ok: true }, 200, {
        'set-cookie': 'vulcan_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'
      });
    }

    if (path.startsWith('/api/admin/')) {
      const session = await readToken(cookie(req, 'vulcan_session'), secret);
      if (!session) return json({ error: 'Not signed in' }, 401);

      if (path === '/api/admin/content' && req.method === 'GET') {
        const meta = JSON.parse((await env.VULCAN.get('meta')) || '{}');
        return json({ ...(await readAll(env)), meta });
      }

      if (path === '/api/admin/content' && req.method === 'PUT') {
        const { key, value } = await req.json().catch(() => ({}));
        if (!KEYS.includes(key)) return json({ error: 'Unknown section' }, 400);
        const problem = validate(key, value);
        if (problem) return json({ error: problem }, 400);

        const previous = await env.VULCAN.get(key);
        if (previous) await env.VULCAN.put(key + '_prev', previous); // one-step rollback
        await env.VULCAN.put(key, JSON.stringify(value));
        await env.VULCAN.put('meta', JSON.stringify({
          lastPublished: new Date().toISOString(),
          publishedBy: session.u
        }));
        return json({ ok: true, count: value.length });
      }

      if (path === '/api/admin/rollback' && req.method === 'POST') {
        const { key } = await req.json().catch(() => ({}));
        if (!KEYS.includes(key)) return json({ error: 'Unknown section' }, 400);
        const prev = await env.VULCAN.get(key + '_prev');
        if (!prev) return json({ error: 'Nothing to roll back to' }, 404);
        await env.VULCAN.put(key, prev);
        return json({ ok: true });
      }

      return json({ error: 'Not found' }, 404);
    }

    return env.ASSETS.fetch(req);
  }
};
