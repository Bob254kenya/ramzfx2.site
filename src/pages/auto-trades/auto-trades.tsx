// auto-trades.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import Input from '@/components/shared_ui/input';
import ThemedScrollbars from '@/components/shared_ui/themed-scrollbars';
import { DBOT_TABS } from '@/constants/bot-contents';
import { contract_stages } from '@/constants/contract-stage';
import { api_base, observer as globalObserver } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import { conditionNotifierStore } from '@/stores/condition-notifier-store';
import { SUPPORTED_VOLATILITY_MARKETS } from '@/utils/digit-strategy';
import { recordDiagnosticEvent, setDiagnosticGauge } from '@/utils/diagnostics';
import { getLastDigitFromQuote, getMarketPipSize, isExpectedStreamInterruption } from '@/utils/market-data';
import { buyContractForUi, streamContractUntilSettled } from '@/utils/trade-purchase';
import { safeSubscribe } from '@/utils/websocket-handler';
import './auto-trades.scss';

// ── Constants ────────────────────────────────────────────────────────────────

type AutoMarket = { symbol: string; label: string; pip: number };
type Direction = 1 | -1 | 0;

const FIVE_MINUTE_GRANULARITY = 300;
const DATA_SILENCE_RESTART_MS = 15000;
const DATA_RESTART_COOLDOWN_MS = 10000;
const UI_REFRESH_THROTTLE_MS = 80;
const MARKET_LOSS_COOLDOWN_TICKS = 20;
const MAX_STREAK_LENGTH = 10;
const MAX_ANALYSIS_TICKS = 10;
const MAX_CONSECUTIVE_LOSSES = 10;

export type TradeType =
    | 'DIGITOVER'
    | 'DIGITUNDER'
    | 'DIGITEVEN'
    | 'DIGITODD'
    | 'DIGITMATCH'
    | 'DIGITDIFF'
    | 'CALL'
    | 'PUT'
    | 'RUNHIGH'
    | 'RUNLOW';

const TRADE_TYPE_LABELS: Record<TradeType, string> = {
    DIGITOVER: 'Over',
    DIGITUNDER: 'Under',
    DIGITEVEN: 'Even',
    DIGITODD: 'Odd',
    DIGITMATCH: 'Matches',
    DIGITDIFF: 'Differs',
    CALL: 'Rise',
    PUT: 'Fall',
    RUNHIGH: 'Only Ups',
    RUNLOW: 'Only Downs',
};

const BARRIER_NEEDED: Record<TradeType, boolean> = {
    DIGITOVER: true,
    DIGITUNDER: true,
    DIGITEVEN: false,
    DIGITODD: false,
    DIGITMATCH: true,
    DIGITDIFF: true,
    CALL: false,
    PUT: false,
    RUNHIGH: false,
    RUNLOW: false,
};

const IS_DIRECTION_TYPE: Record<TradeType, boolean> = {
    DIGITOVER: false,
    DIGITUNDER: false,
    DIGITEVEN: false,
    DIGITODD: false,
    DIGITMATCH: false,
    DIGITDIFF: false,
    CALL: true,
    PUT: true,
    RUNHIGH: true,
    RUNLOW: true,
};

const VALID_TRADE_TYPES: TradeType[] = [
    'DIGITOVER',
    'DIGITUNDER',
    'DIGITEVEN',
    'DIGITODD',
    'DIGITMATCH',
    'DIGITDIFF',
    'CALL',
    'PUT',
    'RUNHIGH',
    'RUNLOW',
];

const AUTO_MARKETS: AutoMarket[] = SUPPORTED_VOLATILITY_MARKETS.map(market => ({
    label: market.label.replace('Volatility ', 'Vol ').replace(' Index', ''),
    pip: market.pip ?? 2,
    symbol: market.symbol,
}));

const AUTO_MARKET_SYMBOLS = AUTO_MARKETS.map(({ symbol }) => symbol);
const AUTO_MARKET_LOOKUP = new Map(AUTO_MARKETS.map(market => [market.symbol, market]));

// ── Utility Functions ──────────────────────────────────────────────────────

const usesLossPrediction = (trade_type: TradeType) =>
    trade_type === 'DIGITOVER' || trade_type === 'DIGITUNDER';

const isRunTradeType = (trade_type: TradeType) =>
    trade_type === 'RUNHIGH' || trade_type === 'RUNLOW';

const isCandleConfirmedTradeType = (trade_type: TradeType) =>
    trade_type === 'CALL' || trade_type === 'PUT' || trade_type === 'RUNHIGH' || trade_type === 'RUNLOW';

const getDigitNumber = (value: unknown, fallback: number) => {
    const digit = Number(value);
    return Number.isFinite(digit) ? Math.min(9, Math.max(0, Math.trunc(digit))) : fallback;
};

const getCandleDirectionLabel = (direction: Direction) => {
    if (direction === 1) return 'Bullish';
    if (direction === -1) return 'Bearish';
    return 'Neutral';
};

const getComparisonOperatorLabel = (operator: ComparisonOperator): string => {
    const labels: Record<ComparisonOperator, string> = {
        '>': 'Greater than (>)',
        '<': 'Less than (<)',
        '>=': 'Greater than or equal (>=)',
        '<=': 'Less than or equal (<=)',
        '==': 'Equal to (==)',
    };
    return labels[operator] || operator;
};

// ── Types ──────────────────────────────────────────────────────────────────

type ComparisonOperator = '>' | '<' | '>=' | '<=' | '==';

interface MarketConfig {
    marketSymbol: string;
    tradeType: TradeType;
    barrier: string;
    predictionDigit: string;
    comparisonOperator: ComparisonOperator;
    inputSequence: string;
    analysisTicks: string;
    inverseMode: boolean;
    enabled: boolean;
}

interface MarketState {
    consecutive: number;
    trading: boolean;
    isRecovering: boolean;
    lastDigits: number[];
    directionHistory: Direction[];
    prevQuote: number | null;
    candleDirection: Direction;
    candleOpen: number | null;
    candleClose: number | null;
    lastResult: 'win' | 'loss' | null;
    lastQuote: number | null;
    tradeStartTime: number | null;
    verificationId: string | null;
    lossCooldownLeft: number;
    currentStake: number;
    consecutiveLosses: number;
    lastResultType: 'win' | 'loss' | null;
    tradeCount: number;
    baseStake: number;
    martingaleMultiplier: number;
    isExecuting: boolean;
    lastPrice: number | null;
    priceHistory: number[];
}

interface MarketDisplay extends MarketState {
    symbol: string;
    label: string;
    pip: number;
}

// ── State Helpers ──────────────────────────────────────────────────────────

const createMarketState = (prev?: Partial<MarketState>): MarketState => ({
    consecutive: 0,
    trading: false,
    isRecovering: false,
    lastDigits: [],
    directionHistory: [],
    prevQuote: null,
    candleDirection: 0,
    candleOpen: null,
    candleClose: null,
    lastResult: null,
    lastQuote: null,
    tradeStartTime: null,
    verificationId: null,
    lossCooldownLeft: 0,
    currentStake: 1,
    consecutiveLosses: 0,
    lastResultType: null,
    tradeCount: 0,
    baseStake: 1,
    martingaleMultiplier: 1,
    isExecuting: false,
    lastPrice: null,
    priceHistory: [],
    ...prev,
});

// ── Signal Detection ──────────────────────────────────────────────────────

const checkComparison = (digit: number, operator: ComparisonOperator, value: number): boolean => {
    switch (operator) {
        case '>': return digit > value;
        case '<': return digit < value;
        case '>=': return digit >= value;
        case '<=': return digit <= value;
        case '==': return digit === value;
        default: return false;
    }
};

const checkTickPattern = (digits: number[], tickCount: number, operator: ComparisonOperator, barrier: number): boolean => {
    if (digits.length < tickCount) return false;
    const recentDigits = digits.slice(-tickCount);
    return recentDigits.every(digit => checkComparison(digit, operator, barrier));
};

const parseEOPattern = (sequence: string): string[] => {
    return sequence.replace(/[,;\s]/g, '').split('').filter(ch => ch === 'E' || ch === 'O');
};

const checkEOPattern = (digits: number[], pattern: string[]): boolean => {
    if (digits.length < pattern.length) return false;
    const recentDigits = digits.slice(-pattern.length);
    for (let i = 0; i < pattern.length; i++) {
        const expected = pattern[i];
        const actual = recentDigits[i];
        if (expected === 'E' && actual % 2 !== 0) return false;
        if (expected === 'O' && actual % 2 === 0) return false;
    }
    return true;
};

const isDigitSignalMatch = ({
    trade_type,
    digit,
    barrier,
    inverse,
}: {
    trade_type: TradeType;
    digit: number;
    barrier: number;
    inverse: boolean;
}) => {
    if (trade_type === 'DIGITOVER') {
        const result = digit >= barrier;
        return inverse ? !result : result;
    }
    if (trade_type === 'DIGITUNDER') {
        const result = digit <= barrier;
        return inverse ? !result : result;
    }
    if (trade_type === 'DIGITEVEN') {
        const isEven = digit % 2 === 0;
        return inverse ? !isEven : isEven;
    }
    if (trade_type === 'DIGITODD') {
        const isOdd = digit % 2 !== 0;
        return inverse ? !isOdd : isOdd;
    }
    if (trade_type === 'DIGITMATCH') {
        return inverse ? digit !== barrier : digit === barrier;
    }
    if (trade_type === 'DIGITDIFF') {
        return inverse ? digit === barrier : digit !== barrier;
    }
    return false;
};

const isDirectionMatch = (trade_type: TradeType, direction: Direction) => {
    if (trade_type === 'CALL') return direction === -1;
    if (trade_type === 'PUT') return direction === 1;
    if (trade_type === 'RUNHIGH') return direction === -1;
    if (trade_type === 'RUNLOW') return direction === 1;
    return false;
};

const isCandleMatch = (trade_type: TradeType, candle_direction: Direction) => {
    if (trade_type === 'CALL') return candle_direction === 1;
    if (trade_type === 'PUT') return candle_direction === -1;
    if (trade_type === 'RUNHIGH') return candle_direction === 1;
    if (trade_type === 'RUNLOW') return candle_direction === -1;
    return true;
};

// ── Martingale Logic ─────────────────────────────────────────────────────
// FIX: base_stake is always the user-configured stake from React state (passed fresh on each call).
//      This ensures stake changes are respected and the multiplier chain is always anchored correctly.

const getNextMartingaleState = ({
    profit,
    base_stake,
    multiplier,
    martingale_enabled,
    consecutive_losses,
}: {
    profit: number;
    base_stake: number;
    multiplier: number;
    martingale_enabled: boolean;
    consecutive_losses: number;
}) => {
    if (profit >= 0) {
        // WIN — reset everything back to base stake
        return {
            consecutiveLosses: 0,
            lastResult: 'win' as const,
            nextStake: base_stake,
            martingaleMultiplier: 1,
            maxLossesReached: false,
        };
    }

    const nextConsecutiveLosses = consecutive_losses + 1;

    if (nextConsecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
        return {
            consecutiveLosses: nextConsecutiveLosses,
            lastResult: 'loss' as const,
            nextStake: base_stake,
            martingaleMultiplier: 1,
            maxLossesReached: true,
        };
    }

    if (!martingale_enabled) {
        // Martingale off — always trade at base stake regardless of losses
        return {
            consecutiveLosses: nextConsecutiveLosses,
            lastResult: 'loss' as const,
            nextStake: base_stake,
            martingaleMultiplier: 1,
            maxLossesReached: false,
        };
    }

    // FIX: martingale ON — next stake = base_stake * multiplier^nextConsecutiveLosses
    // e.g. base=1, mult=2: loss1→2, loss2→4, loss3→8 ...
    const power = Math.pow(multiplier, nextConsecutiveLosses);
    const nextStake = parseFloat((base_stake * power).toFixed(2));

    return {
        consecutiveLosses: nextConsecutiveLosses,
        lastResult: 'loss' as const,
        nextStake,
        // Store the power factor for display ("×4" not "×2")
        martingaleMultiplier: power,
        maxLossesReached: false,
    };
};

