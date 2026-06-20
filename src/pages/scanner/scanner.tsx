import { useCallback, useEffect, useRef, useState } from 'react';
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

type TTickPoint = {
    epoch: number;
    quote: number;
};

type TScannerStrategy = 'Matches & Differs' | 'Even & Odd' | 'Over & Under' | 'Rise & Fall';
type TScannerMode = 'Analyze' | 'Trade';

// Updated TScannerSignal to include recovery properties
type TScannerSignal = {
    barrier?: string;
    contractType: 'DIGITEVEN' | 'DIGITODD' | 'DIGITOVER' | 'DIGITUNDER' | 'DIGITMATCH' | 'DIGITDIFF' | 'CALL' | 'PUT';
    label: string;
    // Recovery properties for Over & Under strategy
    recoveryBarrier?: string;
    recoveryContractType?: 'DIGITOVER' | 'DIGITUNDER';
    recoveryLabel?: string;
};

const MAX_TICKS = 1000;
const DEFAULT_STAKE = '10';
const DEFAULT_STOP_LOSS = '500';
const DEFAULT_TAKE_PROFIT = '500';
const DEFAULT_MARTINGALE_MULTIPLIER = 2;
const DEFAULT_RUNS_TO_CHECK = '5';
const TIMER_SOUND_URL = 'https://www.fesliyanstudios.com/play-mp3/4386';

// Martingale multiplier from 1 to 10 with 0.1 increments
const MARTINGALE_MULTIPLIERS = [1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0, 2.2, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0];

const MARKETS = [
    { label: 'Volatility 10 Index', symbol: 'R_10' },
    { label: 'Volatility 25 Index', symbol: 'R_25' },
    { label: 'Volatility 50 Index', symbol: 'R_50' },
    { label: 'Volatility 75 Index', symbol: 'R_75' },
    { label: 'Volatility 100 Index', symbol: 'R_100' },
    { label: 'Volatility 10(1s) Index', symbol: '1HZ10V' },
    { label: 'Volatility 25(1s) Index', symbol: '1HZ25V' },
    { label: 'Volatility 50(1s) Index', symbol: '1HZ50V' },
    { label: 'Volatility 75(1s) Index', symbol: '1HZ75V' },
    { label: 'Volatility 100(1s) Index', symbol: '1HZ100V' },
];

const STRATEGIES: TScannerStrategy[] = ['Matches & Differs', 'Even & Odd', 'Over & Under', 'Rise & Fall'];

const cleanMoneyInput = (value: string) => value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');

const cleanNumberInput = (value: string) => value.replace(/[^\d]/g, '');

