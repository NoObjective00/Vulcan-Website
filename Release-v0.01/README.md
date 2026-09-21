# The Vulcan, Walkden

Pub website plus a small admin backend. One Cloudflare Worker serves the static
site and a handful of API routes; content lives in Cloudflare KV. Everything
here fits inside the free tier — the only running cost is the domain.

```
wrangler.toml        config: Worker name, KV binding, admin username
src/index.js         the Worker — static files + /api routes
public/
  index.html         the site (self-contained: fonts, styles, hero image inlined)
  admin/index.html   the admin page, served at /admin
  assets/gallery/    gallery photos
  robots.txt         keeps /admin and /api out of search results
```

## Deploy

```bash
npm install -g wrangler
wrangler login

# 1. create the content store — paste the returned id into wrangler.toml
wrangler kv namespace create "KV-TheVulcan-Website-001"

# 2. set the password and a session secret (any long random string)
wrangler secret put ADMIN_PASSWORD
wrangler secret put SESSION_SECRET

# 3. ship it
wrangler deploy
```

Then:

- `/api/content` should return JSON with empty lists — that means the KV binding works
- `/admin` is the login. Username `VulcanAdmin`, password is the secret you set
- add a few fixtures, hit **Publish to site**

No build step. No `npm install` in the project. Deploying a change is
`wrangler deploy`.

## Routes

| Route | Auth | What it does |
|---|---|---|
| `GET /api/content` | public | all lists as one JSON object |
| `POST /api/login` | — | `{user, password}` → 12-hour session cookie |
| `POST /api/logout` | — | clears the cookie |
| `GET /api/admin/content` | yes | as above, plus publish metadata |
| `PUT /api/admin/content` | yes | `{key, value}` writes one list |
| `POST /api/admin/rollback` | yes | `{key}` restores the previous version |
| anything else | — | static file from `public/` |

## KV

Namespace title `KV-TheVulcan-Website-001`, bound in the code as `VULCAN`
(`env.VULCAN`). Bindings must be valid JavaScript identifiers, which is why the
two names differ. Renaming the namespace is safe; renaming the binding means
changing the code too.

Keys: `fixtures` · `music` · `announcements` · `offers` · `drinks` · `hours`

Each holds a JSON array. Each gets a `_prev` twin written on every save — that's
what the rollback button reads. `meta` holds `{ lastPublished, publishedBy }`.

## Why it should stay out of trouble

- **Bad data can't take the site down.** Unparseable KV values fall back to a
  default, so a broken list shows an empty section rather than an error page.
- **Writes are validated before they're stored** — wrong shape, over-long
  strings, or more than six featured offers are refused with a readable message.
- **Per-section caps** stop the layout being flooded. Announcements are two
  fixed slots with no add or delete; clearing the text hides one.
- **Every save keeps the previous version**, so a bad publish is one button away
  from being undone.
- **The password is a Cloudflare secret**, not a value in KV or this repo. It's
  write-only — you can overwrite it, you can't read it back.
- **Session cookie is HttpOnly, Secure, SameSite=Strict**, twelve hours.
- **No image uploads.** Photos are files in this repo, not something that can be
  got wrong at 9pm on a Saturday.

## Changing the password

```bash
wrangler secret put ADMIN_PASSWORD
```

There's no recovery, only replacement. Keep a copy somewhere sensible.

## Adding the real domain later

Workers & Pages → the Worker → Settings → Domains & Routes → Add custom domain.
Point any new Worker at the **same** KV namespace, or you start from empty.

## Editing the site itself

`public/index.html` is a compiled, self-contained file. On load it fetches
`/api/content` and swaps in whatever the admin has published — fixtures, live
music, announcements, offers and hours. If that fetch fails, the baked-in
defaults stay on screen, so the site never shows an error or an empty page.

Design changes are made in the source project and recompiled. Day-to-day content
is edited through `/admin`, never here.
