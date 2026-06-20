// auto-trades.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
type ComparisonOperator = '>' | '<' | '>=' | '<=' | '==';

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

const clampConsecutiveLossThreshold = (value: unknown) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 2;
    return Math.min(10, Math.max(1, Math.trunc(numeric)));
};

const getCandleDirectionLabel = (direction: Direction) => {
    if (direction === 1) return 'Bullish';
    if (direction === -1) return 'Bearish';
    return 'Waiting';
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
    // If profit is >= 0, reset everything
    if (profit >= 0) {
        return {
            consecutiveLosses: 0,
            lastResult: 'win' as const,
            nextStake: base_stake,
            martingaleMultiplier: 1,
            maxLossesReached: false,
        };
    }

    const nextConsecutiveLosses = consecutive_losses + 1;

    // Check max losses reached
    if (nextConsecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
        return {
            consecutiveLosses: nextConsecutiveLosses,
            lastResult: 'loss' as const,
            nextStake: base_stake,
            martingaleMultiplier: 1,
            maxLossesReached: true,
        };
    }

    // If martingale is disabled, use base stake but track losses
    if (!martingale_enabled) {
        return {
            consecutiveLosses: nextConsecutiveLosses,
            lastResult: 'loss' as const,
            nextStake: base_stake,
            martingaleMultiplier: 1,
            maxLossesReached: false,
        };
    }

    // Martingale enabled: increase stake by multiplier^consecutiveLosses
    const martingaleMultiplier = Math.pow(multiplier, nextConsecutiveLosses);
    const nextStake = parseFloat((base_stake * martingaleMultiplier).toFixed(2));

    return {
        consecutiveLosses: nextConsecutiveLosses,
        lastResult: 'loss' as const,
        nextStake: nextStake,
        martingaleMultiplier: martingaleMultiplier,
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
            // Ignore invalid saved market settings.
        }
        return AUTO_MARKET_SYMBOLS.slice(0, 2);
    };

    // ── Global Settings State ─────────────────────────────────────────────

    const [stake, setStake] = useState(() => loadSavedNum('stake', '1', 0.35, 100000));

    // Simplified Martingale: enabled/disabled + multiplier
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

    // Global martingale state across market switches
    const globalMartingaleStateRef = useRef<{
        consecutiveLosses: number;
        currentStake: number;
        martingaleMultiplier: number;
        isInMartingale: boolean;
    }>({
        consecutiveLosses: 0,
        currentStake: 1,
        martingaleMultiplier: 1,
        isInMartingale: false,
    });

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
                    if (config) {
                        configs[symbol] = config;
                    }
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
            // Ignore localStorage write failures.
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
        } catch {
            // Ignore optional run-panel cleanup failures.
        }
        try {
            api_base.is_stopping = false;
            api_base.setIsRunning?.(false);
        } catch {
            // Ignore optional bot-skeleton cleanup failures.
        }
    }, [run_panel]);

    const pushContract = useCallback(
        (data: any) => {
            try {
                transactions.pushTransaction({ ...data, run_id: run_panel.run_id });
                run_panel.onBotContractEvent(data);
                summary_card.onBotContractEvent(data);
            } catch {
                // Ignore observer emit failures.
            }
        },
        [run_panel, summary_card, transactions]
    );

    const stopSubscriptions = useCallback(() => {
        subscriptionVersionRef.current++;
        Object.values(subscriptionsRef.current).forEach(sub => {
            try {
                sub?.unsubscribe?.();
            } catch {
                // Ignore unsubscribe failures.
            }
        });
        subscriptionsRef.current = {};
        Object.values(candleSubscriptionsRef.current).forEach(sub => {
            try {
                sub?.unsubscribe?.();
            } catch {
                // Ignore unsubscribe failures.
            }
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
                        if (!unmountedRef.current) {
                            pushContract(snapshot);
                        }
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
            const nextIndex = (currentIndex + 1) % markets.length;
            return markets[nextIndex];
        }
        if (market1Enabled && market2Enabled) {
            if (currentSymbol === market1Symbol) return market2Symbol;
            if (currentSymbol === market2Symbol) return market1Symbol;
        }
        return null;
    }, [scanAllMarkets, market1Symbol, market2Symbol, market1Enabled, market2Enabled]);

    const getPrimaryMarket = useCallback((): string | null => {
        if (scanAllMarkets) {
            return selectedMarketsRef.current[0] || null;
        }
        if (market1Enabled) return market1Symbol;
        if (market2Enabled) return market2Symbol;
        return null;
    }, [scanAllMarkets, market1Symbol, market2Symbol, market1Enabled, market2Enabled]);

    const shouldMarketTrade = useCallback((symbol: string): boolean => {
        if (!switchOnLoss || !market1Enabled || !market2Enabled || scanAllMarkets) {
            return true;
        }

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

            const baseStake = Number(stake) || 1;
            const mult = martingaleMultiplier || 2;
            const tp = Number(takeProfit) || 100;
            const sl = Number(stopLoss) || 100;

            // Use global martingale state if we're in a martingale sequence
            let consecutiveLosses = state.consecutiveLosses || 0;

            if (globalMartingaleStateRef.current.isInMartingale) {
                consecutiveLosses = globalMartingaleStateRef.current.consecutiveLosses;
            }

            // Calculate next martingale state
            const nextMartingaleState = getNextMartingaleState({
                profit,
                base_stake: baseStake,
                multiplier: mult,
                martingale_enabled: martingaleEnabled,
                consecutive_losses: consecutiveLosses,
            });

            // Update PnL and trade count
            totalPnlRef.current = parseFloat((totalPnlRef.current + profit).toFixed(2));
            totalTradesRef.current++;

            // Update both the global state and the market state
            if (profit < 0 && martingaleEnabled) {
                // Loss: Update global martingale state
                globalMartingaleStateRef.current = {
                    consecutiveLosses: nextMartingaleState.consecutiveLosses,
                    currentStake: nextMartingaleState.nextStake,
                    martingaleMultiplier: nextMartingaleState.martingaleMultiplier || 1,
                    isInMartingale: true,
                };

                state.consecutiveLosses = nextMartingaleState.consecutiveLosses;
                state.currentStake = nextMartingaleState.nextStake;
                state.martingaleMultiplier = nextMartingaleState.martingaleMultiplier || 1;
            } else if (profit >= 0) {
                // Win: Reset global martingale state
                globalMartingaleStateRef.current = {
                    consecutiveLosses: 0,
                    currentStake: baseStake,
                    martingaleMultiplier: 1,
                    isInMartingale: false,
                };

                state.consecutiveLosses = 0;
                state.currentStake = baseStake;
                state.martingaleMultiplier = 1;
            } else {
                state.consecutiveLosses = nextMartingaleState.consecutiveLosses;
                state.currentStake = nextMartingaleState.nextStake;
                state.martingaleMultiplier = nextMartingaleState.martingaleMultiplier || 1;

                if (profit < 0) {
                    globalMartingaleStateRef.current.isInMartingale = true;
                }
            }

            state.lastResultType = nextMartingaleState.lastResult;
            state.lastResult = nextMartingaleState.lastResult;
            state.lossCooldownLeft = profit < 0 ? MARKET_LOSS_COOLDOWN_TICKS : 0;
            state.tradeCount++;
            state.trading = false;
            state.isExecuting = false;
            globalTradingRef.current = false;
            currentTradingMarketRef.current = null;

            if (pendingTradePromisesRef.current[symbol]) {
                pendingTradePromisesRef.current[symbol] = null;
            }

            // Check if max losses reached
            if (nextMartingaleState.maxLossesReached) {
                console.warn(`[AutoTrades] Maximum consecutive losses reached for ${symbol}. Stopping trading.`);
                runningRef.current = false;
                setIsRunning(false);
                setError(`Maximum consecutive losses (${MAX_CONSECUTIVE_LOSSES}) reached. Trading stopped.`);
                completeRunPanelStop();
                return;
            }

            lastResultRef.current[symbol] = nextMartingaleState.lastResult;

            // Handle market switching on loss - IMMEDIATE SWITCH
            if (switchOnLoss && market1Enabled && market2Enabled && !scanAllMarkets) {
                if (profit < 0) {
                    // IMMEDIATELY switch to the other market after loss
                    const nextSymbol = getNextMarketForSwitch(symbol);
                    if (nextSymbol && nextSymbol !== symbol) {
                        const nextConfig = marketConfigsRef.current[nextSymbol];
                        if (nextConfig && nextConfig.enabled) {
                            // Carry over martingale state to the next market
                            const nextState = marketStatesRef.current[nextSymbol];
                            if (nextState) {
                                nextState.consecutiveLosses = globalMartingaleStateRef.current.consecutiveLosses;
                                nextState.currentStake = globalMartingaleStateRef.current.currentStake;
                                nextState.martingaleMultiplier = globalMartingaleStateRef.current.martingaleMultiplier;
                            }

                            marketSwitchActiveRef.current = true;
                            // Switch immediately
                            setActiveTradingMarket(nextSymbol);
                            activeTradingMarketRef.current = nextSymbol;
                            isPrimaryMarketActiveRef.current = false;
                            console.log(`[AutoTrades] IMMEDIATELY switching from ${symbol} to ${nextSymbol} after loss with martingale state:`,
                                globalMartingaleStateRef.current);
                        }
                    }
                } else if (profit >= 0) {
                    // On win, switch back to primary market
                    const primarySymbol = getPrimaryMarket();
                    if (primarySymbol && primarySymbol !== symbol) {
                        const primaryConfig = marketConfigsRef.current[primarySymbol];
                        if (primaryConfig && primaryConfig.enabled) {
                            // Reset primary market's martingale state
                            const primaryState = marketStatesRef.current[primarySymbol];
                            if (primaryState) {
                                primaryState.consecutiveLosses = 0;
                                primaryState.currentStake = baseStake;
                                primaryState.martingaleMultiplier = 1;
                            }

                            // Switch back to primary immediately
                            setActiveTradingMarket(primarySymbol);
                            activeTradingMarketRef.current = primarySymbol;
                            isPrimaryMarketActiveRef.current = true;
                            marketSwitchActiveRef.current = false;
                            console.log(`[AutoTrades] IMMEDIATELY switching back to primary market ${primarySymbol} after win`);
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

            // Check take profit / stop loss
            if ((totalPnlRef.current >= tp || totalPnlRef.current <= -sl) && runningRef.current) {
                runningRef.current = false;
                if (!unmountedRef.current) {
                    setIsRunning(false);
                }
                completeRunPanelStop();
            }
        },
        [completeRunPanelStop, refreshDisplays, stake, martingaleMultiplier, martingaleEnabled, takeProfit, stopLoss, switchOnLoss, getNextMarketForSwitch, getPrimaryMarket, market1Enabled, market2Enabled, scanAllMarkets]
    );

    // ── Try Execute Signal ───────────────────────────────────────────────

    const tryExecuteSignal = useCallback(
        (symbol: string, state: MarketState, signalReady: boolean) => {
            if (!shouldMarketTrade(symbol)) {
                return;
            }

            const config = marketConfigsRef.current[symbol];
            if (!config || !config.enabled) {
                return;
            }

            if (pendingTradePromisesRef.current[symbol]) {
                return;
            }

            if (currentTradingMarketRef.current && currentTradingMarketRef.current !== symbol) {
                return;
            }

            let stakeToUse = state.currentStake || Number(stake) || 1;

            if (globalMartingaleStateRef.current.isInMartingale && martingaleEnabled) {
                stakeToUse = globalMartingaleStateRef.current.currentStake;
                state.currentStake = stakeToUse;
                state.consecutiveLosses = globalMartingaleStateRef.current.consecutiveLosses;
                state.martingaleMultiplier = globalMartingaleStateRef.current.martingaleMultiplier;
                marketStatesRef.current[symbol] = { ...state };
            }

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

                if (stakeToUse <= 0 || isNaN(stakeToUse)) {
                    console.error(`[AutoTrades] Sanity check failed: Invalid stake amount ${stakeToUse} for ${symbol}`);
                    state.trading = false;
                    state.isExecuting = false;
                    globalTradingRef.current = false;
                    currentTradingMarketRef.current = null;
                    setError('Auto Trades stopped because the stake amount is invalid.');
                    refreshDisplays();
                    return;
                }

                marketStatesRef.current[symbol] = { ...state };

                const tradePromise = executeTrade(symbol, stakeToUse, state.lastResultType);
                pendingTradePromisesRef.current[symbol] = tradePromise;

                tradePromise
                    .then(profit => {
                        if (runningRef.current && !unmountedRef.current) {
                            handleAfterTrade(symbol, profit);
                        } else {
                            const currentState = marketStatesRef.current[symbol];
                            if (currentState) {
                                currentState.trading = false;
                                currentState.isExecuting = false;
                                globalTradingRef.current = false;
                                currentTradingMarketRef.current = null;
                                if (pendingTradePromisesRef.current[symbol]) {
                                    pendingTradePromisesRef.current[symbol] = null;
                                }
                                marketStatesRef.current[symbol] = { ...currentState };
                            }
                        }
                    })
                    .catch(error => {
                        console.error(`[AutoTrades] Trade execution failed for ${symbol}:`, error);
                        const currentState = marketStatesRef.current[symbol];
                        if (currentState) {
                            currentState.trading = false;
                            currentState.isExecuting = false;
                            globalTradingRef.current = false;
                            currentTradingMarketRef.current = null;
                            if (pendingTradePromisesRef.current[symbol]) {
                                pendingTradePromisesRef.current[symbol] = null;
                            }
                            marketStatesRef.current[symbol] = { ...currentState };
                            refreshDisplays();
                        }
                    });
            }
        },
        [client.is_logged_in, executeTrade, handleAfterTrade, refreshDisplays, stake, shouldMarketTrade, martingaleEnabled]
    );

    // ── Tick Handler ─────────────────────────────────────────────────────

    const handleTick = useCallback(
        (symbol: string, tick: any) => {
            const config = marketConfigsRef.current[symbol];
            if (!config || !config.enabled) {
                return;
            }

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
            if (isRecoveringDataRef.current) {
                clearDataRecoveryLoading();
            }

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
                }
                else if (ct === 'DIGITEVEN' || ct === 'DIGITODD') {
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
                }
                else {
                    match = isDigitSignalMatch({ trade_type: ct, digit: lastDigit, barrier: bar, inverse: inv });
                }

                if (match) {
                    state.consecutive = Math.min(state.consecutive + 1, MAX_STREAK_LENGTH);
                } else {
                    state.consecutive = 0;
                }
            }

            const candleMatch = isCandleConfirmedTradeType(ct)
                ? (inv ? isCandleMatch(ct, state.candleDirection) : isCandleMatch(ct, state.candleDirection))
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
            if (!config || !config.enabled) {
                return;
            }
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
                (inv ? isCandleMatch(ct, state.candleDirection) : isCandleMatch(ct, state.candleDirection));
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
            if (market1Enabled) {
                marketsToMonitor = AUTO_MARKET_SYMBOLS;
            }
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
                    currentStake: Number(stake) || 1,
                    baseStake: Number(stake) || 1,
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
        stake,
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
                .catch(err => {
                    console.error('[AutoTrades] Data restart failed:', err);
                })
                .finally(() => {
                    restartInFlightRef.current = false;
                    lastTickAtRef.current = Date.now();
                });
        }, 800);
    }, [setDataRecoveryLoading, startSubscriptions, stopSubscriptions]);

    // ── Session Management ───────────────────────────────────────────────

    const resetSession = useCallback(() => {
        const baseStake = Number(stake) || 1;
        globalTradingRef.current = false;
        currentTradingMarketRef.current = null;

        // Reset global martingale state
        globalMartingaleStateRef.current = {
            consecutiveLosses: 0,
            currentStake: baseStake,
            martingaleMultiplier: 1,
            isInMartingale: false,
        };

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
    }, [refreshDisplays, stake, switchOnLoss, market1Enabled, market2Enabled, scanAllMarkets, market1Symbol, market2Symbol]);

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
        } catch {
            // Ignore optional run-panel mount failures.
        }
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

    const handleStop = useCallback(() => {
        stopTrading();
    }, [stopTrading]);

    // ── Effects ──────────────────────────────────────────────────────────

    useEffect(() => {
        if (show_auto && api_base.api) {
            startSubscriptions();
        }
        return () => {
            if (!show_auto) {
                stopSubscriptions();
            }
        };
    }, [show_auto, startSubscriptions, stopSubscriptions, market1Symbol, market2Symbol, market1Enabled, market2Enabled, scanAllMarkets]);

    useEffect(() => {
        if (!show_auto) return undefined;
        const intervalId = window.setInterval(() => {
            if (!show_auto_ref.current || unmountedRef.current) return;
            const has_selected_markets = selectedMarketsRef.current.length > 0;
            const silent_for = Date.now() - lastTickAtRef.current;
            if (has_selected_markets && silent_for > DATA_SILENCE_RESTART_MS) {
                if (!restartInFlightRef.current) {
                    restartSubscriptions();
                }
            }
        }, 5000);
        return () => {
            window.clearInterval(intervalId);
        };
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
            } catch {
                // Ignore optional run-panel stop failures.
            }
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
            if (market1Enabled) {
                displaySymbols.push(...AUTO_MARKET_SYMBOLS);
            }
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
                currentStake: state.currentStake || Number(stake) || 1,
            };
        });
    }, [market1Symbol, market2Symbol, market1Enabled, market2Enabled, scanAllMarkets, stake]);

    // ── Analysis Data Computation ─────────────────────────────────────────

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

        const priceHistory = state.priceHistory.slice(-10);
        const currentPrice = state.lastPrice;

        return {
            allMatch,
            tickResults,
            recentDigits,
            targetLen,
            conditionText,
            signalReady: state.consecutive >= targetLen,
            currentPrice,
            priceHistory,
        };
    }, []);

    // ── Render Analysis Container ─────────────────────────────────────

    const renderAnalysisContainer = (symbol: string, config: MarketConfig | null) => {
        if (!config) return null;

        const analysis = getMarketAnalysis(symbol, config);
        if (!analysis) return null;

        const statusClass = analysis.signalReady ? '--found' : analysis.allMatch ? '--waiting' : '--none';
        const statusText = analysis.signalReady ? 'SIGNAL READY' : analysis.allMatch ? 'PATTERN MATCHED' : 'WAITING';

        const formatPrice = (price: number | null) => {
            if (price === null) return '—';
            const pip = AUTO_MARKET_LOOKUP.get(symbol)?.pip || 2;
            return price.toFixed(pip);
        };

        return (
            <div className="auto-trades-market__analysis">
                <div className="analysis-header">
                    <span className="title">📊 Pattern Analysis</span>
                    <span className={classNames('status', `status${statusClass}`)}>
                        {statusText}
                    </span>
                </div>
                <div className="analysis-body">
                    <div className="analysis-price">
                        <span>💰 Price:</span>
                        <span className="price-value">{formatPrice(analysis.currentPrice)}</span>
                    </div>

                    {analysis.priceHistory && analysis.priceHistory.length > 0 && (
                        <div className="analysis-history">
                            <span className="history-label">📈 Price History</span>
                            <div className="price-bars">
                                {analysis.priceHistory.map((price, idx) => {
                                    const minPrice = Math.min(...analysis.priceHistory);
                                    const maxPrice = Math.max(...analysis.priceHistory);
                                    const range = maxPrice - minPrice || 1;
                                    const height = ((price - minPrice) / range) * 28 + 4;
                                    return (
                                        <div
                                            key={idx}
                                            className="bar"
                                            style={{ height: `${height}px` }}
                                            title={formatPrice(price)}
                                        />
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    <div className="analysis-row">
                        <span>Required Ticks:</span>
                        <strong>{analysis.targetLen}</strong>
                    </div>
                    <div className="analysis-row">
                        <span>Condition:</span>
                        <strong>{analysis.conditionText}</strong>
                    </div>
                    <div className="analysis-row">
                        <span>Last {analysis.targetLen} Ticks:</span>
                    </div>
                    <div className="analysis-ticks">
                        {analysis.recentDigits.map((digit, idx) => (
                            <span
                                key={idx}
                                className={classNames('tick', {
                                    'tick--match': analysis.tickResults[idx],
                                    'tick--nomatch': !analysis.tickResults[idx] && analysis.recentDigits.length >= analysis.targetLen,
                                    'tick--empty': analysis.recentDigits.length < analysis.targetLen,
                                })}
                            >
                                {digit}
                            </span>
                        ))}
                        {analysis.recentDigits.length < analysis.targetLen && (
                            <span className="tick tick--empty">...</span>
                        )}
                    </div>
                    <div className={classNames('analysis-signal', {
                        'analysis-signal--ready': analysis.signalReady,
                        'analysis-signal--waiting': !analysis.signalReady,
                    })}>
                        {analysis.signalReady ? '✅ Signal Ready! Waiting for next tick to execute trade.' : '⏳ Waiting for pattern to match...'}
                    </div>
                </div>
            </div>
        );
    };

    // ── Render ────────────────────────────────────────────────────────────

    if (!show_auto) return null;

    const pnlPositive = totalPnl > 0;
    const pnlNegative = totalPnl < 0;
    const baseStakeNum = Number(stake) || 1;
    const martingaleActive = marketDisplays.some(m => m.currentStake > baseStakeNum) || globalMartingaleStateRef.current.isInMartingale;
    const inCooldown = marketDisplays.some(m => m.lossCooldownLeft > 0);
    const hasAnyLiveQuote = marketDisplays.some(m => m.lastQuote !== null);
    const isLoading = selectedMarketsRef.current.length > 0 && !hasAnyLiveQuote && (dataStreamLoading || !isConnected);

    const getActiveMarketDisplay = () => {
        const activeSymbol = activeTradingMarketRef.current;
        if (!activeSymbol) return 'None';
        const market = AUTO_MARKET_LOOKUP.get(activeSymbol);
        return market?.label || activeSymbol;
    };

    const market1Config = marketConfigsRef.current[market1Symbol] || null;
    const market2Config = marketConfigsRef.current[market2Symbol] || null;

    const hasEnabledMarkets = market1Enabled || market2Enabled || scanAllMarkets;

    return (
        <div className="auto-trades-page">
            <ThemedScrollbars className="auto-trades-page__scroll">
                <div className="auto-trades-page__inner">
                    {/* Header */}
                    <div className="auto-trades-page__header">
                        <h1>
                            <span className="icon">⚡</span>
                            Auto Trades
                        </h1>
                        <div className="auto-trades-page__status">
                            <span
                                className={classNames('dot', {
                                    'dot--live': isConnected && !inCooldown && !isRunning,
                                    'dot--trading': isRunning && !inCooldown,
                                    'dot--cooldown': inCooldown,
                                    'dot--loading': isLoading && !inCooldown,
                                })}
                            />
                            <span>
                                {inCooldown
                                    ? 'Cooldown'
                                    : isLoading
                                        ? 'Loading data'
                                        : isRunning
                                            ? 'Trading'
                                            : isConnected
                                                ? 'Live data'
                                                : 'Connecting…'}
                            </span>
                        </div>
                    </div>

                    {!client.is_logged_in && (
                        <div className="auto-trades-page__notice">
                            Please log in to your Deriv account to execute real trades.
                        </div>
                    )}

                    {error && <div className="auto-trades-page__error">{error}</div>}

                    {inCooldown && isRunning && (
                        <div className="auto-trades-page__cooldown">
                            ⏳ Cooldown after consecutive loss — markets paused for <strong>{Math.max(...marketDisplays.map(m => m.lossCooldownLeft))}</strong> more ticks
                        </div>
                    )}

                    {isLoading && (
                        <div className="auto-trades-page__loader">
                            <div className="loader-content">
                                <span className="spinner" />
                                <strong>Waiting for live market data</strong>
                                <span>{dataStreamMessage}</span>
                            </div>
                        </div>
                    )}

                    <div className="auto-trades-page__body">
                        {/* Run / Stop Button - Now before Global Settings */}
                        <div className="auto-trades-controls">
                            {!isRunning ? (
                                <button
                                    className="btn btn--start"
                                    onClick={handleRun}
                                    disabled={!client.is_logged_in || !hasEnabledMarkets}
                                >
                                    ▶ Start Trading
                                </button>
                            ) : (
                                <button className="btn btn--stop" onClick={handleStop}>
                                    ■ Stop Trading
                                </button>
                            )}
                        </div>

                        {/* Global Settings */}
                        <div className="auto-trades-global">
                            <div className="auto-trades-global__header">
                                <span className="auto-trades-global__title">⚙️ Global Settings</span>
                                {martingaleEnabled && (
                                    <span className="auto-trades-global__info-martingale">
                                        📈 Martingale: ×{martingaleMultiplier.toFixed(1)}
                                    </span>
                                )}
                            </div>
                            <div className="auto-trades-global__grid">
                                <div className="auto-trades-global__field">
                                    <label>Stake ({currency || 'USD'})</label>
                                    <Input
                                        type="number"
                                        min="0.35"
                                        step="0.01"
                                        value={stake}
                                        onChange={e => setStake(e.target.value)}
                                        disabled={isRunning}
                                        className="input"
                                    />
                                </div>

                                <div className="auto-trades-global__field">
                                    <label>Martingale</label>
                                    <button
                                        type="button"
                                        className={classNames(
                                            'auto-trades-global__toggle',
                                            martingaleEnabled && 'auto-trades-global__toggle--active'
                                        )}
                                        onClick={() => setMartingaleEnabled(prev => !prev)}
                                        disabled={isRunning}
                                    >
                                        <span>{martingaleEnabled ? 'ON' : 'OFF'}</span>
                                        <span className="switch">
                                            <span className="knob" />
                                        </span>
                                    </button>
                                </div>

                                <div className="auto-trades-global__field">
                                    <label>Multiplier ×</label>
                                    <select
                                        className="input input--select"
                                        value={martingaleMultiplier}
                                        onChange={e => setMartingaleMultiplier(parseFloat(e.target.value))}
                                        disabled={isRunning || !martingaleEnabled}
                                    >
                                        {Array.from({ length: 91 }, (_, i) => (10 + i) / 10).map(val => (
                                            <option key={val} value={val}>{val.toFixed(1)}</option>
                                        ))}
                                    </select>
                                </div>

                                <div className="auto-trades-global__field">
                                    <label>Take Profit</label>
                                    <Input
                                        type="number"
                                        min="0"
                                        step="1"
                                        value={takeProfit}
                                        onChange={e => setTakeProfit(e.target.value)}
                                        disabled={isRunning}
                                        className="input"
                                    />
                                </div>

                                <div className="auto-trades-global__field">
                                    <label>Stop Loss</label>
                                    <Input
                                        type="number"
                                        min="0"
                                        step="1"
                                        value={stopLoss}
                                        onChange={e => setStopLoss(e.target.value)}
                                        disabled={isRunning}
                                        className="input"
                                    />
                                </div>

                                <div className="auto-trades-global__field">
                                    <label>Market Switching</label>
                                    <button
                                        type="button"
                                        className={classNames(
                                            'auto-trades-global__toggle',
                                            switchOnLoss && 'auto-trades-global__toggle--active'
                                        )}
                                        onClick={() => setSwitchOnLoss(prev => !prev)}
                                        disabled={isRunning}
                                    >
                                        <span>{switchOnLoss ? '🔄 On Loss' : '→ Off'}</span>
                                        <span className="switch">
                                            <span className="knob" />
                                        </span>
                                    </button>
                                </div>

                                <div className="auto-trades-global__field">
                                    <label>Scan All Markets</label>
                                    <button
                                        type="button"
                                        className={classNames(
                                            'auto-trades-global__toggle',
                                            scanAllMarkets && 'auto-trades-global__toggle--active'
                                        )}
                                        onClick={() => setScanAllMarkets(prev => !prev)}
                                        disabled={isRunning}
                                    >
                                        <span>{scanAllMarkets ? '🔍 On' : '→ Off'}</span>
                                        <span className="switch">
                                            <span className="knob" />
                                        </span>
                                    </button>
                                </div>
                            </div>

                            {(switchOnLoss || scanAllMarkets || martingaleEnabled) && (
                                <div className="auto-trades-global__info">
                                    {switchOnLoss && market1Enabled && market2Enabled && !scanAllMarkets && isRunning && (
                                        <span>Active: <span className="highlight">{getActiveMarketDisplay()}</span></span>
                                    )}
                                    {scanAllMarkets && (
                                        <span>Scanning all {AUTO_MARKET_SYMBOLS.length} volatility markets</span>
                                    )}
                                    {martingaleEnabled && (
                                        <span className="martingale-badge">
                                            Martingale: stake multiplies by ×{martingaleMultiplier.toFixed(1)} on each consecutive loss
                                            {globalMartingaleStateRef.current.isInMartingale && (
                                                <span className="martingale-active">
                                                    🔥 Active: ×{globalMartingaleStateRef.current.martingaleMultiplier.toFixed(1)}
                                                    (Loss #{globalMartingaleStateRef.current.consecutiveLosses})
                                                </span>
                                            )}
                                        </span>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Stats - MOVED HERE (after Global Settings) */}
                        <div className="auto-trades-stats">
                            <div className="stat">
                                <span className="label">Total P&L</span>
                                <span className={classNames('value', {
                                    'value--positive': pnlPositive,
                                    'value--negative': pnlNegative,
                                })}>
                                    {pnlPositive ? '+' : ''}{totalPnl.toFixed(2)} {currency}
                                </span>
                            </div>
                            <div className="stat">
                                <span className="label">Total Trades</span>
                                <span className="value">{totalTrades}</span>
                            </div>
                            <div className="stat">
                                <span className="label">Martingale</span>
                                <span className={classNames('value', {
                                    'value--active': martingaleActive && martingaleEnabled,
                                })}>
                                    {martingaleEnabled && martingaleActive ? 'Active' : martingaleEnabled ? 'Waiting' : 'Off'}
                                    {martingaleActive && martingaleEnabled && globalMartingaleStateRef.current.isInMartingale && (
                                        <span className="martingale-detail">
                                            (×{globalMartingaleStateRef.current.martingaleMultiplier.toFixed(1)})
                                        </span>
                                    )}
                                </span>
                            </div>
                            <div className="stat">
                                <span className="label">Status</span>
                                <span className={classNames('value', {
                                    'value--running': isRunning,
                                })}>
                                    {isRunning ? '▶ Running' : '⏸ Stopped'}
                                </span>
                            </div>
                        </div>

                        {/* Markets Grid */}
                        <div className="auto-trades-markets">
                            {/* Market 1 */}
                            <div className={classNames(
                                'auto-trades-market',
                                'auto-trades-market--primary',
                                !market1Enabled && 'auto-trades-market--disabled'
                            )}>
                                <div className="auto-trades-market__header">
                                    <div className="auto-trades-market__title">
                                        <h2>📈 Primary</h2>
                                        {switchOnLoss && activeTradingMarketRef.current === market1Symbol && isRunning && (
                                            <span className="badge badge--active">Active</span>
                                        )}
                                        <span className="badge badge--primary">Primary</span>
                                    </div>
                                    <div className="auto-trades-market__controls">
                                        <button
                                            type="button"
                                            className={classNames(
                                                'auto-trades-global__toggle',
                                                market1Enabled && 'auto-trades-global__toggle--active'
                                            )}
                                            onClick={() => setMarket1Enabled(prev => !prev)}
                                            disabled={isRunning}
                                        >
                                            <span>{market1Enabled ? 'ON' : 'OFF'}</span>
                                            <span className="switch">
                                                <span className="knob" />
                                            </span>
                                        </button>
                                    </div>
                                </div>

                                {market1Enabled && (
                                    <>
                                        <div className="auto-trades-market__config">
                                            <div className="auto-trades-market__field">
                                                <label>Market</label>
                                                <select
                                                    className="input input--select"
                                                    value={market1Symbol}
                                                    onChange={e => setMarket1Symbol(e.target.value)}
                                                    disabled={isRunning || scanAllMarkets}
                                                >
                                                    {AUTO_MARKETS.map(m => (
                                                        <option key={m.symbol} value={m.symbol}>{m.label}</option>
                                                    ))}
                                                </select>
                                            </div>
                                            <div className="auto-trades-market__field">
                                                <label>Contract Type</label>
                                                <select
                                                    className="input input--select"
                                                    value={market1TradeType}
                                                    onChange={e => setMarket1TradeType(e.target.value as TradeType)}
                                                    disabled={isRunning}
                                                >
                                                    <optgroup label="Over/Under">
                                                        <option value="DIGITOVER">Over</option>
                                                        <option value="DIGITUNDER">Under</option>
                                                    </optgroup>
                                                    <optgroup label="Even/Odd">
                                                        <option value="DIGITEVEN">Even</option>
                                                        <option value="DIGITODD">Odd</option>
                                                    </optgroup>
                                                    <optgroup label="Match/Diff">
                                                        <option value="DIGITMATCH">Matches</option>
                                                        <option value="DIGITDIFF">Differs</option>
                                                    </optgroup>
                                                    <optgroup label="Direction">
                                                        <option value="CALL">Rise</option>
                                                        <option value="PUT">Fall</option>
                                                        <option value="RUNHIGH">Only Ups</option>
                                                        <option value="RUNLOW">Only Downs</option>
                                                    </optgroup>
                                                </select>
                                            </div>

                                            {(market1TradeType === 'DIGITOVER' || market1TradeType === 'DIGITUNDER') && (
                                                <>
                                                    <div className="auto-trades-market__field">
                                                        <label>Last Ticks</label>
                                                        <select
                                                            className="input input--select"
                                                            value={market1AnalysisTicks}
                                                            onChange={e => setMarket1AnalysisTicks(e.target.value)}
                                                            disabled={isRunning}
                                                        >
                                                            {Array.from({ length: MAX_ANALYSIS_TICKS }, (_, i) => i + 1).map(d => (
                                                                <option key={d} value={String(d)}>{d}</option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                    <div className="auto-trades-market__field">
                                                        <label>Operator</label>
                                                        <select
                                                            className="input input--select"
                                                            value={market1ComparisonOperator}
                                                            onChange={e => setMarket1ComparisonOperator(e.target.value as ComparisonOperator)}
                                                            disabled={isRunning}
                                                        >
                                                            <option value=">">&gt;</option>
                                                            <option value="<">&lt;</option>
                                                            <option value=">=">&gt;=</option>
                                                            <option value="<=">&lt;=</option>
                                                            <option value="==">==</option>
                                                        </select>
                                                    </div>
                                                    <div className="auto-trades-market__field">
                                                        <label>Compare Digit</label>
                                                        <select
                                                            className="input input--select"
                                                            value={market1Barrier}
                                                            onChange={e => setMarket1Barrier(e.target.value)}
                                                            disabled={isRunning}
                                                        >
                                                            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => (
                                                                <option key={d} value={String(d)}>{d}</option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                    {usesLossPrediction(market1TradeType) && (
                                                        <div className="auto-trades-market__field">
                                                            <label>Predict Digit</label>
                                                            <select
                                                                className="input input--select"
                                                                value={market1PredictionDigit}
                                                                onChange={e => setMarket1PredictionDigit(e.target.value)}
                                                                disabled={isRunning}
                                                            >
                                                                {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => (
                                                                    <option key={d} value={String(d)}>{d}</option>
                                                                ))}
                                                            </select>
                                                        </div>
                                                    )}
                                                </>
                                            )}

                                            {(market1TradeType === 'DIGITEVEN' || market1TradeType === 'DIGITODD') && (
                                                <div className="auto-trades-market__field">
                                                    <label>Pattern (E=Even, O=Odd)</label>
                                                    <Input
                                                        type="text"
                                                        placeholder="e.g., EEO, OEE"
                                                        value={market1InputSequence}
                                                        onChange={e => setMarket1InputSequence(e.target.value.toUpperCase().replace(/[^EO]/g, ''))}
                                                        disabled={isRunning}
                                                        className="input"
                                                    />
                                                    {market1InputSequence && (
                                                        <div className="sequence-preview">
                                                            {market1InputSequence.split('').map((ch, i) => (
                                                                <span key={i} className={`char ${ch === 'E' ? 'even' : 'odd'}`}>
                                                                    {ch === 'E' ? 'Even' : 'Odd'}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            )}

                                            {(market1TradeType === 'DIGITMATCH' || market1TradeType === 'DIGITDIFF') && (
                                                <>
                                                    <div className="auto-trades-market__field">
                                                        <label>Digit</label>
                                                        <select
                                                            className="input input--select"
                                                            value={market1Barrier}
                                                            onChange={e => setMarket1Barrier(e.target.value)}
                                                            disabled={isRunning}
                                                        >
                                                            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => (
                                                                <option key={d} value={String(d)}>{d}</option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                    <div className="auto-trades-market__field">
                                                        <label>Analysis Ticks</label>
                                                        <select
                                                            className="input input--select"
                                                            value={market1AnalysisTicks}
                                                            onChange={e => setMarket1AnalysisTicks(e.target.value)}
                                                            disabled={isRunning}
                                                        >
                                                            {Array.from({ length: MAX_ANALYSIS_TICKS }, (_, i) => i + 1).map(d => (
                                                                <option key={d} value={String(d)}>{d}</option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                </>
                                            )}

                                            <div className="auto-trades-market__field">
                                                <label>Inverse</label>
                                                <button
                                                    type="button"
                                                    className={classNames(
                                                        'auto-trades-global__toggle',
                                                        market1Inverse && 'auto-trades-global__toggle--active'
                                                    )}
                                                    onClick={() => setMarket1Inverse(prev => !prev)}
                                                    disabled={isRunning}
                                                >
                                                    <span>{market1Inverse ? '🔀 Inverse' : '→ Direct'}</span>
                                                    <span className="switch">
                                                        <span className="knob" />
                                                    </span>
                                                </button>
                                            </div>
                                        </div>

                                        {/* Live Display */}
                                        {marketDisplays.find(m => m.symbol === market1Symbol) && (
                                            <div className="auto-trades-market__live">
                                                <div className="quote">
                                                    {marketDisplays.find(m => m.symbol === market1Symbol)?.lastQuote !== null
                                                        ? marketDisplays.find(m => m.symbol === market1Symbol)?.lastQuote?.toFixed(marketDisplays.find(m => m.symbol === market1Symbol)?.pip || 2)
                                                        : '—'}
                                                </div>
                                                <div className="info">
                                                    <span className="streak">
                                                        Streak: {marketDisplays.find(m => m.symbol === market1Symbol)?.consecutive || 0}
                                                    </span>
                                                    <span className="stake">
                                                        Stake: {marketDisplays.find(m => m.symbol === market1Symbol)?.currentStake || baseStakeNum}
                                                        {marketDisplays.find(m => m.symbol === market1Symbol)?.martingaleMultiplier && marketDisplays.find(m => m.symbol === market1Symbol)?.martingaleMultiplier !== 1 &&
                                                            ` (×${marketDisplays.find(m => m.symbol === market1Symbol)?.martingaleMultiplier?.toFixed(2)})`
                                                        }
                                                    </span>
                                                    <span className={classNames('result', {
                                                        'result--win': marketDisplays.find(m => m.symbol === market1Symbol)?.lastResult === 'win',
                                                        'result--loss': marketDisplays.find(m => m.symbol === market1Symbol)?.lastResult === 'loss',
                                                    })}>
                                                        {marketDisplays.find(m => m.symbol === market1Symbol)?.lastResult === 'win' ? '✓' :
                                                            marketDisplays.find(m => m.symbol === market1Symbol)?.lastResult === 'loss' ? '✗' : '—'}
                                                    </span>
                                                </div>
                                                {marketDisplays.find(m => m.symbol === market1Symbol)?.lastDigits.length > 0 && (
                                                    <div className="digits">
                                                        {marketDisplays.find(m => m.symbol === market1Symbol)?.lastDigits.slice(-5).map((d, idx) => (
                                                            <span key={idx} className="digit">{d}</span>
                                                        ))}
                                                    </div>
                                                )}
                                                <div className="meta">
                                                    <span className="candle">
                                                        5m: {getCandleDirectionLabel(marketDisplays.find(m => m.symbol === market1Symbol)?.candleDirection || 0)}
                                                    </span>
                                                    <span className={classNames('status', {
                                                        'status--buying': marketDisplays.find(m => m.symbol === market1Symbol)?.trading,
                                                        'status--cooldown': marketDisplays.find(m => m.symbol === market1Symbol)?.lossCooldownLeft > 0,
                                                        'status--ready': marketDisplays.find(m => m.symbol === market1Symbol)?.consecutive && marketDisplays.find(m => m.symbol === market1Symbol)?.consecutive >= Math.min(MAX_STREAK_LENGTH, Math.max(1, Number(market1AnalysisTicks) || 1)),
                                                        'status--waiting': !marketDisplays.find(m => m.symbol === market1Symbol)?.trading &&
                                                            !(marketDisplays.find(m => m.symbol === market1Symbol)?.lossCooldownLeft > 0) &&
                                                            !(marketDisplays.find(m => m.symbol === market1Symbol)?.consecutive && marketDisplays.find(m => m.symbol === market1Symbol)?.consecutive >= Math.min(MAX_STREAK_LENGTH, Math.max(1, Number(market1AnalysisTicks) || 1))),
                                                    })}>
                                                        {marketDisplays.find(m => m.symbol === market1Symbol)?.trading ? '🔄 Buying...' :
                                                            marketDisplays.find(m => m.symbol === market1Symbol)?.lossCooldownLeft > 0 ? `⏳ Cooldown ${marketDisplays.find(m => m.symbol === market1Symbol)?.lossCooldownLeft}t` :
                                                                marketDisplays.find(m => m.symbol === market1Symbol)?.consecutive && marketDisplays.find(m => m.symbol === market1Symbol)?.consecutive >= Math.min(MAX_STREAK_LENGTH, Math.max(1, Number(market1AnalysisTicks) || 1)) ? '✅ Ready' : '⏳ Waiting'}
                                                    </span>
                                                </div>
                                            </div>
                                        )}

                                        {/* Analysis */}
                                        {renderAnalysisContainer(market1Symbol, market1Config)}
                                    </>
                                )}
                            </div>

                            {/* Market 2 */}
                            <div className={classNames(
                                'auto-trades-market',
                                'auto-trades-market--secondary',
                                !market2Enabled && 'auto-trades-market--disabled'
                            )}>
                                <div className="auto-trades-market__header">
                                    <div className="auto-trades-market__title">
                                        <h2>📊 Secondary</h2>
                                        {switchOnLoss && activeTradingMarketRef.current === market2Symbol && isRunning && (
                                            <span className="badge badge--active">Active</span>
                                        )}
                                        <span className="badge badge--secondary">Secondary</span>
                                    </div>
                                    <div className="auto-trades-market__controls">
                                        <button
                                            type="button"
                                            className={classNames(
                                                'auto-trades-global__toggle',
                                                market2Enabled && 'auto-trades-global__toggle--active'
                                            )}
                                            onClick={() => setMarket2Enabled(prev => !prev)}
                                            disabled={isRunning}
                                        >
                                            <span>{market2Enabled ? 'ON' : 'OFF'}</span>
                                            <span className="switch">
                                                <span className="knob" />
                                            </span>
                                        </button>
                                    </div>
                                </div>

                                {market2Enabled && (
                                    <>
                                        <div className="auto-trades-market__config">
                                            <div className="auto-trades-market__field">
                                                <label>Market</label>
                                                <select
                                                    className="input input--select"
                                                    value={market2Symbol}
                                                    onChange={e => setMarket2Symbol(e.target.value)}
                                                    disabled={isRunning || scanAllMarkets}
                                                >
                                                    {AUTO_MARKETS.map(m => (
                                                        <option key={m.symbol} value={m.symbol}>{m.label}</option>
                                                    ))}
                                                </select>
                                            </div>
                                            <div className="auto-trades-market__field">
                                                <label>Contract Type</label>
                                                <select
                                                    className="input input--select"
                                                    value={market2TradeType}
                                                    onChange={e => setMarket2TradeType(e.target.value as TradeType)}
                                                    disabled={isRunning}
                                                >
                                                    <optgroup label="Over/Under">
                                                        <option value="DIGITOVER">Over</option>
                                                        <option value="DIGITUNDER">Under</option>
                                                    </optgroup>
                                                    <optgroup label="Even/Odd">
                                                        <option value="DIGITEVEN">Even</option>
                                                        <option value="DIGITODD">Odd</option>
                                                    </optgroup>
                                                    <optgroup label="Match/Diff">
                                                        <option value="DIGITMATCH">Matches</option>
                                                        <option value="DIGITDIFF">Differs</option>
                                                    </optgroup>
                                                    <optgroup label="Direction">
                                                        <option value="CALL">Rise</option>
                                                        <option value="PUT">Fall</option>
                                                        <option value="RUNHIGH">Only Ups</option>
                                                        <option value="RUNLOW">Only Downs</option>
                                                    </optgroup>
                                                </select>
                                            </div>

                                            {(market2TradeType === 'DIGITOVER' || market2TradeType === 'DIGITUNDER') && (
                                                <>
                                                    <div className="auto-trades-market__field">
                                                        <label>Last Ticks</label>
                                                        <select
                                                            className="input input--select"
                                                            value={market2AnalysisTicks}
                                                            onChange={e => setMarket2AnalysisTicks(e.target.value)}
                                                            disabled={isRunning}
                                                        >
                                                            {Array.from({ length: MAX_ANALYSIS_TICKS }, (_, i) => i + 1).map(d => (
                                                                <option key={d} value={String(d)}>{d}</option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                    <div className="auto-trades-market__field">
                                                        <label>Operator</label>
                                                        <select
                                                            className="input input--select"
                                                            value={market2ComparisonOperator}
                                                            onChange={e => setMarket2ComparisonOperator(e.target.value as ComparisonOperator)}
                                                            disabled={isRunning}
                                                        >
                                                            <option value=">">&gt;</option>
                                                            <option value="<">&lt;</option>
                                                            <option value=">=">&gt;=</option>
                                                            <option value="<=">&lt;=</option>
                                                            <option value="==">==</option>
                                                        </select>
                                                    </div>
                                                    <div className="auto-trades-market__field">
                                                        <label>Compare Digit</label>
                                                        <select
                                                            className="input input--select"
                                                            value={market2Barrier}
                                                            onChange={e => setMarket2Barrier(e.target.value)}
                                                            disabled={isRunning}
                                                        >
                                                            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => (
                                                                <option key={d} value={String(d)}>{d}</option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                    {usesLossPrediction(market2TradeType) && (
                                                        <div className="auto-trades-market__field">
                                                            <label>Predict Digit</label>
                                                            <select
                                                                className="input input--select"
                                                                value={market2PredictionDigit}
                                                                onChange={e => setMarket2PredictionDigit(e.target.value)}
                                                                disabled={isRunning}
                                                            >
                                                                {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => (
                                                                    <option key={d} value={String(d)}>{d}</option>
                                                                ))}
                                                            </select>
                                                        </div>
                                                    )}
                                                </>
                                            )}

                                            {(market2TradeType === 'DIGITEVEN' || market2TradeType === 'DIGITODD') && (
                                                <div className="auto-trades-market__field">
                                                    <label>Pattern (E=Even, O=Odd)</label>
                                                    <Input
                                                        type="text"
                                                        placeholder="e.g., EEO, OEE"
                                                        value={market2InputSequence}
                                                        onChange={e => setMarket2InputSequence(e.target.value.toUpperCase().replace(/[^EO]/g, ''))}
                                                        disabled={isRunning}
                                                        className="input"
                                                    />
                                                    {market2InputSequence && (
                                                        <div className="sequence-preview">
                                                            {market2InputSequence.split('').map((ch, i) => (
                                                                <span key={i} className={`char ${ch === 'E' ? 'even' : 'odd'}`}>
                                                                    {ch === 'E' ? 'Even' : 'Odd'}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            )}

                                            {(market2TradeType === 'DIGITMATCH' || market2TradeType === 'DIGITDIFF') && (
                                                <>
                                                    <div className="auto-trades-market__field">
                                                        <label>Digit</label>
                                                        <select
                                                            className="input input--select"
                                                            value={market2Barrier}
                                                            onChange={e => setMarket2Barrier(e.target.value)}
                                                            disabled={isRunning}
                                                        >
                                                            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => (
                                                                <option key={d} value={String(d)}>{d}</option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                    <div className="auto-trades-market__field">
                                                        <label>Analysis Ticks</label>
                                                        <select
                                                            className="input input--select"
                                                            value={market2AnalysisTicks}
                                                            onChange={e => setMarket2AnalysisTicks(e.target.value)}
                                                            disabled={isRunning}
                                                        >
                                                            {Array.from({ length: MAX_ANALYSIS_TICKS }, (_, i) => i + 1).map(d => (
                                                                <option key={d} value={String(d)}>{d}</option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                </>
                                            )}

                                            <div className="auto-trades-market__field">
                                                <label>Inverse</label>
                                                <button
                                                    type="button"
                                                    className={classNames(
                                                        'auto-trades-global__toggle',
                                                        market2Inverse && 'auto-trades-global__toggle--active'
                                                    )}
                                                    onClick={() => setMarket2Inverse(prev => !prev)}
                                                    disabled={isRunning}
                                                >
                                                    <span>{market2Inverse ? '🔀 Inverse' : '→ Direct'}</span>
                                                    <span className="switch">
                                                        <span className="knob" />
                                                    </span>
                                                </button>
                                            </div>
                                        </div>

                                        {/* Live Display */}
                                        {marketDisplays.find(m => m.symbol === market2Symbol) && (
                                            <div className="auto-trades-market__live">
                                                <div className="quote">
                                                    {marketDisplays.find(m => m.symbol === market2Symbol)?.lastQuote !== null
                                                        ? marketDisplays.find(m => m.symbol === market2Symbol)?.lastQuote?.toFixed(marketDisplays.find(m => m.symbol === market2Symbol)?.pip || 2)
                                                        : '—'}
                                                </div>
                                                <div className="info">
                                                    <span className="streak">
                                                        Streak: {marketDisplays.find(m => m.symbol === market2Symbol)?.consecutive || 0}
                                                    </span>
                                                    <span className="stake">
                                                        Stake: {marketDisplays.find(m => m.symbol === market2Symbol)?.currentStake || baseStakeNum}
                                                        {marketDisplays.find(m => m.symbol === market2Symbol)?.martingaleMultiplier && marketDisplays.find(m => m.symbol === market2Symbol)?.martingaleMultiplier !== 1 &&
                                                            ` (×${marketDisplays.find(m => m.symbol === market2Symbol)?.martingaleMultiplier?.toFixed(2)})`
                                                        }
                                                    </span>
                                                    <span className={classNames('result', {
                                                        'result--win': marketDisplays.find(m => m.symbol === market2Symbol)?.lastResult === 'win',
                                                        'result--loss': marketDisplays.find(m => m.symbol === market2Symbol)?.lastResult === 'loss',
                                                    })}>
                                                        {marketDisplays.find(m => m.symbol === market2Symbol)?.lastResult === 'win' ? '✓' :
                                                            marketDisplays.find(m => m.symbol === market2Symbol)?.lastResult === 'loss' ? '✗' : '—'}
                                                    </span>
                                                </div>
                                                {marketDisplays.find(m => m.symbol === market2Symbol)?.lastDigits.length > 0 && (
                                                    <div className="digits">
                                                        {marketDisplays.find(m => m.symbol === market2Symbol)?.lastDigits.slice(-5).map((d, idx) => (
                                                            <span key={idx} className="digit">{d}</span>
                                                        ))}
                                                    </div>
                                                )}
                                                <div className="meta">
                                                    <span className="candle">
                                                        5m: {getCandleDirectionLabel(marketDisplays.find(m => m.symbol === market2Symbol)?.candleDirection || 0)}
                                                    </span>
                                                    <span className={classNames('status', {
                                                        'status--buying': marketDisplays.find(m => m.symbol === market2Symbol)?.trading,
                                                        'status--cooldown': marketDisplays.find(m => m.symbol === market2Symbol)?.lossCooldownLeft > 0,
                                                        'status--ready': marketDisplays.find(m => m.symbol === market2Symbol)?.consecutive && marketDisplays.find(m => m.symbol === market2Symbol)?.consecutive >= Math.min(MAX_STREAK_LENGTH, Math.max(1, Number(market2AnalysisTicks) || 1)),
                                                        'status--waiting': !marketDisplays.find(m => m.symbol === market2Symbol)?.trading &&
                                                            !(marketDisplays.find(m => m.symbol === market2Symbol)?.lossCooldownLeft > 0) &&
                                                            !(marketDisplays.find(m => m.symbol === market2Symbol)?.consecutive && marketDisplays.find(m => m.symbol === market2Symbol)?.consecutive >= Math.min(MAX_STREAK_LENGTH, Math.max(1, Number(market2AnalysisTicks) || 1))),
                                                    })}>
                                                        {marketDisplays.find(m => m.symbol === market2Symbol)?.trading ? '🔄 Buying...' :
                                                            marketDisplays.find(m => m.symbol === market2Symbol)?.lossCooldownLeft > 0 ? `⏳ Cooldown ${marketDisplays.find(m => m.symbol === market2Symbol)?.lossCooldownLeft}t` :
                                                                marketDisplays.find(m => m.symbol === market2Symbol)?.consecutive && marketDisplays.find(m => m.symbol === market2Symbol)?.consecutive >= Math.min(MAX_STREAK_LENGTH, Math.max(1, Number(market2AnalysisTicks) || 1)) ? '✅ Ready' : '⏳ Waiting'}
                                                    </span>
                                                </div>
                                            </div>
                                        )}

                                        {/* Analysis */}
                                        {renderAnalysisContainer(market2Symbol, market2Config)}
                                    </>
                                )}
                            </div>
                        </div>

                        {/* Controls - moved to bottom */}
                        <div className="auto-trades-controls">
                            {!isRunning ? (
                                <button
                                    className="btn btn--start"
                                    onClick={handleRun}
                                    disabled={!client.is_logged_in || !hasEnabledMarkets}
                                >
                                    ▶ Start Trading
                                </button>
                            ) : (
                                <button className="btn btn--stop" onClick={handleStop}>
                                    ■ Stop Trading
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </ThemedScrollbars>

            {/* Disclaimer */}
            <button className="auto-trades-disclaimer" onClick={() => setShowDisclaimer(true)}>
                ⚠ Risk Disclaimer
            </button>

            {showDisclaimer && (
                <div className="auto-trades-disclaimer__overlay" onClick={() => setShowDisclaimer(false)}>
                    <div className="auto-trades-disclaimer__modal" onClick={e => e.stopPropagation()}>
                        <div className="auto-trades-disclaimer__modal-header">
                            <span className="icon">⚠</span>
                            <h3 className="title">Risk Disclaimer</h3>
                            <button className="close" onClick={() => setShowDisclaimer(false)}>✕</button>
                        </div>
                        <div className="auto-trades-disclaimer__modal-body">
                            <p>
                                Deriv offers complex derivatives, such as options and contracts for difference
                                (&ldquo;CFDs&rdquo;). These products may not be suitable for all clients, and trading
                                them puts you at risk. Please make sure that you understand the following risks before
                                trading Deriv products:
                            </p>
                            <ul>
                                <li>You may lose some or all of the money you invest in the trade.</li>
                                <li>
                                    If your trade involves currency conversion, exchange rates will affect your profit
                                    and loss.
                                </li>
                                <li>
                                    You should never trade with borrowed money or with money you cannot afford to lose.
                                </li>
                            </ul>
                        </div>
                        <div className="auto-trades-disclaimer__modal-footer">
                            <button className="ok" onClick={() => setShowDisclaimer(false)}>
                                I Understand
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
});

export default AutoTrades;
