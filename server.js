/**
 * AVIATOR GAME - Backend Server
 * Real-time multiplayer crash game for Telegram WebApp
 * 
 * Stack: Node.js + Express + WebSocket (ws) + PostgreSQL
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());

// ─── Database ────────────────────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ─── Telegram Bot ─────────────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const user = msg.from;

  // Register user if not exists
  await db.query(`
    INSERT INTO users (telegram_id, username, first_name, balance)
    VALUES ($1, $2, $3, 0)
    ON CONFLICT (telegram_id) DO NOTHING
  `, [user.id, user.username || '', user.first_name || '']);

  bot.sendMessage(chatId, `🚀 Welcome to Aviator, ${user.first_name}!\n\nYour account is ready. Tap below to play:`, {
    reply_markup: {
      inline_keyboard: [[{
        text: '✈️ Play Aviator',
        web_app: { url: process.env.WEBAPP_URL }
      }]]
    }
  });
});

bot.onText(/\/balance/, async (msg) => {
  const user = await db.query('SELECT balance FROM users WHERE telegram_id = $1', [msg.from.id]);
  const bal = user.rows[0]?.balance ?? 0;
  bot.sendMessage(msg.chat.id, `💰 Your balance: $${(bal / 100).toFixed(2)}`);
});

bot.onText(/\/deposit (.+)/, async (msg, match) => {
  // In production: integrate Telegram Stars or payment provider
  bot.sendMessage(msg.chat.id, `💳 To deposit, use the in-app wallet inside the game.`, {
    reply_markup: {
      inline_keyboard: [[{ text: '💳 Open Wallet', web_app: { url: `${process.env.WEBAPP_URL}?tab=wallet` } }]]
    }
  });
});

// ─── Provably Fair Crash Point ────────────────────────────────────────────────
function generateCrashPoint(serverSeed, clientSeed, nonce) {
  const combined = `${serverSeed}:${clientSeed}:${nonce}`;
  const hash = crypto.createHmac('sha256', serverSeed).update(combined).digest('hex');
  const h = parseInt(hash.slice(0, 8), 16);
  const e = 2 ** 32;

  // House edge: 3%
  if (h % 33 === 0) return 1.00; // instant crash

  const crash = Math.floor((100 * e - h) / (e - h)) / 100;
  return Math.max(1.00, crash);
}

// ─── Game State Machine ───────────────────────────────────────────────────────
const PHASE = { WAITING: 'waiting', BETTING: 'betting', FLYING: 'flying', CRASHED: 'crashed' };

const gameState = {
  phase: PHASE.BETTING,
  roundId: null,
  multiplier: 1.0,
  crashPoint: null,
  serverSeed: null,
  serverSeedHash: null,
  startTime: null,
  bets: new Map(),      // userId -> { amount, cashedOut, cashoutMultiplier }
  history: [],
};

let clients = new Set(); // WebSocket clients

// Broadcast to all connected clients
function broadcast(data) {
  const msg = JSON.stringify(data);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

// ─── Game Loop ────────────────────────────────────────────────────────────────
let gameInterval = null;

async function startBettingPhase() {
  clearInterval(gameInterval);

  // Reveal previous seed, generate new one
  const serverSeed = crypto.randomBytes(32).toString('hex');
  const clientSeed = crypto.randomBytes(16).toString('hex');
  const nonce = Date.now();
  const crashPoint = generateCrashPoint(serverSeed, clientSeed, nonce);

  // Create round in DB
  const roundResult = await db.query(`
    INSERT INTO rounds (server_seed_hash, client_seed, nonce, crash_point, phase, started_at)
    VALUES ($1, $2, $3, $4, 'betting', NOW())
    RETURNING id
  `, [
    crypto.createHash('sha256').update(serverSeed).digest('hex'),
    clientSeed,
    nonce,
    crashPoint,
  ]);

  gameState.phase = PHASE.BETTING;
  gameState.roundId = roundResult.rows[0].id;
  gameState.serverSeed = serverSeed;
  gameState.serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
  gameState.crashPoint = crashPoint;
  gameState.multiplier = 1.0;
  gameState.bets.clear();
  gameState.startTime = null;

  broadcast({
    type: 'phase',
    phase: PHASE.BETTING,
    roundId: gameState.roundId,
    serverSeedHash: gameState.serverSeedHash,
    duration: 7000, // 7 second betting window
    history: gameState.history.slice(0, 20),
  });

  setTimeout(startFlyingPhase, 7000);
}

async function startFlyingPhase() {
  await db.query(`UPDATE rounds SET phase = 'flying' WHERE id = $1`, [gameState.roundId]);

  gameState.phase = PHASE.FLYING;
  gameState.startTime = Date.now();
  gameState.multiplier = 1.0;

  broadcast({ type: 'phase', phase: PHASE.FLYING, startTime: gameState.startTime });

  // Tick every 100ms
  gameInterval = setInterval(async () => {
    const elapsed = (Date.now() - gameState.startTime) / 1000;
    const m = parseFloat(Math.pow(Math.E, elapsed * 0.6).toFixed(2));

    gameState.multiplier = m;

    // Auto-cashout players who set a target
    const cashouts = [];
    for (const [userId, bet] of gameState.bets.entries()) {
      if (!bet.cashedOut && bet.autoCashout && m >= bet.autoCashout) {
        await processCashout(userId, m);
        cashouts.push({ userId, multiplier: m, amount: Math.floor(bet.amount * m) });
      }
    }

    broadcast({ type: 'tick', multiplier: m, cashouts });

    if (m >= gameState.crashPoint) {
      clearInterval(gameInterval);
      await crashRound();
    }
  }, 100);
}

async function crashRound() {
  const cp = gameState.crashPoint;
  gameState.phase = PHASE.CRASHED;
  gameState.multiplier = cp;

  // Settle all remaining (lost) bets
  const losers = [];
  for (const [userId, bet] of gameState.bets.entries()) {
    if (!bet.cashedOut) {
      await db.query(`
        UPDATE bets SET result = 'lost', settled_at = NOW()
        WHERE round_id = $1 AND user_id = $2
      `, [gameState.roundId, userId]);
      losers.push(userId);
    }
  }

  // Reveal server seed (provably fair)
  await db.query(`
    UPDATE rounds SET phase = 'crashed', server_seed = $1, ended_at = NOW()
    WHERE id = $2
  `, [gameState.serverSeed, gameState.roundId]);

  gameState.history.unshift(cp);
  if (gameState.history.length > 20) gameState.history.pop();

  broadcast({
    type: 'crashed',
    crashPoint: cp,
    serverSeed: gameState.serverSeed, // reveal for verification
    losers,
    history: gameState.history.slice(0, 20),
  });

  // Next round after 4 seconds
  setTimeout(startBettingPhase, 4000);
}

// ─── Bet Processing ───────────────────────────────────────────────────────────
async function placeBet(userId, amount, autoCashout = null) {
  if (gameState.phase !== PHASE.BETTING) return { error: 'Betting phase is over' };
  if (gameState.bets.has(userId)) return { error: 'Already placed a bet' };

  // Amount is in cents (integer)
  const amountCents = Math.round(amount * 100);
  if (amountCents < 10) return { error: 'Minimum bet is $0.10' };
  if (amountCents > 1000000) return { error: 'Maximum bet is $10,000' };

  // Deduct from balance
  const result = await db.query(`
    UPDATE users SET balance = balance - $1
    WHERE telegram_id = $2 AND balance >= $1
    RETURNING balance
  `, [amountCents, userId]);

  if (result.rowCount === 0) return { error: 'Insufficient balance' };

  await db.query(`
    INSERT INTO bets (round_id, user_id, amount, auto_cashout, placed_at)
    VALUES ($1, $2, $3, $4, NOW())
  `, [gameState.roundId, userId, amountCents, autoCashout]);

  gameState.bets.set(userId, {
    amount: amountCents,
    autoCashout,
    cashedOut: false,
    cashoutMultiplier: null,
  });

  broadcast({
    type: 'bet_placed',
    userId,
    amount: amountCents,
    totalBets: gameState.bets.size,
  });

  return { success: true, newBalance: result.rows[0].balance };
}

async function processCashout(userId, multiplier) {
  const bet = gameState.bets.get(userId);
  if (!bet || bet.cashedOut) return { error: 'Cannot cash out' };
  if (gameState.phase !== PHASE.FLYING) return { error: 'Not in flying phase' };

  const winnings = Math.floor(bet.amount * multiplier);

  bet.cashedOut = true;
  bet.cashoutMultiplier = multiplier;

  await db.query(`
    UPDATE users SET balance = balance + $1 WHERE telegram_id = $2
  `, [winnings, userId]);

  await db.query(`
    UPDATE bets SET result = 'won', cashout_multiplier = $1, winnings = $2, settled_at = NOW()
    WHERE round_id = $3 AND user_id = $4
  `, [multiplier, winnings, gameState.roundId, userId]);

  broadcast({
    type: 'cashout',
    userId,
    multiplier,
    winnings,
  });

  return { success: true, winnings };
}

// ─── WebSocket Server ─────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', async (ws, req) => {
  let userId = null;
  clients.add(ws);

  // Send current game state immediately on connect
  ws.send(JSON.stringify({
    type: 'init',
    phase: gameState.phase,
    multiplier: gameState.multiplier,
    roundId: gameState.roundId,
    serverSeedHash: gameState.serverSeedHash,
    history: gameState.history.slice(0, 20),
    startTime: gameState.startTime,
    connectedPlayers: clients.size,
  }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'auth': {
        // Verify Telegram WebApp initData
        const valid = verifyTelegramAuth(msg.initData);
        if (!valid) { ws.send(JSON.stringify({ type: 'error', message: 'Auth failed' })); return; }

        userId = valid.id;
        ws.userId = userId;

        // Get user data
        let user = await db.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
        if (user.rows.length === 0) {
          await db.query(`
            INSERT INTO users (telegram_id, username, first_name, balance)
            VALUES ($1, $2, $3, 1000)
          `, [userId, valid.username || '', valid.first_name || '']);
          user = await db.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
        }

        ws.send(JSON.stringify({
          type: 'auth_success',
          user: {
            id: userId,
            username: user.rows[0].username,
            firstName: user.rows[0].first_name,
            balance: user.rows[0].balance,
          }
        }));
        break;
      }

      case 'bet': {
        if (!userId) { ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' })); return; }
        const result = await placeBet(userId, msg.amount, msg.autoCashout || null);
        ws.send(JSON.stringify({ type: 'bet_result', ...result }));
        break;
      }

      case 'cashout': {
        if (!userId) return;
        const result = await processCashout(userId, gameState.multiplier);
        ws.send(JSON.stringify({ type: 'cashout_result', ...result }));
        break;
      }

      case 'get_history': {
        const rounds = await db.query(`
          SELECT id, crash_point, server_seed, client_seed, nonce, started_at
          FROM rounds WHERE phase = 'crashed'
          ORDER BY started_at DESC LIMIT 50
        `);
        ws.send(JSON.stringify({ type: 'history', rounds: rounds.rows }));
        break;
      }

      case 'get_my_bets': {
        if (!userId) return;
        const bets = await db.query(`
          SELECT b.*, r.crash_point FROM bets b
          JOIN rounds r ON r.id = b.round_id
          WHERE b.user_id = $1
          ORDER BY b.placed_at DESC LIMIT 20
        `, [userId]);
        ws.send(JSON.stringify({ type: 'my_bets', bets: bets.rows }));
        break;
      }
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcast({ type: 'players_count', count: clients.size });
  });
});

// ─── Telegram Auth Verification ───────────────────────────────────────────────
function verifyTelegramAuth(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData')
      .update(process.env.BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey)
      .update(dataCheckString).digest('hex');

    if (expectedHash !== hash) return null;

    const user = JSON.parse(params.get('user') || '{}');
    return user;
  } catch {
    return null;
  }
}

// ─── REST API ─────────────────────────────────────────────────────────────────
// Deposit webhook (from payment provider)
app.post('/api/deposit', async (req, res) => {
  const { telegramId, amount, transactionId, signature } = req.body;

  // Verify signature from your payment provider
  const expectedSig = crypto.createHmac('sha256', process.env.PAYMENT_SECRET)
    .update(`${telegramId}:${amount}:${transactionId}`).digest('hex');
  if (signature !== expectedSig) return res.status(401).json({ error: 'Invalid signature' });

  await db.query(`
    UPDATE users SET balance = balance + $1 WHERE telegram_id = $2
  `, [amount, telegramId]);

  await db.query(`
    INSERT INTO transactions (user_id, type, amount, reference, created_at)
    VALUES ($1, 'deposit', $2, $3, NOW())
  `, [telegramId, amount, transactionId]);

  res.json({ success: true });
});

// Withdraw request
app.post('/api/withdraw', async (req, res) => {
  const { initData, amount, method, details } = req.body;
  const user = verifyTelegramAuth(initData);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const amountCents = Math.round(amount * 100);
  if (amountCents < 500) return res.status(400).json({ error: 'Minimum withdrawal is $5' });

  const result = await db.query(`
    UPDATE users SET balance = balance - $1
    WHERE telegram_id = $2 AND balance >= $1
    RETURNING balance
  `, [amountCents, user.id]);

  if (result.rowCount === 0) return res.status(400).json({ error: 'Insufficient balance' });

  await db.query(`
    INSERT INTO transactions (user_id, type, amount, method, details, status, created_at)
    VALUES ($1, 'withdrawal', $2, $3, $4, 'pending', NOW())
  `, [user.id, amountCents, method, JSON.stringify(details)]);

  // TODO: trigger your payout processor here

  res.json({ success: true, newBalance: result.rows[0].balance });
});

// Leaderboard
app.get('/api/leaderboard', async (req, res) => {
  const rows = await db.query(`
    SELECT u.username, u.first_name,
           COUNT(b.id) as total_bets,
           SUM(CASE WHEN b.result = 'won' THEN b.winnings - b.amount ELSE -b.amount END) as total_profit
    FROM users u
    JOIN bets b ON b.user_id = u.telegram_id
    GROUP BY u.telegram_id, u.username, u.first_name
    ORDER BY total_profit DESC
    LIMIT 20
  `);
  res.json(rows.rows);
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, async () => {
  console.log(`🚀 Aviator server running on port ${PORT}`);
  await startBettingPhase();
});
