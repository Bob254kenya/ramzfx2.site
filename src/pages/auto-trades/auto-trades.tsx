// auto-trades.tsx
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import Input from '@/components/shared_ui/input';
import ThemedScrollbars from '@/components/shared_ui/themed-scrollbars';
import { DBOT_TABS } from '@/constants/bot-contents';
import { contract_stages } from '@/constants/contract-stage';
import { api_base, observer as globalObserver } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import { conditionNotifierStore } from '@/stores/condition-notifier-store';
import {
    SUPPORTED_VOLATILITY_MARKETS,
    type DigitStrategyId,
} from '@/utils/digit-strategy';
import { recordDiagnosticEvent, setDiagnosticGauge } from '@/utils/diagnostics';
import { getLastDigitFromQuote, getMarketPipSize, isExpectedStreamInterruption } from '@/utils/market-data';
import { buyContractForUi, streamContractUntilSettled } from '@/utils/trade-purchase';
import { safeSubscribe } from '@/utils/websocket-handler';
import './auto-trades.scss';

// ── Constants ────────────────────────────────────────────────────────────────

type MartingaleModeType =
    | 'no_martingale'
    | 'after_one_loss'
    | 'after_two_losses'
    | 'custom_consecutive_loss_trigger';

type AutoMarket = { symbol: string; label: string; pip: number };
type Direction = 1 | -1 | 0;

const FIVE_MINUTE_GRANULARITY = 300;
const DATA_SILENCE_RESTART_MS = 15000;
const DATA_RESTART_COOLDOWN_MS = 10000;
const UI_REFRESH_THROTTLE_MS = 80;
const MARKET_LOSS_COOLDOWN_TICKS = 60;
const MAX_STREAK_LENGTH = 10;
const MAX_ANALYSIS_TICKS = 10;

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

const INVERSE_TRADE_TYPE: Record<TradeType, TradeType> = {
    DIGITOVER: 'DIGITUNDER',
    DIGITUNDER: 'DIGITOVER',
    DIGITEVEN: 'DIGITODD',
    DIGITODD: 'DIGITEVEN',
    DIGITMATCH: 'DIGITDIFF',
    DIGITDIFF: 'DIGITMATCH',
    CALL: 'PUT',
    PUT: 'CALL',
    RUNHIGH: 'RUNLOW',
    RUNLOW: 'RUNHIGH',
};

const DEFAULT_BARRIER: Record<TradeType, string> = {
    DIGITOVER: '4',
    DIGITUNDER: '5',
    DIGITEVEN: '4',
    DIGITODD: '4',
    DIGITMATCH: '4',
    DIGITDIFF: '4',
    CALL: '4',
    PUT: '4',
    RUNHIGH: '4',
    RUNLOW: '4',
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

const normalizeMartingaleMode = (value: unknown): MartingaleModeType => {
    if (value === 'no_martingale') return 'no_martingale';
    if (value === 'after_two_losses') return 'after_two_losses';
    if (value === 'custom_consecutive_loss_trigger' || value === 'consecutive_loss_trigger') {
        return 'custom_consecutive_loss_trigger';
    }
    return 'after_one_loss';
};

const clampConsecutiveLossThreshold = (value: unknown) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 2;
    return Math.min(10, Math.max(1, Math.trunc(numeric)));
};

const getEffectiveSignalStreak = ({
    trade_type,
    configured_streak,
}: {
    trade_type: TradeType;
    configured_streak: number;
}) => {
    const normalizedStreak = Math.min(MAX_STREAK_LENGTH, Math.max(1, Math.trunc(configured_streak) || 4));
    return usesLossPrediction(trade_type) ? Math.max(3, normalizedStreak) : normalizedStreak;
};

const getCandleDirectionLabel = (direction: Direction) => {
    if (direction === 1) return 'Bullish';
    if (direction === -1) return 'Bearish';
    return 'Waiting';
};

// ── Types ──────────────────────────────────────────────────────────────────

interface MarketConfig {
    marketSymbol: string;
    tradeType: TradeType;
    barrier: string;
    predictionDigit: string; // Unified prediction digit
    streak: string;
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
    ...prev,
});

// ── Signal Detection ──────────────────────────────────────────────────────

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
    if (trade_type === 'DIGITOVER') return inverse ? digit > barrier : digit <= barrier;
    if (trade_type === 'DIGITUNDER') return inverse ? digit < barrier : digit >= barrier;
    if (trade_type === 'DIGITEVEN') return inverse ? digit % 2 === 0 : digit % 2 !== 0;
    if (trade_type === 'DIGITODD') return inverse ? digit % 2 !== 0 : digit % 2 === 0;
    if (trade_type === 'DIGITMATCH') return inverse ? digit === barrier : digit !== barrier;
    if (trade_type === 'DIGITDIFF') return inverse ? digit !== barrier : digit === barrier;
    return false;
};

