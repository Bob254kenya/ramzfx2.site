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

type TScannerStrategy = 
    | 'Matches & Differs' 
    | 'Even & Odd' 
    | 'Over & Under' 
    | 'Rise & Fall'
    | 'Scalping Momentum'
    | 'Mean Reversion'
    | 'Breakout Hunter'
    | 'Trend Following'
    | 'Volatility Sniping';

type TScannerMode = 'Analyze' | 'Trade';

type TScannerSignal = {
    barrier?: string;
    contractType: 'DIGITEVEN' | 'DIGITODD' | 'DIGITOVER' | 'DIGITUNDER' | 'DIGITMATCH' | 'DIGITDIFF' | 'CALL' | 'PUT';
    label: string;
    entryPoint?: number;
    confidence?: number;
};

const MAX_TICKS = 1000;
const DEFAULT_STAKE = '10';
const DEFAULT_STOP_LOSS = '500';
const DEFAULT_TAKE_PROFIT = '500';
const DEFAULT_MARTINGALE_MULTIPLIER = '2';
const DEFAULT_RECOVERY_STAKE = '20';
const PROFIT_CHECK_RUNS = 5;
const TIMER_SOUND_URL = 'https://www.fesliyanstudios.com/play-mp3/4386';

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

const STRATEGIES: TScannerStrategy[] = [
    'Matches & Differs', 
    'Even & Odd', 
    'Over & Under', 
    'Rise & Fall',
    'Scalping Momentum',
    'Mean Reversion',
    'Breakout Hunter',
    'Trend Following',
    'Volatility Sniping'
];

const cleanMoneyInput = (value: string) => value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');

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

const findLeastCommonDigit = (digits: number[]) => {
    const counts: Record<number, number> = {};
    for (const digit of digits) {
        counts[digit] = (counts[digit] || 0) + 1;
    }

    let leastCommon: number | null = null;
    let minCount = Infinity;

    for (const digit in counts) {
        if (counts[digit] < minCount) {
            minCount = counts[digit];
            leastCommon = Number(digit);
        }
    }

    return leastCommon ?? digits[0] ?? 0;
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

// New strategy: Scalping Momentum
const analyzeScalpingMomentum = (ticks: TTickPoint[], symbol: string) => {
    const quotes = ticks.slice(-50).map(t => t.quote);
    const changes: number[] = [];
    
    for (let i = 1; i < quotes.length; i++) {
        changes.push(quotes[i] - quotes[i-1]);
    }
    
    const avgChange = changes.reduce((a, b) => a + b, 0) / changes.length;
    const momentum = changes.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const volatility = Math.abs(avgChange);
    
    let prediction = 'CALL';
    let confidence = 0;
    
    if (momentum > avgChange * 1.5 && volatility > 0.05) {
        prediction = 'CALL';
        confidence = 75 + Math.min(20, Math.abs(momentum - avgChange) * 100);
    } else if (momentum < avgChange * 0.5 && volatility > 0.05) {
        prediction = 'PUT';
        confidence = 75 + Math.min(20, Math.abs(avgChange - momentum) * 100);
    } else {
        prediction = changes.slice(-5).filter(c => c > 0).length > 2 ? 'CALL' : 'PUT';
        confidence = 60;
    }
    
    return {
        lines: [
            `Scalping Analysis Complete!`,
            `Momentum: ${momentum.toFixed(4)}`,
            `Average Change: ${avgChange.toFixed(4)}`,
            `Volatility: ${volatility.toFixed(4)}`,
            `Confidence: ${confidence.toFixed(1)}%`,
            `Signal: ${prediction === 'CALL' ? 'BUY (Expected Rise)' : 'SELL (Expected Fall)'}`,
            `Entry Point: Execute immediately on next tick`
        ],
        signal: {
            contractType: prediction as 'CALL' | 'PUT',
            label: prediction === 'CALL' ? 'Momentum Up' : 'Momentum Down',
            confidence
        }
    };
};

// New strategy: Mean Reversion
const analyzeMeanReversion = (ticks: TTickPoint[], symbol: string) => {
    const quotes = ticks.slice(-100).map(t => t.quote);
    const mean = quotes.reduce((a, b) => a + b, 0) / quotes.length;
    const stdDev = Math.sqrt(quotes.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b, 0) / quotes.length);
    const currentPrice = quotes[quotes.length - 1];
    const zScore = (currentPrice - mean) / stdDev;
    
    let prediction = '';
    let confidence = 0;
    
    if (zScore > 1.5) {
        prediction = 'PUT';
        confidence = 70 + Math.min(25, (zScore - 1.5) * 10);
    } else if (zScore < -1.5) {
        prediction = 'CALL';
        confidence = 70 + Math.min(25, Math.abs(zScore + 1.5) * 10);
    } else {
        prediction = zScore > 0 ? 'PUT' : 'CALL';
        confidence = 55;
    }
    
    return {
        lines: [
            `Mean Reversion Analysis Complete!`,
            `Mean Price: ${mean.toFixed(4)}`,
            `Std Deviation: ${stdDev.toFixed(4)}`,
            `Current Price: ${currentPrice.toFixed(4)}`,
            `Z-Score: ${zScore.toFixed(2)}`,
            `Confidence: ${confidence.toFixed(1)}%`,
            `Signal: ${prediction === 'CALL' ? 'BUY (Oversold)' : 'SELL (Overbought)'}`,
            `Entry Point: Enter when price deviates significantly from mean`
        ],
        signal: {
            contractType: prediction as 'CALL' | 'PUT',
            label: prediction === 'CALL' ? 'Reversion Up' : 'Reversion Down',
            confidence
        }
    };
};

