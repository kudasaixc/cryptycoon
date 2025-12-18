const express = require('express');
const http = require('http');
const cors = require('cors');
const axios = require('axios');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 4000;
const TICK_MS = 3000;
const PRICE_PRECISION = 4;
const BALANCE_PRECISION = 2;

const app = express();
app.use(cors());
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
  },
});

const assets = [
  'BTC',
  'ETH',
  'ICP',
  'XCN',
  'USDT',
  'DASH',
  'NEAR',
  'SOL',
  'USD',
  'EUR',
  'JPY',
  'CNY',
  'TRY',
];

const coingeckoIds = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  ICP: 'internet-computer',
  XCN: 'chain-2',
  USDT: 'tether',
  DASH: 'dash',
  NEAR: 'near',
  SOL: 'solana',
};

const fiatFallback = {
  USD: 1,
  EUR: 0.92,
  JPY: 156,
  CNY: 7.2,
  TRY: 32,
};

const initialSeedPrices = {
  BTC: 67000,
  ETH: 3100,
  ICP: 12,
  XCN: 0.0009,
  USDT: 1,
  DASH: 32,
  NEAR: 5,
  SOL: 145,
  USD: 1,
  EUR: fiatFallback.EUR,
  JPY: fiatFallback.JPY,
  CNY: fiatFallback.CNY,
  TRY: fiatFallback.TRY,
};

const sessions = new Map();
let realWorldSnapshot = { ...initialSeedPrices };

const botNames = [
  'AlphaWhale',
  'QuantumBear',
  'DeFiDegen',
  'Layer2Larry',
  'SatoshiSidekick',
  'IcyTrader',
  'ChartChomper',
  'CandleQueen',
  'BreakoutBob',
  'LimitLynx',
  'MakerMarauder',
  'HedgeHawk',
  'ApexAlgo',
  'DeltaDiva',
  'GammaGuru',
  'VegaViper',
  'Fisherman',
  'OrderFlowOwl',
  'FlashFill',
  'BidBison',
];

function roundPrice(value) {
  return Number(value.toFixed(PRICE_PRECISION));
}

function roundBalance(value) {
  return Number(value.toFixed(BALANCE_PRECISION));
}

let lastRealWorldErrorTs = 0;

async function refreshRealWorldSnapshot() {
  try {
    const ids = Object.values(coingeckoIds).join(',');
    const response = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`
    );
    const prices = { ...initialSeedPrices };
    Object.entries(coingeckoIds).forEach(([symbol, id]) => {
      const usdPrice = response.data?.[id]?.usd;
      if (usdPrice) {
        prices[symbol] = usdPrice;
      }
    });
    realWorldSnapshot = { ...prices };
  } catch (error) {
    const now = Date.now();
    // log at most once per minute to avoid noisy consoles
    if (now - lastRealWorldErrorTs > 60_000) {
      console.warn('Failed to refresh real-world prices, falling back to simulated snapshot');
      lastRealWorldErrorTs = now;
    }
    // Try a lightweight Binance fallback for majors to stay close to reality
    try {
      const majors = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
      const responses = await Promise.all(
        majors.map((symbol) =>
          axios
            .get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`)
            .then((r) => Number(r.data?.price))
            .catch(() => null)
        )
      );
      const prices = { ...realWorldSnapshot };
      majors.forEach((symbol, idx) => {
        const asset = symbol.replace('USDT', '');
        if (responses[idx]) {
          prices[asset] = responses[idx];
        }
      });
      realWorldSnapshot = prices;
    } catch (_) {
      // keep the previous snapshot; nothing else to do
      realWorldSnapshot = { ...realWorldSnapshot, ...initialSeedPrices };
    }
  }
}

function generateInitialCandles(price) {
  const now = Date.now();
  return Array.from({ length: 30 }).map((_, i) => {
    const base = price * (1 + (Math.sin(i) * 0.01));
    return {
      time: now - (30 - i) * TICK_MS,
      open: roundPrice(base * 0.997),
      high: roundPrice(base * 1.01),
      low: roundPrice(base * 0.99),
      close: roundPrice(base * 1.003),
    };
  });
}

function createSession(socketId, payload) {
  const { playerName, difficulty, mode } = payload;
  const startingBalance = mode === 'Admin' ? 10000 : mode === 'Whale' ? 25000 : 1000;
  const session = {
    id: socketId,
    playerName,
    difficulty,
    mode,
    holdings: { USD: startingBalance },
    positions: [],
    realizedPnl: 0,
    unrealizedPnl: 0,
    bots: createBots(startingBalance),
    startedAt: Date.now(),
    faucetClaimed: false,
    selectedAsset: 'BTC',
    market: buildInitialMarket(difficulty),
  };
  sessions.set(socketId, session);
  return session;
}

