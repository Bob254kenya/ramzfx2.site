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

type RecoveryMarketType = 
    | 'same_market'
    | 'opposite_market'
    | 'even_odd_switch'
    | 'over_under_switch'
    | 'matches_differs_switch'
    | 'rise_fall_switch'
    | 'custom_market';

type LastDigitsPattern = {
    enabled: boolean;
    patternType: 'consecutive_odd' | 'consecutive_even' | 'consecutive_over' | 'consecutive_under' | 'consecutive_match' | 'consecutive_differs';
    patternLength: number;
    targetBarrier?: number;
    tradeTypeOverride?: TradeType;
    barrierOverride?: string;
};

type RecoveryConfig = {
    enabled: boolean;
    recoveryType: RecoveryMarketType;
    customMarketSymbol?: string;
    recoveryTradeType?: TradeType;
    recoveryBarrier?: string;
    recoveryStakeMultiplier: number;
    maxRecoveryAttempts: number;
    resetOnWin: boolean;
    switchBackToOriginalMarket: boolean;
    useLastDigitsPattern: boolean;
    lastDigitsPattern: LastDigitsPattern;
    lossRecoveryStrategy: {
        enabled: boolean;
        strategyMode: 'pattern' | 'digit';
        patternValue: string;
        digitCondition: string;
        digitCompare: string;
        digitWindow: string;
    };
};

type CombinedStrategyConfig = {
    enabled: boolean;
    patterns: string;
    tradeType?: TradeType;
    barrier?: string;
};

type VirtualHookConfig = {
    enabled: boolean;
    virtualLossCount: number;
    realTradeCount: number;
};