// New strategy: Breakout Hunter
const analyzeBreakoutHunter = (ticks: TTickPoint[], symbol: string) => {
    const quotes = ticks.slice(-50).map(t => t.quote);
    const highs = Math.max(...quotes.slice(0, -5));
    const lows = Math.min(...quotes.slice(0, -5));
    const currentPrice = quotes[quotes.length - 1];
    const previousPrice = quotes[quotes.length - 2];
    
    let prediction = '';
    let confidence = 0;
    let breakoutLevel = '';
    
    if (currentPrice > highs && currentPrice > previousPrice) {
        prediction = 'CALL';
        confidence = 80;
        breakoutLevel = `Resistance at ${highs.toFixed(4)} broken`;
    } else if (currentPrice < lows && currentPrice < previousPrice) {
        prediction = 'PUT';
        confidence = 80;
        breakoutLevel = `Support at ${lows.toFixed(4)} broken`;
    } else {
        const recentRange = highs - lows;
        const distanceToHigh = (highs - currentPrice) / recentRange;
        const distanceToLow = (currentPrice - lows) / recentRange;
        
        if (distanceToHigh < 0.1) {
            prediction = 'CALL';
            confidence = 65;
            breakoutLevel = `Approaching resistance at ${highs.toFixed(4)}`;
        } else if (distanceToLow < 0.1) {
            prediction = 'PUT';
            confidence = 65;
            breakoutLevel = `Approaching support at ${lows.toFixed(4)}`;
        } else {
            prediction = currentPrice > (highs + lows) / 2 ? 'CALL' : 'PUT';
            confidence = 55;
            breakoutLevel = 'Consolidation phase';
        }
    }
    
    return {
        lines: [
            `Breakout Hunter Analysis Complete!`,
            `Resistance Level: ${highs.toFixed(4)}`,
            `Support Level: ${lows.toFixed(4)}`,
            `Current Price: ${currentPrice.toFixed(4)}`,
            breakoutLevel,
            `Confidence: ${confidence.toFixed(1)}%`,
            `Signal: ${prediction === 'CALL' ? 'BUY (Breakout Expected)' : 'SELL (Breakdown Expected)'}`,
            `Entry Point: Enter on confirmed breakout`
        ],
        signal: {
            contractType: prediction as 'CALL' | 'PUT',
            label: prediction === 'CALL' ? 'Breakout Up' : 'Breakout Down',
            confidence
        }
    };
};

