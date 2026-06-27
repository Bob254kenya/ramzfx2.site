import { SUPPORTED_VOLATILITY_MARKETS } from '@/utils/digit-strategy';
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
    DIGIT_STRATEGIES,
    evaluateDigitStrategy,
    SUPPORTED_VOLATILITY_MARKETS,
    type DigitStrategyId,
} from '@/utils/digit-strategy';
import { recordDiagnosticEvent, setDiagnosticGauge } from '@/utils/diagnostics';
import { getLastDigitFromQuote, getMarketPipSize, isExpectedStreamInterruption } from '@/utils/market-data';
import { buyContractForUi, streamContractUntilSettled } from '@/utils/trade-purchase';
import { safeSubscribe } from '@/utils/websocket-handler';
import './auto-trades.scss';

type MartingaleModeType =
    | 'no_martingale'
    | 'after_one_loss'
    | 'after_two_losses'
    | 'custom_consecutive_loss_trigger';

type AutoMarket = { symbol: string; label: string; pip: number };
type Direction = 1 | -1 | 0;
type StrategyTemplate = 'STANDARD' | DigitStrategyId;
type FloatingStrategyAlert = {
    marketLabel: string;
    message: string;
    strategyId: DigitStrategyId;
    symbol: string;
};

const FIVE_MINUTE_GRANULARITY = 300;
const STRATEGY_ALERT_SOUND_ID = 'announcement';

const AUTO_MARKETS: AutoMarket[] = SUPPORTED_VOLATILITY_MARKETS.map(market => ({
    label: market.label.replace('Volatility ', 'Vol ').replace(' Index', ''),
    pip: market.pip ?? 2,
    symbol: market.symbol,
}));

const AUTO_MARKET_SYMBOLS = AUTO_MARKETS.map(({ symbol }) => symbol);
const AUTO_MARKET_LOOKUP = new Map(AUTO_MARKETS.map(market => [market.symbol, market]));

const DATA_SILENCE_RESTART_MS = 15000;
const DATA_RESTART_COOLDOWN_MS = 10000;
const UI_REFRESH_THROTTLE_MS = 80;
const PERCENTAGE_ANALYSIS_HISTORY_SIZE = 1000;
const PERCENTAGE_BACKFILL_COUNT = PERCENTAGE_ANALYSIS_HISTORY_SIZE;
const PERCENTAGE_MIN_SAMPLE_SIZE = 100;

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

const getDigitNumber = (value: unknown, fallback: number) => {
    const digit = Number(value);
    return Number.isFinite(digit) ? Math.min(9, Math.max(0, Math.trunc(digit))) : fallback;
};

export const getPredictionForLastOutcome = ({
    trade_type,
    last_result,
    consecutive_losses = 0,
    prediction_before_loss,
    prediction_after_loss,
    fallback_barrier,
}: {
    trade_type: TradeType;
    last_result: 'win' | 'loss' | null;
    consecutive_losses?: number;
    prediction_before_loss: number;
    prediction_after_loss: number;
    fallback_barrier: number;
}) => {
    if (!usesLossPrediction(trade_type)) return fallback_barrier;
    return consecutive_losses > 0 || last_result === 'loss' ? prediction_after_loss : prediction_before_loss;
};

