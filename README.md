# ✈️ Aviator — Telegram WebApp Real-Money Multiplayer Game

A production-ready crash game for Telegram with real-time multiplayer,
provably fair results, and real-money deposits/withdrawals.

---

## 📁 Project Structure

```
aviator/
├── backend/
│   ├── server.js          ← Node.js WebSocket + Express server
│   ├── package.json
│   └── .env.example       ← Copy to .env and fill in values
├── frontend/
│   └── index.html         ← Telegram WebApp UI (single file, deploy to CDN/static host)
└── database/
    └── schema.sql         ← PostgreSQL tables
```

---

## 🚀 Step-by-Step Setup

### 1. Create Your Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. `/newbot` → choose name and username
3. Copy your **BOT_TOKEN**
4. Run `/setmenubutton` → set URL to your webapp URL
5. Run `/setdomain` → whitelist your domain

### 2. Set Up PostgreSQL

```bash
# Install PostgreSQL (Ubuntu)
sudo apt install postgresql

# Create database
psql -U postgres
CREATE DATABASE aviator;
\c aviator
\i database/schema.sql
```

Or use a hosted DB: [Neon](https://neon.tech), [Supabase](https://supabase.com), [Railway](https://railway.app)

### 3. Deploy the Backend

```bash
cd backend
cp .env.example .env
# Edit .env with your values

npm install
npm start
```

**Recommended hosting:** Railway, Render, Fly.io, or a VPS.
The server needs to be publicly accessible via HTTPS (required by Telegram).

### 4. Deploy the Frontend

Edit `frontend/index.html`:
```javascript
const WS_URL = 'wss://YOUR_SERVER_URL/ws';  // ← your backend WebSocket URL
```

Deploy `frontend/index.html` to:
- [Vercel](https://vercel.com) (recommended, free)
- Cloudflare Pages
- Any static host

The URL must be **HTTPS**.

### 5. Register WebApp with BotFather

```
/newapp
→ Choose your bot
→ App title: Aviator
→ App description: Real-time crash game
→ Upload photo (any 640x360 image)
→ Web App URL: https://your-frontend-url.vercel.app
```

---

## 💰 Real Money Integration

### Option A: Telegram Stars (Recommended — built into Telegram)

1. In BotFather, enable payments for your bot
2. Use Telegram's built-in Stars API
3. Add to `server.js`:

```javascript
bot.on('pre_checkout_query', (query) => bot.answerPreCheckoutQuery(query.id, true));
bot.on('successful_payment', async (msg) => {
  const stars = msg.successful_payment.total_amount;
  const dollars = stars * 0.013; // ~1 Star = $0.013
  await creditUser(msg.from.id, Math.round(dollars * 100));
});
```

### Option B: Crypto (TON / USDT)

Use [@wallet](https://t.me/wallet) bot or [TON Connect](https://docs.ton.org/develop/dapps/ton-connect/overview):

1. Generate a unique deposit address per user
2. Listen for incoming transactions via TON API
3. Call your `/api/deposit` endpoint when payment confirmed

### Option C: Traditional Payment Gateway

Integrate Stripe, PayOp, or any processor that supports your region:
1. Player initiates deposit in app
2. Redirect to payment page
3. On success, payment provider POSTs to your `/api/deposit` with signed payload

---

## 🔐 Security Checklist

- [x] **Provably fair**: crash point uses server seed + client seed + nonce (HMAC-SHA256)
- [x] **Server-side validation**: all bet/cashout logic runs on server, never trust client
- [x] **Telegram auth**: every WebSocket message verified via `initData` signature
- [x] **Balance in DB**: stored in cents (integers), no floating point money
- [x] **Atomic DB operations**: balance deduction uses `WHERE balance >= amount` to prevent overdrafts
- [ ] **Rate limiting**: add `express-rate-limit` to API routes
- [ ] **DDoS protection**: put Cloudflare in front of your server
- [ ] **KYC/AML**: required in most jurisdictions for real-money gambling
- [ ] **SSL**: HTTPS required (use Let's Encrypt or Cloudflare)

---

## 🎮 How the Game Works

1. **Betting Phase** (7 seconds): Players place bets before each round
2. **Flying Phase**: Multiplier rises from 1.00x continuously
3. **Crash**: Server crashes at a pre-generated (provably fair) point
4. **Cashout**: Players must click "Cash Out" before the crash — or lose their bet
5. **Auto-cashout**: Optional — automatically cashes out at a target multiplier

### Provably Fair Formula

```javascript
function generateCrashPoint(serverSeed, clientSeed, nonce) {
  const hash = HMAC_SHA256(serverSeed, `${serverSeed}:${clientSeed}:${nonce}`);
  const h = parseInt(hash.slice(0,8), 16);
  const e = 2**32;
  if (h % 33 === 0) return 1.00;             // 3% house edge
  return Math.floor((100 * e - h) / (e - h)) / 100;
}
```

Server seed hash is **shown before each round** — revealed after crash so players can verify.

---

## ⚠️ Legal Notice

Real-money gambling is **heavily regulated**. Before launching:

1. Check gambling laws in your target jurisdiction
2. Obtain a gambling license (e.g., Curaçao, Malta MGA, UKGC)
3. Implement KYC (Know Your Customer) verification
4. Add responsible gambling features (deposit limits, self-exclusion)
5. Comply with AML (Anti-Money Laundering) requirements

**Do not operate without proper licensing.**

---

## 📊 Database Schema Overview

| Table          | Purpose                                    |
|----------------|--------------------------------------------|
| `users`        | Telegram users + balances (in cents)       |
| `rounds`       | Game rounds with provably fair seeds       |
| `bets`         | All bets with result + cashout multiplier  |
| `transactions` | Deposits and withdrawals                   |
| `daily_stats`  | Analytics aggregates                       |