// New strategy: Trend Following
const analyzeTrendFollowing = (ticks: TTickPoint[], symbol: string) => {
    const quotes = ticks.slice(-50).map(t => t.quote);
    
    // Simple moving averages
    const sma10 = quotes.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const sma20 = quotes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const sma30 = quotes.slice(-30).reduce((a, b) => a + b, 0) / 30;
    
    const currentPrice = quotes[quotes.length - 1];
    const isUptrend = sma10 > sma20 && sma20 > sma30 && currentPrice > sma10;
    const isDowntrend = sma10 < sma20 && sma20 < sma30 && currentPrice < sma10;
    
    let prediction = '';
    let confidence = 0;
    let trendStrength = '';
    
    if (isUptrend) {
        prediction = 'CALL';
        const strength = ((sma10 - sma30) / sma30) * 100;
        confidence = 70 + Math.min(25, strength * 5);
        trendStrength = `Strong Uptrend (${strength.toFixed(2)}%)`;
    } else if (isDowntrend) {
        prediction = 'PUT';
        const strength = ((sma30 - sma10) / sma30) * 100;
        confidence = 70 + Math.min(25, strength * 5);
        trendStrength = `Strong Downtrend (${strength.toFixed(2)}%)`;
    } else {
        prediction = sma10 > sma20 ? 'CALL' : 'PUT';
        confidence = 55;
        trendStrength = 'Weak/Consolidating Trend';
    }
    
    return {
        lines: [
            `Trend Following Analysis Complete!`,
            `SMA 10: ${sma10.toFixed(4)}`,
            `SMA 20: ${sma20.toFixed(4)}`,
            `SMA 30: ${sma30.toFixed(4)}`,
            `Current Price: ${currentPrice.toFixed(4)}`,
            `Trend: ${trendStrength}`,
            `Confidence: ${confidence.toFixed(1)}%`,
            `Signal: ${prediction === 'CALL' ? 'BUY (Follow Uptrend)' : 'SELL (Follow Downtrend)'}`,
            `Entry Point: Enter on pullback to moving average`
        ],
        signal: {
            contractType: prediction as 'CALL' | 'PUT',
            label: prediction === 'CALL' ? 'Trend Up' : 'Trend Down',
            confidence
        }
    };
};

