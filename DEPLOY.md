# Deploying dbmjr.com on Railway

This app runs on Railway as a Node/Express service. The domain `dbmjr.com` hosts two things:
- `dbmjr.com/` → eBay drafts app (login required)
- `dbmjr.com/lazz/` → The Lazz tournament bracket (public)

---

## First-time deploy

### 1. Push the repo to GitHub
Make sure `main` is pushed with the latest code, including `public/lazz/` and `railway.json`.

### 2. Create the Railway project
1. Railway dashboard → **New Project** → **Deploy from GitHub repo** → pick `murrayclod-max/eBay-drafts`.
2. Railway auto-detects Node via Nixpacks and runs `npm start` (confirmed by `railway.json`).
3. First build takes ~2 minutes. Railway gives you a URL like `dbmjr-production.up.railway.app`.

### 3. Set environment variables
In Railway → your service → **Variables** tab, add every key from your local `.env`:

- `APP_PASSWORD` — password for the eBay app login
- `SESSION_SECRET` — long random string
- `ANTHROPIC_API_KEY` — from console.anthropic.com
- `APP_URL` — **start with the Railway URL**, switch to `https://dbmjr.com` after step 5
- `EBAY_REDIRECT_URI` — `{APP_URL}/ebay/callback`
- `EBAY_ENV` — `production` or `sandbox`
- `EBAY_CLIENT_ID` — from developer.ebay.com
- `EBAY_CLIENT_SECRET` — from developer.ebay.com
- `PORT` — leave unset; Railway sets this automatically

Railway auto-redeploys when you save variables.

### 4. Verify the Railway URL works
Visit `https://{your-project}.up.railway.app/lazz/` — you should see the bracket (no login required).
Visit `https://{your-project}.up.railway.app/` — you should see the eBay app login.

### 5. Attach dbmjr.com as the custom domain
1. Railway → service → **Settings → Networking → Custom Domain** → add `dbmjr.com` (and optionally `www.dbmjr.com`).
2. Railway shows you a CNAME target like `abc123.up.railway.app`.
3. At your domain registrar (where you bought `dbmjr.com`):
   - For apex `dbmjr.com`: use an **ALIAS/ANAME record** pointing at the Railway target (most registrars support this; if yours doesn't, use `www.dbmjr.com` as the canonical and redirect apex → www).
   - For `www`: add a **CNAME** record pointing at the Railway target.
4. DNS propagation: 5–30 min typical. Railway auto-issues the TLS cert once DNS is live.

### 6. Switch `APP_URL` to production
Back in Railway → Variables:
- `APP_URL` → `https://dbmjr.com`
- `EBAY_REDIRECT_URI` → `https://dbmjr.com/ebay/callback`

### 7. Update eBay developer console
eBay requires the redirect URI in the OAuth app config to match exactly.
- Go to developer.ebay.com → your app → **User Tokens / Redirect URI**.
- Update the redirect URI to `https://dbmjr.com/ebay/callback`.

### 8. Connect the Google Sheet for /lazz/
Edit `public/lazz/index.html` — find the line:
```js
const SHEET_CSV_URL = "";
```
Paste the published-CSV URL from the Google Sheet (see `public/lazz/SETUP.md` step 4).
Commit + push → Railway auto-redeploys.

---

## Ongoing deploys

Railway watches the `main` branch. Every push = a new deploy.

## Rolling back
Railway dashboard → **Deployments** tab → click any prior deployment → **Redeploy**.

## Checking logs
Railway dashboard → service → **Deployments** → **View Logs**.
