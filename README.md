# ROTEX website

Standalone website for the ROTEX AI family.

Current web features:

- Sidebar chat list
- Local saved chats
- Firebase Google login and Firestore chat sync when configured
- ROTEX model drop-up beside the chat bar
- Single-screen chatbot layout
- Vercel ROTEX backend at `/api/chat`
- Free user credits: `$0.300` every 3 days

Model costs:

| Model | Backend | Cost |
| --- | --- | ---: |
| Rod _ 1 | Groq `llama-3.1-8b-instant` | `$0.001/message` |
| Rod thinking | Groq `llama-3.3-70b-versatile` | `$0.004/message` |
| Tex 0 | DeepSeek `deepseek-chat` | `$0.007/message` |
| Tex 1.5 | DeepSeek `deepseek-chat` | `$0.015/message` |
| Treesearch _ q | Groq `llama-3.3-70b-versatile` | `$0.002/message` |

Computer mode is available to everyone, but it has separate pricing:

| Computer mode model | Cost |
| --- | ---: |
| Rod thinking (ICM) | `$0.010/message` |
| Tex 0 (ICM) | `$0.040/message` |
| Tex 1.5 (ICM) | `$0.070/message` |

Computer mode asks the user to connect Google Drive, GitHub, Connect PC, or all of them before external-work actions. Direct PC file access requires a paired trusted PC helper; the website alone cannot read or edit local PC files.

Free users can use computer mode a few times per day. Pro removes that heavier-use cap once payment/webhook activation is connected.

When a user is out of credits, the app shows `your out of credits, upgrade?` with an Upgrade button.

Upgrade benefits:

- `$3` in credits
- Better models (coming soon)
- Computer mode (coming soon)
- More plugins
- Tex 2.5 (coming soon)

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
GROQ_API_KEY
DEEPSEEK_API_KEY
```

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

Connect PC uses the in-app 3 digit pairing UI. Real phone-to-PC file access still needs a desktop helper app/server to run on the PC and approve file operations.

## Stripe checkout

Create a Stripe product/price for the upgrade, then add:

```text
STRIPE_SECRET_KEY
STRIPE_PRICE_ID
```

The checkout endpoint is `/api/create-checkout-session` and uses subscription mode. The purchase metadata includes the user id, `$3` credits, and the coming-soon benefits. A Stripe webhook is still needed before purchases can automatically add credits to Firestore.

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

That backend uses the Stripe test secret key to create a Checkout Session for the $15 monthly Pro plan, then returns the checkout URL to the website.

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