function buildInitialMarket(difficulty) {
  const basePrices = difficulty === 'Real-World' ? realWorldSnapshot : initialSeedPrices;
  const prices = { ...basePrices };
  const candles = {};
  assets.forEach((asset) => {
    candles[asset] = generateInitialCandles(prices[asset]);
  });
  const book = buildOrderBook(prices);
  return { prices, candles, orderBook: book };
}

function createBots(startingBalance) {
  return botNames.map((name) => ({
    id: uuidv4(),
    name,
    balance: startingBalance,
    realizedPnl: 0,
    unrealizedPnl: 0,
    positions: [],
  }));
}

function buildOrderBook(prices) {
  const book = {};
  Object.entries(prices).forEach(([symbol, price]) => {
    if (!price) return;
    const bids = [];
    const asks = [];
    for (let i = 0; i < 8; i += 1) {
      const spread = (i + 1) * 0.0015;
      bids.push({ price: roundPrice(price * (1 - spread)), size: roundPrice(Math.random() * 2) });
      asks.push({ price: roundPrice(price * (1 + spread)), size: roundPrice(Math.random() * 2) });
    }
    book[symbol] = { bids, asks };
  });
  return book;
}

function applyDifficultyDrift(price, difficulty, bias = 0) {
  const roll = Math.random();
  if (difficulty === 'Easy') {
    const step = (Math.random() * 0.004 + 0.001 + bias) * price;
    return price + step;
  }
  if (difficulty === 'Medium') {
    const direction = roll > 0.55 ? 1 : -1;
    const magnitude = (Math.random() * 0.006 + 0.002 + Math.abs(bias)) * price;
    return price + direction * magnitude;
  }
  if (difficulty === 'Hard') {
    const direction = roll > 0.35 ? -1 : 1; // bias to hurt the player
    const magnitude = (Math.random() * 0.008 + 0.003 + Math.abs(bias)) * price;
    return price + direction * magnitude;
  }
  return price;
}

function updateCandles(candles, symbol, newPrice) {
  const candleList = candles[symbol] || [];
  const now = Date.now();
  const last = candleList[candleList.length - 1];
  if (!last || now - last.time > TICK_MS * 2) {
    candleList.push({
      time: now,
      open: newPrice,
      high: newPrice,
      low: newPrice,
      close: newPrice,
    });
  } else {
    last.close = newPrice;
    last.high = Math.max(last.high, newPrice);
    last.low = Math.min(last.low, newPrice);
  }
  if (candleList.length > 120) candleList.shift();
  candles[symbol] = candleList;
}

function markToMarket(session) {
  let unrealized = 0;
  session.positions.forEach((pos) => {
    const { symbol, quantity, entryPrice, leverage, side } = pos;
    const px = session.market.prices[symbol] || entryPrice;
    const pnl = side === 'long' ? (px - entryPrice) * quantity : (entryPrice - px) * quantity;
    const leveraged = pnl * leverage;
    unrealized += leveraged;
    const liquidationPrice = side === 'long'
      ? entryPrice * (1 - 1 / leverage)
      : entryPrice * (1 + 1 / leverage);
    if ((side === 'long' && px <= liquidationPrice) || (side === 'short' && px >= liquidationPrice)) {
      session.realizedPnl -= pos.margin;
      pos.margin = 0;
      pos.quantity = 0;
      pos.liquidated = true;
    }
  });
  session.unrealizedPnl = roundBalance(unrealized);
  session.positions = session.positions.filter((p) => p.quantity > 0 && !p.liquidated);
}

function convertCurrency(amount, from, to, prices) {
  if (from === to) return amount;
  const fromUsd = amount * (prices[from] || initialSeedPrices[from] || 1);
  const toUsd = prices[to] || initialSeedPrices[to] || 1;
  return fromUsd / toUsd;
}

