# Deploying Ozone HRMS to Vercel (with a real shared database)

This version replaces the old `localdb.js` (which stored everything in your
browser only) with a real backend: Vercel serverless functions under `/api`
talking to a PostgreSQL database. Once deployed, every employee can log in
from their own phone or computer and see the same shared data.

## What you need first

1. A free [Vercel](https://vercel.com) account.
2. A Postgres database. Easiest options (all have free tiers):
   - **Vercel Postgres** (powered by Neon) — created right inside your Vercel project, no separate signup.
   - **Neon** (neon.tech) or **Supabase** (supabase.com) — separate free account, just need the connection string.

## Step 1 — Create the database

**Option A: Vercel Postgres (simplest, stays in one dashboard)**
1. Go to your Vercel dashboard → **Storage** tab → **Create Database** → **Postgres**.
2. Once created, open its **`.env.local`** / **Quickstart** tab and copy the connection string that starts with `postgres://...`.

**Option B: Neon or Supabase**
1. Create a free project on either site.
2. Copy the Postgres **connection string** they give you (it looks like `postgres://user:password@host/dbname?sslmode=require`).

Keep that connection string handy — you'll paste it into Vercel as `DATABASE_URL` in Step 3.

## Step 2 — Load the database schema

Run the SQL in `schema.sql` (included in this project) once, to create the tables.

- **Vercel Postgres**: Storage tab → your database → **Query** tab → paste the contents of `schema.sql` → Run.
- **Neon**: dashboard → **SQL Editor** → paste and run.
- **Supabase**: dashboard → **SQL Editor** → paste and run.
- Or from a terminal if you have `psql` installed:
  ```
  psql "YOUR_CONNECTION_STRING" -f schema.sql
  ```

## Step 3 — Deploy to Vercel

**Easiest path (no GitHub needed):**
1. Install Node.js if you don't already have it (nodejs.org).
2. Open a terminal in this project folder and run:
   ```
   npx vercel
   ```
3. Follow the prompts (log in, link/create a project, accept defaults). It will give you a live URL when done — that first deploy will show errors until you add the environment variables below, which is expected.

**Alternative path (recommended long-term — auto-redeploys on changes):**
1. Push this folder to a new GitHub repository.
2. On vercel.com → **Add New Project** → import that repository → Deploy.

## Step 4 — Add environment variables

In your Vercel project → **Settings → Environment Variables**, add:

| Name | Value |
|---|---|
| `DATABASE_URL` | the Postgres connection string from Step 1 |
| `JWT_SECRET` | any long random string (e.g. run `openssl rand -base64 32` or just mash the keyboard for 40+ characters) |
| `TZ` | `Asia/Kolkata` (so clock-in/out times match your team's local time) |

If you used **Vercel Postgres**, it may have auto-added variables like `POSTGRES_URL` — that's fine, just make sure `DATABASE_URL` is also set to the same connection string, since that's the name this app's code reads.

After adding variables, **redeploy** (Vercel → Deployments → ⋯ → Redeploy), since environment variables only apply to new deployments.

## Step 5 — First-time setup

1. Open your live Vercel URL (e.g. `https://your-project.vercel.app`).
2. Since the database is empty, the login page will show **"Create Admin Account"** — use it to create the first (admin) account. This becomes your HR/Admin login.
3. Sign in as that admin, go to the **Admin Dashboard**, and use **Create Account** to add each employee with their own email and password.
4. Share each employee's email + password with them directly. They can now open the same URL from their own device and sign in.

## Notes

- **Security**: passwords are hashed with bcrypt and never stored in plain text; login sessions use signed JWT tokens. Still, treat `JWT_SECRET` and your database credentials as secrets — don't commit them to a public repo (the `.env.example` file is a template only, not real values).
- **Costs**: Vercel's free (Hobby) plan and the free tiers of Vercel Postgres/Neon/Supabase are enough for a small team. Check current limits on their pricing pages if your team grows.
- **Custom domain**: once deployed, you can attach your own domain under Vercel → Settings → Domains, instead of the default `.vercel.app` URL.
- **Local testing**: copy `.env.example` to `.env`, fill in real values, and run `npx vercel dev` to test on your own machine before deploying.
