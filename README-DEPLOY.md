# REPLY ALL — Deploy Guide

This package is pre-built and ready to deploy to Railway (recommended).

## What's in here

```
reply-all/
├── index.js          ← server entry point
├── game.js           ← game state machine
├── content.js        ← premises & constraints (edit these to customize!)
├── package.json      ← server dependencies
├── package-lock.json
└── client/
    └── dist/         ← pre-built React frontend (no build step needed)
```

The server automatically serves the React app AND handles WebSocket connections —
one deploy, one URL, everything works.

---

## Deploy to Railway (free, easiest)

1. Go to https://railway.app and sign up (free)
2. Click **New Project → Deploy from GitHub repo**
   - You'll need to push this folder to a GitHub repo first (or use Railway's CLI)
3. Railway auto-detects Node.js. Set:
   - **Root directory**: `/` (the folder with index.js)
   - **Start command**: `npm start`
4. Railway gives you a URL like `https://reply-all-production.up.railway.app`
5. That's it. Open the URL — it works.

### Pushing to GitHub first (if needed)

```bash
cd reply-all        # this folder
git init
git add .
git commit -m "initial deploy"
# Create a repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/reply-all.git
git push -u origin main
```

---

## Deploy to Render (also free)

1. Go to https://render.com → New → Web Service
2. Connect your GitHub repo
3. Settings:
   - **Root directory**: leave blank (or `/`)
   - **Build command**: `npm install`
   - **Start command**: `npm start`
4. Free tier spins down after 15 min of inactivity (first load is slow).
   Paid tier ($7/mo) keeps it always on.

---

## Deploy to Fly.io (free tier available)

```bash
npm install -g flyctl
fly auth login
cd reply-all
fly launch   # follow the prompts, pick a region
fly deploy
```

---

## After deploying

- Host screen: `https://YOUR-APP-URL/host`
- Players join: `https://YOUR-APP-URL/play`
- Share your URL with friends and you're playing

---

## Customizing content

Edit `content.js` to add your own premises and constraints.
Redeploy after changes (Railway/Render auto-deploys on git push).

