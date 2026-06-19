# ROTEX website

Standalone website for the ROTEX AI family.

Current web features:

- Sidebar chat list
- Local saved chats
- Firebase Google login and Firestore chat sync when configured
- ROTEX model drop-up beside the chat bar
- Single-screen chatbot layout
- Vercel ROTEX backend at `/api/chat`
- Normal user credits: `$0.300` daily, `$0.900` weekly, `$1.500` monthly
- Plus user credits: `$2.500` daily, `$5.000` monthly

Model catalog:

- `api/_lib/catalog.js` is the single source of truth for chat routing, public model names, tiers, and per-message credit costs.
- `/api/models` returns the public catalog for clients.
- Claude routes through your Anthropic/Claude key first, then OpenRouter as backup.
- GBT, Grok, Groq, Gemini, and DeepSeek route through OpenRouter.
- The public model lineup is Claude, GBT, Grok, Groq, Ollama, Gemini, and DeepSeek.
- Ollama is local-only and talks to the user's PC at `http://127.0.0.1:11434`.

Computer mode is available to everyone, but it has separate pricing:

| Computer mode model | Cost |
| --- | ---: |
| Regular chat | Uses each catalog model's `cost` |
| Computer mode | Uses each catalog model's `computerCost` |

Computer mode asks the user to connect Google Drive or GitHub before external-work actions. Direct PC file access requires the separate PC helper app; the website computer-mode picker does not offer PC pairing.

Free users can use computer mode a few times per day. Plus removes that heavier-use cap once payment/webhook activation is connected.

When a user hits a daily, weekly, or monthly credit limit, the app shows `your out of credits, upgrade?` with an Upgrade button.

Upgrade benefits:

- `$5` in credits
- Better models
- Computer mode
- More plugins

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
ANTHROPIC_API_KEY   (or CLAUDE_API_KEY)
PRO_PASS_SECRET     (random 32+ char secret; signs the Plus pass)
```

Optional: `CLAUDE_SONNET_MODEL`, `PUBLIC_SITE_URL`.

## Plus enforcement (no database needed)

- `/api/verify-checkout-session` checks Stripe and returns a signed **Pro pass** (HMAC, 35-day expiry).
- The web app and editor store it in `localStorage` under `rotex_pro_pass` and send it with every `/api/chat` call.
- `/api/chat` rejects Plus models without a valid pass (HTTP 402) and gives Plus users bigger output limits.
- `/api/refresh-pro` re-checks the Stripe subscription and reissues the pass; cancelled subs stop refreshing and expire automatically.

## Editor AI

- `/api/chat` streams responses (`stream: true`, SSE) and accepts `mode: 'editor'`, `agent: true`, and `projectContext`.
- Agent mode (Plus) lets the AI propose multi-file changes as ```file:path blocks with per-file Diff/Apply and Apply All.
- Ctrl+K = inline AI edit on the selection in Monaco.
- `Ollama` talks to `http://127.0.0.1:11434` directly from the browser/editor (free/local; browser use needs `OLLAMA_ORIGINS` set).

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

## Stripe checkout

Create a Stripe product/price for the upgrade, then add:

```text
STRIPE_SECRET_KEY
STRIPE_PRICE_ID
```

The checkout endpoint is `/api/create-checkout-session` and uses subscription mode. The purchase metadata includes the user id, `$5` credits, and the Plus benefits. A Stripe webhook is still needed before purchases can automatically add credits to Firestore.

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

That backend uses the Stripe secret key to create a Checkout Session for the $15 monthly Plus plan, then returns the checkout URL to the website.

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
