# Gulece

A private, women-only space for Muslim women to share and connect.

## One-time setup: Supabase

Data (accounts, sessions) and files (verification videos, ID documents) live
in [Supabase](https://supabase.com) — a hosted Postgres database + file
storage, free to start, no Docker or local database install required.

1. Create a free project at [supabase.com](https://supabase.com).
2. In your project, go to **SQL Editor → New query**, paste in the entire
   contents of [`supabase-schema.sql`](supabase-schema.sql), and run it. This
   creates the tables and two private storage buckets.
3. Go to **Project Settings → Data API** and copy the **Project URL**.
4. Go to **Project Settings → API Keys** and copy the **`service_role`**
   secret key (not the `anon` key — the server needs elevated access to
   review signups; this key must never reach the browser).
5. Copy `.env.example` to `.env` and fill in:
   ```
   SUPABASE_URL=...
   SUPABASE_SERVICE_ROLE_KEY=...
   ADMIN_PASSWORD=pick-a-real-password
   ```

## Running locally

```
npm install
npm start
```

Then open `http://localhost:3000`. Camera access (needed for face
verification) only works over `https://` or `http://localhost` — do not open
the HTML files directly (`file://...`), the browser will silently refuse
camera access.

## How verification works

There is no fake AI and no automatic timer. When someone signs up:

1. They record a short face video (and can optionally upload a legal ID) —
   both are uploaded straight to private Supabase Storage buckets.
2. Their account is created with `status: "pending"` — they **cannot** log
   in yet.
3. You (the admin) open `http://localhost:3000/admin.html`, sign in with
   `ADMIN_PASSWORD`, watch the video, and click Approve or Reject.
4. Only after you approve can that person actually sign in.

## Deploying on Render

This repo includes `render.yaml`, so Render can configure itself:

1. Go to [dashboard.render.com](https://dashboard.render.com) → **New → Blueprint**.
2. Connect your GitHub account (if not already) and select the `Gulece` repo.
3. Render reads `render.yaml` and proposes a "gulece" web service on the free
   plan. Click through to create it.
4. It will pause and ask you to fill in three environment variables (kept
   secret, not stored in the repo): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `ADMIN_PASSWORD` — same values as your local `.env`.
5. Deploy. Render will run `npm install` then `npm start`, and pings
   `/healthz` to confirm the app can reach Supabase before marking it live.
6. Your app is now at `https://gulece-xxxx.onrender.com` (or a custom domain
   you attach in Render's settings). Admin review is at `/admin.html` on that
   same URL.

The app server itself is stateless (all data/files live in Supabase), so it
can be scaled to multiple Render instances later with no extra setup.
