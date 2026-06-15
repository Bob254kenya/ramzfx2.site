Here is the complete, fixed React component with updated styling for the Pro Scanner Bot.
```tsx
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { useDevice } from '@deriv-com/ui';
import { contract_stages } from '@/constants/contract-stage';
import { DBOT_TABS } from '@/constants/bot-contents';
import { api_base, observer as globalObserver } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import { getLastDigitFromQuote } from '@/utils/market-data';
import { buyContractForUi, streamContractUntilSettled } from '@/utils/trade-purchase';
import { safeSubscribe } from '@/utils/websocket-handler';
import './scanner.scss';

// ==================== TYPES ====================
type TTickPoint = {
    epoch: number;
    quote: number;
};

type TContractType = 'DIGITEVEN' | 'DIGITODD' | 'DIGITMATCH' | 'DIGITDIFF' | 'DIGITOVER' | 'DIGITUNDER';
type TBotStatus = 'idle' | 'trading_m1' | 'recovery' | 'waiting_pattern' | 'pattern_matched' | 'virtual_hook' | 'reconnecting';
type TMarketConfig = {
    symbol: string;
    contractType: TContractType;
    barrier: string;
};

type TLogEntry = {
    time: string;
    market: string;
    symbol: string;
    contractType: string;
    stake: string;
    exitDigit: number | string;
    result: string;
    pnl: number;
    balanceAfter: number;
    switchInfo: string;
};

type TFrequencyStats = {
    digit: number;
    count: number;
    percentage: number;
};

type TPatternMatch = {
    market: string;
    symbol: string;
    patternType: string;
    patternValue: string;
    contractType: TContractType;
    barrier: string;
};

// ==================== CONSTANTS ====================
const MARKETS = [
    { label: 'Volatility 10 Index', symbol: 'R_10' },
    { label: 'Volatility 25 Index', symbol: 'R_25' },
    { label: 'Volatility 50 Index', symbol: 'R_50' },
    { label: 'Volatility 75 Index', symbol: 'R_75' },
    { label: 'Volatility 100 Index', symbol: 'R_100' },
    { label: 'Volatility 10(1s) Index', symbol: '1HZ10V' },
    { label: 'Volatility 15(1s) Index', symbol: '1HZ15V' },
    { label: 'Volatility 25(1s) Index', symbol: '1HZ25V' },
    { label: 'Volatility 30(1s) Index', symbol: '1HZ30V' },
    { label: 'Volatility 50(1s) Index', symbol: '1HZ50V' },
    { label: 'Volatility 75(1s) Index', symbol: '1HZ75V' },
    { label: 'Volatility 90(1s) Index', symbol: '1HZ90V' },
    { label: 'Volatility 100(1s) Index', symbol: '1HZ100V' },
    { label: 'Jump 10 Index', symbol: 'JD10' },
    { label: 'Jump 25 Index', symbol: 'JD25' },
    { label: 'Bear Market Index', symbol: 'RDBEAR' },
    { label: 'Bull Market Index', symbol: 'RDBULL' },
];

const CONTRACT_TYPES: { value: TContractType; label: string }[] = [
    { value: 'DIGITEVEN', label: 'Even' },
    { value: 'DIGITODD', label: 'Odd' },
    { value: 'DIGITMATCH', label: 'Matches' },
    { value: 'DIGITDIFF', label: 'Differs' },
    { value: 'DIGITOVER', label: 'Over' },
    { value: 'DIGITUNDER', label: 'Under' },
];

const MAX_TICKS = 1000;
const STORAGE_KEY = 'pro_scanner_bot_state';

// ==================== UTILITIES ====================
const getLastDigit = (quote: number, symbol: string): number => {
    const price = typeof quote === 'number' ? quote : parseFloat(String(quote));
    if (isNaN(price)) return 0;
    const str = price.toFixed(8);
    const lastChar = str[str.length - 1];
    return parseInt(lastChar, 10);
};

const cleanMoneyInput = (value: string) => value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');

const formatTime = () => new Date().toLocaleTimeString();

// ==================== MAIN COMPONENT ====================
const Scanner = observer(() => {
    const { client, dashboard, run_panel, summary_card, transactions } = useStore();
    const { isDesktop } = useDevice();
    const { active_tab } = dashboard;

    // ==================== MARKET CONFIGURATION ====================
    const [m1Config, setM1Config] = useState<TMarketConfig>({
        symbol: 'R_10',
        contractType: 'DIGITEVEN',
        barrier: '0',
    });
    const [m2Config, setM2Config] = useState<TMarketConfig>({
        symbol: 'R_25',
        contractType: 'DIGITODD',
        barrier: '0',
    });

    // ==================== BOT STATE ====================
    const [isRunning, setIsRunning] = useState(false);
    const [botStatus, setBotStatus] = useState<TBotStatus>('idle');
    const [currentMarket, setCurrentMarket] = useState<1 | 2>(1);
    const [currentStake, setCurrentStake] = useState(0.35);
    const [martingaleStep, setMartingaleStep] = useState(1);
    const [wins, setWins] = useState(0);
    const [losses, setLosses] = useState(0);
    const [netProfit, setNetProfit] = useState(0);
    const [totalStaked, setTotalStaked] = useState(0);
    const [localBalance, setLocalBalance] = useState(10000);

    // ==================== VIRTUAL HOOK STATE ====================
    const [vhEnabled, setVhEnabled] = useState(false);
    const [vhVirtualLossesRequired, setVhVirtualLossesRequired] = useState(3);
    const [vhRealTradesAfterSignal, setVhRealTradesAfterSignal] = useState(1);
    const [vhFakeWins, setVhFakeWins] = useState(0);
    const [vhFakeLosses, setVhFakeLosses] = useState(0);
    const [vhConsecLosses, setVhConsecLosses] = useState(0);
    const [vhStatus, setVhStatus] = useState<'idle' | 'waiting' | 'confirmed' | 'failed'>('idle');
    const [vhRemainingRealTrades, setVhRemainingRealTrades] = useState(0);

    // ==================== PATTERN STATE ====================
    const [eoPatterns, setEoPatterns] = useState<string[]>(['EEO', 'OOE']);
    const [digitPatterns, setDigitPatterns] = useState<string[]>(['112', '321']);
    const [combinedPatterns, setCombinedPatterns] = useState<string[]>(['1O', '5U', '3E']);
    const [arithmeticEnabled, setArithmeticEnabled] = useState(false);
    const [arithmeticCondition, setArithmeticCondition] = useState<'<' | '>' | '<=' | '>=' | '=='>('>');
    const [arithmeticValue, setArithmeticValue] = useState(5);
    const [arithmeticLookback, setArithmeticLookback] = useState(3);
    const [combinedEnabled, setCombinedEnabled] = useState(false);
    const [scannerEnabled, setScannerEnabled] = useState(true);

    // ==================== RISK MANAGEMENT ====================
    const [tp, setTp] = useState(100);
    const [sl, setSl] = useState(50);
    const [martingaleEnabled, setMartingaleEnabled] = useState(true);
    const [martingaleMultiplier, setMartingaleMultiplier] = useState(2);
    const [martingaleMaxSteps, setMartingaleMaxSteps] = useState(5);
    const [baseStake, setBaseStake] = useState(0.35);
    const [inRecovery, setInRecovery] = useState(false);
    const [turboMode, setTurboMode] = useState(false);

    // ==================== UI STATE ====================
    const [logs, setLogs] = useState<TLogEntry[]>([]);
    const [lastDigits, setLastDigits] = useState<number[]>([]);
    const [showChartPopup, setShowChartPopup] = useState(false);
    const [showSocialPopup, setShowSocialPopup] = useState(true);
    const [chartPosition, setChartPosition] = useState({ x: 100, y: 100 });
    const [isDragging, setIsDragging] = useState(false);
    const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
    const [configName, setConfigName] = useState('My Config');
    const [digitFrequency, setDigitFrequency] = useState<TFrequencyStats[]>([]);
    const [selectedContractTypeFilter, setSelectedContractTypeFilter] = useState<TContractType | ''>('');

    // ==================== REFS ====================
    const subscriptionRefs = useRef<Map<string, { unsubscribe?: () => void }>>(new Map());
    const ticksRefs = useRef<Map<string, TTickPoint[]>>(new Map());
    const requestVersionRef = useRef(0);
    const shouldStopRef = useRef(false);
    const tradeInFlightRef = useRef(false);
    const patternTradeTakenRef = useRef(false);
    const combinedTradeTakenRef = useRef(false);
    const chartPopupRef = useRef<HTMLDivElement>(null);

    const currency = client.currency || 'USD';
    const showScanner = active_tab === DBOT_TABS.SCANNER;

    // ==================== PATTERN RECOGNITION ====================
    const checkEOPattern = useCallback((digits: number[], pattern: string): boolean => {
        const patternLength = pattern.length;
        if (digits.length < patternLength) return false;
        const recentDigits = digits.slice(-patternLength);
        for (let i = 0; i < patternLength; i++) {
            const isEven = recentDigits[i] % 2 === 0;
            const expectedEven = pattern[i] === 'E';
            if (isEven !== expectedEven) return false;
        }
        return true;
    }, []);

    const checkDigitPattern = useCallback((digits: number[], pattern: string): boolean => {
        const patternLength = pattern.length;
        if (digits.length < patternLength) return false;
        const recentDigits = digits.slice(-patternLength);
        for (let i = 0; i < patternLength; i++) {
            if (recentDigits[i] !== parseInt(pattern[i], 10)) return false;
        }
        return true;
    }, []);

    const checkCombinedPattern = useCallback((digits: number[], pattern: string): boolean => {
        if (digits.length < 1) return false;
        const lastDigit = digits[digits.length - 1];
        const patternCode = pattern.charAt(0);
        const condition = pattern.charAt(1);
        
        let digitMatch = false;
        if (patternCode === 'X') digitMatch = true;
        else if (!isNaN(parseInt(patternCode, 10))) digitMatch = lastDigit === parseInt(patternCode, 10);
        
        let conditionMatch = false;
        if (condition === 'E') conditionMatch = lastDigit % 2 === 0;
        else if (condition === 'O') conditionMatch = lastDigit % 2 !== 0;
        else if (condition === 'U') conditionMatch = lastDigit <= 4;
        else if (condition === 'O') conditionMatch = lastDigit >= 5;
        
        return digitMatch && conditionMatch;
    }, []);

    const checkArithmeticCondition = useCallback((digits: number[]): boolean => {
        if (!arithmeticEnabled || digits.length < arithmeticLookback) return false;
        const recentDigits = digits.slice(-arithmeticLookback);
        let sum = 0;
        for (const d of recentDigits) sum += d;
        const avg = sum / arithmeticLookback;
        
        switch (arithmeticCondition) {
            case '>': return avg > arithmeticValue;
            case '<': return avg < arithmeticValue;
            case '>=': return avg >= arithmeticValue;
            case '<=': return avg <= arithmeticValue;
            case '==': return Math.abs(avg - arithmeticValue) < 0.01;
            default: return false;
        }
    }, [arithmeticEnabled, arithmeticCondition, arithmeticValue, arithmeticLookback]);

    const scanAllMarketsForPattern = useCallback((): TPatternMatch | null => {
        for (const [symbol, ticks] of ticksRefs.current.entries()) {
            if (!ticks || ticks.length === 0) continue;
            const digits = ticks.map(t => getLastDigit(t.quote, symbol));
            
            if (combinedEnabled) {
                for (const pattern of combinedPatterns) {
                    if (checkCombinedPattern(digits, pattern)) {
                        return { market: symbol, symbol, patternType: 'combined', patternValue: pattern, contractType: 'DIGITEVEN', barrier: '' };
                    }
                }
            }
            
            for (const pattern of eoPatterns) {
                if (checkEOPattern(digits, pattern)) {
                    const isEven = pattern.includes('E');
                    return { market: symbol, symbol, patternType: 'eo', patternValue: pattern, contractType: isEven ? 'DIGITEVEN' : 'DIGITODD', barrier: '' };
                }
            }
            
            for (const pattern of digitPatterns) {
                if (checkDigitPattern(digits, pattern)) {
                    const lastDigitMatch = parseInt(pattern[pattern.length - 1], 10);
                    return { market: symbol, symbol, patternType: 'digit', patternValue: pattern, contractType: 'DIGITMATCH', barrier: String(lastDigitMatch) };
                }
            }
            
            if (checkArithmeticCondition(digits)) {
                return { market: symbol, symbol, patternType: 'arithmetic', patternValue: `${arithmeticCondition} ${arithmeticValue}`, contractType: 'DIGITOVER', barrier: String(arithmeticValue) };
            }
        }
        return null;
    }, [combinedEnabled, combinedPatterns, eoPatterns, digitPatterns, checkEOPattern, checkDigitPattern, checkCombinedPattern, checkArithmeticCondition, arithmeticEnabled]);

    // ==================== MARTINGALE ====================
    const getMartingaleStake = useCallback((): number => {
        if (!martingaleEnabled) return baseStake;
        const multiplier = Math.pow(martingaleMultiplier, martingaleStep - 1);
        return Math.min(baseStake * multiplier, baseStake * Math.pow(martingaleMultiplier, martingaleMaxSteps));
    }, [martingaleEnabled, martingaleMultiplier, martingaleStep, martingaleMaxSteps, baseStake]);

    const resetMartingale = useCallback(() => {
        setMartingaleStep(1);
        setCurrentStake(baseStake);
    }, [baseStake]);

    const incrementMartingale = useCallback(() => {
        if (martingaleStep < martingaleMaxSteps) {
            setMartingaleStep(prev => prev + 1);
            setCurrentStake(getMartingaleStake());
        }
    }, [martingaleStep, martingaleMaxSteps, getMartingaleStake]);

    // ==================== TRADE EXECUTION ====================
    const executeTrade = useCallback(async (marketConfig: TMarketConfig, isVirtual: boolean = false, isCombined: boolean = false, isRecovery: boolean = false) => {
        if (tradeInFlightRef.current || shouldStopRef.current) return null;
        
        const stake = getMartingaleStake();
        const marketLabel = MARKETS.find(m => m.symbol === marketConfig.symbol)?.label || marketConfig.symbol;
        const marketType = isRecovery ? 'M2' : (currentMarket === 1 ? 'M1' : 'M2');
        const marketDisplay = isCombined ? 'COMBINED' : (isVirtual ? 'VH' : marketType);
        
        setTotalStaked(prev => prev + stake);
        
        if (isVirtual) {
            setLogs(prev => [...prev, {
                time: formatTime(),
                market: `VIRTUAL (${marketDisplay})`,
                symbol: marketConfig.symbol,
                contractType: marketConfig.contractType,
                stake: `${stake.toFixed(2)} ${currency}`,
                exitDigit: '?',
                result: 'V-Pending',
                pnl: 0,
                balanceAfter: localBalance,
                switchInfo: `Step ${martingaleStep}`,
            }]);
            
            await new Promise(resolve => setTimeout(resolve, 1000));
            const win = Math.random() > 0.5;
            
            if (win) {
                setVhFakeWins(prev => prev + 1);
                setVhConsecLosses(0);
                setLogs(prev => {
                    const newLogs = [...prev];
                    const lastIndex = newLogs.length - 1;
                    if (newLogs[lastIndex]) {
                        newLogs[lastIndex].result = 'V-Win';
                        newLogs[lastIndex].exitDigit = Math.floor(Math.random() * 10);
                    }
                    return newLogs;
                });
                return { win: true, profit: stake * 0.9 };
            } else {
                setVhFakeLosses(prev => prev + 1);
                setVhConsecLosses(prev => prev + 1);
                setLogs(prev => {
                    const newLogs = [...prev];
                    const lastIndex = newLogs.length - 1;
                    if (newLogs[lastIndex]) {
                        newLogs[lastIndex].result = 'V-Loss';
                        newLogs[lastIndex].exitDigit = Math.floor(Math.random() * 10);
                    }
                    return newLogs;
                });
                return { win: false, profit: -stake };
            }
        }
        
        try {
            const buyParams: any = {
                amount: stake,
                basis: 'stake',
                contract_type: marketConfig.contractType,
                currency,
                duration: 1,
                duration_unit: 't',
                symbol: marketConfig.symbol,
            };
            if (marketConfig.barrier) buyParams.barrier = marketConfig.barrier;
            
            const buy = await buyContractForUi({ parameters: buyParams, price: stake, source: 'ProScannerBot' });
            
            const settledContract = await streamContractUntilSettled({
                contractId: buy.contract_id,
                fallback: { buy_price: stake, contract_id: buy.contract_id },
                onUpdate: snapshot => transactions?.pushTransaction(snapshot),
                source: 'ProScannerBot',
            });
            
            const profit = Number(settledContract.profit ?? 0);
            const exitDigit = settledContract.exit_tick?.quote ? getLastDigit(settledContract.exit_tick.quote, marketConfig.symbol) : 'N/A';
            const isWin = profit > 0;
            
            setLocalBalance(prev => prev + profit);
            setNetProfit(prev => prev + profit);
            
            if (isWin) {
                setWins(prev => prev + 1);
                resetMartingale();
                if (inRecovery) setInRecovery(false);
                if (vhStatus === 'confirmed') {
                    const remaining = vhRemainingRealTrades - 1;
                    if (remaining <= 0) {
                        setVhStatus('idle');
                        setVhConsecLosses(0);
                    }
                    setVhRemainingRealTrades(remaining);
                }
            } else {
                setLosses(prev => prev + 1);
                if (!inRecovery && !isVirtual) {
                    setInRecovery(true);
                    setCurrentMarket(2);
                }
                if (martingaleEnabled && martingaleStep < martingaleMaxSteps) {
                    incrementMartingale();
                }
                if (vhStatus === 'confirmed') {
                    const remaining = vhRemainingRealTrades - 1;
                    if (remaining <= 0) {
                        setVhStatus('idle');
                        setVhConsecLosses(0);
                    }
                    setVhRemainingRealTrades(remaining);
                }
            }
            
            setLogs(prev => [...prev, {
                time: formatTime(),
                market: marketDisplay,
                symbol: marketConfig.symbol,
                contractType: marketConfig.contractType,
                stake: `${stake.toFixed(2)} ${currency}`,
                exitDigit,
                result: isWin ? (isVirtual ? 'V-Win' : 'Win') : (isVirtual ? 'V-Loss' : 'Loss'),
                pnl: profit,
                balanceAfter: localBalance + profit,
                switchInfo: isWin ? 'Reset step' : (martingaleEnabled ? `Step ${martingaleStep + 1}` : 'No martingale'),
            }]);
            
            if (netProfit + profit >= tp || netProfit + profit <= -sl) {
                shouldStopRef.current = true;
                setIsRunning(false);
                setBotStatus('idle');
            }
            
            return { win: isWin, profit };
        } catch (error) {
            console.error('Trade failed:', error);
            return null;
        }
    }, [getMartingaleStake, currentMarket, localBalance, currency, martingaleEnabled, martingaleStep, martingaleMaxSteps, incrementMartingale, resetMartingale, inRecovery, netProfit, tp, sl, vhStatus, vhRemainingRealTrades]);

    // ==================== VIRTUAL HOOK LOGIC ====================
    const processVirtualHook = useCallback(async (marketConfig: TMarketConfig, patternMatch: TPatternMatch | null) => {
        if (!vhEnabled || vhStatus !== 'idle') return false;
        
        setBotStatus('virtual_hook');
        setVhStatus('waiting');
        setVhConsecLosses(0);
        
        while (vhConsecLosses < vhVirtualLossesRequired && !shouldStopRef.current) {
            const result = await executeTrade(marketConfig, true, false, false);
            if (!result) break;
            if (!result.win) {
                if (vhConsecLosses + 1 >= vhVirtualLossesRequired) {
                    setVhStatus('confirmed');
                    setVhRemainingRealTrades(vhRealTradesAfterSignal);
                    setBotStatus('pattern_matched');
                    return true;
                }
            } else {
                setVhConsecLosses(0);
            }
        }
        return false;
    }, [vhEnabled, vhStatus, vhConsecLosses, vhVirtualLossesRequired, vhRealTradesAfterSignal, executeTrade]);

    // ==================== MAIN TRADING LOOP ====================
    const tradingLoop = useCallback(async () => {
        if (!isRunning || shouldStopRef.current || tradeInFlightRef.current) return;
        
        const activeMarketConfig = currentMarket === 1 ? m1Config : m2Config;
        
        if (combinedEnabled && !combinedTradeTakenRef.current) {
            const patternMatch = scanAllMarketsForPattern();
            if (patternMatch) {
                combinedTradeTakenRef.current = true;
                setBotStatus('pattern_matched');
                
                const marketConfig: TMarketConfig = {
                    symbol: patternMatch.symbol,
                    contractType: patternMatch.contractType,
                    barrier: patternMatch.barrier,
                };
                
                if (vhEnabled && vhStatus === 'idle') {
                    const hookConfirmed = await processVirtualHook(marketConfig, patternMatch);
                    if (hookConfirmed) {
                        for (let i = 0; i < vhRealTradesAfterSignal; i++) {
                            if (shouldStopRef.current) break;
                            const result = await executeTrade(marketConfig, false, true, false);
                            if (result?.win) break;
                        }
                    }
                } else if (vhStatus === 'confirmed') {
                    const result = await executeTrade(marketConfig, false, true, false);
                    if (result?.win) {
                        setVhStatus('idle');
                    }
                } else {
                    await executeTrade(marketConfig, false, true, false);
                }
                
                combinedTradeTakenRef.current = false;
                setBotStatus(currentMarket === 1 ? 'trading_m1' : (inRecovery ? 'recovery' : 'trading_m1'));
            }
        }
        
        if (scannerEnabled && !combinedTradeTakenRef.current) {
            const patternMatch = scanAllMarketsForPattern();
            if (patternMatch && !patternTradeTakenRef.current) {
                patternTradeTakenRef.current = true;
                setBotStatus('pattern_matched');
                
                const marketConfig: TMarketConfig = {
                    symbol: patternMatch.symbol,
                    contractType: patternMatch.contractType,
                    barrier: patternMatch.barrier,
                };
                
                if (vhEnabled && vhStatus === 'idle') {
                    const hookConfirmed = await processVirtualHook(marketConfig, patternMatch);
                    if (hookConfirmed) {
                        for (let i = 0; i < vhRealTradesAfterSignal; i++) {
                            if (shouldStopRef.current) break;
                            const result = await executeTrade(marketConfig, false, false, false);
                            if (result?.win) break;
                        }
                    }
                } else if (vhStatus === 'confirmed') {
                    const result = await executeTrade(marketConfig, false, false, false);
                    if (result?.win) {
                        setVhStatus('idle');
                    }
                } else {
                    await executeTrade(marketConfig, false, false, false);
                }
                
                patternTradeTakenRef.current = false;
                setBotStatus(currentMarket === 1 ? 'trading_m1' : (inRecovery ? 'recovery' : 'trading_m1'));
            }
        }
        
        const defaultMarketConfig = currentMarket === 1 ? m1Config : m2Config;
        await executeTrade(defaultMarketConfig, false, false, inRecovery);
        
        const delay = turboMode ? 0 : 400;
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        
        if (isRunning && !shouldStopRef.current) {
            setTimeout(() => tradingLoop(), 0);
        }
    }, [isRunning, currentMarket, m1Config, m2Config, combinedEnabled, scannerEnabled, scanAllMarketsForPattern, vhEnabled, vhStatus, processVirtualHook, executeTrade, inRecovery, turboMode]);

    // ==================== WEBSOCKET CONNECTION ====================
    const subscribeToMarket = useCallback(async (symbol: string) => {
        if (!api_base.api) return;
        
        try {
            const history = await api_base.api.send({
                adjust_start_time: 1,
                count: MAX_TICKS,
                end: 'latest',
                start: 1,
                style: 'ticks',
                ticks_history: symbol,
            });
            
            const prices = Array.isArray(history?.history?.prices) ? history.history.prices : [];
            const times = Array.isArray(history?.history?.times) ? history.history.times : [];
            const historyTicks = prices.map((price: number | string, index: number) => ({
                epoch: Number(times[index]) || Math.floor(Date.now() / 1000),
                quote: Number(price),
            })).filter(tick => Number.isFinite(tick.quote)).slice(-MAX_TICKS);
            
            ticksRefs.current.set(symbol, historyTicks);
            
            const observable = (api_base.api as any).subscribe({ ticks: symbol });
            const subscription = safeSubscribe(observable, (data: any) => {
                const quote = Number(data?.tick?.quote);
                if (!Number.isFinite(quote)) return;
                const epoch = Number(data?.tick?.epoch) || Math.floor(Date.now() / 1000);
                const currentTicks = ticksRefs.current.get(symbol) || [];
                const newTicks = [...currentTicks, { epoch, quote }].slice(-MAX_TICKS);
                ticksRefs.current.set(symbol, newTicks);
                
                const digits = newTicks.map(t => getLastDigit(t.quote, symbol));
                setLastDigits(digits.slice(-8));
                
                const freq: TFrequencyStats[] = [];
                for (let i = 0; i <= 9; i++) {
                    const count = digits.filter(d => d === i).length;
                    freq.push({ digit: i, count, percentage: (count / digits.length) * 100 });
                }
                setDigitFrequency(freq);
            });
            
            subscriptionRefs.current.set(symbol, subscription);
        } catch (error) {
            console.error(`Failed to subscribe to ${symbol}:`, error);
        }
    }, []);

    const connectAllMarkets = useCallback(async () => {
        const symbolsToSubscribe = MARKETS.map(m => m.symbol);
        for (const symbol of symbolsToSubscribe) {
            await subscribeToMarket(symbol);
        }
    }, [subscribeToMarket]);

    const disconnectAllMarkets = useCallback(() => {
        for (const [symbol, sub] of subscriptionRefs.current.entries()) {
            try {
                sub?.unsubscribe?.();
            } catch { }
        }
        subscriptionRefs.current.clear();
    }, []);

    // ==================== SAVE/LOAD STATE ====================
    const saveBotState = useCallback(() => {
        const state = {
            currentMarket, currentStake, martingaleStep, wins, losses, netProfit, totalStaked, localBalance,
            inRecovery, vhFakeWins, vhFakeLosses, vhConsecLosses, vhStatus, patternTradeTaken: patternTradeTakenRef.current,
            m1Config, m2Config, configName,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }, [currentMarket, currentStake, martingaleStep, wins, losses, netProfit, totalStaked, localBalance, inRecovery, vhFakeWins, vhFakeLosses, vhConsecLosses, vhStatus, m1Config, m2Config, configName]);

    const loadBotState = useCallback(() => {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            try {
                const state = JSON.parse(saved);
                setCurrentMarket(state.currentMarket);
                setCurrentStake(state.currentStake);
                setMartingaleStep(state.martingaleStep);
                setWins(state.wins);
                setLosses(state.losses);
                setNetProfit(state.netProfit);
                setTotalStaked(state.totalStaked);
                setLocalBalance(state.localBalance);
                setInRecovery(state.inRecovery);
                setVhFakeWins(state.vhFakeWins);
                setVhFakeLosses(state.vhFakeLosses);
                setVhConsecLosses(state.vhConsecLosses);
                setVhStatus(state.vhStatus);
                patternTradeTakenRef.current = state.patternTradeTaken;
                if (state.m1Config) setM1Config(state.m1Config);
                if (state.m2Config) setM2Config(state.m2Config);
                if (state.configName) setConfigName(state.configName);
            } catch { }
        }
    }, []);

    // ==================== SAVE/LOAD CONFIG FILE ====================
    const saveConfigToFile = useCallback(() => {
        const config = {
            name: configName,
            m1: m1Config,
            m2: m2Config,
            baseStake,
            martingaleEnabled,
            martingaleMultiplier,
            martingaleMaxSteps,
            tp,
            sl,
            turboMode,
            scannerEnabled,
            eoPatterns,
            digitPatterns,
            combinedPatterns,
            combinedEnabled,
            vhEnabled,
            vhVirtualLossesRequired,
            vhRealTradesAfterSignal,
            arithmeticEnabled,
            arithmeticCondition,
            arithmeticValue,
            arithmeticLookback,
        };
        const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${configName.replace(/\s/g, '_')}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }, [configName, m1Config, m2Config, baseStake, martingaleEnabled, martingaleMultiplier, martingaleMaxSteps, tp, sl, turboMode, scannerEnabled, eoPatterns, digitPatterns, combinedPatterns, combinedEnabled, vhEnabled, vhVirtualLossesRequired, vhRealTradesAfterSignal, arithmeticEnabled, arithmeticCondition, arithmeticValue, arithmeticLookback]);

    const loadConfigFromFile = useCallback((file: File) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const config = JSON.parse(e.target?.result as string);
                if (config.name) setConfigName(config.name);
                if (config.m1) setM1Config(config.m1);
                if (config.m2) setM2Config(config.m2);
                if (config.baseStake) setBaseStake(config.baseStake);
                if (config.martingaleEnabled !== undefined) setMartingaleEnabled(config.martingaleEnabled);
                if (config.martingaleMultiplier) setMartingaleMultiplier(config.martingaleMultiplier);
                if (config.martingaleMaxSteps) setMartingaleMaxSteps(config.martingaleMaxSteps);
                if (config.tp) setTp(config.tp);
                if (config.sl) setSl(config.sl);
                if (config.turboMode !== undefined) setTurboMode(config.turboMode);
                if (config.scannerEnabled !== undefined) setScannerEnabled(config.scannerEnabled);
                if (config.eoPatterns) setEoPatterns(config.eoPatterns);
                if (config.digitPatterns) setDigitPatterns(config.digitPatterns);
                if (config.combinedPatterns) setCombinedPatterns(config.combinedPatterns);
                if (config.combinedEnabled !== undefined) setCombinedEnabled(config.combinedEnabled);
                if (config.vhEnabled !== undefined) setVhEnabled(config.vhEnabled);
                if (config.vhVirtualLossesRequired) setVhVirtualLossesRequired(config.vhVirtualLossesRequired);
                if (config.vhRealTradesAfterSignal) setVhRealTradesAfterSignal(config.vhRealTradesAfterSignal);
                if (config.arithmeticEnabled !== undefined) setArithmeticEnabled(config.arithmeticEnabled);
                if (config.arithmeticCondition) setArithmeticCondition(config.arithmeticCondition);
                if (config.arithmeticValue) setArithmeticValue(config.arithmeticValue);
                if (config.arithmeticLookback) setArithmeticLookback(config.arithmeticLookback);
            } catch (error) {
                console.error('Failed to load config:', error);
            }
        };
        reader.readAsText(file);
    }, []);

    // ==================== START/STOP BOT ====================
    const startBot = useCallback(async () => {
        if (!api_base.api) return;
        shouldStopRef.current = false;
        patternTradeTakenRef.current = false;
        combinedTradeTakenRef.current = false;
        setIsRunning(true);
        setBotStatus(currentMarket === 1 ? 'trading_m1' : (inRecovery ? 'recovery' : 'trading_m1'));
        await connectAllMarkets();
        tradingLoop();
    }, [connectAllMarkets, tradingLoop, currentMarket, inRecovery]);

    const stopBot = useCallback(() => {
        shouldStopRef.current = true;
        setIsRunning(false);
        setBotStatus('idle');
        saveBotState();
    }, [saveBotState]);

    const clearLogs = useCallback(() => {
        setLogs([]);
    }, []);

    // ==================== CHART DRAGGING ====================
    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        setIsDragging(true);
        setDragOffset({ x: e.clientX - chartPosition.x, y: e.clientY - chartPosition.y });
    }, [chartPosition]);

    const handleMouseMove = useCallback((e: MouseEvent) => {
        if (isDragging) {
            setChartPosition({ x: e.clientX - dragOffset.x, y: e.clientY - dragOffset.y });
        }
    }, [isDragging, dragOffset]);

    const handleMouseUp = useCallback(() => {
        setIsDragging(false);
    }, []);

    useEffect(() => {
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, [handleMouseMove, handleMouseUp]);

    useEffect(() => {
        loadBotState();
        return () => {
            disconnectAllMarkets();
            stopBot();
        };
    }, []);

    if (!showScanner) return null;

    // ==================== RENDER ====================
    return (
        <div className="pro-scanner-bot">
            {/* Header */}
            <div className="bot-header">
                <h1 className="bot-title">PRO SCANNER BOT</h1>
                <div className={`bot-status-badge status-${botStatus}`}>
                    {botStatus.toUpperCase().replace('_', ' ')}
                </div>
                <div className="header-actions">
                    <button className="icon-btn" onClick={() => setShowChartPopup(!showChartPopup)}>📊</button>
                    <button className="icon-btn" onClick={saveConfigToFile}>💾</button>
                    <input type="file" accept=".json" id="load-config-input" style={{ display: 'none' }} onChange={(e) => e.target.files?.[0] && loadConfigFromFile(e.target.files[0])} />
                    <button className="icon-btn" onClick={() => document.getElementById('load-config-input')?.click()}>📂</button>
                    <button className="icon-btn" onClick={clearLogs}>🗑️</button>
                </div>
            </div>

            {/* Main Content */}
            <div className="bot-content">
                {/* Left Panel - Configuration */}
                <div className="config-panel">
                    <div className="config-section">
                        <h3>Bot Configuration</h3>
                        <div className="config-row">
                            <label>Config Name:</label>
                            <input type="text" value={configName} onChange={(e) => setConfigName(e.target.value)} className="config-input" />
                        </div>
                    </div>

                    <div className="config-section">
                        <h3>Market M1 (Home)</h3>
                        <select value={m1Config.symbol} onChange={(e) => setM1Config({ ...m1Config, symbol: e.target.value })} className="config-select">
                            {MARKETS.map(m => <option key={m.symbol} value={m.symbol}>{m.label}</option>)}
                        </select>
                        <select value={m1Config.contractType} onChange={(e) => setM1Config({ ...m1Config, contractType: e.target.value as TContractType })} className="config-select">
                            {CONTRACT_TYPES.map(ct => <option key={ct.value} value={ct.value}>{ct.label}</option>)}
                        </select>
                        <input type="number" min="0" max="9" value={m1Config.barrier} onChange={(e) => setM1Config({ ...m1Config, barrier: e.target.value })} className="config-input" placeholder="Barrier (0-9)" />
                    </div>

                    <div className="config-section">
                        <h3>Market M2 (Recovery)</h3>
                        <select value={m2Config.symbol} onChange={(e) => setM2Config({ ...m2Config, symbol: e.target.value })} className="config-select">
                            {MARKETS.map(m => <option key={m.symbol} value={m.symbol}>{m.label}</option>)}
                        </select>
                        <select value={m2Config.contractType} onChange={(e) => setM2Config({ ...m2Config, contractType: e.target.value as TContractType })} className="config-select">
                            {CONTRACT_TYPES.map(ct => <option key={ct.value} value={ct.value}>{ct.label}</option>)}
                        </select>
                        <input type="number" min="0" max="9" value={m2Config.barrier} onChange={(e) => setM2Config({ ...m2Config, barrier: e.target.value })} className="config-input" placeholder="Barrier (0-9)" />
                    </div>

                    <div className="config-section">
                        <h3>Risk Management</h3>
                        <div className="config-row">
                            <label>Base Stake (${0.35} min):</label>
                            <input type="number" min="0.35" step="0.01" value={baseStake} onChange={(e) => setBaseStake(parseFloat(e.target.value))} className="config-input" />
                        </div>
                        <div className="config-row">
                            <label>Take Profit:</label>
                            <input type="number" value={tp} onChange={(e) => setTp(parseFloat(e.target.value))} className="config-input" />
                        </div>
                        <div className="config-row">
                            <label>Stop Loss:</label>
                            <input type="number" value={sl} onChange={(e) => setSl(parseFloat(e.target.value))} className="config-input" />
                        </div>
                        <div className="config-row">
                            <label>
                                <input type="checkbox" checked={martingaleEnabled} onChange={(e) => setMartingaleEnabled(e.target.checked)} />
                                Martingale
                            </label>
                            {martingaleEnabled && (
                                <>
                                    <input type="number" step="0.1" value={martingaleMultiplier} onChange={(e) => setMartingaleMultiplier(parseFloat(e.target.value))} className="config-input-sm" />
                                    <input type="number" min="1" max="10" value={martingaleMaxSteps} onChange={(e) => setMartingaleMaxSteps(parseInt(e.target.value))} className="config-input-sm" />
                                </>
                            )}
                        </div>
                    </div>

                    <div className="config-section">
                        <h3>Pattern Recognition</h3>
                        <div className="config-row">
                            <label>
                                <input type="checkbox" checked={scannerEnabled} onChange={(e) => setScannerEnabled(e.target.checked)} />
                                Scanner Mode
                            </label>
                            <label>
                                <input type="checkbox" checked={combinedEnabled} onChange={(e) => setCombinedEnabled(e.target.checked)} />
                                Combined Strategy
                            </label>
                            <label>
                                <input type="checkbox" checked={turboMode} onChange={(e) => setTurboMode(e.target.checked)} />
                                Turbo Mode
                            </label>
                        </div>
                        <div className="config-row">
                            <label>EO Patterns:</label>
                            <input type="text" value={eoPatterns.join(', ')} onChange={(e) => setEoPatterns(e.target.value.split(',').map(s => s.trim()))} className="config-input" />
                        </div>
                        <div className="config-row">
                            <label>Digit Patterns:</label>
                            <input type="text" value={digitPatterns.join(', ')} onChange={(e) => setDigitPatterns(e.target.value.split(',').map(s => s.trim()))} className="config-input" />
                        </div>
                        <div className="config-row">
                            <label>Combined Patterns:</label>
                            <input type="text" value={combinedPatterns.join(', ')} onChange={(e) => setCombinedPatterns(e.target.value.split(',').map(s => s.trim()))} className="config-input" />
                        </div>
                    </div>

                    <div className="config-section">
                        <h3>Virtual Hook</h3>
                        <div className="config-row">
                            <label>
                                <input type="checkbox" checked={vhEnabled} onChange={(e) => setVhEnabled(e.target.checked)} />
                                Enable Virtual Hook
                            </label>
                        </div>
                        {vhEnabled && (
                            <>
                                <div className="config-row">
                                    <label>Virtual Losses Required:</label>
                                    <input type="number" min="1" max="20" value={vhVirtualLossesRequired} onChange={(e) => setVhVirtualLossesRequired(parseInt(e.target.value))} className="config-input" />
                                </div>
                                <div className="config-row">
                                    <label>Real Trades After Signal:</label>
                                    <input type="number" min="1" max="10" value={vhRealTradesAfterSignal} onChange={(e) => setVhRealTradesAfterSignal(parseInt(e.target.value))} className="config-input" />
                                </div>
                            </>
                        )}
                    </div>

                    <button className={`start-stop-btn ${isRunning ? 'stop' : 'start'}`} onClick={isRunning ? stopBot : startBot}>
                        {isRunning ? 'STOP BOT' : 'START BOT'}
                    </button>
                </div>

                {/* Center Panel - Live Digits & Stats */}
                <div className="live-panel">
                    <div className="stats-grid">
                        <div className="stat-card">
                            <span className="stat-label">Balance</span>
                            <span className="stat-value">{localBalance.toFixed(2)} {currency}</span>
                        </div>
                        <div className="stat-card">
                            <span className="stat-label">Net P&L</span>
                            <span className={`stat-value ${netProfit >= 0 ? 'profit' : 'loss'}`}>{netProfit >= 0 ? '+' : ''}{netProfit.toFixed(2)}</span>
                        </div>
                        <div className="stat-card">
                            <span className="stat-label">Win Rate</span>
                            <span className="stat-value">{wins + losses > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : 0}%</span>
                        </div>
                        <div className="stat-card">
                            <span className="stat-label">Current Stake</span>
                            <span className="stat-value">{getMartingaleStake().toFixed(2)}</span>
                        </div>
                        <div className="stat-card">
                            <span className="stat-label">Martingale Step</span>
                            <span className="stat-value">{martingaleStep}/{martingaleMaxSteps}</span>
                        </div>
                        <div className="stat-card">
                            <span className="stat-label">Market</span>
                            <span className="stat-value">{inRecovery ? 'M2 (Recovery)' : `M1 (Home)`}</span>
                        </div>
                    </div>

                    <div className="digits-strip">
                        <h4>Last 8 Digits</h4>
                        <div className="digits-container">
                            {lastDigits.map((digit, idx) => (
                                <div key={idx} className={`digit-box ${digit >= 5 ? 'over' : 'under'} ${idx === lastDigits.length - 1 ? 'latest' : ''}`}>
                                    {digit}
                                    <span className="eo-indicator">{digit % 2 === 0 ? 'E' : 'O'}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="activity-log">
                        <h4>Activity Log</h4>
                        <div className="log-table-container">
                            <table className="log-table">
                                <thead>
                                    <tr><th>Time</th><th>Market</th><th>Symbol</th><th>Type</th><th>Stake</th><th>Exit</th><th>Result</th><th>P&L</th></tr>
                                </thead>
                                <tbody>
                                    {logs.slice().reverse().slice(0, 20).map((log, idx) => (
                                        <tr key={idx} className={log.result.includes('Win') ? 'win-row' : (log.result.includes('Loss') ? 'loss-row' : '')}>
                                            <td>{log.time}</td>
                                            <td>{log.market}</td>
                                            <td>{log.symbol}</td>
                                            <td>{log.contractType}</td>
                                            <td>{log.stake}</td>
                                            <td>{log.exitDigit}</td>
                                            <td>{log.result}</td>
                                            <td className={log.pnl >= 0 ? 'profit' : 'loss'}>{log.pnl >= 0 ? '+' : ''}{log.pnl.toFixed(2)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>

            {/* Draggable Chart Popup */}
            {showChartPopup && (
                <div ref={chartPopupRef} className="chart-popup" style={{ left: chartPosition.x, top: chartPosition.y }}>
                    <div className="chart-header" onMouseDown={handleMouseDown}>
                        <span>Digit Frequency Analysis</span>
                        <button onClick={() => setShowChartPopup(false)}>✕</button>
                    </div>
                    <div className="chart-body">
                        <div className="frequency-bars">
                            {digitFrequency.map(freq => (
                                <div key={freq.digit} className="bar-container">
                                    <div className="bar-label">{freq.digit}</div>
                                    <div className="bar" style={{ height: `${freq.percentage * 2}px`, width: '30px', background: '#00ff00' }}></div>
                                    <div className="bar-value">{freq.percentage.toFixed(1)}%</div>
                                </div>
                            ))}
                        </div>
                        <div className="stats-summary">
                            <div>Most Common: {digitFrequency.reduce((a, b) => a.count > b.count ? a : b)?.digit ?? '?'}</div>
                            <div>Least Common: {digitFrequency.reduce((a, b) => a.count < b.count ? a : b)?.digit ?? '?'}</div>
                            <div>Even %: {digitFrequency.filter(d => d.digit % 2 === 0).reduce((a, b) => a + b.percentage, 0).toFixed(1)}%</div>
                            <div>Odd %: {digitFrequency.filter(d => d.digit % 2 !== 0).reduce((a, b) => a + b.percentage, 0).toFixed(1)}%</div>
                            <div>Over 4: {digitFrequency.filter(d => d.digit > 4).reduce((a, b) => a + b.percentage, 0).toFixed(1)}%</div>
                            <div>Under 5: {digitFrequency.filter(d => d.digit < 5).reduce((a, b) => a + b.percentage, 0).toFixed(1)}%</div>
                        </div>
                    </div>
                </div>
            )}

            {/* Social Popup */}
            {showSocialPopup && (
                <div className="social-popup">
                    <div className="social-content">
                        <button className="social-close" onClick={() => setShowSocialPopup(false)}>✕</button>
                        <h3>Connect With Us</h3>
                        <div className="social-links">
                            <a href="https://whatsapp.com" target="_blank" rel="noopener noreferrer">📱 WhatsApp</a>
                            <a href="https://telegram.org" target="_blank" rel="noopener noreferrer">✈️ Telegram</a>
                            <a href="https://youtube.com" target="_blank" rel="noopener noreferrer">▶️ YouTube</a>
                            <a href="https://tiktok.com" target="_blank" rel="noopener noreferrer">🎵 TikTok</a>
                            <a href="https://instagram.com" target="_blank" rel="noopener noreferrer">📷 Instagram</a>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
});

export default Scanner;
```