const hasRequiredDigitStreak = ({
    trade_type,
    digits,
    barrier,
    inverse,
    streak,
}: {
    trade_type: TradeType;
    digits: number[];
    barrier: number;
    inverse: boolean;
    streak: number;
}) => {
    if (digits.length < streak) return false;
    return digits
        .slice(-streak)
        .every(digit => isDigitSignalMatch({ trade_type, digit, barrier, inverse }));
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

// ── Martingale Logic ──────────────────────────────────────────────────────

const getNextMartingaleState = ({
    profit,
    current_stake,
    base_stake,
    multiplier,
    martingale_mode,
    consecutive_losses,
    consecutive_loss_trigger,
}: {
    profit: number;
    current_stake: number;
    base_stake: number;
    multiplier: number;
    martingale_mode: MartingaleModeType;
    consecutive_losses: number;
    consecutive_loss_trigger: number;
}) => {
    // If profit is positive (win), reset everything
    if (profit >= 0) {
        return {
            consecutiveLosses: 0,
            lastResult: 'win' as const,
            nextStake: base_stake,
            martingaleMultiplier: 1,
        };
    }

    // Loss occurred
    const nextConsecutiveLosses = consecutive_losses + 1;
    const normalizedMode = normalizeMartingaleMode(martingale_mode);
    const normalizedTrigger = clampConsecutiveLossThreshold(consecutive_loss_trigger);

    // No martingale - keep base stake
    if (normalizedMode === 'no_martingale') {
        return {
            consecutiveLosses: nextConsecutiveLosses,
            lastResult: 'loss' as const,
            nextStake: base_stake,
            martingaleMultiplier: 1,
        };
    }

    // Determine if martingale should be applied based on consecutive losses
    let shouldApplyMartingale = false;
    let martingaleMultiplier = 1;

    if (normalizedMode === 'after_one_loss') {
        shouldApplyMartingale = true;
        martingaleMultiplier = multiplier;
    } else if (normalizedMode === 'after_two_losses') {
        shouldApplyMartingale = nextConsecutiveLosses >= 2;
        martingaleMultiplier = shouldApplyMartingale ? Math.pow(multiplier, nextConsecutiveLosses - 1) : 1;
    } else if (normalizedMode === 'custom_consecutive_loss_trigger') {
        shouldApplyMartingale = nextConsecutiveLosses >= normalizedTrigger;
        martingaleMultiplier = shouldApplyMartingale ? Math.pow(multiplier, nextConsecutiveLosses - normalizedTrigger + 1) : 1;
    }

    const nextStake = shouldApplyMartingale 
        ? parseFloat((base_stake * martingaleMultiplier).toFixed(2))
        : base_stake;

    return {
        consecutiveLosses: nextConsecutiveLosses,
        lastResult: 'loss' as const,
        nextStake: nextStake,
        martingaleMultiplier: martingaleMultiplier,
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

    const [stake, setStake] = useState(() => loadSavedNum('stake', '1', 0.01, 100000));
    const [martingale, setMartingale] = useState(() => loadSavedNum('martingale', '2', 1.01, 100));
    const [takeProfit, setTakeProfit] = useState(() => loadSavedNum('takeProfit', '100', 1, 1000000));
    const [stopLoss, setStopLoss] = useState(() => loadSavedNum('stopLoss', '100', 1, 1000000));
    const [martingaleMode, setMartingaleMode] = useState<MartingaleModeType>(() => {
        try {
            return normalizeMartingaleMode(localStorage.getItem('auto_trades_martingaleMode'));
        } catch {
            return 'after_one_loss';
        }
    });
    const [consecutiveLossCount, setConsecutiveLossCount] = useState(() => {
        try {
            const saved = localStorage.getItem('auto_trades_consecutiveLossCount');
            return clampConsecutiveLossThreshold(saved || 2);
        } catch {
            return 2;
        }
    });
    const [consecutiveLossCountInput, setConsecutiveLossCountInput] = useState(() =>
        String(clampConsecutiveLossThreshold(localStorage.getItem('auto_trades_consecutiveLossCount') || 2))
    );

    // Market switching feature
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
    const [market1Streak, setMarket1Streak] = useState(() => loadSavedNum('market1_streak', '4', 1, MAX_STREAK_LENGTH));
    const [market1AnalysisTicks, setMarket1AnalysisTicks] = useState(() => 
        loadSavedNum('market1_analysisTicks', '1', 1, MAX_ANALYSIS_TICKS)
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
    const [market2Streak, setMarket2Streak] = useState(() => loadSavedNum('market2_streak', '4', 1, MAX_STREAK_LENGTH));
    const [market2AnalysisTicks, setMarket2AnalysisTicks] = useState(() => 
        loadSavedNum('market2_analysisTicks', '1', 1, MAX_ANALYSIS_TICKS)
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
    const [activeTradingMarket, setActiveTradingMarket] = useState<'market1' | 'market2' | null>('market1');

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
    const handleTickRef = useRef<(symbol: string, tick: any) => void>(() => {});
    const handleCandleRef = useRef<(symbol: string, candle: any) => void>(() => {});
    const stopTradingRef = useRef<() => void>(() => {});
    const selectedMarketsRef = useRef<string[]>([]);
    const lastResultRef = useRef<Record<string, 'win' | 'loss' | null>>({});
    const marketSwitchActiveRef = useRef<boolean>(false);

    // ── Update Refs ──────────────────────────────────────────────────────

    useEffect(() => {
        show_auto_ref.current = show_auto;
    }, [show_auto]);

    useEffect(() => {
        const markets: string[] = [];
        if (market1Enabled) markets.push(market1Symbol);
        if (market2Enabled) markets.push(market2Symbol);
        
        if (scanAllMarkets) {
            selectedMarketsRef.current = AUTO_MARKET_SYMBOLS;
        } else {
            selectedMarketsRef.current = markets;
        }
    }, [market1Symbol, market2Symbol, market1Enabled, market2Enabled, scanAllMarkets]);

    // ── Market Configs ────────────────────────────────────────────────────

    const market1Config: MarketConfig = {
        marketSymbol: market1Symbol,
        tradeType: market1TradeType,
        barrier: market1Barrier,
        predictionDigit: market1PredictionDigit,
        streak: market1Streak,
        analysisTicks: market1AnalysisTicks,
        inverseMode: market1Inverse,
        enabled: market1Enabled,
    };

    const market2Config: MarketConfig = {
        marketSymbol: market2Symbol,
        tradeType: market2TradeType,
        barrier: market2Barrier,
        predictionDigit: market2PredictionDigit,
        streak: market2Streak,
        analysisTicks: market2AnalysisTicks,
        inverseMode: market2Inverse,
        enabled: market2Enabled,
    };

    // Update market configs ref whenever settings change
    useEffect(() => {
        const configs: Record<string, MarketConfig> = {};
        
        if (market1Enabled) {
            configs[market1Symbol] = market1Config;
        }
        
        if (market2Enabled) {
            configs[market2Symbol] = market2Config;
        }
        
        // If scan all markets, add config for all markets with default settings from market1
        if (scanAllMarkets) {
            AUTO_MARKET_SYMBOLS.forEach(symbol => {
                if (!configs[symbol]) {
                    configs[symbol] = {
                        marketSymbol: symbol,
                        tradeType: market1TradeType,
                        barrier: market1Barrier,
                        predictionDigit: market1PredictionDigit,
                        streak: market1Streak,
                        analysisTicks: market1AnalysisTicks,
                        inverseMode: false,
                        enabled: true,
                    };
                }
            });
        }
        
        marketConfigsRef.current = configs;
    }, [
        market1Symbol, market2Symbol, market1Config, market2Config,
        market1Enabled, market2Enabled, scanAllMarkets,
        market1TradeType, market1Barrier, market1PredictionDigit,
        market1Streak, market1AnalysisTicks
    ]);

    // ── Save to LocalStorage ─────────────────────────────────────────────

    useEffect(() => {
        try {
            localStorage.setItem('auto_trades_market1_tradeType', market1TradeType);
            localStorage.setItem('auto_trades_market1_barrier', market1Barrier);
            localStorage.setItem('auto_trades_market1_predictionDigit', market1PredictionDigit);
            localStorage.setItem('auto_trades_market1_streak', market1Streak);
            localStorage.setItem('auto_trades_market1_analysisTicks', market1AnalysisTicks);
            localStorage.setItem('auto_trades_market1_inverse', String(market1Inverse));
            localStorage.setItem('auto_trades_market1_enabled', String(market1Enabled));
            
            localStorage.setItem('auto_trades_market2_tradeType', market2TradeType);
            localStorage.setItem('auto_trades_market2_barrier', market2Barrier);
            localStorage.setItem('auto_trades_market2_predictionDigit', market2PredictionDigit);
            localStorage.setItem('auto_trades_market2_streak', market2Streak);
            localStorage.setItem('auto_trades_market2_analysisTicks', market2AnalysisTicks);
            localStorage.setItem('auto_trades_market2_inverse', String(market2Inverse));
            localStorage.setItem('auto_trades_market2_enabled', String(market2Enabled));
            
            localStorage.setItem('auto_trades_stake', stake);
            localStorage.setItem('auto_trades_martingale', martingale);
            localStorage.setItem('auto_trades_takeProfit', takeProfit);
            localStorage.setItem('auto_trades_stopLoss', stopLoss);
            localStorage.setItem('auto_trades_martingaleMode', martingaleMode);
            localStorage.setItem('auto_trades_consecutiveLossCount', String(consecutiveLossCount));
            localStorage.setItem('auto_trades_switchOnLoss', String(switchOnLoss));
            localStorage.setItem('auto_trades_scanAllMarkets', String(scanAllMarkets));
            localStorage.setItem('auto_trades_markets', JSON.stringify([market1Symbol, market2Symbol]));
        } catch {
            // Ignore localStorage write failures.
        }
    }, [
        market1TradeType, market1Barrier, market1PredictionDigit,
        market1Streak, market1AnalysisTicks, market1Inverse, market1Enabled,
        market2TradeType, market2Barrier, market2PredictionDigit,
        market2Streak, market2AnalysisTicks, market2Inverse, market2Enabled,
        stake, martingale, takeProfit, stopLoss, martingaleMode, consecutiveLossCount,
        market1Symbol, market2Symbol, switchOnLoss, scanAllMarkets
    ]);

    // ── Core Logic Functions ─────────────────────────────────────────────

    const getActiveDigitBarrier = useCallback((symbol: string, lastResult: 'win' | 'loss' | null, consecutiveLosses = 0) => {
        const config = marketConfigsRef.current[symbol];
        if (!config) return 4;
        
        const ct = config.tradeType;
        if (!usesLossPrediction(ct)) return getDigitNumber(config.barrier, 4);
        
        // Always use the prediction digit
        const barrier = getDigitNumber(config.predictionDigit, 4);
        return barrier;
    }, []);

    const flushDisplays = useCallback(() => {
        if (unmountedRef.current || !show_auto_ref.current) return;
        lastUiRefreshAtRef.current = Date.now();
        // Force re-render by updating state
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

    // ── After Trade Handler ──────────────────────────────────────────────

    const handleAfterTrade = useCallback(
        (symbol: string, profit: number) => {
            if (!runningRef.current) return;
            const state = marketStatesRef.current[symbol];
            if (!state) return;

            const baseStake = Number(stake) || 1;
            const mult = Number(martingale) || 2;
            const tp = Number(takeProfit) || 100;
            const sl = Number(stopLoss) || 100;

            totalPnlRef.current = parseFloat((totalPnlRef.current + profit).toFixed(2));
            totalTradesRef.current++;

            const nextMartingaleState = getNextMartingaleState({
                profit,
                current_stake: state.currentStake || baseStake,
                base_stake: baseStake,
                multiplier: mult,
                martingale_mode: martingaleMode,
                consecutive_losses: state.consecutiveLosses || 0,
                consecutive_loss_trigger: consecutiveLossCount,
            });

            state.consecutiveLosses = nextMartingaleState.consecutiveLosses;
            state.lastResultType = nextMartingaleState.lastResult;
            state.lastResult = nextMartingaleState.lastResult;
            state.currentStake = nextMartingaleState.nextStake;
            state.martingaleMultiplier = nextMartingaleState.martingaleMultiplier || 1;
            state.lossCooldownLeft = profit < 0 ? MARKET_LOSS_COOLDOWN_TICKS : 0;
            state.tradeCount++;
            state.trading = false;
            globalTradingRef.current = false;

            // Store last result for market switching
            lastResultRef.current[symbol] = nextMartingaleState.lastResult;

            // ── Market Switching Logic ──────────────────────────────────
            if (switchOnLoss && market1Enabled && market2Enabled) {
                // Determine which market to switch to
                const isMarket1 = symbol === market1Symbol;
                const isMarket2 = symbol === market2Symbol;
                
                if (profit < 0) {
                    // On loss, switch to the other market
                    if (isMarket1) {
                        marketSwitchActiveRef.current = true;
                        setActiveTradingMarket('market2');
                    } else if (isMarket2) {
                        marketSwitchActiveRef.current = true;
                        setActiveTradingMarket('market1');
                    }
                } else if (profit >= 0 && marketSwitchActiveRef.current) {
                    // On win after switching, reset to primary market (market1)
                    setActiveTradingMarket('market1');
                    marketSwitchActiveRef.current = false;
                }
            }

            if (!unmountedRef.current) {
                refreshDisplays();
                setTotalPnl(totalPnlRef.current);
                setTotalTrades(totalTradesRef.current);
            }

            // Check profit/loss limits
            if ((totalPnlRef.current >= tp || totalPnlRef.current <= -sl) && runningRef.current) {
                runningRef.current = false;
                if (!unmountedRef.current) {
                    setIsRunning(false);
                }
                completeRunPanelStop();
            }
        },
        [completeRunPanelStop, refreshDisplays, stake, martingale, takeProfit, stopLoss, martingaleMode, consecutiveLossCount, switchOnLoss, market1Enabled, market2Enabled, market1Symbol, market2Symbol]
    );

    // ── Try Execute Signal ───────────────────────────────────────────────

    const tryExecuteSignal = useCallback(
        (symbol: string, state: MarketState, signalReady: boolean) => {
            // Check if this market should be trading based on market switching
            let shouldTrade = false;
            
            if (switchOnLoss && market1Enabled && market2Enabled) {
                // If market switching is enabled, only trade the active market
                if (activeTradingMarket === 'market1' && symbol === market1Symbol) {
                    shouldTrade = true;
                } else if (activeTradingMarket === 'market2' && symbol === market2Symbol) {
                    shouldTrade = true;
                }
            } else {
                // Otherwise trade all enabled markets
                if (symbol === market1Symbol && market1Enabled) shouldTrade = true;
                if (symbol === market2Symbol && market2Enabled) shouldTrade = true;
                if (scanAllMarkets) shouldTrade = true;
            }

            if (
                runningRef.current &&
                signalReady &&
                !state.trading &&
                !globalTradingRef.current &&
                state.lossCooldownLeft === 0 &&
                client.is_logged_in &&
                shouldTrade
            ) {
                state.trading = true;
                state.consecutive = 0;
                globalTradingRef.current = true;
                state.tradeStartTime = Math.floor(Date.now() / 1000);
                state.verificationId = `${symbol}_${state.tradeStartTime}_${Math.random().toString(36).substring(2, 11)}`;

                // Use the current stake from state
                const stakeNow = state.currentStake || Number(stake) || 1;

                if (stakeNow <= 0 || isNaN(stakeNow)) {
                    console.error(`[AutoTrades] Sanity check failed: Invalid stake amount ${stakeNow} for ${symbol}`);
                    state.trading = false;
                    globalTradingRef.current = false;
                    setError('Auto Trades stopped because the stake amount is invalid.');
                    refreshDisplays();
                    return;
                }

                executeTrade(symbol, stakeNow, state.lastResultType).then(profit =>
                    handleAfterTrade(symbol, profit)
                );
            }
        },
        [client.is_logged_in, executeTrade, handleAfterTrade, refreshDisplays, stake, switchOnLoss, activeTradingMarket, market1Symbol, market2Symbol, market1Enabled, market2Enabled, scanAllMarkets]
    );

    // ── Tick Handler ─────────────────────────────────────────────────────

    const handleTick = useCallback(
        (symbol: string, tick: any) => {
            const config = marketConfigsRef.current[symbol];
            if (!config || !config.enabled) {
                if (!scanAllMarkets) return;
            }
            
            const state = marketStatesRef.current[symbol];
            if (!state) return;

            const pip = getMarketPipSize(symbol, AUTO_MARKET_LOOKUP.get(symbol)?.pip ?? 2);
            const quote = tick.quote as number;
            const ct = config.tradeType;
            const targetLen = getEffectiveSignalStreak({
                trade_type: ct,
                configured_streak: getDigitNumber(config.streak, 4),
            });

            state.lastQuote = quote;
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
                state.lastDigits = [...state.lastDigits.slice(-9), lastDigit];
                state.prevQuote = quote;

                const match = isDigitSignalMatch({
                    trade_type: ct,
                    digit: lastDigit,
                    barrier: bar,
                    inverse: inv,
                });

                if (match) {
                    state.consecutive = Math.min(state.consecutive + 1, MAX_STREAK_LENGTH);
                } else {
                    state.consecutive = 0;
                }
            }

            // Candle condition
            const candleMatch = isCandleConfirmedTradeType(ct) 
                ? (inv ? isCandleMatch(ct, state.candleDirection) : isCandleMatch(ct, state.candleDirection))
                : true;

            const riskFilteredDigitStreakReady =
                !usesLossPrediction(ct) ||
                hasRequiredDigitStreak({
                    trade_type: ct,
                    digits: state.lastDigits,
                    barrier: bar,
                    inverse: inv,
                    streak: targetLen,
                });

            const signalReady = state.consecutive >= targetLen && 
                riskFilteredDigitStreakReady && 
                candleMatch;

            // Update condition notifier
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
                condStr = `${invLabel}${label} ${bar} streak ${targetLen}+`;
            }

            conditionNotifierStore.setCondition({
                market: mkt?.label ?? symbol,
                condition: condStr,
                digits: digitsStr,
                result: signalReady,
                source: 'auto',
                timestamp: Date.now(),
            });

            tryExecuteSignal(symbol, state, signalReady);

            refreshDisplays();
        },
        [clearDataRecoveryLoading, getActiveDigitBarrier, refreshDisplays, tryExecuteSignal, scanAllMarkets]
    );

    handleTickRef.current = handleTick;

    // ── Candle Handler ────────────────────────────────────────────────────

    const handleCandle = useCallback(
        (symbol: string, candle: any) => {
            const config = marketConfigsRef.current[symbol];
            if (!config || !config.enabled) {
                if (!scanAllMarkets) return;
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
            const signalReady =
                isCandleConfirmedTradeType(ct) &&
                state.consecutive >= getEffectiveSignalStreak({
                    trade_type: ct,
                    configured_streak: getDigitNumber(config.streak, 4),
                }) &&
                (inv ? isCandleMatch(ct, state.candleDirection) : isCandleMatch(ct, state.candleDirection));

            tryExecuteSignal(symbol, state, signalReady);

            refreshDisplays();
        },
        [refreshDisplays, tryExecuteSignal, scanAllMarkets]
    );

    handleCandleRef.current = handleCandle;

    // ── Start Subscriptions ──────────────────────────────────────────────

    const startSubscriptions = useCallback(async () => {
        const subscriptionVersion = subscriptionVersionRef.current;
        let marketsToMonitor: string[] = [];
        
        if (scanAllMarkets) {
            marketsToMonitor = AUTO_MARKET_SYMBOLS;
        } else {
            if (market1Enabled) marketsToMonitor.push(market1Symbol);
            if (market2Enabled) marketsToMonitor.push(market2Symbol);
        }
        
        const monitoredSymbolSet = new Set(marketsToMonitor);

        // Clean up subscriptions for markets no longer monitored
        Object.entries(subscriptionsRef.current).forEach(([symbol, sub]) => {
            if (!monitoredSymbolSet.has(symbol)) {
                try {
                    sub?.unsubscribe?.();
                } catch {
                    // Ignore unsubscribe failures.
                }
                delete subscriptionsRef.current[symbol];
                updateSubscriptionDiagnostics();
            }
        });

        Object.entries(candleSubscriptionsRef.current).forEach(([symbol, sub]) => {
            if (!monitoredSymbolSet.has(symbol)) {
                try {
                    sub?.unsubscribe?.();
                } catch {
                    // Ignore unsubscribe failures.
                }
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
        
        // Reset states for all markets
        AUTO_MARKET_SYMBOLS.forEach(symbol => {
            marketStatesRef.current[symbol] = createMarketState({ 
                currentStake: baseStake,
                baseStake: baseStake,
                martingaleMultiplier: 1
            });
        });
        
        totalPnlRef.current = 0;
        totalTradesRef.current = 0;
        setTotalPnl(0);
        setTotalTrades(0);
        setError(null);
        setActiveTradingMarket('market1');
        marketSwitchActiveRef.current = false;
        lastResultRef.current = {};
        refreshDisplays();
    }, [refreshDisplays, stake]);

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
        clearDeferredWork();
        Object.values(marketStatesRef.current).forEach(state => {
            state.trading = false;
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

    // Subscribe to data when component mounts or markets change
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

    // Data silence watchdog
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

    // Cleanup on unmount
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
            });
        };
    }, [clearDeferredWork, run_panel, stopTrading, stopSubscriptions]);

    // Register stop handler
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
            displaySymbols.push(...AUTO_MARKET_SYMBOLS);
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

    // ── Render ────────────────────────────────────────────────────────────

    if (!show_auto) return null;

    const pnlPositive = totalPnl > 0;
    const pnlNegative = totalPnl < 0;
    const baseStakeNum = Number(stake) || 1;
    const martingaleActive = marketDisplays.some(m => m.currentStake > baseStakeNum);
    const inCooldown = marketDisplays.some(m => m.lossCooldownLeft > 0);
    const hasAnyLiveQuote = marketDisplays.some(m => m.lastQuote !== null);
    const isLoading = selectedMarketsRef.current.length > 0 && !hasAnyLiveQuote && (dataStreamLoading || !isConnected);

    return (
        <div className='auto-trades-page'>
            <ThemedScrollbars className='auto-trades-page__scroll'>
                <div className='auto-trades-page__inner'>
                    {/* Header */}
                    <div className='auto-trades-page__header'>
                        <div>
                            <h1 className='auto-trades-page__title'>⚡ Auto Trades</h1>
                            <p className='auto-trades-page__subtitle'>Trade two markets independently with custom strategies</p>
                        </div>
                        <div className='auto-trades-page__status-dot'>
                            <span
                                className={classNames('auto-trades-status', {
                                    'auto-trades-status--connected': isConnected && !inCooldown,
                                    'auto-trades-status--running': isRunning && !inCooldown,
                                    'auto-trades-status--cooldown': inCooldown,
                                    'auto-trades-status--loading': isLoading && !inCooldown,
                                })}
                            />
                            <span className='auto-trades-status__label'>
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
                        <div className='auto-trades-page__notice'>
                            Please log in to your Deriv account to execute real trades.
                        </div>
                    )}

                    {error && <div className='auto-trades-page__error'>{error}</div>}

                    {inCooldown && isRunning && (
                        <div className='auto-trades-cooldown'>
                            <span className='auto-trades-cooldown__icon'>⏳</span>
                            <span>Cooldown after consecutive loss — markets paused for <strong>{Math.max(...marketDisplays.map(m => m.lossCooldownLeft))}</strong> more ticks</span>
                        </div>
                    )}

                    {isLoading && (
                        <div className='auto-trades-page__loader'>
                            <div className='auto-trades-data-loader auto-trades-data-loader--panel'>
                                <span className='auto-trades-data-loader__spinner' />
                                <div className='auto-trades-data-loader__copy'>
                                    <strong>Waiting for live market data</strong>
                                    <span>{dataStreamMessage}</span>
                                </div>
                            </div>
                        </div>
                    )}

                    <div className='auto-trades-page__body'>
                        {/* Global Settings */}
                        <div className='auto-trades-page__global-settings'>
                            <div className='auto-trades-card auto-trades-card--global'>
                                <h2 className='auto-trades-card__title'>Global Settings</h2>
                                <div className='auto-trades-global-grid'>
                                    <div className='auto-trades-config__field'>
                                        <label>Base Stake ({currency || 'USD'})</label>
                                        <Input
                                            type='number'
                                            min='0.35'
                                            step='0.01'
                                            value={stake}
                                            onChange={e => setStake(e.target.value)}
                                            disabled={isRunning}
                                        />
                                        <small className='auto-trades-config__hint'>Initial stake amount</small>
                                    </div>
                                    <div className='auto-trades-config__field'>
                                        <label>Martingale ×</label>
                                        <Input
                                            type='number'
                                            min='1.01'
                                            step='0.5'
                                            value={martingale}
                                            onChange={e => setMartingale(e.target.value)}
                                            disabled={isRunning}
                                        />
                                        <small className='auto-trades-config__hint'>Multiplier after consecutive losses</small>
                                    </div>
                                    <div className='auto-trades-config__field'>
                                        <label>Take Profit ({currency || 'USD'})</label>
                                        <Input
                                            type='number'
                                            min='0'
                                            step='1'
                                            value={takeProfit}
                                            onChange={e => setTakeProfit(e.target.value)}
                                            disabled={isRunning}
                                        />
                                    </div>
                                    <div className='auto-trades-config__field'>
                                        <label>Stop Loss ({currency || 'USD'})</label>
                                        <Input
                                            type='number'
                                            min='0'
                                            step='1'
                                            value={stopLoss}
                                            onChange={e => setStopLoss(e.target.value)}
                                            disabled={isRunning}
                                        />
                                    </div>
                                </div>
                                <div className='auto-trades-global-features'>
                                    <div className='auto-trades-config__field auto-trades-config__field--feature'>
                                        <label>Market Switching</label>
                                        <div className='auto-trades-feature-toggle'>
                                            <button
                                                type='button'
                                                className={classNames(
                                                    'auto-trades-feature-btn',
                                                    switchOnLoss && 'auto-trades-feature-btn--active'
                                                )}
                                                onClick={() => setSwitchOnLoss(prev => !prev)}
                                                disabled={isRunning}
                                            >
                                                <span className='auto-trades-feature-btn__label'>
                                                    {switchOnLoss ? '🔄 Switch on Loss' : '→ No Switch'}
                                                </span>
                                                <span className='auto-trades-feature-btn__switch'>
                                                    <span className='auto-trades-feature-btn__knob' />
                                                </span>
                                            </button>
                                        </div>
                                        {switchOnLoss && (
                                            <div className='auto-trades-feature-info'>
                                                <small>Alternate markets on loss, reset to Primary on win</small>
                                                <small className='auto-trades-feature-info__active'>
                                                    Active: {activeTradingMarket === 'market1' ? '📈 Primary' : '📊 Market 2'}
                                                </small>
                                            </div>
                                        )}
                                    </div>
                                    <div className='auto-trades-config__field auto-trades-config__field--feature'>
                                        <label>Scan All Markets</label>
                                        <div className='auto-trades-feature-toggle'>
                                            <button
                                                type='button'
                                                className={classNames(
                                                    'auto-trades-feature-btn',
                                                    scanAllMarkets && 'auto-trades-feature-btn--active'
                                                )}
                                                onClick={() => setScanAllMarkets(prev => !prev)}
                                                disabled={isRunning}
                                            >
                                                <span className='auto-trades-feature-btn__label'>
                                                    {scanAllMarkets ? '🔍 Scanning All' : '→ Custom Markets'}
                                                </span>
                                                <span className='auto-trades-feature-btn__switch'>
                                                    <span className='auto-trades-feature-btn__knob' />
                                                </span>
                                            </button>
                                        </div>
                                        {scanAllMarkets && (
                                            <div className='auto-trades-feature-info'>
                                                <small>Monitoring all {AUTO_MARKET_SYMBOLS.length} volatility markets</small>
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <div className='auto-trades-config__field auto-trades-config__field--martingale'>
                                    <label>Martingale Mode</label>
                                    <select
                                        className='auto-trades-config__select'
                                        value={martingaleMode}
                                        onChange={e => setMartingaleMode(normalizeMartingaleMode(e.target.value))}
                                        disabled={isRunning}
                                    >
                                        <option value='no_martingale'>No Martingale</option>
                                        <option value='after_one_loss'>After 1 loss</option>
                                        <option value='after_two_losses'>After 2 losses</option>
                                        <option value='custom_consecutive_loss_trigger'>Custom loss count</option>
                                    </select>
                                    {martingaleMode === 'custom_consecutive_loss_trigger' && (
                                        <div className='auto-trades-config__field auto-trades-config__field--martingale-threshold'>
                                            <label>Consecutive losses before martingale</label>
                                            <Input
                                                type='number'
                                                min='1'
                                                max='10'
                                                step='1'
                                                value={consecutiveLossCountInput}
                                                inputMode='numeric'
                                                onChange={e => {
                                                    const val = e.target.value.replace(/[^\d]/g, '').slice(0, 2);
                                                    setConsecutiveLossCountInput(val);
                                                }}
                                                onBlur={() => {
                                                    setConsecutiveLossCount(clampConsecutiveLossThreshold(consecutiveLossCountInput || 2));
                                                }}
                                                disabled={isRunning}
                                            />
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Two Market Cards */}
                        <div className='auto-trades-page__markets'>
                            {/* Market 1 - Primary */}
                            <div className={classNames(
                                'auto-trades-card auto-trades-card--market auto-trades-card--market1',
                                !market1Enabled && 'auto-trades-card--disabled'
                            )}>
                                <div className='auto-trades-card__header'>
                                    <div className='auto-trades-card__title-wrapper'>
                                        <h2 className='auto-trades-card__title'>📈 Primary Market</h2>
                                        {switchOnLoss && activeTradingMarket === 'market1' && isRunning && (
                                            <span className='auto-trades-card__active-badge'>Active</span>
                                        )}
                                    </div>
                                    <div className='auto-trades-card__controls'>
                                        <button
                                            type='button'
                                            className={classNames(
                                                'auto-trades-market-toggle',
                                                market1Enabled && 'auto-trades-market-toggle--active'
                                            )}
                                            onClick={() => setMarket1Enabled(prev => !prev)}
                                            disabled={isRunning}
                                        >
                                            <span className='auto-trades-market-toggle__label'>
                                                {market1Enabled ? 'ON' : 'OFF'}
                                            </span>
                                            <span className='auto-trades-market-toggle__switch'>
                                                <span className='auto-trades-market-toggle__knob' />
                                            </span>
                                        </button>
                                        <div className='auto-trades-card__badge auto-trades-card__badge--market1'>Primary</div>
                                    </div>
                                </div>
                                {market1Enabled && (
                                    <>
                                        <div className='auto-trades-market-config'>
                                            <div className='auto-trades-config__field'>
                                                <label>Market</label>
                                                <select
                                                    className='auto-trades-config__select'
                                                    value={market1Symbol}
                                                    onChange={e => setMarket1Symbol(e.target.value)}
                                                    disabled={isRunning || scanAllMarkets}
                                                >
                                                    {AUTO_MARKETS.map(m => (
                                                        <option key={m.symbol} value={m.symbol}>{m.label}</option>
                                                    ))}
                                                </select>
                                            </div>
                                            <div className='auto-trades-config__field'>
                                                <label>Contract Type</label>
                                                <select
                                                    className='auto-trades-config__select'
                                                    value={market1TradeType}
                                                    onChange={e => setMarket1TradeType(e.target.value as TradeType)}
                                                    disabled={isRunning}
                                                >
                                                    <optgroup label='Digits'>
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
                                            {BARRIER_NEEDED[market1TradeType] && (
                                                <div className='auto-trades-config__field'>
                                                    <label>{market1TradeType === 'DIGITMATCH' || market1TradeType === 'DIGITDIFF' ? 'Prediction' : 'Digit'}</label>
                                                    <select
                                                        className='auto-trades-config__select'
                                                        value={market1Barrier}
                                                        onChange={e => setMarket1Barrier(e.target.value)}
                                                        disabled={isRunning}
                                                    >
                                                        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => (
                                                            <option key={d} value={String(d)}>{d}</option>
                                                        ))}
                                                    </select>
                                                </div>
                                            )}
                                            {usesLossPrediction(market1TradeType) && (
                                                <div className='auto-trades-config__field'>
                                                    <label>Digit to predict</label>
                                                    <select
                                                        className='auto-trades-config__select'
                                                        value={market1PredictionDigit}
                                                        onChange={e => setMarket1PredictionDigit(e.target.value)}
                                                        disabled={isRunning}
                                                    >
                                                        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => (
                                                            <option key={d} value={String(d)}>{d}</option>
                                                        ))}
                                                    </select>
                                                    <small className='auto-trades-config__hint'>Always uses this digit for predictions</small>
                                                </div>
                                            )}
                                            <div className='auto-trades-config__field'>
                                                <label>Streak length</label>
                                                <div className='auto-trades-config__streak-row'>
                                                    <input
                                                        className='auto-trades-config__streak-slider'
                                                        type='range'
                                                        min='1'
                                                        max={MAX_STREAK_LENGTH}
                                                        step='1'
                                                        value={market1Streak}
                                                        onChange={e => setMarket1Streak(e.target.value)}
                                                        disabled={isRunning}
                                                        style={{ '--pct': `${(Number(market1Streak) / MAX_STREAK_LENGTH) * 100}%` } as any}
                                                    />
                                                    <span className='auto-trades-config__streak-value'>{market1Streak}</span>
                                                </div>
                                            </div>
                                            <div className='auto-trades-config__field'>
                                                <label>Analysis ticks</label>
                                                <select
                                                    className='auto-trades-config__select'
                                                    value={market1AnalysisTicks}
                                                    onChange={e => setMarket1AnalysisTicks(e.target.value)}
                                                    disabled={isRunning}
                                                >
                                                    {Array.from({ length: MAX_ANALYSIS_TICKS }, (_, i) => i + 1).map(d => (
                                                        <option key={d} value={String(d)}>{d}</option>
                                                    ))}
                                                </select>
                                            </div>
                                            <div className='auto-trades-config__field'>
                                                <label>Inverse Mode</label>
                                                <div className='auto-trades-inverse-toggle'>
                                                    <button
                                                        type='button'
                                                        className={classNames(
                                                            'auto-trades-inverse-btn',
                                                            market1Inverse && 'auto-trades-inverse-btn--active'
                                                        )}
                                                        onClick={() => setMarket1Inverse(prev => !prev)}
                                                        disabled={isRunning}
                                                    >
                                                        <span className='auto-trades-inverse-btn__label'>
                                                            {market1Inverse ? '🔀 Inverse' : '→ Direct'}
                                                        </span>
                                                        <span className='auto-trades-inverse-btn__switch'>
                                                            <span className='auto-trades-inverse-btn__knob' />
                                                        </span>
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                        {/* Market 1 Live Display */}
                                        <div className='auto-trades-market-display'>
                                            {marketDisplays.find(m => m.symbol === market1Symbol) && (
                                                <div className='auto-trades-market-display__content'>
                                                    <div className='auto-trades-market-display__quote'>
                                                        {marketDisplays.find(m => m.symbol === market1Symbol)?.lastQuote !== null 
                                                            ? marketDisplays.find(m => m.symbol === market1Symbol)?.lastQuote?.toFixed(marketDisplays.find(m => m.symbol === market1Symbol)?.pip || 2) 
                                                            : '—'}
                                                    </div>
                                                    <div className='auto-trades-market-display__info'>
                                                        <span className='auto-trades-market-display__streak'>
                                                            Streak: {marketDisplays.find(m => m.symbol === market1Symbol)?.consecutive || 0}
                                                        </span>
                                                        <span className='auto-trades-market-display__stake'>
                                                            Stake: {marketDisplays.find(m => m.symbol === market1Symbol)?.currentStake || baseStakeNum}
                                                            {marketDisplays.find(m => m.symbol === market1Symbol)?.martingaleMultiplier && marketDisplays.find(m => m.symbol === market1Symbol)?.martingaleMultiplier !== 1 && 
                                                                ` (×${marketDisplays.find(m => m.symbol === market1Symbol)?.martingaleMultiplier?.toFixed(2)})`
                                                            }
                                                        </span>
                                                        <span className={classNames(
                                                            'auto-trades-market-display__result',
                                                            marketDisplays.find(m => m.symbol === market1Symbol)?.lastResult === 'win' && 'auto-trades-market-display__result--win',
                                                            marketDisplays.find(m => m.symbol === market1Symbol)?.lastResult === 'loss' && 'auto-trades-market-display__result--loss'
                                                        )}>
                                                            {marketDisplays.find(m => m.symbol === market1Symbol)?.lastResult === 'win' ? '✓' : 
                                                             marketDisplays.find(m => m.symbol === market1Symbol)?.lastResult === 'loss' ? '✗' : '—'}
                                                        </span>
                                                    </div>
                                                    {marketDisplays.find(m => m.symbol === market1Symbol)?.lastDigits.length > 0 && (
                                                        <div className='auto-trades-market-display__digits'>
                                                            {marketDisplays.find(m => m.symbol === market1Symbol)?.lastDigits.slice(-5).map((d, idx) => (
                                                                <span key={idx} className='auto-trades-market-display__digit'>
                                                                    {d}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    )}
                                                    {IS_DIRECTION_TYPE[market1TradeType] && marketDisplays.find(m => m.symbol === market1Symbol)?.directionHistory.length > 0 && (
                                                        <div className='auto-trades-market-display__digits'>
                                                            {marketDisplays.find(m => m.symbol === market1Symbol)?.directionHistory.slice(-5).map((dir, idx) => (
                                                                <span key={idx} className='auto-trades-market-display__digit'>
                                                                    {dir === 1 ? '▲' : dir === -1 ? '▼' : '—'}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    )}
                                                    <div className='auto-trades-market-display__candle'>
                                                        5m: {getCandleDirectionLabel(marketDisplays.find(m => m.symbol === market1Symbol)?.candleDirection || 0)}
                                                    </div>
                                                    <div className='auto-trades-market-display__status'>
                                                        {marketDisplays.find(m => m.symbol === market1Symbol)?.trading ? '🔄 Buying...' : 
                                                         marketDisplays.find(m => m.symbol === market1Symbol)?.lossCooldownLeft > 0 ? `⏳ Cooldown ${marketDisplays.find(m => m.symbol === market1Symbol)?.lossCooldownLeft}t` :
                                                         marketDisplays.find(m => m.symbol === market1Symbol)?.consecutive && marketDisplays.find(m => m.symbol === market1Symbol)?.consecutive >= getEffectiveSignalStreak({ 
                                                             trade_type: market1TradeType, 
                                                             configured_streak: Number(market1Streak) || 4 
                                                         }) ? '✅ Ready' : '⏳ Waiting'}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </>
                                )}
                            </div>

                            {/* Market 2 - Secondary */}
                            <div className={classNames(
                                'auto-trades-card auto-trades-card--market auto-trades-card--market2',
                                !market2Enabled && 'auto-trades-card--disabled'
                            )}>
                                <div className='auto-trades-card__header'>
                                    <div className='auto-trades-card__title-wrapper'>
                                        <h2 className='auto-trades-card__title'>📊 Secondary Market</h2>
                                        {switchOnLoss && activeTradingMarket === 'market2' && isRunning && (
                                            <span className='auto-trades-card__active-badge auto-trades-card__active-badge--market2'>Active</span>
                                        )}
                                    </div>
                                    <div className='auto-trades-card__controls'>
                                        <button
                                            type='button'
                                            className={classNames(
                                                'auto-trades-market-toggle',
                                                market2Enabled && 'auto-trades-market-toggle--active'
                                            )}
                                            onClick={() => setMarket2Enabled(prev => !prev)}
                                            disabled={isRunning}
                                        >
                                            <span className='auto-trades-market-toggle__label'>
                                                {market2Enabled ? 'ON' : 'OFF'}
                                            </span>
                                            <span className='auto-trades-market-toggle__switch'>
                                                <span className='auto-trades-market-toggle__knob' />
                                            </span>
                                        </button>
                                        <div className='auto-trades-card__badge auto-trades-card__badge--market2'>Secondary</div>
                                    </div>
                                </div>
                                {market2Enabled && (
                                    <>
                                        <div className='auto-trades-market-config'>
                                            <div className='auto-trades-config__field'>
                                                <label>Market</label>
                                                <select
                                                    className='auto-trades-config__select'
                                                    value={market2Symbol}
                                                    onChange={e => setMarket2Symbol(e.target.value)}
                                                    disabled={isRunning || scanAllMarkets}
                                                >
                                                    {AUTO_MARKETS.map(m => (
                                                        <option key={m.symbol} value={m.symbol}>{m.label}</option>
                                                    ))}
                                                </select>
                                            </div>
                                            <div className='auto-trades-config__field'>
                                                <label>Contract Type</label>
                                                <select
                                                    className='auto-trades-config__select'
                                                    value={market2TradeType}
                                                    onChange={e => setMarket2TradeType(e.target.value as TradeType)}
                                                    disabled={isRunning}
                                                >
                                                    <optgroup label='Digits'>
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
                                            {BARRIER_NEEDED[market2TradeType] && (
                                                <div className='auto-trades-config__field'>
                                                    <label>{market2TradeType === 'DIGITMATCH' || market2TradeType === 'DIGITDIFF' ? 'Prediction' : 'Digit'}</label>
                                                    <select
                                                        className='auto-trades-config__select'
                                                        value={market2Barrier}
                                                        onChange={e => setMarket2Barrier(e.target.value)}
                                                        disabled={isRunning}
                                                    >
                                                        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => (
                                                            <option key={d} value={String(d)}>{d}</option>
                                                        ))}
                                                    </select>
                                                </div>
                                            )}
                                            {usesLossPrediction(market2TradeType) && (
                                                <div className='auto-trades-config__field'>
                                                    <label>Digit to predict</label>
                                                    <select
                                                        className='auto-trades-config__select'
                                                        value={market2PredictionDigit}
                                                        onChange={e => setMarket2PredictionDigit(e.target.value)}
                                                        disabled={isRunning}
                                                    >
                                                        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => (
                                                            <option key={d} value={String(d)}>{d}</option>
                                                        ))}
                                                    </select>
                                                    <small className='auto-trades-config__hint'>Always uses this digit for predictions</small>
                                                </div>
                                            )}
                                            <div className='auto-trades-config__field'>
                                                <label>Streak length</label>
                                                <div className='auto-trades-config__streak-row'>
                                                    <input
                                                        className='auto-trades-config__streak-slider'
                                                        type='range'
                                                        min='1'
                                                        max={MAX_STREAK_LENGTH}
                                                        step='1'
                                                        value={market2Streak}
                                                        onChange={e => setMarket2Streak(e.target.value)}
                                                        disabled={isRunning}
                                                        style={{ '--pct': `${(Number(market2Streak) / MAX_STREAK_LENGTH) * 100}%` } as any}
                                                    />
                                                    <span className='auto-trades-config__streak-value'>{market2Streak}</span>
                                                </div>
                                            </div>
                                            <div className='auto-trades-config__field'>
                                                <label>Analysis ticks</label>
                                                <select
                                                    className='auto-trades-config__select'
                                                    value={market2AnalysisTicks}
                                                    onChange={e => setMarket2AnalysisTicks(e.target.value)}
                                                    disabled={isRunning}
                                                >
                                                    {Array.from({ length: MAX_ANALYSIS_TICKS }, (_, i) => i + 1).map(d => (
                                                        <option key={d} value={String(d)}>{d}</option>
                                                    ))}
                                                </select>
                                            </div>
                                            <div className='auto-trades-config__field'>
                                                <label>Inverse Mode</label>
                                                <div className='auto-trades-inverse-toggle'>
                                                    <button
                                                        type='button'
                                                        className={classNames(
                                                            'auto-trades-inverse-btn',
                                                            market2Inverse && 'auto-trades-inverse-btn--active'
                                                        )}
                                                        onClick={() => setMarket2Inverse(prev => !prev)}
                                                        disabled={isRunning}
                                                    >
                                                        <span className='auto-trades-inverse-btn__label'>
                                                            {market2Inverse ? '🔀 Inverse' : '→ Direct'}
                                                        </span>
                                                        <span className='auto-trades-inverse-btn__switch'>
                                                            <span className='auto-trades-inverse-btn__knob' />
                                                        </span>
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                        {/* Market 2 Live Display */}
                                        <div className='auto-trades-market-display'>
                                            {marketDisplays.find(m => m.symbol === market2Symbol) && (
                                                <div className='auto-trades-market-display__content'>
                                                    <div className='auto-trades-market-display__quote'>
                                                        {marketDisplays.find(m => m.symbol === market2Symbol)?.lastQuote !== null 
                                                            ? marketDisplays.find(m => m.symbol === market2Symbol)?.lastQuote?.toFixed(marketDisplays.find(m => m.symbol === market2Symbol)?.pip || 2) 
                                                            : '—'}
                                                    </div>
                                                    <div className='auto-trades-market-display__info'>
                                                        <span className='auto-trades-market-display__streak'>
                                                            Streak: {marketDisplays.find(m => m.symbol === market2Symbol)?.consecutive || 0}
                                                        </span>
                                                        <span className='auto-trades-market-display__stake'>
                                                            Stake: {marketDisplays.find(m => m.symbol === market2Symbol)?.currentStake || baseStakeNum}
                                                            {marketDisplays.find(m => m.symbol === market2Symbol)?.martingaleMultiplier && marketDisplays.find(m => m.symbol === market2Symbol)?.martingaleMultiplier !== 1 && 
                                                                ` (×${marketDisplays.find(m => m.symbol === market2Symbol)?.martingaleMultiplier?.toFixed(2)})`
                                                            }
                                                        </span>
                                                        <span className={classNames(
                                                            'auto-trades-market-display__result',
                                                            marketDisplays.find(m => m.symbol === market2Symbol)?.lastResult === 'win' && 'auto-trades-market-display__result--win',
                                                            marketDisplays.find(m => m.symbol === market2Symbol)?.lastResult === 'loss' && 'auto-trades-market-display__result--loss'
                                                        )}>
                                                            {marketDisplays.find(m => m.symbol === market2Symbol)?.lastResult === 'win' ? '✓' : 
                                                             marketDisplays.find(m => m.symbol === market2Symbol)?.lastResult === 'loss' ? '✗' : '—'}
                                                        </span>
                                                    </div>
                                                    {marketDisplays.find(m => m.symbol === market2Symbol)?.lastDigits.length > 0 && (
                                                        <div className='auto-trades-market-display__digits'>
                                                            {marketDisplays.find(m => m.symbol === market2Symbol)?.lastDigits.slice(-5).map((d, idx) => (
                                                                <span key={idx} className='auto-trades-market-display__digit'>
                                                                    {d}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    )}
                                                    {IS_DIRECTION_TYPE[market2TradeType] && marketDisplays.find(m => m.symbol === market2Symbol)?.directionHistory.length > 0 && (
                                                        <div className='auto-trades-market-display__digits'>
                                                            {marketDisplays.find(m => m.symbol === market2Symbol)?.directionHistory.slice(-5).map((dir, idx) => (
                                                                <span key={idx} className='auto-trades-market-display__digit'>
                                                                    {dir === 1 ? '▲' : dir === -1 ? '▼' : '—'}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    )}
                                                    <div className='auto-trades-market-display__candle'>
                                                        5m: {getCandleDirectionLabel(marketDisplays.find(m => m.symbol === market2Symbol)?.candleDirection || 0)}
                                                    </div>
                                                    <div className='auto-trades-market-display__status'>
                                                        {marketDisplays.find(m => m.symbol === market2Symbol)?.trading ? '🔄 Buying...' : 
                                                         marketDisplays.find(m => m.symbol === market2Symbol)?.lossCooldownLeft > 0 ? `⏳ Cooldown ${marketDisplays.find(m => m.symbol === market2Symbol)?.lossCooldownLeft}t` :
                                                         marketDisplays.find(m => m.symbol === market2Symbol)?.consecutive && marketDisplays.find(m => m.symbol === market2Symbol)?.consecutive >= getEffectiveSignalStreak({ 
                                                             trade_type: market2TradeType, 
                                                             configured_streak: Number(market2Streak) || 4 
                                                         }) ? '✅ Ready' : '⏳ Waiting'}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>

                        {/* Stats */}
                        <div className='auto-trades-page__stats'>
                            <div className='auto-trades-stats-grid'>
                                <div className='auto-trades-stat'>
                                    <span className='auto-trades-stat__label'>Total P&L</span>
                                    <span className={classNames('auto-trades-stat__value', {
                                        'auto-trades-stat__value--positive': pnlPositive,
                                        'auto-trades-stat__value--negative': pnlNegative,
                                    })}>
                                        {pnlPositive ? '+' : ''}{totalPnl.toFixed(2)} {currency}
                                    </span>
                                </div>
                                <div className='auto-trades-stat'>
                                    <span className='auto-trades-stat__label'>Total Trades</span>
                                    <span className='auto-trades-stat__value'>{totalTrades}</span>
                                </div>
                                <div className='auto-trades-stat'>
                                    <span className='auto-trades-stat__label'>Martingale</span>
                                    <span className={classNames('auto-trades-stat__value', {
                                        'auto-trades-stat__value--active': martingaleActive,
                                    })}>
                                        {martingaleActive ? 'Active' : 'Off'}
                                    </span>
                                </div>
                                <div className='auto-trades-stat'>
                                    <span className='auto-trades-stat__label'>Status</span>
                                    <span className={classNames('auto-trades-stat__value', {
                                        'auto-trades-stat__value--running': isRunning,
                                    })}>
                                        {isRunning ? '▶ Running' : '⏸ Stopped'}
                                    </span>
                                </div>
                                {switchOnLoss && isRunning && market1Enabled && market2Enabled && (
                                    <div className='auto-trades-stat auto-trades-stat--full'>
                                        <span className='auto-trades-stat__label'>Active Market</span>
                                        <span className={classNames('auto-trades-stat__value', {
                                            'auto-trades-stat__value--market1': activeTradingMarket === 'market1',
                                            'auto-trades-stat__value--market2': activeTradingMarket === 'market2',
                                        })}>
                                            {activeTradingMarket === 'market1' ? '📈 Primary' : '📊 Market 2'}
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Controls */}
                        <div className='auto-trades-controls'>
                            {!isRunning ? (
                                <button
                                    className='auto-trades-controls__run'
                                    onClick={handleRun}
                                    disabled={!client.is_logged_in || (!market1Enabled && !market2Enabled && !scanAllMarkets)}
                                >
                                    ▶ Start Trading
                                </button>
                            ) : (
                                <button className='auto-trades-controls__stop' onClick={handleStop}>
                                    ■ Stop Trading
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </ThemedScrollbars>

            {/* Risk Disclaimer */}
            <button className='auto-trades-disclaimer-btn' onClick={() => setShowDisclaimer(true)}>
                ⚠ Risk Disclaimer
            </button>

            {showDisclaimer && (
                <div className='auto-trades-disclaimer-overlay' onClick={() => setShowDisclaimer(false)}>
                    <div className='auto-trades-disclaimer-modal' onClick={e => e.stopPropagation()}>
                        <div className='auto-trades-disclaimer-modal__header'>
                            <span className='auto-trades-disclaimer-modal__icon'>⚠</span>
                            <h3 className='auto-trades-disclaimer-modal__title'>Risk Disclaimer</h3>
                            <button
                                className='auto-trades-disclaimer-modal__close'
                                onClick={() => setShowDisclaimer(false)}
                            >
                                ✕
                            </button>
                        </div>
                        <div className='auto-trades-disclaimer-modal__body'>
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
                        <div className='auto-trades-disclaimer-modal__footer'>
                            <button
                                className='auto-trades-disclaimer-modal__ok'
                                onClick={() => setShowDisclaimer(false)}
                            >
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
