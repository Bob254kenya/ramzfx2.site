// auto-trades.tsx - SIMPLIFIED TWO MARKET SYSTEM
// Features:
// 1. MAIN Market: Trades with configured contract type
// 2. RECOVERY Market: Activates after loss with L→Digit strategy
// 3. Clean separation with simple state management
// 4. Black background styling for all L→Digit inputs

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

// L→Digit Strategy Types
type LDigitPatternType = 
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

// Market Mode
type MarketMode = 'MAIN' | 'RECOVERY';

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
const MARKET_LOSS_COOLDOWN_TICKS = 3;

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
    if (!(profit < 0)) {
        return {
            consecutiveLosses: 0,
            lastResult: 'win' as const,
            nextStake: base_stake,
        };
    }

    const nextConsecutiveLosses = consecutive_losses + 1;
    const normalizedMode = normalizeMartingaleMode(martingale_mode);
    const normalizedTrigger = clampConsecutiveLossThreshold(consecutive_loss_trigger);

    if (normalizedMode === 'no_martingale') {
        return {
            consecutiveLosses: nextConsecutiveLosses,
            lastResult: 'loss' as const,
            nextStake: base_stake,
        };
    }

    const shouldApplyMartingale =
        normalizedMode === 'after_one_loss' ||
        (normalizedMode === 'after_two_losses' && nextConsecutiveLosses >= 2) ||
        (normalizedMode === 'custom_consecutive_loss_trigger' && nextConsecutiveLosses >= normalizedTrigger);

    return {
        consecutiveLosses: nextConsecutiveLosses,
        lastResult: 'loss' as const,
        nextStake: shouldApplyMartingale ? parseFloat((current_stake * multiplier).toFixed(2)) : base_stake,
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

// Evaluate recovery pattern
const evaluateRecoveryPattern = (
    lDigitStrategy: LDigitAnalysis | null,
    digits: number[],
    directions: Direction[]
): boolean => {
    if (!lDigitStrategy?.enabled) return false;
    if (digits.length < lDigitStrategy.lookbackTicks) return false;

    const recentDigits = digits.slice(-lDigitStrategy.lookbackTicks);
    const recentDirections = directions.slice(-lDigitStrategy.lookbackTicks);

    switch (lDigitStrategy.patternType) {
        case 'odd_to_even':
            return recentDigits.every(d => d % 2 !== 0);
        case 'even_to_odd':
            return recentDigits.every(d => d % 2 === 0);
        case 'over_to_under':
            if (lDigitStrategy.thresholdDigit === undefined) return false;
            return recentDigits.every(d => d > lDigitStrategy.thresholdDigit);
        case 'under_to_over':
            if (lDigitStrategy.thresholdDigit === undefined) return false;
            return recentDigits.every(d => d < lDigitStrategy.thresholdDigit);
        case 'match_to_diff':
            if (lDigitStrategy.barrierDigit === undefined) return false;
            return recentDigits.every(d => d === lDigitStrategy.barrierDigit);
        case 'diff_to_match':
            if (lDigitStrategy.barrierDigit === undefined) return false;
            return recentDigits.every(d => d !== lDigitStrategy.barrierDigit);
        case 'rise_to_fall':
            return recentDirections.length >= lDigitStrategy.lookbackTicks && 
                   recentDirections.every(d => d === 1);
        case 'fall_to_rise':
            return recentDirections.length >= lDigitStrategy.lookbackTicks && 
                   recentDirections.every(d => d === -1);
        default:
            return false;
    }
};

// Get recovery trade type
const getRecoveryTradeType = (lDigitStrategy: LDigitAnalysis | null): TradeType | null => {
    if (!lDigitStrategy?.enabled) return null;
    switch (lDigitStrategy.patternType) {
        case 'odd_to_even': return 'DIGITEVEN';
        case 'even_to_odd': return 'DIGITODD';
        case 'over_to_under': return 'DIGITUNDER';
        case 'under_to_over': return 'DIGITOVER';
        case 'match_to_diff': return 'DIGITDIFF';
        case 'diff_to_match': return 'DIGITMATCH';
        case 'rise_to_fall': return 'PUT';
        case 'fall_to_rise': return 'CALL';
        default: return null;
    }
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
    state: any,
    barrier: number
): PercentageSnapshot => {
    if (IS_DIRECTION_TYPE[trade_type]) {
        const { risePercentage, fallPercentage, confidence, sampleSize } = calculateDirectionPercentages(
            state.directionSampleHistory || []
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

    const percentages = state.digitPercentages || {};
    const safeBarrier = Math.min(9, Math.max(0, barrier));
    const sampleSize = state.digitHistory?.length || 0;

    if (trade_type === 'DIGITOVER') {
        const primaryPercentage = sumDigitPercentages(percentages, digit => digit > safeBarrier);
        return {
            primaryLabel: `Over ${safeBarrier}`,
            primaryPercentage,
            secondaryLabel: `${safeBarrier} or below`,
            secondaryPercentage: Number((100 - primaryPercentage).toFixed(2)),
            confidence: state.confidenceScore || 0,
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
            confidence: state.confidenceScore || 0,
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
            confidence: state.confidenceScore || 0,
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
        confidence: state.confidenceScore || 0,
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

export const isPercentageSignalReady = (trade_type: TradeType, state: any, barrier: number): boolean => {
    const snapshot = getPercentageSnapshot(trade_type, state, barrier);
    const threshold = getPercentageThreshold(trade_type, barrier);
    return (
        snapshot.sampleSize >= PERCENTAGE_MIN_SAMPLE_SIZE &&
        snapshot.primaryPercentage >= threshold.minPercentage &&
        snapshot.confidence >= threshold.confidence
    );
};

// Market state interface
interface MarketState {
    symbol: string;
    mode: MarketMode;
    tradeType: TradeType;
    barrier: number;
    streak: number;
    analysisTicks: number;
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
    lossCooldownLeft: number;
    qualifyingWinningDigits: number[];
    specialEntryReady: boolean;
    trailingTriggerCount: number;
    alertActive: boolean;
    alertMessage: string;
    currentStake: number;
    cooldownLeft: number;
    // Recovery specific
    isRecoveryActive: boolean;
    recoveryWaitingForPattern: boolean;
    recoveryPatternMatched: boolean;
    recoveryOriginalTradeType: TradeType | null;
}

const createMarketState = (symbol: string, mode: MarketMode = 'MAIN'): MarketState => ({
    symbol,
    mode,
    tradeType: 'DIGITOVER',
    barrier: 4,
    streak: 4,
    analysisTicks: 1,
    consecutive: 0,
    trading: false,
    isRecovering: false,
    lastDigits: [],
    directionHistory: [],
    prevQuote: null,
    candleDirection: 0,
    candleOpen: null,
    candleClose: null,
    directionSampleHistory: [],
    tradeCount: 0,
    lastResult: null,
    lastQuote: null,
    tradeStartTime: null,
    verificationId: null,
    digitHistory: [],
    digitPercentages: {},
    confidenceScore: 0,
    momentumCount: 0,
    percentageQuoteHistory: [],
    percentageEpochHistory: [],
    percentageBackfilled: false,
    percentageBackfillInFlight: false,
    lossCooldownLeft: 0,
    qualifyingWinningDigits: [],
    specialEntryReady: false,
    trailingTriggerCount: 0,
    alertActive: false,
    alertMessage: '',
    currentStake: 1,
    cooldownLeft: 0,
    isRecoveryActive: false,
    recoveryWaitingForPattern: false,
    recoveryPatternMatched: false,
    recoveryOriginalTradeType: null,
});

// Utility functions
const getDirectionSamplesFromQuotes = (quotes: number[]): Direction[] =>
    quotes.slice(1).map((quote, index) => {
        const previousQuote = quotes[index];
        if (quote > previousQuote) return 1;
        if (quote < previousQuote) return -1;
        return 0;
    });

const rebuildPercentageAnalytics = (state: MarketState) => {
    const pip = AUTO_MARKET_LOOKUP.get(state.symbol)?.pip ?? 2;
    const quoteHistory = state.percentageQuoteHistory.slice(-PERCENTAGE_ANALYSIS_HISTORY_SIZE);
    state.percentageQuoteHistory = quoteHistory;
    state.percentageEpochHistory = quoteHistory.length ? state.percentageEpochHistory.slice(-quoteHistory.length) : [];
    state.digitHistory = quoteHistory.map(quote => getLastDigitFromQuote(quote, state.symbol, pip));
    state.digitPercentages = calculateDigitPercentages(state.digitHistory);
    state.directionSampleHistory = getDirectionSamplesFromQuotes(quoteHistory);

    if (IS_DIRECTION_TYPE[state.tradeType]) {
        const directionPercentages = calculateDirectionPercentages(state.directionSampleHistory);
        state.confidenceScore = directionPercentages.confidence;
        state.momentumCount = Math.round(
            state.tradeType === 'CALL' || state.tradeType === 'RUNHIGH'
                ? directionPercentages.risePercentage
                : directionPercentages.fallPercentage
        );
    } else {
        state.confidenceScore = calculateConfidence(state.digitPercentages);
        state.momentumCount = 0;
    }
};

const appendPercentageQuote = (state: MarketState, quote: number, epoch: number | null) => {
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
    rebuildPercentageAnalytics(state);
};

// Main component
const AutoTrades = observer(() => {
    const { dashboard, client, run_panel, summary_card, transactions } = useStore();
    const { currency } = client;
    const { active_tab } = dashboard;

    const VALID_TRADE_TYPES: TradeType[] = [
        'DIGITOVER', 'DIGITUNDER', 'DIGITEVEN', 'DIGITODD',
        'DIGITMATCH', 'DIGITDIFF', 'CALL', 'PUT', 'RUNHIGH', 'RUNLOW'
    ];

    const loadSaved = (key: string, fallback: string) => {
        try { return localStorage.getItem(`auto_trades_${key}`) || fallback; } catch { return fallback; }
    };
    const loadSavedNum = (key: string, fallback: string, min: number, max: number) => {
        const v = loadSaved(key, fallback);
        const n = Number(v);
        return !isNaN(n) && n >= min && n <= max ? v : fallback;
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
        } catch {}
        return AUTO_MARKET_SYMBOLS;
    };

    // State
    const [stake, setStake] = useState(() => loadSavedNum('stake', '1', 0.01, 100000));
    const [martingale, setMartingale] = useState(() => loadSavedNum('martingale', '2', 1.01, 100));
    const [takeProfit, setTakeProfit] = useState(() => loadSavedNum('takeProfit', '100', 1, 1000000));
    const [stopLoss, setStopLoss] = useState(() => loadSavedNum('stopLoss', '100', 1, 1000000));
    const [tradeType, setTradeType] = useState<TradeType>(() => {
        const v = loadSaved('tradeType', 'DIGITOVER');
        return VALID_TRADE_TYPES.includes(v as TradeType) ? (v as TradeType) : 'DIGITOVER';
    });
    const [strategyTemplate, setStrategyTemplate] = useState<StrategyTemplate>(() => {
        const saved = loadSaved('strategyTemplate', 'STANDARD');
        return STRATEGY_TEMPLATE_IDS.includes(saved as StrategyTemplate) ? (saved as StrategyTemplate) : 'STANDARD';
    });
    const [barrier, setBarrier] = useState(() => loadSavedNum('barrier', '4', 0, 9));
    const [predictionBeforeLoss, setPredictionBeforeLoss] = useState(() => loadSavedNum('predictionBeforeLoss', '4', 0, 9));
    const [predictionAfterLoss, setPredictionAfterLoss] = useState(() => loadSavedNum('predictionAfterLoss', '5', 0, 9));
    const [streak, setStreak] = useState(() => loadSavedNum('streak', '4', 1, 10));
    const [analysisTicks, setAnalysisTicks] = useState(() => loadSavedNum('analysisTicks', '1', 1, 10));
    const [selectedMarketSymbols, setSelectedMarketSymbols] = useState<string[]>(loadSavedMarkets);
    
    const [lDigitStrategy, setLDigitStrategy] = useState<LDigitAnalysis>(() => {
        try {
            const saved = localStorage.getItem('auto_trades_lDigitStrategy');
            if (saved) {
                const parsed = JSON.parse(saved);
                return {
                    enabled: parsed.enabled ?? false,
                    patternType: parsed.patternType ?? 'odd_to_even',
                    lookbackTicks: parsed.lookbackTicks ?? 5,
                    thresholdDigit: parsed.thresholdDigit,
                    barrierDigit: parsed.barrierDigit,
                };
            }
        } catch {}
        return { enabled: false, patternType: 'odd_to_even', lookbackTicks: 5 };
    });

    const selectedMarkets = useMemo(
        () => AUTO_MARKETS.filter(market => selectedMarketSymbols.includes(market.symbol)),
        [selectedMarketSymbols]
    );
    const availableMarkets = useMemo(
        () => AUTO_MARKETS.filter(market => !selectedMarketSymbols.includes(market.symbol)),
        [selectedMarketSymbols]
    );

    // UI State
    const [totalPnl, setTotalPnl] = useState(0);
    const [totalTrades, setTotalTrades] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [isRunning, setIsRunning] = useState(false);
    const [isConnected, setIsConnected] = useState(false);
    const [inverseMode, setInverseMode] = useState(() => {
        try { return localStorage.getItem('auto_trades_inverseMode') === 'true'; } catch { return false; }
    });
    const inverseModeRef = useRef(false);
    const [strategyMode, setStrategyMode] = useState<StrategyMode>(() => {
        try { return (localStorage.getItem('auto_trades_strategyMode') as StrategyMode) || 'STANDARD'; } catch { return 'STANDARD'; }
    });
    const [martingaleMode, setMartingaleMode] = useState<MartingaleModeType>(() => {
        try { return normalizeMartingaleMode(localStorage.getItem('auto_trades_martingaleMode')); } catch { return 'after_one_loss'; }
    });
    const [consecutiveLossCount, setConsecutiveLossCount] = useState(getInitialConsecutiveLossThreshold);
    const [consecutiveLossCountInput, setConsecutiveLossCountInput] = useState(() => String(getInitialConsecutiveLossThreshold()));
    const [showDisclaimer, setShowDisclaimer] = useState(false);
    const [currentStakeDisplay, setCurrentStakeDisplay] = useState(1);
    const [cooldownDisplay, setCooldownDisplay] = useState(0);
    const [dataStreamLoading, setDataStreamLoading] = useState(false);
    const [dataStreamMessage, setDataStreamMessage] = useState('Loading selected market data...');
    const [floatingStrategyAlert, setFloatingStrategyAlert] = useState<FloatingStrategyAlert | null>(null);

    // Refs
    const strategyModeRef = useRef(strategyMode);
    const martingaleModeRef = useRef(martingaleMode);
    const consecutiveLossCountRef = useRef(consecutiveLossCount);
    const modeTransitionLockRef = useRef(false);
    const isRecoveringDataRef = useRef(false);
    const selectedMarketsRef = useRef<AutoMarket[]>(selectedMarkets);
    const selectedMarketSymbolsRef = useRef<Set<string>>(new Set(selectedMarketSymbols));
    const monitoredMarketSymbolsRef = useRef<Set<string>>(new Set(selectedMarketSymbols));
    const activeMarketRef = useRef<Record<string, MarketMode>>(Object.fromEntries(AUTO_MARKETS.map(m => [m.symbol, 'MAIN'])));
    const subscriptionsRef = useRef<Record<string, any>>({});
    const candleSubscriptionsRef = useRef<Record<string, any>>({});
    
    // Market states - each symbol has MAIN and RECOVERY
    const marketStatesRef = useRef<Record<string, { main: MarketState; recovery: MarketState }>>(
        Object.fromEntries(AUTO_MARKETS.map(m => [
            m.symbol,
            {
                main: createMarketState(m.symbol, 'MAIN'),
                recovery: createMarketState(m.symbol, 'RECOVERY')
            }
        ]))
    );

    const [marketDisplays, setMarketDisplays] = useState<any[]>(() => {
        const displays: any[] = [];
        selectedMarkets.forEach(m => {
            displays.push({ ...marketStatesRef.current[m.symbol].main, currentStake: 1, cooldownLeft: 0 });
            displays.push({ ...marketStatesRef.current[m.symbol].recovery, currentStake: 1, cooldownLeft: 0 });
        });
        return displays;
    });

    const totalPnlRef = useRef(0);
    const totalTradesRef = useRef(0);
    const runningRef = useRef(false);
    const configRef = useRef({
        stake: 1, martingale: 2, takeProfit: 100, stopLoss: 100,
        martingaleMode: 'after_one_loss' as MartingaleModeType,
        consecutiveLossThreshold: 2,
    });
    const barrierRef = useRef(4);
    const predictionBeforeLossRef = useRef(4);
    const predictionAfterLossRef = useRef(5);
    const streakRef = useRef(4);
    const analysisTicksRef = useRef(1);
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
    const lDigitStrategyRef = useRef(lDigitStrategy);

    // Save L→digit strategy
    useEffect(() => {
        try { localStorage.setItem('auto_trades_lDigitStrategy', JSON.stringify(lDigitStrategy)); } catch {}
        lDigitStrategyRef.current = lDigitStrategy;
    }, [lDigitStrategy]);

    useEffect(() => {
        configRef.current = {
            stake: Number(stake) || 1,
            martingale: Math.max(1.01, Number(martingale) || 2),
            takeProfit: Number(takeProfit) || 100,
            stopLoss: Number(stopLoss) || 100,
            martingaleMode,
            consecutiveLossThreshold: clampConsecutiveLossThreshold(consecutiveLossCount),
        };
        try {
            localStorage.setItem('auto_trades_stake', stake);
            localStorage.setItem('auto_trades_martingale', martingale);
            localStorage.setItem('auto_trades_takeProfit', takeProfit);
            localStorage.setItem('auto_trades_stopLoss', stopLoss);
        } catch {}
    }, [stake, martingale, takeProfit, stopLoss, martingaleMode, consecutiveLossCount]);

    useEffect(() => {
        try { localStorage.setItem('auto_trades_tradeType', tradeType); } catch {}
        Object.values(marketStatesRef.current).forEach(({ main, recovery }) => {
            main.tradeType = tradeType;
            main.barrier = parseInt(barrier);
            main.streak = parseInt(streak);
            main.analysisTicks = parseInt(analysisTicks);
        });
    }, [tradeType, barrier, streak, analysisTicks]);

    useEffect(() => {
        try { localStorage.setItem('auto_trades_strategyTemplate', strategyTemplate); } catch {}
        const templateConfig = getTemplateTradeConfig(strategyTemplate);
        if (!templateConfig) return;
        setTradeType(templateConfig.tradeType);
        setBarrier(templateConfig.barrier);
        setAnalysisTicks('1');
        setInverseMode(false);
    }, [strategyTemplate]);

    useEffect(() => {
        barrierRef.current = getDigitNumber(barrier, 4);
        try { localStorage.setItem('auto_trades_barrier', barrier); } catch {}
    }, [barrier]);

    useEffect(() => {
        predictionBeforeLossRef.current = getDigitNumber(predictionBeforeLoss, 0);
        try { localStorage.setItem('auto_trades_predictionBeforeLoss', predictionBeforeLoss); } catch {}
    }, [predictionBeforeLoss]);

    useEffect(() => {
        predictionAfterLossRef.current = getDigitNumber(predictionAfterLoss, 0);
        try { localStorage.setItem('auto_trades_predictionAfterLoss', predictionAfterLoss); } catch {}
    }, [predictionAfterLoss]);

    useEffect(() => {
        streakRef.current = Math.min(10, Math.max(1, Number(streak) || 4));
        try { localStorage.setItem('auto_trades_streak', streak); } catch {}
    }, [streak]);

    useEffect(() => {
        analysisTicksRef.current = Math.min(10, Math.max(1, Number(analysisTicks) || 1));
        try { localStorage.setItem('auto_trades_analysisTicks', analysisTicks); } catch {}
    }, [analysisTicks]);

    useEffect(() => {
        martingaleModeRef.current = martingaleMode;
        try { localStorage.setItem('auto_trades_martingaleMode', martingaleMode); } catch {}
    }, [martingaleMode]);

    useEffect(() => {
        consecutiveLossCountRef.current = clampConsecutiveLossThreshold(consecutiveLossCount);
        try { localStorage.setItem('auto_trades_consecutiveLossCount', String(consecutiveLossCountRef.current)); } catch {}
    }, [consecutiveLossCount]);

    useEffect(() => {
        setConsecutiveLossCountInput(String(clampConsecutiveLossThreshold(consecutiveLossCount)));
    }, [consecutiveLossCount]);

    useEffect(() => {
        selectedMarketsRef.current = selectedMarkets;
        selectedMarketSymbolsRef.current = new Set(selectedMarketSymbols);
        selectedMarketSymbols.forEach(symbol => {
            if (!marketStatesRef.current[symbol]) {
                marketStatesRef.current[symbol] = {
                    main: createMarketState(symbol, 'MAIN'),
                    recovery: createMarketState(symbol, 'RECOVERY')
                };
            }
        });
        try { localStorage.setItem('auto_trades_markets', JSON.stringify(selectedMarketSymbols)); } catch {}
    }, [selectedMarketSymbols, selectedMarkets]);

    useEffect(() => {
        monitoredMarketSymbolsRef.current = new Set(
            strategyTemplate === 'STANDARD' ? selectedMarketSymbols : AUTO_MARKET_SYMBOLS
        );
    }, [selectedMarketSymbols, strategyTemplate]);

    useEffect(() => {
        floatingStrategyAlertRef.current = floatingStrategyAlert;
    }, [floatingStrategyAlert]);

    useEffect(() => {
        inverseModeRef.current = inverseMode;
        try { localStorage.setItem('auto_trades_inverseMode', String(inverseMode)); } catch {}
    }, [inverseMode]);

    useEffect(() => {
        modeTransitionLockRef.current = true;
        strategyModeRef.current = strategyMode;
        try { localStorage.setItem('auto_trades_strategyMode', strategyMode); } catch {}
        if (strategyMode === 'INVERSE') setInverseMode(true);
        else if (strategyMode === 'STANDARD' || strategyMode === 'PERCENTAGE') setInverseMode(false);
        if (strategyMode === 'PERCENTAGE') {
            Object.values(marketStatesRef.current).forEach(({ main, recovery }) => {
                [main, recovery].forEach(state => {
                    state.digitHistory = [];
                    state.digitPercentages = {};
                    state.directionSampleHistory = [];
                    state.confidenceScore = 0;
                    state.momentumCount = 0;
                    state.percentageQuoteHistory = [];
                    state.percentageEpochHistory = [];
                    state.percentageBackfilled = false;
                    state.percentageBackfillInFlight = false;
                });
            });
        }
        if (modeTransitionTimerRef.current !== null) window.clearTimeout(modeTransitionTimerRef.current);
        modeTransitionTimerRef.current = window.setTimeout(() => {
            modeTransitionTimerRef.current = null;
            modeTransitionLockRef.current = false;
        }, 100);
    }, [strategyMode]);

    const handleTradeTypeChange = useCallback((t: TradeType) => {
        setTradeType(t);
        setBarrier(DEFAULT_BARRIER[t]);
        if (usesLossPrediction(t)) {
            setPredictionBeforeLoss(DEFAULT_BARRIER[t]);
            setPredictionAfterLoss(t === 'DIGITOVER' ? '5' : '4');
        }
    }, []);

    const handleConsecutiveLossCountInputChange = useCallback((value: string) => {
        const digits_only = value.replace(/[^\d]/g, '').slice(0, 2);
        setConsecutiveLossCountInput(digits_only);
    }, []);

    const commitConsecutiveLossCountInput = useCallback(() => {
        setConsecutiveLossCount(clampConsecutiveLossThreshold(consecutiveLossCountInput || 2));
    }, [consecutiveLossCountInput]);

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
        const displays: any[] = [];
        selectedMarketsRef.current.forEach(m => {
            const states = marketStatesRef.current[m.symbol];
            if (states) {
                displays.push({ ...states.main, currentStake: nextStakeRef.current, cooldownLeft: states.main.lossCooldownLeft });
                displays.push({ ...states.recovery, currentStake: nextStakeRef.current, cooldownLeft: states.recovery.lossCooldownLeft });
            }
        });
        setMarketDisplays(displays);
        setTotalPnl(totalPnlRef.current);
        setTotalTrades(totalTradesRef.current);
        setCurrentStakeDisplay(nextStakeRef.current);
        let highestCooldown = 0;
        Object.values(marketStatesRef.current).forEach(({ main, recovery }) => {
            highestCooldown = Math.max(highestCooldown, main.lossCooldownLeft, recovery.lossCooldownLeft);
        });
        setCooldownDisplay(highestCooldown);
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

    const markMarketRecovering = useCallback((symbol: string, is_recovering: boolean) => {
        const states = marketStatesRef.current[symbol];
        if (!states) return;
        states.main.isRecovering = is_recovering;
        states.recovery.isRecovering = is_recovering;
        refreshDisplays();
    }, [refreshDisplays]);

    useEffect(() => { refreshDisplays(); }, [refreshDisplays, selectedMarketSymbols]);

    const handleAddMarket = useCallback((symbol: string) => {
        if (!AUTO_MARKET_LOOKUP.has(symbol) || runningRef.current) return;
        setSelectedMarketSymbols(current => (current.includes(symbol) ? current : [...current, symbol]));
    }, []);

    const handleRemoveMarket = useCallback((symbol: string) => {
        if (!AUTO_MARKET_LOOKUP.has(symbol) || runningRef.current) return;
        setSelectedMarketSymbols(current => current.filter(item => item !== symbol));
    }, []);

    const handleSelectAllMarkets = useCallback(() => {
        if (!runningRef.current) setSelectedMarketSymbols(AUTO_MARKET_SYMBOLS);
    }, []);

    const handleClearMarkets = useCallback(() => {
        if (!runningRef.current) setSelectedMarketSymbols([]);
    }, []);

    const handleLoadAlertMarket = useCallback((symbol: string, strategyId: DigitStrategyId) => {
        const market = AUTO_MARKET_LOOKUP.get(symbol);
        const strategy = DIGIT_STRATEGIES[strategyId];
        if (!market || !strategy) return;
        setStrategyTemplate(strategyId);
        setTradeType(strategy.contractType);
        setBarrier(strategy.winBarrier);
        setSelectedMarketSymbols([symbol]);
        setFloatingStrategyAlert(null);
        setError(null);
        try {
            localStorage.setItem('auto_trades_strategyTemplate', strategyId);
            localStorage.setItem('auto_trades_tradeType', strategy.contractType);
            localStorage.setItem('auto_trades_barrier', strategy.winBarrier);
            localStorage.setItem('auto_trades_markets', JSON.stringify([symbol]));
        } catch {}
    }, []);

    const pushContract = useCallback((data: any) => {
        try {
            transactions.pushTransaction({ ...data, run_id: run_panel.run_id });
            run_panel.onBotContractEvent(data);
            summary_card.onBotContractEvent(data);
        } catch {}
    }, [run_panel, summary_card, transactions]);

    const getActiveDigitBarrier = useCallback((ct: TradeType, lastResult: 'win' | 'loss' | null, consecutiveLosses = 0) => {
        return getPredictionForLastOutcome({
            trade_type: ct,
            last_result: lastResult,
            consecutive_losses: consecutiveLosses,
            prediction_before_loss: predictionBeforeLossRef.current,
            prediction_after_loss: predictionAfterLossRef.current,
            fallback_barrier: barrierRef.current,
        });
    }, []);

    const completeRunPanelStop = useCallback(() => {
        try {
            run_panel.is_contract_buying_in_progress = false;
            run_panel.setIsRunning(false);
            run_panel.setHasOpenContract?.(false);
            run_panel.setContractStage?.(contract_stages.NOT_RUNNING);
            run_panel.setShowBotStopMessage?.(false);
        } catch {}
        try {
            api_base.is_stopping = false;
            api_base.setIsRunning?.(false);
        } catch {}
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
        modeTransitionLockRef.current = false;
        contractStreamAbortControllersRef.current.forEach(controller => controller.abort());
        contractStreamAbortControllersRef.current.clear();
        restartInFlightRef.current = false;
    }, []);

    const executeTrade = useCallback(async (state: MarketState, stakeAmount: number, lastResult: 'win' | 'loss' | null): Promise<number> => {
        const ct = state.tradeType;
        const bar = getActiveDigitBarrier(ct, lastResult, consecutiveLossRef.current);
        const tradeStartTime = Math.floor(Date.now() / 1000);
        const verificationId = `${state.symbol}_${state.mode}_${tradeStartTime}_${Math.random().toString(36).substring(2, 11)}`;
        const abortController = new AbortController();

        const params: Record<string, any> = {
            amount: stakeAmount,
            basis: 'stake',
            contract_type: ct,
            currency: currency || 'USD',
            duration: state.analysisTicks || analysisTicksRef.current,
            duration_unit: 't',
            symbol: state.symbol,
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
                display_name: `${state.symbol} [${state.mode}]`,
                underlying_symbol: state.symbol,
                shortcode: `AUTO_${ct}_${state.symbol}`,
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
                    display_name: `${state.symbol} [${state.mode}]`,
                    underlying_symbol: state.symbol,
                    shortcode: `AUTO_${ct}_${state.symbol}`,
                    contract_type: ct,
                    currency: currency || 'USD',
                    verification_id: verificationId,
                },
                onUpdate: snapshot => { if (!unmountedRef.current) pushContract(snapshot); },
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
    }, [currency, getActiveDigitBarrier, pushContract, setError]);

    // handleAfterTrade - Manage switching between MAIN and RECOVERY
    const handleAfterTrade = useCallback((symbol: string, mode: MarketMode, profit: number) => {
        if (!runningRef.current) return;
        const states = marketStatesRef.current[symbol];
        if (!states) return;
        const state = mode === 'MAIN' ? states.main : states.recovery;
        if (!state) return;

        const { martingale: mult, takeProfit: tp, stopLoss: sl, stake: baseStake } = configRef.current;

        totalPnlRef.current = parseFloat((totalPnlRef.current + profit).toFixed(2));
        totalTradesRef.current++;

        const nextMartingaleState = getNextMartingaleState({
            profit,
            current_stake: nextStakeRef.current,
            base_stake: baseStake,
            multiplier: mult,
            martingale_mode: martingaleModeRef.current,
            consecutive_losses: consecutiveLossRef.current,
            consecutive_loss_trigger: consecutiveLossCountRef.current,
        });

        nextStakeRef.current = nextMartingaleState.nextStake;
        consecutiveLossRef.current = nextMartingaleState.consecutiveLosses;
        state.lastResult = nextMartingaleState.lastResult;
        state.lossCooldownLeft = profit < 0 ? MARKET_LOSS_COOLDOWN_TICKS : 0;
        previousContractResultRef.current = state.lastResult;
        state.tradeCount++;
        state.trading = false;
        globalTradingRef.current = false;

        // TWO MARKET SYSTEM LOGIC
        if (mode === 'MAIN') {
            if (profit < 0 && lDigitStrategyRef.current.enabled) {
                // LOSS on MAIN → Switch to RECOVERY
                activeMarketRef.current[symbol] = 'RECOVERY';
                states.recovery.recoveryWaitingForPattern = true;
                states.recovery.recoveryPatternMatched = false;
                states.recovery.consecutive = 0;
                states.recovery.recoveryOriginalTradeType = states.main.tradeType;
                // Set recovery trade type
                const recoveryType = getRecoveryTradeType(lDigitStrategyRef.current);
                if (recoveryType) states.recovery.tradeType = recoveryType;
                
                conditionNotifierStore.setCondition({
                    market: `${symbol} [MAIN]`,
                    condition: `🔴 LOSS → Switching to RECOVERY market`,
                    digits: `Waiting for pattern: ${lDigitStrategyRef.current.patternType}`,
                    result: false,
                    source: 'main-to-recovery',
                    timestamp: Date.now(),
                });
            }
        } else {
            // RECOVERY mode
            if (profit > 0) {
                // WIN on RECOVERY → Switch back to MAIN
                activeMarketRef.current[symbol] = 'MAIN';
                states.recovery.isRecoveryActive = false;
                states.recovery.recoveryWaitingForPattern = false;
                states.recovery.recoveryPatternMatched = false;
                states.recovery.recoveryOriginalTradeType = null;
                states.recovery.consecutive = 0;
                states.main.consecutive = 0;
                states.main.lastResult = null;
                
                conditionNotifierStore.setCondition({
                    market: `${symbol} [RECOVERY]`,
                    condition: `✅ WIN → Switching back to MAIN market`,
                    digits: '',
                    result: true,
                    source: 'recovery-to-main',
                    timestamp: Date.now(),
                });
            } else {
                // LOSS on RECOVERY → Continue with RECOVERY (wait for pattern again)
                states.recovery.recoveryWaitingForPattern = true;
                states.recovery.recoveryPatternMatched = false;
                states.recovery.consecutive = 0;
                
                conditionNotifierStore.setCondition({
                    market: `${symbol} [RECOVERY]`,
                    condition: `🔴 LOSS on RECOVERY - Waiting for pattern again`,
                    digits: `[${states.recovery.lastDigits.slice(-lDigitStrategyRef.current.lookbackTicks).join(', ')}]`,
                    result: false,
                    source: 'recovery-loss',
                    timestamp: Date.now(),
                });
            }
        }

        if (!unmountedRef.current) refreshDisplays();

        if ((totalPnlRef.current >= tp || totalPnlRef.current <= -sl) && runningRef.current) {
            runningRef.current = false;
            if (!unmountedRef.current) setIsRunning(false);
            completeRunPanelStop();
        }
    }, [completeRunPanelStop, refreshDisplays]);

    const isPatternDigit = useCallback((state: MarketState, digit: number): boolean => {
        const ct = state.tradeType;
        const lastResult = previousContractResultRef.current;
        const consecutiveLosses = consecutiveLossRef.current;
        if ((strategyModeRef.current === 'PERCENTAGE' || strategyTemplateRef.current !== 'STANDARD') && !modeTransitionLockRef.current) {
            return isPercentageSignalReady(ct, state, getActiveDigitBarrier(ct, lastResult, consecutiveLosses));
        }
        const bar = getActiveDigitBarrier(ct, lastResult, consecutiveLosses);
        const inv = inverseModeRef.current;
        return isDigitSignalMatch({ trade_type: ct, digit, barrier: bar, inverse: inv });
    }, [getActiveDigitBarrier]);

    const tryExecuteSignal = useCallback((state: MarketState, signalReady: boolean) => {
        if (runningRef.current && signalReady && !state.trading && !globalTradingRef.current && state.lossCooldownLeft === 0) {
            state.trading = true;
            state.consecutive = 0;
            globalTradingRef.current = true;
            state.tradeStartTime = Math.floor(Date.now() / 1000);
            state.verificationId = `${state.symbol}_${state.mode}_${state.tradeStartTime}_${Math.random().toString(36).substring(2, 11)}`;
            const stakeNow = nextStakeRef.current;
            if (stakeNow <= 0 || isNaN(stakeNow)) {
                console.error(`[AutoTrades] Invalid stake amount ${stakeNow}`);
                state.trading = false;
                globalTradingRef.current = false;
                setError('Auto Trades stopped because the stake amount is invalid.');
                refreshDisplays();
                return;
            }
            executeTrade(state, stakeNow, previousContractResultRef.current).then(profit =>
                handleAfterTrade(state.symbol, state.mode, profit)
            );
        }
    }, [executeTrade, handleAfterTrade, refreshDisplays]);

    const handleCandle = useCallback((symbol: string, candle: any) => {
        if (!selectedMarketSymbolsRef.current.has(symbol)) return;
        const states = marketStatesRef.current[symbol];
        if (!states) return;
        const open = Number(candle?.open);
        const close = Number(candle?.close);
        if (!Number.isFinite(open) || !Number.isFinite(close)) return;

        ['MAIN', 'RECOVERY'].forEach(mode => {
            const state = mode === 'MAIN' ? states.main : states.recovery;
            state.candleOpen = open;
            state.candleClose = close;
            state.candleDirection = close > open ? 1 : close < open ? -1 : 0;
            if (activeMarketRef.current[symbol] === mode) {
                const ct = state.tradeType;
                let signalReady = false;
                signalReady = isCandleConfirmedTradeType(ct) &&
                    state.consecutive >= streakRef.current &&
                    (inverseModeRef.current ? isInverseCandleMatch(ct, state.candleDirection) : isCandleMatch(ct, state.candleDirection));
                tryExecuteSignal(state, signalReady);
            }
        });
        refreshDisplays();
    }, [refreshDisplays, tryExecuteSignal]);

    handleCandleRef.current = handleCandle;

    const handleTick = useCallback((symbol: string, tick: any) => {
        if (!monitoredMarketSymbolsRef.current.has(symbol)) return;
        const states = marketStatesRef.current[symbol];
        if (!states) return;

        const pip = getMarketPipSize(symbol, AUTO_MARKET_LOOKUP.get(symbol)?.pip ?? 2);
        const quote = tick.quote as number;

        ['MAIN', 'RECOVERY'].forEach(mode => {
            const state = mode === 'MAIN' ? states.main : states.recovery;
            const ct = state.tradeType;
            const targetLen = getEffectiveSignalStreak({ trade_type: ct, configured_streak: streakRef.current });

            state.lastQuote = quote;
            state.isRecovering = false;
            lastTickAtRef.current = Date.now();
            if (isRecoveringDataRef.current) clearDataRecoveryLoading();

            if ((strategyModeRef.current === 'PERCENTAGE' || strategyTemplateRef.current !== 'STANDARD') && !modeTransitionLockRef.current) {
                const epoch = Number(tick.epoch);
                appendPercentageQuote(state, quote, Number.isFinite(epoch) ? epoch : null);
            }

            if (state.lossCooldownLeft > 0) state.lossCooldownLeft = Math.max(0, state.lossCooldownLeft - 1);

            const prev = state.prevQuote;
            const dir: Direction = prev === null ? 0 : quote > prev ? 1 : quote < prev ? -1 : 0;
            state.directionHistory = [...state.directionHistory.slice(-20), dir];
            state.prevQuote = quote;

            if (IS_DIRECTION_TYPE[ct]) {
                if (dir !== 0) {
                    const match = inverseModeRef.current ? isInverseDirectionMatch(ct, dir) : isDirectionMatch(ct, dir);
                    if (match) state.consecutive = Math.min(state.consecutive + 1, 10);
                    else state.consecutive = 0;
                }
            } else {
                const lastDigit = getLastDigitFromQuote(quote, symbol, pip);
                state.lastDigits = [...state.lastDigits.slice(-20), lastDigit];
                state.prevQuote = quote;
                if (isPatternDigit(state, lastDigit)) {
                    state.consecutive = Math.min(state.consecutive + 1, 10);
                } else {
                    state.consecutive = 0;
                }
            }

            const candleMatch = inverseModeRef.current ? isInverseCandleMatch(ct, state.candleDirection) : isCandleMatch(ct, state.candleDirection);
            const requiresCandle = isCandleConfirmedTradeType(ct);
            const lastPredictionResult = previousContractResultRef.current;
            const activeBarrier = getActiveDigitBarrier(ct, lastPredictionResult, consecutiveLossRef.current);

            // Special strategy evaluation
            const activeStrategyTemplate = strategyTemplateRef.current;
            const specialStrategyEvaluation = activeStrategyTemplate !== 'STANDARD'
                ? evaluateDigitStrategy(activeStrategyTemplate, state.digitPercentages, state.lastDigits)
                : null;

            if (specialStrategyEvaluation) {
                const wasAlertActive = state.alertActive;
                state.alertActive = specialStrategyEvaluation.isQualified;
                state.specialEntryReady = specialStrategyEvaluation.entryReady;
                state.trailingTriggerCount = specialStrategyEvaluation.trailingTriggerCount;
                state.qualifyingWinningDigits = specialStrategyEvaluation.qualifyingWinningDigits;
                state.alertMessage = specialStrategyEvaluation.isQualified
                    ? `${specialStrategyEvaluation.alertLabel} ready to watch. Winning digits >= 10.5%: ${specialStrategyEvaluation.qualifyingWinningDigits.join(', ')}`
                    : `${specialStrategyEvaluation.alertLabel} waiting for qualifying percentages.`;

                if (!wasAlertActive && specialStrategyEvaluation.isQualified) {
                    const marketLabel = AUTO_MARKET_LOOKUP.get(symbol)?.label ?? symbol;
                    playStrategyAlertSound();
                    setFloatingStrategyAlert({
                        marketLabel,
                        message: state.alertMessage,
                        strategyId: activeStrategyTemplate,
                        symbol,
                    });
                } else if (floatingStrategyAlertRef.current?.symbol === symbol &&
                    floatingStrategyAlertRef.current?.strategyId === activeStrategyTemplate &&
                    !specialStrategyEvaluation.isQualified) {
                    setFloatingStrategyAlert(current =>
                        current?.symbol === symbol && current.strategyId === activeStrategyTemplate ? null : current
                    );
                }

                if (runningRef.current && selectedMarketSymbolsRef.current.has(symbol) && !specialStrategyEvaluation.isQualified) {
                    stopTradingRef.current();
                    setError(`${AUTO_MARKET_LOOKUP.get(symbol)?.label ?? symbol} no longer matches ${specialStrategyEvaluation.alertLabel}. Auto Trades stopped.`);
                    return;
                }
            } else {
                state.alertActive = false;
                state.specialEntryReady = false;
                state.trailingTriggerCount = 0;
                state.qualifyingWinningDigits = [];
                state.alertMessage = '';
            }

            // RECOVERY MARKET LOGIC - Check for pattern match
            if (mode === 'RECOVERY' && lDigitStrategyRef.current.enabled) {
                if (state.recoveryWaitingForPattern) {
                    const patternMatched = evaluateRecoveryPattern(lDigitStrategyRef.current, state.lastDigits, state.directionHistory);
                    if (patternMatched) {
                        state.recoveryPatternMatched = true;
                        state.recoveryWaitingForPattern = false;
                        state.isRecoveryActive = true;
                        state.consecutive = Math.min(state.consecutive + 1, 10);
                        conditionNotifierStore.setCondition({
                            market: `${symbol} [RECOVERY]`,
                            condition: `✅ Pattern MATCHED: ${lDigitStrategyRef.current.patternType}`,
                            digits: `[${state.lastDigits.slice(-lDigitStrategyRef.current.lookbackTicks).join(', ')}]`,
                            result: true,
                            source: 'recovery-pattern-match',
                            timestamp: Date.now(),
                        });
                    }
                }
                if (state.isRecoveryActive) {
                    const patternStillMatches = evaluateRecoveryPattern(lDigitStrategyRef.current, state.lastDigits, state.directionHistory);
                    if (!patternStillMatches) {
                        state.isRecoveryActive = false;
                        state.recoveryWaitingForPattern = true;
                        state.recoveryPatternMatched = false;
                        state.consecutive = 0;
                        conditionNotifierStore.setCondition({
                            market: `${symbol} [RECOVERY]`,
                            condition: `⏳ Pattern broke - waiting again: ${lDigitStrategyRef.current.patternType}`,
                            digits: `[${state.lastDigits.slice(-lDigitStrategyRef.current.lookbackTicks).join(', ')}]`,
                            result: false,
                            source: 'recovery-pattern-break',
                            timestamp: Date.now(),
                        });
                    }
                }
            }

            // SIGNAL CHECK - Only for active market
            const isActive = activeMarketRef.current[symbol] === mode;
            let canTrade = isActive;
            if (mode === 'RECOVERY') {
                canTrade = isActive && state.isRecoveryActive && !state.recoveryWaitingForPattern;
            }

            let signalReady = false;
            if (canTrade) {
                const riskFilteredDigitStreakReady = !usesLossPrediction(ct) ||
                    hasRequiredDigitStreak({
                        trade_type: ct,
                        digits: state.lastDigits,
                        barrier: activeBarrier,
                        inverse: inverseModeRef.current,
                        streak: targetLen,
                    });
                signalReady = specialStrategyEvaluation
                    ? specialStrategyEvaluation.entryReady
                    : strategyModeRef.current === 'PERCENTAGE' && !modeTransitionLockRef.current
                        ? isPercentageSignalReady(ct, state, activeBarrier) && (!requiresCandle || candleMatch)
                        : state.consecutive >= targetLen && riskFilteredDigitStreakReady && (!requiresCandle || candleMatch);
            }

            // Log condition
            if (runningRef.current || specialStrategyEvaluation) {
                const mkt = AUTO_MARKET_LOOKUP.get(symbol);
                const isActiveMode = activeMarketRef.current[symbol] === mode;
                let condStr = '', digitsStr = '';
                if (mode === 'RECOVERY' && state.recoveryWaitingForPattern) {
                    condStr = `⏳ RECOVERY WAITING: ${lDigitStrategyRef.current.patternType}`;
                    digitsStr = `[${state.lastDigits.slice(-lDigitStrategyRef.current.lookbackTicks).join(', ')}]`;
                } else if (mode === 'RECOVERY' && state.isRecoveryActive) {
                    condStr = `🔴 RECOVERY ACTIVE: ${lDigitStrategyRef.current.patternType}`;
                    digitsStr = `[${state.lastDigits.slice(-lDigitStrategyRef.current.lookbackTicks).join(', ')}]`;
                } else if (IS_DIRECTION_TYPE[ct]) {
                    const dirs = state.directionHistory.slice(-targetLen);
                    digitsStr = `[${dirs.map(d => d === 1 ? '↑' : d === -1 ? '↓' : '—').join(', ')}]`;
                    condStr = getDirectionCondition(ct, targetLen);
                } else {
                    const recent = state.lastDigits.slice(-targetLen);
                    digitsStr = `[${recent.join(', ')}]`;
                    const bar = activeBarrier;
                    if (inverseModeRef.current) {
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
                const marketLabel = mode === 'MAIN' ? `${mkt?.label ?? symbol} [MAIN]` : `${mkt?.label ?? symbol} [RECOVERY]`;
                const isWaiting = mode === 'RECOVERY' && state.recoveryWaitingForPattern;
                conditionNotifierStore.setCondition({
                    market: marketLabel,
                    condition: condStr,
                    digits: digitsStr,
                    result: isWaiting ? false : (specialStrategyEvaluation ? specialStrategyEvaluation.isQualified : signalReady),
                    source: isWaiting ? 'recovery-waiting' : (mode === 'RECOVERY' ? 'recovery-active' : 'main'),
                    timestamp: Date.now(),
                });
            }

            if (canTrade && signalReady) {
                tryExecuteSignal(state, signalReady);
            }
        });

        refreshDisplays();
    }, [clearDataRecoveryLoading, getActiveDigitBarrier, isPatternDigit, refreshDisplays, tryExecuteSignal]);

    handleTickRef.current = handleTick;

    useEffect(() => { unmountedRef.current = false; return () => { unmountedRef.current = true; }; }, []);

    const backfillPercentageTicks = useCallback(async (symbol: string) => {
        const states = marketStatesRef.current[symbol];
        if (!states) return;
        ['MAIN', 'RECOVERY'].forEach(mode => {
            const state = mode === 'MAIN' ? states.main : states.recovery;
            if (state.percentageBackfilled || state.percentageBackfillInFlight ||
                (strategyModeRef.current !== 'PERCENTAGE' && strategyTemplateRef.current === 'STANDARD')) {
                return;
            }
            state.percentageBackfillInFlight = true;
        });

        try {
            const response = await (api_base.api as any).send({
                ticks_history: symbol,
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

            ['MAIN', 'RECOVERY'].forEach(mode => {
                const state = mode === 'MAIN' ? states.main : states.recovery;
                state.percentageQuoteHistory = quotes.slice(-PERCENTAGE_ANALYSIS_HISTORY_SIZE);
                state.percentageEpochHistory = epochs.slice(-state.percentageQuoteHistory.length);
                state.percentageBackfilled = state.percentageQuoteHistory.length > 0;
                if (state.percentageQuoteHistory.length > 0) {
                    const latestQuote = state.percentageQuoteHistory[state.percentageQuoteHistory.length - 1];
                    rebuildPercentageAnalytics(state);
                    state.lastQuote = latestQuote;
                    state.prevQuote = latestQuote;
                    state.lastDigits = state.digitHistory.slice(-10);
                    state.directionHistory = state.directionSampleHistory.slice(-10);
                }
                state.percentageBackfillInFlight = false;
            });
            refreshDisplays();
        } catch (error) {
            ['MAIN', 'RECOVERY'].forEach(mode => {
                const state = mode === 'MAIN' ? states.main : states.recovery;
                state.percentageBackfilled = false;
                state.percentageBackfillInFlight = false;
            });
            if (!isExpectedStreamInterruption(error)) {
                console.warn(`[AutoTrades] Percentage history backfill failed for ${symbol}:`, error);
            }
        }
    }, [refreshDisplays]);

    const startSubscriptions = useCallback(async () => {
        const subscriptionVersion = subscriptionVersionRef.current;
        const monitorAllMarkets = strategyTemplateRef.current !== 'STANDARD';
        const marketsToMonitor = monitorAllMarkets ? AUTO_MARKETS : selectedMarketsRef.current;
        const monitoredSymbolSet = new Set(marketsToMonitor.map(({ symbol }) => symbol));
        const candleSymbolSet = monitorAllMarkets ? new Set<string>() : new Set(selectedMarketsRef.current.map(({ symbol }) => symbol));

        Object.entries(subscriptionsRef.current).forEach(([symbol, sub]) => {
            if (!monitoredSymbolSet.has(symbol)) {
                try { sub?.unsubscribe?.(); } catch {}
                delete subscriptionsRef.current[symbol];
                updateSubscriptionDiagnostics();
            }
        });
        Object.entries(candleSubscriptionsRef.current).forEach(([symbol, sub]) => {
            if (!candleSymbolSet.has(symbol)) {
                try { sub?.unsubscribe?.(); } catch {}
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
            if (strategyModeRef.current === 'PERCENTAGE' || strategyTemplateRef.current !== 'STANDARD') {
                backfillPercentageTicks(market.symbol);
            }
            if (!subscriptionsRef.current[market.symbol]) {
                try {
                    const obs = (api_base.api as any).subscribe({ ticks: market.symbol });
                    const sub = safeSubscribe(obs,
                        (data: any) => {
                            if (subscriptionVersion !== subscriptionVersionRef.current) return;
                            if (!show_auto_ref.current || unmountedRef.current) return;
                            if (data?.error) {
                                if (!isExpectedStreamInterruption(data.error)) {
                                    console.warn(`[AutoTrades] Tick stream error for ${market.symbol}:`, data.error);
                                }
                                markMarketRecovering(market.symbol, true);
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
                            markMarketRecovering(market.symbol, true);
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
                    const sub = safeSubscribe(obs,
                        (data: any) => {
                            if (subscriptionVersion !== subscriptionVersionRef.current) return;
                            if (!show_auto_ref.current || unmountedRef.current) return;
                            if (data?.error) {
                                if (!isExpectedStreamInterruption(data.error)) {
                                    console.warn(`[AutoTrades] Candle stream error for ${market.symbol}:`, data.error);
                                }
                                markMarketRecovering(market.symbol, true);
                                return;
                            }
                            const candle = data?.ohlc ??
                                (Array.isArray(data?.candles) ? data.candles[data.candles.length - 1] : null);
                            if (candle) handleCandleRef.current(market.symbol, candle);
                        },
                        (streamError: unknown) => {
                            if (subscriptionVersion !== subscriptionVersionRef.current) return;
                            if (!show_auto_ref.current || unmountedRef.current) return;
                            if (!isExpectedStreamInterruption(streamError)) {
                                console.warn(`[AutoTrades] Candle stream error for ${market.symbol}:`, streamError);
                            }
                            markMarketRecovering(market.symbol, true);
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
    }, [backfillPercentageTicks, clearDataRecoveryLoading, markMarketRecovering, setDataRecoveryLoading, updateSubscriptionDiagnostics]);

    const stopSubscriptions = useCallback(() => {
        subscriptionVersionRef.current++;
        Object.values(subscriptionsRef.current).forEach(sub => { try { sub?.unsubscribe?.(); } catch {} });
        subscriptionsRef.current = {};
        Object.values(candleSubscriptionsRef.current).forEach(sub => { try { sub?.unsubscribe?.(); } catch {} });
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
            startSubscriptions().catch(err => console.error('[AutoTrades] Data restart failed:', err)).finally(() => {
                restartInFlightRef.current = false;
                lastTickAtRef.current = Date.now();
            });
        }, 800);
    }, [setDataRecoveryLoading, startSubscriptions, stopSubscriptions]);

    const resetSession = useCallback(() => {
        const baseStake = configRef.current.stake;
        nextStakeRef.current = baseStake;
        globalTradingRef.current = false;
        previousContractResultRef.current = null;
        consecutiveLossRef.current = 0;
        selectedMarkets.forEach(m => {
            const states = marketStatesRef.current[m.symbol];
            if (states) {
                states.main = createMarketState(m.symbol, 'MAIN');
                states.recovery = createMarketState(m.symbol, 'RECOVERY');
                const recoveryType = getRecoveryTradeType(lDigitStrategyRef.current);
                if (recoveryType) states.recovery.tradeType = recoveryType;
            }
            activeMarketRef.current[m.symbol] = 'MAIN';
        });
        totalPnlRef.current = 0;
        totalTradesRef.current = 0;
        setTotalPnl(0);
        setTotalTrades(0);
        setCooldownDisplay(0);
        setCurrentStakeDisplay(baseStake);
        setError(null);
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
        } catch {}
        dashboard.setActiveTradingModule('auto_trades');
        runningRef.current = true;
        setIsRunning(true);
    }, [dashboard, resetSession, run_panel, selectedMarkets.length]);

    const stopTrading = useCallback(() => {
        runningRef.current = false;
        globalTradingRef.current = false;
        consecutiveLossRef.current = 0;
        previousContractResultRef.current = null;
        clearDeferredWork();
        Object.values(marketStatesRef.current).forEach(({ main, recovery }) => {
            main.trading = false;
            main.consecutive = 0;
            main.tradeStartTime = null;
            main.verificationId = null;
            main.lossCooldownLeft = 0;
            recovery.trading = false;
            recovery.consecutive = 0;
            recovery.tradeStartTime = null;
            recovery.verificationId = null;
            recovery.lossCooldownLeft = 0;
            recovery.isRecoveryActive = false;
            recovery.recoveryWaitingForPattern = false;
            recovery.recoveryPatternMatched = false;
            recovery.recoveryOriginalTradeType = null;
        });
        Object.keys(activeMarketRef.current).forEach(symbol => { activeMarketRef.current[symbol] = 'MAIN'; });
        setIsRunning(false);
        clearDataRecoveryLoading();
        setCooldownDisplay(0);
        setCurrentStakeDisplay(configRef.current.stake);
        nextStakeRef.current = configRef.current.stake;
        dashboard.setActiveTradingModule(null);
        recordDiagnosticEvent('auto_trades.stop_trading', {
            selectedMarkets: selectedMarketsRef.current.length,
            tickStreams: Object.keys(subscriptionsRef.current).length,
            candleStreams: Object.keys(candleSubscriptionsRef.current).length,
        });
        updateSubscriptionDiagnostics();
        completeRunPanelStop();
        refreshDisplays();
    }, [clearDataRecoveryLoading, clearDeferredWork, completeRunPanelStop, dashboard, refreshDisplays, updateSubscriptionDiagnostics]);

    const handleStop = useCallback(() => { stopTrading(); }, [stopTrading]);

    useEffect(() => { stopTradingRef.current = stopTrading; }, [stopTrading]);

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
                    if (api_base.api) { clearInterval(id); startSubscriptions(); }
                }, 1000);
                return () => clearInterval(id);
            }
        } else {
            if (runningRef.current) {
                runningRef.current = false;
                setIsRunning(false);
                try { run_panel.setIsRunning(false); } catch {}
            }
            clearDeferredWork();
            stopSubscriptions();
        }
        return undefined;
    }, [clearDeferredWork, show_auto, run_panel, startSubscriptions, stopSubscriptions]);

    useEffect(() => {
        if (!show_auto || !api_base.api) return;
        startSubscriptions();
    }, [selectedMarketSymbols, show_auto, startSubscriptions, strategyMode, strategyTemplate]);

    const dataSilenceIntervalRef = useRef<number | null>(null);
    useEffect(() => {
        if (dataSilenceIntervalRef.current) { window.clearInterval(dataSilenceIntervalRef.current); dataSilenceIntervalRef.current = null; }
        if (!show_auto) return undefined;
        dataSilenceIntervalRef.current = window.setInterval(() => {
            if (!show_auto_ref.current || unmountedRef.current) return;
            const has_selected_markets = selectedMarketsRef.current.length > 0;
            const silent_for = Date.now() - lastTickAtRef.current;
            if (has_selected_markets && silent_for > DATA_SILENCE_RESTART_MS) {
                if (!restartInFlightRef.current) restartSubscriptions();
            }
        }, 5000);
        return () => {
            if (dataSilenceIntervalRef.current) { window.clearInterval(dataSilenceIntervalRef.current); dataSilenceIntervalRef.current = null; }
        };
    }, [restartSubscriptions, show_auto]);

    useEffect(() => {
        if (!run_panel.is_running && runningRef.current && show_auto) stopTrading();
    }, [run_panel.is_running, show_auto, stopTrading]);

    useEffect(() => () => {
        unmountedRef.current = true;
        clearDeferredWork();
        subscriptionVersionRef.current++;
        runningRef.current = false;
        stopTrading();
        try { run_panel.setIsRunning(false); run_panel.setHasOpenContract(false); } catch {}
        stopSubscriptions();
        Object.values(marketStatesRef.current).forEach(({ main, recovery }) => {
            [main, recovery].forEach(state => {
                state.digitHistory.length = 0;
                state.directionHistory.length = 0;
                state.percentageQuoteHistory.length = 0;
                state.percentageEpochHistory.length = 0;
                state.directionSampleHistory.length = 0;
                state.lastDigits.length = 0;
            });
        });
    }, [clearDeferredWork, run_panel, stopTrading, stopSubscriptions]);

    if (!show_auto) return null;

    // Computed values for rendering
    const pnlPositive = totalPnl > 0;
    const pnlNegative = totalPnl < 0;
    const baseStakeNum = Number(stake) || 1;
    const martingaleActive = currentStakeDisplay > baseStakeNum;
    const inCooldown = cooldownDisplay > 0;
    const usingSpecialStrategy = strategyTemplate !== 'STANDARD';
    const isDirection = IS_DIRECTION_TYPE[tradeType];
    const activeSpecialStrategy = usingSpecialStrategy ? DIGIT_STRATEGIES[strategyTemplate as DigitStrategyId] : null;

    const hasAnyLiveQuote = selectedMarkets.length > 0 && marketDisplays.some(display => display?.lastQuote !== null);
    const hasAllLiveQuotes = selectedMarkets.length > 0 && marketDisplays.every(display => display?.lastQuote !== null);
    const isDataLoading = selectedMarketSymbols.length > 0 &&
        ((!hasAnyLiveQuote && (dataStreamLoading || !isConnected || show_auto)) ||
         (!hasAllLiveQuotes && !hasAnyLiveQuote));

    const isAnyRecoveryActive = Object.values(activeMarketRef.current).some(m => m === 'RECOVERY');
    const isAnyRecoveryWaiting = Object.values(marketStatesRef.current).some(({ recovery }) => recovery.recoveryWaitingForPattern);

    return (
        <div className='auto-trades-page'>
            <ThemedScrollbars className='auto-trades-page__scroll'>
                <div className='auto-trades-page__inner'>
                    {/* Header */}
                    <div className='auto-trades-page__header'>
                        <div>
                            <h1 className='auto-trades-page__title'>Auto Trades</h1>
                            <p className='auto-trades-page__subtitle'>
                                {isAnyRecoveryActive 
                                    ? `🔴 RECOVERY ACTIVE - ${Object.values(activeMarketRef.current).filter(m => m === 'RECOVERY').length} market(s) in recovery`
                                    : isAnyRecoveryWaiting
                                    ? `⏳ RECOVERY WAITING - ${Object.values(marketStatesRef.current).filter(({ recovery }) => recovery.recoveryWaitingForPattern).length} market(s) waiting for pattern`
                                    : `${Object.values(activeMarketRef.current).filter(m => m === 'MAIN').length} market(s) in MAIN mode`
                                }
                            </p>
                        </div>
                        <div className='auto-trades-page__status-dot'>
                            <span className={classNames('auto-trades-status', {
                                'auto-trades-status--connected': isConnected && !inCooldown,
                                'auto-trades-status--running': isRunning && !inCooldown && !isAnyRecoveryWaiting,
                                'auto-trades-status--waiting': isAnyRecoveryWaiting && isRunning,
                                'auto-trades-status--cooldown': inCooldown,
                                'auto-trades-status--loading': isDataLoading && !inCooldown,
                            })} />
                            <span className='auto-trades-status__label'>
                                {isAnyRecoveryWaiting && isRunning ? '⏳ Waiting for recovery pattern' :
                                 inCooldown ? `Cooldown ${cooldownDisplay}t` :
                                 isDataLoading ? 'Loading data' :
                                 isRunning ? 'Trading' :
                                 isConnected ? 'Live data' :
                                 selectedMarketSymbols.length === 0 ? 'No markets' : 'Connecting…'}
                            </span>
                        </div>
                    </div>

                    {/* Recovery Status Banners */}
                    {isAnyRecoveryWaiting && isRunning && (
                        <div className='auto-trades-recovery-waiting'>
                            <span className='auto-trades-recovery-waiting__icon'>⏳</span>
                            <span><strong>Recovery Market Active:</strong> Waiting for pattern to match — <strong>NO TRADING</strong> until pattern is confirmed</span>
                        </div>
                    )}
                    {isAnyRecoveryActive && isRunning && (
                        <div className='auto-trades-recovery-active'>
                            <span className='auto-trades-recovery-active__icon'>🔴</span>
                            <span><strong>Recovery Market Active:</strong> Trading with L→Digit strategy</span>
                        </div>
                    )}
                    {inCooldown && isRunning && (
                        <div className='auto-trades-cooldown'>
                            <span className='auto-trades-cooldown__icon'>⏳</span>
                            <span>Cooldown after loss — all markets paused for <strong>{cooldownDisplay}</strong> more ticks</span>
                        </div>
                    )}

                    {!client.is_logged_in && <div className='auto-trades-page__notice'>Please log in to your Deriv account to execute real trades.</div>}
                    {error && <div className='auto-trades-page__error'>{error}</div>}

                    {floatingStrategyAlert && (
                        <div className='auto-trades-floating-alert' role='status' aria-live='polite'>
                            <div className='auto-trades-floating-alert__eyebrow'>{DIGIT_STRATEGIES[floatingStrategyAlert.strategyId].alertLabel} ready</div>
                            <strong>{floatingStrategyAlert.marketLabel}</strong>
                            <p>{floatingStrategyAlert.message}</p>
                            <div className='auto-trades-floating-alert__actions'>
                                <button type='button' onClick={() => handleLoadAlertMarket(floatingStrategyAlert.symbol, floatingStrategyAlert.strategyId)}>Load market</button>
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
                        {/* Sidebar - Settings */}
                        <div className='auto-trades-page__sidebar'>
                            <div className='auto-trades-card'>
                                <h2 className='auto-trades-card__title'>Settings</h2>

                                {/* Strategy Template */}
                                <div className='auto-trades-config__group'>
                                    <div className='auto-trades-strategy-selector'>
                                        <label>Strategy template</label>
                                        <select className='auto-trades-strategy-selector__select' value={strategyTemplate} onChange={e => setStrategyTemplate(e.target.value as StrategyTemplate)} disabled={isRunning}>
                                            <option value='STANDARD'>Standard builder</option>
                                            <option value='OVER_2_MARKET'>Over 2 Market</option>
                                            <option value='UNDER_7_MARKET'>Under 7 Market</option>
                                        </select>
                                    </div>
                                    <p className='auto-trades-inverse__hint'>
                                        {usingSpecialStrategy ? 'Scans every volatility and 1s market in the background. When one qualifies, load that market and click Start Trading to wait for the entry and buy automatically.' : 'Use the standard contract builder to configure your own auto-trade rule.'}
                                    </p>
                                </div>

                                {/* Contract Type */}
                                <div className='auto-trades-config__group'>
                                    <p className='auto-trades-config__group-label'>Contract Type</p>
                                    <div className='auto-trades-config__trade-row'>
                                        <div className='auto-trades-config__field auto-trades-config__field--type'>
                                            <label>Type</label>
                                            <select className='auto-trades-config__select' value={tradeType} onChange={e => handleTradeTypeChange(e.target.value as TradeType)} disabled={isRunning || usingSpecialStrategy}>
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

                                        {usesLossPrediction(tradeType) && (
                                            <div className='auto-trades-config__prediction-pair'>
                                                <div className='auto-trades-config__prediction-label'>
                                                    Prediction
                                                    <span className='auto-trades-config__prediction-hint'>W→digit / L→digit</span>
                                                </div>
                                                <div className='auto-trades-config__prediction-controls'>
                                                    <div className='auto-trades-config__prediction-item'>
                                                        <span className='auto-trades-config__prediction-tag auto-trades-config__prediction-tag--win'>W</span>
                                                        <select className='auto-trades-config__select auto-trades-config__select--compact' value={predictionBeforeLoss} onChange={e => setPredictionBeforeLoss(e.target.value)} disabled={isRunning || usingSpecialStrategy}>
                                                            {[0,1,2,3,4,5,6,7,8,9].map(d => <option key={d} value={String(d)}>{d}</option>)}
                                                        </select>
                                                    </div>
                                                    <span className='auto-trades-config__prediction-divider'>|</span>
                                                    <div className='auto-trades-config__prediction-item'>
                                                        <span className='auto-trades-config__prediction-tag auto-trades-config__prediction-tag--loss'>L</span>
                                                        <select className='auto-trades-config__select auto-trades-config__select--compact' value={predictionAfterLoss} onChange={e => setPredictionAfterLoss(e.target.value)} disabled={isRunning || usingSpecialStrategy}>
                                                            {[0,1,2,3,4,5,6,7,8,9].map(d => <option key={d} value={String(d)}>{d}</option>)}
                                                        </select>
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {BARRIER_NEEDED[tradeType] && !usesLossPrediction(tradeType) && (
                                            <div className='auto-trades-config__field auto-trades-config__field--narrow'>
                                                <label>{tradeType === 'DIGITMATCH' || tradeType === 'DIGITDIFF' ? 'Prediction' : 'Digit'}</label>
                                                <select className='auto-trades-config__select' value={barrier} onChange={e => setBarrier(e.target.value)} disabled={isRunning || usingSpecialStrategy}>
                                                    {[0,1,2,3,4,5,6,7,8,9].map(d => <option key={d} value={String(d)}>{d}</option>)}
                                                </select>
                                            </div>
                                        )}

                                        <div className='auto-trades-config__field auto-trades-config__field--analysis'>
                                            <label>Analysis ticks</label>
                                            <select className='auto-trades-config__select' value={analysisTicks} onChange={e => setAnalysisTicks(e.target.value)} disabled={isRunning || usingSpecialStrategy}>
                                                {[1,2,3,4,5,6,7,8,9,10].map(d => <option key={d} value={String(d)}>{d}</option>)}
                                            </select>
                                        </div>
                                    </div>

                                    <div className='auto-trades-config__field' style={{ marginTop: '0.8rem' }}>
                                        <label>Streak ({isDirection ? getDirectionStreakLabel(tradeType) : 'matching digits'})</label>
                                        <div className='auto-trades-config__streak-row'>
                                            <input className='auto-trades-config__streak-slider' type='range' min='1' max='10' step='1' value={streak} onChange={e => setStreak(e.target.value)} disabled={isRunning || usingSpecialStrategy} />
                                            <span className='auto-trades-config__streak-value'>{streak}</span>
                                        </div>
                                    </div>
                                </div>

                                {/* Strategy Mode */}
                                <div className='auto-trades-config__group'>
                                    <div className='auto-trades-strategy-selector'>
                                        <label>Strategy Mode</label>
                                        <select className='auto-trades-strategy-selector__select' value={strategyMode} onChange={e => setStrategyMode(e.target.value as StrategyMode)} disabled={isRunning || usingSpecialStrategy}>
                                            <option value='STANDARD'>Standard</option>
                                            <option value='INVERSE'>Inverse</option>
                                            <option value='PERCENTAGE'>Percentage Mode</option>
                                        </select>
                                    </div>
                                    <p className='auto-trades-inverse__hint'>
                                        {strategyMode === 'PERCENTAGE' ? 'Auto-loads the latest 1,000 ticks and keeps a live rolling percentage window' :
                                         strategyMode === 'INVERSE' ? 'Detects opposite signals, executes contracts' :
                                         'Detects standard signals, executes contracts'}
                                    </p>
                                </div>

                                {/* Signal Mode */}
                                {strategyMode !== 'PERCENTAGE' && !usingSpecialStrategy && (
                                    <div className='auto-trades-config__group'>
                                        <button type='button' className={classNames('auto-trades-strategy-btn', inverseMode && 'auto-trades-strategy-btn--active')} onClick={() => setInverseMode(prev => !prev)} disabled={isRunning || usingSpecialStrategy}>
                                            <span className='auto-trades-strategy-btn__badge'>{inverseMode ? 'Inverse' : 'Direct'}</span>
                                            <span className='auto-trades-strategy-btn__label'>Signal Mode</span>
                                            <span className={classNames('auto-trades-inverse__toggle-switch', 'auto-trades-strategy-btn__switch')}><span className='auto-trades-inverse__toggle-knob' /></span>
                                        </button>
                                    </div>
                )}

                                {/* L→Digit Strategy - Recovery Market */}
                                <div className='auto-trades-l-digit-section'>
                                    <div className='auto-trades-l-digit-section__header'>
                                        <span className='auto-trades-l-digit-section__icon'>🔄</span>
                                        <span className='auto-trades-l-digit-section__title'>Recovery Market (L→Digit)</span>
                                        <span className={classNames('auto-trades-l-digit-section__badge', {
                                            'auto-trades-l-digit-section__badge--active': lDigitStrategy.enabled && isAnyRecoveryActive && isRunning,
                                            'auto-trades-l-digit-section__badge--waiting': lDigitStrategy.enabled && isAnyRecoveryWaiting && isRunning,
                                        })}>
                                            {lDigitStrategy.enabled && isRunning ? (isAnyRecoveryActive ? 'ACTIVE' : isAnyRecoveryWaiting ? 'WAITING' : 'ON') : 'OFF'}
                                        </span>
                                    </div>
                                    
                                    <div className='auto-trades-strategy-selector'>
                                        <select className='auto-trades-strategy-selector__select l-digit-select' value={lDigitStrategy.enabled ? lDigitStrategy.patternType : 'disabled'} onChange={e => {
                                            const value = e.target.value;
                                            if (value === 'disabled') setLDigitStrategy({ enabled: false, patternType: 'odd_to_even', lookbackTicks: 5 });
                                            else if (value === 'odd_to_even') setLDigitStrategy({ enabled: true, patternType: 'odd_to_even', lookbackTicks: 5 });
                                            else if (value === 'even_to_odd') setLDigitStrategy({ enabled: true, patternType: 'even_to_odd', lookbackTicks: 5 });
                                            else if (value === 'over_to_under') setLDigitStrategy({ enabled: true, patternType: 'over_to_under', lookbackTicks: 5, thresholdDigit: 4 });
                                            else if (value === 'under_to_over') setLDigitStrategy({ enabled: true, patternType: 'under_to_over', lookbackTicks: 5, thresholdDigit: 4 });
                                            else if (value === 'match_to_diff') setLDigitStrategy({ enabled: true, patternType: 'match_to_diff', lookbackTicks: 5, barrierDigit: 4 });
                                            else if (value === 'diff_to_match') setLDigitStrategy({ enabled: true, patternType: 'diff_to_match', lookbackTicks: 5, barrierDigit: 4 });
                                            else if (value === 'rise_to_fall') setLDigitStrategy({ enabled: true, patternType: 'rise_to_fall', lookbackTicks: 5 });
                                            else if (value === 'fall_to_rise') setLDigitStrategy({ enabled: true, patternType: 'fall_to_rise', lookbackTicks: 5 });
                                        }} disabled={isRunning}>
                                            <option value='disabled'>⚫ Disabled</option>
                                            <option value='odd_to_even'>🔴 Odd → Even</option>
                                            <option value='even_to_odd'>🟢 Even → Odd</option>
                                            <option value='over_to_under'>📉 Over → Under</option>
                                            <option value='under_to_over'>📈 Under → Over</option>
                                            <option value='match_to_diff'>🎯 Match → Differs</option>
                                            <option value='diff_to_match'>🎯 Differs → Match</option>
                                            <option value='rise_to_fall'>⬆️ Rise → Fall</option>
                                            <option value='fall_to_rise'>⬇️ Fall → Rise</option>
                                        </select>
                                    </div>
                                    
                                    {lDigitStrategy.enabled && (
                                        <div className='auto-trades-l-digit-section__config'>
                                            <div className='auto-trades-l-digit-section__field'>
                                                <label className='auto-trades-l-digit-section__label'>Lookback Ticks</label>
                                                <div className='auto-trades-l-digit-section__lookback'>
                                                    <input className='auto-trades-l-digit-section__range' type='range' min='1' max='20' step='1' value={lDigitStrategy.lookbackTicks} onChange={e => setLDigitStrategy(prev => ({ ...prev, lookbackTicks: parseInt(e.target.value) }))} disabled={isRunning} style={{ width: '100%', height: '6px', borderRadius: '3px', background: `linear-gradient(to right, #2a7de1 0%, #2a7de1 ${(lDigitStrategy.lookbackTicks / 20) * 100}%, #e0e0e0 ${(lDigitStrategy.lookbackTicks / 20) * 100}%, #e0e0e0 100%)`, outline: 'none', transition: 'background 0.2s ease', cursor: isRunning ? 'not-allowed' : 'pointer' }} />
                                                    <div className='auto-trades-l-digit-section__lookback-value' style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
                                                        <span style={{ fontSize: '1.4rem', fontWeight: '700', color: '#ffffff', backgroundColor: '#1a1a1a', padding: '2px 14px', borderRadius: '6px', border: '2px solid #2a7de1', minWidth: '36px', textAlign: 'center', display: 'inline-block', boxShadow: '0 2px 4px rgba(0,0,0,0.3)' }}>{lDigitStrategy.lookbackTicks}</span>
                                                        <span style={{ fontSize: '0.8rem', color: '#888', fontWeight: '500' }}>ticks</span>
                                                    </div>
                                                </div>
                                            </div>
                                            
                                            {(lDigitStrategy.patternType === 'over_to_under' || lDigitStrategy.patternType === 'under_to_over') && (
                                                <div className='auto-trades-l-digit-section__field'>
                                                    <label className='auto-trades-l-digit-section__label'>Threshold Digit</label>
                                                    <select className='auto-trades-config__select' value={lDigitStrategy.thresholdDigit} onChange={e => setLDigitStrategy(prev => ({ ...prev, thresholdDigit: parseInt(e.target.value) }))} disabled={isRunning} style={{ padding: '8px 12px', borderRadius: '6px', border: '2px solid #2a7de1', fontSize: '1rem', fontWeight: '500', width: '100%', backgroundColor: '#1a1a1a', color: '#ffffff', cursor: isRunning ? 'not-allowed' : 'pointer', boxShadow: '0 2px 4px rgba(0,0,0,0.3)', transition: 'all 0.2s ease', outline: 'none', appearance: 'auto' }}>
                                                        {[0,1,2,3,4,5,6,7,8,9].map(d => <option key={d} value={d} style={{ padding: '6px', backgroundColor: d === 4 ? '#2a7de1' : '#1a1a1a', color: '#ffffff', fontWeight: d === 4 ? 'bold' : 'normal' }}>{d}</option>)}
                                                    </select>
                                                </div>
                                            )}
                                            
                                            {(lDigitStrategy.patternType === 'match_to_diff' || lDigitStrategy.patternType === 'diff_to_match') && (
                                                <div className='auto-trades-l-digit-section__field'>
                                                    <label className='auto-trades-l-digit-section__label'>Barrier Digit</label>
                                                    <select className='auto-trades-config__select' value={lDigitStrategy.barrierDigit} onChange={e => setLDigitStrategy(prev => ({ ...prev, barrierDigit: parseInt(e.target.value) }))} disabled={isRunning} style={{ padding: '8px 12px', borderRadius: '6px', border: '2px solid #2a7de1', fontSize: '1rem', fontWeight: '500', width: '100%', backgroundColor: '#1a1a1a', color: '#ffffff', cursor: isRunning ? 'not-allowed' : 'pointer', boxShadow: '0 2px 4px rgba(0,0,0,0.3)', transition: 'all 0.2s ease', outline: 'none', appearance: 'auto' }}>
                                                        {[0,1,2,3,4,5,6,7,8,9].map(d => <option key={d} value={d} style={{ padding: '6px', backgroundColor: d === 4 ? '#2a7de1' : '#1a1a1a', color: '#ffffff', fontWeight: d === 4 ? 'bold' : 'normal' }}>{d}</option>)}
                                                    </select>
                                                </div>
                                            )}
                                            
                                            <p className='auto-trades-l-digit-section__hint' style={{ fontSize: '0.8rem', marginTop: '10px', padding: '10px', background: '#1a1a1a', borderRadius: '6px', borderLeft: '3px solid #2a7de1', lineHeight: '1.5', color: '#e0e0e0' }}>
                                                🔄 <strong style={{ color: '#ffffff' }}>Recovery Market</strong> activates after MAIN loss<br />
                                                ⏳ <strong style={{ color: '#ffffff' }}>NO TRADING</strong> while waiting for pattern<br />
                                                ✅ Returns to MAIN after recovery win
                                            </p>
                                        </div>
                                    )}
                                </div>

                                {/* Percentage Mode */}
                                {strategyMode === 'PERCENTAGE' && (
                                    <div className='auto-trades-config__group percentage-mode-config'>
                                        <div className='auto-trades-config__field'>
                                            <label>Trade Type</label>
                                            <select className='auto-trades-config__select' value={tradeType} onChange={e => setTradeType(e.target.value as TradeType)} disabled={isRunning}>
                                                <option value='DIGITOVER'>Digit Over</option>
                                                <option value='DIGITUNDER'>Digit Under</option>
                                                <option value='DIGITEVEN'>Digit Even/Odd</option>
                                                <option value='DIGITMATCH'>Digit Match/Differs</option>
                                                <option value='CALL'>Rise/Fall</option>
                                                <option value='RUNHIGH'>Higher/Lower</option>
                                            </select>
                                        </div>
                                        <div className='auto-trades-config__field'>
                                            <label>Confidence Threshold: 80%</label>
                                            <input type='range' className='auto-trades-config__slider' min='50' max='95' step='1' value={80} onChange={() => {}} disabled={isRunning} />
                                        </div>
                                    </div>
                                )}

                                {/* Money Settings */}
                                <div className='auto-trades-config'>
                                    <div className='auto-trades-config__field'>
                                        <label>Stake ({currency || 'USD'})</label>
                                        <Input type='number' min='0.35' step='0.01' value={stake} onChange={e => setStake(e.target.value)} disabled={isRunning} />
                                    </div>
                                    <div className='auto-trades-config__field'>
                                        <label>Martingale ×</label>
                                        <Input type='number' min='1.01' step='0.5' value={martingale} onChange={e => setMartingale(e.target.value)} disabled={isRunning} />
                                    </div>
                                    <div className='auto-trades-config__field'>
                                        <label>Take Profit ({currency || 'USD'})</label>
                                        <Input type='number' min='0' step='1' value={takeProfit} onChange={e => setTakeProfit(e.target.value)} disabled={isRunning} />
                                    </div>
                                    <div className='auto-trades-config__field'>
                                        <label>Stop Loss ({currency || 'USD'})</label>
                                        <Input type='number' min='0' step='1' value={stopLoss} onChange={e => setStopLoss(e.target.value)} disabled={isRunning} />
                                    </div>
                                </div>

                                {/* Martingale Strategy */}
                                <div className='auto-trades-config__group'>
                                    <div className='auto-trades-martingale-selector'>
                                        <label>Martingale Strategy</label>
                                        <select className='auto-trades-martingale-selector__select' value={martingaleMode} onChange={e => setMartingaleMode(normalizeMartingaleMode(e.target.value))} disabled={isRunning}>
                                            <option value='no_martingale'>No Martingale</option>
                                            <option value='after_one_loss'>After 1 loss</option>
                                            <option value='after_two_losses'>After 2 losses</option>
                                            <option value='custom_consecutive_loss_trigger'>Custom loss count</option>
                                        </select>
                                    </div>
                                    <p className='auto-trades-martingale__hint'>
                                        {martingaleMode === 'no_martingale' ? 'Martingale is disabled. Stake stays at the base amount.' :
                                         martingaleMode === 'after_one_loss' ? 'Martingale engages immediately after one loss.' :
                                         martingaleMode === 'after_two_losses' ? 'Martingale engages only after two consecutive losses.' :
                                         `Martingale engages after ${clampConsecutiveLossThreshold(consecutiveLossCount)} consecutive losses.`}
                                    </p>
                                    {martingaleMode === 'custom_consecutive_loss_trigger' && (
                                        <div className='auto-trades-config__field auto-trades-config__field--martingale-threshold' style={{ marginTop: '0.5rem' }}>
                                            <label>Consecutive losses before martingale</label>
                                            <Input type='number' min='1' max='10' step='1' value={consecutiveLossCountInput} inputMode='numeric' onChange={e => handleConsecutiveLossCountInputChange((e.target as HTMLInputElement).value)} onBlur={commitConsecutiveLossCountInput} disabled={isRunning} />
                                        </div>
                                    )}
                                </div>

                                {/* Controls */}
                                <div className='auto-trades-controls'>
                                    {!isRunning ? (
                                        <button className='auto-trades-controls__run' onClick={handleRun} disabled={!client.is_logged_in || selectedMarketSymbols.length === 0}>▶ Start Trading</button>
                                    ) : (
                                        <button className='auto-trades-controls__stop' onClick={handleStop}>■ Stop Trading</button>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Markets Grid */}
                        <div className='auto-trades-markets'>
                            <h2 className='auto-trades-markets__title'>
                                Live Markets
                                <span className='auto-trades-markets__selected-count'>{selectedMarketSymbols.length}/{AUTO_MARKETS.length} selected</span>
                                {isConnected && <span className='auto-trades-markets__live-badge'>● LIVE</span>}
                                {isAnyRecoveryWaiting && isRunning && <span className='auto-trades-markets__waiting-badge'>⏳ WAITING FOR RECOVERY</span>}
                                {isAnyRecoveryActive && isRunning && <span className='auto-trades-markets__recovery-badge'>🔴 RECOVERY ACTIVE</span>}
                                {inCooldown && isRunning && <span className='auto-trades-markets__cooldown-badge'>⏳ {cooldownDisplay}t cooldown</span>}
                            </h2>
                            {!isRunning && (
                                <div className='auto-trades-markets__actions'>
                                    <button type='button' onClick={handleSelectAllMarkets}>Select all</button>
                                    <button type='button' onClick={handleClearMarkets}>Clear</button>
                                </div>
                            )}
                            {selectedMarketSymbols.length === 0 && (
                                <div className='auto-trades-hint'>
                                    {usingSpecialStrategy ? 'Background scanning is live across all supported volatility markets. Load one alert market to enable Start Trading.' : 'Select at least one market to show live quotes and enable Auto Trades.'}
                                </div>
                            )}
                            <div className='auto-trades-markets__grid'>
                                {marketDisplays.map((m, index) => {
                                    const isMain = m.mode === 'MAIN';
                                    const isRecovery = m.mode === 'RECOVERY';
                                    const isActive = activeMarketRef.current[m.symbol] === m.mode;
                                    const isWaiting = isRecovery && m.recoveryWaitingForPattern;
                                    const isMarketLoading = m.lastQuote === null;
                                    const marketInCooldown = m.cooldownLeft > 0;
                                    const dots = Math.min(m.consecutive, streakNum);
                                    const candleReady = !isCandleConfirmedTradeType(m.tradeType) ||
                                        (inverseModeRef.current ? isInverseCandleMatch(m.tradeType, m.candleDirection) : isCandleMatch(m.tradeType, m.candleDirection));
                                    const isReady = !isWaiting &&
                                        (((usingSpecialStrategy ? m.specialEntryReady : m.consecutive >= streakNum) && candleReady) || m.trading) &&
                                        !marketInCooldown && isActive;
                                    const marketBadge = isMain ? 'M1' : 'R1';
                                    const isRecoveryActive = isRecovery && m.isRecoveryActive;

                                    return (
                                        <div key={`${m.symbol}-${m.mode}`} className={classNames('auto-trades-market', {
                                            'auto-trades-market--main': isMain,
                                            'auto-trades-market--recovery': isRecovery,
                                            'auto-trades-market--active': isActive,
                                            'auto-trades-market--inactive': !isActive,
                                            'auto-trades-market--ready': isReady && !m.trading && isRunning,
                                            'auto-trades-market--trading': m.trading,
                                            'auto-trades-market--win': m.lastResult === 'win' && !m.trading,
                                            'auto-trades-market--loss': m.lastResult === 'loss' && !m.trading,
                                            'auto-trades-market--cooldown': marketInCooldown && isRunning,
                                            'auto-trades-market--loading': isMarketLoading,
                                            'auto-trades-market--waiting': isWaiting,
                                            'auto-trades-market--recovery-active': isRecoveryActive,
                                        })} style={{ borderColor: isActive ? (isMain ? '#2a7de1' : '#ff6b6b') : '#333', borderWidth: isActive ? '2px' : '1px', opacity: isActive ? 1 : 0.6 }}>
                                            {isMarketLoading && (
                                                <div className='auto-trades-market__loading'>
                                                    <span className='auto-trades-data-loader__spinner' />
                                                    <span>Loading</span>
                                                </div>
                                            )}
                                            <div className='auto-trades-market__top'>
                                                <div>
                                                    <p className='auto-trades-market__name'>
                                                        {m.label}
                                                        <span className='auto-trades-market__market-badge' style={{ fontSize: '0.6rem', fontWeight: '700', padding: '2px 8px', borderRadius: '4px', marginLeft: '6px', backgroundColor: isMain ? '#2a7de1' : '#ff6b6b', color: '#fff' }}>{marketBadge}</span>
                                                    </p>
                                                    <p className='auto-trades-market__symbol'>{m.symbol}</p>
                                                </div>
                                                <div className='auto-trades-market__controls'>
                                                    {!isRunning && (
                                                        <button className='auto-trades-market__btn auto-trades-market__btn--remove' onClick={() => handleRemoveMarket(m.symbol)} title='Remove from Auto Trades' type='button'>−</button>
                                                    )}
                                                    {isWaiting && isRunning ? (
                                                        <div className='auto-trades-market__badge auto-trades-market__badge--waiting'>⏳WAIT</div>
                                                    ) : marketInCooldown && isRunning ? (
                                                        <div className='auto-trades-market__badge auto-trades-market__badge--cooldown'>⏳{m.cooldownLeft}</div>
                                                    ) : (
                                                        <div className={classNames('auto-trades-market__badge', {
                                                            'auto-trades-market__badge--ready': isReady && isRunning,
                                                            'auto-trades-market__badge--trading': m.trading,
                                                            'auto-trades-market__badge--recovery': isRecoveryActive,
                                                            'auto-trades-market__badge--inactive': !isActive,
                                                        })} style={{ backgroundColor: !isActive ? '#555' : undefined }}>
                                                            {m.trading ? 'BUYING' : isRecoveryActive ? 'REC' : isReady && isRunning ? 'READY' : m.consecutive > 0 ? `${m.consecutive}` : isActive ? '—' : '⏸'}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>

                                            {m.lastQuote !== null && (
                                                <div className='auto-trades-market__quote'>
                                                    {m.lastQuote.toFixed(getMarketPipSize(m.symbol, AUTO_MARKET_LOOKUP.get(m.symbol)?.pip ?? 2))}
                                                </div>
                                            )}

                                            <div className='auto-trades-market__status'>
                                                {isActive ? <span style={{ color: isMain ? '#2a7de1' : '#ff6b6b', fontWeight: 'bold' }}>● ACTIVE {isMain ? 'MAIN' : 'RECOVERY'}</span> :
                                                <span style={{ color: '#888' }}>○ INACTIVE</span>}
                                                {isRecovery && m.recoveryWaitingForPattern && <span style={{ color: '#ff6b6b', marginLeft: '8px' }}>⏳ Waiting for pattern</span>}
                                                {isRecoveryActive && <span style={{ color: '#ff6b6b', marginLeft: '8px' }}>🔴 Pattern active</span>}
                                            </div>

                                            {isWaiting && (
                                                <div className='auto-trades-market__waiting-status'>
                                                    ⏳ Waiting for pattern: {lDigitStrategy.patternType}
                                                    <br />
                                                    <small>
                                                        Current: [{m.lastDigits.slice(-lDigitStrategy.lookbackTicks).join(', ')}]
                                                        {m.lastDigits.length >= lDigitStrategy.lookbackTicks && ` → ${evaluateRecoveryPattern(lDigitStrategy, m.lastDigits, m.directionHistory) ? '✅ MATCHED!' : '❌ Not yet'}`}
                                                    </small>
                                                </div>
                                            )}

                                            {usingSpecialStrategy && (
                                                <div className='auto-trades-market__confidence'>
                                                    {m.alertActive ? `${m.alertMessage} Trigger streak ${m.trailingTriggerCount}/3.` : m.alertMessage || 'Waiting for percentage alert.'}
                                                </div>
                                            )}

                                            {isCandleConfirmedTradeType(m.tradeType) && (
                                                <div className={classNames('auto-trades-market__candle', {
                                                    'auto-trades-market__candle--bullish': m.candleDirection === 1,
                                                    'auto-trades-market__candle--bearish': m.candleDirection === -1,
                                                    'auto-trades-market__candle--waiting': m.candleDirection === 0,
                                                })}>
                                                    5m candle: {getCandleDirectionLabel(m.candleDirection)}
                                                </div>
                                            )}

                                            {isRunning && !inCooldown && !isWaiting && isActive && (
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

                                            {!IS_DIRECTION_TYPE[m.tradeType] && m.lastDigits.length > 0 && (
                                                <div className='auto-trades-market__digits'>
                                                    {m.lastDigits.slice(-5).map((d, idx) => (
                                                        <span key={idx} className={classNames('auto-trades-market__digit', {
                                                            'auto-trades-market__digit--low': d <= 4,
                                                            'auto-trades-market__digit--high': d > 4,
                                                        })}>{d}</span>
                                                    ))}
                                                </div>
                                            )}

                                            {IS_DIRECTION_TYPE[m.tradeType] && m.directionHistory.length > 0 && (
                                                <div className='auto-trades-market__digits'>
                                                    {m.directionHistory.slice(-5).map((dir, idx) => (
                                                        <span key={idx} className={classNames('auto-trades-market__digit', {
                                                            'auto-trades-market__digit--low': dir === 1,
                                                            'auto-trades-market__digit--high': dir === -1,
                                                        })}>{dir === 1 ? '▲' : dir === -1 ? '▼' : '—'}</span>
                                                    ))}
                                                </div>
                                            )}

                                            {strategyMode === 'PERCENTAGE' && (
                                                <div className='auto-trades-market__percentages'>
                                                    {(() => {
                                                        const snapshot = getPercentageSnapshot(m.tradeType, m, getActiveDigitBarrier(m.tradeType, previousContractResultRef.current, consecutiveLossRef.current));
                                                        const threshold = getPercentageThreshold(m.tradeType, getActiveDigitBarrier(m.tradeType, previousContractResultRef.current, consecutiveLossRef.current));
                                                        const hasEnoughSamples = snapshot.sampleSize >= PERCENTAGE_MIN_SAMPLE_SIZE;
                                                        const rollingWindowLabel = m.percentageBackfillInFlight && snapshot.sampleSize === 0 ? 'Loading 1,000 tick window' : `Window ${Math.min(snapshot.sampleSize, PERCENTAGE_ANALYSIS_HISTORY_SIZE)}/${PERCENTAGE_ANALYSIS_HISTORY_SIZE} ticks`;
                                                        return (
                                                            <>
                                                                <div className='auto-trades-market__percentage-row'>
                                                                    <span>{snapshot.primaryLabel}: {snapshot.primaryPercentage.toFixed(1)}%</span>
                                                                    {snapshot.secondaryLabel && <span>{snapshot.secondaryLabel}: {snapshot.secondaryPercentage?.toFixed(1)}%</span>}
                                                                </div>
                                                                <div className='auto-trades-market__confidence'>
                                                                    {hasEnoughSamples ? `Signal needs ${threshold.minPercentage}% / confidence ${threshold.confidence}%` : `Collecting ${snapshot.sampleSize}/${PERCENTAGE_MIN_SAMPLE_SIZE} samples`}
                                                                    {' · '}{rollingWindowLabel}{' · '}Confidence: {snapshot.confidence.toFixed(0)}%
                                                                </div>
                                                            </>
                                                        );
                                                    })()}
                                                    {!IS_DIRECTION_TYPE[m.tradeType] && Object.keys(m.digitPercentages).length > 0 && (
                                                        <div className='auto-trades-market__digit-bars'>
                                                            {[...Array(10)].map((_, d) => {
                                                                const pct = m.digitPercentages[d] || 0;
                                                                const isHot = pct > 15;
                                                                const isCold = pct < 5;
                                                                return (
                                                                    <div key={d} className='auto-trades-market__digit-bar-wrapper'>
                                                                        <span className={classNames('auto-trades-market__digit-num', { 'auto-trades-market__digit-num--hot': isHot, 'auto-trades-market__digit-num--cold': isCold })}>{d}</span>
                                                                        <div className='auto-trades-market__digit-bar-bg'>
                                                                            <div className={classNames('auto-trades-market__digit-bar-fill', { 'auto-trades-market__digit-bar-fill--hot': isHot, 'auto-trades-market__digit-bar-fill--cold': isCold })} style={{ width: `${pct}%` }} />
                                                                        </div>
                                                                        <span className='auto-trades-market__digit-pct'>{pct.toFixed(0)}%</span>
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    )}
                                                </div>
                                            )}

                                            {m.tradeCount > 0 && (
                                                <div className='auto-trades-market__footer'>
                                                    <span>{m.tradeCount} trade{m.tradeCount !== 1 ? 's' : ''}</span>
                                                    <span className={classNames({ 'auto-trades-market__last-win': m.lastResult === 'win', 'auto-trades-market__last-loss': m.lastResult === 'loss' })}>
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
                                    <h3 className='auto-trades-markets__subtitle'>Available markets to add</h3>
                                    <p className='auto-trades-markets__help'>Removed markets stay here with a plus button until you add them back.</p>
                                    <div className='auto-trades-markets__grid auto-trades-markets__grid--available'>
                                        {availableMarkets.map(market => (
                                            <button key={market.symbol} className='auto-trades-market-add' onClick={() => handleAddMarket(market.symbol)} type='button' title={`Add ${market.label} to Auto Trades`}>
                                                <span className='auto-trades-market-add__plus'>+</span>
                                                <div className='auto-trades-market-add__info'>
                                                    <p className='auto-trades-market-add__name'>{market.label}</p>
                                                    <p className='auto-trades-market-add__symbol'>{market.symbol}</p>
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

            <button className='auto-trades-disclaimer-btn' onClick={() => setShowDisclaimer(true)}>⚠ Risk Disclaimer</button>
            {showDisclaimer && (
                <div className='auto-trades-disclaimer-overlay' onClick={() => setShowDisclaimer(false)}>
                    <div className='auto-trades-disclaimer-modal' onClick={e => e.stopPropagation()}>
                        <div className='auto-trades-disclaimer-modal__header'>
                            <span className='auto-trades-disclaimer-modal__icon'>⚠</span>
                            <h3 className='auto-trades-disclaimer-modal__title'>Risk Disclaimer</h3>
                            <button className='auto-trades-disclaimer-modal__close' onClick={() => setShowDisclaimer(false)}>✕</button>
                        </div>
                        <div className='auto-trades-disclaimer-modal__body'>
                            <p>Deriv offers complex derivatives, such as options and contracts for difference (&ldquo;CFDs&rdquo;). These products may not be suitable for all clients, and trading them puts you at risk. Please make sure that you understand the following risks before trading Deriv products:</p>
                            <ul>
                                <li>You may lose some or all of the money you invest in the trade.</li>
                                <li>If your trade involves currency conversion, exchange rates will affect your profit and loss.</li>
                                <li>You should never trade with borrowed money or with money you cannot afford to lose.</li>
                            </ul>
                        </div>
                        <div className='auto-trades-disclaimer-modal__footer'>
                            <button className='auto-trades-disclaimer-modal__ok' onClick={() => setShowDisclaimer(false)}>I Understand</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
});

export default AutoTrades;