const generateRandomCode = () => {
    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$#@!%^&*()';
    let result = '';
    for (let i = 0; i < 40; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
};

const generateFakeLogs = () => {
    const logs = [
        '[INFO] Connecting to server... [OK]',
        '[INFO] Authenticating API key... [OK]',
        '[WARNING] Unstable connection detected...',
        '[ERROR] Connection timeout. Retrying...',
        '[INFO] Fetching market data... [OK]',
        '[INFO] Analysing Volatility Index...',
        '[SUCCESS] Data stream established...',
        '[SECURITY] Encryption enabled...',
        '[INFO] Predicting next digit...',
        '[WARNING] High market volatility detected...',
        '[INFO] Compiling results...',
        '[INFO] Data transmission complete...',
    ];
    let line = '';
    for (let i = 0; i < 10; i++) {
        line += `${logs[Math.floor(Math.random() * logs.length)]} `;
    }
    return line;
};

// Helper function to get sorted digits by frequency (least to most common)
const getSortedDigitsByFrequency = (digits: number[]): number[] => {
    const counts: Record<number, number> = {};
    for (const digit of digits) {
        counts[digit] = (counts[digit] || 0) + 1;
    }
    
    return Object.entries(counts)
        .sort((a, b) => a[1] - b[1])
        .map(entry => Number(entry[0]));
};

// FIXED: Over & Under analysis with correct digit ranges
// OVER: 0-4 (Over 0, Over 1, Over 2, Over 3, Over 4)
// UNDER: 5-9 (Under 5, Under 6, Under 7, Under 8, Under 9)
const buildOverUnderAnalysis = (ticks: TTickPoint[], symbol: string) => {
    const lastDigits = ticks.slice(-MAX_TICKS).map(tick => getLastDigitFromQuote(tick.quote, symbol));
    const sampleSize = Math.max(lastDigits.length, 1);
    const lines: string[] = ['Analysis Complete!'];
    
    // Count OVER (0-4) and UNDER (5-9)
    let overCount = 0;
    let underCount = 0;
    const overDigits: number[] = [];
    const underDigits: number[] = [];

    for (const digit of lastDigits) {
        if (digit >= 0 && digit <= 4) {
            overCount++;
            overDigits.push(digit);
        } else if (digit >= 5 && digit <= 9) {
            underCount++;
            underDigits.push(digit);
        }
    }

    const overPercentage = sampleSize > 0 ? ((overCount / sampleSize) * 100).toFixed(2) : '0.00';
    const underPercentage = sampleSize > 0 ? ((underCount / sampleSize) * 100).toFixed(2) : '0.00';

    let signal: TScannerSignal;
    
    // Determine which side is less frequent (that's our primary signal)
    if (overCount < underCount) {
        // OVER is the primary signal (less common)
        const sortedOverDigits = getSortedDigitsByFrequency(overDigits);
        
        // PRIMARY: Least common OVER digit (0-4 range)
        const primaryOver = sortedOverDigits[0] ?? 0;
        
        // RECOVERY: Second least common OVER digit (0-4 range)
        // If only one digit exists, default to a different digit in 0-4 range
        let recoveryOver = sortedOverDigits[1] ?? (primaryOver < 4 ? primaryOver + 1 : primaryOver - 1);
        // Ensure recovery is different from primary and in range 0-4
        if (recoveryOver === primaryOver) {
            recoveryOver = primaryOver < 4 ? primaryOver + 1 : primaryOver - 1;
        }
        // Clamp to 0-4 range
        recoveryOver = Math.max(0, Math.min(4, recoveryOver));
        
        lines.push(`📊 OVER dominates with ${overPercentage}% (${overCount} occurrences)`);
        lines.push(`🎯 Primary Signal: OVER ${primaryOver} (least common in 0-4)`);
        lines.push(`🔄 Recovery Signal: OVER ${recoveryOver} (second least common in 0-4)`);
        lines.push(`📈 Entry Points: ${getRandomEntryPoints(3).join(', ')}`);
        lines.push(`💡 Strategy: Trade OVER ${primaryOver}, if loss recover with OVER ${recoveryOver}`);
        
        signal = { 
            barrier: String(primaryOver), 
            contractType: 'DIGITOVER', 
            label: `Over ${primaryOver}`,
            recoveryBarrier: String(recoveryOver),
            recoveryContractType: 'DIGITOVER',
            recoveryLabel: `Over ${recoveryOver}`
        };
        
    } else if (underCount < overCount) {
        // UNDER is the primary signal (less common)
        const sortedUnderDigits = getSortedDigitsByFrequency(underDigits);
        
        // PRIMARY: Least common UNDER digit (5-9 range)
        const primaryUnder = sortedUnderDigits[0] ?? 5;
        
        // RECOVERY: Second least common UNDER digit (5-9 range)
        let recoveryUnder = sortedUnderDigits[1] ?? (primaryUnder < 9 ? primaryUnder + 1 : primaryUnder - 1);
        // Ensure recovery is different from primary and in range 5-9
        if (recoveryUnder === primaryUnder) {
            recoveryUnder = primaryUnder < 9 ? primaryUnder + 1 : primaryUnder - 1;
        }
        // Clamp to 5-9 range
        recoveryUnder = Math.max(5, Math.min(9, recoveryUnder));
        
        lines.push(`📊 UNDER dominates with ${underPercentage}% (${underCount} occurrences)`);
        lines.push(`🎯 Primary Signal: UNDER ${primaryUnder} (least common in 5-9)`);
        lines.push(`🔄 Recovery Signal: UNDER ${recoveryUnder} (second least common in 5-9)`);
        lines.push(`📈 Entry Points: ${getRandomEntryPoints(3).join(', ')}`);
        lines.push(`💡 Strategy: Trade UNDER ${primaryUnder}, if loss recover with UNDER ${recoveryUnder}`);
        
        signal = { 
            barrier: String(primaryUnder), 
            contractType: 'DIGITUNDER', 
            label: `Under ${primaryUnder}`,
            recoveryBarrier: String(recoveryUnder),
            recoveryContractType: 'DIGITUNDER',
            recoveryLabel: `Under ${recoveryUnder}`
        };
        
    } else {
        // Equal counts or no data - default to OVER 2 with recovery OVER 3
        lines.push(`📊 Equal distribution between OVER and UNDER`);
        lines.push(`🎯 Default Primary Signal: OVER 2`);
        lines.push(`🔄 Default Recovery Signal: OVER 3`);
        lines.push(`💡 Strategy: Trade OVER 2, if loss recover with OVER 3`);
        
        signal = { 
            barrier: '2', 
            contractType: 'DIGITOVER', 
            label: 'Over 2',
            recoveryBarrier: '3',
            recoveryContractType: 'DIGITOVER',
            recoveryLabel: 'Over 3'
        };
    }

    return { lines, signal };
};

// Modified buildAnalysis to use the new Over & Under logic
const buildAnalysis = (strategy: TScannerStrategy, ticks: TTickPoint[], symbol: string) => {
    const lastDigits = ticks.slice(-MAX_TICKS).map(tick => getLastDigitFromQuote(tick.quote, symbol));
    const sampleSize = Math.max(lastDigits.length, 1);
    const lines: string[] = ['Analysis Complete!'];
    let signal: TScannerSignal = { contractType: 'DIGITDIFF', label: 'Differs 0', barrier: '0' };

    if (strategy === 'Matches & Differs') {
        const digitCounts: Record<number, number> = {};
        for (const digit of lastDigits) {
            digitCounts[digit] = (digitCounts[digit] || 0) + 1;
        }

        let mostCommonDigit = 0;
        let leastCommonDigit = 0;
        let maxCount = 0;
        let minCount = Infinity;

        for (const digit in digitCounts) {
            if (digitCounts[digit] > maxCount) {
                maxCount = digitCounts[digit];
                mostCommonDigit = Number(digit);
            }
            if (digitCounts[digit] < minCount) {
                minCount = digitCounts[digit];
                leastCommonDigit = Number(digit);
            }
        }

        const matchPercentage = ((maxCount / sampleSize) * 100).toFixed(2);
        const differPercentage = ((minCount / sampleSize) * 100).toFixed(2);
        lines.push(`MATCH with ${mostCommonDigit} (${matchPercentage}% accuracy)`);
        lines.push(`DIFFERS with ${leastCommonDigit} (${differPercentage}% accuracy)`);
        signal = { barrier: String(leastCommonDigit), contractType: 'DIGITDIFF', label: `Differs ${leastCommonDigit}` };
    } else if (strategy === 'Even & Odd') {
        let evenCount = 0;
        let oddCount = 0;

        for (const digit of lastDigits) {
            if (digit % 2 === 0) evenCount++;
            else oddCount++;
        }

        const evenPercentage = ((evenCount / sampleSize) * 100).toFixed(2);
        const oddPercentage = ((oddCount / sampleSize) * 100).toFixed(2);

        if (evenCount > oddCount) {
            lines.push(`EVEN numbers dominate (${evenPercentage}%)`);
            lines.push(getRandomEntryPoints(3).join(', '));
            lines.push('Entry Point: Run your bot whenever an even number appears after a sequence of 3 or more consecutive odd numbers.');
            signal = { contractType: 'DIGITEVEN', label: 'Even' };
        } else {
            lines.push(`ODD numbers dominate (${oddPercentage}%)`);
            lines.push(getRandomEntryPoints(3).join(', '));
            lines.push('Entry Point: Run your bot whenever an odd number appears after a sequence of 3 or more consecutive even numbers.');
            signal = { contractType: 'DIGITODD', label: 'Odd' };
        }
    } else if (strategy === 'Over & Under') {
        // Use the new enhanced Over & Under analysis
        const result = buildOverUnderAnalysis(ticks, symbol);
        return result;
    } else {
        let ups = 0;
        let downs = 0;

        for (let i = 1; i < ticks.length; i++) {
            if (ticks[i].quote > ticks[i - 1].quote) ups++;
            else if (ticks[i].quote < ticks[i - 1].quote) downs++;
        }

        const prediction = ups > downs ? 'RISE' : 'FALL';
        lines.push(`Market will ${prediction}`);
        lines.push(`Entry Point: ${ups > downs ? 'Enter when price crosses above resistance' : 'Enter when price crosses below support'}`);
        signal = {
            contractType: ups > downs ? 'CALL' : 'PUT',
            label: ups > downs ? 'Rise' : 'Fall',
        };
    }

    return { lines, signal };
};

const getRandomEntryPoints = (count: number) => {
    const entryPoints: number[] = [];
    for (let i = 0; i < count; i++) {
        entryPoints.push(Math.floor(Math.random() * 10));
    }
    return entryPoints;
};

const getQuoteFromTick = (data: any): TTickPoint | null => {
    const quote = Number(data?.tick?.quote);
    if (!Number.isFinite(quote)) return null;

    return {
        epoch: Number(data?.tick?.epoch) || Math.floor(Date.now() / 1000),
        quote,
    };
};

const Scanner = observer(() => {
    const { client, dashboard, run_panel, summary_card, transactions } = useStore();
    const { isDesktop } = useDevice();
    const { active_tab } = dashboard;
    const [selectedSymbol, setSelectedSymbol] = useState('R_10');
    const [strategy, setStrategy] = useState<TScannerStrategy>('Over & Under');
    const [mode, setMode] = useState<TScannerMode>('Trade');
    const [stakeInput, setStakeInput] = useState(DEFAULT_STAKE);
    const [stopLossInput, setStopLossInput] = useState(DEFAULT_STOP_LOSS);
    const [takeProfitInput, setTakeProfitInput] = useState(DEFAULT_TAKE_PROFIT);
    const [martingaleMultiplier, setMartingaleMultiplier] = useState(DEFAULT_MARTINGALE_MULTIPLIER);
    const [runsToCheckInput, setRunsToCheckInput] = useState(DEFAULT_RUNS_TO_CHECK);
    const [ticks, setTicks] = useState<TTickPoint[]>([]);
    const [popupOpen, setPopupOpen] = useState(false);
    const [terminalDashboard, setTerminalDashboard] = useState<string[]>(['Analysis Dashboard']);
    const [terminalBody, setTerminalBody] = useState<string[]>(['Connecting to server...']);
    const [scrollingText, setScrollingText] = useState('');
    const [isWorking, setIsWorking] = useState(false);
    const [sessionProfit, setSessionProfit] = useState(0);
    const subscriptionRef = useRef<{ unsubscribe?: () => void } | null>(null);
    const requestVersionRef = useRef(0);
    const ticksRef = useRef<TTickPoint[]>([]);
    const shouldStopRef = useRef(false);
    const tradeActiveRef = useRef(false);
    const tradeInFlightRef = useRef(false);
    const completedRunsRef = useRef(0);
    const sessionProfitRef = useRef(0);
    const stakeRef = useRef(0);
    const stopLossRef = useRef(0);
    const takeProfitRef = useRef(0);
    const runsToCheckRef = useRef(5);
    const strategyRef = useRef<TScannerStrategy>(strategy);
    const selectedSymbolRef = useRef(selectedSymbol);
    const handleTradeTickRef = useRef<(currentTicks: TTickPoint[]) => void>(() => undefined);
    const timerSoundRef = useRef<HTMLAudioElement | null>(null);
    
    // Martingale state refs
    const currentMartingaleStakeRef = useRef(0);
    const baseStakeRef = useRef(0);
    const martingaleMultiplierRef = useRef(DEFAULT_MARTINGALE_MULTIPLIER);
    const consecutiveLossesRef = useRef(0);
    
    // Recovery signal tracking
    const isRecoveryTradeRef = useRef(false);
    const recoverySignalRef = useRef<TScannerSignal | null>(null);
    const primarySignalRef = useRef<TScannerSignal | null>(null);
    const consecutiveRecoveryLossesRef = useRef(0);
    
    const currency = client.currency || 'USD';
    const showScanner = active_tab === DBOT_TABS.SCANNER;
    const isCoveredByMobileRunPanel = !isDesktop && run_panel.is_drawer_open;
    const selectedMarket = MARKETS.find(market => market.symbol === selectedSymbol) ?? MARKETS[0];
    const latestTick = ticks[ticks.length - 1];
    const latestDigit = latestTick ? getLastDigitFromQuote(latestTick.quote, selectedSymbol) : null;
    const canAnalyze = ticks.length >= MAX_TICKS;

    useEffect(() => {
        ticksRef.current = ticks;
    }, [ticks]);

    useEffect(() => {
        strategyRef.current = strategy;
    }, [strategy]);

    useEffect(() => {
        selectedSymbolRef.current = selectedSymbol;
    }, [selectedSymbol]);
    
    useEffect(() => {
        martingaleMultiplierRef.current = martingaleMultiplier;
    }, [martingaleMultiplier]);

    useEffect(() => {
        runsToCheckRef.current = parseInt(runsToCheckInput) || 5;
    }, [runsToCheckInput]);

    useEffect(() => {
        timerSoundRef.current = new Audio(TIMER_SOUND_URL);
        timerSoundRef.current.preload = 'auto';
        timerSoundRef.current.loop = true;

        return () => {
            timerSoundRef.current?.pause();
            timerSoundRef.current = null;
        };
    }, []);

    const stopTimerSound = useCallback(() => {
        const sound = timerSoundRef.current;
        if (!sound) return;
        sound.pause();
        sound.currentTime = 0;
    }, []);

    const playTimerSound = useCallback(() => {
        const sound = timerSoundRef.current;
        if (!sound) return;

        sound.currentTime = 0;
        sound.loop = true;
        const playPromise = sound.play();

        if (playPromise) {
            playPromise.catch(() => {
                const enableSound = () => {
                    sound.play().catch(() => undefined);
                };
                document.addEventListener('click', enableSound, { once: true });
            });
        }
    }, []);

    useEffect(() => {
        if (!showScanner) return undefined;

        const updateScrollingText = () => {
            let text = '';
            for (let i = 0; i < 100; i++) {
                text += `${generateFakeLogs()}\n`;
            }
            setScrollingText(text + text);
        };

        updateScrollingText();
        const interval = setInterval(updateScrollingText, 200);
        return () => clearInterval(interval);
    }, [showScanner]);

    const unsubscribe = useCallback(() => {
        try {
            subscriptionRef.current?.unsubscribe?.();
        } catch {
            // Ignore old scanner streams that are already closed.
        }
        subscriptionRef.current = null;
    }, []);

    const stopTrading = useCallback(() => {
        shouldStopRef.current = true;
        tradeActiveRef.current = false;
        setIsWorking(false);
        stopTimerSound();
        
        // Reset martingale state on stop
        consecutiveLossesRef.current = 0;
        currentMartingaleStakeRef.current = baseStakeRef.current;
        consecutiveRecoveryLossesRef.current = 0;
        isRecoveryTradeRef.current = false;
        recoverySignalRef.current = null;
        primarySignalRef.current = null;

        try {
            run_panel.setIsRunning(false);
            run_panel.setContractStage?.(contract_stages.NOT_RUNNING);
        } catch {
            // Run panel can be unavailable while the app is still initializing.
        }

        dashboard.setActiveTradingModule(null);
    }, [dashboard, run_panel, stopTimerSound]);

    // Manual stop button handler - stops the bot gracefully but doesn't close the popup
    const handleStopBot = useCallback(() => {
        if (tradeActiveRef.current || isWorking) {
            stopTrading();
            setTerminalDashboard(prev => [...prev, '[USER] Bot manually stopped by user.']);
        }
    }, [stopTrading, isWorking]);

    const applyLiveTick = useCallback((tick: TTickPoint) => {
        const nextTicks = [...ticksRef.current, tick].slice(-MAX_TICKS);
        ticksRef.current = nextTicks;
        setTicks(nextTicks);
        handleTradeTickRef.current(nextTicks);
    }, []);

    const loadMarketData = useCallback(async () => {
        unsubscribe();

        if (!showScanner || !api_base.api) {
            return;
        }

        const requestVersion = requestVersionRef.current + 1;
        requestVersionRef.current = requestVersion;
        setTicks([]);
        ticksRef.current = [];

        try {
            const history = await api_base.api.send({
                adjust_start_time: 1,
                count: MAX_TICKS,
                end: 'latest',
                start: 1,
                style: 'ticks',
                ticks_history: selectedSymbol,
            });

            if (requestVersionRef.current !== requestVersion) return;

            const prices = Array.isArray(history?.history?.prices) ? history.history.prices : [];
            const times = Array.isArray(history?.history?.times) ? history.history.times : [];
            const historyTicks = prices
                .map((price: number | string, index: number) => ({
                    epoch: Number(times[index]) || Math.floor(Date.now() / 1000),
                    quote: Number(price),
                }))
                .filter((tick: TTickPoint) => Number.isFinite(tick.quote))
                .slice(-MAX_TICKS);

            ticksRef.current = historyTicks;
            setTicks(historyTicks);

            const observable = (api_base.api as any).subscribe({ ticks: selectedSymbol });
            subscriptionRef.current = safeSubscribe(observable, (data: any) => {
                if (requestVersionRef.current !== requestVersion) return;
                const tick = getQuoteFromTick(data);
                if (!tick) return;
                applyLiveTick(tick);
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unable to load scanner ticks.';
            setTerminalDashboard([`Error: ${message}`]);
            setPopupOpen(true);
        }
    }, [applyLiveTick, selectedSymbol, showScanner, unsubscribe]);

    useEffect(() => {
        void loadMarketData();
        return () => {
            requestVersionRef.current += 1;
            unsubscribe();
        };
    }, [loadMarketData, unsubscribe]);

    useEffect(() => {
        if (!showScanner) return undefined;

        dashboard.registerTradingStopHandler('scanner', stopTrading);
        globalObserver.register('bot.manual_stop', stopTrading);

        return () => {
            dashboard.unregisterTradingStopHandler('scanner');
            if (globalObserver.isRegistered('bot.manual_stop')) {
                globalObserver.unregister('bot.manual_stop', stopTrading);
            }
            shouldStopRef.current = true;
            tradeActiveRef.current = false;
        };
    }, [dashboard, showScanner, stopTrading]);

    const pushContract = useCallback(
        (data: any) => {
            try {
                transactions.pushTransaction({ ...data, run_id: run_panel.run_id });
                run_panel.onBotContractEvent(data);
                summary_card.onBotContractEvent(data);
            } catch {
                // Scanner trades should not fail because a side panel observer is unavailable.
            }
        },
        [run_panel, summary_card, transactions]
    );

    const buildTradeParameters = useCallback(
        (signal: TScannerSignal, stake: number) => {
            const parameters: Record<string, number | string> = {
                amount: stake,
                basis: 'stake',
                contract_type: signal.contractType,
                currency,
                duration: 1,
                duration_unit: 't',
                symbol: selectedSymbol,
            };

            if (signal.barrier) parameters.barrier = signal.barrier;
            return parameters;
        },
        [currency, selectedSymbol]
    );

    const runSingleTrade = useCallback(
        async (signal: TScannerSignal, stake: number): Promise<number> => {
            const tradeStartTime = Math.floor(Date.now() / 1000);
            const fallbackContract = {
                buy_price: stake,
                date_start: tradeStartTime,
                display_name: selectedMarket.label,
                underlying_symbol: selectedSymbol,
                shortcode: `SCANNER_${signal.contractType}_${selectedSymbol}`,
                contract_type: signal.contractType,
                currency,
            };

            setTerminalDashboard(previous => [...previous, `Buying ${signal.label} with ${stake.toFixed(2)} ${currency} (Martingale step: ${consecutiveLossesRef.current})...`]);
            const buy = await buyContractForUi({
                parameters: buildTradeParameters(signal, stake),
                price: stake,
                source: 'Scanner',
            });
            const buySnapshot = {
                ...fallbackContract,
                buy_price: buy.buy_price,
                contract_id: buy.contract_id,
                transaction_ids: { buy: buy.transaction_id },
            };

            pushContract(buySnapshot);
            const settledContract = await streamContractUntilSettled({
                contractId: buy.contract_id,
                fallback: buySnapshot,
                onUpdate: snapshot => pushContract(snapshot),
                source: 'Scanner',
            });

            return Number(settledContract.profit ?? 0);
        },
        [buildTradeParameters, currency, pushContract, selectedMarket.label, selectedSymbol]
    );

    // Execute trade with recovery logic for Over & Under
    const executeTradeWithRecovery = useCallback(
        async (primarySignal: TScannerSignal, recoverySignal: TScannerSignal, currentTicks: TTickPoint[]) => {
            if (!tradeActiveRef.current || tradeInFlightRef.current || shouldStopRef.current || currentTicks.length < MAX_TICKS) {
                return;
            }

            // Stop if stop loss is reached
            if (sessionProfitRef.current <= -stopLossRef.current) {
                setTerminalDashboard(previous => [
                    ...previous,
                    `STOP LOSS REACHED! P/L: ${sessionProfitRef.current.toFixed(2)} ${currency}`,
                ]);
                stopTrading();
                return;
            }

            // Stop if take profit is reached
            if (sessionProfitRef.current >= takeProfitRef.current) {
                setTerminalDashboard(previous => [
                    ...previous,
                    `TAKE PROFIT REACHED! P/L: ${sessionProfitRef.current.toFixed(2)} ${currency}`,
                ]);
                stopTrading();
                return;
            }

            // Check if we've reached the required number of runs
            if (completedRunsRef.current >= runsToCheckRef.current) {
                if (sessionProfitRef.current <= 0.1) {
                    setTerminalDashboard(previous => [
                        ...previous,
                        `${runsToCheckRef.current} runs completed but profit (${sessionProfitRef.current.toFixed(2)} ${currency}) <= 0.1. Continuing until profit > 0.1...`,
                    ]);
                } else {
                    setTerminalDashboard(previous => [
                        ...previous,
                        `${runsToCheckRef.current} runs complete with profit > 0.1: ${sessionProfitRef.current.toFixed(2)} ${currency}`,
                    ]);
                    stopTrading();
                    return;
                }
            }

            // Determine which signal to use (primary or recovery)
            const currentSignal = isRecoveryTradeRef.current ? recoverySignal : primarySignal;
            const signalType = isRecoveryTradeRef.current ? 'RECOVERY' : 'PRIMARY';
            
            tradeInFlightRef.current = true;
            const tradeStake = currentMartingaleStakeRef.current;
            
            setTerminalDashboard(previous => [
                ...previous, 
                `🎯 ${signalType} signal found: ${currentSignal.label} | Stake: ${tradeStake.toFixed(2)} ${currency}`,
                `📊 Consecutive losses: ${consecutiveLossesRef.current}`
            ]);

            try {
                const profit = await runSingleTrade(currentSignal, tradeStake);
                const isWin = profit > 0;
                
                if (isWin) {
                    // WIN: Reset everything
                    consecutiveLossesRef.current = 0;
                    consecutiveRecoveryLossesRef.current = 0;
                    currentMartingaleStakeRef.current = baseStakeRef.current;
                    isRecoveryTradeRef.current = false;
                    
                    setTerminalDashboard(previous => [
                        ...previous, 
                        `✅ WIN! All systems reset. Base stake: ${baseStakeRef.current.toFixed(2)} ${currency}`,
                        `🔄 Back to PRIMARY signal for next trade`
                    ]);
                } else {
                    // LOSS: Determine recovery strategy
                    consecutiveLossesRef.current += 1;
                    
                    if (isRecoveryTradeRef.current) {
                        // Loss on recovery trade - activate martingale on recovery
                        consecutiveRecoveryLossesRef.current += 1;
                        const newStake = baseStakeRef.current * Math.pow(martingaleMultiplierRef.current, consecutiveRecoveryLossesRef.current);
                        currentMartingaleStakeRef.current = newStake;
                        
                        setTerminalDashboard(previous => [
                            ...previous, 
                            `❌ RECOVERY LOSS! Recovery losses: ${consecutiveRecoveryLossesRef.current}`,
                            `💰 Next recovery stake: ${newStake.toFixed(2)} ${currency} (x${martingaleMultiplierRef.current}^${consecutiveRecoveryLossesRef.current})`
                        ]);
                    } else {
                        // Loss on primary trade - switch to recovery
                        isRecoveryTradeRef.current = true;
                        consecutiveRecoveryLossesRef.current = 1;
                        const newStake = baseStakeRef.current * martingaleMultiplierRef.current;
                        currentMartingaleStakeRef.current = newStake;
                        
                        setTerminalDashboard(previous => [
                            ...previous, 
                            `❌ PRIMARY LOSS! Switching to RECOVERY signal: ${recoverySignal.label}`,
                            `💰 First recovery stake: ${newStake.toFixed(2)} ${currency} (x${martingaleMultiplierRef.current})`
                        ]);
                    }
                }
                
                const totalProfit = Number((sessionProfitRef.current + profit).toFixed(8));
                completedRunsRef.current += 1;
                sessionProfitRef.current = totalProfit;
                setSessionProfit(totalProfit);
                
                setTerminalDashboard(previous => [
                    ...previous,
                    `📈 Run ${completedRunsRef.current}/${runsToCheckRef.current} closed: ${currentSignal.label} ${profit.toFixed(2)} ${currency}`,
                    `💰 Session P/L: ${totalProfit.toFixed(2)} ${currency}`,
                    `🎯 Next trade: ${isRecoveryTradeRef.current ? 'RECOVERY' : 'PRIMARY'} signal`
                ]);

                // Check conditions again after updating
                if (totalProfit <= -stopLossRef.current) {
                    setTerminalDashboard(previous => [
                        ...previous,
                        `STOP LOSS REACHED! P/L: ${totalProfit.toFixed(2)} ${currency}`,
                    ]);
                    stopTrading();
                } else if (totalProfit >= takeProfitRef.current) {
                    setTerminalDashboard(previous => [
                        ...previous,
                        `TAKE PROFIT REACHED! P/L: ${totalProfit.toFixed(2)} ${currency}`,
                    ]);
                    stopTrading();
                } else if (completedRunsRef.current >= runsToCheckRef.current && totalProfit > 0.1) {
                    setTerminalDashboard(previous => [
                        ...previous,
                        `${runsToCheckRef.current} runs complete with profit > 0.1: ${totalProfit.toFixed(2)} ${currency}`,
                    ]);
                    stopTrading();
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Trade mode failed.';
                setTerminalDashboard(previous => [...previous, `Error: ${message}`]);
                stopTrading();
            } finally {
                tradeInFlightRef.current = false;
                if (tradeActiveRef.current && !shouldStopRef.current) {
                    setTimeout(() => handleTradeTickRef.current(ticksRef.current), 0);
                }
            }
        },
        [currency, runSingleTrade, stopTrading]
    );

    // Modified executeTradeFromTick to use recovery logic for Over & Under
    const executeTradeFromTick = useCallback(
        async (currentTicks: TTickPoint[]) => {
            if (!tradeActiveRef.current || tradeInFlightRef.current || shouldStopRef.current || currentTicks.length < MAX_TICKS) {
                return;
            }

            // Stop if stop loss is reached
            if (sessionProfitRef.current <= -stopLossRef.current) {
                setTerminalDashboard(previous => [
                    ...previous,
                    `STOP LOSS REACHED! P/L: ${sessionProfitRef.current.toFixed(2)} ${currency}`,
                ]);
                stopTrading();
                return;
            }

            // Stop if take profit is reached
            if (sessionProfitRef.current >= takeProfitRef.current) {
                setTerminalDashboard(previous => [
                    ...previous,
                    `TAKE PROFIT REACHED! P/L: ${sessionProfitRef.current.toFixed(2)} ${currency}`,
                ]);
                stopTrading();
                return;
            }

            // Check if we've reached the required number of runs
            if (completedRunsRef.current >= runsToCheckRef.current) {
                if (sessionProfitRef.current <= 0.1) {
                    setTerminalDashboard(previous => [
                        ...previous,
                        `${runsToCheckRef.current} runs completed but profit (${sessionProfitRef.current.toFixed(2)} ${currency}) <= 0.1. Continuing until profit > 0.1...`,
                    ]);
                } else {
                    setTerminalDashboard(previous => [
                        ...previous,
                        `${runsToCheckRef.current} runs complete with profit > 0.1: ${sessionProfitRef.current.toFixed(2)} ${currency}`,
                    ]);
                    stopTrading();
                    return;
                }
            }

            // For Over & Under strategy, use the recovery logic
            if (strategyRef.current === 'Over & Under' && primarySignalRef.current && recoverySignalRef.current) {
                await executeTradeWithRecovery(primarySignalRef.current, recoverySignalRef.current, currentTicks);
                return;
            }

            // Original logic for other strategies
            const analysis = buildAnalysis(strategyRef.current, currentTicks, selectedSymbolRef.current);
            tradeInFlightRef.current = true;
            
            const tradeStake = currentMartingaleStakeRef.current;
            setTerminalDashboard(previous => [...previous, `Tick signal found: ${analysis.signal.label} | Stake: ${tradeStake.toFixed(2)} ${currency}`]);

            try {
                const profit = await runSingleTrade(analysis.signal, tradeStake);
                const isWin = profit > 0;
                
                if (isWin) {
                    consecutiveLossesRef.current = 0;
                    currentMartingaleStakeRef.current = baseStakeRef.current;
                    setTerminalDashboard(previous => [...previous, `✓ WIN! Martingale reset to base stake: ${baseStakeRef.current.toFixed(2)} ${currency}`]);
                } else {
                    consecutiveLossesRef.current += 1;
                    const newStake = baseStakeRef.current * Math.pow(martingaleMultiplierRef.current, consecutiveLossesRef.current);
                    currentMartingaleStakeRef.current = newStake;
                    setTerminalDashboard(previous => [...previous, `✗ LOSS! Martingale activated. Next stake: ${newStake.toFixed(2)} ${currency} (x${martingaleMultiplierRef.current}^${consecutiveLossesRef.current})`]);
                }
                
                const totalProfit = Number((sessionProfitRef.current + profit).toFixed(8));
                completedRunsRef.current += 1;
                sessionProfitRef.current = totalProfit;
                setSessionProfit(totalProfit);
                setTerminalDashboard(previous => [
                    ...previous,
                    `Run ${completedRunsRef.current}/${runsToCheckRef.current} closed: ${analysis.signal.label} ${profit.toFixed(2)} ${currency}`,
                    `Session P/L: ${totalProfit.toFixed(2)} ${currency}`,
                    `Martingale Status: ${isWin ? 'RESET' : `Active (${consecutiveLossesRef.current} losses)`}`,
                ]);

                if (totalProfit <= -stopLossRef.current) {
                    setTerminalDashboard(previous => [
                        ...previous,
                        `STOP LOSS REACHED! P/L: ${totalProfit.toFixed(2)} ${currency}`,
                    ]);
                    stopTrading();
                } else if (totalProfit >= takeProfitRef.current) {
                    setTerminalDashboard(previous => [
                        ...previous,
                        `TAKE PROFIT REACHED! P/L: ${totalProfit.toFixed(2)} ${currency}`,
                    ]);
                    stopTrading();
                } else if (completedRunsRef.current >= runsToCheckRef.current && totalProfit > 0.1) {
                    setTerminalDashboard(previous => [
                        ...previous,
                        `${runsToCheckRef.current} runs complete with profit > 0.1: ${totalProfit.toFixed(2)} ${currency}`,
                    ]);
                    stopTrading();
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Trade mode failed.';
                setTerminalDashboard(previous => [...previous, `Error: ${message}`]);
                stopTrading();
            } finally {
                tradeInFlightRef.current = false;
                if (tradeActiveRef.current && !shouldStopRef.current) {
                    setTimeout(() => handleTradeTickRef.current(ticksRef.current), 0);
                }
            }
        },
        [currency, runSingleTrade, stopTrading, executeTradeWithRecovery]
    );

    useEffect(() => {
        handleTradeTickRef.current = currentTicks => {
            void executeTradeFromTick(currentTicks);
        };
    }, [executeTradeFromTick]);

    // Modified startScannerTrading to store primary and recovery signals
    const startScannerTrading = useCallback(
        (firstSignal: TScannerSignal, stake: number, stopLoss: number, takeProfit: number, multiplier: number, runsToCheck: number) => {
            // Initialize martingale state
            baseStakeRef.current = stake;
            currentMartingaleStakeRef.current = stake;
            consecutiveLossesRef.current = 0;
            consecutiveRecoveryLossesRef.current = 0;
            isRecoveryTradeRef.current = false;
            stakeRef.current = stake;
            stopLossRef.current = stopLoss;
            takeProfitRef.current = takeProfit;
            runsToCheckRef.current = runsToCheck;
            sessionProfitRef.current = 0;
            completedRunsRef.current = 0;
            shouldStopRef.current = false;
            tradeActiveRef.current = true;
            tradeInFlightRef.current = false;
            setSessionProfit(0);

            // Store primary and recovery signals for Over & Under strategy
            if (strategyRef.current === 'Over & Under' && firstSignal.recoveryBarrier && firstSignal.recoveryContractType && firstSignal.recoveryLabel) {
                primarySignalRef.current = {
                    barrier: firstSignal.barrier,
                    contractType: firstSignal.contractType,
                    label: firstSignal.label
                };
                recoverySignalRef.current = {
                    barrier: firstSignal.recoveryBarrier,
                    contractType: firstSignal.recoveryContractType,
                    label: firstSignal.recoveryLabel
                };
                setTerminalDashboard(previous => [
                    ...previous,
                    `🔄 Recovery strategy enabled:`,
                    `   PRIMARY: ${primarySignalRef.current?.label}`,
                    `   RECOVERY: ${recoverySignalRef.current?.label}`,
                    `   Rule: Trade PRIMARY, if loss -> switch to RECOVERY with martingale`
                ]);
            } else {
                primarySignalRef.current = null;
                recoverySignalRef.current = null;
            }

            try {
                run_panel.setRunId(`scanner-${Date.now()}`);
                run_panel.setIsRunning(true);
                run_panel.setContractStage?.(contract_stages.RUNNING);
                run_panel.toggleDrawer(true);
            } catch {
                // Run panel can be unavailable while the app is still initializing.
            }

            dashboard.setActiveTradingModule('scanner');
            setTerminalDashboard(previous => [
                ...previous,
                `Bot activated with ${firstSignal.label}.`,
                `Martingale enabled: multiplier x${multiplier} | Base stake: ${stake} ${currency}`,
                `Will check profit after ${runsToCheck} runs (will continue until profit > 0.1).`,
                `Stop Loss: ${stopLoss} ${currency} | Take Profit: ${takeProfit} ${currency}`,
            ]);
            void executeTradeFromTick(ticksRef.current);
        },
        [currency, dashboard, executeTradeFromTick, run_panel]
    );

    const startFastMovingCodes = useCallback(
        (nextMode: TScannerMode, stake: number, stopLoss: number, takeProfit: number, multiplier: number, runsToCheck: number) => {
            playTimerSound();
            setTerminalBody(previous => [...previous, 'Running deep analysis...']);

            const codeInterval = setInterval(() => {
                if (shouldStopRef.current) {
                    clearInterval(codeInterval);
                    return;
                }
                setTerminalBody(previous => [...previous.slice(-49), generateRandomCode()]);
            }, 50);

            setTimeout(() => {
                clearInterval(codeInterval);
                stopTimerSound();
                if (shouldStopRef.current) {
                    setIsWorking(false);
                    return;
                }
                const analysis = buildAnalysis(strategy, ticksRef.current, selectedSymbol);
                setTerminalDashboard(previous => [...previous, ...analysis.lines]);

                let count = 5;
                const countdownInterval = setInterval(() => {
                    if (shouldStopRef.current) {
                        clearInterval(countdownInterval);
                        setIsWorking(false);
                        return;
                    }

                    setTerminalDashboard(previous => [...previous, `Running bot in ${count} seconds...`]);
                    count--;

                    if (count < 0) {
                        clearInterval(countdownInterval);
                        setTerminalDashboard(previous => [...previous, nextMode === 'Trade' ? 'Bot activated!' : 'Analysis mode complete.']);

                        if (nextMode === 'Trade') {
                            startScannerTrading(analysis.signal, stake, stopLoss, takeProfit, multiplier, runsToCheck);
                        } else {
                            setIsWorking(false);
                        }
                    }
                }, 1000);
            }, 5000);
        },
        [playTimerSound, selectedSymbol, startScannerTrading, stopTimerSound, strategy]
    );

    const handleAnalyze = () => {
        const stake = Number(stakeInput);
        const stopLoss = Number(stopLossInput);
        const takeProfit = Number(takeProfitInput);
        const multiplier = martingaleMultiplier;
        const runsToCheck = parseInt(runsToCheckInput) || 5;

        if (!strategy || !selectedSymbol) {
            setTerminalDashboard(['Error: Please select both strategy and market!']);
            setPopupOpen(true);
            return;
        }

        if (!Number.isFinite(stake) || stake <= 0 || !Number.isFinite(stopLoss) || stopLoss <= 0 || !Number.isFinite(takeProfit) || takeProfit <= 0) {
            setTerminalDashboard(['Error: Please enter valid Stake, SL and TP amounts!']);
            setPopupOpen(true);
            return;
        }

        if (runsToCheck < 1 || runsToCheck > 1000) {
            setTerminalDashboard(['Error: Please enter valid number of runs (1-1000)!']);
            setPopupOpen(true);
            return;
        }

        if (!canAnalyze) {
            setTerminalDashboard([`Error: Loading ${MAX_TICKS} ticks before analysis. Please wait.`]);
            setPopupOpen(true);
            return;
        }

        shouldStopRef.current = false;
        setIsWorking(true);
        setSessionProfit(0);
        sessionProfitRef.current = 0;
        completedRunsRef.current = 0;
        setPopupOpen(true);
        setTerminalDashboard([`Analysis Dashboard - ${strategy} on ${selectedSymbol}`]);
        setTerminalBody(['Connecting to server...']);

        const messages = [
            `Analysing ${strategy} on ${selectedSymbol}...`,
            'Retrieving market data...',
            'Error: Timeout connecting to node...',
            'Attempting reconnect...',
            'Data stream detected...',
            'Error: Unstable connection...',
            'Finalizing analysis...',
        ];

        let index = 0;
        const interval = setInterval(() => {
            if (shouldStopRef.current) {
                clearInterval(interval);
                setIsWorking(false);
                return;
            }

            if (index < messages.length) {
                const nextMessage = messages[index];
                setTerminalBody(previous => [...previous, nextMessage]);
                index++;
            } else {
                clearInterval(interval);
                startFastMovingCodes(mode, stake, stopLoss, takeProfit, multiplier, runsToCheck);
            }
        }, 1000);
    };

    const handleClosePopup = () => {
        stopTimerSound();
        setPopupOpen(false);
    };

    const handleMarketChange = (symbol: string) => {
        stopTrading();
        setSelectedSymbol(symbol);
    };

    const handleStrategyChange = (nextStrategy: TScannerStrategy) => {
        stopTrading();
        setStrategy(nextStrategy);
    };

    const handleModeChange = (nextMode: TScannerMode) => {
        stopTrading();
        setMode(nextMode);
    };

    if (!showScanner) return null;

    return (
        <div className={`scanner-page${isCoveredByMobileRunPanel ? ' scanner-page--run-panel-open' : ''}`}>
            <div className='background'>
                <div className='scrolling-text'>{scrollingText}</div>
            </div>
            <div className='container'>
                <h1>⚡ SIGNAL ANALYZER ⚡</h1>
                
                <label htmlFor='strategy'>📊 SELECT STRATEGY</label>
                <select id='strategy' className='dropdown' value={strategy} onChange={event => handleStrategyChange(event.target.value as TScannerStrategy)}>
                    {STRATEGIES.map(item => (
                        <option key={item}>{item}</option>
                    ))}
                </select>
                
                <label htmlFor='market'>🌍 SELECT MARKET</label>
                <select id='market' className='dropdown' value={selectedSymbol} onChange={event => handleMarketChange(event.target.value)}>
                    {MARKETS.map(market => (
                        <option key={market.symbol} value={market.symbol}>
                            {market.label}
                        </option>
                    ))}
                </select>
                
                <label htmlFor='stake'>💰 BASE STAKE</label>
                <input id='stake' className='dropdown' inputMode='decimal' value={stakeInput} onChange={event => setStakeInput(cleanMoneyInput(event.target.value))} />
                
                <label htmlFor='stop-loss'>🛑 STOP LOSS (SL)</label>
                <input id='stop-loss' className='dropdown' inputMode='decimal' value={stopLossInput} onChange={event => setStopLossInput(cleanMoneyInput(event.target.value))} />
                
                <label htmlFor='take-profit'>🎯 TAKE PROFIT (TP)</label>
                <input id='take-profit' className='dropdown' inputMode='decimal' value={takeProfitInput} onChange={event => setTakeProfitInput(cleanMoneyInput(event.target.value))} />
                
                <label htmlFor='runs-to-check'>🔢 RUNS BEFORE CHECKING PROFIT</label>
                <input 
                    id='runs-to-check' 
                    className='dropdown' 
                    inputMode='numeric' 
                    value={runsToCheckInput} 
                    onChange={event => setRunsToCheckInput(cleanNumberInput(event.target.value))}
                />
                
                <div className='martingale-row'>
                    <label>🎲 MARTINGALE MULTIPLIER (1x - 10x)</label>
                    <select 
                        className='martingale-select' 
                        value={martingaleMultiplier} 
                        onChange={event => setMartingaleMultiplier(Number(event.target.value))}
                    >
                        {MARTINGALE_MULTIPLIERS.map(m => (
                            <option key={m} value={m}>x{m.toFixed(1)}</option>
                        ))}
                    </select>
                </div>
                
                <label htmlFor='mode'>⚙️ MODE</label>
                <select id='mode' className='dropdown' value={mode} onChange={event => handleModeChange(event.target.value as TScannerMode)}>
                    <option>Analyze</option>
                    <option>Trade</option>
                </select>
                
                <div className='contain'>
                    <div className='latest-tick'>
                        📈 Latest Tick: <span>{latestTick?.quote ?? '--'}</span>
                    </div>
                    <div className='latest-tick'>
                        🔢 Last Digit: <span>{latestDigit ?? '--'}</span>
                    </div>
                    <div className='latest-tick'>
                        💵 P/L: <span>{sessionProfit.toFixed(2)} {currency}</span>
                    </div>
                    <div className='latest-tick'>
                        🎯 Runs: <span>{completedRunsRef.current}/{runsToCheckInput}</span>
                    </div>
                </div>

                <div className='buttons'>
                    <button className='analyse' type='button' onClick={handleAnalyze} disabled={isWorking}>
                        {isWorking ? 'PROCESSING...' : '🚀 ANALYSE & RUN'}
                    </button>
                </div>
            </div>
            
            <div className='popup popup--reduced' style={{ display: popupOpen ? 'block' : 'none' }}>
                <div className='popup-content'>
                    <div className='popup-header'>
                        <button className='stop-bot-btn' type='button' onClick={handleStopBot} disabled={!tradeActiveRef.current && !isWorking}>
                            ⏹️ STOP BOT
                        </button>
                        <button className='close-btn' type='button' onClick={handleClosePopup}>
                            ✕
                        </button>
                    </div>
                    <div className='terminal-header'>
                        <span className='dot red' />
                        <span className='dot yellow' />
                        <span className='dot green' />
                        <span className='terminal-title'>QUANTUM TERMINAL v2.0</span>
                    </div>
                    <div className='terminal-dashboard'>
                        {terminalDashboard.map((line, index) => (
                            <p className={line?.startsWith('Error') ? 'red' : 'green'} key={`${line}-${index}`}>
                                {line ?? ''}
                            </p>
                        ))}
                    </div>
                    <div className='terminal-scroll'>
                        <div className='terminal-scroll-content'>
                            {terminalBody.map((line, index) => (
                                <p className={(line ?? '').startsWith('Error') ? 'red' : 'green'} key={`${line}-${index}`}>
                                    {line ?? ''}
                                </p>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
});

export default Scanner;
