# ROTEX website

Dashboard website for ROTEX Desktop.

Current web features:

- Homepage for the ROTEX desktop app download
- Firebase login before Pro or TexToken purchases
- Account dashboard for plan status, Pro checkout, and TexToken credits
- Extra TexTokens through Stripe Checkout at `$1 = 1M TexTokens`
- Pro user TexTokens: `1M` daily soft limit, `20M` monthly
- Desktop app/editor served from `editor.html`

Model catalog:

- `api/_lib/catalog.js` is the single source of truth for chat routing, public model names, tiers, and per-message credit costs.
- `/api/models` returns the public catalog for clients.
- In the desktop app, TexBrain Thinking-beta runs on-device via Ollama (free, local). It auto-detects the best installed model and uses a Roblox/Luau-focused system prompt.
- In the browser, TexBrain Thinking-beta falls back to the cloud OpenRouter model.
- Claude Haiku is cloud-only and uses Anthropic first. If Anthropic runs out of credits, ROTEX emails you and switches that request to OpenRouter.
- If OpenRouter also runs out, users see `AI is busy right now. Please retry in a few seconds.`
- Claude Haiku 4.5 is available to everyone through the Claude Haiku model.

Model access:

- Free: TexBrain Thinking-beta and Claude Haiku.
- Pro: more TexToken budget for all models, Agent mode, Super Agent mode, 5 connected projects, better memory, priority speed, more file edits, more computer mode, Pro badge, and early access features.

TexToken rates:

- `$1 = 1M TexTokens`
- TexBrain Thinking-beta (cloud/browser only): input `0.2x`, output `0.6x`
- TexBrain Thinking-beta in the desktop app is free via Ollama and does not consume TexTokens.
- Claude Haiku: input `3.2x`, output `16x`

## Firebase Auth

Create a Firebase web app, enable Google Auth, create a Firestore database, and add these domains in Firebase Authentication authorized domains:

```text
rrotex.com
www.rrotex.com
rrotex.vercel.app
```

Add the values from `firebase-env.example` to Vercel Project Settings -> Environment Variables, then redeploy.

## AI backend keys

Add these to Vercel Project Settings -> Environment Variables:

```text
OPENROUTER_API_KEY
GROQ_API_KEY
ANTHROPIC_API_KEY   (or CLAUDE_API_KEY)
OPENROUTER_API_KEY  (fallback for Anthropic only)
PRO_PASS_SECRET     (random 32+ char secret; signs the Pro pass)
PROVIDER_CREDIT_BALANCE
```

Optional: `CLAUDE_HAIKU_MODEL`, `PUBLIC_SITE_URL`.

`PROVIDER_CREDIT_BALANCE` is the admin setting for Provider Credit Balance. If it is under `$10`, expensive models are blocked. If it is under `$5`, all AI requests are blocked. Low-credit and insufficient-credit provider errors send an email alert to `rayf24241@gmail.com` at most once every 6 hours.

## Pro enforcement (no database needed)

- `/api/verify-checkout-session` checks Stripe and returns a signed **Pro pass** (HMAC, 35-day expiry).
- The web app and editor store it in `localStorage` under `rotex_pro_pass` and send it with every `/api/chat` call.
- `/api/chat` rejects Pro models without a valid pass (HTTP 402) and gives Pro users bigger output limits.
- `/api/refresh-pro` re-checks the Stripe subscription and reissues the pass; cancelled subs stop refreshing and expire automatically.

## Editor AI

- `/api/chat` streams responses (`stream: true`, SSE) and accepts `mode: 'editor'`, `agent: true`, and `projectContext`.
- Agent mode (Pro) lets the AI propose multi-file changes as ```file:path blocks with per-file Diff/Apply and Apply All.
- Ctrl+K = inline AI edit on the selection in Monaco.

## Computer mode connectors

The UI starts real OAuth redirects when these are configured:

```text
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
```

Callback URLs:

```text
https://www.rrotex.com/api/connect/github-callback
https://www.rrotex.com/api/connect/google-drive-callback
```

The PC helper source lives in `pc_app/rotex_pc_app.py`. The downloadable Windows build is served from `downloads/ROTEX-PC-App.exe`.

The PC helper now opens directly into a clean ROTEX Desktop workspace. First launch asks what the user is working on, lets them pick up to two of Roblox, Blender, and Unity, asks for a project name, then lets them choose a local project folder and chat with file context.

Desktop app builds:

- Windows, macOS, and Linux Electron builds are configured in `electron/package.json`.
- The GitHub Actions workflow `.github/workflows/desktop-build.yml` builds all three platforms and uploads artifacts.
- macOS/Linux download links point at `downloads/desktop/ROTEX-Desktop-mac.dmg` and `downloads/desktop/ROTEX-Desktop-linux.AppImage`; copy the built artifacts there when publishing a release.

## Stripe checkout

Create a Stripe product/price for the upgrade, then add:

```text
STRIPE_SECRET_KEY
STRIPE_PRICE_ID
```

The Pro checkout endpoint is `/api/create-checkout-session` and uses subscription mode.

The extra TexToken checkout flow uses `/api/create-checkout-session` with `kind: "credits"` and one-time payment mode. The website lets a signed-in user choose any whole dollar amount from `$1` to `$500`; each `$1` buys `1M` TexTokens. After Stripe redirects back, `/api/verify-checkout-session` verifies the paid session before the dashboard adds the credits.

For production-grade cloud balances, connect a Stripe webhook to Firebase Admin and store credited session ids server-side so the same Stripe session cannot be applied twice from another device.

## Local preview

Open `index.html` in a browser, or run a tiny static server:

```powershell
python -m http.server 5173
```

Then visit `http://localhost:5173`.

## Stripe test mode plan

Do not put Stripe secret keys in this website. The website should call a backend endpoint like:

```text
POST /api/create-checkout-session
```

That backend uses the Stripe secret key to create a Checkout Session for the $20 monthly Pro plan, then returns the checkout URL to the website.

## ROTEX backend plan

The website can talk to the ROTEX backend through a public backend URL later. For local testing, use:

```text
http://localhost:3001
```

For a deployed site, `localhost` only points to the visitor's device, so the backend needs to be deployed too.

## GoDaddy DNS helper

Copy `.env.example` to `.env`, then put your Production GoDaddy API key and secret in `.env`.

Run:

```powershell
.\godaddy-dns.ps1
```

The script sets:

```text
A      @      76.76.21.21
CNAME  www    cname.vercel-dns.com
```

Do not commit `.env`.
