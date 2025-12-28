import { useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import classNames from 'classnames';
import { CandlestickSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import './App.css';

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

const patterns = [
  'Falling wedge spotted – watch for a fake breakout.',
  'Ascending wedge forming – pressure building on bulls.',
  'Fake breakout just happened, volume drying up.',
  'Sideways chop – stay patient, avoid FOMO.',
  'Momentum spike incoming – scale in slowly.',
];

const difficulties = ['Real-World', 'Easy', 'Medium', 'Hard'] as const;
const modes = ['EZ-Mode', 'Admin', 'Whale'] as const;
const priceProviders = ['internal', 'coingecko', 'binance'] as const;

type Difficulty = (typeof difficulties)[number];
type Mode = (typeof modes)[number];
type PriceProvider = (typeof priceProviders)[number];

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

type OrderBook = {
  bids: { price: number; size: number }[];
  asks: { price: number; size: number }[];
};

type MarketState = {
  prices: Record<string, number>;
  candles: Record<string, Candle[]>;
  orderBook: Record<string, OrderBook>;
};

type Position = {
  symbol: string;
  side: 'long' | 'short';
  quote: string;
  entryPrice: number;
  quantity: number;
  leverage: number;
  margin: number;
};

type BotRow = {
  id: string;
  name: string;
  balance: number;
  realizedPnl: number;
  unrealizedPnl: number;
};

type SessionState = {
  playerName: string;
  difficulty: Difficulty;
  mode: Mode;
  priceProvider: PriceProvider;
  holdings: Record<string, number>;
  positions: Position[];
  realizedPnl: number;
  unrealizedPnl: number;
  market: MarketState;
  bots: BotRow[];
  startedAt: number;
  faucetClaimed: boolean;
};

type OrderForm = {
  base: string;
  quote: string;
  side: 'buy' | 'sell';
  size: number;
  leverage: number;
};

const localHosts = ['localhost', '127.0.0.1', '::1'];

function resolveSocketUrl() {
  if (import.meta.env.VITE_SERVER_URL) return import.meta.env.VITE_SERVER_URL;

  const { protocol, hostname, port } = window.location;

  if (localHosts.includes(hostname)) {
    return `${protocol}//${hostname}:4000`;
  }

  // Handle forwarded dev URLs where the port is encoded in the subdomain (e.g. 5173-myapp.example -> 4000-myapp.example)
  const subdomainPortMatch = hostname.match(/^(\d+)-(.*)$/);
  if (subdomainPortMatch) {
    return `${protocol}//4000-${subdomainPortMatch[2]}`;
  }

  // Fallback: keep the host and only swap the port when it is explicitly present
  if (port) {
    const targetPort = port === '5173' ? '4000' : port;
    return `${protocol}//${hostname}:${targetPort}`;
  }

  return `${protocol}//${hostname}`;
}

const socketUrl = resolveSocketUrl();

function useSocket() {
  return useMemo(
    () =>
      io(socketUrl, {
        autoConnect: false,
        transports: ['websocket', 'polling'],
      }),
    []
  );
}

const formatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatPrice(value?: number) {
  if (!value && value !== 0) return '-';
  return Number(value).toFixed(4);
}

function App() {
  const socket = useSocket();
  const socketRef = useRef<Socket | null>(null);
  const pendingStartRef = useRef<(() => void) | null>(null);
  const [step, setStep] = useState<'welcome' | 'setup' | 'play'>('welcome');
  const [playerName, setPlayerName] = useState('');
  const [difficulty, setDifficulty] = useState<Difficulty>('Medium');
  const [mode, setMode] = useState<Mode>('EZ-Mode');
  const [priceProvider, setPriceProvider] = useState<PriceProvider>('internal');
  const [session, setSession] = useState<SessionState | null>(null);
  const [market, setMarket] = useState<MarketState | null>(null);
  const [selectedAsset, setSelectedAsset] = useState('BTC');
  const [orderForm, setOrderForm] = useState<OrderForm>({
    base: 'BTC',
    quote: 'USD',
    side: 'buy',
    size: 0.01,
    leverage: 1,
  });
  const [status, setStatus] = useState<string>('');
  const [connecting, setConnecting] = useState(false);
  const [timeLeft, setTimeLeft] = useState<string>('15:00');
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartInstanceRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const patternRef = useRef<string>(patterns[0]);

  useEffect(() => {
    socketRef.current = socket;
    socket.connect();
    console.info('[network] Attempting socket connection', { url: socketUrl });

    const handleConnect = () => {
      console.info('[network] Connected to server', { url: socketUrl, id: socket.id });
      setStatus(`Connecté au serveur (${socketUrl}).`);
      if (!pendingStartRef.current) {
        setConnecting(false);
      }
    };

    const handleSessionUpdate = (data: SessionState) => {
      console.info('[network] session_update received', { priceProvider: data.priceProvider, difficulty: data.difficulty });
      setSession(data);
      setMarket(data.market);
      setPattern();
      setStep('play');
      setStatus('');
      setConnecting(false);
    };

    const handleMarketUpdate = (payload: Partial<MarketState> & { bots?: BotRow[] }) => {
      console.info('[network] market_update received', {
        prices: Object.keys(payload.prices || {}).length,
        candles: Object.keys(payload.candles || {}).length,
      });
      setMarket((prev) => ({
        prices: payload.prices || prev?.prices || {},
        candles: payload.candles || prev?.candles || {},
        orderBook: payload.orderBook || prev?.orderBook || {},
      }));
      setSession((prev) => (prev ? { ...prev, bots: payload.bots || prev.bots } : prev));
    };

    const handleConnectError = (err: unknown) => {
      console.error('[network] connect_error', err);
      if (pendingStartRef.current) {
        socket.off('connect', pendingStartRef.current);
        pendingStartRef.current = null;
      }
      setStatus(`Connexion au serveur impossible (${socketUrl}). Vérifiez que le backend tourne.`);
      setConnecting(false);
    };

    const handleDisconnect = () => {
      console.warn('[network] Socket disconnected');
      if (pendingStartRef.current) {
        socket.off('connect', pendingStartRef.current);
        pendingStartRef.current = null;
      }
      setStatus('Déconnecté du serveur. Relancez la partie pour réessayer.');
      setSession(null);
      setMarket(null);
      setStep('welcome');
      setConnecting(false);
    };

    socket.on('connect', handleConnect);
    socket.on('session_update', handleSessionUpdate);
    socket.on('market_update', handleMarketUpdate);
    socket.on('connect_error', handleConnectError);
    socket.on('disconnect', handleDisconnect);

    return () => {
      if (pendingStartRef.current) {
        socket.off('connect', pendingStartRef.current);
        pendingStartRef.current = null;
      }
      socket.off('connect', handleConnect);
      socket.off('session_update', handleSessionUpdate);
      socket.off('market_update', handleMarketUpdate);
      socket.off('connect_error', handleConnectError);
      socket.off('disconnect', handleDisconnect);
      socket.disconnect();
    };
  }, [socket]);

  useEffect(() => {
    if (!market || !chartRef.current) return;
    const chart = createChart(chartRef.current, {
      layout: { background: { color: '#050a10' }, textColor: '#dfe7ef' },
      grid: {
        vertLines: { color: '#121a24' },
        horzLines: { color: '#121a24' },
      },
      width: chartRef.current.clientWidth,
      height: 380,
      rightPriceScale: {
        borderColor: '#1f2a35',
      },
      timeScale: {
        rightOffset: 8,
        barSpacing: 9,
        fixLeftEdge: false,
        lockVisibleTimeRangeOnResize: false,
        rightBarStaysOnScroll: true,
        borderColor: '#1f2a35',
        secondsVisible: true,
        timeVisible: true,
      },
      crosshair: {
        mode: 1,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: {
          time: true,
          price: true,
        },
      },
    });
    chartInstanceRef.current = chart;
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#15c98b',
      downColor: '#f03a5f',
      borderUpColor: '#15c98b',
      borderDownColor: '#f03a5f',
      wickUpColor: '#15c98b',
      wickDownColor: '#f03a5f',
    });
    candleSeriesRef.current = candleSeries;
    const resizeObserver = new ResizeObserver(() => {
      chart.applyOptions({ width: chartRef.current?.clientWidth || 300 });
    });
    resizeObserver.observe(chartRef.current);

    return () => {
      chartInstanceRef.current = null;
      chart.remove();
      resizeObserver.disconnect();
    };
  }, [market]);

  useEffect(() => {
    if (!market || !candleSeriesRef.current) return;
    const candles = market.candles?.[selectedAsset] || [];
    candleSeriesRef.current.setData(
      candles.map((candle) => ({
        time: (candle.time / 1000) as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      }))
    );
    candleSeriesRef.current.priceScale().applyOptions({
      scaleMargins: {
        top: 0.1,
        bottom: 0.15,
      },
    });
    chartInstanceRef.current?.timeScale().fitContent();
  }, [market, selectedAsset]);

  const setPattern = () => {
    const choice = patterns[Math.floor(Math.random() * patterns.length)];
    patternRef.current = choice;
  };

  useEffect(() => {
    if (!session?.startedAt) return undefined;
    const startedAt = session.startedAt;
    const interval = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(0, 15 * 60 * 1000 - elapsed);
      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000)
        .toString()
        .padStart(2, '0');
      setTimeLeft(`${minutes}:${seconds}`);
    }, 1000);
    return () => clearInterval(interval);
  }, [session?.startedAt]);

  const handleStart = () => {
    if (!playerName.trim()) {
      setStatus('Merci de saisir un nom de joueur.');
      return;
    }
    const socketClient = socketRef.current || socket;
    const startGame = () => {
      setStatus(`Connexion au serveur (${socketUrl}) | Provider prix : ${priceProvider}`);
      setConnecting(true);
      socketClient.emit('start_game', { playerName, difficulty, mode, priceProvider });
    };

    if (socketClient.connected) {
      startGame();
      return;
    }

    if (pendingStartRef.current) {
      socketClient.off('connect', pendingStartRef.current);
    }

    const deferredStart = () => {
      pendingStartRef.current = null;
      startGame();
    };
    pendingStartRef.current = deferredStart;
    socketClient.on('connect', deferredStart);
    socketClient.connect();
    setStatus(`Connexion au serveur (${socketUrl}) | Provider prix : ${priceProvider}`);
    setConnecting(true);
  };

  const handleOrder = () => {
    if (!orderForm.size || orderForm.size <= 0) {
      setStatus('Veuillez saisir une taille d\'ordre valide.');
      return;
    }
    socketRef.current?.emit('place_order', orderForm, (response: { error?: string; convertedFromUsd?: number; pairPrice?: number }) => {
      if (response?.error) {
        setStatus(response.error);
      } else {
        const conversionNote = response.convertedFromUsd
          ? ` | ${formatter.format(response.convertedFromUsd)} USD convertis en ${orderForm.quote}`
          : '';
        setStatus(`Ordre exécuté sur ${orderForm.base}/${orderForm.quote} à ${formatPrice(response.pairPrice)}${conversionNote}`);
      }
    });
  };

  const handleFaucet = () => {
    socketRef.current?.emit('claim_faucet');
  };

  const handleClosePosition = (symbol: string, side?: 'long' | 'short') => {
    socketRef.current?.emit('close_position', { symbol, side }, (response: { error?: string; closed?: number }) => {
      if (response?.error) {
        setStatus(response.error);
      } else if (response?.closed) {
        setStatus(`Fermé ${response.closed} position(s) sur ${symbol}.`);
      }
    });
  };

  const handleCloseAll = () => {
    if (!session) return;
    const symbols = Array.from(new Set(session.positions.map((p) => p.symbol)));
    symbols.forEach((symbol) => handleClosePosition(symbol));
  };

  const aggregatedBalanceValue = () => {
    if (!session || !market) return 0;
    const totalUsd = Object.entries(session.holdings).reduce((acc, [currency, amount]) => {
      const price = market.prices?.[currency] || 1;
      return acc + amount * price;
    }, 0);
    return totalUsd + session.realizedPnl + session.unrealizedPnl;
  };

  const aggregatedBalanceDisplay = () => formatter.format(aggregatedBalanceValue());

  const leaderboard = (session?.bots || [])
    .concat(
      session
        ? [{
            id: 'player',
            name: `${session.playerName} (Vous)`,
            balance: aggregatedBalanceValue(),
            realizedPnl: session.realizedPnl,
            unrealizedPnl: session.unrealizedPnl,
          }]
        : []
    )
    .sort((a, b) => b.realizedPnl - a.realizedPnl)
    .slice(0, 21);

  const activePrice = market?.prices?.[selectedAsset];
  const activeOrderBook = market?.orderBook?.[selectedAsset];
  const realized = session?.realizedPnl ?? 0;
  const unrealized = session?.unrealizedPnl ?? 0;
  const positionsView = useMemo(() => {
    if (!session || !market) return [];
    return session.positions.map((pos) => {
      const basePx = market.prices?.[pos.symbol] || 0;
      const quotePx = market.prices?.[pos.quote] || 1;
      const pairPrice = quotePx ? basePx / quotePx : 0;
      const pnl = (pos.side === 'long' ? pairPrice - pos.entryPrice : pos.entryPrice - pairPrice) * pos.quantity * pos.leverage;
      const pnlPct = pos.margin ? (pnl / pos.margin) * 100 : 0;
      const liquidation = pos.side === 'long'
        ? pos.entryPrice * (1 - 1 / pos.leverage)
        : pos.entryPrice * (1 + 1 / pos.leverage);
      return {
        ...pos,
        currentPrice: pairPrice,
        pnl,
        pnlPct,
        liquidation,
      };
    });
  }, [session, market]);
  const orderBookMaxSize = useMemo(() => {
    const sizes = [
      ...(activeOrderBook?.asks?.map((a) => a.size) || []),
      ...(activeOrderBook?.bids?.map((b) => b.size) || []),
    ];
    return Math.max(...(sizes.length ? sizes : [1]));
  }, [activeOrderBook]);

  return (
    <div className="app-shell">
      <header className="nav">
        <div className="brand">Cryptycoon</div>
        <div className="meta">
          <span className="pill">Difficulté : {difficulty}</span>
          <span className="pill">Mode : {mode}</span>
          <span className="pill">API Prix : {session?.priceProvider || priceProvider}</span>
          <span className="pill">Timer : {timeLeft}</span>
        </div>
      </header>

      {step === 'welcome' && (
        <section className="panel hero">
          <div>
            <h1>Bienvenue dans Cryptycoon</h1>
            <p>
              Simulez un exchange crypto sombre façon Binance : order book en direct, chandeliers, bots concurrents, levier jusqu\'à x200 et difficultés qui réagissent à votre trading.
            </p>
            <button className="primary" onClick={() => setStep('setup')}>
              Suivant
            </button>
          </div>
        </section>
      )}

      {step === 'setup' && (
        <section className="panel setup">
          <div className="form-grid">
            <label>
              Nom du joueur
              <input value={playerName} onChange={(e) => setPlayerName(e.target.value)} placeholder="Satoshi" />
            </label>
            <label>
              Difficulté
              <select value={difficulty} onChange={(e) => setDifficulty(e.target.value as Difficulty)}>
                {difficulties.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </label>
            <label>
              Mode de jeu
              <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
                {modes.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
            <label>
              Source des prix
              <select
                value={priceProvider}
                onChange={(e) => setPriceProvider(e.target.value as PriceProvider)}
              >
                {priceProviders.map((provider) => (
                  <option key={provider} value={provider}>
                    {provider === 'internal' ? 'Interne (sans API externe)' : provider}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="muted">
            Real-World met à jour les cours toutes les 3s avec les marchés réels. Easy, Medium et Hard génèrent leurs propres patterns : falling wedges, fake breakouts et autres surprises.
          </p>
          <p className="muted">
            Serveur ciblé : <code>{socketUrl}</code>. Choisissez "Interne" si les API Binance ou CoinGecko sont injoignables.
          </p>
          <button className="primary" onClick={handleStart} disabled={connecting}>
            {connecting ? 'Connexion...' : 'Lancer la partie'}
          </button>
          {status && <p className="status">{status}</p>}
        </section>
      )}

      {step === 'play' && (
        <>
          <section className="panel banner">
            <div className="banner-left">
              <p className="eyebrow">Salle de trading en direct</p>
              <h2>Desk de {session?.playerName}</h2>
              <p className="muted">{patternRef.current}</p>
              <div className="pill-row">
                <span className="pill">Difficulté : {difficulty}</span>
                <span className="pill">Mode : {mode}</span>
                <span className="pill">Provider : {session?.priceProvider || priceProvider}</span>
                <span className="pill">Timer : {timeLeft}</span>
              </div>
            </div>
            <div className="banner-actions">
              <div className="stat-block">
                <p className="muted">Balance agrégée</p>
                <strong>{aggregatedBalanceDisplay()} $</strong>
              </div>
              <div className="stat-block">
                <p className="muted">PnL</p>
                <strong className={unrealized >= 0 ? 'buy' : 'sell'}>
                  {formatter.format(unrealized + realized)} $
                </strong>
              </div>
              <button className="secondary ghost" onClick={handleCloseAll} disabled={!session?.positions.length}>
                Fermer toutes les positions
              </button>
              {status && <p className="status">{status}</p>}
            </div>
          </section>

          <div className="grid grid-main">
            <section className="panel chart">
              <div className="panel-header">
                <div className="pair-header">
                  <h2>{selectedAsset}/USD</h2>
                  <span className="live-dot">live</span>
                </div>
                <div className="header-actions">
                  <select
                    value={selectedAsset}
                    onChange={(e) => {
                      setSelectedAsset(e.target.value);
                      setOrderForm((prev) => ({ ...prev, base: e.target.value }));
                    }}
                  >
                    {assets.map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </select>
                  <div className="pill soft">{patternRef.current}</div>
                </div>
              </div>
              <div ref={chartRef} className="chart-area" />
              <div className="price-strip cards">
                <div className="mini-card">
                  <p className="muted">Dernier prix</p>
                  <strong>{formatPrice(activePrice)}</strong>
                </div>
                <div className="mini-card">
                  <p className="muted">PnL flottant</p>
                  <strong className={unrealized >= 0 ? 'buy' : 'sell'}>{formatter.format(unrealized)}</strong>
                </div>
                <div className="mini-card">
                  <p className="muted">PnL réalisé</p>
                  <strong className={realized >= 0 ? 'buy' : 'sell'}>{formatter.format(realized)}</strong>
                </div>
                <div className="mini-card">
                  <p className="muted">Sessions bots</p>
                  <strong>{session?.bots?.length || 0}</strong>
                </div>
              </div>
            </section>

            <section className="panel trade trade-panel">
              <div className="panel-header">
                <h3>Ticket d'ordre</h3>
                <div className="pill soft">Levier max {mode === 'EZ-Mode' ? '200x' : '500x'}</div>
              </div>
              <div className="form-grid">
                <label>
                  Base
                  <select value={orderForm.base} onChange={(e) => setOrderForm({ ...orderForm, base: e.target.value })}>
                    {assets.map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Contre-devise
                  <select value={orderForm.quote} onChange={(e) => setOrderForm({ ...orderForm, quote: e.target.value })}>
                    {assets.map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Taille
                  <input
                    type="number"
                    min={0}
                    step={0.0001}
                    value={orderForm.size}
                    onChange={(e) => setOrderForm({ ...orderForm, size: Number(e.target.value) })}
                  />
                </label>
                <label>
                  Levier
                  <input
                    type="number"
                    min={1}
                    max={mode === 'EZ-Mode' ? 200 : 500}
                    value={orderForm.leverage}
                    onChange={(e) => setOrderForm({ ...orderForm, leverage: Number(e.target.value) })}
                  />
                </label>
              </div>
              <div className="side-buttons">
                <button
                  className={classNames('buy', { active: orderForm.side === 'buy' })}
                  onClick={() => setOrderForm({ ...orderForm, side: 'buy' })}
                >
                  Long / Buy
                </button>
                <button
                  className={classNames('sell', { active: orderForm.side === 'sell' })}
                  onClick={() => setOrderForm({ ...orderForm, side: 'sell' })}
                >
                  Short / Sell
                </button>
              </div>
              <div className="leverage-row">
                {[1, 5, 25, 100].map((value) => (
                  <button
                    key={value}
                    className={classNames('chip', { active: orderForm.leverage === value })}
                    onClick={() => setOrderForm({ ...orderForm, leverage: value })}
                  >
                    {value}x
                  </button>
                ))}
              </div>
              <button className="primary block" onClick={handleOrder}>
                Exécuter l'ordre
              </button>

              <div className="holdings">
                <div className="panel-subheader">
                  <h4>Solde</h4>
                  {session && session.holdings.USD <= 0 && !session.faucetClaimed && (
                    <button className="secondary compact" onClick={handleFaucet}>
                      Faucet 10$
                    </button>
                  )}
                </div>
                <div className="pill-row">
                  {session &&
                    Object.entries(session.holdings).map(([key, value]) => (
                      <span key={key} className="pill">
                        {key}: {formatter.format(value)}
                      </span>
                    ))}
                </div>
              </div>
            </section>

            <section className="panel orderbook depth-panel">
              <div className="panel-header">
                <h3>Order book {selectedAsset}</h3>
                <p className="muted">Binance feed + profondeur synthétique</p>
              </div>
              <div className="orderbook-grid depth">
                <div>
                  <h4>Asks</h4>
                  {activeOrderBook?.asks?.slice(0, 12).map((ask, idx) => (
                    <div key={`ask-${idx}`} className="depth-row ask">
                      <div className="depth-bar ask" style={{ width: `${(ask.size / orderBookMaxSize) * 100}%` }} />
                      <div className="depth-values">
                        <span>{formatPrice(ask.price)}</span>
                        <span>{ask.size.toFixed(4)}</span>
                      </div>
                    </div>
                  ))}
                </div>
                <div>
                  <h4>Bids</h4>
                  {activeOrderBook?.bids?.slice(0, 12).map((bid, idx) => (
                    <div key={`bid-${idx}`} className="depth-row bid">
                      <div className="depth-bar bid" style={{ width: `${(bid.size / orderBookMaxSize) * 100}%` }} />
                      <div className="depth-values">
                        <span>{formatPrice(bid.price)}</span>
                        <span>{bid.size.toFixed(4)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section className="panel positions positions-panel">
              <div className="panel-header">
                <h3>Positions & Liquidations</h3>
                <button className="secondary compact" onClick={handleCloseAll} disabled={!positionsView.length}>
                  Fermer tout
                </button>
              </div>
              {positionsView.length === 0 ? (
                <p className="muted">Aucune position ouverte. Passez un ordre pour commencer.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Symbole</th>
                      <th>Quote</th>
                      <th>Side</th>
                      <th>Quantité</th>
                      <th>Entrée</th>
                      <th>Prix Actuel</th>
                      <th>PnL</th>
                      <th>Liq.</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {positionsView.map((pos) => (
                      <tr key={`${pos.symbol}-${pos.side}-${pos.quote}`}>
                        <td>{pos.symbol}</td>
                        <td>{pos.quote}</td>
                        <td className={pos.side === 'long' ? 'buy' : 'sell'}>{pos.side}</td>
                        <td>{pos.quantity.toFixed(4)}</td>
                        <td>{formatPrice(pos.entryPrice)}</td>
                        <td>{formatPrice(pos.currentPrice)}</td>
                        <td className={pos.pnl >= 0 ? 'buy' : 'sell'}>
                          {formatter.format(pos.pnl)} ({pos.pnlPct.toFixed(2)}%)
                        </td>
                        <td>{formatPrice(pos.liquidation)}</td>
                        <td>
                          <button className="secondary compact" onClick={() => handleClosePosition(pos.symbol, pos.side)}>
                            Fermer
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="panel leaderboard">
              <h3>Leaderboard (PnL réalisé)</h3>
              <table>
                <thead>
                  <tr>
                    <th>Joueur</th>
                    <th>Realized</th>
                    <th>Unrealized</th>
                    <th>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.map((row) => (
                    <tr key={row.id} className={row.name.includes('Vous') ? 'you' : ''}>
                      <td>{row.name}</td>
                      <td>{formatter.format(row.realizedPnl)}</td>
                      <td>{formatter.format(row.unrealizedPnl)}</td>
                      <td>{typeof row.balance === 'number' ? formatter.format(row.balance) : row.balance}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

export default App;
