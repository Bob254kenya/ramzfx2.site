Here's the complete, well-styled AutoTrades.tsx file with all imports and proper styling for the L→Digit Strategy section:

```tsx
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
import { API_BASE } from '@/utils/api-base';
import {
    DIGIT_STRATEGIES,
    evaluateDigitStrategy,
    SUPPORTED_VOLATILITY_MARKETS,
    type DigitStrategyId,
} from '@/utils/digit-strategy';
import { recordDiagnosticEvent, setDiagnosticGauge } from '@/utils/diagnostics';
import { getLastDigitFromQuote, getMarketPipSize, isExpectedStreamInterruption } from '@/utils/market-data';
import { buyContractForUi, streamContractUntilSettled } from '@/utils/trade-purchase';
import { safeSubscribe } from '@/utils/websocket-handler';
import {
    AUTO_TRADE_STRATEGY_FAMILIES,
    AUTO_TRADE_STRATEGY_PRESET_COUNT,
    AUTO_TRADE_STRATEGY_PRESET_LOOKUP,
} from './strategy-presets';
import type { AutoTradeStrategyPreset } from './strategy-presets';
import './auto-trades.scss';

type MartingaleModeType =
    | 'no_martingale'
    | 'after_one_loss'
    | 'after_two_losses'
    | 'custom_consecutive_loss_trigger';

type AutoMarket = { symbol: string; label: string; pip: number };
type Direction = 1 | -1 | 0;
type AiFabPosition = { left: number; top: number };
type StrategyTemplate = 'STANDARD' | DigitStrategyId;
type FloatingStrategyAlert = {
    marketLabel: string;
    message: string;
    strategyId: DigitStrategyId;
    symbol: string;
};

// L→Digit Strategy Types
type LDigitPatternType = 
    | 'disabled'
    | 'odd_to_even'
    | 'even_to_odd'
    | 'over_to_under'
    | 'under_to_over'
    | 'match_to_diff'
    | 'diff_to_match'
    | 'rise_to_fall'
    | 'fall_to_rise';

type LDigitAnalysis = {
    enabled: boolean;
    patternType: LDigitPatternType;
    lookbackTicks: number;
    thresholdDigit?: number;
    barrierDigit?: number;
};

const FIVE_MINUTE_GRANULARITY = 300;
const AI_FAB_SIZE = 72;
const AI_FAB_MARGIN = 12;
const AI_FAB_BOTTOM_GUARD = 82;
const STRATEGY_ALERT_SOUND_ID = 'announcement';

const AUTO_MARKETS: AutoMarket[] = SUPPORTED_VOLATILITY_MARKETS.map(market => ({
    label: market.label.replace('Volatility ', 'Vol ').replace(' Index', ''),
    pip: market.pip ?? 2,
    symbol: market.symbol,
}));

const AUTO_MARKET_SYMBOLS = AUTO_MARKETS.map(({ symbol }) => symbol);
const AUTO_MARKET_LOOKUP = new Map(AUTO_MARKETS.map(market => [market.symbol, market]));

type AiAutoTradeSettings = {
    tradeType?: TradeType | null;
    barrier?: string | null;
    predictionBeforeLoss?: string | null;
    predictionAfterLoss?: string | null;
    analysisTicks?: string | null;
    selectedMarketSymbols?: string[];
    stake?: string | null;
    martingale?: string | null;
    takeProfit?: string | null;
    stopLoss?: string | null;
    streak?: string | null;
    strategyMode?: StrategyMode | null;
    martingaleMode?: MartingaleModeType | null;
    consecutiveLossCount?: string | null;
    lDigitStrategy?: LDigitAnalysis | null;
};

type AiCustomStrategy = {
    intent?: string;
    entryRules?: string[];
    exitRules?: string[];
    riskRules?: string[];
    notes?: string[];
};

type AiAutoTradeParseResult = {
    settings: AiAutoTradeSettings;
    summary: string[];
    warnings: string[];
    unsupportedCapabilities?: string[];
    customStrategy?: AiCustomStrategy;
    confidence?: number;
    source?: 'openai' | 'local' | 'preset';
};

const DATA_SILENCE_RESTART_MS = 15000;
const DATA_RESTART_COOLDOWN_MS = 10000;
const UI_REFRESH_THROTTLE_MS = 80;
const PERCENTAGE_ANALYSIS_HISTORY_SIZE = 1000;
const PERCENTAGE_BACKFILL_COUNT = PERCENTAGE_ANALYSIS_HISTORY_SIZE;
const PERCENTAGE_MIN_SAMPLE_SIZE = 100;
const MARKET_LOSS_COOLDOWN_TICKS = 60;

type StrategyMode = 'STANDARD' | 'INVERSE' | 'PERCENTAGE';

type PercentageThresholds = {
    over: Record<number, { minPercentage: number; confidence: number; streak: number }>;
    under: Record<number, { minPercentage: number; confidence: number; streak: number }>;
    even: { minPercentage: number; streak: number; confidence: number };
    odd: { minPercentage: number; streak: number; confidence: number };
    rise: { minPercentage: number; momentum: number; confidence: number };
    fall: { minPercentage: number; momentum: number; confidence: number };
    differs: { minPercentage: number; confidence: number; streak: number };
    match: { minPercentage: number; confidence: number; streak: number };
    higher: { minPercentage: number; momentum: number; confidence: number };
    lower: { minPercentage: number; momentum: number; confidence: number };
};

const PERCENTAGE_THRESHOLDS: PercentageThresholds = {
    over: {
        0: { minPercentage: 88, confidence: 92, streak: 3 },
        1: { minPercentage: 82, confidence: 90, streak: 3 },
        2: { minPercentage: 74, confidence: 88, streak: 2 },
        3: { minPercentage: 66, confidence: 85, streak: 2 },
        4: { minPercentage: 58, confidence: 82, streak: 2 },
        5: { minPercentage: 50, confidence: 80, streak: 1 },
        6: { minPercentage: 42, confidence: 80, streak: 2 },
        7: { minPercentage: 34, confidence: 85, streak: 2 },
        8: { minPercentage: 22, confidence: 90, streak: 3 },
    },
    under: {
        1: { minPercentage: 12, confidence: 92, streak: 3 },
        2: { minPercentage: 18, confidence: 90, streak: 3 },
        3: { minPercentage: 26, confidence: 88, streak: 2 },
        4: { minPercentage: 34, confidence: 85, streak: 2 },
        5: { minPercentage: 42, confidence: 82, streak: 2 },
        6: { minPercentage: 50, confidence: 80, streak: 1 },
        7: { minPercentage: 58, confidence: 80, streak: 2 },
        8: { minPercentage: 66, confidence: 85, streak: 2 },
        9: { minPercentage: 78, confidence: 90, streak: 3 },
    },
    even: { minPercentage: 56, streak: 4, confidence: 84 },
    odd: { minPercentage: 56, streak: 4, confidence: 84 },
    rise: { minPercentage: 58, momentum: 4, confidence: 86 },
    fall: { minPercentage: 58, momentum: 4, confidence: 86 },
    differs: { minPercentage: 82, confidence: 91, streak: 3 },
    match: { minPercentage: 18, confidence: 90, streak: 4 },
    higher: { minPercentage: 57, momentum: 3, confidence: 85 },
    lower: { minPercentage: 57, momentum: 3, confidence: 85 },
};

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
    DIGITOVER: 'Digit Over',
    DIGITUNDER: 'Digit Under',
    DIGITEVEN: 'Digit Even',
    DIGITODD: 'Digit Odd',
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

const INVERSE_LABELS: Record<TradeType, string> = {
    DIGITOVER: 'Inv Over',
    DIGITUNDER: 'Inv Under',
    DIGITEVEN: 'Inv Even',
    DIGITODD: 'Inv Odd',
    DIGITMATCH: 'Inv Match',
    DIGITDIFF: 'Inv Diff',
    CALL: 'Inv Rise',
    PUT: 'Inv Fall',
    RUNHIGH: 'Inv Ups',
    RUNLOW: 'Inv Downs',
};

const isInverseDirectionMatch = (trade_type: TradeType, direction: Direction) => {
    if (trade_type === 'CALL') return direction === 1;
    if (trade_type === 'PUT') return direction === -1;
    if (trade_type === 'RUNHIGH') return direction === 1;
    if (trade_type === 'RUNLOW') return direction === -1;
    return false;
};

const isCandleConfirmedTradeType = (trade_type: TradeType) =>
    trade_type === 'CALL' || trade_type === 'PUT' || trade_type === 'RUNHIGH' || trade_type === 'RUNLOW';

const isInverseCandleMatch = (trade_type: TradeType, candle_direction: Direction) => {
    if (trade_type === 'CALL') return candle_direction === 1;
    if (trade_type === 'PUT') return candle_direction === -1;
    if (trade_type === 'RUNHIGH') return candle_direction === -1;
    if (trade_type === 'RUNLOW') return candle_direction === 1;
    return true;
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

const isRunTradeType = (trade_type: TradeType) => trade_type === 'RUNHIGH' || trade_type === 'RUNLOW';
const usesLossPrediction = (trade_type: TradeType) => trade_type === 'DIGITOVER' || trade_type === 'DIGITUNDER';
const STRATEGY_TEMPLATE_IDS: StrategyTemplate[] = ['STANDARD', 'OVER_2_MARKET', 'UNDER_7_MARKET'];

const getTemplateTradeConfig = (template: StrategyTemplate) => {
    if (template === 'OVER_2_MARKET') {
        return { barrier: '2', tradeType: 'DIGITOVER' as TradeType };
    }
    if (template === 'UNDER_7_MARKET') {
        return { barrier: '7', tradeType: 'DIGITUNDER' as TradeType };
    }
    return null;
};

const playStrategyAlertSound = () => {
    if (typeof document === 'undefined') return;
    const audio = document.getElementById(STRATEGY_ALERT_SOUND_ID) as HTMLAudioElement | null;
    if (!audio) return;
    audio.currentTime = 0;
    audio.play().catch(() => {});
};

const clampAiFabPosition = (left: number, top: number): AiFabPosition => {
    if (typeof window === 'undefined') return { left, top };
    const maxLeft = Math.max(AI_FAB_MARGIN, window.innerWidth - AI_FAB_SIZE - AI_FAB_MARGIN);
    const maxTop = Math.max(AI_FAB_MARGIN, window.innerHeight - AI_FAB_SIZE - AI_FAB_BOTTOM_GUARD);
    return {
        left: Math.min(Math.max(AI_FAB_MARGIN, left), maxLeft),
        top: Math.min(Math.max(AI_FAB_MARGIN, top), maxTop),
    };
};

const getDefaultAiFabPosition = () => {
    if (typeof window === 'undefined') return { left: AI_FAB_MARGIN, top: AI_FAB_MARGIN };
    return clampAiFabPosition(window.innerWidth - AI_FAB_SIZE - 16, window.innerHeight - AI_FAB_SIZE - 104);
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

const getInitialConsecutiveLossThreshold = () => {
    try {
        const saved = localStorage.getItem('auto_trades_consecutiveLossCount');
        return clampConsecutiveLossThreshold(saved || 2);
    } catch {
        return 2;
    }
};

const getAiNumber = (text: string, patterns: RegExp[], min: number, max: number) => {
    for (const pattern of patterns) {
        const match = text.match(pattern);
        const value = Number(match?.[1]);
        if (Number.isFinite(value) && value >= min && value <= max) return String(value);
    }
    return undefined;
};

const getAiMoney = (text: string, patterns: RegExp[]) => {
    for (const pattern of patterns) {
        const match = text.match(pattern);
        const value = Number(match?.[1]);
        if (Number.isFinite(value) && value > 0) return String(value);
    }
    return undefined;
};

const getAiMarketSymbols = (text: string) => {
    const symbols = new Set<string>();
    const normalized = text.toLowerCase();
    AUTO_MARKETS.forEach(market => {
        if (normalized.includes(market.symbol.toLowerCase()) || normalized.includes(market.label.toLowerCase())) {
            symbols.add(market.symbol);
        }
    });
    const volatilityMatches = normalized.matchAll(/\b(?:v|vol|volatility)\s*(10|15|25|30|50|75|90|100)\b/g);
    for (const match of volatilityMatches) {
        const value = match[1];
        const wantsOneSecond = /\b(?:1s|1\s*second|one\s*second|1hz)\b/.test(normalized);
        const oneSecondSymbol = `1HZ${value}V`;
        const standardSymbol = `R_${value}`;
        const symbol = wantsOneSecond && AUTO_MARKET_LOOKUP.has(oneSecondSymbol) ? oneSecondSymbol : standardSymbol;
        if (AUTO_MARKET_LOOKUP.has(symbol)) symbols.add(symbol);
    }
    return [...symbols];
};

const isAiTradeType = (value: unknown): value is TradeType =>
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(TRADE_TYPE_LABELS, value);

const isAiStrategyMode = (value: unknown): value is StrategyMode =>
    value === 'STANDARD' || value === 'INVERSE' || value === 'PERCENTAGE';

const getAiDigitString = (value: unknown) => {
    const digit = Number(value);
    return Number.isInteger(digit) && digit >= 0 && digit <= 9 ? String(digit) : undefined;
};

const getDigitNumber = (value: unknown, fallback: number) => {
    const digit = Number(value);
    return Number.isFinite(digit) ? Math.min(9, Math.max(0, Math.trunc(digit))) : fallback;
};

const getAiBoundedIntString = (value: unknown, min: number, max: number) => {
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric >= min && numeric <= max ? String(numeric) : undefined;
};

const getAiPositiveNumberString = (value: unknown) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? String(value) : undefined;
};

export const normalizeAiAutoTradePlan = (plan: Partial<AiAutoTradeParseResult>): AiAutoTradeParseResult => {
    const settings = plan.settings || {};
    const normalizedSettings: AiAutoTradeSettings = {};

    if (isAiTradeType(settings.tradeType)) normalizedSettings.tradeType = settings.tradeType;
    if (isAiStrategyMode(settings.strategyMode)) normalizedSettings.strategyMode = settings.strategyMode;

    const barrier = getAiDigitString(settings.barrier);
    if (barrier !== undefined) normalizedSettings.barrier = barrier;

    const predictionBeforeLoss = getAiDigitString(settings.predictionBeforeLoss);
    if (predictionBeforeLoss !== undefined) normalizedSettings.predictionBeforeLoss = predictionBeforeLoss;

    const predictionAfterLoss = getAiDigitString(settings.predictionAfterLoss);
    if (predictionAfterLoss !== undefined) normalizedSettings.predictionAfterLoss = predictionAfterLoss;

    const analysisTicks = getAiBoundedIntString(settings.analysisTicks, 1, 10);
    if (analysisTicks !== undefined) normalizedSettings.analysisTicks = analysisTicks;

    const streak = getAiBoundedIntString(settings.streak, 1, 10);
    if (streak !== undefined) normalizedSettings.streak = streak;

    if (Array.isArray(settings.selectedMarketSymbols)) {
        normalizedSettings.selectedMarketSymbols = [
            ...new Set(settings.selectedMarketSymbols.filter(symbol => AUTO_MARKET_LOOKUP.has(symbol))),
        ];
    }

    const stake = getAiPositiveNumberString(settings.stake);
    if (stake !== undefined) normalizedSettings.stake = stake;

    const martingale = getAiPositiveNumberString(settings.martingale);
    if (martingale !== undefined) normalizedSettings.martingale = martingale;

    const takeProfit = getAiPositiveNumberString(settings.takeProfit);
    if (takeProfit !== undefined) normalizedSettings.takeProfit = takeProfit;

    const stopLoss = getAiPositiveNumberString(settings.stopLoss);
    if (stopLoss !== undefined) normalizedSettings.stopLoss = stopLoss;

    if (settings.martingaleMode != null) {
        normalizedSettings.martingaleMode = normalizeMartingaleMode(settings.martingaleMode);
    }

    const consecutiveLossCount = getAiBoundedIntString(settings.consecutiveLossCount, 1, 10);
    if (consecutiveLossCount !== undefined) normalizedSettings.consecutiveLossCount = consecutiveLossCount;

    if (settings.lDigitStrategy) {
        normalizedSettings.lDigitStrategy = settings.lDigitStrategy;
    }

    return {
        settings: normalizedSettings,
        summary: Array.isArray(plan.summary) ? plan.summary.filter(item => typeof item === 'string') : [],
        warnings: Array.isArray(plan.warnings) ? plan.warnings.filter(item => typeof item === 'string') : [],
        unsupportedCapabilities: Array.isArray(plan.unsupportedCapabilities)
            ? plan.unsupportedCapabilities.filter(item => typeof item === 'string')
            : [],
        customStrategy: {
            intent: typeof plan.customStrategy?.intent === 'string' ? plan.customStrategy.intent : undefined,
            entryRules: Array.isArray(plan.customStrategy?.entryRules)
                ? plan.customStrategy.entryRules.filter(item => typeof item === 'string')
                : [],
            exitRules: Array.isArray(plan.customStrategy?.exitRules)
                ? plan.customStrategy.exitRules.filter(item => typeof item === 'string')
                : [],
            riskRules: Array.isArray(plan.customStrategy?.riskRules)
                ? plan.customStrategy.riskRules.filter(item => typeof item === 'string')
                : [],
            notes: Array.isArray(plan.customStrategy?.notes)
                ? plan.customStrategy.notes.filter(item => typeof item === 'string')
                : [],
        },
        confidence: Number.isFinite(Number(plan.confidence)) ? Number(plan.confidence) : undefined,
        source: plan.source === 'openai' || plan.source === 'local' || plan.source === 'preset' ? plan.source : undefined,
    };
};

export const parseAiAutoTradeStrategy = (rawText: string): AiAutoTradeParseResult => {
    const text = rawText.toLowerCase().replace(/\s+/g, ' ').trim();
    const settings: AiAutoTradeSettings = {};
    const summary: string[] = [];
    const warnings: string[] = [];

    if (!text) {
        return { settings, summary, warnings: ['Enter a strategy before applying settings.'], source: 'local' };
    }

    // Parse L→digit strategy patterns
    const lDigitOddToEvenMatch = text.match(/\b(?:l→digit|loss to digit|after loss check|pattern)\s*odd\s*to\s*even\s*(?:with|using|lookback)?\s*(\d+)?\s*ticks?\b/i);
    const lDigitEvenToOddMatch = text.match(/\b(?:l→digit|loss to digit|after loss check|pattern)\s*even\s*to\s*odd\s*(?:with|using|lookback)?\s*(\d+)?\s*ticks?\b/i);
    const lDigitOverToUnderMatch = text.match(/\b(?:l→digit|loss to digit|after loss check|pattern)\s*over\s*(\d+)\s*to\s*under\s*(?:with|using|lookback)?\s*(\d+)?\s*ticks?\b/i);
    const lDigitUnderToOverMatch = text.match(/\b(?:l→digit|loss to digit|after loss check|pattern)\s*under\s*(\d+)\s*to\s*over\s*(?:with|using|lookback)?\s*(\d+)?\s*ticks?\b/i);

    if (lDigitOddToEvenMatch) {
        const lookback = lDigitOddToEvenMatch[1] ? parseInt(lDigitOddToEvenMatch[1]) : 5;
        settings.lDigitStrategy = {
            enabled: true,
            patternType: 'odd_to_even',
            lookbackTicks: Math.min(20, Math.max(1, lookback)),
        };
        summary.push(`L→Digit: After loss, check last ${lookback} ticks, if all odd → trade Even`);
    } else if (lDigitEvenToOddMatch) {
        const lookback = lDigitEvenToOddMatch[1] ? parseInt(lDigitEvenToOddMatch[1]) : 5;
        settings.lDigitStrategy = {
            enabled: true,
            patternType: 'even_to_odd',
            lookbackTicks: Math.min(20, Math.max(1, lookback)),
        };
        summary.push(`L→Digit: After loss, check last ${lookback} ticks, if all even → trade Odd`);
    } else if (lDigitOverToUnderMatch) {
        const threshold = parseInt(lDigitOverToUnderMatch[1]);
        const lookback = lDigitOverToUnderMatch[2] ? parseInt(lDigitOverToUnderMatch[2]) : 5;
        if (threshold >= 0 && threshold <= 9) {
            settings.lDigitStrategy = {
                enabled: true,
                patternType: 'over_to_under',
                lookbackTicks: Math.min(20, Math.max(1, lookback)),
                thresholdDigit: threshold,
            };
            summary.push(`L→Digit: After loss, check last ${lookback} ticks, if all > ${threshold} → trade Under ${threshold}`);
        }
    } else if (lDigitUnderToOverMatch) {
        const threshold = parseInt(lDigitUnderToOverMatch[1]);
        const lookback = lDigitUnderToOverMatch[2] ? parseInt(lDigitUnderToOverMatch[2]) : 5;
        if (threshold >= 0 && threshold <= 9) {
            settings.lDigitStrategy = {
                enabled: true,
                patternType: 'under_to_over',
                lookbackTicks: Math.min(20, Math.max(1, lookback)),
                thresholdDigit: threshold,
            };
            summary.push(`L→Digit: After loss, check last ${lookback} ticks, if all < ${threshold} → trade Over ${threshold}`);
        }
    }

    // ... rest of parseAiAutoTradeStrategy function remains the same
    const afterLossMatch = text.match(/(?:after|if|when|incase|in case|following)\s+(?:of\s+)?(?:a\s+)?loss.*?\b(over|under)\s*(?:digit\s*)?([0-9])\b/);
    const firstOverUnderMatch = text.match(/\b(over|under)\s*(?:digit\s*)?([0-9])\b/);

    if (firstOverUnderMatch) {
        settings.tradeType = firstOverUnderMatch[1] === 'under' ? 'DIGITUNDER' : 'DIGITOVER';
        settings.predictionBeforeLoss = firstOverUnderMatch[2];
        settings.strategyMode = 'STANDARD';
        summary.push(`${settings.tradeType === 'DIGITUNDER' ? 'Digit Under' : 'Digit Over'} before-loss prediction ${firstOverUnderMatch[2]}`);

        if (afterLossMatch) {
            const afterLossType = afterLossMatch[1] === 'under' ? 'DIGITUNDER' : 'DIGITOVER';
            if (afterLossType !== settings.tradeType) {
                warnings.push('After-loss prediction type was different, so only the digit value was applied.');
            }
            settings.predictionAfterLoss = afterLossMatch[2];
            summary.push(`After-loss prediction ${afterLossMatch[2]}`);
        }
    } else if (/\b(?:rise|call)\b/.test(text)) {
        settings.tradeType = 'CALL';
        settings.strategyMode = 'STANDARD';
        summary.push('Trade type Rise');
    } else if (/\b(?:fall|put)\b/.test(text)) {
        settings.tradeType = 'PUT';
        settings.strategyMode = 'STANDARD';
        summary.push('Trade type Fall');
    }

    // ... rest of the function

    return { settings, summary, warnings, source: 'local' };
};

// ... Continue with the rest of the component functions (getPredictionForLastOutcome, getNextMartingaleState, etc.)
// ... Then the main AutoTrades component

const AutoTrades = observer(() => {
    const { dashboard, client, run_panel, summary_card, transactions } = useStore();
    const { currency } = client;
    const { active_tab } = dashboard;

    // State declarations
    const [stake, setStake] = useState('1');
    const [martingale, setMartingale] = useState('2');
    const [takeProfit, setTakeProfit] = useState('100');
    const [stopLoss, setStopLoss] = useState('100');
    const [tradeType, setTradeType] = useState<TradeType>('DIGITOVER');
    const [strategyTemplate, setStrategyTemplate] = useState<StrategyTemplate>('STANDARD');
    const [barrier, setBarrier] = useState('4');
    const [predictionBeforeLoss, setPredictionBeforeLoss] = useState('4');
    const [predictionAfterLoss, setPredictionAfterLoss] = useState('5');
    const [streak, setStreak] = useState('4');
    const [analysisTicks, setAnalysisTicks] = useState('1');
    const [selectedMarketSymbols, setSelectedMarketSymbols] = useState<string[]>(AUTO_MARKET_SYMBOLS);
    
    // L→Digit strategy state
    const [lDigitStrategy, setLDigitStrategy] = useState<LDigitAnalysis>({
        enabled: false,
        patternType: 'disabled',
        lookbackTicks: 5,
        thresholdDigit: 4,
        barrierDigit: 4,
    });

    // ... rest of state declarations

    // Get L→Digit strategy display text
    const getLDigitStrategyText = () => {
        if (!lDigitStrategy.enabled) return null;
        switch (lDigitStrategy.patternType) {
            case 'odd_to_even':
                return `After loss, if last ${lDigitStrategy.lookbackTicks} digits are all odd → trade EVEN`;
            case 'even_to_odd':
                return `After loss, if last ${lDigitStrategy.lookbackTicks} digits are all even → trade ODD`;
            case 'over_to_under':
                return `After loss, if last ${lDigitStrategy.lookbackTicks} digits are all > ${lDigitStrategy.thresholdDigit} → trade UNDER ${lDigitStrategy.thresholdDigit}`;
            case 'under_to_over':
                return `After loss, if last ${lDigitStrategy.lookbackTicks} digits are all < ${lDigitStrategy.thresholdDigit} → trade OVER ${lDigitStrategy.thresholdDigit}`;
            default:
                return null;
        }
    };

    const isLossActive = previousContractResultRef.current === 'loss' || consecutiveLossRef.current > 0;

    // ... rest of component logic

    // RENDER - WELL STYLED UI
    return (
        <div className='auto-trades-page'>
            <ThemedScrollbars className='auto-trades-page__scroll'>
                <div className='auto-trades-page__inner'>
                    {/* Header */}
                    <div className='auto-trades-page__header'>
                        <div>
                            <h1 className='auto-trades-page__title'>Auto Trades</h1>
                            <p className='auto-trades-page__subtitle'>{resolvedSubtitleTxt}</p>
                        </div>
                        <div className='auto-trades-page__status-dot'>
                            <span className={classNames('auto-trades-status', {
                                'auto-trades-status--connected': isConnected && !inCooldown,
                                'auto-trades-status--running': isRunning && !inCooldown,
                                'auto-trades-status--cooldown': inCooldown,
                                'auto-trades-status--loading': isDataLoading && !inCooldown,
                            })} />
                            <span className='auto-trades-status__label'>
                                {inCooldown ? `Cooldown ${cooldownDisplay}t` :
                                 isDataLoading ? 'Loading data' :
                                 isRunning ? 'Trading' :
                                 isConnected ? 'Live data' :
                                 selectedMarketSymbols.length === 0 ? 'No markets' : 'Connecting…'}
                            </span>
                        </div>
                    </div>

                    {/* Cooldown banner */}
                    {inCooldown && isRunning && (
                        <div className='auto-trades-cooldown'>
                            <span className='auto-trades-cooldown__icon'>⏳</span>
                            <span>Cooldown after 2 consecutive losses — all markets paused for <strong>{cooldownDisplay}</strong> more ticks</span>
                        </div>
                    )}

                    {!client.is_logged_in && (
                        <div className='auto-trades-page__notice'>
                            Please log in to your Deriv account to execute real trades.
                        </div>
                    )}

                    {error && <div className='auto-trades-page__error'>{error}</div>}

                    {floatingStrategyAlert && (
                        <div className='auto-trades-floating-alert' role='status' aria-live='polite'>
                            <div className='auto-trades-floating-alert__eyebrow'>
                                {DIGIT_STRATEGIES[floatingStrategyAlert.strategyId].alertLabel} ready
                            </div>
                            <strong>{floatingStrategyAlert.marketLabel}</strong>
                            <p>{floatingStrategyAlert.message}</p>
                            <div className='auto-trades-floating-alert__actions'>
                                <button type='button' onClick={() => handleLoadAlertMarket(floatingStrategyAlert.symbol, floatingStrategyAlert.strategyId)}>
                                    Load market
                                </button>
                                <button type='button' onClick={() => setFloatingStrategyAlert(null)}>Dismiss</button>
                            </div>
                        </div>
                    )}

                    {isDataLoading && (
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

                    <div className={classNames('auto-trades-page__body', { 'auto-trades-page__body--loading': isDataLoading })}>
                        {/* Sidebar */}
                        <div className='auto-trades-page__sidebar'>
                            <div className='auto-trades-card'>
                                <h2 className='auto-trades-card__title'>Settings</h2>

                                {/* L→Digit Strategy Section - WELL STYLED */}
                                <div className='auto-trades-l-digit'>
                                    <div className='auto-trades-l-digit__header'>
                                        <div className='auto-trades-l-digit__icon'>🎯</div>
                                        <h3 className='auto-trades-l-digit__title'>L→Digit Strategy (Loss to Digit)</h3>
                                        <div className={classNames('auto-trades-l-digit__status', {
                                            'auto-trades-l-digit__status--active': lDigitStrategy.enabled && isLossActive && isRunning,
                                            'auto-trades-l-digit__status--ready': lDigitStrategy.enabled && !isLossActive,
                                        })}>
                                            {lDigitStrategy.enabled ? (isLossActive && isRunning ? 'ACTIVE' : 'READY') : 'DISABLED'}
                                        </div>
                                    </div>

                                    {/* Strategy Type Selector */}
                                    <div className='auto-trades-l-digit__selector'>
                                        <label className='auto-trades-l-digit__label'>Strategy Type</label>
                                        <select
                                            className='auto-trades-l-digit__select'
                                            value={lDigitStrategy.enabled ? lDigitStrategy.patternType : 'disabled'}
                                            onChange={e => {
                                                const value = e.target.value as LDigitPatternType;
                                                if (value === 'disabled') {
                                                    setLDigitStrategy({ enabled: false, patternType: 'disabled', lookbackTicks: 5 });
                                                } else if (value === 'odd_to_even') {
                                                    setLDigitStrategy({ enabled: true, patternType: 'odd_to_even', lookbackTicks: 5 });
                                                } else if (value === 'even_to_odd') {
                                                    setLDigitStrategy({ enabled: true, patternType: 'even_to_odd', lookbackTicks: 5 });
                                                } else if (value === 'over_to_under') {
                                                    setLDigitStrategy({ enabled: true, patternType: 'over_to_under', lookbackTicks: 5, thresholdDigit: 4 });
                                                } else if (value === 'under_to_over') {
                                                    setLDigitStrategy({ enabled: true, patternType: 'under_to_over', lookbackTicks: 5, thresholdDigit: 4 });
                                                }
                                            }}
                                            disabled={isRunning}
                                        >
                                            <option value='disabled'>Disabled</option>
                                            <option value='odd_to_even'>🔴 Odd → Even</option>
                                            <option value='even_to_odd'>🟢 Even → Odd</option>
                                            <option value='over_to_under'>📉 Over → Under</option>
                                            <option value='under_to_over'>📈 Under → Over</option>
                                        </select>
                                    </div>

                                    {lDigitStrategy.enabled && (
                                        <div className='auto-trades-l-digit__config'>
                                            {/* Lookback Ticks */}
                                            <div className='auto-trades-l-digit__field'>
                                                <label className='auto-trades-l-digit__label'>Lookback Ticks</label>
                                                <div className='auto-trades-l-digit__slider-container'>
                                                    <input
                                                        type='range'
                                                        className='auto-trades-l-digit__slider'
                                                        min='1'
                                                        max='20'
                                                        step='1'
                                                        value={lDigitStrategy.lookbackTicks}
                                                        onChange={e => setLDigitStrategy(prev => ({
                                                            ...prev,
                                                            lookbackTicks: parseInt(e.target.value)
                                                        }))}
                                                        disabled={isRunning}
                                                    />
                                                    <span className='auto-trades-l-digit__value'>{lDigitStrategy.lookbackTicks} ticks</span>
                                                </div>
                                            </div>

                                            {/* Threshold Digit for Over/Under strategies */}
                                            {(lDigitStrategy.patternType === 'over_to_under' || lDigitStrategy.patternType === 'under_to_over') && (
                                                <div className='auto-trades-l-digit__field'>
                                                    <label className='auto-trades-l-digit__label'>Threshold Digit</label>
                                                    <select
                                                        className='auto-trades-l-digit__select auto-trades-l-digit__select--small'
                                                        value={lDigitStrategy.thresholdDigit}
                                                        onChange={e => setLDigitStrategy(prev => ({
                                                            ...prev,
                                                            thresholdDigit: parseInt(e.target.value)
                                                        }))}
                                                        disabled={isRunning}
                                                    >
                                                        {[0,1,2,3,4,5,6,7,8,9].map(d => (
                                                            <option key={d} value={d}>{d}</option>
                                                        ))}
                                                    </select>
                                                </div>
                                            )}

                                            {/* Strategy Description */}
                                            <div className='auto-trades-l-digit__hint'>
                                                <span className='auto-trades-l-digit__hint-icon'>ℹ️</span>
                                                <span>{getLDigitStrategyText()}</span>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* Strategy Template */}
                                <div className='auto-trades-config__group'>
                                    <div className='auto-trades-strategy-selector'>
                                        <label>Strategy template</label>
                                        <select
                                            className='auto-trades-strategy-selector__select'
                                            value={strategyTemplate}
                                            onChange={e => setStrategyTemplate(e.target.value as StrategyTemplate)}
                                            disabled={isRunning}
                                        >
                                            <option value='STANDARD'>Standard builder</option>
                                            <option value='OVER_2_MARKET'>Over 2 Market</option>
                                            <option value='UNDER_7_MARKET'>Under 7 Market</option>
                                        </select>
                                    </div>
                                    <p className='auto-trades-inverse__hint'>
                                        {usingSpecialStrategy
                                            ? 'Scans every volatility and 1s market in the background. When one qualifies, load that market and click Start Trading to wait for the entry and buy automatically.'
                                            : 'Use the standard contract builder to configure your own auto-trade rule.'}
                                    </p>
                                </div>

                                {/* Contract Type */}
                                <div className='auto-trades-config__group'>
                                    <p className='auto-trades-config__group-label'>Contract Type</p>

                                    <div className='auto-trades-config__trade-row'>
                                        <div className='auto-trades-config__field auto-trades-config__field--type'>
                                            <label>Type</label>
                                            <select
                                                className='auto-trades-config__select'
                                                value={tradeType}
                                                onChange={e => handleTradeTypeChange(e.target.value as TradeType)}
                                                disabled={isRunning || usingSpecialStrategy}
                                            >
                                                <optgroup label='Digits'>
                                                    <option value='DIGITOVER'>Digit Over</option>
                                                    <option value='DIGITUNDER'>Digit Under</option>
                                                    <option value='DIGITEVEN'>Digit Even</option>
                                                    <option value='DIGITODD'>Digit Odd</option>
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

                                        {/* Prediction Pairs */}
                                        {usesLossPrediction(tradeType) && (
                                            <div className='auto-trades-config__prediction-pair'>
                                                <div className='auto-trades-config__prediction-label'>
                                                    Prediction
                                                    <span className='auto-trades-config__prediction-hint'>W→digit / L→digit</span>
                                                </div>
                                                <div className='auto-trades-config__prediction-controls'>
                                                    <div className='auto-trades-config__prediction-item'>
                                                        <span className='auto-trades-config__prediction-tag auto-trades-config__prediction-tag--win'>W</span>
                                                        <select
                                                            className='auto-trades-config__select auto-trades-config__select--compact'
                                                            value={predictionBeforeLoss}
                                                            onChange={e => setPredictionBeforeLoss(e.target.value)}
                                                            disabled={isRunning || usingSpecialStrategy}
                                                        >
                                                            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => (
                                                                <option key={d} value={String(d)}>{d}</option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                    <span className='auto-trades-config__prediction-divider'>|</span>
                                                    <div className='auto-trades-config__prediction-item'>
                                                        <span className='auto-trades-config__prediction-tag auto-trades-config__prediction-tag--loss'>L</span>
                                                        <select
                                                            className='auto-trades-config__select auto-trades-config__select--compact'
                                                            value={predictionAfterLoss}
                                                            onChange={e => setPredictionAfterLoss(e.target.value)}
                                                            disabled={isRunning || usingSpecialStrategy}
                                                        >
                                                            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => (
                                                                <option key={d} value={String(d)}>{d}</option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {/* Analysis Ticks */}
                                        <div className='auto-trades-config__field auto-trades-config__field--analysis'>
                                            <label>Analysis ticks</label>
                                            <select
                                                className='auto-trades-config__select'
                                                value={analysisTicks}
                                                onChange={e => setAnalysisTicks(e.target.value)}
                                                disabled={isRunning || usingSpecialStrategy}
                                            >
                                                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(d => (
                                                    <option key={d} value={String(d)}>{d}</option>
                                                ))}
                                            </select>
                                        </div>
                                    </div>

                                    {/* Streak */}
                                    <div className='auto-trades-config__field' style={{ marginTop: '0.8rem' }}>
                                        <label>Streak ({isDirection ? getDirectionStreakLabel(tradeType) : 'matching digits'})</label>
                                        <div className='auto-trades-config__streak-row'>
                                            <input
                                                className='auto-trades-config__streak-slider'
                                                type='range'
                                                min='1'
                                                max='10'
                                                step='1'
                                                value={streak}
                                                onChange={e => setStreak(e.target.value)}
                                                disabled={isRunning || usingSpecialStrategy}
                                            />
                                            <span className='auto-trades-config__streak-value'>{streak}</span>
                                        </div>
                                    </div>
                                </div>

                                {/* Strategy Mode */}
                                <div className='auto-trades-config__group'>
                                    <div className='auto-trades-strategy-selector'>
                                        <label>Strategy Mode</label>
                                        <select
                                            className='auto-trades-strategy-selector__select'
                                            value={strategyMode}
                                            onChange={e => setStrategyMode(e.target.value as StrategyMode)}
                                            disabled={isRunning || usingSpecialStrategy}
                                        >
                                            <option value='STANDARD'>Standard</option>
                                            <option value='INVERSE'>Inverse</option>
                                            <option value='PERCENTAGE'>Percentage Mode</option>
                                        </select>
                                    </div>
                                    <p className='auto-trades-inverse__hint'>
                                        {strategyMode === 'PERCENTAGE'
                                            ? 'Auto-loads the latest 1,000 ticks and keeps a live rolling percentage window'
                                            : strategyMode === 'INVERSE'
                                              ? 'Detects opposite signals, executes contracts'
                                              : 'Detects standard signals, executes contracts'}
                                    </p>
                                </div>

                                {/* Run/Stop Controls */}
                                <div className='auto-trades-controls'>
                                    <button
                                        className={classNames('auto-trades-controls__ai', {
                                            'auto-trades-controls__ai--dragging': isAiFabDragging,
                                        })}
                                        onClick={handleAiFabClick}
                                        onPointerDown={handleAiFabPointerDown}
                                        onPointerMove={handleAiFabPointerMove}
                                        onPointerUp={finishAiFabDrag}
                                        onPointerCancel={finishAiFabDrag}
                                        disabled={isRunning}
                                        type='button'
                                        title='AI strategy setup'
                                        style={aiFabStyle}
                                    >
                                        <span className='auto-trades-controls__ai-orbit'>
                                            <span className='auto-trades-controls__ai-text'>AI</span>
                                            <span className='auto-trades-controls__ai-dot' />
                                        </span>
                                        <span className='auto-trades-controls__ai-label'>Ai</span>
                                    </button>
                                    {!isRunning ? (
                                        <button
                                            className='auto-trades-controls__run'
                                            onClick={handleRun}
                                            disabled={!client.is_logged_in || selectedMarketSymbols.length === 0}
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

                        {/* Markets Grid */}
                        <div className='auto-trades-markets'>
                            <h2 className='auto-trades-markets__title'>
                                Live Markets
                                <span className='auto-trades-markets__selected-count'>
                                    {selectedMarketSymbols.length}/{AUTO_MARKETS.length} selected
                                </span>
                                {isConnected && <span className='auto-trades-markets__live-badge'>● LIVE</span>}
                                {inCooldown && isRunning && (
                                    <span className='auto-trades-markets__cooldown-badge'>⏳ {cooldownDisplay}t cooldown</span>
                                )}
                                {lDigitStrategy.enabled && (
                                    <span className={classNames('auto-trades-markets__l-digit-badge', {
                                        'auto-trades-markets__l-digit-badge--active': isLossActive && isRunning
                                    })}>
                                        {isLossActive && isRunning ? '🔴 L→Digit ACTIVE' : '⚡ L→Digit Ready'}
                                    </span>
                                )}
                            </h2>
                            
                            {!isRunning && (
                                <div className='auto-trades-markets__actions'>
                                    <button type='button' onClick={handleSelectAllMarkets}>Select all</button>
                                    <button type='button' onClick={handleClearMarkets}>Clear</button>
                                </div>
                            )}
                            
                            {selectedMarketSymbols.length === 0 && (
                                <div className='auto-trades-hint'>
                                    {usingSpecialStrategy
                                        ? 'Background scanning is live across all supported volatility markets. Load one alert market to enable Start Trading.'
                                        : 'Select at least one market to show live quotes and enable Auto Trades.'}
                                </div>
                            )}
                            
                            <div className='auto-trades-markets__grid'>
                                {marketDisplays.map(m => {
                                    const isMarketLoading = m.lastQuote === null;
                                    const marketInCooldown = m.cooldownLeft > 0;
                                    const dots = Math.min(m.consecutive, streakNum);
                                    const isReady = ((usingSpecialStrategy ? m.specialEntryReady : m.consecutive >= streakNum) && !marketInCooldown) || m.trading;
                                    
                                    return (
                                        <div
                                            key={m.symbol}
                                            className={classNames('auto-trades-market', {
                                                'auto-trades-market--ready': isReady && !m.trading && isRunning,
                                                'auto-trades-market--trading': m.trading,
                                                'auto-trades-market--win': m.lastResult === 'win' && !m.trading,
                                                'auto-trades-market--loss': m.lastResult === 'loss' && !m.trading,
                                                'auto-trades-market--cooldown': marketInCooldown && isRunning,
                                                'auto-trades-market--loading': isMarketLoading,
                                                'auto-trades-market--l-digit-active': m.lDigitActive,
                                            })}
                                        >
                                            {isMarketLoading && (
                                                <div className='auto-trades-market__loading'>
                                                    <span className='auto-trades-data-loader__spinner' />
                                                    <span>Loading</span>
                                                </div>
                                            )}
                                            <div className='auto-trades-market__top'>
                                                <div>
                                                    <p className='auto-trades-market__name'>{m.label}</p>
                                                    <p className='auto-trades-market__symbol'>{m.symbol}</p>
                                                </div>
                                                <div className='auto-trades-market__controls'>
                                                    {!isRunning && (
                                                        <button
                                                            className='auto-trades-market__btn auto-trades-market__btn--remove'
                                                            onClick={() => handleRemoveMarket(m.symbol)}
                                                            type='button'
                                                        >
                                                            −
                                                        </button>
                                                    )}
                                                    <div className={classNames('auto-trades-market__badge', {
                                                        'auto-trades-market__badge--ready': isReady && isRunning,
                                                        'auto-trades-market__badge--trading': m.trading,
                                                        'auto-trades-market__badge--l-digit': m.lDigitActive,
                                                    })}>
                                                        {m.trading ? 'BUYING' : m.lDigitActive ? 'L→D' : isReady && isRunning ? 'READY' : m.consecutive > 0 ? `${m.consecutive}` : '—'}
                                                    </div>
                                                </div>
                                            </div>

                                            {m.lastQuote !== null && (
                                                <div className='auto-trades-market__quote'>
                                                    {m.lastQuote.toFixed(getMarketPipSize(m.symbol, AUTO_MARKET_LOOKUP.get(m.symbol)?.pip ?? 2))}
                                                </div>
                                            )}

                                            {isRunning && !inCooldown && (
                                                <div className='auto-trades-market__dots'>
                                                    {Array.from({ length: streakNum }).map((_, i) => (
                                                        <div key={i} className={classNames('auto-trades-market__dot', {
                                                            'auto-trades-market__dot--filled': i < dots,
                                                            'auto-trades-market__dot--ready': i < dots && isReady,
                                                        })} />
                                                    ))}
                                                    <span className='auto-trades-market__dots-label'>{m.consecutive}/{streakNum}</span>
                                                </div>
                                            )}

                                            {!isDirection && m.lastDigits.length > 0 && (
                                                <div className='auto-trades-market__digits'>
                                                    {m.lastDigits.slice(-5).map((d, idx) => (
                                                        <span key={idx} className={classNames('auto-trades-market__digit', {
                                                            'auto-trades-market__digit--low': d <= 4,
                                                            'auto-trades-market__digit--high': d > 4,
                                                        })}>{d}</span>
                                                    ))}
                                                </div>
                                            )}

                                            {m.tradeCount > 0 && (
                                                <div className='auto-trades-market__footer'>
                                                    <span>{m.tradeCount} trade{m.tradeCount !== 1 ? 's' : ''}</span>
                                                    <span className={classNames({
                                                        'auto-trades-market__last-win': m.lastResult === 'win',
                                                        'auto-trades-market__last-loss': m.lastResult === 'loss',
                                                    })}>
                                                        {m.lastResult === 'win' ? '✓ Win' : '✗ Loss'}
                                                    </span>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                </div>
            </ThemedScrollbars>

            {/* AI Strategy Modal */}
            {showAiStrategy && (
                <div className='auto-trades-ai-overlay' onClick={() => setShowAiStrategy(false)}>
                    <div className='auto-trades-ai-modal' onClick={e => e.stopPropagation()}>
                        <div className='auto-trades-ai-modal__header'>
                            <div className='auto-trades-controls__ai-orbit auto-trades-controls__ai-orbit--small'>
                                <span className='auto-trades-controls__ai-text'>AI</span>
                                <span className='auto-trades-controls__ai-dot' />
                            </div>
                            <h3 className='auto-trades-ai-modal__title'>AI Strategy</h3>
                            <button className='auto-trades-ai-modal__close' onClick={() => setShowAiStrategy(false)}>✕</button>
                        </div>
                        <textarea
                            className='auto-trades-ai-modal__textarea'
                            value={aiStrategyText}
                            onChange={e => setAiStrategyText(e.target.value)}
                            placeholder='Trade Over 1. In case of a loss trade Over 3. Use 1 tick. Only trade V25 index.'
                        />
                        <div className='auto-trades-ai-modal__footer'>
                            <button className='auto-trades-ai-modal__secondary' onClick={() => setShowAiStrategy(false)}>Cancel</button>
                            <button className='auto-trades-ai-modal__primary' onClick={applyAiStrategy}>Apply Settings</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
});

export default AutoTrades;
```