function handleOrder(session, order) {
  const { base, quote, side, size, leverage = 1 } = order;
  const prices = session.market.prices;
  const baseUsd = prices[base];
  const quoteUsd = prices[quote];
  if (!baseUsd || !quoteUsd) {
    return { error: 'Pair not supported' };
  }
  const pairPrice = baseUsd / quoteUsd;
  const costInQuote = size * pairPrice;
  let availableQuote = session.holdings[quote] || 0;
  let convertedFromUsd = 0;

  if (availableQuote < costInQuote) {
    const missing = costInQuote - availableQuote;
    if (quote !== 'USD' && (session.holdings.USD || 0) > 0) {
      const neededUsd = missing * quoteUsd;
      if (session.holdings.USD >= neededUsd) {
        session.holdings.USD = roundBalance(session.holdings.USD - neededUsd);
        availableQuote += missing;
        convertedFromUsd = neededUsd;
      }
    }
  }

  if (availableQuote < costInQuote && leverage === 1) {
    return { error: 'Insufficient balance for spot trade' };
  }

  const margin = leverage > 1 ? costInQuote / leverage : costInQuote;
  if (leverage > 1 && availableQuote < margin) {
    return { error: 'Insufficient margin for leveraged trade' };
  }

  if (availableQuote >= margin) {
    const deduction = leverage > 1 ? margin : costInQuote;
    session.holdings[quote] = roundBalance(availableQuote - deduction);
  }

  const positionSide = side === 'buy' ? 'long' : 'short';
  const existing = session.positions.find((p) => p.symbol === base && p.side === positionSide);
  if (existing) {
    const totalQty = existing.quantity + size;
    existing.entryPrice = roundPrice((existing.entryPrice * existing.quantity + pairPrice * size) / totalQty);
    existing.quantity = totalQty;
    existing.leverage = Math.max(existing.leverage, leverage);
    existing.margin += margin;
  } else {
    session.positions.push({
      symbol: base,
      side: positionSide,
      entryPrice: roundPrice(pairPrice),
      quantity: size,
      leverage,
      margin,
    });
  }
  return { convertedFromUsd, pairPrice: roundPrice(pairPrice) };
}

function updateBots(session) {
  session.bots.forEach((bot) => {
    const symbol = assets[Math.floor(Math.random() * 5)];
    const price = session.market.prices[symbol];
    if (!price) return;
    const direction = Math.random() > 0.5 ? 1 : -1;
    const size = Math.random() * 0.05 * (1000 / price);
    const leverage = Math.random() > 0.8 ? 5 : 2;
    const entry = price;
    const pnl = direction === 1 ? (price - entry) * size : (entry - price) * size;
    bot.unrealizedPnl = roundBalance(pnl * leverage);
    const delta = Math.random() * 20 - 10;
    bot.realizedPnl = roundBalance(bot.realizedPnl + delta);
    bot.balance = roundBalance(bot.balance + delta);
  });
}

function emitSession(socket, session) {
  markToMarket(session);
  socket.emit('session_update', sanitizeSession(session));
}

function sanitizeSession(session) {
  return {
    playerName: session.playerName,
    difficulty: session.difficulty,
    mode: session.mode,
    holdings: session.holdings,
    positions: session.positions,
    realizedPnl: session.realizedPnl,
    unrealizedPnl: session.unrealizedPnl,
    market: session.market,
    bots: session.bots,
    startedAt: session.startedAt,
    faucetClaimed: session.faucetClaimed,
  };
}

async function tick() {
  await refreshRealWorldSnapshot();
  sessions.forEach((session, socketId) => {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) return;
    const { difficulty } = session;
    const prices = { ...session.market.prices };
    assets.forEach((asset) => {
      if (!prices[asset]) return;
      const current = prices[asset];
      let nextPrice = current;
      if (difficulty === 'Real-World' && realWorldSnapshot[asset]) {
        nextPrice = realWorldSnapshot[asset];
      } else {
        const bias = session.positions.some((p) => p.symbol === asset)
          ? session.positions.reduce((acc, p) => (p.symbol === asset ? acc + (p.side === 'long' ? -0.002 : 0.002) : acc), 0)
          : 0;
        nextPrice = applyDifficultyDrift(current, difficulty, bias);
      }
      nextPrice = Math.max(0.0001, nextPrice);
      prices[asset] = roundPrice(nextPrice);
      updateCandles(session.market.candles, asset, prices[asset]);
    });
    session.market.prices = prices;
    session.market.orderBook = buildOrderBook(prices);
    updateBots(session);
    markToMarket(session);
    socket.emit('market_update', {
      prices,
      candles: session.market.candles,
      orderBook: session.market.orderBook,
      bots: session.bots,
    });
  });
}

io.on('connection', (socket) => {
  socket.on('start_game', (payload) => {
    const session = createSession(socket.id, payload);
    emitSession(socket, session);
  });

  socket.on('place_order', (order, callback) => {
    const session = sessions.get(socket.id);
    if (!session) return;
    const result = handleOrder(session, order);
    markToMarket(session);
    emitSession(socket, session);
    if (callback) callback(result);
  });

  socket.on('claim_faucet', () => {
    const session = sessions.get(socket.id);
    if (!session || session.faucetClaimed) return;
    if (session.holdings.USD <= 0) {
      session.holdings.USD = 10;
      session.faucetClaimed = true;
      emitSession(socket, session);
    }
  });

  socket.on('disconnect', () => {
    sessions.delete(socket.id);
  });
});

setInterval(tick, TICK_MS);

httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