// New strategy: Volatility Sniping
const analyzeVolatilitySniping = (ticks: TTickPoint[], symbol: string) => {
    const quotes = ticks.slice(-50).map(t => t.quote);
    const changes: number[] = [];
    
    for (let i = 1; i < quotes.length; i++) {
        changes.push(Math.abs(quotes[i] - quotes[i-1]));
    }
    
    const avgVolatility = changes.reduce((a, b) => a + b, 0) / changes.length;
    const recentVolatility = changes.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const volatilitySpike = recentVolatility / avgVolatility;
    
    const lastDigit = getLastDigitFromQuote(quotes[quotes.length - 1], symbol);
    const secondLastDigit = getLastDigitFromQuote(quotes[quotes.length - 2], symbol);
    
    let prediction = '';
    let confidence = 0;
    let contractType: any = 'DIGITEVEN';
    let barrier = '';
    
    if (volatilitySpike > 1.5) {
        // High volatility - use digit strategies
        if (lastDigit % 2 === 0) {
            prediction = 'Even number expected';
            contractType = 'DIGITEVEN';
            confidence = 65 + Math.min(20, (volatilitySpike - 1.5) * 10);
        } else {
            prediction = 'Odd number expected';
            contractType = 'DIGITODD';
            confidence = 65 + Math.min(20, (volatilitySpike - 1.5) * 10);
        }
    } else if (volatilitySpike > 1.2) {
        // Moderate volatility - use over/under
        if (lastDigit <= 4) {
            prediction = `Under ${lastDigit}`;
            contractType = 'DIGITUNDER';
            barrier = String(lastDigit);
            confidence = 60;
        } else {
            prediction = `Over ${lastDigit}`;
            contractType = 'DIGITOVER';
            barrier = String(lastDigit);
            confidence = 60;
        }
    } else {
        // Low volatility - use match/differ
        if (lastDigit === secondLastDigit) {
            prediction = `Matches ${lastDigit}`;
            contractType = 'DIGITMATCH';
            barrier = String(lastDigit);
            confidence = 55;
        } else {
            prediction = `Differs from ${secondLastDigit}`;
            contractType = 'DIGITDIFF';
            barrier = String(secondLastDigit);
            confidence = 55;
        }
    }
    
    return {
        lines: [
            `Volatility Sniping Analysis Complete!`,
            `Avg Volatility: ${(avgVolatility * 10000).toFixed(2)} pips`,
            `Recent Volatility: ${(recentVolatility * 10000).toFixed(2)} pips`,
            `Volatility Spike Ratio: ${volatilitySpike.toFixed(2)}x`,
            `Last Digit: ${lastDigit}`,
            `Confidence: ${confidence.toFixed(1)}%`,
            `Signal: ${prediction}`,
            `Entry Point: Enter immediately on volatility confirmation`
        ],
        signal: {
            contractType,
            label: prediction,
            barrier,
            confidence
        }
    };
};

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
        let overCount = 0;
        let underCount = 0;

        for (const digit of lastDigits) {
            if (digit <= 4) overCount++;
            else underCount++;
        }

        const overPercentage = ((overCount / sampleSize) * 100).toFixed(2);
        const underPercentage = ((underCount / sampleSize) * 100).toFixed(2);

        if (overCount < underCount) {
            const overDigits = lastDigits.filter(digit => digit <= 4);
            const leastCommonOver = findLeastCommonDigit(overDigits);
            lines.push(`OVER (0-4) with ${overPercentage}%`);
            lines.push(`Recommended digit: ${leastCommonOver}`);
            lines.push(`Entry Points: ${getRandomEntryPoints(3).join(', ')}`);
            signal = { barrier: String(leastCommonOver), contractType: 'DIGITOVER', label: `Over ${leastCommonOver}` };
        } else {
            const underDigits = lastDigits.filter(digit => digit >= 5);
            const leastCommonUnder = findLeastCommonDigit(underDigits);
            lines.push(`UNDER (5-9) with ${underPercentage}%`);
            lines.push(`Recommended digit: ${leastCommonUnder}`);
            lines.push(`Entry Points: ${getRandomEntryPoints(3).join(', ')}`);
            signal = { barrier: String(leastCommonUnder), contractType: 'DIGITUNDER', label: `Under ${leastCommonUnder}` };
        }
    } else if (strategy === 'Rise & Fall') {
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
    } else if (strategy === 'Scalping Momentum') {
        const result = analyzeScalpingMomentum(ticks, symbol);
        lines.push(...result.lines);
        signal = result.signal;
    } else if (strategy === 'Mean Reversion') {
        const result = analyzeMeanReversion(ticks, symbol);
        lines.push(...result.lines);
        signal = result.signal;
    } else if (strategy === 'Breakout Hunter') {
        const result = analyzeBreakoutHunter(ticks, symbol);
        lines.push(...result.lines);
        signal = result.signal;
    } else if (strategy === 'Trend Following') {
        const result = analyzeTrendFollowing(ticks, symbol);
        lines.push(...result.lines);
        signal = result.signal;
    } else if (strategy === 'Volatility Sniping') {
        const result = analyzeVolatilitySniping(ticks, symbol);
        lines.push(...result.lines);
        signal = result.signal;
    }

    return { lines, signal };
};