// ── Component ─────────────────────────────────────────────────────────────

const AutoTrades = observer(() => {
    const { dashboard, client, run_panel, summary_card, transactions } = useStore();
    const { currency } = client;
    const { active_tab } = dashboard;

    const show_auto = active_tab === DBOT_TABS.AUTO_TRADES;

    // ── Local Storage Helpers ─────────────────────────────────────────────

    const loadSaved = (key: string, fallback: string) => {
        try {
            return localStorage.getItem(`auto_trades_${key}`) || fallback;
        } catch {
            return fallback;
        }
    };

    const loadSavedNum = (key: string, fallback: string, min: number, max: number) => {
        const v = loadSaved(key, fallback);
        const n = Number(v);
        return !isNaN(n) && n >= min && n <= max ? v : fallback;
    };

    const loadSavedBoolean = (key: string, fallback: boolean) => {
        try {
            const val = localStorage.getItem(`auto_trades_${key}`);
            if (val === null) return fallback;
            return val === 'true';
        } catch {
            return fallback;
        }
    };

    const loadSavedMarkets = () => {
        try {
            const raw = localStorage.getItem('auto_trades_markets');
            const parsed = raw ? JSON.parse(raw) : null;
            if (Array.isArray(parsed)) {
                const symbols = Array.from(
                    new Set(
                        parsed.filter(
                            (symbol): symbol is string => typeof symbol === 'string' && AUTO_MARKET_LOOKUP.has(symbol)
                        )
                    )
                );
                return symbols;
            }
        } catch {
            // ignore
        }
        return AUTO_MARKET_SYMBOLS.slice(0, 2);
    };

    // ── Global Settings State ─────────────────────────────────────────────

    const [stake, setStake] = useState(() => loadSavedNum('stake', '1', 0.35, 100000));
    const [martingaleEnabled, setMartingaleEnabled] = useState(() => loadSavedBoolean('martingaleEnabled', true));
    const [martingaleMultiplier, setMartingaleMultiplier] = useState(() => {
        const saved = loadSaved('martingaleMultiplier', '2');
        const num = parseFloat(saved);
        return !isNaN(num) && num >= 1 && num <= 10 ? num : 2;
    });
    const [takeProfit, setTakeProfit] = useState(() => loadSavedNum('takeProfit', '100', 1, 1000000));
    const [stopLoss, setStopLoss] = useState(() => loadSavedNum('stopLoss', '100', 1, 1000000));
    const [switchOnLoss, setSwitchOnLoss] = useState(() => loadSavedBoolean('switchOnLoss', false));
    const [scanAllMarkets, setScanAllMarkets] = useState(() => loadSavedBoolean('scanAllMarkets', false));

    // ── Market 1 Config State ─────────────────────────────────────────────

    const [market1Symbol, setMarket1Symbol] = useState(() => {
        const markets = loadSavedMarkets();
        return markets[0] || AUTO_MARKET_SYMBOLS[0];
    });
    const [market1TradeType, setMarket1TradeType] = useState<TradeType>(() => {
        const v = loadSaved('market1_tradeType', 'DIGITOVER');
        return VALID_TRADE_TYPES.includes(v as TradeType) ? (v as TradeType) : 'DIGITOVER';
    });
    const [market1Barrier, setMarket1Barrier] = useState(() => loadSavedNum('market1_barrier', '4', 0, 9));
    const [market1PredictionDigit, setMarket1PredictionDigit] = useState(() =>
        loadSavedNum('market1_predictionDigit', '4', 0, 9)
    );
    const [market1ComparisonOperator, setMarket1ComparisonOperator] = useState<ComparisonOperator>(() => {
        const saved = loadSaved('market1_comparisonOperator', '<=');
        return ['>', '<', '>=', '<=', '=='].includes(saved) ? saved as ComparisonOperator : '<=';
    });
    const [market1InputSequence, setMarket1InputSequence] = useState(() =>
        loadSaved('market1_inputSequence', '')
    );
    const [market1AnalysisTicks, setMarket1AnalysisTicks] = useState(() =>
        loadSavedNum('market1_analysisTicks', '4', 1, MAX_ANALYSIS_TICKS)
    );
    const [market1Inverse, setMarket1Inverse] = useState(() => loadSavedBoolean('market1_inverse', false));
    const [market1Enabled, setMarket1Enabled] = useState(() => loadSavedBoolean('market1_enabled', true));

    // ── Market 2 Config State ─────────────────────────────────────────────

    const [market2Symbol, setMarket2Symbol] = useState(() => {
        const markets = loadSavedMarkets();
        return markets[1] || AUTO_MARKET_SYMBOLS[1] || AUTO_MARKET_SYMBOLS[0];
    });
    const [market2TradeType, setMarket2TradeType] = useState<TradeType>(() => {
        const v = loadSaved('market2_tradeType', 'DIGITUNDER');
        return VALID_TRADE_TYPES.includes(v as TradeType) ? (v as TradeType) : 'DIGITUNDER';
    });
    const [market2Barrier, setMarket2Barrier] = useState(() => loadSavedNum('market2_barrier', '5', 0, 9));
    const [market2PredictionDigit, setMarket2PredictionDigit] = useState(() =>
        loadSavedNum('market2_predictionDigit', '5', 0, 9)
    );
    const [market2ComparisonOperator, setMarket2ComparisonOperator] = useState<ComparisonOperator>(() => {
        const saved = loadSaved('market2_comparisonOperator', '<=');
        return ['>', '<', '>=', '<=', '=='].includes(saved) ? saved as ComparisonOperator : '<=';
    });
    const [market2InputSequence, setMarket2InputSequence] = useState(() =>
        loadSaved('market2_inputSequence', '')
    );
    const [market2AnalysisTicks, setMarket2AnalysisTicks] = useState(() =>
        loadSavedNum('market2_analysisTicks', '4', 1, MAX_ANALYSIS_TICKS)
    );
    const [market2Inverse, setMarket2Inverse] = useState(() => loadSavedBoolean('market2_inverse', false));
    const [market2Enabled, setMarket2Enabled] = useState(() => loadSavedBoolean('market2_enabled', true));

    // ── UI State ───────────────────────────────────────────────────────────

    const [totalPnl, setTotalPnl] = useState(0);
    const [totalTrades, setTotalTrades] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [isRunning, setIsRunning] = useState(false);
    const [isConnected, setIsConnected] = useState(false);
    const [dataStreamLoading, setDataStreamLoading] = useState(false);
    const [dataStreamMessage, setDataStreamMessage] = useState('Loading market data...');
    const [showDisclaimer, setShowDisclaimer] = useState(false);
    const [isDataLoading, setIsDataLoading] = useState(true);
    const [activeTradingMarket, setActiveTradingMarket] = useState<string | null>(null);
    const [marketSwitchActive, setMarketSwitchActive] = useState(false);

    // ── Refs ──────────────────────────────────────────────────────────────

    const subscriptionsRef = useRef<Record<string, any>>({});
    const candleSubscriptionsRef = useRef<Record<string, any>>({});
    const marketStatesRef = useRef<Record<string, MarketState>>(
        Object.fromEntries(AUTO_MARKETS.map(m => [m.symbol, createMarketState()]))
    );
    const marketConfigsRef = useRef<Record<string, MarketConfig>>({});
    const totalPnlRef = useRef(0);
    const totalTradesRef = useRef(0);
    const runningRef = useRef(false);
    const globalTradingRef = useRef(false);
    const show_auto_ref = useRef(show_auto);
    const unmountedRef = useRef(false);
    const lastTickAtRef = useRef(0);
    const restartInFlightRef = useRef(false);
    const lastRestartAttemptAtRef = useRef(0);
    const subscriptionVersionRef = useRef(0);
    const lastUiRefreshAtRef = useRef(0);
    const uiRefreshTimerRef = useRef<number | null>(null);
    const restartTimerRef = useRef<number | null>(null);
    const contractStreamAbortControllersRef = useRef<Set<AbortController>>(new Set());
    const isRecoveringDataRef = useRef(false);
    const handleTickRef = useRef<(symbol: string, tick: any) => void>(() => { });
    const handleCandleRef = useRef<(symbol: string, candle: any) => void>(() => { });
    const stopTradingRef = useRef<() => void>(() => { });
    const selectedMarketsRef = useRef<string[]>([]);
    const lastResultRef = useRef<Record<string, 'win' | 'loss' | null>>({});
    const marketSwitchActiveRef = useRef<boolean>(false);
    const activeTradingMarketRef = useRef<string | null>(null);
    const isPrimaryMarketActiveRef = useRef<boolean>(true);
    const pendingTradePromisesRef = useRef<Record<string, Promise<number> | null>>({});
    const currentTradingMarketRef = useRef<string | null>(null);
    const forceUpdateCounterRef = useRef(0);

    // ── Stake ref so executeTrade/handleAfterTrade always read latest value ──
    // FIX: Keep a ref that always reflects the current stake React state so
    //      closures in async trade callbacks never read stale stake values.
    const stakeRef = useRef(stake);
    useEffect(() => { stakeRef.current = stake; }, [stake]);

    const martingaleEnabledRef = useRef(martingaleEnabled);
    useEffect(() => { martingaleEnabledRef.current = martingaleEnabled; }, [martingaleEnabled]);

    const martingaleMultiplierRef = useRef(martingaleMultiplier);
    useEffect(() => { martingaleMultiplierRef.current = martingaleMultiplier; }, [martingaleMultiplier]);

    // ── Update Refs ──────────────────────────────────────────────────────

    useEffect(() => {
        show_auto_ref.current = show_auto;
    }, [show_auto]);

    useEffect(() => {
        activeTradingMarketRef.current = activeTradingMarket;
    }, [activeTradingMarket]);

    useEffect(() => {
        const markets: string[] = [];
        if (market1Enabled) markets.push(market1Symbol);
        if (market2Enabled) markets.push(market2Symbol);

        if (scanAllMarkets) {
            selectedMarketsRef.current = AUTO_MARKET_SYMBOLS;
        } else {
            selectedMarketsRef.current = markets;
        }

        if (switchOnLoss && market1Enabled && market2Enabled && !scanAllMarkets) {
            if (!activeTradingMarketRef.current) {
                const primary = market1Enabled ? market1Symbol : market2Symbol;
                setActiveTradingMarket(primary);
                activeTradingMarketRef.current = primary;
                isPrimaryMarketActiveRef.current = true;
                marketSwitchActiveRef.current = false;
            }
        } else if (!switchOnLoss || !market1Enabled || !market2Enabled) {
            setActiveTradingMarket(null);
            activeTradingMarketRef.current = null;
            marketSwitchActiveRef.current = false;
            isPrimaryMarketActiveRef.current = true;
        }
    }, [market1Symbol, market2Symbol, market1Enabled, market2Enabled, scanAllMarkets, switchOnLoss]);

    // ── Get Market Config ────────────────────────────────────────────────────

    const getMarketConfig = useCallback((symbol: string): MarketConfig | null => {
        if (scanAllMarkets) {
            if (!market1Enabled) return null;
            return {
                marketSymbol: symbol,
                tradeType: market1TradeType,
                barrier: market1Barrier,
                predictionDigit: market1PredictionDigit,
                comparisonOperator: market1ComparisonOperator,
                inputSequence: market1InputSequence,
                analysisTicks: market1AnalysisTicks,
                inverseMode: market1Inverse,
                enabled: true,
            };
        }

        if (symbol === market1Symbol && market1Enabled) {
            return {
                marketSymbol: symbol,
                tradeType: market1TradeType,
                barrier: market1Barrier,
                predictionDigit: market1PredictionDigit,
                comparisonOperator: market1ComparisonOperator,
                inputSequence: market1InputSequence,
                analysisTicks: market1AnalysisTicks,
                inverseMode: market1Inverse,
                enabled: true,
            };
        }
        if (symbol === market2Symbol && market2Enabled) {
            return {
                marketSymbol: symbol,
                tradeType: market2TradeType,
                barrier: market2Barrier,
                predictionDigit: market2PredictionDigit,
                comparisonOperator: market2ComparisonOperator,
                inputSequence: market2InputSequence,
                analysisTicks: market2AnalysisTicks,
                inverseMode: market2Inverse,
                enabled: true,
            };
        }
        return null;
    }, [
        scanAllMarkets,
        market1Symbol, market1TradeType, market1Barrier, market1PredictionDigit,
        market1ComparisonOperator, market1InputSequence, market1AnalysisTicks, market1Inverse, market1Enabled,
        market2Symbol, market2TradeType, market2Barrier, market2PredictionDigit,
        market2ComparisonOperator, market2InputSequence, market2AnalysisTicks, market2Inverse, market2Enabled
    ]);

    useEffect(() => {
        const configs: Record<string, MarketConfig> = {};

        if (scanAllMarkets) {
            if (market1Enabled) {
                AUTO_MARKET_SYMBOLS.forEach(symbol => {
                    const config = getMarketConfig(symbol);
                    if (config) configs[symbol] = config;
                });
            }
        } else {
            if (market1Enabled) {
                const config = getMarketConfig(market1Symbol);
                if (config) configs[market1Symbol] = config;
            }
            if (market2Enabled) {
                const config = getMarketConfig(market2Symbol);
                if (config) configs[market2Symbol] = config;
            }
        }

        marketConfigsRef.current = configs;
    }, [
        getMarketConfig,
        market1Symbol, market2Symbol,
        market1Enabled, market2Enabled,
        scanAllMarkets
    ]);

    // ── Save to LocalStorage ─────────────────────────────────────────────

    useEffect(() => {
        try {
            localStorage.setItem('auto_trades_market1_tradeType', market1TradeType);
            localStorage.setItem('auto_trades_market1_barrier', market1Barrier);
            localStorage.setItem('auto_trades_market1_predictionDigit', market1PredictionDigit);
            localStorage.setItem('auto_trades_market1_comparisonOperator', market1ComparisonOperator);
            localStorage.setItem('auto_trades_market1_inputSequence', market1InputSequence);
            localStorage.setItem('auto_trades_market1_analysisTicks', market1AnalysisTicks);
            localStorage.setItem('auto_trades_market1_inverse', String(market1Inverse));
            localStorage.setItem('auto_trades_market1_enabled', String(market1Enabled));

            localStorage.setItem('auto_trades_market2_tradeType', market2TradeType);
            localStorage.setItem('auto_trades_market2_barrier', market2Barrier);
            localStorage.setItem('auto_trades_market2_predictionDigit', market2PredictionDigit);
            localStorage.setItem('auto_trades_market2_comparisonOperator', market2ComparisonOperator);
            localStorage.setItem('auto_trades_market2_inputSequence', market2InputSequence);
            localStorage.setItem('auto_trades_market2_analysisTicks', market2AnalysisTicks);
            localStorage.setItem('auto_trades_market2_inverse', String(market2Inverse));
            localStorage.setItem('auto_trades_market2_enabled', String(market2Enabled));

            localStorage.setItem('auto_trades_stake', stake);
            localStorage.setItem('auto_trades_martingaleEnabled', String(martingaleEnabled));
            localStorage.setItem('auto_trades_martingaleMultiplier', String(martingaleMultiplier));
            localStorage.setItem('auto_trades_takeProfit', takeProfit);
            localStorage.setItem('auto_trades_stopLoss', stopLoss);
            localStorage.setItem('auto_trades_switchOnLoss', String(switchOnLoss));
            localStorage.setItem('auto_trades_scanAllMarkets', String(scanAllMarkets));
            localStorage.setItem('auto_trades_markets', JSON.stringify([market1Symbol, market2Symbol]));
        } catch {
            // ignore
        }
    }, [
        market1TradeType, market1Barrier, market1PredictionDigit,
        market1ComparisonOperator, market1InputSequence, market1AnalysisTicks, market1Inverse, market1Enabled,
        market2TradeType, market2Barrier, market2PredictionDigit,
        market2ComparisonOperator, market2InputSequence, market2AnalysisTicks, market2Inverse, market2Enabled,
        stake, martingaleEnabled, martingaleMultiplier, takeProfit, stopLoss,
        market1Symbol, market2Symbol, switchOnLoss, scanAllMarkets
    ]);

    // ── Core Logic Functions ─────────────────────────────────────────────

    const getActiveDigitBarrier = useCallback((symbol: string, lastResult: 'win' | 'loss' | null, consecutiveLosses = 0) => {
        const config = marketConfigsRef.current[symbol];
        if (!config) return 4;
        const ct = config.tradeType;
        if (!usesLossPrediction(ct)) return getDigitNumber(config.barrier, 4);
        return getDigitNumber(config.predictionDigit, 4);
    }, []);

    const flushDisplays = useCallback(() => {
        if (unmountedRef.current || !show_auto_ref.current) return;
        lastUiRefreshAtRef.current = Date.now();
        forceUpdateCounterRef.current++;
        setTotalPnl(prev => prev);
    }, []);

    const refreshDisplays = useCallback(() => {
        if (unmountedRef.current || !show_auto_ref.current) return;
        const elapsed = Date.now() - lastUiRefreshAtRef.current;
        if (elapsed >= UI_REFRESH_THROTTLE_MS) {
            if (uiRefreshTimerRef.current !== null) {
                window.clearTimeout(uiRefreshTimerRef.current);
                uiRefreshTimerRef.current = null;
            }
            flushDisplays();
            return;
        }
        if (uiRefreshTimerRef.current !== null) return;
        uiRefreshTimerRef.current = window.setTimeout(() => {
            uiRefreshTimerRef.current = null;
            flushDisplays();
        }, UI_REFRESH_THROTTLE_MS - elapsed);
    }, [flushDisplays]);

    const clearDataRecoveryLoading = useCallback(() => {
        if (unmountedRef.current) return;
        isRecoveringDataRef.current = false;
        setDataStreamLoading(false);
        setIsDataLoading(false);
    }, []);

    const setDataRecoveryLoading = useCallback((message: string) => {
        if (unmountedRef.current || !show_auto_ref.current) return;
        isRecoveringDataRef.current = true;
        setDataStreamMessage(message);
        setDataStreamLoading(true);
        setIsDataLoading(true);
    }, []);

    const updateSubscriptionDiagnostics = useCallback(() => {
        setDiagnosticGauge('auto_trades.subscriptions', {
            tickStreams: Object.keys(subscriptionsRef.current).length,
            candleStreams: Object.keys(candleSubscriptionsRef.current).length,
            selectedMarkets: selectedMarketsRef.current.length,
            isConnected: Object.keys(subscriptionsRef.current).length > 0,
            running: runningRef.current,
        });
    }, []);

    const clearDeferredWork = useCallback(() => {
        if (uiRefreshTimerRef.current !== null) {
            window.clearTimeout(uiRefreshTimerRef.current);
            uiRefreshTimerRef.current = null;
        }
        if (restartTimerRef.current !== null) {
            window.clearTimeout(restartTimerRef.current);
            restartTimerRef.current = null;
        }
        contractStreamAbortControllersRef.current.forEach(controller => controller.abort());
        contractStreamAbortControllersRef.current.clear();
        restartInFlightRef.current = false;
    }, []);

    const completeRunPanelStop = useCallback(() => {
        try {
            run_panel.is_contract_buying_in_progress = false;
            run_panel.setIsRunning(false);
            run_panel.setHasOpenContract?.(false);
            run_panel.setContractStage?.(contract_stages.NOT_RUNNING);
            run_panel.setShowBotStopMessage?.(false);
        } catch { }
        try {
            api_base.is_stopping = false;
            api_base.setIsRunning?.(false);
        } catch { }
    }, [run_panel]);

    const pushContract = useCallback(
        (data: any) => {
            try {
                transactions.pushTransaction({ ...data, run_id: run_panel.run_id });
                run_panel.onBotContractEvent(data);
                summary_card.onBotContractEvent(data);
            } catch { }
        },
        [run_panel, summary_card, transactions]
    );

    const stopSubscriptions = useCallback(() => {
        subscriptionVersionRef.current++;
        Object.values(subscriptionsRef.current).forEach(sub => {
            try { sub?.unsubscribe?.(); } catch { }
        });
        subscriptionsRef.current = {};
        Object.values(candleSubscriptionsRef.current).forEach(sub => {
            try { sub?.unsubscribe?.(); } catch { }
        });
        candleSubscriptionsRef.current = {};
        setIsConnected(false);
        clearDataRecoveryLoading();
        updateSubscriptionDiagnostics();
    }, [clearDataRecoveryLoading, updateSubscriptionDiagnostics]);

    // ── Execute Trade ─────────────────────────────────────────────────────

    const executeTrade = useCallback(
        async (symbol: string, stakeAmount: number, lastResult: 'win' | 'loss' | null): Promise<number> => {
            const config = marketConfigsRef.current[symbol];
            if (!config) return 0;
            const ct = config.tradeType;
            const bar = getActiveDigitBarrier(symbol, lastResult, marketStatesRef.current[symbol]?.consecutiveLosses || 0);
            const tradeStartTime = Math.floor(Date.now() / 1000);
            const verificationId = `${symbol}_${tradeStartTime}_${Math.random().toString(36).substring(2, 11)}`;
            const abortController = new AbortController();
            const params: Record<string, any> = {
                amount: stakeAmount,
                basis: 'stake',
                contract_type: ct,
                currency: currency || 'USD',
                duration: getDigitNumber(config.analysisTicks, 1),
                duration_unit: 't',
                symbol,
            };
            if (BARRIER_NEEDED[ct]) params.barrier = String(bar);
            try {
                const buy = await buyContractForUi({ parameters: params, price: stakeAmount, source: 'AutoTrades' });
                const { contract_id, buy_price, transaction_id } = buy;
                pushContract({
                    buy_price,
                    contract_id,
                    transaction_ids: { buy: transaction_id },
                    date_start: tradeStartTime,
                    display_name: symbol,
                    underlying_symbol: symbol,
                    shortcode: `AUTO_${ct}_${symbol}`,
                    contract_type: ct,
                    currency: currency || 'USD',
                    verification_id: verificationId,
                });
                contractStreamAbortControllersRef.current.add(abortController);
                const contract = await streamContractUntilSettled({
                    contractId: contract_id,
                    fallback: {
                        buy_price,
                        contract_id,
                        transaction_ids: { buy: transaction_id },
                        date_start: tradeStartTime,
                        display_name: symbol,
                        underlying_symbol: symbol,
                        shortcode: `AUTO_${ct}_${symbol}`,
                        contract_type: ct,
                        currency: currency || 'USD',
                        verification_id: verificationId,
                    },
                    onUpdate: snapshot => {
                        if (!unmountedRef.current) pushContract(snapshot);
                    },
                    signal: abortController.signal,
                    source: 'AutoTrades',
                });
                return Number(contract.profit ?? 0);
            } catch (err) {
                console.error('[AutoTrades] executeTrade exception:', err);
                setError(err instanceof Error ? err.message : 'Auto Trades could not purchase this contract.');
                return 0;
            } finally {
                contractStreamAbortControllersRef.current.delete(abortController);
            }
        },
        [currency, getActiveDigitBarrier, pushContract, setError]
    );

    // ── Get Next Market for Switching ────────────────────────────────────

    const getNextMarketForSwitch = useCallback((currentSymbol: string): string | null => {
        if (scanAllMarkets) {
            const markets = selectedMarketsRef.current;
            const currentIndex = markets.indexOf(currentSymbol);
            if (currentIndex === -1 || markets.length <= 1) return null;
            return markets[(currentIndex + 1) % markets.length];
        }
        if (market1Enabled && market2Enabled) {
            if (currentSymbol === market1Symbol) return market2Symbol;
            if (currentSymbol === market2Symbol) return market1Symbol;
        }
        return null;
    }, [scanAllMarkets, market1Symbol, market2Symbol, market1Enabled, market2Enabled]);

    const getPrimaryMarket = useCallback((): string | null => {
        if (scanAllMarkets) return selectedMarketsRef.current[0] || null;
        if (market1Enabled) return market1Symbol;
        if (market2Enabled) return market2Symbol;
        return null;
    }, [scanAllMarkets, market1Symbol, market2Symbol, market1Enabled, market2Enabled]);

    const shouldMarketTrade = useCallback((symbol: string): boolean => {
        if (!switchOnLoss || !market1Enabled || !market2Enabled || scanAllMarkets) return true;
        const activeSymbol = activeTradingMarketRef.current;
        if (!activeSymbol) {
            const primary = getPrimaryMarket();
            if (primary === symbol) {
                setActiveTradingMarket(symbol);
                activeTradingMarketRef.current = symbol;
                return true;
            }
            return false;
        }
        return activeSymbol === symbol;
    }, [switchOnLoss, market1Enabled, market2Enabled, scanAllMarkets, getPrimaryMarket]);

    // ── After Trade Handler ──────────────────────────────────────────────

    const handleAfterTrade = useCallback(
        (symbol: string, profit: number) => {
            if (!runningRef.current) return;
            const state = marketStatesRef.current[symbol];
            if (!state) return;

            // FIX: Always read from refs so we get the live configured values,
            //      not stale closure values from when the callback was created.
            const baseStake = Number(stakeRef.current) || 1;
            const mult = martingaleMultiplierRef.current || 2;
            const tp = Number(takeProfit) || 100;
            const sl = Number(stopLoss) || 100;

            const nextMartingaleState = getNextMartingaleState({
                profit,
                base_stake: baseStake,
                multiplier: mult,
                martingale_enabled: martingaleEnabledRef.current,
                consecutive_losses: state.consecutiveLosses || 0,
            });

            totalPnlRef.current = parseFloat((totalPnlRef.current + profit).toFixed(2));
            totalTradesRef.current++;

            state.consecutiveLosses = nextMartingaleState.consecutiveLosses;
            state.lastResultType = nextMartingaleState.lastResult;
            state.lastResult = nextMartingaleState.lastResult;
            // FIX: Persist the computed next stake so tryExecuteSignal picks it up
            state.currentStake = nextMartingaleState.nextStake;
            // FIX: Store base stake so we can verify/display correctly
            state.baseStake = baseStake;
            state.martingaleMultiplier = nextMartingaleState.martingaleMultiplier;
            state.lossCooldownLeft = profit < 0 ? MARKET_LOSS_COOLDOWN_TICKS : 0;
            state.tradeCount++;
            state.trading = false;
            state.isExecuting = false;
            globalTradingRef.current = false;
            currentTradingMarketRef.current = null;

            if (pendingTradePromisesRef.current[symbol]) {
                pendingTradePromisesRef.current[symbol] = null;
            }

            if (nextMartingaleState.maxLossesReached) {
                console.warn(`[AutoTrades] Maximum consecutive losses reached for ${symbol}. Stopping.`);
                runningRef.current = false;
                setIsRunning(false);
                setError(`Maximum consecutive losses (${MAX_CONSECUTIVE_LOSSES}) reached. Trading stopped.`);
                completeRunPanelStop();
                return;
            }

            lastResultRef.current[symbol] = nextMartingaleState.lastResult;

            if (switchOnLoss && market1Enabled && market2Enabled && !scanAllMarkets) {
                if (profit < 0) {
                    const nextSymbol = getNextMarketForSwitch(symbol);
                    if (nextSymbol && nextSymbol !== symbol) {
                        const nextConfig = marketConfigsRef.current[nextSymbol];
                        if (nextConfig?.enabled) {
                            marketSwitchActiveRef.current = true;
                            setActiveTradingMarket(nextSymbol);
                            activeTradingMarketRef.current = nextSymbol;
                            isPrimaryMarketActiveRef.current = false;
                        }
                    }
                } else if (profit >= 0) {
                    const primarySymbol = getPrimaryMarket();
                    if (primarySymbol && primarySymbol !== symbol) {
                        const primaryConfig = marketConfigsRef.current[primarySymbol];
                        if (primaryConfig?.enabled) {
                            setActiveTradingMarket(primarySymbol);
                            activeTradingMarketRef.current = primarySymbol;
                            isPrimaryMarketActiveRef.current = true;
                            marketSwitchActiveRef.current = false;
                        }
                    }
                }
            }

            marketStatesRef.current[symbol] = { ...state };

            if (!unmountedRef.current) {
                refreshDisplays();
                setTotalPnl(totalPnlRef.current);
                setTotalTrades(totalTradesRef.current);
            }

            if ((totalPnlRef.current >= tp || totalPnlRef.current <= -sl) && runningRef.current) {
                runningRef.current = false;
                if (!unmountedRef.current) setIsRunning(false);
                completeRunPanelStop();
            }
        },
        [completeRunPanelStop, refreshDisplays, takeProfit, stopLoss, switchOnLoss,
            getNextMarketForSwitch, getPrimaryMarket, market1Enabled, market2Enabled, scanAllMarkets]
    );

    // ── Try Execute Signal ───────────────────────────────────────────────

    const tryExecuteSignal = useCallback(
        (symbol: string, state: MarketState, signalReady: boolean) => {
            if (!shouldMarketTrade(symbol)) return;
            const config = marketConfigsRef.current[symbol];
            if (!config || !config.enabled) return;
            if (pendingTradePromisesRef.current[symbol]) return;
            if (currentTradingMarketRef.current && currentTradingMarketRef.current !== symbol) return;

            if (
                runningRef.current &&
                signalReady &&
                !state.trading &&
                !state.isExecuting &&
                !globalTradingRef.current &&
                state.lossCooldownLeft === 0 &&
                client.is_logged_in
            ) {
                state.trading = true;
                state.isExecuting = true;
                state.consecutive = 0;
                globalTradingRef.current = true;
                currentTradingMarketRef.current = symbol;
                state.tradeStartTime = Math.floor(Date.now() / 1000);
                state.verificationId = `${symbol}_${state.tradeStartTime}_${Math.random().toString(36).substring(2, 11)}`;

                // FIX: Use the persisted currentStake which was correctly set by handleAfterTrade.
                //      Fall back to stakeRef (current configured stake) only if currentStake is unset.
                const stakeNow = (state.currentStake > 0 && state.currentStake)
                    ? state.currentStake
                    : Number(stakeRef.current) || 1;

                if (stakeNow <= 0 || isNaN(stakeNow)) {
                    console.error(`[AutoTrades] Invalid stake ${stakeNow} for ${symbol}`);
                    state.trading = false;
                    state.isExecuting = false;
                    globalTradingRef.current = false;
                    currentTradingMarketRef.current = null;
                    setError('Auto Trades stopped because the stake amount is invalid.');
                    refreshDisplays();
                    return;
                }

                marketStatesRef.current[symbol] = { ...state };

                const tradePromise = executeTrade(symbol, stakeNow, state.lastResultType);
                pendingTradePromisesRef.current[symbol] = tradePromise;

                tradePromise
                    .then(profit => {
                        if (runningRef.current && !unmountedRef.current) {
                            handleAfterTrade(symbol, profit);
                        } else {
                            const s = marketStatesRef.current[symbol];
                            if (s) {
                                s.trading = false;
                                s.isExecuting = false;
                                globalTradingRef.current = false;
                                currentTradingMarketRef.current = null;
                                pendingTradePromisesRef.current[symbol] = null;
                                marketStatesRef.current[symbol] = { ...s };
                            }
                        }
                    })
                    .catch(err => {
                        console.error(`[AutoTrades] Trade failed for ${symbol}:`, err);
                        const s = marketStatesRef.current[symbol];
                        if (s) {
                            s.trading = false;
                            s.isExecuting = false;
                            globalTradingRef.current = false;
                            currentTradingMarketRef.current = null;
                            pendingTradePromisesRef.current[symbol] = null;
                            marketStatesRef.current[symbol] = { ...s };
                            refreshDisplays();
                        }
                    });
            }
        },
        [client.is_logged_in, executeTrade, handleAfterTrade, refreshDisplays, shouldMarketTrade]
    );

    // ── Tick Handler ─────────────────────────────────────────────────────

    const handleTick = useCallback(
        (symbol: string, tick: any) => {
            const config = marketConfigsRef.current[symbol];
            if (!config || !config.enabled) return;
            const state = marketStatesRef.current[symbol];
            if (!state) return;

            const pip = getMarketPipSize(symbol, AUTO_MARKET_LOOKUP.get(symbol)?.pip ?? 2);
            const quote = tick.quote as number;
            const ct = config.tradeType;
            const targetLen = Math.min(MAX_STREAK_LENGTH, Math.max(1, getDigitNumber(config.analysisTicks, 1)));

            state.lastQuote = quote;
            state.lastPrice = quote;
            state.priceHistory = [...state.priceHistory.slice(-50), quote];
            state.isRecovering = false;
            lastTickAtRef.current = Date.now();
            if (isRecoveringDataRef.current) clearDataRecoveryLoading();

            if (state.lossCooldownLeft > 0) {
                state.lossCooldownLeft = Math.max(0, state.lossCooldownLeft - 1);
            }

            const inv = config.inverseMode || false;
            const bar = getActiveDigitBarrier(symbol, state.lastResultType, state.consecutiveLosses || 0);

            if (IS_DIRECTION_TYPE[ct]) {
                const prev = state.prevQuote;
                const dir: Direction = prev === null ? 0 : quote > prev ? 1 : quote < prev ? -1 : 0;
                state.directionHistory = [...state.directionHistory.slice(-9), dir];
                state.prevQuote = quote;
                if (dir !== 0) {
                    const match = isDirectionMatch(ct, dir);
                    if (inv ? !match : match) {
                        state.consecutive = Math.min(state.consecutive + 1, MAX_STREAK_LENGTH);
                    } else {
                        state.consecutive = 0;
                    }
                }
            } else {
                const lastDigit = getLastDigitFromQuote(quote, symbol, pip);
                state.lastDigits = [...state.lastDigits.slice(-MAX_STREAK_LENGTH), lastDigit];
                state.prevQuote = quote;

                let match = false;
                if (ct === 'DIGITOVER' || ct === 'DIGITUNDER') {
                    const operator = config.comparisonOperator;
                    const tickCount = Math.max(1, getDigitNumber(config.analysisTicks, 1));
                    match = checkTickPattern(state.lastDigits, tickCount, operator, bar);
                } else if (ct === 'DIGITEVEN' || ct === 'DIGITODD') {
                    if (config.inputSequence && config.inputSequence.length > 0) {
                        const eoPattern = parseEOPattern(config.inputSequence);
                        if (eoPattern.length > 0) {
                            match = checkEOPattern(state.lastDigits, eoPattern);
                        } else {
                            match = isDigitSignalMatch({ trade_type: ct, digit: lastDigit, barrier: bar, inverse: inv });
                        }
                    } else {
                        match = isDigitSignalMatch({ trade_type: ct, digit: lastDigit, barrier: bar, inverse: inv });
                    }
                } else {
                    match = isDigitSignalMatch({ trade_type: ct, digit: lastDigit, barrier: bar, inverse: inv });
                }

                if (match) {
                    state.consecutive = Math.min(state.consecutive + 1, MAX_STREAK_LENGTH);
                } else {
                    state.consecutive = 0;
                }
            }

            const candleMatch = isCandleConfirmedTradeType(ct)
                ? isCandleMatch(ct, state.candleDirection)
                : true;

            const signalReady = state.consecutive >= targetLen && candleMatch;

            const mkt = AUTO_MARKET_LOOKUP.get(symbol);
            const label = TRADE_TYPE_LABELS[ct];
            const invLabel = inv ? 'Inverse ' : '';
            let condStr = '';
            let digitsStr = '';

            if (IS_DIRECTION_TYPE[ct]) {
                const dirs = state.directionHistory.slice(-targetLen);
                digitsStr = `[${dirs.map(d => (d === 1 ? '↑' : d === -1 ? '↓' : '—')).join(', ')}]`;
                condStr = `${invLabel}${label} ${targetLen}+ ticks`;
            } else {
                const recent = state.lastDigits.slice(-targetLen);
                digitsStr = `[${recent.join(', ')}]`;
                if (ct === 'DIGITOVER' || ct === 'DIGITUNDER') {
                    condStr = `${invLabel}Last ${targetLen} ticks ${getComparisonOperatorLabel(config.comparisonOperator)} ${bar}`;
                } else if ((ct === 'DIGITEVEN' || ct === 'DIGITODD') && config.inputSequence) {
                    condStr = `${invLabel}Pattern: ${config.inputSequence}`;
                } else {
                    condStr = `${invLabel}${label} ${bar}`;
                }
            }

            conditionNotifierStore.setCondition({
                market: mkt?.label ?? symbol,
                condition: condStr,
                digits: digitsStr,
                result: signalReady,
                source: 'auto',
                timestamp: Date.now(),
            });

            refreshDisplays();
            tryExecuteSignal(symbol, state, signalReady);
        },
        [clearDataRecoveryLoading, getActiveDigitBarrier, refreshDisplays, tryExecuteSignal]
    );

    handleTickRef.current = handleTick;

    // ── Candle Handler ────────────────────────────────────────────────────

    const handleCandle = useCallback(
        (symbol: string, candle: any) => {
            const config = marketConfigsRef.current[symbol];
            if (!config || !config.enabled) return;
            const state = marketStatesRef.current[symbol];
            if (!state) return;
            const open = Number(candle?.open);
            const close = Number(candle?.close);
            if (!Number.isFinite(open) || !Number.isFinite(close)) return;
            state.candleOpen = open;
            state.candleClose = close;
            state.candleDirection = close > open ? 1 : close < open ? -1 : 0;
            const ct = config.tradeType;
            const inv = config.inverseMode || false;
            const targetLen = Math.min(MAX_STREAK_LENGTH, Math.max(1, getDigitNumber(config.analysisTicks, 1)));
            const signalReady =
                isCandleConfirmedTradeType(ct) &&
                state.consecutive >= targetLen &&
                isCandleMatch(ct, state.candleDirection);
            tryExecuteSignal(symbol, state, signalReady);
            refreshDisplays();
        },
        [refreshDisplays, tryExecuteSignal]
    );

    handleCandleRef.current = handleCandle;

    // ── Start Subscriptions ──────────────────────────────────────────────

    const startSubscriptions = useCallback(async () => {
        const subscriptionVersion = subscriptionVersionRef.current;
        let marketsToMonitor: string[] = [];

        if (scanAllMarkets) {
            if (market1Enabled) marketsToMonitor = AUTO_MARKET_SYMBOLS;
        } else {
            if (market1Enabled) marketsToMonitor.push(market1Symbol);
            if (market2Enabled) marketsToMonitor.push(market2Symbol);
        }

        const monitoredSymbolSet = new Set(marketsToMonitor);

        Object.entries(subscriptionsRef.current).forEach(([symbol, sub]) => {
            if (!monitoredSymbolSet.has(symbol)) {
                try { sub?.unsubscribe?.(); } catch { }
                delete subscriptionsRef.current[symbol];
                updateSubscriptionDiagnostics();
            }
        });

        Object.entries(candleSubscriptionsRef.current).forEach(([symbol, sub]) => {
            if (!monitoredSymbolSet.has(symbol)) {
                try { sub?.unsubscribe?.(); } catch { }
                delete candleSubscriptionsRef.current[symbol];
                updateSubscriptionDiagnostics();
            }
        });

        if (marketsToMonitor.length === 0) {
            setIsConnected(false);
            clearDataRecoveryLoading();
            return;
        }

        lastTickAtRef.current = Date.now();
        setDataRecoveryLoading('Loading market data...');

        for (const symbol of marketsToMonitor) {
            const market = AUTO_MARKET_LOOKUP.get(symbol);
            if (!market) continue;

            if (!marketStatesRef.current[symbol]) {
                marketStatesRef.current[symbol] = createMarketState({
                    // FIX: Initialize currentStake from the current configured stake ref
                    currentStake: Number(stakeRef.current) || 1,
                    baseStake: Number(stakeRef.current) || 1,
                    isExecuting: false,
                    lastPrice: null,
                    priceHistory: [],
                });
            }

            if (!subscriptionsRef.current[symbol]) {
                try {
                    const obs = (api_base.api as any).subscribe({ ticks: symbol });
                    const sub = safeSubscribe(
                        obs,
                        (data: any) => {
                            if (subscriptionVersion !== subscriptionVersionRef.current) return;
                            if (!show_auto_ref.current || unmountedRef.current) return;
                            if (data?.error) {
                                if (!isExpectedStreamInterruption(data.error)) {
                                    console.warn(`[AutoTrades] Tick stream error for ${symbol}:`, data.error);
                                }
                                return;
                            }
                            if (data?.tick?.quote !== undefined) handleTickRef.current(symbol, data.tick);
                        },
                        (streamError: unknown) => {
                            if (subscriptionVersion !== subscriptionVersionRef.current) return;
                            if (!show_auto_ref.current || unmountedRef.current) return;
                            if (!isExpectedStreamInterruption(streamError)) {
                                console.warn(`[AutoTrades] Tick stream error for ${symbol}:`, streamError);
                            }
                        }
                    );
                    subscriptionsRef.current[symbol] = sub;
                    updateSubscriptionDiagnostics();
                } catch (err) {
                    if (!isExpectedStreamInterruption(err)) {
                        console.error(`[AutoTrades] Subscribe failed for ${symbol}:`, err);
                    }
                }
            }

            if (!candleSubscriptionsRef.current[symbol]) {
                try {
                    const obs = (api_base.api as any).subscribe({
                        ticks_history: symbol,
                        end: 'latest',
                        count: 2,
                        granularity: FIVE_MINUTE_GRANULARITY,
                        style: 'candles',
                        subscribe: 1,
                    });
                    const sub = safeSubscribe(
                        obs,
                        (data: any) => {
                            if (subscriptionVersion !== subscriptionVersionRef.current) return;
                            if (!show_auto_ref.current || unmountedRef.current) return;
                            if (data?.error) {
                                if (!isExpectedStreamInterruption(data.error)) {
                                    console.warn(`[AutoTrades] Candle stream error for ${symbol}:`, data.error);
                                }
                                return;
                            }
                            const candle =
                                data?.ohlc ??
                                (Array.isArray(data?.candles) ? data.candles[data.candles.length - 1] : null);
                            if (candle) handleCandleRef.current(symbol, candle);
                        },
                        (streamError: unknown) => {
                            if (subscriptionVersion !== subscriptionVersionRef.current) return;
                            if (!show_auto_ref.current || unmountedRef.current) return;
                            if (!isExpectedStreamInterruption(streamError)) {
                                console.warn(`[AutoTrades] Candle stream error for ${symbol}:`, streamError);
                            }
                        }
                    );
                    candleSubscriptionsRef.current[symbol] = sub;
                    updateSubscriptionDiagnostics();
                } catch (err) {
                    if (!isExpectedStreamInterruption(err)) {
                        console.error(`[AutoTrades] 5m candle subscribe failed for ${symbol}:`, err);
                    }
                }
            }
        }
        setIsConnected(Object.keys(subscriptionsRef.current).length > 0);
        setIsDataLoading(false);
        setDataStreamLoading(false);
        updateSubscriptionDiagnostics();
    }, [
        clearDataRecoveryLoading,
        setDataRecoveryLoading,
        updateSubscriptionDiagnostics,
        market1Symbol,
        market2Symbol,
        market1Enabled,
        market2Enabled,
        scanAllMarkets,
    ]);

    // ── Restart Subscriptions ────────────────────────────────────────────

    const restartSubscriptions = useCallback(() => {
        const now = Date.now();
        if (restartInFlightRef.current) return;
        if (now - lastRestartAttemptAtRef.current < DATA_RESTART_COOLDOWN_MS) return;
        restartInFlightRef.current = true;
        lastRestartAttemptAtRef.current = now;
        recordDiagnosticEvent('auto_trades.stream_restart', {
            selectedMarkets: selectedMarketsRef.current.length,
            silentForMs: now - lastTickAtRef.current,
        });
        stopSubscriptions();
        setDataRecoveryLoading('Market data paused. Reconnecting streams...');
        restartTimerRef.current = window.setTimeout(() => {
            restartTimerRef.current = null;
            if (!show_auto_ref.current || unmountedRef.current) {
                restartInFlightRef.current = false;
                return;
            }
            startSubscriptions()
                .catch(err => console.error('[AutoTrades] Data restart failed:', err))
                .finally(() => {
                    restartInFlightRef.current = false;
                    lastTickAtRef.current = Date.now();
                });
        }, 800);
    }, [setDataRecoveryLoading, startSubscriptions, stopSubscriptions]);

    // ── Session Management ───────────────────────────────────────────────

    const resetSession = useCallback(() => {
        const baseStake = Number(stakeRef.current) || 1;
        globalTradingRef.current = false;
        currentTradingMarketRef.current = null;

        AUTO_MARKET_SYMBOLS.forEach(symbol => {
            marketStatesRef.current[symbol] = createMarketState({
                currentStake: baseStake,
                baseStake: baseStake,
                martingaleMultiplier: 1,
                consecutiveLosses: 0,
                lastResultType: null,
                lastResult: null,
                isExecuting: false,
                lastPrice: null,
                priceHistory: [],
            });
        });

        pendingTradePromisesRef.current = {};
        totalPnlRef.current = 0;
        totalTradesRef.current = 0;
        setTotalPnl(0);
        setTotalTrades(0);
        setError(null);

        if (switchOnLoss && market1Enabled && market2Enabled && !scanAllMarkets) {
            const primary = market1Enabled ? market1Symbol : market2Symbol;
            setActiveTradingMarket(primary);
            activeTradingMarketRef.current = primary;
            isPrimaryMarketActiveRef.current = true;
            marketSwitchActiveRef.current = false;
        } else {
            setActiveTradingMarket(null);
            activeTradingMarketRef.current = null;
            marketSwitchActiveRef.current = false;
            isPrimaryMarketActiveRef.current = true;
        }
        lastResultRef.current = {};
        refreshDisplays();
    }, [refreshDisplays, switchOnLoss, market1Enabled, market2Enabled, scanAllMarkets, market1Symbol, market2Symbol]);

    // ── Run/Stop ─────────────────────────────────────────────────────────

    const handleRun = useCallback(() => {
        if (!api_base.is_authorized) {
            setError('Please log in to your Deriv account before trading.');
            return;
        }
        setError(null);
        resetSession();
        try {
            run_panel.setIsRunning(true);
            run_panel.setRunId(`run-${Date.now()}`);
            run_panel.setContractStage?.(contract_stages.RUNNING);
            run_panel.toggleDrawer(true);
        } catch { }
        dashboard.setActiveTradingModule('auto_trades');
        runningRef.current = true;
        setIsRunning(true);
    }, [dashboard, resetSession, run_panel]);

    const stopTrading = useCallback(() => {
        runningRef.current = false;
        globalTradingRef.current = false;
        currentTradingMarketRef.current = null;
        clearDeferredWork();

        Object.keys(pendingTradePromisesRef.current).forEach(key => {
            pendingTradePromisesRef.current[key] = null;
        });

        Object.values(marketStatesRef.current).forEach(state => {
            state.trading = false;
            state.isExecuting = false;
            state.consecutive = 0;
            state.tradeStartTime = null;
            state.verificationId = null;
            state.lossCooldownLeft = 0;
        });
        setIsRunning(false);
        clearDataRecoveryLoading();
        dashboard.setActiveTradingModule(null);
        recordDiagnosticEvent('auto_trades.stop_trading', {
            selectedMarkets: selectedMarketsRef.current.length,
            tickStreams: Object.keys(subscriptionsRef.current).length,
            candleStreams: Object.keys(candleSubscriptionsRef.current).length,
        });
        updateSubscriptionDiagnostics();
        completeRunPanelStop();
        refreshDisplays();
    }, [
        clearDataRecoveryLoading,
        clearDeferredWork,
        completeRunPanelStop,
        dashboard,
        refreshDisplays,
        updateSubscriptionDiagnostics,
    ]);

    stopTradingRef.current = stopTrading;
    const handleStop = useCallback(() => stopTrading(), [stopTrading]);

    // ── Effects ──────────────────────────────────────────────────────────

    useEffect(() => {
        if (show_auto && api_base.api) startSubscriptions();
        return () => {
            if (!show_auto) stopSubscriptions();
        };
    }, [show_auto, startSubscriptions, stopSubscriptions, market1Symbol, market2Symbol, market1Enabled, market2Enabled, scanAllMarkets]);

    useEffect(() => {
        if (!show_auto) return undefined;
        const intervalId = window.setInterval(() => {
            if (!show_auto_ref.current || unmountedRef.current) return;
            const has_selected_markets = selectedMarketsRef.current.length > 0;
            const silent_for = Date.now() - lastTickAtRef.current;
            if (has_selected_markets && silent_for > DATA_SILENCE_RESTART_MS && !restartInFlightRef.current) {
                restartSubscriptions();
            }
        }, 5000);
        return () => window.clearInterval(intervalId);
    }, [restartSubscriptions, show_auto]);

    useEffect(() => {
        unmountedRef.current = false;
        return () => {
            unmountedRef.current = true;
            clearDeferredWork();
            subscriptionVersionRef.current++;
            runningRef.current = false;
            stopTrading();
            try {
                run_panel.setIsRunning(false);
                run_panel.setHasOpenContract(false);
            } catch { }
            stopSubscriptions();
            Object.values(marketStatesRef.current).forEach(state => {
                state.directionHistory = [];
                state.lastDigits = [];
                state.priceHistory = [];
            });
        };
    }, [clearDeferredWork, run_panel, stopTrading, stopSubscriptions]);

    useEffect(() => {
        if (!show_auto) return undefined;
        dashboard.registerTradingStopHandler('auto_trades', stopTrading);
        globalObserver.register('bot.running', run_panel.onBotRunningEvent);
        globalObserver.register('contract.status', run_panel.onContractStatusEvent);
        globalObserver.register('Error', run_panel.onError);
        globalObserver.register('bot.setPurchaseInProgress', run_panel.SetpurchaseInProgress);
        globalObserver.register('bot.manual_stop', stopTrading);
        return () => {
            dashboard.unregisterTradingStopHandler('auto_trades');
            globalObserver.unregister('bot.running', run_panel.onBotRunningEvent);
            globalObserver.unregister('contract.status', run_panel.onContractStatusEvent);
            globalObserver.unregister('Error', run_panel.onError);
            globalObserver.unregister('bot.setPurchaseInProgress', run_panel.SetpurchaseInProgress);
            globalObserver.unregister('bot.manual_stop', stopTrading);
        };
    }, [dashboard, run_panel, show_auto, stopTrading]);

    // ── Compute Market Displays ──────────────────────────────────────────

    const marketDisplays = useMemo((): MarketDisplay[] => {
        const displaySymbols: string[] = [];
        if (scanAllMarkets) {
            if (market1Enabled) displaySymbols.push(...AUTO_MARKET_SYMBOLS);
        } else {
            if (market1Enabled) displaySymbols.push(market1Symbol);
            if (market2Enabled) displaySymbols.push(market2Symbol);
        }
        return displaySymbols.map(symbol => {
            const market = AUTO_MARKET_LOOKUP.get(symbol);
            const state = marketStatesRef.current[symbol] || createMarketState();
            return {
                symbol,
                label: market?.label || symbol,
                pip: market?.pip || 2,
                ...state,
                // FIX: Ensure currentStake always reflects configured stake if not yet set by martingale
                currentStake: state.currentStake > 0 ? state.currentStake : Number(stake) || 1,
            };
        });
    }, [market1Symbol, market2Symbol, market1Enabled, market2Enabled, scanAllMarkets, stake]);

    // ── Analysis Data ─────────────────────────────────────────────────────

    const getMarketAnalysis = useCallback((symbol: string, config: MarketConfig | null) => {
        const state = marketStatesRef.current[symbol];
        if (!state || !config) return null;

        const targetLen = Math.min(MAX_STREAK_LENGTH, Math.max(1, getDigitNumber(config.analysisTicks, 1)));
        const recentDigits = state.lastDigits.slice(-targetLen);
        const ct = config.tradeType;
        const inv = config.inverseMode;
        const bar = getDigitNumber(config.barrier, 4);

        let allMatch = false;
        let tickResults: boolean[] = [];
        let conditionText = '';

        if (ct === 'DIGITOVER' || ct === 'DIGITUNDER') {
            const operator = config.comparisonOperator;
            tickResults = recentDigits.map(d => checkComparison(d, operator, bar));
            allMatch = recentDigits.length >= targetLen && tickResults.every(Boolean);
            conditionText = `Last ${targetLen} ticks ${getComparisonOperatorLabel(operator)} ${bar}`;
        } else if (ct === 'DIGITEVEN' || ct === 'DIGITODD') {
            if (config.inputSequence && config.inputSequence.length > 0) {
                const eoPattern = parseEOPattern(config.inputSequence);
                tickResults = recentDigits.map((d, i) => {
                    if (i >= eoPattern.length) return false;
                    return eoPattern[i] === 'E' ? d % 2 === 0 : d % 2 !== 0;
                });
                allMatch = recentDigits.length >= eoPattern.length && checkEOPattern(state.lastDigits, eoPattern);
                conditionText = `Pattern: ${config.inputSequence}`;
            } else {
                tickResults = recentDigits.map(d => isDigitSignalMatch({ trade_type: ct, digit: d, barrier: bar, inverse: inv }));
                allMatch = recentDigits.length >= targetLen && tickResults.every(Boolean);
                conditionText = `${TRADE_TYPE_LABELS[ct]}: ${bar}`;
            }
        } else {
            tickResults = recentDigits.map(d => isDigitSignalMatch({ trade_type: ct, digit: d, barrier: bar, inverse: inv }));
            allMatch = recentDigits.length >= targetLen && tickResults.every(Boolean);
            conditionText = `${TRADE_TYPE_LABELS[ct]}: ${bar}`;
        }

        return {
            allMatch,
            tickResults,
            recentDigits,
            targetLen,
            conditionText,
            signalReady: state.consecutive >= targetLen,
            currentPrice: state.lastPrice,
            priceHistory: state.priceHistory.slice(-10),
        };
    }, []);

    // ── Render Analysis ───────────────────────────────────────────────────

    const renderAnalysisContainer = (symbol: string, config: MarketConfig | null) => {
        if (!config) return null;
        const analysis = getMarketAnalysis(symbol, config);
        if (!analysis) return null;

        const state = marketStatesRef.current[symbol];
        const isSignalReady = analysis.signalReady;
        const isPatternMatch = analysis.allMatch;

        const formatPrice = (price: number | null) => {
            if (price === null) return '—';
            const pip = AUTO_MARKET_LOOKUP.get(symbol)?.pip || 2;
            return price.toFixed(pip);
        };

        return (
            <div className={classNames('at-analysis', {
                'at-analysis--ready': isSignalReady,
                'at-analysis--match': isPatternMatch && !isSignalReady,
            })}>
                <div className='at-analysis__header'>
                    <div className='at-analysis__header-left'>
                        <div className={classNames('at-analysis__signal-dot', {
                            'at-analysis__signal-dot--ready': isSignalReady,
                            'at-analysis__signal-dot--match': isPatternMatch && !isSignalReady,
                        })} />
                        <span className='at-analysis__label'>Pattern Analysis</span>
                    </div>
                    <span className={classNames('at-analysis__badge', {
                        'at-analysis__badge--ready': isSignalReady,
                        'at-analysis__badge--match': isPatternMatch && !isSignalReady,
                        'at-analysis__badge--waiting': !isPatternMatch,
                    })}>
                        {isSignalReady ? 'Signal Ready' : isPatternMatch ? 'Pattern Matched' : 'Scanning'}
                    </span>
                </div>

                <div className='at-analysis__price-row'>
                    <span className='at-analysis__price'>{formatPrice(analysis.currentPrice)}</span>
                    {analysis.priceHistory.length > 1 && (
                        <div className='at-analysis__sparkline'>
                            {analysis.priceHistory.map((price, idx) => {
                                const min = Math.min(...analysis.priceHistory);
                                const max = Math.max(...analysis.priceHistory);
                                const range = max - min || 1;
                                const h = ((price - min) / range) * 20 + 4;
                                const isLast = idx === analysis.priceHistory.length - 1;
                                return (
                                    <div
                                        key={idx}
                                        className={classNames('at-analysis__spark-bar', { 'at-analysis__spark-bar--last': isLast })}
                                        style={{ height: `${h}px` }}
                                    />
                                );
                            })}
                        </div>
                    )}
                </div>

                <div className='at-analysis__condition'>{analysis.conditionText}</div>

                <div className='at-analysis__ticks'>
                    {analysis.recentDigits.map((digit, idx) => (
                        <span
                            key={idx}
                            className={classNames('at-analysis__tick', {
                                'at-analysis__tick--match': analysis.tickResults[idx],
                                'at-analysis__tick--miss': !analysis.tickResults[idx] && analysis.recentDigits.length >= analysis.targetLen,
                            })}
                        >
                            {digit}
                        </span>
                    ))}
                    {analysis.recentDigits.length < analysis.targetLen &&
                        Array.from({ length: analysis.targetLen - analysis.recentDigits.length }).map((_, i) => (
                            <span key={`empty-${i}`} className='at-analysis__tick at-analysis__tick--empty'>·</span>
                        ))
                    }
                </div>

                {isSignalReady && (
                    <div className='at-analysis__ready-msg'>
                        Signal confirmed — executing on next tick
                    </div>
                )}
            </div>
        );
    };

    // ── Render Helpers ────────────────────────────────────────────────────

    if (!show_auto) return null;

    const pnlPositive = totalPnl > 0;
    const pnlNegative = totalPnl < 0;
    const baseStakeNum = Number(stake) || 1;
    const martingaleActive = martingaleEnabled && marketDisplays.some(m => m.currentStake > baseStakeNum);
    const inCooldown = marketDisplays.some(m => m.lossCooldownLeft > 0);
    const hasAnyLiveQuote = marketDisplays.some(m => m.lastQuote !== null);
    const isLoading = selectedMarketsRef.current.length > 0 && !hasAnyLiveQuote && (dataStreamLoading || !isConnected);
    const hasEnabledMarkets = market1Enabled || market2Enabled || scanAllMarkets;

    const getActiveMarketDisplay = () => {
        const activeSymbol = activeTradingMarketRef.current;
        if (!activeSymbol) return 'None';
        return AUTO_MARKET_LOOKUP.get(activeSymbol)?.label || activeSymbol;
    };

    const market1Config = marketConfigsRef.current[market1Symbol] || null;
    const market2Config = marketConfigsRef.current[market2Symbol] || null;

    const renderMarketCard = (
        slot: 1 | 2,
        symbol: string,
        enabled: boolean,
        setEnabled: (v: boolean) => void,
        tradeType: TradeType,
        setTradeType: (v: TradeType) => void,
        barrier: string,
        setBarrier: (v: string) => void,
        predictionDigit: string,
        setPredictionDigit: (v: string) => void,
        comparisonOperator: ComparisonOperator,
        setComparisonOperator: (v: ComparisonOperator) => void,
        inputSequence: string,
        setInputSequence: (v: string) => void,
        analysisTicks: string,
        setAnalysisTicks: (v: string) => void,
        inverse: boolean,
        setInverse: (v: boolean) => void,
        config: MarketConfig | null,
        setSymbol: (v: string) => void
    ) => {
        const display = marketDisplays.find(m => m.symbol === symbol);
        const isActive = switchOnLoss && activeTradingMarketRef.current === symbol && isRunning;
        const isM1 = slot === 1;

        return (
            <div className={classNames('at-market-card', {
                'at-market-card--disabled': !enabled,
                'at-market-card--active': isActive,
                'at-market-card--m1': isM1,
                'at-market-card--m2': !isM1,
            })}>
                {/* Card header */}
                <div className='at-market-card__header'>
                    <div className='at-market-card__title-row'>
                        <div className={classNames('at-market-card__slot-tag', { 'at-market-card__slot-tag--m2': !isM1 })}>
                            {isM1 ? 'M1' : 'M2'}
                        </div>
                        <span className='at-market-card__title'>{isM1 ? 'Primary Market' : 'Secondary Market'}</span>
                        {isActive && <span className='at-market-card__active-pill'>LIVE</span>}
                    </div>
                    <button
                        type='button'
                        className={classNames('at-toggle', { 'at-toggle--on': enabled })}
                        onClick={() => setEnabled(!enabled)}
                        disabled={isRunning}
                    >
                        <span className='at-toggle__track'>
                            <span className='at-toggle__thumb' />
                        </span>
                        <span className='at-toggle__label'>{enabled ? 'ON' : 'OFF'}</span>
                    </button>
                </div>

                {enabled && (
                    <>
                        {/* Live quote strip */}
                        {display && (
                            <div className='at-market-card__quote-strip'>
                                <span className='at-market-card__quote'>
                                    {display.lastQuote !== null
                                        ? display.lastQuote.toFixed(display.pip)
                                        : '—'}
                                </span>
                                <div className='at-market-card__quote-meta'>
                                    <span className='at-market-card__streak'>
                                        Streak <strong>{display.consecutive}</strong>
                                    </span>
                                    <span className={classNames('at-market-card__stake-badge', {
                                        'at-market-card__stake-badge--elevated': display.currentStake > baseStakeNum,
                                    })}>
                                        {display.currentStake.toFixed(2)} {currency || 'USD'}
                                        {martingaleEnabled && display.currentStake > baseStakeNum && (
                                            <span className='at-market-card__mult'>
                                                ×{display.martingaleMultiplier.toFixed(1)}
                                            </span>
                                        )}
                                    </span>
                                    {display.lastResult && (
                                        <span className={classNames('at-market-card__result', {
                                            'at-market-card__result--win': display.lastResult === 'win',
                                            'at-market-card__result--loss': display.lastResult === 'loss',
                                        })}>
                                            {display.lastResult === 'win' ? '↑ Win' : '↓ Loss'}
                                        </span>
                                    )}
                                    <span className='at-market-card__candle'>
                                        {getCandleDirectionLabel(display.candleDirection)}
                                    </span>
                                </div>
                                {display.lastDigits.length > 0 && (
                                    <div className='at-market-card__digits'>
                                        {display.lastDigits.slice(-5).map((d, idx) => (
                                            <span key={idx} className='at-market-card__digit'>{d}</span>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Config fields */}
                        <div className='at-market-card__config'>
                            <div className='at-field'>
                                <label className='at-field__label'>Market</label>
                                <select
                                    className='at-field__select'
                                    value={symbol}
                                    onChange={e => setSymbol(e.target.value)}
                                    disabled={isRunning || scanAllMarkets}
                                >
                                    {AUTO_MARKETS.map(m => (
                                        <option key={m.symbol} value={m.symbol}>{m.label}</option>
                                    ))}
                                </select>
                            </div>

                            <div className='at-field'>
                                <label className='at-field__label'>Contract Type</label>
                                <select
                                    className='at-field__select'
                                    value={tradeType}
                                    onChange={e => setTradeType(e.target.value as TradeType)}
                                    disabled={isRunning}
                                >
                                    <optgroup label='Digit'>
                                        <option value='DIGITOVER'>Over</option>
                                        <option value='DIGITUNDER'>Under</option>
                                        <option value='DIGITEVEN'>Even</option>
                                        <option value='DIGITODD'>Odd</option>
                                        <option value='DIGITMATCH'>Matches</option>
                                        <option value='DIGITDIFF'>Differs</option>
                                    </optgroup>
                                    <optgroup label='Direction'>
                                        <option value='CALL'>Rise</option>
                                        <option value='PUT'>Fall</option>
                                        <option value='RUNHIGH'>Only Ups</option>
                                        <option value='RUNLOW'>Only Downs</option>
                                    </optgroup>
                                </select>
                            </div>

                            {(tradeType === 'DIGITOVER' || tradeType === 'DIGITUNDER') && (<>
                                <div className='at-field'>
                                    <label className='at-field__label'>Last N Ticks</label>
                                    <select
                                        className='at-field__select'
                                        value={analysisTicks}
                                        onChange={e => setAnalysisTicks(e.target.value)}
                                        disabled={isRunning}
                                    >
                                        {Array.from({ length: MAX_ANALYSIS_TICKS }, (_, i) => i + 1).map(d => (
                                            <option key={d} value={String(d)}>{d}</option>
                                        ))}
                                    </select>
                                </div>
                                <div className='at-field'>
                                    <label className='at-field__label'>Operator</label>
                                    <select
                                        className='at-field__select'
                                        value={comparisonOperator}
                                        onChange={e => setComparisonOperator(e.target.value as ComparisonOperator)}
                                        disabled={isRunning}
                                    >
                                        <option value='>'>Greater than (&gt;)</option>
                                        <option value='<'>Less than (&lt;)</option>
                                        <option value='>='>Greater than or equal (&gt;=)</option>
                                        <option value='<='>Less than or equal (&lt;=)</option>
                                        <option value='=='>Equal to (==)</option>
                                    </select>
                                </div>
                                <div className='at-field'>
                                    <label className='at-field__label'>Compare Digit</label>
                                    <select
                                        className='at-field__select'
                                        value={barrier}
                                        onChange={e => setBarrier(e.target.value)}
                                        disabled={isRunning}
                                    >
                                        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => (
                                            <option key={d} value={String(d)}>{d}</option>
                                        ))}
                                    </select>
                                </div>
                                {usesLossPrediction(tradeType) && (
                                    <div className='at-field'>
                                        <label className='at-field__label'>Predict Digit</label>
                                        <select
                                            className='at-field__select'
                                            value={predictionDigit}
                                            onChange={e => setPredictionDigit(e.target.value)}
                                            disabled={isRunning}
                                        >
                                            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => (
                                                <option key={d} value={String(d)}>{d}</option>
                                            ))}
                                        </select>
                                    </div>
                                )}
                            </>)}

                            {(tradeType === 'DIGITEVEN' || tradeType === 'DIGITODD') && (
                                <div className='at-field at-field--full'>
                                    <label className='at-field__label'>E/O Pattern</label>
                                    <Input
                                        type='text'
                                        placeholder='e.g. EEO or OEE'
                                        value={inputSequence}
                                        onChange={e => setInputSequence(e.target.value.toUpperCase().replace(/[^EO]/g, ''))}
                                        disabled={isRunning}
                                    />
                                    {inputSequence && (
                                        <div className='at-eo-preview'>
                                            {inputSequence.split('').map((ch, i) => (
                                                <span key={i} className={classNames('at-eo-preview__chip', {
                                                    'at-eo-preview__chip--e': ch === 'E',
                                                    'at-eo-preview__chip--o': ch === 'O',
                                                })}>
                                                    {ch === 'E' ? 'Even' : 'Odd'}
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}

                            {(tradeType === 'DIGITMATCH' || tradeType === 'DIGITDIFF') && (<>
                                <div className='at-field'>
                                    <label className='at-field__label'>Digit</label>
                                    <select
                                        className='at-field__select'
                                        value={barrier}
                                        onChange={e => setBarrier(e.target.value)}
                                        disabled={isRunning}
                                    >
                                        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => (
                                            <option key={d} value={String(d)}>{d}</option>
                                        ))}
                                    </select>
                                </div>
                                <div className='at-field'>
                                    <label className='at-field__label'>Analysis Ticks</label>
                                    <select
                                        className='at-field__select'
                                        value={analysisTicks}
                                        onChange={e => setAnalysisTicks(e.target.value)}
                                        disabled={isRunning}
                                    >
                                        {Array.from({ length: MAX_ANALYSIS_TICKS }, (_, i) => i + 1).map(d => (
                                            <option key={d} value={String(d)}>{d}</option>
                                        ))}
                                    </select>
                                </div>
                            </>)}

                            <div className='at-field at-field--inline'>
                                <label className='at-field__label'>Inverse Mode</label>
                                <button
                                    type='button'
                                    className={classNames('at-toggle at-toggle--sm', { 'at-toggle--on': inverse })}
                                    onClick={() => setInverse(!inverse)}
                                    disabled={isRunning}
                                >
                                    <span className='at-toggle__track'>
                                        <span className='at-toggle__thumb' />
                                    </span>
                                    <span className='at-toggle__label'>{inverse ? 'Inverse' : 'Direct'}</span>
                                </button>
                            </div>
                        </div>

                        {renderAnalysisContainer(symbol, config)}
                    </>
                )}
            </div>
        );
    };

    return (
        <div className='auto-trades-page'>
            <ThemedScrollbars className='auto-trades-page__scroll'>
                <div className='auto-trades-page__inner'>

                    {/* ── Top bar ── */}
                    <div className='at-topbar'>
                        <div className='at-topbar__brand'>
                            <span className='at-topbar__icon'>⚡</span>
                            <div>
                                <h1 className='at-topbar__title'>Auto Trades</h1>
                                <p className='at-topbar__sub'>Dual-market algorithmic trading</p>
                            </div>
                        </div>
                        <div className='at-topbar__status'>
                            <span className={classNames('at-status-dot', {
                                'at-status-dot--live': isConnected && !isRunning && !inCooldown,
                                'at-status-dot--running': isRunning && !inCooldown,
                                'at-status-dot--cooldown': inCooldown,
                                'at-status-dot--loading': isLoading,
                            })} />
                            <span className='at-topbar__status-label'>
                                {inCooldown ? 'Cooldown'
                                    : isLoading ? 'Connecting'
                                        : isRunning ? 'Trading'
                                            : isConnected ? 'Live'
                                                : 'Offline'}
                            </span>
                        </div>
                    </div>

                    {/* ── Alerts ── */}
                    {!client.is_logged_in && (
                        <div className='at-alert at-alert--warn'>
                            Log in to your Deriv account to execute real trades.
                        </div>
                    )}
                    {error && <div className='at-alert at-alert--error'>{error}</div>}
                    {inCooldown && isRunning && (
                        <div className='at-alert at-alert--cooldown'>
                            Cooldown — {Math.max(...marketDisplays.map(m => m.lossCooldownLeft))} ticks remaining after loss
                        </div>
                    )}
                    {isLoading && (
                        <div className='at-loader'>
                            <div className='at-loader__spinner' />
                            <div className='at-loader__text'>
                                <strong>Connecting to markets</strong>
                                <span>{dataStreamMessage}</span>
                            </div>
                        </div>
                    )}

                    {/* ── Stats bar ── */}
                    <div className='at-stats'>
                        <div className='at-stat'>
                            <span className='at-stat__label'>P&L</span>
                            <span className={classNames('at-stat__value', {
                                'at-stat__value--pos': pnlPositive,
                                'at-stat__value--neg': pnlNegative,
                            })}>
                                {pnlPositive ? '+' : ''}{totalPnl.toFixed(2)} {currency || 'USD'}
                            </span>
                        </div>
                        <div className='at-stat'>
                            <span className='at-stat__label'>Trades</span>
                            <span className='at-stat__value'>{totalTrades}</span>
                        </div>
                        <div className='at-stat'>
                            <span className='at-stat__label'>Martingale</span>
                            <span className={classNames('at-stat__value', {
                                'at-stat__value--active': martingaleActive,
                                'at-stat__value--off': !martingaleEnabled,
                            })}>
                                {!martingaleEnabled ? 'Off' : martingaleActive ? 'Escalating' : 'Standby'}
                            </span>
                        </div>
                        <div className='at-stat'>
                            <span className='at-stat__label'>Status</span>
                            <span className={classNames('at-stat__value', { 'at-stat__value--running': isRunning })}>
                                {isRunning ? 'Running' : 'Stopped'}
                            </span>
                        </div>
                    </div>

                    {/* ── Global settings ── */}
                    <div className='at-settings'>
                        <div className='at-settings__header'>
                            <span className='at-settings__title'>Settings</span>
                        </div>
                        <div className='at-settings__grid'>
                            <div className='at-field'>
                                <label className='at-field__label'>Stake ({currency || 'USD'})</label>
                                <Input
                                    type='number'
                                    min='0.35'
                                    step='0.01'
                                    value={stake}
                                    onChange={e => setStake(e.target.value)}
                                    disabled={isRunning}
                                />
                            </div>

                            <div className='at-field'>
                                <label className='at-field__label'>Take Profit</label>
                                <Input
                                    type='number'
                                    min='0'
                                    step='1'
                                    value={takeProfit}
                                    onChange={e => setTakeProfit(e.target.value)}
                                    disabled={isRunning}
                                />
                            </div>

                            <div className='at-field'>
                                <label className='at-field__label'>Stop Loss</label>
                                <Input
                                    type='number'
                                    min='0'
                                    step='1'
                                    value={stopLoss}
                                    onChange={e => setStopLoss(e.target.value)}
                                    disabled={isRunning}
                                />
                            </div>

                            <div className='at-field at-field--inline'>
                                <label className='at-field__label'>Martingale</label>
                                <button
                                    type='button'
                                    className={classNames('at-toggle', { 'at-toggle--on': martingaleEnabled })}
                                    onClick={() => setMartingaleEnabled(p => !p)}
                                    disabled={isRunning}
                                >
                                    <span className='at-toggle__track'>
                                        <span className='at-toggle__thumb' />
                                    </span>
                                    <span className='at-toggle__label'>{martingaleEnabled ? 'ON' : 'OFF'}</span>
                                </button>
                            </div>

                            <div className='at-field'>
                                <label className='at-field__label'>Multiplier ×</label>
                                <select
                                    className='at-field__select'
                                    value={martingaleMultiplier}
                                    onChange={e => setMartingaleMultiplier(parseFloat(e.target.value))}
                                    disabled={isRunning || !martingaleEnabled}
                                >
                                    {Array.from({ length: 91 }, (_, i) => (10 + i) / 10).map(val => (
                                        <option key={val} value={val}>{val.toFixed(1)}</option>
                                    ))}
                                </select>
                            </div>

                            <div className='at-field at-field--inline'>
                                <label className='at-field__label'>Switch on Loss</label>
                                <button
                                    type='button'
                                    className={classNames('at-toggle', { 'at-toggle--on': switchOnLoss })}
                                    onClick={() => setSwitchOnLoss(p => !p)}
                                    disabled={isRunning}
                                >
                                    <span className='at-toggle__track'>
                                        <span className='at-toggle__thumb' />
                                    </span>
                                    <span className='at-toggle__label'>{switchOnLoss ? 'ON' : 'OFF'}</span>
                                </button>
                            </div>

                            <div className='at-field at-field--inline'>
                                <label className='at-field__label'>Scan All Markets</label>
                                <button
                                    type='button'
                                    className={classNames('at-toggle', { 'at-toggle--on': scanAllMarkets })}
                                    onClick={() => setScanAllMarkets(p => !p)}
                                    disabled={isRunning}
                                >
                                    <span className='at-toggle__track'>
                                        <span className='at-toggle__thumb' />
                                    </span>
                                    <span className='at-toggle__label'>{scanAllMarkets ? 'ON' : 'OFF'}</span>
                                </button>
                            </div>
                        </div>

                        {martingaleEnabled && (
                            <div className='at-settings__info'>
                                Stake doubles by ×{martingaleMultiplier.toFixed(1)} on each consecutive loss,
                                resets to {Number(stake).toFixed(2)} {currency || 'USD'} on win.
                            </div>
                        )}
                        {switchOnLoss && isRunning && market1Enabled && market2Enabled && !scanAllMarkets && (
                            <div className='at-settings__info at-settings__info--active'>
                                Active market: <strong>{getActiveMarketDisplay()}</strong>
                                {marketSwitchActive && ' — switched after loss'}
                            </div>
                        )}
                        {scanAllMarkets && (
                            <div className='at-settings__info'>
                                Scanning all {AUTO_MARKET_SYMBOLS.length} volatility markets with M1 strategy
                            </div>
                        )}
                    </div>

                    {/* ── Market cards ── */}
                    <div className='at-markets'>
                        {renderMarketCard(
                            1, market1Symbol, market1Enabled, setMarket1Enabled,
                            market1TradeType, setMarket1TradeType,
                            market1Barrier, setMarket1Barrier,
                            market1PredictionDigit, setMarket1PredictionDigit,
                            market1ComparisonOperator, setMarket1ComparisonOperator,
                            market1InputSequence, setMarket1InputSequence,
                            market1AnalysisTicks, setMarket1AnalysisTicks,
                            market1Inverse, setMarket1Inverse,
                            market1Config, setMarket1Symbol
                        )}
                        {renderMarketCard(
                            2, market2Symbol, market2Enabled, setMarket2Enabled,
                            market2TradeType, setMarket2TradeType,
                            market2Barrier, setMarket2Barrier,
                            market2PredictionDigit, setMarket2PredictionDigit,
                            market2ComparisonOperator, setMarket2ComparisonOperator,
                            market2InputSequence, setMarket2InputSequence,
                            market2AnalysisTicks, setMarket2AnalysisTicks,
                            market2Inverse, setMarket2Inverse,
                            market2Config, setMarket2Symbol
                        )}
                    </div>

                    {/* ── Run/Stop ── */}
                    <div className='at-controls'>
                        {!isRunning ? (
                            <button
                                className='at-controls__run'
                                onClick={handleRun}
                                disabled={!client.is_logged_in || !hasEnabledMarkets}
                            >
                                <span className='at-controls__run-icon'>▶</span>
                                Start Trading
                            </button>
                        ) : (
                            <button className='at-controls__stop' onClick={handleStop}>
                                <span className='at-controls__stop-icon'>■</span>
                                Stop Trading
                            </button>
                        )}
                    </div>
                </div>
            </ThemedScrollbars>

            {/* ── Disclaimer ── */}
            <button className='at-disclaimer-btn' onClick={() => setShowDisclaimer(true)}>
                ⚠ Risk Disclaimer
            </button>

            {showDisclaimer && (
                <div className='at-disclaimer-overlay' onClick={() => setShowDisclaimer(false)}>
                    <div className='at-disclaimer-modal' onClick={e => e.stopPropagation()}>
                        <div className='at-disclaimer-modal__header'>
                            <span>⚠ Risk Disclaimer</span>
                            <button onClick={() => setShowDisclaimer(false)}>✕</button>
                        </div>
                        <div className='at-disclaimer-modal__body'>
                            <p>Deriv offers complex derivatives such as options and CFDs. These products may not be suitable for all clients and trading them puts you at risk.</p>
                            <ul>
                                <li>You may lose some or all of the money you invest.</li>
                                <li>If your trade involves currency conversion, exchange rates will affect profit and loss.</li>
                                <li>Never trade with borrowed money or money you cannot afford to lose.</li>
                            </ul>
                        </div>
                        <div className='at-disclaimer-modal__footer'>
                            <button onClick={() => setShowDisclaimer(false)}>I Understand</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
});

export default AutoTrades;
