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

const KEYS = ['fixtures', 'music', 'announcements', 'offers', 'drinks', 'hours', 'highlights', 'week', 'hero', 'stats', 'brand', 'copy', 'jugs'];

const DEFAULTS = {
  brand: [{ name: 'The Vulcan', messenger: 'https://m.me/thevulcanpubwalkden', facebook: 'https://www.facebook.com/thevulcanpubwalkden', instagram: 'https://www.instagram.com/thevulcanpubwalkden/', address: '94 Worsley Road North,\nWalkden, M28 3QW', footerLine: 'Established 1833 · 94 Worsley Road North, Walkden, M28 3QW' }],
  copy: [{}],
  jugs: [
    { name: 'Vulcan Bomber', recipe: '6x Smirnoff vodka, Vimto, lemonade, ice' },
    { name: 'Vulcan Fun', recipe: '3x Smirnoff vodka, 2x Archers, Malibu, J20, lemonade & ice' },
    { name: 'Vulcan Jack', recipe: "5x Jack Daniel's, 2x ginger ale, lime juice, Coca Cola, ice" },
    { name: 'Vulcan Beast', recipe: '2x Blue WKD, 2x Orange WKD, 2x Smirnoff Ice, ice' },
    { name: 'Vulcan Chill', recipe: '5x Southern Comfort, lime juice, lemonade, ice' },
    { name: 'Vulcan Sourz', recipe: '2x Vulcan Juice, one of each Sourz, lemonade, ice' },
    { name: 'Cheeky Vimto', recipe: '4x 50ml port, 3x Blue WKD, ice' },
    { name: 'Vulcan Fire', recipe: '5x Fireball, 4x cranberry or apple, half pint lemonade or pint and a half of coke' }
  ],
  hero: [{ kicker: 'Walkden \u00b7 Established 1833', title: 'The best night\nin town.', subtitle: 'A proper local. Every match on the big screens, live bands most weekends, and a warm welcome at the bar seven days a week.' }],
  stats: [
    { figure: '23', label: 'TVs for sports and football' },
    { figure: '75"', label: 'Big screen on the stage' },
    { figure: '2', label: 'Outdoor screens out back' },
    { figure: '7', label: 'Days a week, open late' }
  ],
  fixtures: [], music: [], announcements: [], offers: [], drinks: [],
  week: [
    { day: 'Tuesday', title: 'Quiz Night', detail: 'Teams of up to six. Cash prize and a bar tab.', time: 'From 8pm' },
    { day: 'Friday', title: 'Karaoke', detail: 'Grab the mic. Free entry, everyone welcome.', time: 'From 9pm' },
    { day: 'Saturday', title: 'Live Music', detail: 'Bands and singers on the stage after the football.', time: 'From 9pm' }
  ],
  highlights: [
    { kicker: 'House shot', title: 'The Vulcan Juice', text: 'Our own recipe, made in house. On its own, as a Vulcan Bomb, or with lemonade.' },
    { kicker: 'Over 22 to go at', title: "Jo's Whiskey & Bourbon Bar", text: 'From classic Jim Beam bourbon to Sheep Dog peanut butter whiskey.' },
    { kicker: "Gin o'clock", title: 'Double up for \u00a32.20', text: 'Across the full gin range, all day, every day.' }
  ],
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

const LIMITS = { fixtures: 12, music: 8, announcements: 2, offers: 40, drinks: 12, hours: 7, highlights: 3, week: 7, hero: 1, stats: 4, brand: 1, copy: 1, jugs: 12 };
const MAX_FEATURED = 6;

// Public photo uploads
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
const MAX_UPLOAD = 10 * 1024 * 1024; // 10MB — a phone photo, not a raw file
const MAX_PHOTOS = 300;

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

async function readPhotos(env) {
  try {
    const raw = await env.VULCAN.get('photos');
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

// Five curated themes. Each carries its whole palette so contrast is decided
// here, not left to chance when someone picks an accent.
const THEMES = {
  mahogany: { label: 'Mahogany', dark: true, vars: {
    '--bg':'#1a1310','--panel':'#12100e','--band':'#1f3a34',
    '--ink':'#f2e8d7','--ink2':'#e0d2b8','--muted':'#cbbba0','--dim':'#a89878','--faint':'#a1907a',
    '--accent':'#c9963f','--accent-hi':'#e6b969','--on-accent':'#17110e' } },
  snug: { label: 'Snug', dark: true, vars: {
    '--bg':'#16241f','--panel':'#101a17','--band':'#1d2f28',
    '--ink':'#f0ece0','--ink2':'#dcd5c4','--muted':'#c3bba7','--dim':'#a89f8d','--faint':'#a49c8b',
    '--accent':'#d6a15a','--accent-hi':'#ecbd7d','--on-accent':'#101a17' } },
  publicbar: { label: 'Public Bar', dark: true, vars: {
    '--bg':'#17161a','--panel':'#0f0e11','--band':'#231f21',
    '--ink':'#f1eeea','--ink2':'#ddd7d0','--muted':'#c2bab1','--dim':'#a8a09a','--faint':'#a49c96',
    '--accent':'#e08a63','--accent-hi':'#f0a483','--on-accent':'#14100e' } },
  parlour: { label: 'Parlour', dark: false, vars: {
    '--bg':'#f4efe4','--panel':'#ebe3d4','--band':'#e3dac7',
    '--ink':'#1f1712','--ink2':'#3a2e24','--muted':'#544a3e','--dim':'#645847','--faint':'#6a5e4f',
    '--accent':'#3f5c33','--accent-hi':'#2f461f','--on-accent':'#f7f2e7' } },
  taproom: { label: 'Tap Room', dark: false, vars: {
    '--bg':'#f1eeea','--panel':'#e6e1da','--band':'#ded7cd',
    '--ink':'#211c19','--ink2':'#3a322c','--muted':'#554c44','--dim':'#63594f','--faint':'#6b6157',
    '--accent':'#8d2f24','--accent-hi':'#6f231a','--on-accent':'#f7f2e7' } }
};

async function readTheme(env) {
  try {
    const raw = await env.VULCAN.get('theme');
    const t = raw ? JSON.parse(raw) : null;
    const name = t && THEMES[t.name] ? t.name : 'mahogany';
    return { name, label: THEMES[name].label, vars: THEMES[name].vars };
  } catch { return { name: 'mahogany', label: THEMES.mahogany.label, vars: THEMES.mahogany.vars }; }
}

async function readSettings(env) {
  try {
    const raw = await env.VULCAN.get('settings');
    const parsed = raw ? JSON.parse(raw) : null;
    return { uploadsOpen: parsed ? !!parsed.uploadsOpen : true };
  } catch { return { uploadsOpen: true }; }
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
  if (key === 'highlights' && !every(r => str(r.kicker) && str(r.title) && typeof r.text === 'string' && r.text.length <= 300))
    return 'Each highlight needs a label, a title and text under 300 characters';
  if (key === 'week' && !every(r => str(r.day) && str(r.title) && str(r.detail) && str(r.time)))
    return 'Each weekly night needs a day, title, description and time';
  if (key === 'hero' && !every(r => str(r.kicker) && str(r.title) && typeof r.subtitle === 'string' && r.subtitle.length <= 300))
    return 'The hero needs a label, a headline and text under 300 characters';
  if (key === 'stats' && !every(r => str(r.figure) && str(r.label)))
    return 'Each figure needs a number and a label';
  if (key === 'jugs' && !every(r => str(r.name) && typeof r.recipe === 'string' && r.recipe.length <= 300))
    return 'Each jug needs a name and a recipe under 300 characters';
  if (key === 'copy' && !every(r => Object.values(r).every(v => typeof v === 'string' && v.length <= 400)))
    return 'Each piece of copy must be text under 400 characters';
  if (key === 'brand') {
    if (!every(r => str(r.name) && r.name.trim().length > 1)) return 'The pub needs a name';
    const link = v => v === '' || v === undefined || /^https?:\/\/\S+$/.test(String(v));
    if (!every(r => link(r.messenger) && link(r.facebook) && link(r.instagram)))
      return 'Links must start with https:// — leave one empty to hide it';
  }
  return null;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    const secret = env.SESSION_SECRET || 'dev-only-secret';

    if (path === '/api/content' && req.method === 'GET') {
      const [content, photos, theme] = await Promise.all([readAll(env), readPhotos(env), readTheme(env)]);
      return json({ ...content, photos, theme }, 200, { 'cache-control': 'public, max-age=60' });
    }

    // Public photo, straight from R2. Immutable — the key never changes.
    if (path.startsWith('/photo/') && req.method === 'GET') {
      const key = decodeURIComponent(path.slice('/photo/'.length));
      const obj = await env.PHOTOS.get(key);
      if (!obj) return new Response('Not found', { status: 404 });
      return new Response(obj.body, {
        headers: {
          'content-type': obj.httpMetadata?.contentType || 'image/jpeg',
          'cache-control': 'public, max-age=31536000, immutable'
        }
      });
    }

    // Public upload from the QR code. Auto-publishes; the landlord can bin any
    // photo from the admin, or close uploads entirely.
    if (path === '/api/upload' && req.method === 'POST') {
      const settings = await readSettings(env);
      if (!settings.uploadsOpen) return json({ error: 'Photo uploads are closed at the moment' }, 403);

      const type = req.headers.get('content-type') || '';
      if (!ALLOWED_TYPES.includes(type)) return json({ error: 'That file type is not supported — JPEG, PNG, WebP or HEIC only' }, 415);

      const size = Number(req.headers.get('content-length') || 0);
      if (size > MAX_UPLOAD) return json({ error: 'That photo is too big — 10MB is the limit' }, 413);

      const photos = await readPhotos(env);
      if (photos.length >= MAX_PHOTOS) return json({ error: 'The gallery is full — ask behind the bar' }, 507);

      const ext = ({ 'image/jpeg':'jpg', 'image/png':'png', 'image/webp':'webp', 'image/heic':'heic' })[type] || 'jpg';
      const key = Date.now().toString(36) + '-' + crypto.randomUUID().slice(0, 8) + '.' + ext;

      const body = await req.arrayBuffer();
      if (body.byteLength > MAX_UPLOAD) return json({ error: 'That photo is too big — 10MB is the limit' }, 413);

      await env.PHOTOS.put(key, body, { httpMetadata: { contentType: type } });
      photos.unshift({ key, at: new Date().toISOString() });
      await env.VULCAN.put('photos', JSON.stringify(photos.slice(0, MAX_PHOTOS)));
      return json({ ok: true, key });
    }

    if (path === '/api/uploads-open' && req.method === 'GET') {
      return json(await readSettings(env), 200, { 'cache-control': 'no-store' });
    }

    if (path === '/api/login' && req.method === 'POST') {
      if (!env.ADMIN_PASSWORD) {
        return json({ error: 'No password has been set on the Worker yet (ADMIN_PASSWORD secret is missing)' }, 503);
      }
      const { user, password } = await req.json().catch(() => ({}));
      const ok = safeEqual(user || '', env.ADMIN_USER) && safeEqual(password || '', env.ADMIN_PASSWORD);
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
        const [content, photos, settings, theme] = await Promise.all([readAll(env), readPhotos(env), readSettings(env), readTheme(env)]);
        return json({ ...content, photos, settings, theme, meta });
      }

      // Bin a photo: gone from the gallery and from storage.
      if (path === '/api/admin/photo' && req.method === 'DELETE') {
        const { key } = await req.json().catch(() => ({}));
        if (!key) return json({ error: 'No photo given' }, 400);
        const photos = (await readPhotos(env)).filter(p => p.key !== key);
        await env.VULCAN.put('photos', JSON.stringify(photos));
        await env.PHOTOS.delete(key);
        return json({ ok: true });
      }

      if (path === '/api/admin/theme' && req.method === 'PUT') {
        const { name } = await req.json().catch(() => ({}));
        if (!THEMES[name]) return json({ error: 'Unknown theme' }, 400);
        await env.VULCAN.put('theme', JSON.stringify({ name }));
        return json({ ok: true, theme: { name, label: THEMES[name].label, vars: THEMES[name].vars } });
      }

      // Kill switch for the QR code.
      if (path === '/api/admin/uploads' && req.method === 'PUT') {
        const { open } = await req.json().catch(() => ({}));
        await env.VULCAN.put('settings', JSON.stringify({ uploadsOpen: !!open }));
        return json({ ok: true, uploadsOpen: !!open });
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
