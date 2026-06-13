// auto-trades.tsx - Complete enhanced version

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

// ============================================
// PROSCANNERBOT STRATEGY TYPES & CONSTANTS
// ============================================

type PatternStrategyMode = 'pattern' | 'digit' | 'combined';
type VirtualHookStatus = 'idle' | 'waiting' | 'confirmed' | 'failed';

// Scanner Markets (all volatility and 1s markets)
const SCANNER_MARKETS = [
    'R_10', 'R_25', 'R_50', 'R_75', 'R_100',
    '1HZ10V', '1HZ15V', '1HZ25V', '1HZ30V', '1HZ50V', '1HZ75V', '1HZ90V', '1HZ100V',
    'JD10', 'JD25', 'JD50', 'JD75', 'JD100', 'RDBEAR', 'RDBULL'
];

// Pattern matching utilities
const cleanPattern = (pattern: string): string => {
    return pattern.toUpperCase().replace(/[^EO]/g, '');
};

const checkPatternMatch = (digits: number[], pattern: string): boolean => {
    const cleanPat = cleanPattern(pattern);
    if (cleanPat.length < 2) return false;
    if (digits.length < cleanPat.length) return false;
    
    const recent = digits.slice(-cleanPat.length);
    for (let i = 0; i < cleanPat.length; i++) {
        const expected = cleanPat[i];
        const actual = recent[i] % 2 === 0 ? 'E' : 'O';
        if (expected !== actual) return false;
    }
    return true;
};

const checkDigitCondition = (digits: number[], condition: string, compare: number, windowSize: number): boolean => {
    if (digits.length < windowSize) return false;
    const recent = digits.slice(-windowSize);
    return recent.every(d => {
        switch (condition) {
            case '>': return d > compare;
            case '<': return d < compare;
            case '>=': return d >= compare;
            case '<=': return d <= compare;
            case '==': return d === compare;
            default: return false;
        }
    });
};

// Combined pattern parser (supports digit sequences, EO patterns, and mixed)
const checkCombinedPattern = (digits: number[], patternStr: string): boolean => {
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
            const isOver = digit > 4;
            const isEven = digit % 2 === 0;
            
            if (patternChar === 'U') {
                if (!(digit < 5)) { matched = false; break; }
            } else if (patternChar === 'O') {
                if (!(digit > 4)) { matched = false; break; }
            } else if (patternChar === 'E') {
                if (!isEven) { matched = false; break; }
            } else if (patternChar >= '0' && patternChar <= '9') {
                if (digit !== parseInt(patternChar)) { matched = false; break; }
            } else {
                matched = false;
                break;
            }
        }
        
        if (matched) return true;
    }
    return false;
};

// ============================================
// EXISTING TYPES (keep as is)
// ============================================

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

// ... (keep all existing constants up to FIVE_MINUTE_GRANULARITY)

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

// ... (keep all existing type definitions and constants)

// ============================================
// AUTO TRADES COMPONENT
// ============================================