const Scanner = observer(() => {
    const { client, dashboard, run_panel, summary_card, transactions } = useStore();
    const { isDesktop } = useDevice();
    const { active_tab } = dashboard;
    const [selectedSymbol, setSelectedSymbol] = useState('R_10');
    const [strategy, setStrategy] = useState<TScannerStrategy>('Matches & Differs');
    const [mode, setMode] = useState<TScannerMode>('Analyze');
    const [stakeInput, setStakeInput] = useState(DEFAULT_STAKE);
    const [stopLossInput, setStopLossInput] = useState(DEFAULT_STOP_LOSS);
    const [takeProfitInput, setTakeProfitInput] = useState(DEFAULT_TAKE_PROFIT);
    const [martingaleMultiplier, setMartingaleMultiplier] = useState(DEFAULT_MARTINGALE_MULTIPLIER);
    const [recoveryStake, setRecoveryStake] = useState(DEFAULT_RECOVERY_STAKE);
    const [selectedBarrier, setSelectedBarrier] = useState<string>('');
    const [selectedContractType, setSelectedContractType] = useState<string>('');
    const [ticks, setTicks] = useState<TTickPoint[]>([]);
    const [popupOpen, setPopupOpen] = useState(false);
    const [terminalDashboard, setTerminalDashboard] = useState<string[]>(['Analysis Dashboard']);
    const [terminalBody, setTerminalBody] = useState<string[]>(['Connecting to server...']);
    const [scrollingText, setScrollingText] = useState('');
    const [isWorking, setIsWorking] = useState(false);
    const [sessionProfit, setSessionProfit] = useState(0);
    const [lossStreak, setLossStreak] = useState(0);
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
    const strategyRef = useRef<TScannerStrategy>(strategy);
    const selectedSymbolRef = useRef(selectedSymbol);
    const handleTradeTickRef = useRef<(currentTicks: TTickPoint[]) => void>(() => undefined);
    const timerSoundRef = useRef<HTMLAudioElement | null>(null);
    const currency = client.currency || 'USD';
    const showScanner = active_tab === DBOT_TABS.SCANNER;
    const isCoveredByMobileRunPanel = !isDesktop && run_panel.is_drawer_open;
    const selectedMarket = MARKETS.find(market => market.symbol === selectedSymbol) ?? MARKETS[0];
    const latestTick = ticks[ticks.length - 1];
    const latestDigit = latestTick ? getLastDigitFromQuote(latestTick.quote, selectedSymbol) : null;
    const canAnalyze = ticks.length >= MAX_TICKS;

    // Available barrier options based on strategy
    const getBarrierOptions = () => {
        if (strategy === 'Over & Under') {
            return ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
        } else if (strategy === 'Matches & Differs') {
            return ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
        }
        return [];
    };

    // Available contract types based on strategy
    const getContractTypeOptions = () => {
        if (strategy === 'Even & Odd') {
            return ['DIGITEVEN', 'DIGITODD'];
        } else if (strategy === 'Over & Under') {
            return ['DIGITOVER', 'DIGITUNDER'];
        } else if (strategy === 'Matches & Differs') {
            return ['DIGITMATCH', 'DIGITDIFF'];
        } else if (strategy === 'Rise & Fall' || strategy.includes('Scalping') || strategy.includes('Mean') || 
                   strategy.includes('Breakout') || strategy.includes('Trend') || strategy.includes('Volatility')) {
            return ['CALL', 'PUT'];
        }
        return [];
    };

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
        setLossStreak(0);

        try {
            run_panel.setIsRunning(false);
            run_panel.setContractStage?.(contract_stages.NOT_RUNNING);
        } catch {
            // Run panel can be unavailable while the app is still initializing.
        }

        dashboard.setActiveTradingModule(null);
    }, [dashboard, run_panel, stopTimerSound]);

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
        (signal: TScannerSignal, stake: number, customBarrier?: string, customContractType?: string) => {
            const parameters: Record<string, number | string> = {
                amount: stake,
                basis: 'stake',
                contract_type: customContractType || signal.contractType,
                currency,
                duration: 1,
                duration_unit: 't',
                symbol: selectedSymbol,
            };

            const barrierToUse = customBarrier || signal.barrier;
            if (barrierToUse) parameters.barrier = barrierToUse;
            return parameters;
        },
        [currency, selectedSymbol]
    );

    const runSingleTrade = useCallback(
        async (signal: TScannerSignal, stake: number, isRecovery: boolean = false) => {
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

            const confidenceText = signal.confidence ? ` (Confidence: ${signal.confidence.toFixed(1)}%)` : '';
            const recoveryText = isRecovery ? ' [RECOVERY TRADE]' : '';
            setTerminalDashboard(previous => [...previous, `Buying ${signal.label}${confidenceText}${recoveryText} with ${stake.toFixed(2)} ${currency}...`]);
            
            const contractTypeToUse = selectedContractType || signal.contractType;
            const barrierToUse = selectedBarrier || signal.barrier;
            
            const buy = await buyContractForUi({
                parameters: buildTradeParameters(signal, stake, barrierToUse, contractTypeToUse),
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
        [buildTradeParameters, currency, pushContract, selectedMarket.label, selectedSymbol, selectedBarrier, selectedContractType]
    );

    const executeTradeFromTick = useCallback(
        async (currentTicks: TTickPoint[]) => {
            if (!tradeActiveRef.current || tradeInFlightRef.current || shouldStopRef.current || currentTicks.length < MAX_TICKS) {
                return;
            }

            if (
                sessionProfitRef.current <= -stopLossRef.current ||
                (completedRunsRef.current >= PROFIT_CHECK_RUNS && sessionProfitRef.current > 0)
            ) {
                stopTrading();
                return;
            }

            const analysis = buildAnalysis(strategyRef.current, currentTicks, selectedSymbolRef.current);
            const confidenceText = analysis.signal.confidence ? ` (Confidence: ${analysis.signal.confidence.toFixed(1)}%)` : '';
            tradeInFlightRef.current = true;
            
            // Calculate stake with martingale if in loss streak
            let currentStake = stakeRef.current;
            if (lossStreak > 0) {
                const multiplier = Math.pow(Number(martingaleMultiplier), lossStreak);
                currentStake = stakeRef.current * multiplier;
                currentStake = Math.min(currentStake, Number(recoveryStake) * 10); // Cap at 10x recovery stake
                setTerminalDashboard(previous => [...previous, `Martingale activated: Loss streak ${lossStreak}, Stake: ${currentStake.toFixed(2)} ${currency}`]);
            }
            
            setTerminalDashboard(previous => [...previous, `Tick signal found: ${analysis.signal.label}${confidenceText}`]);

            try {
                const profit = await runSingleTrade(analysis.signal, currentStake, lossStreak > 0);
                const totalProfit = Number((sessionProfitRef.current + profit).toFixed(8));
                
                if (profit > 0) {
                    // Reset loss streak on win
                    setLossStreak(0);
                    setTerminalDashboard(previous => [...previous, `WIN! Loss streak reset to 0`]);
                } else {
                    // Increment loss streak on loss
                    setLossStreak(prev => prev + 1);
                    setTerminalDashboard(previous => [...previous, `LOSS! Loss streak: ${lossStreak + 1}`]);
                }
                
                completedRunsRef.current += 1;
                sessionProfitRef.current = totalProfit;
                setSessionProfit(totalProfit);
                setTerminalDashboard(previous => [
                    ...previous,
                    `Run ${completedRunsRef.current} closed: ${analysis.signal.label} ${profit.toFixed(2)} ${currency}`,
                    `Session P/L: ${totalProfit.toFixed(2)} ${currency}`,
                ]);

                if (
                    totalProfit <= -stopLossRef.current ||
                    (completedRunsRef.current >= PROFIT_CHECK_RUNS && totalProfit > 0) ||
                    (completedRunsRef.current >= PROFIT_CHECK_RUNS && totalProfit >= takeProfitRef.current)
                ) {
                    setTerminalDashboard(previous => [
                        ...previous,
                        totalProfit <= -stopLossRef.current
                            ? `SL reached: ${totalProfit.toFixed(2)} ${currency}`
                            : `${PROFIT_CHECK_RUNS} runs complete in profit: ${totalProfit.toFixed(2)} ${currency}`,
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
        [currency, runSingleTrade, stopTrading, martingaleMultiplier, lossStreak, recoveryStake]
    );

    useEffect(() => {
        handleTradeTickRef.current = currentTicks => {
            void executeTradeFromTick(currentTicks);
        };
    }, [executeTradeFromTick]);

    const startScannerTrading = useCallback(
        (firstSignal: TScannerSignal, stake: number, stopLoss: number, takeProfit: number) => {
            stakeRef.current = stake;
            stopLossRef.current = stopLoss;
            takeProfitRef.current = takeProfit;
            sessionProfitRef.current = 0;
            completedRunsRef.current = 0;
            shouldStopRef.current = false;
            tradeActiveRef.current = true;
            tradeInFlightRef.current = false;
            setSessionProfit(0);
            setLossStreak(0);

            try {
                run_panel.setRunId(`scanner-${Date.now()}`);
                run_panel.setIsRunning(true);
                run_panel.setContractStage?.(contract_stages.RUNNING);
                run_panel.toggleDrawer(true);
            } catch {
                // Run panel can be unavailable while the app is still initializing.
            }

            dashboard.setActiveTradingModule('scanner');
            const confidenceText = firstSignal.confidence ? ` (Confidence: ${firstSignal.confidence.toFixed(1)}%)` : '';
            const barrierText = selectedBarrier ? ` | Barrier: ${selectedBarrier}` : '';
            const contractText = selectedContractType ? ` | Contract: ${selectedContractType}` : '';
            setTerminalDashboard(previous => [
                ...previous,
                `Bot activated with ${firstSignal.label}${confidenceText}${barrierText}${contractText}.`,
                `Martingale Multiplier: ${martingaleMultiplier}x | Recovery Stake: ${recoveryStake} ${currency}`,
                `Execution is now listening on every live tick. It will check profit after ${PROFIT_CHECK_RUNS} runs.`,
            ]);
            void executeTradeFromTick(ticksRef.current);
        },
        [dashboard, executeTradeFromTick, run_panel, selectedBarrier, selectedContractType, martingaleMultiplier, recoveryStake, currency]
    );

    const startFastMovingCodes = useCallback(
        (nextMode: TScannerMode, stake: number, stopLoss: number, takeProfit: number) => {
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
                            startScannerTrading(analysis.signal, stake, stopLoss, takeProfit);
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
        const recoveryAmount = Number(recoveryStake);

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

        if (!Number.isFinite(recoveryAmount) || recoveryAmount <= 0) {
            setTerminalDashboard(['Error: Please enter valid Recovery Stake amount!']);
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
        setLossStreak(0);
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
                startFastMovingCodes(mode, stake, stopLoss, takeProfit);
            }
        }, 1000);
    };

    const handleClosePopup = () => {
        stopTimerSound();
        stopTrading();
        setPopupOpen(false);
    };

    const handleMarketChange = (symbol: string) => {
        stopTrading();
        setSelectedSymbol(symbol);
    };

    const handleStrategyChange = (nextStrategy: TScannerStrategy) => {
        stopTrading();
        setStrategy(nextStrategy);
        // Reset barrier and contract type when strategy changes
        setSelectedBarrier('');
        setSelectedContractType('');
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
                <div className='content-wrapper'>
                    <h1>Signal Analyzer</h1>
                    
                    <div className='form-group'>
                        <label htmlFor='strategy'>Select Strategy</label>
                        <select id='strategy' className='dropdown' value={strategy} onChange={event => handleStrategyChange(event.target.value as TScannerStrategy)}>
                            {STRATEGIES.map(item => (
                                <option key={item}>{item}</option>
                            ))}
                        </select>
                    </div>

                    {getBarrierOptions().length > 0 && (
                        <div className='form-group'>
                            <label htmlFor='barrier'>Select Barrier (Optional)</label>
                            <select id='barrier' className='dropdown' value={selectedBarrier} onChange={event => setSelectedBarrier(event.target.value)}>
                                <option value=''>Auto-detect</option>
                                {getBarrierOptions().map(barrier => (
                                    <option key={barrier} value={barrier}>{barrier}</option>
                                ))}
                            </select>
                        </div>
                    )}

                    {getContractTypeOptions().length > 0 && (
                        <div className='form-group'>
                            <label htmlFor='contract-type'>Select Contract Type (Optional)</label>
                            <select id='contract-type' className='dropdown' value={selectedContractType} onChange={event => setSelectedContractType(event.target.value)}>
                                <option value=''>Auto-detect</option>
                                {getContractTypeOptions().map(type => (
                                    <option key={type} value={type}>{type}</option>
                                ))}
                            </select>
                        </div>
                    )}

                    <div className='form-group'>
                        <label htmlFor='market'>Select Market</label>
                        <select id='market' className='dropdown' value={selectedSymbol} onChange={event => handleMarketChange(event.target.value)}>
                            {MARKETS.map(market => (
                                <option key={market.symbol} value={market.symbol}>
                                    {market.label}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className='form-row'>
                        <div className='form-group half'>
                            <label htmlFor='stake'>Stake</label>
                            <input id='stake' className='dropdown' inputMode='decimal' value={stakeInput} onChange={event => setStakeInput(cleanMoneyInput(event.target.value))} />
                        </div>
                        <div className='form-group half'>
                            <label htmlFor='recovery-stake'>Recovery Stake</label>
                            <input id='recovery-stake' className='dropdown' inputMode='decimal' value={recoveryStake} onChange={event => setRecoveryStake(cleanMoneyInput(event.target.value))} />
                        </div>
                    </div>

                    <div className='form-row'>
                        <div className='form-group half'>
                            <label htmlFor='stop-loss'>Stop Loss</label>
                            <input id='stop-loss' className='dropdown' inputMode='decimal' value={stopLossInput} onChange={event => setStopLossInput(cleanMoneyInput(event.target.value))} />
                        </div>
                        <div className='form-group half'>
                            <label htmlFor='take-profit'>Take Profit</label>
                            <input id='take-profit' className='dropdown' inputMode='decimal' value={takeProfitInput} onChange={event => setTakeProfitInput(cleanMoneyInput(event.target.value))} />
                        </div>
                    </div>

                    <div className='form-group'>
                        <label htmlFor='martingale'>Martingale Multiplier</label>
                        <input id='martingale' className='dropdown' inputMode='decimal' value={martingaleMultiplier} onChange={event => setMartingaleMultiplier(cleanMoneyInput(event.target.value))} />
                    </div>

                    <div className='form-group'>
                        <label htmlFor='mode'>Mode</label>
                        <select id='mode' className='dropdown' value={mode} onChange={event => handleModeChange(event.target.value as TScannerMode)}>
                            <option>Analyze</option>
                            <option>Trade</option>
                        </select>
                    </div>

                    <div className='stats-container'>
                        <div className='stat-card'>
                            <span className='stat-label'>Latest Tick:</span>
                            <span className='stat-value'>{latestTick?.quote ?? '--'}</span>
                        </div>
                        <div className='stat-card'>
                            <span className='stat-label'>Last Digit:</span>
                            <span className='stat-value'>{latestDigit ?? '--'}</span>
                        </div>
                        <div className='stat-card'>
                            <span className='stat-label'>P/L:</span>
                            <span className={`stat-value ${sessionProfit >= 0 ? 'profit' : 'loss'}`}>
                                {sessionProfit.toFixed(2)} {currency}
                            </span>
                        </div>
                        {lossStreak > 0 && (
                            <div className='stat-card'>
                                <span className='stat-label'>Loss Streak:</span>
                                <span className='stat-value loss'>{lossStreak}</span>
                            </div>
                        )}
                    </div>

                    <div className='buttons'>
                        <button className='analyse' type='button' onClick={handleAnalyze} disabled={isWorking}>
                            {isWorking ? 'Running...' : 'Analyse & Trade'}
                        </button>
                    </div>
                </div>
            </div>
            <div className='popup' style={{ display: popupOpen ? 'block' : 'none' }}>
                <div className='popup-content'>
                    <button className='close-btn' type='button' onClick={handleClosePopup}>
                        ✕
                    </button>
                    <div className='terminal-header'>
                        <span className='dot red' />
                        <span className='dot yellow' />
                        <span className='dot green' />
                        <span className='terminal-title'>Scanner Terminal</span>
                    </div>
                    <div className='terminal-dashboard'>
                        {terminalDashboard.map((line, index) => (
                            <p className={line?.includes('Error') ? 'red' : line?.includes('WIN') ? 'green-bold' : line?.includes('LOSS') ? 'red-bold' : 'green'} key={`${line}-${index}`}>
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