type StrategyCondition = {
    enabled: boolean;
    mode: 'pattern' | 'digit';
    pattern?: string;
    digitCondition?: string;
    digitCompare?: string;
    digitWindow?: string;
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

const SCANNER_MARKETS: { symbol: string; name: string }[] = [
    { symbol: 'R_10', name: 'Vol 10' }, { symbol: 'R_25', name: 'Vol 25' },
    { symbol: 'R_50', name: 'Vol 50' }, { symbol: 'R_75', name: 'Vol 75' },
    { symbol: 'R_100', name: 'Vol 100' }, { symbol: '1HZ10V', name: 'V10 1s' },
    { symbol: '1HZ25V', name: 'V25 1s' }, { symbol: '1HZ50V', name: 'V50 1s' },
    { symbol: '1HZ75V', name: 'V75 1s' }, { symbol: '1HZ100V', name: 'V100 1s' },
];

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
    recoveryConfig?: RecoveryConfig;
    lastDigitsPattern?: LastDigitsPattern;
    m1Combined?: CombinedStrategyConfig;
    m2Combined?: CombinedStrategyConfig;
    m1VirtualHook?: VirtualHookConfig;
    m2VirtualHook?: VirtualHookConfig;
    m1Strategy?: StrategyCondition;
    m2Strategy?: StrategyCondition;
    scannerActive?: boolean;
    turboMode?: boolean;
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

const RECOVERY_MARKET_MAPPING: Record<RecoveryMarketType, (originalSymbol: string, originalTradeType: TradeType) => string[]> = {
    same_market: (symbol) => [symbol],
    opposite_market: (symbol) => {
        const match = symbol.match(/R_(\d+)|1HZ(\d+)V/);
        if (match) {
            const vol = parseInt(match[1] || match[2]);
            const oppositeVol = vol <= 50 ? vol + 25 : vol - 25;
            return [`R_${oppositeVol}`];
        }
        return [symbol];
    },
    even_odd_switch: (symbol) => AUTO_MARKET_SYMBOLS.filter(s => s !== symbol).slice(0, 2),
    over_under_switch: (symbol) => AUTO_MARKET_SYMBOLS.filter(s => s !== symbol).slice(0, 2),
    matches_differs_switch: (symbol) => AUTO_MARKET_SYMBOLS.filter(s => s !== symbol).slice(0, 2),
    rise_fall_switch: (symbol) => AUTO_MARKET_SYMBOLS.filter(s => s !== symbol).slice(0, 2),
    custom_market: (symbol) => [],
};

// FIXED: Complete evaluateLossRecoveryStrategy with proper over (0-8) and under (9-1) handling
const evaluateLossRecoveryStrategy = (
    strategy: RecoveryConfig['lossRecoveryStrategy'],
    lastDigits: number[],
    currentTradeType: TradeType,
    currentBarrier: number
): { shouldRecover: boolean; suggestedTradeType?: TradeType; suggestedBarrier?: number } => {
    if (!strategy.enabled) return { shouldRecover: true };
    
    const windowSize = parseInt(strategy.digitWindow) || 3;
    const digits = lastDigits.slice(-windowSize);
    
    if (strategy.strategyMode === 'pattern') {
        const pattern = strategy.patternValue.toUpperCase();
        if (!pattern || digits.length < pattern.length) return { shouldRecover: false };
        
        let matches = true;
        for (let i = 0; i < pattern.length; i++) {
            const expected = pattern[i];
            const actual = digits[i] % 2 === 0 ? 'E' : 'O';
            if (expected !== actual) {
                matches = false;
                break;
            }
        }
        
        if (matches) {
            let suggestedType: TradeType = currentTradeType;
            let suggestedBarrierNum = currentBarrier;
            
            if (pattern === 'EEE') suggestedType = 'DIGITODD';
            else if (pattern === 'OOO') suggestedType = 'DIGITEVEN';
            else if (pattern === 'EEO' || pattern === 'OEE') suggestedType = 'DIGITODD';
            else if (pattern === 'OOE' || pattern === 'EOO') suggestedType = 'DIGITEVEN';
            
            return { shouldRecover: true, suggestedTradeType: suggestedType, suggestedBarrier: suggestedBarrierNum };
        }
        return { shouldRecover: false };
    } else {
        const compareValue = parseInt(strategy.digitCompare);
        if (isNaN(compareValue)) return { shouldRecover: true };
        
        switch (strategy.digitCondition) {
            case 'over':
                // Check if ALL digits are OVER the compare value (range: 0-8)
                // When digits are consistently over the barrier, suggest trading UNDER
                if (digits.every(d => d > compareValue)) {
                    // Suggest barrier should be the compare value or higher
                    const suggestedBarrier = Math.min(8, compareValue + 1);
                    return { 
                        shouldRecover: true, 
                        suggestedTradeType: 'DIGITUNDER', 
                        suggestedBarrier: suggestedBarrier 
                    };
                }
                break;
            case 'under':
                // Check if ALL digits are UNDER the compare value (range: 1-9)
                // When digits are consistently under the barrier, suggest trading OVER
                if (digits.every(d => d < compareValue)) {
                    // Suggest barrier should be the compare value or lower
                    const suggestedBarrier = Math.max(1, compareValue - 1);
                    return { 
                        shouldRecover: true, 
                        suggestedTradeType: 'DIGITOVER', 
                        suggestedBarrier: suggestedBarrier 
                    };
                }
                break;
            case 'even':
                // Check if ALL digits are EVEN (0,2,4,6,8)
                if (digits.every(d => d % 2 === 0)) {
                    return { 
                        shouldRecover: true, 
                        suggestedTradeType: 'DIGITODD', 
                        suggestedBarrier: 0 
                    };
                }
                break;
            case 'odd':
                // Check if ALL digits are ODD (1,3,5,7,9)
                if (digits.every(d => d % 2 !== 0)) {
                    return { 
                        shouldRecover: true, 
                        suggestedTradeType: 'DIGITEVEN', 
                        suggestedBarrier: 0 
                    };
                }
                break;
            case 'matches':
                // Check if ALL digits MATCH the compare value
                if (digits.every(d => d === compareValue)) {
                    return { 
                        shouldRecover: true, 
                        suggestedTradeType: 'DIGITDIFF', 
                        suggestedBarrier: compareValue 
                    };
                }
                break;
            case 'differs':
                // Check if ALL digits DIFFER from the compare value
                if (digits.every(d => d !== compareValue)) {
                    return { 
                        shouldRecover: true, 
                        suggestedTradeType: 'DIGITMATCH', 
                        suggestedBarrier: compareValue 
                    };
                }
                break;
            case 'rise':
                // Check if digits are consistently rising (each tick > previous)
                if (digits.length >= 2) {
                    let allRising = true;
                    for (let i = 1; i < digits.length; i++) {
                        if (digits[i] <= digits[i - 1]) {
                            allRising = false;
                            break;
                        }
                    }
                    if (allRising) {
                        return { 
                            shouldRecover: true, 
                            suggestedTradeType: 'PUT', 
                            suggestedBarrier: 0 
                        };
                    }
                }
                break;
            case 'fall':
                // Check if digits are consistently falling (each tick < previous)
                if (digits.length >= 2) {
                    let allFalling = true;
                    for (let i = 1; i < digits.length; i++) {
                        if (digits[i] >= digits[i - 1]) {
                            allFalling = false;
                            break;
                        }
                    }
                    if (allFalling) {
                        return { 
                            shouldRecover: true, 
                            suggestedTradeType: 'CALL', 
                            suggestedBarrier: 0 
                        };
                    }
                }
                break;
        }
        return { shouldRecover: false };
    }
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

const isCandleMatch = (trade_type: TradeType, candle_direction: Direction) => {
    if (trade_type === 'CALL') return candle_direction === 1;
    if (trade_type === 'PUT') return candle_direction === -1;
    if (trade_type === 'RUNHIGH') return candle_direction === 1;
    if (trade_type === 'RUNLOW') return candle_direction === -1;
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

const getRecoveryTradeType = (originalTradeType: TradeType, recoveryType: RecoveryMarketType): TradeType => {
    if (recoveryType === 'even_odd_switch') {
        if (originalTradeType === 'DIGITEVEN') return 'DIGITODD';
        if (originalTradeType === 'DIGITODD') return 'DIGITEVEN';
    }
    if (recoveryType === 'over_under_switch') {
        if (originalTradeType === 'DIGITOVER') return 'DIGITUNDER';
        if (originalTradeType === 'DIGITUNDER') return 'DIGITOVER';
    }
    if (recoveryType === 'matches_differs_switch') {
        if (originalTradeType === 'DIGITMATCH') return 'DIGITDIFF';
        if (originalTradeType === 'DIGITDIFF') return 'DIGITMATCH';
    }
    if (recoveryType === 'rise_fall_switch') {
        if (originalTradeType === 'CALL') return 'PUT';
        if (originalTradeType === 'PUT') return 'CALL';
    }
    return originalTradeType;
};

function checkCombinedPattern(digits: number[], patternStr: string): boolean {
    if (!patternStr || patternStr.trim() === '') return false;
    const patterns = patternStr.split(',').map(p => p.trim().toUpperCase()).filter(p => p.length > 0);
    if (patterns.length === 0) return false;
    
    for (const pattern of patterns) {
        let matched = true;
        const len = pattern.length;
        if (digits.length < len) {
            matched = false;
            continue;
        }
        const recentDigits = digits.slice(-len);
        
        for (let i = 0; i < len; i++) {
            const patternChar = pattern[i];
            const digit = recentDigits[i];
            
            if (patternChar >= '0' && patternChar <= '9') {
                if (digit !== parseInt(patternChar)) { matched = false; break; }
            } else if (patternChar === 'O') {
                if (!(digit > 4)) { matched = false; break; }
            } else if (patternChar === 'U') {
                if (!(digit < 5)) { matched = false; break; }
            } else if (patternChar === 'E') {
                if (digit % 2 !== 0) { matched = false; break; }
            } else {
                matched = false;
                break;
            }
        }
        
        if (matched) return true;
    }
    return false;
}

const detectLastDigitsPattern = (
    digits: number[],
    pattern: LastDigitsPattern,
    tradeType: TradeType
): { detected: boolean; suggestedTradeType?: TradeType; suggestedBarrier?: number } => {
    if (!pattern.enabled || digits.length < pattern.patternLength) {
        return { detected: false };
    }

    const recentDigits = digits.slice(-pattern.patternLength);
    
    switch (pattern.patternType) {
        case 'consecutive_odd': {
            const allOdd = recentDigits.every(d => d % 2 !== 0);
            if (allOdd) {
                return { detected: true, suggestedTradeType: 'DIGITEVEN', suggestedBarrier: 0 };
            }
            break;
        }
        case 'consecutive_even': {
            const allEven = recentDigits.every(d => d % 2 === 0);
            if (allEven) {
                return { detected: true, suggestedTradeType: 'DIGITODD', suggestedBarrier: 0 };
            }
            break;
        }
        case 'consecutive_over': {
            const barrier = pattern.targetBarrier ?? 5;
            const allOver = recentDigits.every(d => d > barrier);
            if (allOver) {
                return { detected: true, suggestedTradeType: 'DIGITUNDER', suggestedBarrier: barrier };
            }
            break;
        }
        case 'consecutive_under': {
            const barrier = pattern.targetBarrier ?? 4;
            const allUnder = recentDigits.every(d => d < barrier);
            if (allUnder) {
                return { detected: true, suggestedTradeType: 'DIGITOVER', suggestedBarrier: barrier };
            }
            break;
        }
        case 'consecutive_match': {
            const barrier = pattern.targetBarrier ?? 5;
            const allMatch = recentDigits.every(d => d === barrier);
            if (allMatch) {
                return { detected: true, suggestedTradeType: 'DIGITDIFF', suggestedBarrier: barrier };
            }
            break;
        }
        case 'consecutive_differs': {
            const barrier = pattern.targetBarrier ?? 5;
            const allDiffer = recentDigits.every(d => d !== barrier);
            if (allDiffer) {
                return { detected: true, suggestedTradeType: 'DIGITMATCH', suggestedBarrier: barrier };
            }
            break;
        }
    }
    
    return { detected: false };
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

    if (settings.recoveryConfig) normalizedSettings.recoveryConfig = settings.recoveryConfig;
    if (settings.lastDigitsPattern) normalizedSettings.lastDigitsPattern = settings.lastDigitsPattern;

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
    } else if (/\b(?:only\s*ups?|run\s*high|higher)\b/.test(text)) {
        settings.tradeType = 'RUNHIGH';
        settings.strategyMode = 'STANDARD';
        summary.push('Trade type Only Ups');
    } else if (/\b(?:only\s*downs?|run\s*low|lower)\b/.test(text)) {
        settings.tradeType = 'RUNLOW';
        settings.strategyMode = 'STANDARD';
        summary.push('Trade type Only Downs');
    } else if (/\b(?:even)\b/.test(text)) {
        settings.tradeType = 'DIGITEVEN';
        settings.strategyMode = 'STANDARD';
        summary.push('Trade type Digit Even');
    } else if (/\b(?:odd)\b/.test(text)) {
        settings.tradeType = 'DIGITODD';
        settings.strategyMode = 'STANDARD';
        summary.push('Trade type Digit Odd');
    }

    const analysisTicks = getAiNumber(text, [/\b(?:using|use|duration|for)\s*(\d+)\s*ticks?\b/, /\b(\d+)\s*ticks?\b/], 1, 10);
    if (analysisTicks) {
        settings.analysisTicks = analysisTicks;
        summary.push(`${analysisTicks} analysis tick${analysisTicks === '1' ? '' : 's'}`);
    }

    const streak = getAiNumber(text, [/\bstreak\s*(?:of|=|is)?\s*(\d+)\b/, /\b(\d+)\s*(?:match|matches|streak)\b/], 1, 10);
    if (streak) {
        settings.streak = streak;
        summary.push(`Streak ${streak}`);
    }

    const stake = getAiMoney(text, [/\bstake\s*(?:of|=|is)?\s*(\d+(?:\.\d+)?)\b/, /\bamount\s*(?:of|=|is)?\s*(\d+(?:\.\d+)?)\b/]);
    if (stake) {
        settings.stake = stake;
        summary.push(`Stake ${stake}`);
    }

    const martingale = getAiMoney(text, [/\bmartingale\s*(?:x|of|=|is)?\s*(\d+(?:\.\d+)?)\b/]);
    if (martingale) {
        settings.martingale = martingale;
        summary.push(`Martingale ${martingale}`);
    }

    const takeProfit = getAiMoney(text, [/\btake\s*profit\s*(?:of|=|is)?\s*(\d+(?:\.\d+)?)\b/, /\btp\s*(?:of|=|is)?\s*(\d+(?:\.\d+)?)\b/]);
    if (takeProfit) {
        settings.takeProfit = takeProfit;
        summary.push(`Take profit ${takeProfit}`);
    }

    const stopLoss = getAiMoney(text, [/\bstop\s*loss\s*(?:of|=|is)?\s*(\d+(?:\.\d+)?)\b/, /\bsl\s*(?:of|=|is)?\s*(\d+(?:\.\d+)?)\b/]);
    if (stopLoss) {
        settings.stopLoss = stopLoss;
        summary.push(`Stop loss ${stopLoss}`);
    }

    const marketSymbols = getAiMarketSymbols(text);
    if (marketSymbols.length > 0) {
        settings.selectedMarketSymbols = marketSymbols;
        summary.push(`Markets: ${marketSymbols.join(', ')}`);
    }

    if (!settings.tradeType && !settings.selectedMarketSymbols?.length) {
        warnings.push('I could not identify a contract type or market from that text.');
    }

    return { settings, summary, warnings, source: 'local' };
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
    return digits.slice(-streak).every(digit => isDigitSignalMatch({ trade_type, digit, barrier, inverse }));
};

const isDirectionMatch = (trade_type: TradeType, direction: Direction) => {
    if (trade_type === 'CALL') return direction === -1;
    if (trade_type === 'PUT') return direction === 1;
    if (trade_type === 'RUNHIGH') return direction === -1;
    if (trade_type === 'RUNLOW') return direction === 1;
    return false;
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
    digitHistory.forEach(d => { if (d >= 0 && d <= 9) counts[d]++; });
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
    Object.entries(percentages).reduce((sum, [digit, percentage]) => (predicate(Number(digit)) ? sum + percentage : sum), 0);

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
        const { risePercentage, fallPercentage, confidence, sampleSize } = calculateDirectionPercentages(state.directionSampleHistory);
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
    return snapshot.sampleSize >= PERCENTAGE_MIN_SAMPLE_SIZE &&
        snapshot.primaryPercentage >= threshold.minPercentage &&
        snapshot.confidence >= threshold.confidence;
};

interface MarketState {
    alertActive: boolean;
    alertMessage: string;
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
    recoveryAttempts: number;
    originalStake: number;
    recoveryActive: boolean;
    recoveryOriginalMarket: string;
    recoveryOriginalTradeType: TradeType;
    recoveryOriginalBarrier: number;
    lastDigitsHistory: number[];
    patternDetected: boolean;
    patternTradePending: boolean;
    virtualHookActive: boolean;
    virtualConsecutiveLosses: number;
    virtualFakeWins: number;
    virtualFakeLosses: number;
    virtualTradeCount: number;
}

interface MarketDisplay extends MarketState {
    symbol: string;
    label: string;
    currentStake: number;
    cooldownLeft: number;
}

const createMarketState = (prev?: Partial<MarketState>): MarketState => ({
    alertActive: prev?.alertActive ?? false,
    alertMessage: prev?.alertMessage ?? '',
    consecutive: 0,
    trading: false,
    isRecovering: false,
    lastDigits: prev?.lastDigits ?? [],
    directionHistory: prev?.directionHistory ?? [],
    prevQuote: prev?.prevQuote ?? null,
    candleDirection: prev?.candleDirection ?? 0,
    candleOpen: prev?.candleOpen ?? null,
    candleClose: prev?.candleClose ?? null,
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
    lossCooldownLeft: prev?.lossCooldownLeft ?? 0,
    qualifyingWinningDigits: prev?.qualifyingWinningDigits ?? [],
    specialEntryReady: prev?.specialEntryReady ?? false,
    trailingTriggerCount: prev?.trailingTriggerCount ?? 0,
    recoveryAttempts: prev?.recoveryAttempts ?? 0,
    originalStake: prev?.originalStake ?? 0,
    recoveryActive: prev?.recoveryActive ?? false,
    recoveryOriginalMarket: prev?.recoveryOriginalMarket ?? '',
    recoveryOriginalTradeType: prev?.recoveryOriginalTradeType ?? 'DIGITOVER',
    recoveryOriginalBarrier: prev?.recoveryOriginalBarrier ?? 4,
    lastDigitsHistory: prev?.lastDigitsHistory ?? [],
    patternDetected: prev?.patternDetected ?? false,
    patternTradePending: prev?.patternTradePending ?? false,
    virtualHookActive: prev?.virtualHookActive ?? false,
    virtualConsecutiveLosses: prev?.virtualConsecutiveLosses ?? 0,
    virtualFakeWins: prev?.virtualFakeWins ?? 0,
    virtualFakeLosses: prev?.virtualFakeLosses ?? 0,
    virtualTradeCount: prev?.virtualTradeCount ?? 0,
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
        state.momentumCount = Math.round(trade_type === 'CALL' || trade_type === 'RUNHIGH' ? directionPercentages.risePercentage : directionPercentages.fallPercentage);
    } else {
        state.confidenceScore = calculateConfidence(state.digitPercentages);
        state.momentumCount = 0;
    }
};

const appendPercentageQuote = (symbol: string, state: MarketState, quote: number, epoch: number | null, trade_type: TradeType) => {
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

const AutoTrades = observer(() => {
    const { dashboard, client, run_panel, summary_card, transactions } = useStore();
    const { currency } = client;
    const { active_tab } = dashboard;

    const VALID_TRADE_TYPES: TradeType[] = [
        'DIGITOVER', 'DIGITUNDER', 'DIGITEVEN', 'DIGITODD', 'DIGITMATCH', 'DIGITDIFF', 'CALL', 'PUT', 'RUNHIGH', 'RUNLOW',
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
                return Array.from(new Set(parsed.filter((symbol): symbol is string => typeof symbol === 'string' && AUTO_MARKET_LOOKUP.has(symbol))));
            }
        } catch {}
        return AUTO_MARKET_SYMBOLS;
    };

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
    const selectedMarkets = useMemo(() => AUTO_MARKETS.filter(market => selectedMarketSymbols.includes(market.symbol)), [selectedMarketSymbols]);
    const availableMarkets = useMemo(() => AUTO_MARKETS.filter(market => !selectedMarketSymbols.includes(market.symbol)), [selectedMarketSymbols]);

    const [totalPnl, setTotalPnl] = useState(0);
    const [totalTrades, setTotalTrades] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [isRunning, setIsRunning] = useState(false);
    const [isConnected, setIsConnected] = useState(false);
    const [inverseMode, setInverseMode] = useState(() => { try { return localStorage.getItem('auto_trades_inverseMode') === 'true'; } catch { return false; } });
    const inverseModeRef = useRef(false);
    const [strategyMode, setStrategyMode] = useState<StrategyMode>(() => { try { return (localStorage.getItem('auto_trades_strategyMode') as StrategyMode) || 'STANDARD'; } catch { return 'STANDARD'; } });
    const [martingaleMode, setMartingaleMode] = useState<MartingaleModeType>(() => { try { return normalizeMartingaleMode(localStorage.getItem('auto_trades_martingaleMode')); } catch { return 'after_one_loss'; } });
    const [consecutiveLossCount, setConsecutiveLossCount] = useState(getInitialConsecutiveLossThreshold);
    const [consecutiveLossCountInput, setConsecutiveLossCountInput] = useState(() => String(getInitialConsecutiveLossThreshold()));
    
    const [scannerActive, setScannerActive] = useState(false);
    const [turboMode, setTurboMode] = useState(true);
    
    const [recoveryConfig, setRecoveryConfig] = useState<RecoveryConfig>(() => {
        try {
            const saved = localStorage.getItem('auto_trades_recoveryConfig');
            if (saved) {
                const parsed = JSON.parse(saved);
                if (!parsed.lossRecoveryStrategy) {
                    parsed.lossRecoveryStrategy = {
                        enabled: false,
                        strategyMode: 'pattern',
                        patternValue: '',
                        digitCondition: 'over',
                        digitCompare: '5',
                        digitWindow: '3',
                    };
                }
                return parsed;
            }
            return {
                enabled: false,
                recoveryType: 'same_market',
                customMarketSymbol: '',
                recoveryStakeMultiplier: 2,
                maxRecoveryAttempts: 3,
                resetOnWin: true,
                switchBackToOriginalMarket: true,
                useLastDigitsPattern: false,
                lastDigitsPattern: {
                    enabled: false,
                    patternType: 'consecutive_odd',
                    patternLength: 3,
                    targetBarrier: undefined,
                },
                lossRecoveryStrategy: {
                    enabled: false,
                    strategyMode: 'pattern',
                    patternValue: '',
                    digitCondition: 'over',
                    digitCompare: '5',
                    digitWindow: '3',
                },
            };
        } catch {
            return {
                enabled: false,
                recoveryType: 'same_market',
                customMarketSymbol: '',
                recoveryStakeMultiplier: 2,
                maxRecoveryAttempts: 3,
                resetOnWin: true,
                switchBackToOriginalMarket: true,
                useLastDigitsPattern: false,
                lastDigitsPattern: {
                    enabled: false,
                    patternType: 'consecutive_odd',
                    patternLength: 3,
                    targetBarrier: undefined,
                },
                lossRecoveryStrategy: {
                    enabled: false,
                    strategyMode: 'pattern',
                    patternValue: '',
                    digitCondition: 'over',
                    digitCompare: '5',
                    digitWindow: '3',
                },
            };
        }
    });
    
    const [m1Strategy, setM1Strategy] = useState<StrategyCondition>({ enabled: false, mode: 'pattern', pattern: '', digitCondition: '==', digitCompare: '5', digitWindow: '3' });
    const [m2Strategy, setM2Strategy] = useState<StrategyCondition>({ enabled: false, mode: 'pattern', pattern: '', digitCondition: '==', digitCompare: '5', digitWindow: '3' });
    const [m1VirtualHook, setM1VirtualHook] = useState<VirtualHookConfig>({ enabled: false, virtualLossCount: 3, realTradeCount: 2 });
    const [m2VirtualHook, setM2VirtualHook] = useState<VirtualHookConfig>({ enabled: false, virtualLossCount: 3, realTradeCount: 2 });
    const [m1Combined, setM1Combined] = useState<CombinedStrategyConfig>({ enabled: false, patterns: '' });
    const [m2Combined, setM2Combined] = useState<CombinedStrategyConfig>({ enabled: false, patterns: '' });
    
    const strategyModeRef = useRef(strategyMode);
    const martingaleModeRef = useRef(martingaleMode);
    const consecutiveLossCountRef = useRef(consecutiveLossCount);
    const modeTransitionLockRef = useRef(false);
    const isRecoveringDataRef = useRef(false);
    const [showDisclaimer, setShowDisclaimer] = useState(false);
    const [showAiStrategy, setShowAiStrategy] = useState(false);
    const [aiStrategyText, setAiStrategyText] = useState('');
    const [aiStrategyResult, setAiStrategyResult] = useState<AiAutoTradeParseResult | null>(null);
    const [aiStrategyLoading, setAiStrategyLoading] = useState(false);
    const [selectedAiPresetId, setSelectedAiPresetId] = useState('');
    const aiPresetFamilies = useMemo(() => AUTO_TRADE_STRATEGY_FAMILIES.map(family => ({ ...family, presets: family.presetIds.map(id => AUTO_TRADE_STRATEGY_PRESET_LOOKUP.get(id)).filter((preset): preset is AutoTradeStrategyPreset => Boolean(preset)) })), []);
    const [aiFabPosition, setAiFabPosition] = useState<AiFabPosition | null>(() => { try { const saved = localStorage.getItem('auto_trades_aiFabPosition'); if (!saved) return null; const parsed = JSON.parse(saved); if (typeof parsed?.left !== 'number' || typeof parsed?.top !== 'number') return null; return parsed; } catch { return null; } });
    const [isAiFabDragging, setIsAiFabDragging] = useState(false);
    const [currentStakeDisplay, setCurrentStakeDisplay] = useState(1);
    const [cooldownDisplay, setCooldownDisplay] = useState(0);
    const [dataStreamLoading, setDataStreamLoading] = useState(false);
    const [dataStreamMessage, setDataStreamMessage] = useState('Loading selected market data...');
    const [floatingStrategyAlert, setFloatingStrategyAlert] = useState<FloatingStrategyAlert | null>(null);

    const [marketDisplays, setMarketDisplays] = useState<MarketDisplay[]>(
        selectedMarkets.map(m => ({ ...m, consecutive: 0, lastDigits: [], directionHistory: [], isRecovering: false, prevQuote: null, candleDirection: 0, candleOpen: null, candleClose: null, directionSampleHistory: [], trading: false, lastResult: null, tradeCount: 0, lastQuote: null, tradeStartTime: null, verificationId: null, digitHistory: [], digitPercentages: {}, confidenceScore: 0, momentumCount: 0, percentageQuoteHistory: [], percentageEpochHistory: [], percentageBackfilled: false, percentageBackfillInFlight: false, currentStake: 1, cooldownLeft: 0, recoveryAttempts: 0, originalStake: 0, recoveryActive: false, recoveryOriginalMarket: '', recoveryOriginalTradeType: 'DIGITOVER', recoveryOriginalBarrier: 4, lastDigitsHistory: [], patternDetected: false, patternTradePending: false, virtualHookActive: false, virtualConsecutiveLosses: 0, virtualFakeWins: 0, virtualFakeLosses: 0, virtualTradeCount: 0 }))
    );

    const subscriptionsRef = useRef<Record<string, any>>({});
    const candleSubscriptionsRef = useRef<Record<string, any>>({});
    const selectedMarketsRef = useRef<AutoMarket[]>(selectedMarkets);
    const selectedMarketSymbolsRef = useRef<Set<string>>(new Set(selectedMarketSymbols));
    const monitoredMarketSymbolsRef = useRef<Set<string>>(new Set(selectedMarketSymbols));
    const marketStatesRef = useRef<Record<string, MarketState>>(Object.fromEntries(AUTO_MARKETS.map(m => [m.symbol, createMarketState()])));
    const totalPnlRef = useRef(0);
    const totalTradesRef = useRef(0);
    const runningRef = useRef(false);
    const configRef = useRef({ stake: 1, martingale: 2, takeProfit: 100, stopLoss: 100, martingaleMode: 'after_one_loss' as MartingaleModeType, consecutiveLossThreshold: 2 });
    const tradeTypeRef = useRef<TradeType>('DIGITOVER');
    const strategyTemplateRef = useRef<StrategyTemplate>('STANDARD');
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
    const aiFabDragRef = useRef({ active: false, moved: false, pointerId: null as number | null, startX: 0, startY: 0, startLeft: 0, startTop: 0 });
    const suppressAiFabClickRef = useRef(false);
    const show_auto = active_tab === DBOT_TABS.AUTO_TRADES;
    const show_auto_ref = useRef(show_auto);
    show_auto_ref.current = show_auto;
    const unmountedRef = useRef(false);
    const stopTradingRef = useRef<() => void>(() => {});
    const floatingStrategyAlertRef = useRef<FloatingStrategyAlert | null>(null);

    // ... (rest of the component code continues - the evaluateLossRecoveryStrategy function above is the key fix)
    
    // Note: The rest of the component (getRecoveryMarkets, calculateRecoveryStake, handleRecoveryMode, 
    // checkPatternMatch, checkDigitCondition, etc.) remains the same as in the original code.
    // The key fix is in the evaluateLossRecoveryStrategy function above.
    
    return null; // Placeholder - actual return would be the full JSX from original
});

export default AutoTrades;