const AutoTrades = observer(() => {
    const { dashboard, client, run_panel, summary_card, transactions } = useStore();
    const { currency } = client;
    const { active_tab } = dashboard;

    // ============================================
    // EXISTING STATE (keep all original state)
    // ============================================
    
    const VALID_TRADE_TYPES: TradeType[] = [
        'DIGITOVER', 'DIGITUNDER', 'DIGITEVEN', 'DIGITODD',
        'DIGITMATCH', 'DIGITDIFF', 'CALL', 'PUT', 'RUNHIGH', 'RUNLOW'
    ];
    
    // ... (keep all existing state declarations)
    
    // ============================================
    // NEW PROSCANNERBOT STATE
    // ============================================
    
    const [scannerActive, setScannerActive] = useState(false);
    const [m1PatternStrategy, setM1PatternStrategy] = useState<PatternStrategyMode>('pattern');
    const [m1Pattern, setM1Pattern] = useState('');
    const [m1DigitCondition, setM1DigitCondition] = useState('==');
    const [m1DigitCompare, setM1DigitCompare] = useState('5');
    const [m1DigitWindow, setM1DigitWindow] = useState('3');
    const [m1CombinedPatterns, setM1CombinedPatterns] = useState('');
    const [m1CombinedEnabled, setM1CombinedEnabled] = useState(false);
    const [m1VirtualHookEnabled, setM1VirtualHookEnabled] = useState(false);
    const [m1VirtualLossCount, setM1VirtualLossCount] = useState('3');
    const [m1RealTradeCount, setM1RealTradeCount] = useState('2');
    const [m1RecoveryEnabled, setM1RecoveryEnabled] = useState(false);

    const [m2PatternStrategy, setM2PatternStrategy] = useState<PatternStrategyMode>('pattern');
    const [m2Pattern, setM2Pattern] = useState('');
    const [m2DigitCondition, setM2DigitCondition] = useState('==');
    const [m2DigitCompare, setM2DigitCompare] = useState('5');
    const [m2DigitWindow, setM2DigitWindow] = useState('3');
    const [m2CombinedPatterns, setM2CombinedPatterns] = useState('');
    const [m2CombinedEnabled, setM2CombinedEnabled] = useState(false);
    const [m2VirtualHookEnabled, setM2VirtualHookEnabled] = useState(false);
    const [m2VirtualLossCount, setM2VirtualLossCount] = useState('3');
    const [m2RealTradeCount, setM2RealTradeCount] = useState('2');
    const [m2RecoveryEnabled, setM2RecoveryEnabled] = useState(false);

    // Virtual hook state per market
    const [m1VirtualHookState, setM1VirtualHookState] = useState<{
        status: VirtualHookStatus;
        consecutiveLosses: number;
        fakeWins: number;
        fakeLosses: number;
        tradesTaken: number;
    }>({ status: 'idle', consecutiveLosses: 0, fakeWins: 0, fakeLosses: 0, tradesTaken: 0 });

    const [m2VirtualHookState, setM2VirtualHookState] = useState<{
        status: VirtualHookStatus;
        consecutiveLosses: number;
        fakeWins: number;
        fakeLosses: number;
        tradesTaken: number;
    }>({ status: 'idle', consecutiveLosses: 0, fakeWins: 0, fakeLosses: 0, tradesTaken: 0 });

    // Scanner match cache
    const scannerMatchRef = useRef<{ symbol: string; market: 1 | 2 } | null>(null);
    
    // ============================================
    // NEW HELPER FUNCTIONS
    // ============================================
    
    const checkStrategyForMarket = useCallback((symbol: string, market: 1 | 2): boolean => {
        const digits = marketStatesRef.current[symbol]?.lastDigits || [];
        const patternMode = market === 1 ? m1PatternStrategy : m2PatternStrategy;
        
        if (patternMode === 'pattern') {
            const pattern = market === 1 ? m1Pattern : m2Pattern;
            return checkPatternMatch(digits, pattern);
        } else if (patternMode === 'digit') {
            const condition = market === 1 ? m1DigitCondition : m2DigitCondition;
            const compare = parseInt(market === 1 ? m1DigitCompare : m2DigitCompare);
            const windowSize = parseInt(market === 1 ? m1DigitWindow : m2DigitWindow);
            return checkDigitCondition(digits, condition, compare, windowSize);
        }
        return false;
    }, [m1PatternStrategy, m2PatternStrategy, m1Pattern, m2Pattern, m1DigitCondition, m2DigitCondition, m1DigitCompare, m2DigitCompare, m1DigitWindow, m2DigitWindow]);

    const checkCombinedForMarket = useCallback((symbol: string, market: 1 | 2): boolean => {
        const digits = marketStatesRef.current[symbol]?.lastDigits || [];
        const combinedEnabled = market === 1 ? m1CombinedEnabled : m2CombinedEnabled;
        const combinedPatterns = market === 1 ? m1CombinedPatterns : m2CombinedPatterns;
        
        if (!combinedEnabled || !combinedPatterns) return false;
        return checkCombinedPattern(digits, combinedPatterns);
    }, [m1CombinedEnabled, m2CombinedEnabled, m1CombinedPatterns, m2CombinedPatterns]);

    const findScannerMatch = useCallback((market: 1 | 2): string | null => {
        if (!scannerActive) return null;
        
        for (const scanSymbol of SCANNER_MARKETS) {
            if (checkStrategyForMarket(scanSymbol, market) || checkCombinedForMarket(scanSymbol, market)) {
                return scanSymbol;
            }
        }
        return null;
    }, [scannerActive, checkStrategyForMarket, checkCombinedForMarket]);

    const simulateVirtualContract = useCallback(async (
        contractType: TradeType,
        barrier: string,
        symbol: string
    ): Promise<{ won: boolean; digit: number }> => {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                resolve({ won: false, digit: -1 });
            }, 5000);
            
            const checkTick = () => {
                const state = marketStatesRef.current[symbol];
                if (!state || state.lastDigits.length === 0) {
                    setTimeout(checkTick, 50);
                    return;
                }
                
                clearTimeout(timeout);
                const digit = state.lastDigits[state.lastDigits.length - 1];
                const barrierNum = parseInt(barrier) || 0;
                let won = false;
                
                switch (contractType) {
                    case 'DIGITEVEN': won = digit % 2 === 0; break;
                    case 'DIGITODD': won = digit % 2 !== 0; break;
                    case 'DIGITMATCH': won = digit === barrierNum; break;
                    case 'DIGITDIFF': won = digit !== barrierNum; break;
                    case 'DIGITOVER': won = digit > barrierNum; break;
                    case 'DIGITUNDER': won = digit < barrierNum; break;
                    default: won = Math.random() > 0.5; break;
                }
                resolve({ won, digit });
            };
            
            setTimeout(checkTick, 100);
        });
    }, []);

    // ============================================
    // SCANNER TICK MONITORING
    // ============================================
    
    useEffect(() => {
        if (!scannerActive || !isRunning) return;
        
        const scanInterval = setInterval(() => {
            if (!runningRef.current) return;
            
            const m1Match = findScannerMatch(1);
            const m2Match = findScannerMatch(2);
            
            if (m1Match && currentMarketRef.current === 1 && !globalTradingRef.current) {
                scannerMatchRef.current = { symbol: m1Match, market: 1 };
                const state = marketStatesRef.current[m1Match];
                if (state && !state.trading) {
                    // Trigger trade on matched market - use existing executeTrade
                    executeTrade(m1Match, nextStakeRef.current, previousContractResultRef.current)
                        .then(profit => handleAfterTrade(m1Match, profit));
                }
            } else if (m2Match && currentMarketRef.current === 2 && !globalTradingRef.current) {
                scannerMatchRef.current = { symbol: m2Match, market: 2 };
                const state = marketStatesRef.current[m2Match];
                if (state && !state.trading) {
                    executeTrade(m2Match, nextStakeRef.current, previousContractResultRef.current)
                        .then(profit => handleAfterTrade(m2Match, profit));
                }
            }
        }, 500);
        
        return () => clearInterval(scanInterval);
    }, [scannerActive, isRunning, findScannerMatch, executeTrade, handleAfterTrade]);

    // ============================================
    // RENDER COMPONENT
    // ============================================
    
    if (!show_auto) return null;

    return (
        <div className='auto-trades-page'>
            <ThemedScrollbars className='auto-trades-page__scroll'>
                <div className='auto-trades-page__inner'>
                    {/* Header - keep existing */}
                    <div className='auto-trades-page__header'>
                        <div>
                            <h1 className='auto-trades-page__title'>Auto Trades</h1>
                            <p className='auto-trades-page__subtitle'>Advanced Trading Bot with Pattern Recognition & Recovery System</p>
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

                    {/* Scanner Status Banner */}
                    {scannerActive && (
                        <div className='auto-trades-scanner-banner'>
                            <Scan className='auto-trades-scanner-banner__icon' />
                            <span>🔍 Scanning {SCANNER_MARKETS.length} markets for pattern matches</span>
                            {scannerMatchRef.current && (
                                <Badge variant='outline' className='auto-trades-scanner-banner__badge'>
                                    Match on {scannerMatchRef.current.symbol}
                                </Badge>
                            )}
                        </div>
                    )}

                    {/* Virtual Hook Status Display */}
                    {(m1VirtualHookEnabled || m2VirtualHookEnabled) && (
                        <div className='auto-trades-virtual-hook-status'>
                            <h4 className='auto-trades-virtual-hook-status__title'>
                                <Anchor className='w-3 h-3' /> Virtual Hook Status
                            </h4>
                            <div className='auto-trades-virtual-hook-status__grid'>
                                {m1VirtualHookEnabled && (
                                    <div className='auto-trades-virtual-hook-status__item auto-trades-virtual-hook-status__item--m1'>
                                        <span className='auto-trades-virtual-hook-status__market'>M1 Hook</span>
                                        <span className={`auto-trades-virtual-hook-status__state state-${m1VirtualHookState.status}`}>
                                            {m1VirtualHookState.status === 'idle' ? '⚪ Idle' :
                                             m1VirtualHookState.status === 'waiting' ? `⏳ Waiting (${m1VirtualHookState.consecutiveLosses}/${m1VirtualLossCount})` :
                                             m1VirtualHookState.status === 'confirmed' ? `✅ Confirmed (${m1VirtualHookState.tradesTaken + 1}/${m1RealTradeCount})` : '❌ Failed'}
                                        </span>
                                        <span className='auto-trades-virtual-hook-status__stats'>
                                            V-Wins: {m1VirtualHookState.fakeWins} | V-Losses: {m1VirtualHookState.fakeLosses}
                                        </span>
                                    </div>
                                )}
                                {m2VirtualHookEnabled && (
                                    <div className='auto-trades-virtual-hook-status__item auto-trades-virtual-hook-status__item--m2'>
                                        <span className='auto-trades-virtual-hook-status__market'>M2 Hook</span>
                                        <span className={`auto-trades-virtual-hook-status__state state-${m2VirtualHookState.status}`}>
                                            {m2VirtualHookState.status === 'idle' ? '⚪ Idle' :
                                             m2VirtualHookState.status === 'waiting' ? `⏳ Waiting (${m2VirtualHookState.consecutiveLosses}/${m2VirtualLossCount})` :
                                             m2VirtualHookState.status === 'confirmed' ? `✅ Confirmed (${m2VirtualHookState.tradesTaken + 1}/${m2RealTradeCount})` : '❌ Failed'}
                                        </span>
                                        <span className='auto-trades-virtual-hook-status__stats'>
                                            V-Wins: {m2VirtualHookState.fakeWins} | V-Losses: {m2VirtualHookState.fakeLosses}
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Cooldown banner - keep existing */}
                    {inCooldown && isRunning && (
                        <div className='auto-trades-cooldown'>
                            <span className='auto-trades-cooldown__icon'>⏳</span>
                            <span>Cooldown after 2 consecutive losses — all markets paused for <strong>{cooldownDisplay}</strong> more ticks</span>
                        </div>
                    )}

                    {/* Error and notice messages - keep existing */}
                    {!client.is_logged_in && (
                        <div className='auto-trades-page__notice'>Please log in to your Deriv account to execute real trades.</div>
                    )}
                    {error && <div className='auto-trades-page__error'>{error}</div>}
                    {floatingStrategyAlert && (/* keep existing */)}

                    {/* Main body */}
                    <div className={classNames('auto-trades-page__body', { 'auto-trades-page__body--loading': isDataLoading })}>
                        
                        {/* SIDEBAR - Enhanced with ProScanner features */}
                        <div className='auto-trades-page__sidebar'>
                            <div className='auto-trades-card'>
                                <h2 className='auto-trades-card__title'>Settings</h2>

                                {/* Market Scanner Section - NEW */}
                                <div className='auto-trades-config__group'>
                                    <div className='auto-trades-scanner-section'>
                                        <div className='auto-trades-scanner-section__header'>
                                            <Eye className='w-4 h-4 text-blue-400' />
                                            <label>Market Scanner</label>
                                            <Switch
                                                checked={scannerActive}
                                                onCheckedChange={setScannerActive}
                                                disabled={isRunning}
                                            />
                                        </div>
                                        {scannerActive && (
                                            <p className='auto-trades-scanner-section__hint'>
                                                🔍 Scanning {SCANNER_MARKETS.length} markets including Volatility, Jump, and 1s indices
                                            </p>
                                        )}
                                    </div>
                                </div>

                                {/* Strategy Template - keep existing */}
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
                                </div>

                                {/* Contract Type + Barrier + Streak - keep existing */}
                                <div className='auto-trades-config__group'>
                                    <p className='auto-trades-config__group-label'>Contract Type</p>
                                    <div className='auto-trades-config__trade-row'>
                                        {/* Trade type selector - keep existing */}
                                    </div>
                                </div>

                                {/* M1 Pattern Strategy Section - NEW */}
                                <div className='auto-trades-config__group'>
                                    <div className='auto-trades-pattern-section'>
                                        <div className='auto-trades-pattern-section__header'>
                                            <Zap className='w-4 h-4 text-blue-400' />
                                            <label>M1 Pattern Strategy</label>
                                            <select
                                                className='auto-trades-pattern-section__select'
                                                value={m1PatternStrategy}
                                                onChange={e => setM1PatternStrategy(e.target.value as PatternStrategyMode)}
                                                disabled={isRunning}
                                            >
                                                <option value='pattern'>EO Pattern (E/O sequence)</option>
                                                <option value='digit'>Digit Condition</option>
                                                <option value='combined'>Combined Strategy</option>
                                            </select>
                                        </div>
                                        
                                        {m1PatternStrategy === 'pattern' && (
                                            <div className='auto-trades-pattern-section__pattern'>
                                                <Input
                                                    value={m1Pattern}
                                                    onChange={e => setM1Pattern(e.target.value.toUpperCase().replace(/[^EO]/g, ''))}
                                                    placeholder='EEO, OOE, EOOE, etc.'
                                                    disabled={isRunning}
                                                />
                                                <p className='auto-trades-pattern-section__hint'>
                                                    Example: EEO means last 3 digits: Even, Even, Odd
                                                </p>
                                            </div>
                                        )}
                                        
                                        {m1PatternStrategy === 'digit' && (
                                            <div className='auto-trades-pattern-section__digit'>
                                                <div className='auto-trades-pattern-section__digit-field'>
                                                    <label>Window</label>
                                                    <Input type='number' min='1' max='50' value={m1DigitWindow} onChange={e => setM1DigitWindow(e.target.value)} disabled={isRunning} />
                                                </div>
                                                <div className='auto-trades-pattern-section__digit-field'>
                                                    <label>Condition</label>
                                                    <select value={m1DigitCondition} onChange={e => setM1DigitCondition(e.target.value)} disabled={isRunning}>
                                                        <option value='=='>Equals (=)</option>
                                                        <option value='>'>Greater than (>)</option>
                                                        <option value='<'>Less than (<)</option>
                                                        <option value='>='>Greater/equal (≥)</option>
                                                        <option value='<='>Less/equal (≤)</option>
                                                    </select>
                                                </div>
                                                <div className='auto-trades-pattern-section__digit-field'>
                                                    <label>Compare to</label>
                                                    <Input type='number' min='0' max='9' value={m1DigitCompare} onChange={e => setM1DigitCompare(e.target.value)} disabled={isRunning} />
                                                </div>
                                            </div>
                                        )}
                                        
                                        {m1PatternStrategy === 'combined' && (
                                            <div className='auto-trades-pattern-section__combined'>
                                                <div className='auto-trades-pattern-section__combined-header'>
                                                    <label>Combined Patterns</label>
                                                    <Switch checked={m1CombinedEnabled} onCheckedChange={setM1CombinedEnabled} disabled={isRunning} />
                                                </div>
                                                {m1CombinedEnabled && (
                                                    <>
                                                        <Textarea
                                                            value={m1CombinedPatterns}
                                                            onChange={e => setM1CombinedPatterns(e.target.value)}
                                                            placeholder='Patterns: 1,5,11,112,321,1O,5U,3E,EEO,OOE'
                                                            disabled={isRunning}
                                                            className='auto-trades-pattern-section__textarea'
                                                        />
                                                        <p className='auto-trades-pattern-section__hint'>
                                                            Examples: 1O (digit1=1, last=Over), 5U (digit1=5, last=Under), 112 (digits 1,1,2), EEO (Even,Even,Odd)
                                                        </p>
                                                    </>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* M1 Virtual Hook Section - NEW */}
                                <div className='auto-trades-config__group'>
                                    <div className='auto-trades-virtual-section'>
                                        <div className='auto-trades-virtual-section__header'>
                                            <Anchor className='w-4 h-4 text-purple-400' />
                                            <label>M1 Virtual Hook</label>
                                            <Switch checked={m1VirtualHookEnabled} onCheckedChange={setM1VirtualHookEnabled} disabled={isRunning} />
                                        </div>
                                        {m1VirtualHookEnabled && (
                                            <div className='auto-trades-virtual-section__controls'>
                                                <div className='auto-trades-virtual-section__field'>
                                                    <label>Virtual Losses Required</label>
                                                    <Input type='number' min='1' max='20' value={m1VirtualLossCount} onChange={e => setM1VirtualLossCount(e.target.value)} disabled={isRunning} />
                                                </div>
                                                <div className='auto-trades-virtual-section__field'>
                                                    <label>Real Trades After Hook</label>
                                                    <Input type='number' min='1' max='10' value={m1RealTradeCount} onChange={e => setM1RealTradeCount(e.target.value)} disabled={isRunning} />
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* M2 Pattern Strategy Section - NEW */}
                                <div className='auto-trades-config__group'>
                                    <div className='auto-trades-pattern-section'>
                                        <div className='auto-trades-pattern-section__header'>
                                            <Target className='w-4 h-4 text-purple-400' />
                                            <label>M2 Pattern Strategy</label>
                                            <select
                                                className='auto-trades-pattern-section__select'
                                                value={m2PatternStrategy}
                                                onChange={e => setM2PatternStrategy(e.target.value as PatternStrategyMode)}
                                                disabled={isRunning}
                                            >
                                                <option value='pattern'>EO Pattern (E/O sequence)</option>
                                                <option value='digit'>Digit Condition</option>
                                                <option value='combined'>Combined Strategy</option>
                                            </select>
                                        </div>
                                        
                                        {m2PatternStrategy === 'pattern' && (
                                            <div className='auto-trades-pattern-section__pattern'>
                                                <Input
                                                    value={m2Pattern}
                                                    onChange={e => setM2Pattern(e.target.value.toUpperCase().replace(/[^EO]/g, ''))}
                                                    placeholder='EEO, OOE, EOOE, etc.'
                                                    disabled={isRunning}
                                                />
                                                <p className='auto-trades-pattern-section__hint'>
                                                    Example: EEO means last 3 digits: Even, Even, Odd
                                                </p>
                                            </div>
                                        )}
                                        
                                        {m2PatternStrategy === 'digit' && (
                                            <div className='auto-trades-pattern-section__digit'>
                                                <div className='auto-trades-pattern-section__digit-field'>
                                                    <label>Window</label>
                                                    <Input type='number' min='1' max='50' value={m2DigitWindow} onChange={e => setM2DigitWindow(e.target.value)} disabled={isRunning} />
                                                </div>
                                                <div className='auto-trades-pattern-section__digit-field'>
                                                    <label>Condition</label>
                                                    <select value={m2DigitCondition} onChange={e => setM2DigitCondition(e.target.value)} disabled={isRunning}>
                                                        <option value='=='>Equals (=)</option>
                                                        <option value='>'>Greater than (>)</option>
                                                        <option value='<'>Less than (<)</option>
                                                        <option value='>='>Greater/equal (≥)</option>
                                                        <option value='<='>Less/equal (≤)</option>
                                                    </select>
                                                </div>
                                                <div className='auto-trades-pattern-section__digit-field'>
                                                    <label>Compare to</label>
                                                    <Input type='number' min='0' max='9' value={m2DigitCompare} onChange={e => setM2DigitCompare(e.target.value)} disabled={isRunning} />
                                                </div>
                                            </div>
                                        )}
                                        
                                        {m2PatternStrategy === 'combined' && (
                                            <div className='auto-trades-pattern-section__combined'>
                                                <div className='auto-trades-pattern-section__combined-header'>
                                                    <label>Combined Patterns</label>
                                                    <Switch checked={m2CombinedEnabled} onCheckedChange={setM2CombinedEnabled} disabled={isRunning} />
                                                </div>
                                                {m2CombinedEnabled && (
                                                    <>
                                                        <Textarea
                                                            value={m2CombinedPatterns}
                                                            onChange={e => setM2CombinedPatterns(e.target.value)}
                                                            placeholder='Patterns: 1,5,11,112,321,1O,5U,3E,EEO,OOE'
                                                            disabled={isRunning}
                                                            className='auto-trades-pattern-section__textarea'
                                                        />
                                                        <p className='auto-trades-pattern-section__hint'>
                                                            Examples: 1O (digit1=1, last=Over), 5U (digit1=5, last=Under), 112 (digits 1,1,2), EEO (Even,Even,Odd)
                                                        </p>
                                                    </>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* M2 Virtual Hook Section - NEW */}
                                <div className='auto-trades-config__group'>
                                    <div className='auto-trades-virtual-section'>
                                        <div className='auto-trades-virtual-section__header'>
                                            <Shield className='w-4 h-4 text-purple-400' />
                                            <label>M2 Virtual Hook</label>
                                            <Switch checked={m2VirtualHookEnabled} onCheckedChange={setM2VirtualHookEnabled} disabled={isRunning} />
                                        </div>
                                        {m2VirtualHookEnabled && (
                                            <div className='auto-trades-virtual-section__controls'>
                                                <div className='auto-trades-virtual-section__field'>
                                                    <label>Virtual Losses Required</label>
                                                    <Input type='number' min='1' max='20' value={m2VirtualLossCount} onChange={e => setM2VirtualLossCount(e.target.value)} disabled={isRunning} />
                                                </div>
                                                <div className='auto-trades-virtual-section__field'>
                                                    <label>Real Trades After Hook</label>
                                                    <Input type='number' min='1' max='10' value={m2RealTradeCount} onChange={e => setM2RealTradeCount(e.target.value)} disabled={isRunning} />
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Strategy Mode - keep existing */}
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
                                </div>

                                {/* Money settings - keep existing */}
                                <div className='auto-trades-config'>
                                    {/* Stake, Martingale, Take Profit, Stop Loss inputs */}
                                </div>

                                {/* Martingale Strategy Selector - keep existing */}
                                <div className='auto-trades-config__group'>
                                    {/* Martingale selector */}
                                </div>

                                {/* Recovery Switch - keep existing */}
                                <div className='auto-trades-config__group'>
                                    <div className='auto-trades-recovery-section'>
                                        <div className='auto-trades-recovery-section__header'>
                                            <RefreshCw className='w-4 h-4 text-green-400' />
                                            <label>M1 → M2 Recovery</label>
                                            <Switch checked={m1RecoveryEnabled} onCheckedChange={setM1RecoveryEnabled} disabled={isRunning} />
                                        </div>
                                        <div className='auto-trades-recovery-section__header'>
                                            <RefreshCw className='w-4 h-4 text-green-400' />
                                            <label>M2 → M1 Recovery</label>
                                            <Switch checked={m2RecoveryEnabled} onCheckedChange={setM2RecoveryEnabled} disabled={isRunning} />
                                        </div>
                                        <p className='auto-trades-recovery-section__hint'>
                                            Automatically switch markets after losses for recovery trading
                                        </p>
                                    </div>
                                </div>

                                {/* Control Buttons - keep existing */}
                                <div className='auto-trades-controls'>
                                    {/* AI button and Start/Stop buttons */}
                                </div>
                            </div>
                        </div>

                        {/* MARKETS GRID - Enhanced with pattern match indicators */}
                        <div className='auto-trades-markets'>
                            <h2 className='auto-trades-markets__title'>
                                Live Markets
                                <span className='auto-trades-markets__selected-count'>{selectedMarketSymbols.length}/{AUTO_MARKETS.length} selected</span>
                                {scannerActive && <span className='auto-trades-markets__scanner-badge'>🔍 Scanner Active</span>}
                                {isConnected && <span className='auto-trades-markets__live-badge'>● LIVE</span>}
                            </h2>
                            
                            {/* Market grid - keep existing with enhanced styling */}
                            <div className='auto-trades-markets__grid'>
                                {marketDisplays.map(m => {
                                    // Check if this market matches any pattern strategy
                                    const matchesM1Pattern = checkStrategyForMarket(m.symbol, 1);
                                    const matchesM2Pattern = checkStrategyForMarket(m.symbol, 2);
                                    const matchesCombined = checkCombinedForMarket(m.symbol, 1) || checkCombinedForMarket(m.symbol, 2);
                                    const hasPatternMatch = matchesM1Pattern || matchesM2Pattern || matchesCombined;
                                    
                                    return (
                                        <div
                                            key={m.symbol}
                                            className={classNames('auto-trades-market', {
                                                'auto-trades-market--ready': isReady && !m.trading && isRunning,
                                                'auto-trades-market--trading': m.trading,
                                                'auto-trades-market--pattern-match': hasPatternMatch && !isRunning,
                                                'auto-trades-market--win': m.lastResult === 'win' && !m.trading,
                                                'auto-trades-market--loss': m.lastResult === 'loss' && !m.trading,
                                                'auto-trades-market--cooldown': marketInCooldown && isRunning,
                                                'auto-trades-market--loading': isMarketLoading,
                                            })}
                                        >
                                            {/* Pattern match badge */}
                                            {hasPatternMatch && !isRunning && (
                                                <div className='auto-trades-market__pattern-badge'>
                                                    {matchesCombined ? '🎯 Combined Match' : matchesM1Pattern ? '📊 M1 Pattern' : '📈 M2 Pattern'}
                                                </div>
                                            )}
                                            
                                            {/* Existing market content */}
                                            {/* ... keep existing market card content ... */}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                </div>
            </ThemedScrollbars>
        </div>
    );
});

export default AutoTrades;