export const getNextMartingaleState = ({
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
    // If profit is positive, reset everything
    if (profit >= 0) {
        return {
            consecutiveLosses: 0,
            lastResult: 'win' as const,
            nextStake: base_stake,
        };
    }

    // Loss occurred - increment consecutive losses
    const nextConsecutiveLosses = consecutive_losses + 1;
    const normalizedMode = normalizeMartingaleMode(martingale_mode);
    const normalizedTrigger = clampConsecutiveLossThreshold(consecutive_loss_trigger);

    // No martingale - keep base stake
    if (normalizedMode === 'no_martingale') {
        return {
            consecutiveLosses: nextConsecutiveLosses,
            lastResult: 'loss' as const,
            nextStake: base_stake,
        };
    }

    // Determine if martingale should be applied based on mode
    let shouldApplyMartingale = false;
    
    if (normalizedMode === 'after_one_loss') {
        // Apply martingale immediately after the first loss
        shouldApplyMartingale = true;
    } else if (normalizedMode === 'after_two_losses') {
        // Apply martingale only after 2 consecutive losses
        shouldApplyMartingale = nextConsecutiveLosses >= 2;
    } else if (normalizedMode === 'custom_consecutive_loss_trigger') {
        // Apply martingale after custom number of consecutive losses
        shouldApplyMartingale = nextConsecutiveLosses >= normalizedTrigger;
    }

    // Calculate next stake
    const nextStake = shouldApplyMartingale 
        ? parseFloat((current_stake * multiplier).toFixed(2)) 
        : base_stake;

    return {
        consecutiveLosses: nextConsecutiveLosses,
        lastResult: 'loss' as const,
        nextStake: nextStake,
    };
};

export const getEffectiveSignalStreak = ({
    trade_type,
    configured_streak,
}: {
    trade_type: TradeType;
    configured_streak: number;
}) => {
    const normalizedStreak = Math.min(10, Math.max(1, Math.trunc(configured_streak) || 4));
    return usesLossPrediction(trade_type) ? Math.max(3, normalizedStreak) : normalizedStreak;
};

export const isDigitSignalMatch = ({
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

export const hasRequiredDigitStreak = ({
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

const getCandleDirectionLabel = (direction: Direction) => {
    if (direction === 1) return 'Bullish';
    if (direction === -1) return 'Bearish';
    return 'Waiting';
};

const getDirectionCondition = (trade_type: TradeType, target_len: number) => {
    if (trade_type === 'CALL') return `5m candle bullish + consecutive falling ticks ≥ ${target_len}`;
    if (trade_type === 'PUT') return `5m candle bearish + consecutive rising ticks ≥ ${target_len}`;
    if (trade_type === 'RUNHIGH') return `5m candle bullish + consecutive falling ticks ≥ ${target_len}`;
    return `5m candle bearish + consecutive rising ticks ≥ ${target_len}`;
};

const getDirectionStreakLabel = (trade_type: TradeType) => {
    if (trade_type === 'CALL') return 'falling ticks + bullish 5m candle';
    if (trade_type === 'PUT') return 'rising ticks + bearish 5m candle';
    if (trade_type === 'RUNHIGH') return 'falling ticks + bullish 5m candle';
    return 'rising ticks + bearish 5m candle';
};

export const computePercentage = (baseAmount: number, targetAmount: number): number => {
    if (baseAmount === 0 || isNaN(baseAmount) || isNaN(targetAmount)) return 0;
    return Number(((targetAmount / baseAmount) * 100).toFixed(2));
};

const calculateDigitPercentages = (digitHistory: number[]): Record<number, number> => {
    if (digitHistory.length === 0) return {};
    const counts = Array(10).fill(0);
    digitHistory.forEach(d => {
        if (d >= 0 && d <= 9) counts[d]++;
    });
    return Object.fromEntries(counts.map((count, digit) => [digit, computePercentage(digitHistory.length, count)]));
};

const calculateConfidence = (percentages: Record<number, number>): number => {
    const expectedPct = 10;
    const totalDeviation = Object.values(percentages).reduce((sum, pct) => sum + Math.abs(pct - expectedPct), 0);
    const avgDeviation = totalDeviation / 10;
    return Math.max(0, 100 - avgDeviation * 2);
};

type PercentageSnapshot = {
    primaryLabel: string;
    primaryPercentage: number;
    secondaryLabel?: string;
    secondaryPercentage?: number;
    confidence: number;
    sampleSize: number;
};

const sumDigitPercentages = (percentages: Record<number, number>, predicate: (digit: number) => boolean) =>
    Object.entries(percentages).reduce(
        (sum, [digit, percentage]) => (predicate(Number(digit)) ? sum + percentage : sum),
        0
    );

const calculateDirectionPercentages = (directionHistory: Direction[]) => {
    const directionalTicks = directionHistory.filter(direction => direction !== 0);
    if (directionalTicks.length === 0) {
        return { risePercentage: 0, fallPercentage: 0, confidence: 0, sampleSize: 0 };
    }

    const risingTicks = directionalTicks.filter(direction => direction === 1).length;
    const risePercentage = computePercentage(directionalTicks.length, risingTicks);
    const fallPercentage = Number((100 - risePercentage).toFixed(2));
    const confidence = Math.min(100, Math.abs(risePercentage - fallPercentage) * 2);

    return { risePercentage, fallPercentage, confidence, sampleSize: directionalTicks.length };
};

export const getPercentageSnapshot = (
    trade_type: TradeType,
    state: Pick<MarketState, 'digitHistory' | 'digitPercentages' | 'directionSampleHistory' | 'confidenceScore'>,
    barrier: number
): PercentageSnapshot => {
    if (IS_DIRECTION_TYPE[trade_type]) {
        const { risePercentage, fallPercentage, confidence, sampleSize } = calculateDirectionPercentages(
            state.directionSampleHistory
        );
        const primaryIsRise = trade_type === 'CALL' || trade_type === 'RUNHIGH';

        return {
            primaryLabel: primaryIsRise ? 'Rise' : 'Fall',
            primaryPercentage: primaryIsRise ? risePercentage : fallPercentage,
            secondaryLabel: primaryIsRise ? 'Fall' : 'Rise',
            secondaryPercentage: primaryIsRise ? fallPercentage : risePercentage,
            confidence,
            sampleSize,
        };
    }

    const percentages = state.digitPercentages;
    const safeBarrier = Math.min(9, Math.max(0, barrier));
    const sampleSize = state.digitHistory.length;

    if (trade_type === 'DIGITOVER') {
        const primaryPercentage = sumDigitPercentages(percentages, digit => digit > safeBarrier);
        return {
            primaryLabel: `Over ${safeBarrier}`,
            primaryPercentage,
            secondaryLabel: `${safeBarrier} or below`,
            secondaryPercentage: Number((100 - primaryPercentage).toFixed(2)),
            confidence: state.confidenceScore,
            sampleSize,
        };
    }

    if (trade_type === 'DIGITUNDER') {
        const primaryPercentage = sumDigitPercentages(percentages, digit => digit < safeBarrier);
        return {
            primaryLabel: `Under ${safeBarrier}`,
            primaryPercentage,
            secondaryLabel: `${safeBarrier} or above`,
            secondaryPercentage: Number((100 - primaryPercentage).toFixed(2)),
            confidence: state.confidenceScore,
            sampleSize,
        };
    }

    if (trade_type === 'DIGITEVEN' || trade_type === 'DIGITODD') {
        const evenPercentage = sumDigitPercentages(percentages, digit => digit % 2 === 0);
        const oddPercentage = Number((100 - evenPercentage).toFixed(2));
        const primaryIsEven = trade_type === 'DIGITEVEN';

        return {
            primaryLabel: primaryIsEven ? 'Even' : 'Odd',
            primaryPercentage: primaryIsEven ? evenPercentage : oddPercentage,
            secondaryLabel: primaryIsEven ? 'Odd' : 'Even',
            secondaryPercentage: primaryIsEven ? oddPercentage : evenPercentage,
            confidence: state.confidenceScore,
            sampleSize,
        };
    }

    const matchPercentage = percentages[safeBarrier] ?? 0;
    const differsPercentage = Number((100 - matchPercentage).toFixed(2));
    const primaryIsMatch = trade_type === 'DIGITMATCH';

    return {
        primaryLabel: primaryIsMatch ? `Match ${safeBarrier}` : `Differ ${safeBarrier}`,
        primaryPercentage: primaryIsMatch ? matchPercentage : differsPercentage,
        secondaryLabel: primaryIsMatch ? `Differ ${safeBarrier}` : `Match ${safeBarrier}`,
        secondaryPercentage: primaryIsMatch ? differsPercentage : matchPercentage,
        confidence: state.confidenceScore,
        sampleSize,
    };
};

const getPercentageThreshold = (trade_type: TradeType, barrier: number) => {
    if (trade_type === 'DIGITOVER') return PERCENTAGE_THRESHOLDS.over[barrier] ?? PERCENTAGE_THRESHOLDS.over[4];
    if (trade_type === 'DIGITUNDER') return PERCENTAGE_THRESHOLDS.under[barrier] ?? PERCENTAGE_THRESHOLDS.under[5];
    if (trade_type === 'DIGITEVEN') return PERCENTAGE_THRESHOLDS.even;
    if (trade_type === 'DIGITODD') return PERCENTAGE_THRESHOLDS.odd;
    if (trade_type === 'DIGITMATCH') return PERCENTAGE_THRESHOLDS.match;
    if (trade_type === 'DIGITDIFF') return PERCENTAGE_THRESHOLDS.differs;
    if (trade_type === 'CALL') return PERCENTAGE_THRESHOLDS.rise;
    if (trade_type === 'PUT') return PERCENTAGE_THRESHOLDS.fall;
    if (trade_type === 'RUNHIGH') return PERCENTAGE_THRESHOLDS.higher;
    return PERCENTAGE_THRESHOLDS.lower;
};

export const isPercentageSignalReady = (trade_type: TradeType, state: MarketState, barrier: number): boolean => {
    const snapshot = getPercentageSnapshot(trade_type, state, barrier);
    const threshold = getPercentageThreshold(trade_type, barrier);

    return (
        snapshot.sampleSize >= PERCENTAGE_MIN_SAMPLE_SIZE &&
        snapshot.primaryPercentage >= threshold.minPercentage &&
        snapshot.confidence >= threshold.confidence
    );
};

// ─── Market Configuration ────────────────────────────────────────────────────

interface MarketState {
    // Core state
    consecutive: number;
    trading: boolean;
    isRecovering: boolean;
    lastDigits: number[];
    directionHistory: Direction[];
    prevQuote: number | null;
    candleDirection: Direction;
    candleOpen: number | null;
    candleClose: number | null;
    directionSampleHistory: Direction[];
    tradeCount: number;
    lastResult: 'win' | 'loss' | null;
    lastQuote: number | null;
    tradeStartTime: number | null;
    verificationId: string | null;
    digitHistory: number[];
    digitPercentages: Record<number, number>;
    confidenceScore: number;
    momentumCount: number;
    percentageQuoteHistory: number[];
    percentageEpochHistory: number[];
    percentageBackfilled: boolean;
    percentageBackfillInFlight: boolean;
    qualifyingWinningDigits: number[];
    specialEntryReady: boolean;
    trailingTriggerCount: number;
    alertActive: boolean;
    alertMessage: string;
    recoveryActive: boolean;
    recoveryStartTime: number | null;
    recoveryBlocked: boolean;
    market2Consecutive: number;
    market2LastResult: 'win' | 'loss' | null;
    market2ConsecutiveLosses: number;
    activeMarket: 'm1' | 'm2' | null;
}

interface MarketDisplay extends MarketState {
    symbol: string;
    label: string;
    currentStake: number;
}

const createMarketState = (prev?: Partial<MarketState>): MarketState => ({
    consecutive: 0,
    trading: false,
    isRecovering: false,
    lastDigits: prev?.lastDigits ?? [],
    directionHistory: prev?.directionHistory ?? [],
    prevQuote: prev?.prevQuote ?? null,
    candleDirection: 0,
    candleOpen: null,
    candleClose: null,
    directionSampleHistory: prev?.directionSampleHistory ?? [],
    tradeCount: 0,
    lastResult: null,
    lastQuote: prev?.lastQuote ?? null,
    tradeStartTime: null,
    verificationId: null,
    digitHistory: [],
    digitPercentages: {},
    confidenceScore: 0,
    momentumCount: 0,
    percentageQuoteHistory: prev?.percentageQuoteHistory ?? [],
    percentageEpochHistory: prev?.percentageEpochHistory ?? [],
    percentageBackfilled: prev?.percentageBackfilled ?? false,
    percentageBackfillInFlight: prev?.percentageBackfillInFlight ?? false,
    qualifyingWinningDigits: prev?.qualifyingWinningDigits ?? [],
    specialEntryReady: prev?.specialEntryReady ?? false,
    trailingTriggerCount: prev?.trailingTriggerCount ?? 0,
    alertActive: prev?.alertActive ?? false,
    alertMessage: prev?.alertMessage ?? '',
    recoveryActive: prev?.recoveryActive ?? false,
    recoveryStartTime: prev?.recoveryStartTime ?? null,
    recoveryBlocked: prev?.recoveryBlocked ?? false,
    market2Consecutive: prev?.market2Consecutive ?? 0,
    market2LastResult: prev?.market2LastResult ?? null,
    market2ConsecutiveLosses: prev?.market2ConsecutiveLosses ?? 0,
    activeMarket: prev?.activeMarket ?? null,
});

const getDirectionSamplesFromQuotes = (quotes: number[]): Direction[] =>
    quotes.slice(1).map((quote, index) => {
        const previousQuote = quotes[index];
        if (quote > previousQuote) return 1;
        if (quote < previousQuote) return -1;
        return 0;
    });

const rebuildPercentageAnalytics = (symbol: string, state: MarketState, trade_type: TradeType) => {
    const pip = getMarketPipSize(symbol, AUTO_MARKET_LOOKUP.get(symbol)?.pip ?? 2);
    const quoteHistory = state.percentageQuoteHistory.slice(-PERCENTAGE_ANALYSIS_HISTORY_SIZE);

    state.percentageQuoteHistory = quoteHistory;
    state.percentageEpochHistory = quoteHistory.length ? state.percentageEpochHistory.slice(-quoteHistory.length) : [];
    state.digitHistory = quoteHistory.map(quote => getLastDigitFromQuote(quote, symbol, pip));
    state.digitPercentages = calculateDigitPercentages(state.digitHistory);
    state.directionSampleHistory = getDirectionSamplesFromQuotes(quoteHistory);

    if (IS_DIRECTION_TYPE[trade_type]) {
        const directionPercentages = calculateDirectionPercentages(state.directionSampleHistory);
        state.confidenceScore = directionPercentages.confidence;
        state.momentumCount = Math.round(
            trade_type === 'CALL' || trade_type === 'RUNHIGH'
                ? directionPercentages.risePercentage
                : directionPercentages.fallPercentage
        );
    } else {
        state.confidenceScore = calculateConfidence(state.digitPercentages);
        state.momentumCount = 0;
    }
};

const appendPercentageQuote = (
    symbol: string,
    state: MarketState,
    quote: number,
    epoch: number | null,
    trade_type: TradeType
) => {
    if (!Number.isFinite(quote)) return;

    const lastEpoch = state.percentageEpochHistory[state.percentageEpochHistory.length - 1];
    if (epoch !== null && lastEpoch === epoch) {
        state.percentageQuoteHistory[state.percentageQuoteHistory.length - 1] = quote;
    } else {
        state.percentageQuoteHistory.push(quote);
        state.percentageEpochHistory.push(epoch ?? Date.now());
    }

    while (state.percentageQuoteHistory.length > PERCENTAGE_ANALYSIS_HISTORY_SIZE) {
        state.percentageQuoteHistory.shift();
        state.percentageEpochHistory.shift();
    }

    rebuildPercentageAnalytics(symbol, state, trade_type);
};

// ─── TP/SL Notification Component ──────────────────────────────────────────

const TPSLNotification: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    takeProfit: number;
    stopLoss: number;
    currency: string;
    totalPnl: number;
    totalTrades: number;
    currentStake: number;
    onStopTrading?: () => void;
}> = ({
    isOpen,
    onClose,
    takeProfit,
    stopLoss,
    currency,
    totalPnl,
    totalTrades,
    currentStake,
    onStopTrading,
}) => {
    if (!isOpen) return null;

    const pnlPercent = currentStake > 0 ? (totalPnl / currentStake) * 100 : 0;
    const isProfit = totalPnl > 0;
    const isLoss = totalPnl < 0;
    const tpHit = totalPnl >= takeProfit;
    const slHit = totalPnl <= -stopLoss;

    return (
        <div className="tp-sl-overlay" onClick={onClose}>
            <div className="tp-sl-card" onClick={(e) => e.stopPropagation()}>
                <div className="tp-sl-card__header">
                    <div className="tp-sl-card__icon">
                        {tpHit ? '🎯' : slHit ? '🛑' : '📊'}
                    </div>
                    <h3 className="tp-sl-card__title">
                        {tpHit ? 'Take Profit Hit!' : slHit ? 'Stop Loss Hit!' : 'TP / SL Status'}
                    </h3>
                    <button className="tp-sl-card__close" onClick={onClose}>
                        ✕
                    </button>
                </div>

                <div className="tp-sl-card__body">
                    <div className={classNames('tp-sl-card__row', 'tp-sl-card__row--tp', {
                        'tp-sl-card__row--active': tpHit,
                    })}>
                        <div className="tp-sl-card__row-label">
                            <span>🎯 Take Profit</span>
                            <span className="tp-sl-card__row-badge">target</span>
                        </div>
                        <div className="tp-sl-card__row-value">
                            <span className="tp-sl-card__amount">
                                {takeProfit} {currency}
                            </span>
                            <span className={classNames('tp-sl-card__status', {
                                'tp-sl-card__status--hit': tpHit,
                                'tp-sl-card__status--miss': !tpHit,
                            })}>
                                {tpHit ? '✓ HIT' : 'pending'}
                            </span>
                        </div>
                    </div>

                    <div className={classNames('tp-sl-card__row', 'tp-sl-card__row--sl', {
                        'tp-sl-card__row--active': slHit,
                    })}>
                        <div className="tp-sl-card__row-label">
                            <span>🛑 Stop Loss</span>
                            <span className="tp-sl-card__row-badge">limit</span>
                        </div>
                        <div className="tp-sl-card__row-value">
                            <span className="tp-sl-card__amount">
                                {stopLoss} {currency}
                            </span>
                            <span className={classNames('tp-sl-card__status', {
                                'tp-sl-card__status--hit': slHit,
                                'tp-sl-card__status--miss': !slHit,
                            })}>
                                {slHit ? '✗ HIT' : 'pending'}
                            </span>
                        </div>
                    </div>

                    <div className="tp-sl-card__summary">
                        <div className="tp-sl-card__pnl">
                            <span className="tp-sl-card__pnl-label">P&L</span>
                            <span className={classNames('tp-sl-card__pnl-value', {
                                'tp-sl-card__pnl-value--profit': isProfit,
                                'tp-sl-card__pnl-value--loss': isLoss,
                                'tp-sl-card__pnl-value--neutral': totalPnl === 0,
                            })}>
                                {isProfit ? '+' : ''}{totalPnl.toFixed(2)} {currency}
                                <span className="tp-sl-card__pnl-percent">
                                    ({pnlPercent >= 0 ? '+' : ''}{pnlPercent.toFixed(1)}%)
                                </span>
                            </span>
                        </div>
                        <div className="tp-sl-card__trades">
                            <span>{totalTrades} trade{totalTrades !== 1 ? 's' : ''}</span>
                            <span>•</span>
                            <span className="tp-sl-card__stake">stake: {currentStake.toFixed(2)} {currency}</span>
                        </div>
                    </div>
                </div>

                <div className="tp-sl-card__footer">
                    <button className="tp-sl-card__btn tp-sl-card__btn--dismiss" onClick={onClose}>
                        Dismiss
                    </button>
                    {(tpHit || slHit) && onStopTrading && (
                        <button className="tp-sl-card__btn tp-sl-card__btn--stop" onClick={onStopTrading}>
                            ⏹ Stop Trading
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};

// ─── Main Component ──────────────────────────────────────────────────────────

const AutoTrades = observer(() => {
    const { dashboard, client, run_panel, summary_card, transactions } = useStore();
    const { currency } = client;
    const { active_tab } = dashboard;

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

    // ─── UNIFIED CONFIG STATE ──────────────────────────────────────────────

    // Shared stake, martingale, TP, SL, and martingale strategy
    const [sharedStake, setSharedStake] = useState(() => {
        try { return localStorage.getItem('auto_trades_shared_stake') || '1'; } catch { return '1'; }
    });
    const [sharedMartingale, setSharedMartingale] = useState(() => {
        try { return localStorage.getItem('auto_trades_shared_martingale') || '2'; } catch { return '2'; }
    });
    const [sharedTakeProfit, setSharedTakeProfit] = useState(() => {
        try { return localStorage.getItem('auto_trades_shared_takeProfit') || '100'; } catch { return '100'; }
    });
    const [sharedStopLoss, setSharedStopLoss] = useState(() => {
        try { return localStorage.getItem('auto_trades_shared_stopLoss') || '100'; } catch { return '100'; }
    });
    const [sharedMartingaleMode, setSharedMartingaleMode] = useState<MartingaleModeType>(() => {
        try { return normalizeMartingaleMode(localStorage.getItem('auto_trades_shared_martingaleMode')); } catch { return 'after_one_loss'; }
    });
    const [sharedConsecutiveLossCount, setSharedConsecutiveLossCount] = useState(getInitialConsecutiveLossThreshold);
    const [sharedConsecutiveLossCountInput, setSharedConsecutiveLossCountInput] = useState(() =>
        String(getInitialConsecutiveLossThreshold())
    );

    // ─── Market 1 Config ──────────────────────────────────────────────────

    const [m1TradeType, setM1TradeType] = useState<TradeType>(() => {
        const v = localStorage.getItem('auto_trades_m1_tradeType');
        return VALID_TRADE_TYPES.includes(v as TradeType) ? (v as TradeType) : 'DIGITOVER';
    });
    const [m1Barrier, setM1Barrier] = useState(() => {
        try { return localStorage.getItem('auto_trades_m1_barrier') || '4'; } catch { return '4'; }
    });
    const [m1PredictionBeforeLoss, setM1PredictionBeforeLoss] = useState(() => {
        try { return localStorage.getItem('auto_trades_m1_predictionBeforeLoss') || '4'; } catch { return '4'; }
    });
    const [m1PredictionAfterLoss, setM1PredictionAfterLoss] = useState(() => {
        try { return localStorage.getItem('auto_trades_m1_predictionAfterLoss') || '5'; } catch { return '5'; }
    });
    const [m1Streak, setM1Streak] = useState(() => {
        try { return localStorage.getItem('auto_trades_m1_streak') || '4'; } catch { return '4'; }
    });
    const [m1AnalysisTicks, setM1AnalysisTicks] = useState(() => {
        try { return localStorage.getItem('auto_trades_m1_analysisTicks') || '1'; } catch { return '1'; }
    });
    const [m1InverseMode, setM1InverseMode] = useState(() => {
        try { return localStorage.getItem('auto_trades_m1_inverseMode') === 'true'; } catch { return false; }
    });
    const [m1StrategyMode, setM1StrategyMode] = useState<StrategyMode>(() => {
        try { return (localStorage.getItem('auto_trades_m1_strategyMode') as StrategyMode) || 'STANDARD'; } catch { return 'STANDARD'; }
    });
    const [m1StrategyTemplate, setM1StrategyTemplate] = useState<StrategyTemplate>(() => {
        const saved = localStorage.getItem('auto_trades_m1_strategyTemplate');
        return STRATEGY_TEMPLATE_IDS.includes(saved as StrategyTemplate) ? (saved as StrategyTemplate) : 'STANDARD';
    });

    // ─── Market 2 Config ──────────────────────────────────────────────────

    const [m2Enabled, setM2Enabled] = useState(() => {
        try { return localStorage.getItem('auto_trades_m2_enabled') === 'true'; } catch { return false; }
    });
    const [m2TradeType, setM2TradeType] = useState<TradeType>(() => {
        const v = localStorage.getItem('auto_trades_m2_tradeType');
        return VALID_TRADE_TYPES.includes(v as TradeType) ? (v as TradeType) : 'DIGITUNDER';
    });
    const [m2Barrier, setM2Barrier] = useState(() => {
        try { return localStorage.getItem('auto_trades_m2_barrier') || '5'; } catch { return '5'; }
    });
    const [m2PredictionBeforeLoss, setM2PredictionBeforeLoss] = useState(() => {
        try { return localStorage.getItem('auto_trades_m2_predictionBeforeLoss') || '4'; } catch { return '4'; }
    });
    const [m2PredictionAfterLoss, setM2PredictionAfterLoss] = useState(() => {
        try { return localStorage.getItem('auto_trades_m2_predictionAfterLoss') || '5'; } catch { return '5'; }
    });
    const [m2Streak, setM2Streak] = useState(() => {
        try { return localStorage.getItem('auto_trades_m2_streak') || '4'; } catch { return '4'; }
    });
    const [m2AnalysisTicks, setM2AnalysisTicks] = useState(() => {
        try { return localStorage.getItem('auto_trades_m2_analysisTicks') || '1'; } catch { return '1'; }
    });
    const [m2InverseMode, setM2InverseMode] = useState(() => {
        try { return localStorage.getItem('auto_trades_m2_inverseMode') === 'true'; } catch { return false; }
    });
    const [m2StrategyMode, setM2StrategyMode] = useState<StrategyMode>(() => {
        try { return (localStorage.getItem('auto_trades_m2_strategyMode') as StrategyMode) || 'STANDARD'; } catch { return 'STANDARD'; }
    });

    // ─── Trading Mode ────────────────────────────────────────────────────────

    type TradingMode = 'market1_only' | 'market2_only' | 'recovery_mode';
    const [tradingMode, setTradingMode] = useState<TradingMode>(() => {
        try { return (localStorage.getItem('auto_trades_trading_mode') as TradingMode) || 'market1_only'; } catch { return 'market1_only'; }
    });

    // ─── Shared State ──────────────────────────────────────────────────────

    const [selectedMarketSymbols, setSelectedMarketSymbols] = useState<string[]>(() => {
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
        } catch { /* Ignore */ }
        return AUTO_MARKET_SYMBOLS;
    });

    const [totalPnl, setTotalPnl] = useState(0);
    const [totalTrades, setTotalTrades] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [isRunning, setIsRunning] = useState(false);
    const [isConnected, setIsConnected] = useState(false);
    const [showDisclaimer, setShowDisclaimer] = useState(false);
    const [currentStakeDisplay, setCurrentStakeDisplay] = useState(1);
    const [dataStreamLoading, setDataStreamLoading] = useState(false);
    const [dataStreamMessage, setDataStreamMessage] = useState('Loading selected market data...');
    const [floatingStrategyAlert, setFloatingStrategyAlert] = useState<FloatingStrategyAlert | null>(null);
    const [showTPSLNotification, setShowTPSLNotification] = useState(false);

    const selectedMarkets = useMemo(
        () => AUTO_MARKETS.filter(market => selectedMarketSymbols.includes(market.symbol)),
        [selectedMarketSymbols]
    );
    const availableMarkets = useMemo(
        () => AUTO_MARKETS.filter(market => !selectedMarketSymbols.includes(market.symbol)),
        [selectedMarketSymbols]
    );

    // ─── Refs ──────────────────────────────────────────────────────────────

    const subscriptionsRef = useRef<Record<string, any>>({});
    const candleSubscriptionsRef = useRef<Record<string, any>>({});
    const selectedMarketsRef = useRef<AutoMarket[]>(selectedMarkets);
    const selectedMarketSymbolsRef = useRef<Set<string>>(new Set(selectedMarketSymbols));
    const monitoredMarketSymbolsRef = useRef<Set<string>>(new Set(selectedMarketSymbols));
    const marketStatesRef = useRef<Record<string, MarketState>>(
        Object.fromEntries(AUTO_MARKETS.map(m => [m.symbol, createMarketState()]))
    );
    const totalPnlRef = useRef(0);
    const totalTradesRef = useRef(0);
    const runningRef = useRef(false);
    const globalTradingRef = useRef(false);
    const nextStakeRef = useRef(1);
    const consecutiveLossRef = useRef(0);
    const previousContractResultRef = useRef<'win' | 'loss' | null>(null);
    const lastTickAtRef = useRef(0);
    const restartInFlightRef = useRef(false);
    const lastRestartAttemptAtRef = useRef(0);
    const subscriptionVersionRef = useRef(0);
    const handleTickRef = useRef<(symbol: string, tick: any) => void>(() => {});
    const handleCandleRef = useRef<(symbol: string, candle: any) => void>(() => {});
    const lastUiRefreshAtRef = useRef(0);
    const uiRefreshTimerRef = useRef<number | null>(null);
    const restartTimerRef = useRef<number | null>(null);
    const modeTransitionTimerRef = useRef<number | null>(null);
    const contractStreamAbortControllersRef = useRef<Set<AbortController>>(new Set());
    const show_auto = active_tab === DBOT_TABS.AUTO_TRADES;
    const show_auto_ref = useRef(show_auto);
    show_auto_ref.current = show_auto;
    const unmountedRef = useRef(false);
    const stopTradingRef = useRef<() => void>(() => {});
    const floatingStrategyAlertRef = useRef<FloatingStrategyAlert | null>(null);
    const isRecoveringDataRef = useRef(false);
    const tradingModeRef = useRef<TradingMode>('market1_only');
    const m2EnabledRef = useRef(false);
    const activeMarketRef = useRef<'m1' | 'm2' | null>(null);
    const recoveryBlockedRef = useRef(false);

    // ─── Shared Config Refs ──────────────────────────────────────────────

    const sharedConfigRef = useRef({
        stake: 1,
        martingale: 2,
        takeProfit: 100,
        stopLoss: 100,
        martingaleMode: 'after_one_loss' as MartingaleModeType,
        consecutiveLossThreshold: 2,
    });

    // ─── Market Config Refs ──────────────────────────────────────────────

    const m1ConfigRef = useRef({
        tradeType: 'DIGITOVER' as TradeType,
        barrier: 4,
        predictionBeforeLoss: 4,
        predictionAfterLoss: 5,
        streak: 4,
        analysisTicks: 1,
        inverseMode: false,
        strategyMode: 'STANDARD' as StrategyMode,
        strategyTemplate: 'STANDARD' as StrategyTemplate,
    });

    const m2ConfigRef = useRef({
        enabled: false,
        tradeType: 'DIGITUNDER' as TradeType,
        barrier: 5,
        predictionBeforeLoss: 4,
        predictionAfterLoss: 5,
        streak: 4,
        analysisTicks: 1,
        inverseMode: false,
        strategyMode: 'STANDARD' as StrategyMode,
    });

    // ─── Effect: Sync shared config to ref ───────────────────────────────

    useEffect(() => {
        sharedConfigRef.current = {
            stake: Number(sharedStake) || 1,
            martingale: Math.max(1.01, Number(sharedMartingale) || 2),
            takeProfit: Number(sharedTakeProfit) || 100,
            stopLoss: Number(sharedStopLoss) || 100,
            martingaleMode: sharedMartingaleMode,
            consecutiveLossThreshold: clampConsecutiveLossThreshold(sharedConsecutiveLossCount),
        };
    }, [sharedStake, sharedMartingale, sharedTakeProfit, sharedStopLoss, sharedMartingaleMode, sharedConsecutiveLossCount]);

    // ─── Effect: Sync M1 config to ref ───────────────────────────────────

    useEffect(() => {
        m1ConfigRef.current = {
            tradeType: m1TradeType,
            barrier: getDigitNumber(m1Barrier, 4),
            predictionBeforeLoss: getDigitNumber(m1PredictionBeforeLoss, 4),
            predictionAfterLoss: getDigitNumber(m1PredictionAfterLoss, 5),
            streak: Math.min(10, Math.max(1, Number(m1Streak) || 4)),
            analysisTicks: Math.min(10, Math.max(1, Number(m1AnalysisTicks) || 1)),
            inverseMode: m1InverseMode,
            strategyMode: m1StrategyMode,
            strategyTemplate: m1StrategyTemplate,
        };
    }, [m1TradeType, m1Barrier, m1PredictionBeforeLoss, m1PredictionAfterLoss, m1Streak, m1AnalysisTicks, m1InverseMode, m1StrategyMode, m1StrategyTemplate]);

    // ─── Effect: Sync M2 config to ref ───────────────────────────────────

    useEffect(() => {
        m2ConfigRef.current = {
            enabled: m2Enabled,
            tradeType: m2TradeType,
            barrier: getDigitNumber(m2Barrier, 5),
            predictionBeforeLoss: getDigitNumber(m2PredictionBeforeLoss, 4),
            predictionAfterLoss: getDigitNumber(m2PredictionAfterLoss, 5),
            streak: Math.min(10, Math.max(1, Number(m2Streak) || 4)),
            analysisTicks: Math.min(10, Math.max(1, Number(m2AnalysisTicks) || 1)),
            inverseMode: m2InverseMode,
            strategyMode: m2StrategyMode,
        };
    }, [m2Enabled, m2TradeType, m2Barrier, m2PredictionBeforeLoss, m2PredictionAfterLoss, m2Streak, m2AnalysisTicks, m2InverseMode, m2StrategyMode]);

    // ─── Effect: Save shared config ──────────────────────────────────────

    useEffect(() => {
        try {
            localStorage.setItem('auto_trades_shared_stake', sharedStake);
            localStorage.setItem('auto_trades_shared_martingale', sharedMartingale);
            localStorage.setItem('auto_trades_shared_takeProfit', sharedTakeProfit);
            localStorage.setItem('auto_trades_shared_stopLoss', sharedStopLoss);
            localStorage.setItem('auto_trades_shared_martingaleMode', sharedMartingaleMode);
            localStorage.setItem('auto_trades_shared_consecutiveLossCount', String(sharedConsecutiveLossCount));
        } catch { /* Ignore */ }
    }, [sharedStake, sharedMartingale, sharedTakeProfit, sharedStopLoss, sharedMartingaleMode, sharedConsecutiveLossCount]);

    // ─── Effect: Save M1 config ──────────────────────────────────────────

    useEffect(() => {
        try {
            localStorage.setItem('auto_trades_m1_tradeType', m1TradeType);
            localStorage.setItem('auto_trades_m1_barrier', m1Barrier);
            localStorage.setItem('auto_trades_m1_predictionBeforeLoss', m1PredictionBeforeLoss);
            localStorage.setItem('auto_trades_m1_predictionAfterLoss', m1PredictionAfterLoss);
            localStorage.setItem('auto_trades_m1_streak', m1Streak);
            localStorage.setItem('auto_trades_m1_analysisTicks', m1AnalysisTicks);
            localStorage.setItem('auto_trades_m1_inverseMode', String(m1InverseMode));
            localStorage.setItem('auto_trades_m1_strategyMode', m1StrategyMode);
            localStorage.setItem('auto_trades_m1_strategyTemplate', m1StrategyTemplate);
        } catch { /* Ignore */ }
    }, [m1TradeType, m1Barrier, m1PredictionBeforeLoss, m1PredictionAfterLoss, m1Streak, m1AnalysisTicks, m1InverseMode, m1StrategyMode, m1StrategyTemplate]);

    // ─── Effect: Save M2 config ──────────────────────────────────────────

    useEffect(() => {
        try {
            localStorage.setItem('auto_trades_m2_tradeType', m2TradeType);
            localStorage.setItem('auto_trades_m2_barrier', m2Barrier);
            localStorage.setItem('auto_trades_m2_predictionBeforeLoss', m2PredictionBeforeLoss);
            localStorage.setItem('auto_trades_m2_predictionAfterLoss', m2PredictionAfterLoss);
            localStorage.setItem('auto_trades_m2_streak', m2Streak);
            localStorage.setItem('auto_trades_m2_analysisTicks', m2AnalysisTicks);
            localStorage.setItem('auto_trades_m2_inverseMode', String(m2InverseMode));
            localStorage.setItem('auto_trades_m2_strategyMode', m2StrategyMode);
        } catch { /* Ignore */ }
    }, [m2TradeType, m2Barrier, m2PredictionBeforeLoss, m2PredictionAfterLoss, m2Streak, m2AnalysisTicks, m2InverseMode, m2StrategyMode]);

    // ─── Effect: Save trading mode ───────────────────────────────────────

    useEffect(() => {
        tradingModeRef.current = tradingMode;
        m2EnabledRef.current = m2Enabled;
        try {
            localStorage.setItem('auto_trades_trading_mode', tradingMode);
            localStorage.setItem('auto_trades_m2_enabled', String(m2Enabled));
        } catch { /* Ignore */ }
    }, [tradingMode, m2Enabled]);

    // ─── Effect: Save markets ─────────────────────────────────────────────

    useEffect(() => {
        selectedMarketsRef.current = selectedMarkets;
        selectedMarketSymbolsRef.current = new Set(selectedMarketSymbols);
        selectedMarketSymbols.forEach(symbol => {
            if (!marketStatesRef.current[symbol]) marketStatesRef.current[symbol] = createMarketState();
        });
        try {
            localStorage.setItem('auto_trades_markets', JSON.stringify(selectedMarketSymbols));
        } catch { /* Ignore */ }
    }, [selectedMarketSymbols, selectedMarkets]);

    useEffect(() => {
        monitoredMarketSymbolsRef.current = new Set(
            m1StrategyTemplate === 'STANDARD' ? selectedMarketSymbols : AUTO_MARKET_SYMBOLS
        );
    }, [selectedMarketSymbols, m1StrategyTemplate]);

    useEffect(() => {
        floatingStrategyAlertRef.current = floatingStrategyAlert;
    }, [floatingStrategyAlert]);

    // ─── UI Helpers ────────────────────────────────────────────────────────

    const setDataRecoveryLoading = useCallback((message: string) => {
        if (unmountedRef.current || !show_auto_ref.current) return;
        isRecoveringDataRef.current = true;
        setDataStreamMessage(message);
        setDataStreamLoading(true);
    }, []);

    const clearDataRecoveryLoading = useCallback(() => {
        if (unmountedRef.current) return;
        isRecoveringDataRef.current = false;
        setDataStreamLoading(false);
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

    const flushDisplays = useCallback(() => {
        if (unmountedRef.current || !show_auto_ref.current) return;
        lastUiRefreshAtRef.current = Date.now();
        setMarketDisplays(
            selectedMarketsRef.current.map(m => ({
                ...m,
                ...(marketStatesRef.current[m.symbol] || createMarketState()),
                currentStake: nextStakeRef.current,
            }))
        );
        setTotalPnl(totalPnlRef.current);
        setTotalTrades(totalTradesRef.current);
        setCurrentStakeDisplay(nextStakeRef.current);
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

    const [marketDisplays, setMarketDisplays] = useState<MarketDisplay[]>(
        selectedMarkets.map(m => ({
            ...m,
            ...createMarketState(),
            currentStake: 1,
        }))
    );

    useEffect(() => {
        refreshDisplays();
    }, [refreshDisplays, selectedMarketSymbols]);

    // ─── Market Helpers ────────────────────────────────────────────────────

    const getActiveConfig = useCallback((symbol: string): {
        config: typeof m1ConfigRef.current;
        sharedConfig: typeof sharedConfigRef.current;
        isMarket2: boolean;
        isRecovery: boolean;
        isBlocked: boolean;
    } => {
        const state = marketStatesRef.current[symbol];
        if (!state) return { 
            config: m1ConfigRef.current, 
            sharedConfig: sharedConfigRef.current, 
            isMarket2: false, 
            isRecovery: false,
            isBlocked: false
        };

        const isRecoveryMode = tradingModeRef.current === 'recovery_mode' && m2EnabledRef.current;
        
        if (isRecoveryMode && recoveryBlockedRef.current) {
            return { 
                config: m2ConfigRef.current, 
                sharedConfig: sharedConfigRef.current, 
                isMarket2: true, 
                isRecovery: true,
                isBlocked: true
            };
        }

        if (tradingModeRef.current === 'market2_only' && m2EnabledRef.current) {
            return { 
                config: m2ConfigRef.current, 
                sharedConfig: sharedConfigRef.current, 
                isMarket2: true, 
                isRecovery: false,
                isBlocked: false
            };
        }

        return { 
            config: m1ConfigRef.current, 
            sharedConfig: sharedConfigRef.current, 
            isMarket2: false, 
            isRecovery: false,
            isBlocked: false
        };
    }, []);

    const getActiveTradeType = useCallback((symbol: string): TradeType => {
        const { config } = getActiveConfig(symbol);
        return config.tradeType;
    }, [getActiveConfig]);

    const getActiveBarrier = useCallback((symbol: string, lastResult: 'win' | 'loss' | null, consecutiveLosses = 0) => {
        const { config } = getActiveConfig(symbol);
        return getPredictionForLastOutcome({
            trade_type: config.tradeType,
            last_result: lastResult,
            consecutive_losses: consecutiveLosses,
            prediction_before_loss: config.predictionBeforeLoss,
            prediction_after_loss: config.predictionAfterLoss,
            fallback_barrier: config.barrier,
        });
    }, [getActiveConfig]);

    const getActiveStreak = useCallback((symbol: string): number => {
        const { config } = getActiveConfig(symbol);
        return getEffectiveSignalStreak({
            trade_type: config.tradeType,
            configured_streak: config.streak,
        });
    }, [getActiveConfig]);

    const getActiveInverse = useCallback((symbol: string): boolean => {
        const { config } = getActiveConfig(symbol);
        return config.inverseMode;
    }, [getActiveConfig]);

    const getActiveStrategyMode = useCallback((symbol: string): StrategyMode => {
        const { config } = getActiveConfig(symbol);
        return config.strategyMode;
    }, [getActiveConfig]);

    // ─── Pattern Detection ─────────────────────────────────────────────────

    const isPatternDigit = useCallback((
        symbol: string,
        digit: number,
        tradeType: TradeType,
        barrier: number,
        inverse: boolean
    ): boolean => {
        return isDigitSignalMatch({
            trade_type: tradeType,
            digit,
            barrier,
            inverse,
        });
    }, []);

    // ─── Trade Execution ──────────────────────────────────────────────────

    const pushContract = useCallback((data: any) => {
        try {
            transactions.pushTransaction({ ...data, run_id: run_panel.run_id });
            run_panel.onBotContractEvent(data);
            summary_card.onBotContractEvent(data);
        } catch { /* Ignore */ }
    }, [run_panel, summary_card, transactions]);

    const completeRunPanelStop = useCallback(() => {
        try {
            run_panel.is_contract_buying_in_progress = false;
            run_panel.setIsRunning(false);
            run_panel.setHasOpenContract?.(false);
            run_panel.setContractStage?.(contract_stages.NOT_RUNNING);
            run_panel.setShowBotStopMessage?.(false);
        } catch { /* Ignore */ }

        try {
            api_base.is_stopping = false;
            api_base.setIsRunning?.(false);
        } catch { /* Ignore */ }
    }, [run_panel]);

    const clearDeferredWork = useCallback(() => {
        if (uiRefreshTimerRef.current !== null) {
            window.clearTimeout(uiRefreshTimerRef.current);
            uiRefreshTimerRef.current = null;
        }
        if (restartTimerRef.current !== null) {
            window.clearTimeout(restartTimerRef.current);
            restartTimerRef.current = null;
        }
        if (modeTransitionTimerRef.current !== null) {
            window.clearTimeout(modeTransitionTimerRef.current);
            modeTransitionTimerRef.current = null;
        }
        contractStreamAbortControllersRef.current.forEach(controller => controller.abort());
        contractStreamAbortControllersRef.current.clear();
        restartInFlightRef.current = false;
    }, []);

    // ─── EXECUTE TRADE ──────────────────────────────────────────────────────
    const executeTrade = useCallback(
        async (symbol: string, stakeAmount: number, lastResult: 'win' | 'loss' | null): Promise<number> => {
            if (globalTradingRef.current) {
                console.warn('[AutoTrades] Trade already in progress, skipping');
                return 0;
            }
            
            const { config, sharedConfig } = getActiveConfig(symbol);
            const ct = config.tradeType;
            const bar = getActiveBarrier(symbol, lastResult, 0);
            const tradeStartTime = Math.floor(Date.now() / 1000);
            const verificationId = `${symbol}_${tradeStartTime}_${Math.random().toString(36).substring(2, 11)}`;
            const abortController = new AbortController();

            const params: Record<string, any> = {
                amount: stakeAmount,
                basis: 'stake',
                contract_type: ct,
                currency: currency || 'USD',
                duration: config.analysisTicks,
                duration_unit: 't',
                symbol,
            };
            if (BARRIER_NEEDED[ct]) params.barrier = String(bar);

            globalTradingRef.current = true;

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
                globalTradingRef.current = false;
            }
        },
        [currency, getActiveConfig, getActiveBarrier, pushContract, setError]
    );

    // ─── After Trade Handler ──────────────────────────────────────────────
    // FIXED: Martingale applied immediately after EVERY loss
    const handleAfterTrade = useCallback((symbol: string, profit: number, isMarket2: boolean) => {
        if (!runningRef.current) return;
        const state = marketStatesRef.current[symbol];
        if (!state) return;

        const { config, sharedConfig, isRecovery, isBlocked } = getActiveConfig(symbol);
        const { martingale: mult, takeProfit: tp, stopLoss: sl, stake: baseStake } = sharedConfig;

        totalPnlRef.current = parseFloat((totalPnlRef.current + profit).toFixed(2));
        totalTradesRef.current++;

        const martingaleMode = sharedConfig.martingaleMode;
        const consecutiveLossThreshold = sharedConfig.consecutiveLossThreshold;
        const currentConsecutiveLosses = isMarket2 ? state.market2ConsecutiveLosses : consecutiveLossRef.current;

        // ─── MARTINGALE - Applied IMMEDIATELY on EVERY loss ──────────────────────
        // getNextMartingaleState now handles all logic including immediate application
        const nextMartingaleState = getNextMartingaleState({
            profit,
            current_stake: nextStakeRef.current,
            base_stake: baseStake,
            multiplier: mult,
            martingale_mode: martingaleMode,
            consecutive_losses: currentConsecutiveLosses,
            consecutive_loss_trigger: consecutiveLossThreshold,
        });

        // Update consecutive losses and last result
        if (isMarket2) {
            state.market2ConsecutiveLosses = nextMartingaleState.consecutiveLosses;
            state.market2LastResult = nextMartingaleState.lastResult;
            state.market2Consecutive = profit >= 0 ? 0 : state.market2Consecutive + 1;
        } else {
            consecutiveLossRef.current = nextMartingaleState.consecutiveLosses;
            previousContractResultRef.current = nextMartingaleState.lastResult;
            state.consecutive = profit >= 0 ? 0 : state.consecutive + 1;
        }

        // ALWAYS use the calculated next stake from martingale
        nextStakeRef.current = nextMartingaleState.nextStake;
        state.lastResult = nextMartingaleState.lastResult;
        state.tradeCount++;
        state.trading = false;
        globalTradingRef.current = false;

        // ─── RECOVERY MODE LOGIC ──────────────────────────────────────────
        const isRecoveryMode = tradingModeRef.current === 'recovery_mode' && m2EnabledRef.current;

        if (isRecoveryMode) {
            if (profit < 0) {
                // LOSS → BLOCK ALL MARKETS, switch to M2
                recoveryBlockedRef.current = true;
                state.recoveryActive = true;
                state.recoveryStartTime = Date.now();
                state.activeMarket = 'm2';
                activeMarketRef.current = 'm2';
                state.market2Consecutive = 0;
                state.market2ConsecutiveLosses = 0;
                state.market2LastResult = null;
                state.consecutive = 0;
                consecutiveLossRef.current = 0;
                previousContractResultRef.current = null;
                // Reset stake to base when entering recovery
                nextStakeRef.current = sharedConfigRef.current.stake;

                Object.values(marketStatesRef.current).forEach(s => {
                    s.recoveryBlocked = true;
                    s.recoveryActive = true;
                });

                conditionNotifierStore.setCondition({
                    market: AUTO_MARKET_LOOKUP.get(symbol)?.label ?? symbol,
                    condition: `🔴 LOSS — BLOCKING ALL MARKETS, switching to M2 with martingale`,
                    digits: '',
                    result: false,
                    source: 'recovery-loss',
                    timestamp: Date.now(),
                });
                
                console.log(`[Recovery] LOSS - ALL MARKETS BLOCKED, M2 ACTIVE, martingale applied`);
            } else if (profit >= 0 && isMarket2) {
                // WIN on M2 → UNBLOCK ALL MARKETS, return to M1
                recoveryBlockedRef.current = false;
                state.recoveryActive = false;
                state.recoveryStartTime = null;
                state.activeMarket = 'm1';
                activeMarketRef.current = 'm1';
                state.market2Consecutive = 0;
                state.market2ConsecutiveLosses = 0;
                state.market2LastResult = null;
                state.consecutive = 0;
                consecutiveLossRef.current = 0;
                previousContractResultRef.current = null;
                nextStakeRef.current = sharedConfigRef.current.stake;

                Object.values(marketStatesRef.current).forEach(s => {
                    s.recoveryBlocked = false;
                    s.recoveryActive = false;
                });

                conditionNotifierStore.setCondition({
                    market: AUTO_MARKET_LOOKUP.get(symbol)?.label ?? symbol,
                    condition: `✅ WIN on M2 — RECOVERY COMPLETE. ALL MARKETS UNBLOCKED, returning to M1`,
                    digits: '',
                    result: true,
                    source: 'recovery-win',
                    timestamp: Date.now(),
                });
                
                console.log(`[Recovery] WIN on M2 - ALL MARKETS UNBLOCKED, M1 ACTIVE`);
            } else if (profit < 0 && isMarket2) {
                // LOSS on M2 → Stay on M2 with martingale, ALL MARKETS remain BLOCKED
                state.activeMarket = 'm2';
                activeMarketRef.current = 'm2';
                
                Object.values(marketStatesRef.current).forEach(s => {
                    s.recoveryBlocked = true;
                });

                conditionNotifierStore.setCondition({
                    market: AUTO_MARKET_LOOKUP.get(symbol)?.label ?? symbol,
                    condition: `🔴 LOSS on M2 — Continuing recovery on M2 (ALL MARKETS remain BLOCKED)`,
                    digits: '',
                    result: false,
                    source: 'recovery-m2-loss',
                    timestamp: Date.now(),
                });
                
                console.log(`[Recovery] M2 LOSS - Staying on M2, ALL MARKETS remain BLOCKED`);
            } else if (profit >= 0 && !isMarket2) {
                // WIN on M1 → Reset everything
                recoveryBlockedRef.current = false;
                consecutiveLossRef.current = 0;
                previousContractResultRef.current = null;
                nextStakeRef.current = sharedConfigRef.current.stake;
                state.consecutive = 0;
                state.recoveryActive = false;
                state.recoveryStartTime = null;
                state.market2Consecutive = 0;
                state.market2ConsecutiveLosses = 0;
                state.market2LastResult = null;
                state.activeMarket = 'm1';
                activeMarketRef.current = 'm1';

                Object.values(marketStatesRef.current).forEach(s => {
                    s.recoveryBlocked = false;
                    s.recoveryActive = false;
                });
            }
        } else {
            // Normal mode: reset on win
            if (profit >= 0) {
                if (isMarket2) {
                    state.market2ConsecutiveLosses = 0;
                    state.market2LastResult = null;
                } else {
                    consecutiveLossRef.current = 0;
                    previousContractResultRef.current = null;
                }
                nextStakeRef.current = sharedConfigRef.current.stake;
            }
            // On loss, keep the martingale stake that was already set by getNextMartingaleState
        }

        refreshDisplays();

        // ─── TP/SL Check ──────────────────────────────────────────────────

        const currentTP = sharedConfigRef.current.takeProfit;
        const currentSL = sharedConfigRef.current.stopLoss;

        if ((totalPnlRef.current >= currentTP || totalPnlRef.current <= -currentSL) && runningRef.current) {
            setShowTPSLNotification(true);
            runningRef.current = false;
            if (!unmountedRef.current) {
                setIsRunning(false);
            }
            completeRunPanelStop();
        }
    }, [completeRunPanelStop, getActiveConfig, refreshDisplays]);

    // ─── Try Execute Signal ──────────────────────────────────────────────

    const tryExecuteSignal = useCallback((
        symbol: string,
        state: MarketState,
        signalReady: boolean,
        isMarket2: boolean
    ) => {
        const isRecoveryMode = tradingModeRef.current === 'recovery_mode' && m2EnabledRef.current;
        
        if (isRecoveryMode && recoveryBlockedRef.current) {
            if (!isMarket2) {
                return;
            }
        }

        if (isRecoveryMode && !recoveryBlockedRef.current && isMarket2) {
            return;
        }

        if (tradingModeRef.current === 'market2_only' && !isMarket2) {
            return;
        }

        if (tradingModeRef.current === 'market1_only' && isMarket2) {
            return;
        }

        if (globalTradingRef.current) {
            return;
        }

        if (
            runningRef.current &&
            signalReady &&
            !state.trading &&
            !globalTradingRef.current
        ) {
            state.trading = true;
            state.tradeStartTime = Math.floor(Date.now() / 1000);
            state.verificationId = `${symbol}_${state.tradeStartTime}_${Math.random().toString(36).substring(2, 11)}`;

            const stakeNow = nextStakeRef.current;

            if (stakeNow <= 0 || isNaN(stakeNow)) {
                console.error(`[AutoTrades] Sanity check failed: Invalid stake amount ${stakeNow} for ${symbol}`);
                state.trading = false;
                globalTradingRef.current = false;
                setError('Auto Trades stopped because the stake amount is invalid.');
                refreshDisplays();
                return;
            }

            const lastResult = isMarket2 ? state.market2LastResult : previousContractResultRef.current;
            executeTrade(symbol, stakeNow, lastResult).then(profit =>
                handleAfterTrade(symbol, profit, isMarket2)
            );
        }
    }, [executeTrade, handleAfterTrade, refreshDisplays]);

    // ─── Tick Handler ─────────────────────────────────────────────────────

    const handleTick = useCallback((symbol: string, tick: any) => {
        if (!monitoredMarketSymbolsRef.current.has(symbol)) return;

        const state = marketStatesRef.current[symbol];
        if (!state) return;

        const pip = getMarketPipSize(symbol, AUTO_MARKET_LOOKUP.get(symbol)?.pip ?? 2);
        const quote = tick.quote as number;

        state.lastQuote = quote;
        state.isRecovering = false;
        lastTickAtRef.current = Date.now();
        if (isRecoveringDataRef.current) {
            clearDataRecoveryLoading();
        }

        const isRecoveryMode = tradingModeRef.current === 'recovery_mode' && m2EnabledRef.current;
        const isBlocked = isRecoveryMode && recoveryBlockedRef.current;

        let activeConfig = m1ConfigRef.current;
        let isMarket2 = false;
        let isRecovery = false;

        if (isRecoveryMode && isBlocked) {
            activeConfig = m2ConfigRef.current;
            isMarket2 = true;
            isRecovery = true;
            state.activeMarket = 'm2';
            activeMarketRef.current = 'm2';
            state.recoveryBlocked = true;
        } else if (isRecoveryMode && !isBlocked) {
            activeConfig = m1ConfigRef.current;
            isMarket2 = false;
            isRecovery = true;
            state.activeMarket = 'm1';
            activeMarketRef.current = 'm1';
            state.recoveryBlocked = false;
        } else if (tradingModeRef.current === 'market2_only' && m2EnabledRef.current) {
            activeConfig = m2ConfigRef.current;
            isMarket2 = true;
            isRecovery = false;
            state.activeMarket = 'm2';
            activeMarketRef.current = 'm2';
            state.recoveryBlocked = false;
        } else {
            activeConfig = m1ConfigRef.current;
            isMarket2 = false;
            isRecovery = false;
            state.activeMarket = 'm1';
            activeMarketRef.current = 'm1';
            state.recoveryBlocked = false;
        }

        const ct = activeConfig.tradeType;
        const barrier = getActiveBarrier(symbol, isMarket2 ? state.market2LastResult : previousContractResultRef.current, isMarket2 ? state.market2ConsecutiveLosses : consecutiveLossRef.current);
        const inverse = activeConfig.inverseMode;
        const streak = activeConfig.streak;
        const strategyMode = activeConfig.strategyMode;
        const targetLen = getEffectiveSignalStreak({ trade_type: ct, configured_streak: streak });

        if (IS_DIRECTION_TYPE[ct]) {
            const prev = state.prevQuote;
            const dir: Direction = prev === null ? 0 : quote > prev ? 1 : quote < prev ? -1 : 0;
            state.directionHistory = [...state.directionHistory.slice(-9), dir];
            state.prevQuote = quote;

            if (dir !== 0) {
                const match = inverse ? isInverseDirectionMatch(ct, dir) : isDirectionMatch(ct, dir);
                if (isMarket2) {
                    state.market2Consecutive = match ? Math.min(state.market2Consecutive + 1, 10) : 0;
                } else {
                    state.consecutive = match ? Math.min(state.consecutive + 1, 10) : 0;
                }
            }
        } else {
            const lastDigit = getLastDigitFromQuote(quote, symbol, pip);
            state.lastDigits = [...state.lastDigits.slice(-9), lastDigit];
            state.prevQuote = quote;

            const isMatch = isPatternDigit(symbol, lastDigit, ct, barrier, inverse);
            if (isMarket2) {
                state.market2Consecutive = isMatch ? Math.min(state.market2Consecutive + 1, 10) : 0;
            } else {
                state.consecutive = isMatch ? Math.min(state.consecutive + 1, 10) : 0;
            }
        }

        // ─── STRATEGY TEMPLATE EVALUATION ────────────────────────────────
        if (!isMarket2 && activeConfig.strategyTemplate !== 'STANDARD' && !isBlocked) {
            const evaluation = evaluateDigitStrategy(
                activeConfig.strategyTemplate as DigitStrategyId,
                state.digitPercentages,
                state.lastDigits
            );

            if (evaluation) {
                state.alertActive = evaluation.isQualified;
                state.specialEntryReady = evaluation.entryReady;
                state.trailingTriggerCount = evaluation.trailingTriggerCount;
                state.qualifyingWinningDigits = evaluation.qualifyingWinningDigits;
                state.alertMessage = evaluation.isQualified
                    ? `${evaluation.alertLabel} ready to watch. Winning digits >= 10.5%: ${evaluation.qualifyingWinningDigits.join(', ')}`
                    : `${evaluation.alertLabel} waiting for qualifying percentages.`;

                if (state.alertActive) {
                    const marketLabel = AUTO_MARKET_LOOKUP.get(symbol)?.label ?? symbol;
                    playStrategyAlertSound();
                    setFloatingStrategyAlert({
                        marketLabel,
                        message: state.alertMessage,
                        strategyId: activeConfig.strategyTemplate as DigitStrategyId,
                        symbol,
                    });
                }

                if (runningRef.current && selectedMarketSymbolsRef.current.has(symbol) && !evaluation.isQualified) {
                    stopTradingRef.current();
                    setError(`${AUTO_MARKET_LOOKUP.get(symbol)?.label ?? symbol} no longer matches ${evaluation.alertLabel}. Auto Trades stopped.`);
                    return;
                }

                const signalReady = evaluation.entryReady;
                if (!isBlocked) {
                    tryExecuteSignal(symbol, state, signalReady, false);
                }
                refreshDisplays();
                return;
            }
        }

        // ─── PERCENTAGE MODE ───────────────────────────────────────────────
        if (strategyMode === 'PERCENTAGE') {
            const epoch = Number(tick.epoch);
            appendPercentageQuote(symbol, state, quote, Number.isFinite(epoch) ? epoch : null, ct);
        }

        // ─── SIGNAL CHECK ──────────────────────────────────────────────────
        const requiresCandle = isCandleConfirmedTradeType(ct);
        const candleMatch = requiresCandle ? (inverse ? isInverseCandleMatch(ct, state.candleDirection) : isCandleMatch(ct, state.candleDirection)) : true;

        let signalReady: boolean;

        if (strategyMode === 'PERCENTAGE') {
            signalReady = isPercentageSignalReady(ct, state, barrier) && (!requiresCandle || candleMatch);
        } else {
            const currentStreak = isMarket2 ? state.market2Consecutive : state.consecutive;
            signalReady = currentStreak >= targetLen && (!requiresCandle || candleMatch);
        }

        // ─── CONDITION NOTIFIER ────────────────────────────────────────────
        if (runningRef.current) {
            const mkt = AUTO_MARKET_LOOKUP.get(symbol);
            let condStr = '';
            let digitsStr = '';
            const currentStreak = isMarket2 ? state.market2Consecutive : state.consecutive;

            if (IS_DIRECTION_TYPE[ct]) {
                const dirs = state.directionHistory.slice(-targetLen);
                digitsStr = `[${dirs.map(d => (d === 1 ? '↑' : d === -1 ? '↓' : '—')).join(', ')}]`;
                if (inverse) {
                    if (ct === 'CALL') condStr = `5m candle bullish + consecutive rising ticks ≥ ${targetLen}`;
                    else if (ct === 'PUT') condStr = `5m candle bearish + consecutive falling ticks ≥ ${targetLen}`;
                    else if (ct === 'RUNHIGH') condStr = `5m candle bearish + consecutive rising ticks ≥ ${targetLen}`;
                    else condStr = `5m candle bullish + consecutive falling ticks ≥ ${targetLen}`;
                } else {
                    condStr = getDirectionCondition(ct, targetLen);
                }
            } else {
                const recent = state.lastDigits.slice(-targetLen);
                digitsStr = `[${recent.join(', ')}]`;
                const bar = barrier;
                if (inverse) {
                    if (ct === 'DIGITOVER') condStr = `digits > ${bar} streak ≥ ${targetLen}`;
                    else if (ct === 'DIGITUNDER') condStr = `digits < ${bar} streak ≥ ${targetLen}`;
                    else if (ct === 'DIGITEVEN') condStr = `consecutive even digits ≥ ${targetLen}`;
                    else if (ct === 'DIGITODD') condStr = `consecutive odd digits ≥ ${targetLen}`;
                    else if (ct === 'DIGITMATCH') condStr = `digits = ${bar} streak ≥ ${targetLen}`;
                    else condStr = `digits ≠ ${bar} streak ≥ ${targetLen}`;
                } else {
                    if (ct === 'DIGITOVER') condStr = `digits ≤ ${bar} streak ≥ ${targetLen}`;
                    if (ct === 'DIGITUNDER') condStr = `digits ≥ ${bar} streak ≥ ${targetLen}`;
                    if (ct === 'DIGITEVEN') condStr = `consecutive odd digits ≥ ${targetLen}`;
                    if (ct === 'DIGITODD') condStr = `consecutive even digits ≥ ${targetLen}`;
                    if (ct === 'DIGITMATCH') condStr = `digits ≠ ${bar} streak ≥ ${targetLen}`;
                    if (ct === 'DIGITDIFF') condStr = `digits = ${bar} streak ≥ ${targetLen}`;
                }
            }

            const statusLabel = isBlocked ? '🔴 ALL MARKETS BLOCKED' : isMarket2 ? '📊 M2' : '🟢 M1';
            const prefix = isRecovery ? `🔄 RECOVERY: ${statusLabel}` : isMarket2 ? '📊 M2: ' : '📈 M1: ';

            conditionNotifierStore.setCondition({
                market: mkt?.label ?? symbol,
                condition: prefix + condStr,
                digits: digitsStr,
                result: signalReady,
                source: 'auto',
                timestamp: Date.now(),
            });
        }

        // ─── EXECUTE SIGNAL ────────────────────────────────────────────────
        let shouldExecute = false;
        
        if (isRecoveryMode) {
            if (isBlocked) {
                shouldExecute = isMarket2;
            } else {
                shouldExecute = !isMarket2;
            }
        } else if (tradingModeRef.current === 'market2_only') {
            shouldExecute = isMarket2;
        } else {
            shouldExecute = !isMarket2;
        }

        if (shouldExecute && !globalTradingRef.current) {
            tryExecuteSignal(symbol, state, signalReady, isMarket2);
        }

        refreshDisplays();

    }, [clearDataRecoveryLoading, getActiveBarrier, isPatternDigit, refreshDisplays, tryExecuteSignal]);

    handleTickRef.current = handleTick;

    const handleCandle = useCallback((symbol: string, candle: any) => {
        if (!selectedMarketSymbolsRef.current.has(symbol)) return;

        const state = marketStatesRef.current[symbol];
        if (!state) return;

        const open = Number(candle?.open);
        const close = Number(candle?.close);
        if (!Number.isFinite(open) || !Number.isFinite(close)) return;

        state.candleOpen = open;
        state.candleClose = close;
        state.candleDirection = close > open ? 1 : close < open ? -1 : 0;

        refreshDisplays();
    }, [refreshDisplays]);

    handleCandleRef.current = handleCandle;

    // ─── Subscription Management ─────────────────────────────────────────

    const backfillPercentageTicks = useCallback(async (market: AutoMarket) => {
        const state = marketStatesRef.current[market.symbol];
        if (!state || state.percentageBackfilled || state.percentageBackfillInFlight) return;

        state.percentageBackfillInFlight = true;

        try {
            const response = await (api_base.api as any).send({
                ticks_history: market.symbol,
                end: 'latest',
                count: PERCENTAGE_BACKFILL_COUNT,
                style: 'ticks',
            });
            const history = response?.history;
            const prices = Array.isArray(history?.prices) ? history.prices : [];
            const times = Array.isArray(history?.times) ? history.times : [];
            const quotes: number[] = [];
            const epochs: number[] = [];

            prices.forEach((price: unknown, index: number) => {
                const quote = Number(price);
                if (!Number.isFinite(quote)) return;

                const epoch = Number(times[index]);
                quotes.push(quote);
                epochs.push(Number.isFinite(epoch) ? epoch : Date.now() + index);
            });

            state.percentageQuoteHistory = quotes.slice(-PERCENTAGE_ANALYSIS_HISTORY_SIZE);
            state.percentageEpochHistory = epochs.slice(-state.percentageQuoteHistory.length);
            state.percentageBackfilled = state.percentageQuoteHistory.length > 0;

            if (state.percentageQuoteHistory.length > 0) {
                const latestQuote = state.percentageQuoteHistory[state.percentageQuoteHistory.length - 1];
                rebuildPercentageAnalytics(market.symbol, state, m1TradeType);
                state.lastQuote = latestQuote;
                state.prevQuote = latestQuote;
                state.lastDigits = state.digitHistory.slice(-10);
                state.directionHistory = state.directionSampleHistory.slice(-10);
            }

            refreshDisplays();
        } catch (error) {
            state.percentageBackfilled = false;
            if (!isExpectedStreamInterruption(error)) {
                console.warn(`[AutoTrades] Percentage history backfill failed for ${market.symbol}:`, error);
            }
        } finally {
            state.percentageBackfillInFlight = false;
        }
    }, [m1TradeType, refreshDisplays]);

    const startSubscriptions = useCallback(async () => {
        const subscriptionVersion = subscriptionVersionRef.current;
        const monitorAllMarkets = m1StrategyTemplate !== 'STANDARD';
        const marketsToMonitor = monitorAllMarkets ? AUTO_MARKETS : selectedMarketsRef.current;
        const monitoredSymbolSet = new Set(marketsToMonitor.map(({ symbol }) => symbol));
        const candleSymbolSet = monitorAllMarkets ? new Set<string>() : new Set(selectedMarketsRef.current.map(({ symbol }) => symbol));

        Object.entries(subscriptionsRef.current).forEach(([symbol, sub]) => {
            if (!monitoredSymbolSet.has(symbol)) {
                try { sub?.unsubscribe?.(); } catch { /* Ignore */ }
                delete subscriptionsRef.current[symbol];
                updateSubscriptionDiagnostics();
            }
        });

        Object.entries(candleSubscriptionsRef.current).forEach(([symbol, sub]) => {
            if (!candleSymbolSet.has(symbol)) {
                try { sub?.unsubscribe?.(); } catch { /* Ignore */ }
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
        setDataRecoveryLoading(monitorAllMarkets ? 'Loading strategy scanner data...' : 'Loading selected market data...');

        for (const market of marketsToMonitor) {
            if (m1StrategyMode === 'PERCENTAGE' || m1StrategyTemplate !== 'STANDARD') {
                backfillPercentageTicks(market);
            }

            if (!subscriptionsRef.current[market.symbol]) {
                try {
                    const obs = (api_base.api as any).subscribe({ ticks: market.symbol });
                    const sub = safeSubscribe(
                        obs,
                        (data: any) => {
                            if (subscriptionVersion !== subscriptionVersionRef.current) return;
                            if (!show_auto_ref.current || unmountedRef.current) return;
                            if (data?.error) {
                                if (!isExpectedStreamInterruption(data.error)) {
                                    console.warn(`[AutoTrades] Tick stream error for ${market.symbol}:`, data.error);
                                }
                                return;
                            }
                            if (data?.tick?.quote !== undefined) handleTickRef.current(market.symbol, data.tick);
                        },
                        (streamError: unknown) => {
                            if (subscriptionVersion !== subscriptionVersionRef.current) return;
                            if (!show_auto_ref.current || unmountedRef.current) return;
                            if (!isExpectedStreamInterruption(streamError)) {
                                console.warn(`[AutoTrades] Tick stream error for ${market.symbol}:`, streamError);
                            }
                        }
                    );
                    subscriptionsRef.current[market.symbol] = sub;
                    updateSubscriptionDiagnostics();
                } catch (err) {
                    if (!isExpectedStreamInterruption(err)) {
                        console.error(`[AutoTrades] Subscribe failed for ${market.symbol}:`, err);
                    }
                }
            }

            if (!monitorAllMarkets && !candleSubscriptionsRef.current[market.symbol]) {
                try {
                    const obs = (api_base.api as any).subscribe({
                        ticks_history: market.symbol,
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
                                    console.warn(`[AutoTrades] Candle stream error for ${market.symbol}:`, data.error);
                                }
                                return;
                            }
                            const candle = data?.ohlc ?? (Array.isArray(data?.candles) ? data.candles[data.candles.length - 1] : null);
                            if (candle) handleCandleRef.current(market.symbol, candle);
                        },
                        (streamError: unknown) => {
                            if (subscriptionVersion !== subscriptionVersionRef.current) return;
                            if (!show_auto_ref.current || unmountedRef.current) return;
                            if (!isExpectedStreamInterruption(streamError)) {
                                console.warn(`[AutoTrades] Candle stream error for ${market.symbol}:`, streamError);
                            }
                        }
                    );
                    candleSubscriptionsRef.current[market.symbol] = sub;
                    updateSubscriptionDiagnostics();
                } catch (err) {
                    if (!isExpectedStreamInterruption(err)) {
                        console.error(`[AutoTrades] 5m candle subscribe failed for ${market.symbol}:`, err);
                    }
                }
            }
        }
        setIsConnected(Object.keys(subscriptionsRef.current).length > 0);
        updateSubscriptionDiagnostics();
    }, [backfillPercentageTicks, clearDataRecoveryLoading, m1StrategyMode, m1StrategyTemplate, setDataRecoveryLoading, updateSubscriptionDiagnostics]);

    const stopSubscriptions = useCallback(() => {
        subscriptionVersionRef.current++;
        Object.values(subscriptionsRef.current).forEach(sub => {
            try { sub?.unsubscribe?.(); } catch { /* Ignore */ }
        });
        subscriptionsRef.current = {};
        Object.values(candleSubscriptionsRef.current).forEach(sub => {
            try { sub?.unsubscribe?.(); } catch { /* Ignore */ }
        });
        candleSubscriptionsRef.current = {};
        setIsConnected(false);
        clearDataRecoveryLoading();
        updateSubscriptionDiagnostics();
    }, [clearDataRecoveryLoading, updateSubscriptionDiagnostics]);

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

    // ─── Session Management ──────────────────────────────────────────────

    const resetSession = useCallback(() => {
        const baseStake = sharedConfigRef.current.stake;
        nextStakeRef.current = baseStake;
        globalTradingRef.current = false;
        previousContractResultRef.current = null;
        consecutiveLossRef.current = 0;
        activeMarketRef.current = null;
        recoveryBlockedRef.current = false;

        selectedMarkets.forEach(m => {
            marketStatesRef.current[m.symbol] = createMarketState();
        });
        totalPnlRef.current = 0;
        totalTradesRef.current = 0;
        setTotalPnl(0);
        setTotalTrades(0);
        setCurrentStakeDisplay(baseStake);
        setError(null);
        setShowTPSLNotification(false);
        refreshDisplays();
    }, [refreshDisplays, selectedMarkets]);

    const handleRun = useCallback(() => {
        if (!api_base.is_authorized) {
            setError('Please log in to your Deriv account before trading.');
            return;
        }
        if (selectedMarkets.length === 0) {
            setError('Please select at least one market before running Auto Trades.');
            return;
        }
        setError(null);
        resetSession();
        try {
            run_panel.setIsRunning(true);
            run_panel.setRunId(`run-${Date.now()}`);
            run_panel.setContractStage?.(contract_stages.RUNNING);
            run_panel.toggleDrawer(true);
        } catch { /* Ignore */ }
        dashboard.setActiveTradingModule('auto_trades');
        runningRef.current = true;
        setIsRunning(true);
    }, [dashboard, resetSession, run_panel, selectedMarkets.length]);

    const stopTrading = useCallback(() => {
        runningRef.current = false;
        globalTradingRef.current = false;
        consecutiveLossRef.current = 0;
        previousContractResultRef.current = null;
        activeMarketRef.current = null;
        recoveryBlockedRef.current = false;
        clearDeferredWork();
        Object.values(marketStatesRef.current).forEach(state => {
            state.trading = false;
            state.consecutive = 0;
            state.tradeStartTime = null;
            state.verificationId = null;
            state.recoveryActive = false;
            state.recoveryStartTime = null;
            state.recoveryBlocked = false;
            state.market2Consecutive = 0;
            state.market2ConsecutiveLosses = 0;
            state.market2LastResult = null;
            state.activeMarket = null;
        });
        setIsRunning(false);
        clearDataRecoveryLoading();
        setCurrentStakeDisplay(sharedConfigRef.current.stake);
        nextStakeRef.current = sharedConfigRef.current.stake;
        dashboard.setActiveTradingModule(null);
        setShowTPSLNotification(false);
        recordDiagnosticEvent('auto_trades.stop_trading', {
            selectedMarkets: selectedMarketsRef.current.length,
            tickStreams: Object.keys(subscriptionsRef.current).length,
            candleStreams: Object.keys(candleSubscriptionsRef.current).length,
        });
        updateSubscriptionDiagnostics();
        completeRunPanelStop();
        refreshDisplays();
    }, [clearDataRecoveryLoading, clearDeferredWork, completeRunPanelStop, dashboard, refreshDisplays, updateSubscriptionDiagnostics]);

    const handleStop = useCallback(() => {
        stopTrading();
    }, [stopTrading]);

    useEffect(() => {
        stopTradingRef.current = stopTrading;
    }, [stopTrading]);

    // ─── Lifecycle Effects ───────────────────────────────────────────────

    useEffect(() => {
        unmountedRef.current = false;
        return () => {
            unmountedRef.current = true;
        };
    }, []);

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

    useEffect(() => {
        if (show_auto) {
            if (api_base.api) {
                startSubscriptions();
            } else {
                const id = setInterval(() => {
                    if (api_base.api) {
                        clearInterval(id);
                        startSubscriptions();
                    }
                }, 1000);
                return () => clearInterval(id);
            }
        } else {
            if (runningRef.current) {
                runningRef.current = false;
                setIsRunning(false);
                try { run_panel.setIsRunning(false); } catch { /* Ignore */ }
            }
            clearDeferredWork();
            stopSubscriptions();
        }
        return undefined;
    }, [clearDeferredWork, show_auto, run_panel, startSubscriptions, stopSubscriptions]);

    useEffect(() => {
        if (!show_auto || !api_base.api) return;
        startSubscriptions();
    }, [selectedMarketSymbols, show_auto, startSubscriptions, m1StrategyMode, m1StrategyTemplate]);

    const dataSilenceIntervalRef = useRef<number | null>(null);

    useEffect(() => {
        if (dataSilenceIntervalRef.current) {
            window.clearInterval(dataSilenceIntervalRef.current);
            dataSilenceIntervalRef.current = null;
        }

        if (!show_auto) return undefined;

        dataSilenceIntervalRef.current = window.setInterval(() => {
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
            if (dataSilenceIntervalRef.current) {
                window.clearInterval(dataSilenceIntervalRef.current);
                dataSilenceIntervalRef.current = null;
            }
        };
    }, [restartSubscriptions, show_auto]);

    useEffect(() => {
        if (!run_panel.is_running && runningRef.current && show_auto) {
            stopTrading();
        }
    }, [run_panel.is_running, show_auto, stopTrading]);

    useEffect(
        () => () => {
            unmountedRef.current = true;
            clearDeferredWork();
            subscriptionVersionRef.current++;
            runningRef.current = false;
            stopTrading();
            try {
                run_panel.setIsRunning(false);
                run_panel.setHasOpenContract(false);
            } catch { /* Ignore */ }
            stopSubscriptions();
            Object.values(marketStatesRef.current).forEach(state => {
                state.digitHistory.length = 0;
                state.directionHistory.length = 0;
                state.percentageQuoteHistory.length = 0;
                state.percentageEpochHistory.length = 0;
                state.directionSampleHistory.length = 0;
                state.lastDigits.length = 0;
            });
        },
        [clearDeferredWork, run_panel, stopTrading, stopSubscriptions]
    );

    // ─── Render Helpers ──────────────────────────────────────────────────

    const getMarketStatus = (state: MarketState, symbol: string): {
        label: string;
        isReady: boolean;
        isTrading: boolean;
        isRecovery: boolean;
        isMarket2: boolean;
        isBlocked: boolean;
        streak: number;
        target: number;
        activeLabel: string;
    } => {
        const { config: activeConfig, isMarket2, isRecovery, isBlocked } = getActiveConfig(symbol);
        const targetLen = getEffectiveSignalStreak({ trade_type: activeConfig.tradeType, configured_streak: activeConfig.streak });
        const currentStreak = isMarket2 ? state.market2Consecutive : state.consecutive;
        const requiresCandle = isCandleConfirmedTradeType(activeConfig.tradeType);
        const candleMatch = requiresCandle ? (activeConfig.inverseMode ? isInverseCandleMatch(activeConfig.tradeType, state.candleDirection) : isCandleMatch(activeConfig.tradeType, state.candleDirection)) : true;

        let isReady = currentStreak >= targetLen && (!requiresCandle || candleMatch);

        if (activeConfig.strategyMode === 'PERCENTAGE') {
            const barrier = getActiveBarrier(symbol, isMarket2 ? state.market2LastResult : previousContractResultRef.current, isMarket2 ? state.market2ConsecutiveLosses : consecutiveLossRef.current);
            isReady = isPercentageSignalReady(activeConfig.tradeType, state, barrier) && (!requiresCandle || candleMatch);
        }

        let label = isMarket2 ? 'M2' : 'M1';
        if (isBlocked) label = '🔴 ALL BLOCKED';
        else if (isRecovery && isMarket2) label = '🔄 RECOVERY';
        else if (isRecovery) label = '🟢 M1 ACTIVE';
        
        const activeLabel = isBlocked ? 'M2' : isMarket2 ? 'M2' : 'M1';

        return {
            label,
            isReady,
            isTrading: state.trading,
            isRecovery,
            isMarket2,
            isBlocked,
            streak: currentStreak,
            target: targetLen,
            activeLabel,
        };
    };

    const getMarketSubtitle = (symbol: string): string => {
        const { config, isMarket2, isRecovery, isBlocked } = getActiveConfig(symbol);
        const ct = config.tradeType;
        const inv = config.inverseMode;
        const barrier = getActiveBarrier(symbol, isMarket2 ? null : previousContractResultRef.current, isMarket2 ? 0 : consecutiveLossRef.current);
        const streak = config.streak;

        let modeLabel = isMarket2 ? '📊 M2' : '📈 M1';
        if (isBlocked) modeLabel = '🔴 ALL BLOCKED → M2';
        else if (isRecovery && isMarket2) modeLabel = '🔄 Recovery M2';
        else if (isRecovery) modeLabel = '🟢 M1 Active';

        const label = inv ? INVERSE_LABELS[ct] : TRADE_TYPE_LABELS[ct];

        if (ct === 'DIGITOVER') return `${modeLabel}: Streak ${streak}+ digits ${inv ? '>' : '≤'} ${barrier} → ${label}`;
        if (ct === 'DIGITUNDER') return `${modeLabel}: Streak ${streak}+ digits ${inv ? '<' : '≥'} ${barrier} → ${label}`;
        if (ct === 'CALL') return `${modeLabel}: 5m bullish + ${streak}+ ${inv ? 'rising' : 'falling'} ticks → ${label}`;
        if (ct === 'PUT') return `${modeLabel}: 5m bearish + ${streak}+ ${inv ? 'falling' : 'rising'} ticks → ${label}`;
        if (ct === 'RUNHIGH') return `${modeLabel}: ${inv ? 'bearish' : 'bullish'} 5m + ${streak}+ ${inv ? 'rising' : 'falling'} → ${label}`;
        if (ct === 'RUNLOW') return `${modeLabel}: ${inv ? 'bullish' : 'bearish'} 5m + ${streak}+ ${inv ? 'falling' : 'rising'} → ${label}`;
        if (ct === 'DIGITEVEN') return `${modeLabel}: ${streak}+ consecutive ${inv ? 'Even' : 'Odd'} → ${label}`;
        if (ct === 'DIGITODD') return `${modeLabel}: ${streak}+ consecutive ${inv ? 'Odd' : 'Even'} → ${label}`;
        if (ct === 'DIGITMATCH') return `${modeLabel}: ${streak}+ digits ${inv ? '=' : '≠'} ${barrier} → ${label}`;
        if (ct === 'DIGITDIFF') return `${modeLabel}: ${streak}+ digits ${inv ? '≠' : '='} ${barrier} → ${label}`;
        return `${modeLabel}: ${label}`;
    };

    // ─── Render ──────────────────────────────────────────────────────────

    if (!show_auto) return null;

    const pnlPositive = totalPnl > 0;
    const pnlNegative = totalPnl < 0;
    const baseStakeNum = Number(sharedStake) || 1;
    const martingaleActive = currentStakeDisplay > baseStakeNum;
    const selectedMarketDisplayStates = selectedMarkets.map(
        market => marketDisplays.find(display => display.symbol === market.symbol) ?? marketStatesRef.current[market.symbol]
    );
    const hasAnyLiveQuote = selectedMarkets.length > 0 && selectedMarketDisplayStates.some(display => display?.lastQuote !== null);
    const hasAllLiveQuotes = selectedMarkets.length > 0 && selectedMarketDisplayStates.every(display => display?.lastQuote !== null);
    const isDataLoading = selectedMarketSymbols.length > 0 && ((!hasAnyLiveQuote && (dataStreamLoading || !isConnected || show_auto)) || (!hasAllLiveQuotes && !hasAnyLiveQuote));

    const isM2Available = m2Enabled;
    const isRecoveryMode = tradingMode === 'recovery_mode' && isM2Available;
    const isM2Only = tradingMode === 'market2_only' && isM2Available;
    const isRecoveryActive = isRecoveryMode && recoveryBlockedRef.current;

    return (
        <div className='auto-trades-page'>
            <ThemedScrollbars className='auto-trades-page__scroll'>
                <div className='auto-trades-page__inner'>
                    {/* Header */}
                    <div className='auto-trades-page__header'>
                        <div>
                            <h1 className='auto-trades-page__title'>Auto Trades</h1>
                            <p className='auto-trades-page__subtitle'>
                                {isM2Only ? 'Market 2 Only' : isRecoveryMode ? `🔄 Recovery Mode ${isRecoveryActive ? '(ALL MARKETS BLOCKED → M2 ONLY)' : '(M1 ACTIVE)'}` : 'Market 1 Only'}
                            </p>
                        </div>
                        <div className='auto-trades-page__status-dot'>
                            <span
                                className={classNames('auto-trades-status', {
                                    'auto-trades-status--connected': isConnected,
                                    'auto-trades-status--running': isRunning,
                                    'auto-trades-status--loading': isDataLoading,
                                    'auto-trades-status--recovery': isRecoveryActive,
                                })}
                            />
                            <span className='auto-trades-status__label'>
                                {isRecoveryActive ? '🔴 RECOVERY' : isDataLoading ? 'Loading data' : isRunning ? 'Trading' : isConnected ? 'Live data' : selectedMarketSymbols.length === 0 ? 'No markets' : 'Connecting…'}
                            </span>
                        </div>
                    </div>

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
                                <button type='button' onClick={() => {
                                    const strategy = DIGIT_STRATEGIES[floatingStrategyAlert.strategyId];
                                    if (strategy) {
                                        setM1StrategyTemplate(floatingStrategyAlert.strategyId);
                                        setM1TradeType(strategy.contractType);
                                        setM1Barrier(strategy.winBarrier);
                                        setSelectedMarketSymbols([floatingStrategyAlert.symbol]);
                                    }
                                    setFloatingStrategyAlert(null);
                                }}>
                                    Load market
                                </button>
                                <button type='button' onClick={() => setFloatingStrategyAlert(null)}>
                                    Dismiss
                                </button>
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
                            {/* Trading Mode Selector */}
                            <div className='auto-trades-card'>
                                <h2 className='auto-trades-card__title'>Trading Mode</h2>
                                <div className='auto-trades-mode-selector'>
                                    <button
                                        className={classNames('auto-trades-mode-btn', {
                                            'auto-trades-mode-btn--active': tradingMode === 'market1_only',
                                        })}
                                        onClick={() => setTradingMode('market1_only')}
                                        disabled={isRunning}
                                    >
                                        <span className='auto-trades-mode-btn__icon'>📈</span>
                                        <span className='auto-trades-mode-btn__label'>Market 1 Only</span>
                                        <span className='auto-trades-mode-btn__desc'>Trade only with M1 strategy</span>
                                    </button>
                                    <button
                                        className={classNames('auto-trades-mode-btn', {
                                            'auto-trades-mode-btn--active': tradingMode === 'market2_only',
                                            'auto-trades-mode-btn--disabled': !m2Enabled,
                                        })}
                                        onClick={() => m2Enabled && setTradingMode('market2_only')}
                                        disabled={isRunning || !m2Enabled}
                                    >
                                        <span className='auto-trades-mode-btn__icon'>📊</span>
                                        <span className='auto-trades-mode-btn__label'>Market 2 Only</span>
                                        <span className='auto-trades-mode-btn__desc'>
                                            {m2Enabled ? 'Trade only with M2 strategy' : 'Enable M2 below'}
                                        </span>
                                    </button>
                                    <button
                                        className={classNames('auto-trades-mode-btn', {
                                            'auto-trades-mode-btn--active': tradingMode === 'recovery_mode',
                                            'auto-trades-mode-btn--disabled': !m2Enabled,
                                        })}
                                        onClick={() => m2Enabled && setTradingMode('recovery_mode')}
                                        disabled={isRunning || !m2Enabled}
                                    >
                                        <span className='auto-trades-mode-btn__icon'>🔄</span>
                                        <span className='auto-trades-mode-btn__label'>Recovery Mode</span>
                                        <span className='auto-trades-mode-btn__desc'>
                                            {m2Enabled ? 'Loss → ALL BLOCKED, M2 only. Win → UNBLOCK ALL' : 'Enable M2 below'}
                                        </span>
                                    </button>
                                </div>
                                {!m2Enabled && (
                                    <p className='auto-trades-mode-hint'>Enable Market 2 below to use M2-only or Recovery mode</p>
                                )}
                                {isRecoveryActive && (
                                    <div className='auto-trades-recovery-status' style={{ backgroundColor: '#f44336', color: '#fff', padding: '0.5rem 1rem', borderRadius: '4px', marginTop: '0.5rem' }}>
                                        🔴 ALL MARKETS BLOCKED — M2 ONLY
                                        <br />
                                        <small style={{ fontSize: '0.7rem' }}>Waiting for M2 win to unblock ALL markets</small>
                                    </div>
                                )}
                            </div>

                            {/* Shared Stake/Martingale/TP/SL Section */}
                            <div className='auto-trades-card auto-trades-card--shared'>
                                <h2 className='auto-trades-card__title' style={{ color: '#ffffff', fontSize: '1.1rem' }}>💰 Stake &amp; Risk Management</h2>
                                <p className='auto-trades-card__subtitle' style={{ color: '#a0a0a0', fontSize: '0.85rem' }}>Applies to both Market 1 and Market 2</p>
                                <div className='auto-trades-config'>
                                    <div className='auto-trades-config__group'>
                                        <div className='auto-trades-config__field'>
                                            <label style={{ color: '#e0e0e0', fontWeight: 500 }}>Stake ({currency || 'USD'})</label>
                                            <Input 
                                                type='number' 
                                                min='0.35' 
                                                step='0.01' 
                                                value={sharedStake} 
                                                onChange={e => setSharedStake(e.target.value)} 
                                                disabled={isRunning}
                                                style={{ backgroundColor: '#2a2a3a', color: '#ffffff', border: '1px solid #3a3a4a' }}
                                            />
                                        </div>
                                        <div className='auto-trades-config__field'>
                                            <label style={{ color: '#e0e0e0', fontWeight: 500 }}>Martingale ×</label>
                                            <Input 
                                                type='number' 
                                                min='1.01' 
                                                step='0.5' 
                                                value={sharedMartingale} 
                                                onChange={e => setSharedMartingale(e.target.value)} 
                                                disabled={isRunning}
                                                style={{ backgroundColor: '#2a2a3a', color: '#ffffff', border: '1px solid #3a3a4a' }}
                                            />
                                        </div>
                                        <div className='auto-trades-config__field'>
                                            <label style={{ color: '#e0e0e0', fontWeight: 500 }}>Take Profit ({currency || 'USD'})</label>
                                            <Input 
                                                type='number' 
                                                min='0' 
                                                step='1' 
                                                value={sharedTakeProfit} 
                                                onChange={e => setSharedTakeProfit(e.target.value)} 
                                                disabled={isRunning}
                                                style={{ backgroundColor: '#2a2a3a', color: '#ffffff', border: '1px solid #3a3a4a' }}
                                            />
                                        </div>
                                        <div className='auto-trades-config__field'>
                                            <label style={{ color: '#e0e0e0', fontWeight: 500 }}>Stop Loss ({currency || 'USD'})</label>
                                            <Input 
                                                type='number' 
                                                min='0' 
                                                step='1' 
                                                value={sharedStopLoss} 
                                                onChange={e => setSharedStopLoss(e.target.value)} 
                                                disabled={isRunning}
                                                style={{ backgroundColor: '#2a2a3a', color: '#ffffff', border: '1px solid #3a3a4a' }}
                                            />
                                        </div>
                                    </div>

                                    <div className='auto-trades-config__group'>
                                        <div className='auto-trades-martingale-selector'>
                                            <label style={{ color: '#e0e0e0', fontWeight: 500 }}>Martingale Strategy</label>
                                            <select
                                                className='auto-trades-martingale-selector__select'
                                                value={sharedMartingaleMode}
                                                onChange={e => setSharedMartingaleMode(normalizeMartingaleMode(e.target.value))}
                                                disabled={isRunning}
                                                style={{ backgroundColor: '#2a2a3a', color: '#ffffff', border: '1px solid #3a3a4a' }}
                                            >
                                                <option value='no_martingale'>No Martingale</option>
                                                <option value='after_one_loss'>After 1 loss</option>
                                                <option value='after_two_losses'>After 2 losses</option>
                                                <option value='custom_consecutive_loss_trigger'>Custom loss count</option>
                                            </select>
                                        </div>
                                        {sharedMartingaleMode === 'custom_consecutive_loss_trigger' && (
                                            <div className='auto-trades-config__field' style={{ marginTop: '0.5rem' }}>
                                                <label style={{ color: '#e0e0e0', fontWeight: 500 }}>Consecutive losses before martingale</label>
                                                <Input
                                                    type='number'
                                                    min='1'
                                                    max='10'
                                                    step='1'
                                                    value={sharedConsecutiveLossCountInput}
                                                    onChange={e => {
                                                        const val = e.target.value.replace(/[^\d]/g, '').slice(0, 2);
                                                        setSharedConsecutiveLossCountInput(val);
                                                    }}
                                                    onBlur={() => setSharedConsecutiveLossCount(clampConsecutiveLossThreshold(sharedConsecutiveLossCountInput || 2))}
                                                    disabled={isRunning}
                                                    style={{ backgroundColor: '#2a2a3a', color: '#ffffff', border: '1px solid #3a3a4a' }}
                                                />
                                            </div>
                                        )}
                                    </div>

                                    {martingaleActive && isRunning && (
                                        <div className='auto-trades-config__martingale-active' style={{ backgroundColor: '#3a3a4a', padding: '0.5rem 1rem', borderRadius: '4px', marginTop: '0.5rem' }}>
                                            <span style={{ color: '#ffcc00' }}>⚡ Martingale active: {currentStakeDisplay.toFixed(2)} {currency}</span>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Market 1 Config */}
                            <div className='auto-trades-card auto-trades-card--m1'>
                                <h2 className='auto-trades-card__title' style={{ color: '#4caf50' }}>📈 Market 1 Strategy</h2>
                                <div className='auto-trades-config'>
                                    <div className='auto-trades-config__group'>
                                        <div className='auto-trades-strategy-selector'>
                                            <label style={{ color: '#e0e0e0', fontWeight: 500 }}>Strategy template</label>
                                            <select
                                                className='auto-trades-strategy-selector__select'
                                                value={m1StrategyTemplate}
                                                onChange={e => setM1StrategyTemplate(e.target.value as StrategyTemplate)}
                                                disabled={isRunning}
                                                style={{ backgroundColor: '#2a2a3a', color: '#ffffff', border: '1px solid #3a3a4a' }}
                                            >
                                                <option value='STANDARD'>Standard builder</option>
                                                <option value='OVER_2_MARKET'>Over 2 Market</option>
                                                <option value='UNDER_7_MARKET'>Under 7 Market</option>
                                            </select>
                                        </div>
                                        <p className='auto-trades-inverse__hint' style={{ color: '#a0a0a0', fontSize: '0.8rem' }}>
                                            {m1StrategyTemplate !== 'STANDARD'
                                                ? 'Scans every volatility market. When one qualifies, load that market and click Start Trading.'
                                                : 'Configure your own auto-trade rule.'}
                                        </p>
                                    </div>

                                    <div className='auto-trades-config__group'>
                                        <p className='auto-trades-config__group-label' style={{ color: '#d0d0d0', fontWeight: 600 }}>Contract Type</p>
                                        <div className='auto-trades-config__trade-row'>
                                            <div className='auto-trades-config__field auto-trades-config__field--type'>
                                                <label style={{ color: '#e0e0e0', fontWeight: 500 }}>Type</label>
                                                <select
                                                    className='auto-trades-config__select'
                                                    value={m1TradeType}
                                                    onChange={e => setM1TradeType(e.target.value as TradeType)}
                                                    disabled={isRunning || m1StrategyTemplate !== 'STANDARD'}
                                                    style={{ backgroundColor: '#2a2a3a', color: '#ffffff', border: '1px solid #3a3a4a' }}
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

                                            {usesLossPrediction(m1TradeType) && (
                                                <div className='auto-trades-config__prediction-pair'>
                                                    <div className='auto-trades-config__prediction-label' style={{ color: '#d0d0d0' }}>
                                                        Prediction
                                                        <span className='auto-trades-config__prediction-hint' style={{ color: '#888' }}>W→digit / L→digit</span>
                                                    </div>
                                                    <div className='auto-trades-config__prediction-controls'>
                                                        <div className='auto-trades-config__prediction-item'>
                                                            <span className='auto-trades-config__prediction-tag auto-trades-config__prediction-tag--win' style={{ color: '#4caf50' }}>W</span>
                                                            <select
                                                                className='auto-trades-config__select auto-trades-config__select--compact'
                                                                value={m1PredictionBeforeLoss}
                                                                onChange={e => setM1PredictionBeforeLoss(e.target.value)}
                                                                disabled={isRunning || m1StrategyTemplate !== 'STANDARD'}
                                                                style={{ backgroundColor: '#2a2a3a', color: '#ffffff', border: '1px solid #3a3a4a' }}
                                                            >
                                                                {[0,1,2,3,4,5,6,7,8,9].map(d => <option key={d} value={String(d)}>{d}</option>)}
                                                            </select>
                                                        </div>
                                                        <span className='auto-trades-config__prediction-divider' style={{ color: '#888' }}>|</span>
                                                        <div className='auto-trades-config__prediction-item'>
                                                            <span className='auto-trades-config__prediction-tag auto-trades-config__prediction-tag--loss' style={{ color: '#f44336' }}>L</span>
                                                            <select
                                                                className='auto-trades-config__select auto-trades-config__select--compact'
                                                                value={m1PredictionAfterLoss}
                                                                onChange={e => setM1PredictionAfterLoss(e.target.value)}
                                                                disabled={isRunning || m1StrategyTemplate !== 'STANDARD'}
                                                                style={{ backgroundColor: '#2a2a3a', color: '#ffffff', border: '1px solid #3a3a4a' }}
                                                            >
                                                                {[0,1,2,3,4,5,6,7,8,9].map(d => <option key={d} value={String(d)}>{d}</option>)}
                                                            </select>
                                                        </div>
                                                    </div>
                                                </div>
                                            )}

                                            {BARRIER_NEEDED[m1TradeType] && !usesLossPrediction(m1TradeType) && (
                                                <div className='auto-trades-config__field auto-trades-config__field--narrow'>
                                                    <label style={{ color: '#e0e0e0', fontWeight: 500 }}>{m1TradeType === 'DIGITMATCH' || m1TradeType === 'DIGITDIFF' ? 'Prediction' : 'Digit'}</label>
                                                    <select
                                                        className='auto-trades-config__select'
                                                        value={m1Barrier}
                                                        onChange={e => setM1Barrier(e.target.value)}
                                                        disabled={isRunning || m1StrategyTemplate !== 'STANDARD'}
                                                        style={{ backgroundColor: '#2a2a3a', color: '#ffffff', border: '1px solid #3a3a4a' }}
                                                    >
                                                        {[0,1,2,3,4,5,6,7,8,9].map(d => <option key={d} value={String(d)}>{d}</option>)}
                                                    </select>
                                                </div>
                                            )}

                                            <div className='auto-trades-config__field auto-trades-config__field--analysis'>
                                                <label style={{ color: '#e0e0e0', fontWeight: 500 }}>Analysis ticks</label>
                                                <select
                                                    className='auto-trades-config__select'
                                                    value={m1AnalysisTicks}
                                                    onChange={e => setM1AnalysisTicks(e.target.value)}
                                                    disabled={isRunning || m1StrategyTemplate !== 'STANDARD'}
                                                    style={{ backgroundColor: '#2a2a3a', color: '#ffffff', border: '1px solid #3a3a4a' }}
                                                >
                                                    {[1,2,3,4,5,6,7,8,9,10].map(d => <option key={d} value={String(d)}>{d}</option>)}
                                                </select>
                                            </div>
                                        </div>

                                        <div className='auto-trades-config__field' style={{ marginTop: '0.8rem' }}>
                                            <label style={{ color: '#e0e0e0', fontWeight: 500 }}>Streak</label>
                                            <div className='auto-trades-config__streak-row'>
                                                <input
                                                    className='auto-trades-config__streak-slider'
                                                    type='range'
                                                    min='1'
                                                    max='10'
                                                    step='1'
                                                    value={m1Streak}
                                                    onChange={e => setM1Streak(e.target.value)}
                                                    disabled={isRunning || m1StrategyTemplate !== 'STANDARD'}
                                                    style={{ accentColor: '#4caf50' }}
                                                />
                                                <span className='auto-trades-config__streak-value' style={{ color: '#ffffff', fontWeight: 600 }}>{m1Streak}</span>
                                            </div>
                                        </div>
                                    </div>

                                    <div className='auto-trades-config__group'>
                                        <div className='auto-trades-strategy-selector'>
                                            <label style={{ color: '#e0e0e0', fontWeight: 500 }}>Strategy Mode</label>
                                            <select
                                                className='auto-trades-strategy-selector__select'
                                                value={m1StrategyMode}
                                                onChange={e => setM1StrategyMode(e.target.value as StrategyMode)}
                                                disabled={isRunning || m1StrategyTemplate !== 'STANDARD'}
                                                style={{ backgroundColor: '#2a2a3a', color: '#ffffff', border: '1px solid #3a3a4a' }}
                                            >
                                                <option value='STANDARD'>Standard</option>
                                                <option value='INVERSE'>Inverse</option>
                                                <option value='PERCENTAGE'>Percentage Mode</option>
                                            </select>
                                        </div>
                                        <p className='auto-trades-inverse__hint' style={{ color: '#a0a0a0', fontSize: '0.8rem' }}>
                                            {m1StrategyMode === 'PERCENTAGE' ? 'Uses rolling percentage window for signals' :
                                             m1StrategyMode === 'INVERSE' ? 'Detects opposite signals' :
                                             'Detects standard signals'}
                                        </p>
                                    </div>

                                    {m1StrategyMode !== 'PERCENTAGE' && m1StrategyTemplate === 'STANDARD' && (
                                        <div className='auto-trades-config__group'>
                                            <button
                                                type='button'
                                                className={classNames('auto-trades-strategy-btn', m1InverseMode && 'auto-trades-strategy-btn--active')}
                                                onClick={() => setM1InverseMode(prev => !prev)}
                                                disabled={isRunning || m1StrategyTemplate !== 'STANDARD'}
                                                style={{ backgroundColor: m1InverseMode ? '#2e7d32' : '#2a2a3a', color: '#ffffff', border: '1px solid #3a3a4a' }}
                                            >
                                                <span className='auto-trades-strategy-btn__badge' style={{ color: m1InverseMode ? '#4caf50' : '#888' }}>{m1InverseMode ? 'Inverse' : 'Direct'}</span>
                                                <span className='auto-trades-strategy-btn__label'>Signal Mode</span>
                                                <span className='auto-trades-strategy-btn__switch'>
                                                    <span className='auto-trades-inverse__toggle-knob' />
                                                </span>
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Market 2 Config */}
                            <div className='auto-trades-card auto-trades-card--m2'>
                                <h2 className='auto-trades-card__title' style={{ color: '#ff9800' }}>
                                    📊 Market 2 Strategy
                                    <button
                                        className={classNames('auto-trades-toggle', m2Enabled && 'auto-trades-toggle--active')}
                                        onClick={() => setM2Enabled(prev => !prev)}
                                        disabled={isRunning}
                                        style={{ backgroundColor: m2Enabled ? '#ff9800' : '#555', color: '#fff', border: 'none', padding: '0.2rem 0.8rem', borderRadius: '4px', cursor: 'pointer' }}
                                    >
                                        {m2Enabled ? 'ON' : 'OFF'}
                                    </button>
                                </h2>
                                {m2Enabled && (
                                    <div className='auto-trades-config'>
                                        <div className='auto-trades-config__group'>
                                            <p className='auto-trades-config__group-label' style={{ color: '#d0d0d0', fontWeight: 600 }}>Contract Type</p>
                                            <div className='auto-trades-config__trade-row'>
                                                <div className='auto-trades-config__field auto-trades-config__field--type'>
                                                    <label style={{ color: '#e0e0e0', fontWeight: 500 }}>Type</label>
                                                    <select
                                                        className='auto-trades-config__select'
                                                        value={m2TradeType}
                                                        onChange={e => setM2TradeType(e.target.value as TradeType)}
                                                        disabled={isRunning}
                                                        style={{ backgroundColor: '#2a2a3a', color: '#ffffff', border: '1px solid #3a3a4a' }}
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

                                                {usesLossPrediction(m2TradeType) && (
                                                    <div className='auto-trades-config__prediction-pair'>
                                                        <div className='auto-trades-config__prediction-label' style={{ color: '#d0d0d0' }}>
                                                            Prediction
                                                            <span className='auto-trades-config__prediction-hint' style={{ color: '#888' }}>W→digit / L→digit</span>
                                                        </div>
                                                        <div className='auto-trades-config__prediction-controls'>
                                                            <div className='auto-trades-config__prediction-item'>
                                                                <span className='auto-trades-config__prediction-tag auto-trades-config__prediction-tag--win' style={{ color: '#4caf50' }}>W</span>
                                                                <select
                                                                    className='auto-trades-config__select auto-trades-config__select--compact'
                                                                    value={m2PredictionBeforeLoss}
                                                                    onChange={e => setM2PredictionBeforeLoss(e.target.value)}
                                                                    disabled={isRunning}
                                                                    style={{ backgroundColor: '#2a2a3a', color: '#ffffff', border: '1px solid #3a3a4a' }}
                                                                >
                                                                    {[0,1,2,3,4,5,6,7,8,9].map(d => <option key={d} value={String(d)}>{d}</option>)}
                                                                </select>
                                                            </div>
                                                            <span className='auto-trades-config__prediction-divider' style={{ color: '#888' }}>|</span>
                                                            <div className='auto-trades-config__prediction-item'>
                                                                <span className='auto-trades-config__prediction-tag auto-trades-config__prediction-tag--loss' style={{ color: '#f44336' }}>L</span>
                                                                <select
                                                                    className='auto-trades-config__select auto-trades-config__select--compact'
                                                                    value={m2PredictionAfterLoss}
                                                                    onChange={e => setM2PredictionAfterLoss(e.target.value)}
                                                                    disabled={isRunning}
                                                                    style={{ backgroundColor: '#2a2a3a', color: '#ffffff', border: '1px solid #3a3a4a' }}
                                                                >
                                                                    {[0,1,2,3,4,5,6,7,8,9].map(d => <option key={d} value={String(d)}>{d}</option>)}
                                                                </select>
                                                            </div>
                                                        </div>
                                                    </div>
                                                )}

                                                {BARRIER_NEEDED[m2TradeType] && !usesLossPrediction(m2TradeType) && (
                                                    <div className='auto-trades-config__field auto-trades-config__field--narrow'>
                                                        <label style={{ color: '#e0e0e0', fontWeight: 500 }}>{m2TradeType === 'DIGITMATCH' || m2TradeType === 'DIGITDIFF' ? 'Prediction' : 'Digit'}</label>
                                                        <select
                                                            className='auto-trades-config__select'
                                                            value={m2Barrier}
                                                            onChange={e => setM2Barrier(e.target.value)}
                                                            disabled={isRunning}
                                                            style={{ backgroundColor: '#2a2a3a', color: '#ffffff', border: '1px solid #3a3a4a' }}
                                                        >
                                                            {[0,1,2,3,4,5,6,7,8,9].map(d => <option key={d} value={String(d)}>{d}</option>)}
                                                        </select>
                                                    </div>
                                                )}

                                                <div className='auto-trades-config__field auto-trades-config__field--analysis'>
                                                    <label style={{ color: '#e0e0e0', fontWeight: 500 }}>Analysis ticks</label>
                                                    <select
                                                        className='auto-trades-config__select'
                                                        value={m2AnalysisTicks}
                                                        onChange={e => setM2AnalysisTicks(e.target.value)}
                                                        disabled={isRunning}
                                                        style={{ backgroundColor: '#2a2a3a', color: '#ffffff', border: '1px solid #3a3a4a' }}
                                                    >
                                                        {[1,2,3,4,5,6,7,8,9,10].map(d => <option key={d} value={String(d)}>{d}</option>)}
                                                    </select>
                                                </div>
                                            </div>

                                            <div className='auto-trades-config__field' style={{ marginTop: '0.8rem' }}>
                                                <label style={{ color: '#e0e0e0', fontWeight: 500 }}>Streak</label>
                                                <div className='auto-trades-config__streak-row'>
                                                    <input
                                                        className='auto-trades-config__streak-slider'
                                                        type='range'
                                                        min='1'
                                                        max='10'
                                                        step='1'
                                                        value={m2Streak}
                                                        onChange={e => setM2Streak(e.target.value)}
                                                        disabled={isRunning}
                                                        style={{ accentColor: '#ff9800' }}
                                                    />
                                                    <span className='auto-trades-config__streak-value' style={{ color: '#ffffff', fontWeight: 600 }}>{m2Streak}</span>
                                                </div>
                                            </div>
                                        </div>

                                        <div className='auto-trades-config__group'>
                                            <div className='auto-trades-strategy-selector'>
                                                <label style={{ color: '#e0e0e0', fontWeight: 500 }}>Strategy Mode</label>
                                                <select
                                                    className='auto-trades-strategy-selector__select'
                                                    value={m2StrategyMode}
                                                    onChange={e => setM2StrategyMode(e.target.value as StrategyMode)}
                                                    disabled={isRunning}
                                                    style={{ backgroundColor: '#2a2a3a', color: '#ffffff', border: '1px solid #3a3a4a' }}
                                                >
                                                    <option value='STANDARD'>Standard</option>
                                                    <option value='INVERSE'>Inverse</option>
                                                    <option value='PERCENTAGE'>Percentage Mode</option>
                                                </select>
                                            </div>
                                        </div>

                                        {m2StrategyMode !== 'PERCENTAGE' && (
                                            <div className='auto-trades-config__group'>
                                                <button
                                                    type='button'
                                                    className={classNames('auto-trades-strategy-btn', m2InverseMode && 'auto-trades-strategy-btn--active')}
                                                    onClick={() => setM2InverseMode(prev => !prev)}
                                                    disabled={isRunning}
                                                    style={{ backgroundColor: m2InverseMode ? '#e65100' : '#2a2a3a', color: '#ffffff', border: '1px solid #3a3a4a' }}
                                                >
                                                    <span className='auto-trades-strategy-btn__badge' style={{ color: m2InverseMode ? '#ff9800' : '#888' }}>{m2InverseMode ? 'Inverse' : 'Direct'}</span>
                                                    <span className='auto-trades-strategy-btn__label'>Signal Mode</span>
                                                    <span className='auto-trades-strategy-btn__switch'>
                                                        <span className='auto-trades-inverse__toggle-knob' />
                                                    </span>
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                )}
                                {!m2Enabled && (
                                    <p className='auto-trades-inverse__hint' style={{ marginTop: '1rem', color: '#a0a0a0', fontSize: '0.85rem' }}>
                                        Toggle ON to configure Market 2. M2 can be used as a fallback in Recovery Mode or as a standalone strategy.
                                    </p>
                                )}
                            </div>

                            {/* Controls */}
                            <div className='auto-trades-controls'>
                                {!isRunning ? (
                                    <button className='auto-trades-controls__run' onClick={handleRun} disabled={!client.is_logged_in || selectedMarketSymbols.length === 0} style={{ backgroundColor: '#4caf50', color: '#fff', padding: '0.8rem 2rem', border: 'none', borderRadius: '4px', fontSize: '1rem', fontWeight: 600, cursor: 'pointer' }}>
                                        ▶ Start Trading
                                    </button>
                                ) : (
                                    <button className='auto-trades-controls__stop' onClick={handleStop} style={{ backgroundColor: '#f44336', color: '#fff', padding: '0.8rem 2rem', border: 'none', borderRadius: '4px', fontSize: '1rem', fontWeight: 600, cursor: 'pointer' }}>
                                        ■ Stop Trading
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* Markets grid */}
                        <div className='auto-trades-markets'>
                            <h2 className='auto-trades-markets__title' style={{ color: '#ffffff' }}>
                                Live Markets
                                <span className='auto-trades-markets__selected-count' style={{ color: '#a0a0a0', fontSize: '0.9rem', marginLeft: '0.5rem' }}>{selectedMarketSymbols.length}/{AUTO_MARKETS.length} selected</span>
                                {isConnected && <span className='auto-trades-markets__live-badge' style={{ color: '#4caf50', marginLeft: '0.5rem' }}>● LIVE</span>}
                                {isRunning && (
                                    <span className='auto-trades-markets__mode-badge' style={{ color: '#ffcc00', marginLeft: '0.5rem' }}>
                                        {isM2Only ? '📊 M2 Only' : isRecoveryMode ? (isRecoveryActive ? '🔴 ALL BLOCKED' : '🟢 M1') : '📈 M1'}
                                    </span>
                                )}
                                {martingaleActive && isRunning && (
                                    <span className='auto-trades-markets__martingale-badge' style={{ color: '#ffcc00', marginLeft: '0.5rem' }}>
                                        ⚡ Martingale: {currentStakeDisplay.toFixed(2)} {currency}
                                    </span>
                                )}
                                {isRecoveryActive && isRunning && (
                                    <span className='auto-trades-markets__recovery-badge' style={{ color: '#f44336', marginLeft: '0.5rem', fontWeight: 'bold' }}>
                                        🔴 ALL MARKETS BLOCKED
                                    </span>
                                )}
                            </h2>
                            {!isRunning && (
                                <div className='auto-trades-markets__actions'>
                                    <button type='button' onClick={() => setSelectedMarketSymbols(AUTO_MARKET_SYMBOLS)} style={{ color: '#4caf50', background: 'none', border: 'none', cursor: 'pointer' }}>Select all</button>
                                    <button type='button' onClick={() => setSelectedMarketSymbols([])} style={{ color: '#f44336', background: 'none', border: 'none', cursor: 'pointer' }}>Clear</button>
                                </div>
                            )}
                            {selectedMarketSymbols.length === 0 && (
                                <div className='auto-trades-hint' style={{ color: '#a0a0a0' }}>
                                    Select at least one market to show live quotes and enable Auto Trades.
                                </div>
                            )}
                            <div className='auto-trades-markets__grid'>
                                {marketDisplays.map(m => {
                                    const status = getMarketStatus(m, m.symbol);
                                    const isMarketLoading = m.lastQuote === null;
                                    const isMarketRecovering = m.isRecovering && m.lastQuote !== null;
                                    const isM2Active = status.isMarket2 && status.isReady;
                                    const isRecoveryActive = status.isRecovery && status.isReady;
                                    const isBlocked = status.isBlocked;

                                    return (
                                        <div
                                            key={m.symbol}
                                            className={classNames('auto-trades-market', {
                                                'auto-trades-market--ready': status.isReady && !m.trading && isRunning && !isBlocked,
                                                'auto-trades-market--trading': m.trading,
                                                'auto-trades-market--win': m.lastResult === 'win' && !m.trading,
                                                'auto-trades-market--loss': m.lastResult === 'loss' && !m.trading,
                                                'auto-trades-market--loading': isMarketLoading,
                                                'auto-trades-market--recovering': isMarketRecovering,
                                                'auto-trades-market--m2-active': isM2Active || isRecoveryActive,
                                                'auto-trades-market--recovery-active': isRecoveryActive,
                                                'auto-trades-market--blocked': isBlocked,
                                            })}
                                            style={{ 
                                                backgroundColor: isBlocked ? '#2a1a1a' : isRecoveryActive ? '#1a2a1a' : '#1a1a2a',
                                                border: isBlocked ? '2px solid #f44336' : isRecoveryActive ? '1px solid #ff9800' : '1px solid #2a2a3a',
                                                borderRadius: '8px',
                                                padding: '1rem',
                                                color: '#ffffff',
                                                opacity: isBlocked ? 0.7 : 1,
                                            }}
                                        >
                                            {isMarketLoading && (
                                                <div className='auto-trades-market__loading'>
                                                    <span className='auto-trades-data-loader__spinner' />
                                                    <span>Loading</span>
                                                </div>
                                            )}
                                            <div className='auto-trades-market__top'>
                                                <div>
                                                    <p className='auto-trades-market__name' style={{ fontSize: '1.1rem', fontWeight: 600, color: '#ffffff' }}>{m.label}</p>
                                                    <p className='auto-trades-market__symbol' style={{ fontSize: '0.85rem', color: '#a0a0a0' }}>{m.symbol}</p>
                                                    <p className='auto-trades-market__mode-label' style={{ fontSize: '0.8rem', color: '#a0a0a0' }}>
                                                        {getMarketSubtitle(m.symbol)}
                                                    </p>
                                                </div>
                                                <div className='auto-trades-market__controls'>
                                                    {!isRunning && (
                                                        <button
                                                            className='auto-trades-market__btn auto-trades-market__btn--remove'
                                                            onClick={() => setSelectedMarketSymbols(current => current.filter(item => item !== m.symbol))}
                                                            title='Remove from Auto Trades'
                                                            type='button'
                                                            style={{ color: '#f44336', background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer' }}
                                                        >
                                                            −
                                                        </button>
                                                    )}
                                                    <div
                                                        className={classNames('auto-trades-market__badge', {
                                                            'auto-trades-market__badge--ready': status.isReady && isRunning && !m.trading && !isBlocked,
                                                            'auto-trades-market__badge--trading': m.trading,
                                                            'auto-trades-market__badge--m2': status.isMarket2,
                                                            'auto-trades-market__badge--recovery': status.isRecovery,
                                                            'auto-trades-market__badge--blocked': isBlocked,
                                                        })}
                                                        style={{
                                                            padding: '0.2rem 0.6rem',
                                                            borderRadius: '4px',
                                                            fontSize: '0.7rem',
                                                            fontWeight: 600,
                                                            backgroundColor: isBlocked ? '#f44336' : m.trading ? '#ff9800' : status.isReady && isRunning ? '#4caf50' : '#555',
                                                            color: '#fff'
                                                        }}
                                                    >
                                                        {m.trading ? 'BUYING' : isBlocked ? 'BLOCKED' : status.isReady && isRunning ? 'READY' : status.label}
                                                    </div>
                                                </div>
                                            </div>

                                            {m.lastQuote !== null && (
                                                <div className='auto-trades-market__quote' style={{ fontSize: '1.5rem', fontWeight: 600, color: '#ffffff', marginTop: '0.5rem' }}>
                                                    {m.lastQuote.toFixed(getMarketPipSize(m.symbol, AUTO_MARKET_LOOKUP.get(m.symbol)?.pip ?? 2))}
                                                </div>
                                            )}

                                            {isBlocked && (
                                                <div className='auto-trades-market__blocked-status' style={{ backgroundColor: '#f44336', color: '#fff', padding: '0.3rem 0.6rem', borderRadius: '4px', marginTop: '0.5rem', fontSize: '0.8rem' }}>
                                                    🔴 ALL MARKETS BLOCKED — M2 ONLY
                                                    <br />
                                                    <small style={{ fontSize: '0.7rem' }}>Wait for M2 win to unblock ALL markets</small>
                                                </div>
                                            )}

                                            {isRecoveryActive && !isBlocked && (
                                                <div className='auto-trades-market__recovery-status' style={{ backgroundColor: '#4caf50', color: '#fff', padding: '0.3rem 0.6rem', borderRadius: '4px', marginTop: '0.5rem', fontSize: '0.8rem' }}>
                                                    🟢 M1 ACTIVE
                                                    <br />
                                                    <small style={{ fontSize: '0.7rem' }}>Recovery complete — all markets unblocked</small>
                                                </div>
                                            )}

                                            {isCandleConfirmedTradeType(getActiveTradeType(m.symbol)) && (
                                                <div className={classNames('auto-trades-market__candle', {
                                                    'auto-trades-market__candle--bullish': m.candleDirection === 1,
                                                    'auto-trades-market__candle--bearish': m.candleDirection === -1,
                                                    'auto-trades-market__candle--waiting': m.candleDirection === 0,
                                                })} style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: m.candleDirection === 1 ? '#4caf50' : m.candleDirection === -1 ? '#f44336' : '#888' }}>
                                                    5m candle: {getCandleDirectionLabel(m.candleDirection)}
                                                </div>
                                            )}

                                            {isRunning && (
                                                <div className='auto-trades-market__dots' style={{ display: 'flex', alignItems: 'center', gap: '0.2rem', marginTop: '0.5rem' }}>
                                                    {Array.from({ length: status.target }).map((_, i) => (
                                                        <div
                                                            key={i}
                                                            className={classNames('auto-trades-market__dot', {
                                                                'auto-trades-market__dot--filled': i < status.streak,
                                                                'auto-trades-market__dot--ready': i < status.streak && status.isReady && !isBlocked,
                                                                'auto-trades-market__dot--m2': status.isMarket2 && i < status.streak,
                                                                'auto-trades-market__dot--recovery': status.isRecovery && i < status.streak,
                                                                'auto-trades-market__dot--blocked': isBlocked,
                                                            })}
                                                            style={{
                                                                width: '12px',
                                                                height: '12px',
                                                                borderRadius: '50%',
                                                                backgroundColor: i < status.streak ? (isBlocked ? '#f44336' : status.isMarket2 ? '#ff9800' : '#4caf50') : '#3a3a4a'
                                                            }}
                                                        />
                                                    ))}
                                                    <span className='auto-trades-market__dots-label' style={{ color: '#a0a0a0', fontSize: '0.75rem', marginLeft: '0.3rem' }}>
                                                        {isBlocked ? '🔴' : status.isMarket2 ? 'M2' : status.isRecovery ? '🔄' : 'M1'} {status.streak}/{status.target}
                                                    </span>
                                                </div>
                                            )}

                                            {!IS_DIRECTION_TYPE[getActiveTradeType(m.symbol)] && m.lastDigits.length > 0 && (
                                                <div className='auto-trades-market__digits' style={{ display: 'flex', gap: '0.3rem', marginTop: '0.5rem' }}>
                                                    {m.lastDigits.slice(-5).map((d, idx) => (
                                                        <span key={idx} className={classNames('auto-trades-market__digit', {
                                                            'auto-trades-market__digit--low': d <= 4,
                                                            'auto-trades-market__digit--high': d > 4,
                                                        })} style={{ 
                                                            backgroundColor: d <= 4 ? '#2a3a2a' : '#3a2a2a',
                                                            color: '#fff',
                                                            padding: '0.2rem 0.4rem',
                                                            borderRadius: '4px',
                                                            fontSize: '0.85rem'
                                                        }}>
                                                            {d}
                                                        </span>
                                                    ))}
                                                </div>
                                            )}

                                            {IS_DIRECTION_TYPE[getActiveTradeType(m.symbol)] && m.directionHistory.length > 0 && (
                                                <div className='auto-trades-market__digits' style={{ display: 'flex', gap: '0.3rem', marginTop: '0.5rem' }}>
                                                    {m.directionHistory.slice(-5).map((dir, idx) => (
                                                        <span key={idx} className={classNames('auto-trades-market__digit', {
                                                            'auto-trades-market__digit--low': dir === 1,
                                                            'auto-trades-market__digit--high': dir === -1,
                                                        })} style={{ 
                                                            backgroundColor: dir === 1 ? '#2a3a2a' : dir === -1 ? '#3a2a2a' : '#2a2a2a',
                                                            color: '#fff',
                                                            padding: '0.2rem 0.4rem',
                                                            borderRadius: '4px',
                                                            fontSize: '0.85rem'
                                                        }}>
                                                            {dir === 1 ? '▲' : dir === -1 ? '▼' : '—'}
                                                        </span>
                                                    ))}
                                                </div>
                                            )}

                                            {getActiveStrategyMode(m.symbol) === 'PERCENTAGE' && (
                                                <div className='auto-trades-market__percentages' style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: '#a0a0a0' }}>
                                                    {(() => {
                                                        const { config } = getActiveConfig(m.symbol);
                                                        const barrier = getActiveBarrier(m.symbol, m.lastResult, consecutiveLossRef.current);
                                                        const snapshot = getPercentageSnapshot(config.tradeType, m, barrier);
                                                        const threshold = getPercentageThreshold(config.tradeType, barrier);
                                                        const hasEnoughSamples = snapshot.sampleSize >= PERCENTAGE_MIN_SAMPLE_SIZE;

                                                        return (
                                                            <>
                                                                <div className='auto-trades-market__percentage-row'>
                                                                    <span>{snapshot.primaryLabel}: {snapshot.primaryPercentage.toFixed(1)}%</span>
                                                                    {snapshot.secondaryLabel && (
                                                                        <span>{snapshot.secondaryLabel}: {snapshot.secondaryPercentage?.toFixed(1)}%</span>
                                                                    )}
                                                                </div>
                                                                <div className='auto-trades-market__confidence'>
                                                                    {hasEnoughSamples
                                                                        ? `Signal needs ${threshold.minPercentage}% / confidence ${threshold.confidence}%`
                                                                        : `Collecting ${snapshot.sampleSize}/${PERCENTAGE_MIN_SAMPLE_SIZE} samples`}
                                                                    {' · '}
                                                                    Confidence: {snapshot.confidence.toFixed(0)}%
                                                                </div>
                                                            </>
                                                        );
                                                    })()}
                                                </div>
                                            )}

                                            {m.tradeCount > 0 && (
                                                <div className='auto-trades-market__footer' style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.5rem', fontSize: '0.8rem', color: '#a0a0a0' }}>
                                                    <span>{m.tradeCount} trade{m.tradeCount !== 1 ? 's' : ''}</span>
                                                    <span className={classNames({
                                                        'auto-trades-market__last-win': m.lastResult === 'win',
                                                        'auto-trades-market__last-loss': m.lastResult === 'loss',
                                                    })} style={{ color: m.lastResult === 'win' ? '#4caf50' : m.lastResult === 'loss' ? '#f44336' : '#888' }}>
                                                        {m.lastResult === 'win' ? '✓ Win' : '✗ Loss'}
                                                    </span>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                            {!isRunning && availableMarkets.length > 0 && (
                                <div className='auto-trades-markets__available'>
                                    <h3 className='auto-trades-markets__subtitle' style={{ color: '#ffffff', fontSize: '1rem' }}>Available markets to add</h3>
                                    <p className='auto-trades-markets__help' style={{ color: '#a0a0a0', fontSize: '0.85rem' }}>Removed markets stay here with a plus button until you add them back.</p>
                                    <div className='auto-trades-markets__grid auto-trades-markets__grid--available'>
                                        {availableMarkets.map(market => (
                                            <button
                                                key={market.symbol}
                                                className='auto-trades-market-add'
                                                onClick={() => setSelectedMarketSymbols(current => [...current, market.symbol])}
                                                type='button'
                                                title={`Add ${market.label} to Auto Trades`}
                                                style={{ backgroundColor: '#2a2a3a', border: '1px solid #3a3a4a', borderRadius: '8px', padding: '0.8rem', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
                                            >
                                                <span className='auto-trades-market-add__plus' style={{ color: '#4caf50', fontSize: '1.2rem', fontWeight: 600 }}>+</span>
                                                <div className='auto-trades-market-add__info'>
                                                    <p className='auto-trades-market-add__name' style={{ fontWeight: 600 }}>{market.label}</p>
                                                    <p className='auto-trades-market-add__symbol' style={{ fontSize: '0.8rem', color: '#a0a0a0' }}>{market.symbol}</p>
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </ThemedScrollbars>

            {/* TP/SL Notification */}
            {showTPSLNotification && (
                <TPSLNotification
                    isOpen={showTPSLNotification}
                    onClose={() => setShowTPSLNotification(false)}
                    takeProfit={Number(sharedTakeProfit)}
                    stopLoss={Number(sharedStopLoss)}
                    currency={currency || 'USD'}
                    totalPnl={totalPnl}
                    totalTrades={totalTrades}
                    currentStake={currentStakeDisplay}
                    onStopTrading={handleStop}
                />
            )}

            {/* Floating Risk Disclaimer */}
            <button className='auto-trades-disclaimer-btn' onClick={() => setShowDisclaimer(true)} style={{ position: 'fixed', bottom: '1rem', right: '1rem', backgroundColor: '#f44336', color: '#fff', padding: '0.5rem 1rem', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '0.85rem' }}>⚠ Risk Disclaimer</button>

            {showDisclaimer && (
                <div className='auto-trades-disclaimer-overlay' onClick={() => setShowDisclaimer(false)} style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
                    <div className='auto-trades-disclaimer-modal' onClick={e => e.stopPropagation()} style={{ backgroundColor: '#1a1a2e', borderRadius: '12px', padding: '2rem', maxWidth: '500px', width: '90%', color: '#fff' }}>
                        <div className='auto-trades-disclaimer-modal__header' style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
                            <span className='auto-trades-disclaimer-modal__icon' style={{ fontSize: '1.5rem' }}>⚠</span>
                            <h3 className='auto-trades-disclaimer-modal__title' style={{ margin: 0 }}>Risk Disclaimer</h3>
                            <button className='auto-trades-disclaimer-modal__close' onClick={() => setShowDisclaimer(false)} style={{ background: 'none', border: 'none', color: '#fff', fontSize: '1.5rem', cursor: 'pointer' }}>✕</button>
                        </div>
                        <div className='auto-trades-disclaimer-modal__body' style={{ marginBottom: '1.5rem', color: '#d0d0d0' }}>
                            <p>Deriv offers complex derivatives, such as options and contracts for difference (&ldquo;CFDs&rdquo;). These products may not be suitable for all clients, and trading them puts you at risk. Please make sure that you understand the following risks before trading Deriv products:</p>
                            <ul style={{ marginTop: '0.5rem', paddingLeft: '1.5rem' }}>
                                <li>You may lose some or all of the money you invest in the trade.</li>
                                <li>If your trade involves currency conversion, exchange rates will affect your profit and loss.</li>
                                <li>You should never trade with borrowed money or with money you cannot afford to lose.</li>
                            </ul>
                        </div>
                        <div className='auto-trades-disclaimer-modal__footer'>
                            <button className='auto-trades-disclaimer-modal__ok' onClick={() => setShowDisclaimer(false)} style={{ backgroundColor: '#4caf50', color: '#fff', padding: '0.5rem 2rem', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '1rem', fontWeight: 600 }}>I Understand</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
});

export default AutoTrades;
