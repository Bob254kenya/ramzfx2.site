import { useCallback, useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { DBOT_TABS } from '@/constants/bot-contents';
import { useStore } from '@/hooks/useStore';
import './deriv-education.scss';

// Types
interface Lesson {
  id: string;
  title: string;
  description: string;
  content: string[];
  example?: string;
  formula?: string;
}

interface Indicator {
  id: string;
  name: string;
  acronym: string;
  category: 'trend' | 'momentum' | 'volatility' | 'other';
  description: string;
  settings: string;
  strengths: string[];
  weaknesses: string[];
  useAsFilter: string;
}

interface Strategy {
  id: string;
  name: string;
  type: string;
  description: string;
  steps: string[];
  riskLevel: 'low' | 'medium' | 'high';
  winRate: string;
  bestFor: string;
  confidenceScore: number;
}

interface AnalysisTool {
  id: string;
  name: string;
  description: string;
  howToUse: string[];
  example: string;
}

const INDICATORS: Indicator[] = [
  {
    id: 'sma',
    name: 'Simple Moving Average',
    acronym: 'SMA',
    category: 'trend',
    description: 'Average price over a specified period, equally weighted.',
    settings: 'Periods: 10, 20, 50, 100, 200',
    strengths: ['Easy to understand', 'Clear trend direction', 'Widely accepted'],
    weaknesses: ['Lagging indicator', 'Slow to react', 'Sensitive to outliers'],
    useAsFilter: 'Use SMA to determine overall trend direction. Trade only when price is above SMA for uptrend, below for downtrend.'
  },
  {
    id: 'ema',
    name: 'Exponential Moving Average',
    acronym: 'EMA',
    category: 'trend',
    description: 'Weighted average giving more importance to recent prices.',
    settings: 'Periods: 9, 12, 26, 50',
    strengths: ['More responsive', 'Reduces lag', 'Popular with traders'],
    weaknesses: ['Still lagging', 'False signals in range'],
    useAsFilter: 'Use EMA crossovers as confirmation. Example: 9 EMA crossing 21 EMA signals momentum change.'
  },
  {
    id: 'wma',
    name: 'Weighted Moving Average',
    acronym: 'WMA',
    category: 'trend',
    description: 'Linear-weighted average emphasizing recent data.',
    settings: 'Periods: 10-20, increasing weights',
    strengths: ['More responsive than SMA', 'Smoother than EMA'],
    weaknesses: ['Complex calculation', 'Still lags'],
    useAsFilter: 'Trade in direction of WMA slope. Steeper slope = stronger trend.'
  },
  {
    id: 'hma',
    name: 'Hull Moving Average',
    acronym: 'HMA',
    category: 'trend',
    description: 'Smooth moving average designed to reduce lag.',
    settings: 'Periods: 16, 20, 50',
    strengths: ['Virtually no lag', 'Very smooth', 'Excellent trend'],
    weaknesses: ['Complex to calculate', 'Minor repainting'],
    useAsFilter: 'Price crossing HMA indicates momentum change. Use as entry signal.'
  },
  {
    id: 'macd',
    name: 'Moving Average Convergence Divergence',
    acronym: 'MACD',
    category: 'momentum',
    description: 'Shows relationship between two moving averages and momentum.',
    settings: 'Fast: 12, Slow: 26, Signal: 9',
    strengths: ['Shows momentum', 'Divergence signals', 'Popular'],
    weaknesses: ['Lagging', 'False signals in ranging'],
    useAsFilter: 'MACD crossing above signal line = bullish. Below = bearish. Divergence = potential reversal.'
  },
  {
    id: 'rsi',
    name: 'Relative Strength Index',
    acronym: 'RSI',
    category: 'momentum',
    description: 'Measures speed and change of price movements.',
    settings: 'Period: 14, Overbought: 70, Oversold: 30',
    strengths: ['Clear overbought/oversold', 'Divergence signals', 'Popular'],
    weaknesses: ['Can stay overbought/oversold', 'False signals in trends'],
    useAsFilter: 'Avoid buying when RSI > 70 (overbought). Avoid selling when RSI < 30 (oversold).'
  },
  {
    id: 'stochastic',
    name: 'Stochastic Oscillator',
    acronym: 'Stochastic',
    category: 'momentum',
    description: 'Compares closing price to price range over time.',
    settings: '%K: 14, %D: 3, Smoothing: 3',
    strengths: ['Identifies turning points', 'Overbought/oversold', 'Divergence'],
    weaknesses: ['False signals in trends', 'Can be early'],
    useAsFilter: 'Buy when %K crosses above %D in oversold area. Sell when crosses below in overbought.'
  },
  {
    id: 'bollinger',
    name: 'Bollinger Bands',
    acronym: 'BB',
    category: 'volatility',
    description: 'Volatility bands placed above and below moving average.',
    settings: 'Period: 20, Standard Deviations: 2',
    strengths: ['Volatility measurement', 'Support/resistance levels', 'Breakout signals'],
    weaknesses: ['Lagging', 'Can be whipsawed'],
    useAsFilter: 'Price touching lower band = oversold. Touching upper band = overbought. Breakouts from bands signal volatility expansion.'
  },
  {
    id: 'atr',
    name: 'Average True Range',
    acronym: 'ATR',
    category: 'volatility',
    description: 'Measures market volatility over a period.',
    settings: 'Period: 14',
    strengths: ['Volatility measurement', 'Stop loss placement', 'Position sizing'],
    weaknesses: ['Lagging', 'No direction'],
    useAsFilter: 'High ATR = increased volatility. Lower stake sizes when ATR is high.'
  },
  {
    id: 'adx',
    name: 'Average Directional Index',
    acronym: 'ADX',
    category: 'trend',
    description: 'Measures trend strength, not direction.',
    settings: 'Period: 14',
    strengths: ['Trend strength measurement', 'Works with +DI/-DI'],
    weaknesses: ['Lagging', 'No direction on its own'],
    useAsFilter: 'ADX > 25 = trending. ADX < 20 = ranging. Trade only when ADX shows trending conditions.'
  },
  {
    id: 'parabolic_sar',
    name: 'Parabolic SAR',
    acronym: 'PSAR',
    category: 'trend',
    description: 'Shows potential reversal points with dots above/below price.',
    settings: 'Step: 0.02, Maximum step: 0.2',
    strengths: ['Clear entry/exit', 'Trend following', 'Simple'],
    weaknesses: ['Whipsaw in range', 'Lagging'],
    useAsFilter: 'Dots below price = uptrend. Dots above price = downtrend. Trade in direction of dots.'
  },
  {
    id: 'supertrend',
    name: 'SuperTrend',
    acronym: 'ST',
    category: 'trend',
    description: 'Volatility-based trend indicator with color changes.',
    settings: 'Period: 10, Multiplier: 3',
    strengths: ['Clear signals', 'Follows trends well', 'Popular'],
    weaknesses: ['Whipsaw in range', 'Lagging'],
    useAsFilter: 'Green = uptrend, Red = downtrend. Trade in direction of color.'
  },
  {
    id: 'cci',
    name: 'Commodity Channel Index',
    acronym: 'CCI',
    category: 'momentum',
    description: 'Measures deviation from statistical mean.',
    settings: 'Period: 20, Levels: ±100',
    strengths: ['Overbought/oversold', 'Divergence', 'Early signals'],
    weaknesses: ['Can be early', 'False signals'],
    useAsFilter: 'Buy when CCI crosses above -100. Sell when crosses below +100.'
  },
  {
    id: 'momentum',
    name: 'Momentum Indicator',
    acronym: 'Momentum',
    category: 'momentum',
    description: 'Measures rate of price change over time.',
    settings: 'Period: 10',
    strengths: ['Simple', 'Clear changes', 'Early signals'],
    weaknesses: ['Can be volatile', 'False signals'],
    useAsFilter: 'Momentum rising = increasing price speed. Momentum falling = decreasing speed.'
  },
  {
    id: 'williams_r',
    name: 'Williams %R',
    acronym: '%R',
    category: 'momentum',
    description: 'Measures overbought/oversold levels.',
    settings: 'Period: 14, Overbought: -20, Oversold: -80',
    strengths: ['Clear overbought/oversold', 'Early signals', 'Popular'],
    weaknesses: ['Can stay in extremes', 'False in trends'],
    useAsFilter: 'Buy when %R > -80 (Oversold). Sell when %R < -20 (Overbought).'
  },
  {
    id: 'roc',
    name: 'Rate of Change',
    acronym: 'ROC',
    category: 'momentum',
    description: 'Shows percentage change over specified period.',
    settings: 'Period: 10',
    strengths: ['Clear momentum changes', 'Simple', 'Zero line crossovers'],
    weaknesses: ['Can be volatile', 'Lagging'],
    useAsFilter: 'ROC above 0 = bullish momentum. ROC below 0 = bearish momentum.'
  },
  {
    id: 'ichimoku',
    name: 'Ichimoku Cloud',
    acronym: 'Ichimoku',
    category: 'trend',
    description: 'Comprehensive system showing support/resistance, trend, and momentum.',
    settings: 'Tenkan: 9, Kijun: 26, Senkou: 52',
    strengths: ['Multiple signals', 'Support/resistance', 'Comprehensive'],
    weaknesses: ['Complex', 'Lagging', 'Can be overwhelming'],
    useAsFilter: 'Price above cloud = uptrend. Price below cloud = downtrend. Cloud thickness = support/resistance strength.'
  },
  {
    id: 'donchian',
    name: 'Donchian Channels',
    acronym: 'Donchian',
    category: 'volatility',
    description: 'Highest high and lowest low over specified period.',
    settings: 'Period: 20',
    strengths: ['Simple', 'Breakout signals', 'Support/resistance'],
    weaknesses: ['Lagging', 'False breakouts'],
    useAsFilter: 'Price breaking upper channel = bullish breakout. Breaking lower = bearish breakout.'
  },
  {
    id: 'keltner',
    name: 'Keltner Channels',
    acronym: 'KC',
    category: 'volatility',
    description: 'Volatility bands based on Average True Range.',
    settings: 'Period: 20, ATR multiplier: 2',
    strengths: ['Volatility adjusted', 'Support/resistance', 'Breakout signals'],
    weaknesses: ['Lagging', 'Can be whipsawed'],
    useAsFilter: 'Price touching bands indicates potential reversal or continuation.'
  },
  {
    id: 'vwap',
    name: 'Volume Weighted Average Price',
    acronym: 'VWAP',
    category: 'other',
    description: 'Average price weighted by volume.',
    settings: 'Intraday calculation',
    strengths: ['Institutional level', 'Support/resistance', 'Fair value'],
    weaknesses: ['Limited to volume data', 'Not always available'],
    useAsFilter: 'Price above VWAP = bullish. Below VWAP = bearish.'
  },
  {
    id: 'pivot_points',
    name: 'Pivot Points',
    acronym: 'Pivot',
    category: 'other',
    description: 'Support and resistance levels from previous period.',
    settings: 'Standard, Fibonacci, Woodie, Camarilla',
    strengths: ['Support/resistance levels', 'Popular', 'Entry/exit levels'],
    weaknesses: ['Self-fulfilling prophecy', 'Not always accurate'],
    useAsFilter: 'Use pivot points as support/resistance levels. Trade bounces or breakouts.'
  }
];

const LESSONS: Lesson[] = [
  {
    id: 'prob_math',
    title: 'Probability Mathematics',
    description: 'Understanding the mathematical foundation of digit trading',
    content: [
      'Each digit (0-9) has a theoretical probability of 10% in a fair market.',
      'Over/Under probabilities: Over 5 = 50%, Under 5 = 50% (digits 0-4 vs 5-9).',
      'Even/Odd probabilities: Even = 50%, Odd = 50% (digits 0,2,4,6,8 vs 1,3,5,7,9).',
      'Matches vs Differs: Match probability depends on previous digit (10%).',
      'Expected Value (EV) = (Win probability × Win amount) - (Loss probability × Loss amount).',
      'House edge = (Theoretical win rate - Actual payout odds). Typically 3-5% depending on contract.',
    ],
    example: 'If you bet $10 on a digit with 90% payout and 10% probability: EV = (0.10 × $9) - (0.90 × $10) = -$8.10 (negative EV)',
    formula: 'P(digit) = 1/10 = 10%\nP(Over) = 5/10 = 50%\nP(Even) = 5/10 = 50%\nEV = Σ(P(x) × Return(x))'
  },
  {
    id: 'stat_analysis',
    title: 'Statistical Analysis',
    description: 'Advanced statistical tools for digit analysis',
    content: [
      'Frequency tables track occurrence of each digit over time.',
      'Rolling windows (50/100/200 ticks) show evolving patterns.',
      'Standard deviation measures how much digits deviate from expected frequency.',
      'Z-score indicates how many standard deviations a digit is from the mean.',
      'Chi-square tests determine if digit distribution is significantly different from random.',
      'Confidence intervals provide a range where the true probability lies.',
      'Hot digits = appearing more frequently than expected (Z-score > 2).',
      'Cold digits = appearing less frequently than expected (Z-score < -2).'
    ],
    example: 'If digit 7 appears 15 times in 100 ticks (expected 10), Z-score = (15-10)/√(100×0.1×0.9) = 1.67 (Hot digit)'
  },
  {
    id: 'percentage_system',
    title: 'Percentage-Based Signal System',
    description: 'A scoring model for trade confidence',
    content: [
      'Digit frequency analysis: 35% weight',
      'RSI filter: 15% weight',
      'MACD confirmation: 15% weight',
      'Bollinger Band confirmation: 10% weight',
      'Trend strength (ADX): 10% weight',
      'Tick momentum: 15% weight'
    ],
    example: 'Score interpretation:\n90-100%: Strong setup - Consider entry\n80-89%: Good setup - Entry with caution\n70-79%: Moderate setup - Wait for confirmation\nBelow 70%: No trade - Continue monitoring'
  },
  {
    id: 'tick_patterns',
    title: 'Tick Pattern Analysis',
    description: 'Understanding digit sequences and patterns',
    content: [
      'Repeating digits: Identical digits in consecutive ticks.',
      'Alternating sequences: High-low-high-low patterns.',
      'Clusters: Groups of digits in the same range (0-4 or 5-9).',
      'Long runs: 3+ consecutive ticks in same direction.',
      'Rare digit appearances: Digits with low frequency over time.',
      'Transition matrices show probability from one digit to another.',
      'Markov-chain concepts analyze sequence dependencies.',
      'Momentum in digit frequencies tracks accelerating patterns.'
    ]
  },
  {
    id: 'market_sessions',
    title: 'Market Sessions',
    description: 'Optimal trading times and indices',
    content: [
      'Best times to trade: During high market liquidity (Asian, London, US overlaps).',
      'Tick speed varies: Lower volatility in Asia, higher in US session.',
      'Volatility 10: Slowest, most predictable movements.',
      'Volatility 25: Moderate volatility, good for trend strategies.',
      'Volatility 50: High volatility, more aggressive moves.',
      'Volatility 75: Very high volatility, excellent for breakout strategies.',
      'Volatility 100: Extreme volatility, high risk high reward.',
      '1HZ indices: Synthetic indices with steady tick intervals.',
      'Adapt strategies to index characteristics: Lower volatility = smaller stakes.'
    ]
  },
  {
    id: 'money_management',
    title: 'Money Management',
    description: 'Risk and capital management techniques',
    content: [
      'Fixed stake: Constant bet size regardless of account size.',
      'Percentage risk: Bet 1-2% of account per trade.',
      'Limited martingale: Double stake after losses, but with a maximum limit.',
      'Anti-martingale: Increase stake after wins, decrease after losses.',
      'Fibonacci staking: Use Fibonacci sequence (1,2,3,5,8,13).',
      'Daily stop-loss: Maximum daily loss limit to protect capital.',
      'Daily profit target: Take profits and stop trading for the day.',
      'Maximum drawdown limits: 10-15% of account as a hard rule.'
    ]
  },
  {
    id: 'trading_psychology',
    title: 'Trading Psychology',
    description: 'Mental discipline and emotional control',
    content: [
      'Patience: Waiting for the right setups, not forcing trades.',
      'Discipline: Following your system regardless of emotions.',
      'Avoiding revenge trading: Never chase losses, stick to the plan.',
      'Emotional control: Recognize fear, greed, and hope.',
      'Journaling trades: Record entry, exit, reasoning, emotions, and outcomes.',
      'Taking breaks: Step away after losses to reset perspective.',
      'Focusing on process, not results: Good process leads to good outcomes.'
    ]
  },
  {
    id: 'backtesting',
    title: 'Backtesting',
    description: 'Testing strategies on historical data',
    content: [
      'Record trades with exact entry, exit, stake, and outcome.',
      'Measure win rate: Percentage of winning trades.',
      'Profit factor: Gross profit / Gross loss (should be >1).',
      'Maximum losing streak: Most consecutive losses.',
      'Recovery analysis: Time/days to recover from drawdowns.',
      'Sharpe ratio: Risk-adjusted return measurement.',
      'Best/worst case scenarios: Optimize for worst case outcomes.',
      'Walk-forward analysis: Test on unseen data to validate strategies.'
    ]
  },
  {
    id: 'building_signal_analyzer',
    title: 'Building a Signal Analyzer',
    description: 'Creating your own analysis tool',
    content: [
      'Collect live ticks from Deriv API.',
      'Calculate digit frequencies in real-time.',
      'Track hot/cold digits with rolling windows.',
      'Compute confidence scores based on your rules.',
      'Display real-time dashboards with metrics.',
      'Generate trade alerts based on confidence thresholds.',
      'Log all signals and outcomes for analysis.',
      'Continuously refine your scoring system.'
    ]
  }
];

const STRATEGIES: Strategy[] = [
  {
    id: 'over_under',
    name: 'Over/Under Strategy',
    type: 'over-under',
    description: 'Trade based on whether next digit will be above or below 5.',
    steps: [
      'Calculate current digit frequency (last 50 ticks).',
      'Determine if Over or Under is favored.',
      'Check RSI for overbought/oversold conditions.',
      'Look for MACD confirmation.',
      'Place trade in direction of frequency advantage.',
      'Set stop-loss at 2x stake value.'
    ],
    riskLevel: 'medium',
    winRate: '55-60%',
    bestFor: 'Volatility 25-50',
    confidenceScore: 85
  },
  {
    id: 'even_odd',
    name: 'Even/Odd Strategy',
    type: 'even-odd',
    description: 'Trade based on whether next digit will be even or odd.',
    steps: [
      'Analyze even/odd distribution in last 100 ticks.',
      'Identify any deviation from 50/50.',
      'Use Stochastic oscillator for entry timing.',
      'Confirm with Bollinger Band position.',
      'Enter on favorable even/odd imbalance.',
      'Exit after 3 consecutive wins or 1 loss.'
    ],
    riskLevel: 'medium',
    winRate: '52-56%',
    bestFor: 'Volatility 10-25',
    confidenceScore: 75
  },
  {
    id: 'matches',
    name: 'Matches Strategy',
    type: 'matches',
    description: 'Trade based on whether next digit will match the previous.',
    steps: [
      'Track previous digit frequency patterns.',
      'Use Markov chain probabilities for match prediction.',
      'Apply ADX filter (ADX > 25 required).',
      'Check if digit is "hot" (Z-score > 2).',
      'Trade match when hot digit appears and ADX shows trend.',
      'Risk: 1% of account per trade.'
    ],
    riskLevel: 'high',
    winRate: '45-50%',
    bestFor: 'Volatility 50+',
    confidenceScore: 65
  },
  {
    id: 'differs',
    name: 'Differs Strategy',
    type: 'differs',
    description: 'Trade based on whether next digit will differ from the previous.',
    steps: [
      'Analyze transition probabilities between digits.',
      'Look for alternating patterns (e.g., 7-2-7-2).',
      'Use CCI for momentum confirmation.',
      'Apply trend filter (HMA direction).',
      'Trade differs when pattern is strong and momentum aligns.',
      'Use conservative stake: 0.5% of account.'
    ],
    riskLevel: 'low',
    winRate: '60-65%',
    bestFor: 'Volatility 10-25',
    confidenceScore: 90
  },
  {
    id: 'frequency',
    name: 'Frequency-Based Strategy',
    type: 'frequency',
    description: 'Trade based on digit frequency deviations from expected.',
    steps: [
      'Calculate rolling frequency for each digit (100 ticks).',
      'Identify hot digits (Z-score > 2) and cold digits (Z-score < -2).',
      'Use Parabolic SAR for trend confirmation.',
      'Trade hot digits in uptrend, cold digits in downtrend.',
      'Set confidence threshold: >80% required.',
      'Maximum 5 trades per day.'
    ],
    riskLevel: 'medium',
    winRate: '58-62%',
    bestFor: 'Volatility 25-50',
    confidenceScore: 88
  },
  {
    id: 'trend_filtered',
    name: 'Trend-Filtered Strategy',
    type: 'trend',
    description: 'Trade in direction of established trend with digit confirmation.',
    steps: [
      'Identify trend with SMA (20) and HMA (16).',
      'Trend must be confirmed (both moving averages aligned).',
      'Calculate digit frequencies in trend direction.',
      'Look for SuperTrend confirmation (green = uptrend).',
      'Enter on pullbacks in trend direction.',
      'Use Fibonacci staking: 1,2,3,5 units.'
    ],
    riskLevel: 'low',
    winRate: '62-68%',
    bestFor: 'Volatility 25-75',
    confidenceScore: 92
  },
  {
    id: 'multi_confirmation',
    name: 'Multi-Confirmation Strategy',
    type: 'multi-confirmation',
    description: 'Combine multiple confirmations before entering.',
    steps: [
      'Confirmation 1: Digit frequency advantage (35%).',
      'Confirmation 2: RSI not overbought/oversold (15%).',
      'Confirmation 3: MACD crossover (15%).',
      'Confirmation 4: Bollinger Band position (10%).',
      'Confirmation 5: ADX > 25 (10%).',
      'Confirmation 6: Tick momentum positive (15%).',
      'Trade only when total confidence >80%.'
    ],
    riskLevel: 'medium',
    winRate: '60-65%',
    bestFor: 'All indices',
    confidenceScore: 85
  },
  {
    id: 'ai_scoring',
    name: 'AI-Inspired Scoring Strategy',
    type: 'ai-scoring',
    description: 'Advanced scoring system with weighted factors.',
    steps: [
      'Score 1: Digit frequency (Weight: 30%).',
      'Score 2: RSI momentum (Weight: 20%).',
      'Score 3: Trend strength - ADX (Weight: 20%).',
      'Score 4: Volatility - ATR (Weight: 15%).',
      'Score 5: Pattern recognition (Weight: 15%).',
      'Calculate weighted average total score.',
      'Trade if total score > 85% confidence.',
      'Adjust weights based on market conditions.'
    ],
    riskLevel: 'high',
    winRate: '55-60%',
    bestFor: 'Volatility 50-100',
    confidenceScore: 80
  },
  {
    id: 'conservative',
    name: 'Conservative Strategy',
    type: 'conservative',
    description: 'Very selective, only the highest probability setups.',
    steps: [
      'Only trade when confidence score > 90%.',
      'Use fixed stake: 0.5% of account.',
      'Daily stop-loss: 2% of account.',
      'Daily profit target: 3% of account.',
      'Maximum 3 trades per day.',
      'Skip days without high-confidence setups.',
      'Exit immediately on any loss.'
    ],
    riskLevel: 'low',
    winRate: '70-75%',
    bestFor: 'Volatility 10-25',
    confidenceScore: 95
  },
  {
    id: 'aggressive',
    name: 'Aggressive Strategy',
    type: 'aggressive',
    description: 'High-frequency trading with larger stakes.',
    steps: [
      'Trade on 70%+ confidence setups.',
      'Use percentage risk: 2% of account.',
      'Limited martingale: Double stake on losses, max 3x.',
      'Daily stop-loss: 5% of account.',
      'Daily profit target: 10% of account.',
      'Trades every 5-10 ticks.',
      'Adapt quickly to changing patterns.'
    ],
    riskLevel: 'high',
    winRate: '50-55%',
    bestFor: 'Volatility 50-100',
    confidenceScore: 72
  }
];

const ANALYSIS_TOOLS: AnalysisTool[] = [
  {
    id: 'frequency_calculator',
    name: 'Digit Frequency Calculator',
    description: 'Calculate real-time digit frequencies and identify hot/cold digits.',
    howToUse: [
      'Collect last 100 tick data.',
      'Count occurrences of each digit (0-9).',
      'Calculate expected frequency (10% per digit).',
      'Compute Z-score for each digit.',
      'Identify hot digits (Z-score > 2) and cold digits (Z-score < -2).',
      'Use frequency imbalance as trade signal.'
    ],
    example: 'Digit 8 appears 16 times in 100 ticks (expected 10). Z-score = 2.00 → Hot digit. Consider trading digit 8.'
  },
  {
    id: 'confidence_scorer',
    name: 'Confidence Score Calculator',
    description: 'Calculate trade confidence based on multiple indicators.',
    howToUse: [
      'Input current indicator values.',
      'Apply weighted scoring formula.',
      'Calculate percentage confidence.',
      'Determine trade recommendation.',
      'Log scores for backtesting.',
      'Refine weights based on results.'
    ],
    example: 'Digit freq score: 85%, RSI: 70%, MACD: 80%, BB: 60%, ADX: 75%, Momentum: 90%\nWeighted total: (85×0.35) + (70×0.15) + (80×0.15) + (60×0.10) + (75×0.10) + (90×0.15) = 79.25%\nModerate confidence - consider entry with caution.'
  },
  {
    id: 'pattern_detector',
    name: 'Pattern Detector',
    description: 'Identify repeating patterns in digit sequences.',
    howToUse: [
      'Collect recent tick sequence.',
      'Look for repeating digits (e.g., 7,7,7).',
      'Identify alternating patterns (e.g., 3,8,3,8).',
      'Detect clusters (e.g., 0-2 range repeatedly).',
      'Calculate transition probabilities.',
      'Use patterns as additional confirmation.'
    ],
    example: 'Sequence: 3,8,3,8,5,5,5,2,7,7,8,3,8,3\nPattern: Alternating 3-8 appears 3 times → Consider trading this pattern.'
  },
  {
    id: 'risk_calculator',
    name: 'Risk Calculator',
    description: 'Calculate optimal stake size based on account and risk tolerance.',
    howToUse: [
      'Input account balance.',
      'Set risk percentage (1-2% recommended).',
      'Determine stop-loss distance.',
      'Calculate position size.',
      'Apply Kelly criterion for optimal sizing.',
      'Adjust based on confidence score.'
    ],
    example: 'Account: $1000, Risk: 2%, Confidence: 85%\nStake = $1000 × 0.02 = $20 (base)\nConfidence adjustment: $20 × 0.85 = $17 optimal stake'
  }
];

const DigitEducation = observer(() => {
  const { client, dashboard, toolbar } = useStore();
  const { setActiveTab } = dashboard;
  
  const [activeLesson, setActiveLesson] = useState<string | null>(null);
  const [activeStrategy, setActiveStrategy] = useState<string | null>(null);
  const [activeIndicator, setActiveIndicator] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedRiskLevel, setSelectedRiskLevel] = useState<string>('all');
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filter strategies based on search and filters
  const filteredStrategies = STRATEGIES.filter(strategy => {
    const matchesSearch = strategy.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          strategy.description.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesRisk = selectedRiskLevel === 'all' || strategy.riskLevel === selectedRiskLevel;
    const matchesCategory = selectedCategory === 'all' || strategy.type === selectedCategory;
    return matchesSearch && matchesRisk && matchesCategory;
  });

  // Filter indicators based on search and category
  const filteredIndicators = INDICATORS.filter(indicator => {
    const matchesSearch = indicator.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          indicator.acronym.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          indicator.description.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = selectedCategory === 'all' || indicator.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const getRiskColor = (risk: string) => {
    switch(risk) {
      case 'low': return '#4CAF50';
      case 'medium': return '#FF9800';
      case 'high': return '#F44336';
      default: return '#9E9E9E';
    }
  };

  const getConfidenceColor = (score: number) => {
    if (score >= 90) return '#4CAF50';
    if (score >= 80) return '#8BC34A';
    if (score >= 70) return '#FF9800';
    return '#F44336';
  };

  return (
    <div className='deriv-education-page'>
      <div className='deriv-education-page__inner'>
        {/* Header */}
        <header className='de-header'>
          <h1 className='de-header__title'>📚 Deriv Digits Trading Education</h1>
          <p className='de-header__subtitle'>
            Complete guide to trading Deriv digit contracts - From probability mathematics to advanced strategies
          </p>
          <div className='de-header__stats'>
            <span className='de-header__stat'>{INDICATORS.length} Indicators</span>
            <span className='de-header__stat'>{STRATEGIES.length} Strategies</span>
            <span className='de-header__stat'>{LESSONS.length} Lessons</span>
            <span className='de-header__stat'>{ANALYSIS_TOOLS.length} Tools</span>
          </div>
        </header>

        {/* Search and Filter */}
        <div className='de-controls'>
          <input
            className='de-controls__search'
            type='text'
            placeholder='Search indicators, strategies, or lessons...'
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />
          <div className='de-controls__filters'>
            <select 
              className='de-controls__filter'
              value={selectedCategory}
              onChange={e => setSelectedCategory(e.target.value)}
            >
              <option value='all'>All Categories</option>
              <option value='trend'>Trend Indicators</option>
              <option value='momentum'>Momentum Indicators</option>
              <option value='volatility'>Volatility Indicators</option>
              <option value='other'>Other Indicators</option>
            </select>
            <select 
              className='de-controls__filter'
              value={selectedRiskLevel}
              onChange={e => setSelectedRiskLevel(e.target.value)}
            >
              <option value='all'>All Risk Levels</option>
              <option value='low'>Low Risk</option>
              <option value='medium'>Medium Risk</option>
              <option value='high'>High Risk</option>
            </select>
          </div>
        </div>

        {/* Lessons Section */}
        <section className='de-section'>
          <h2 className='de-section__title'>📖 Core Lessons</h2>
          <div className='de-section__grid de-section__grid--lessons'>
            {LESSONS.map(lesson => (
              <div 
                key={lesson.id} 
                className={`de-lesson-card ${activeLesson === lesson.id ? 'de-lesson-card--active' : ''}`}
                onClick={() => setActiveLesson(activeLesson === lesson.id ? null : lesson.id)}
              >
                <div className='de-lesson-card__header'>
                  <h3 className='de-lesson-card__title'>{lesson.title}</h3>
                  <span className='de-lesson-card__toggle'>{activeLesson === lesson.id ? '−' : '+'}</span>
                </div>
                <p className='de-lesson-card__description'>{lesson.description}</p>
                {activeLesson === lesson.id && (
                  <div className='de-lesson-card__content'>
                    <ul className='de-lesson-card__list'>
                      {lesson.content.map((item, index) => (
                        <li key={index} className='de-lesson-card__item'>{item}</li>
                      ))}
                    </ul>
                    {lesson.formula && (
                      <div className='de-lesson-card__formula'>
                        <strong>Formula:</strong>
                        <pre>{lesson.formula}</pre>
                      </div>
                    )}
                    {lesson.example && (
                      <div className='de-lesson-card__example'>
                        <strong>Example:</strong>
                        <p>{lesson.example}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Indicators Section */}
        <section className='de-section'>
          <h2 className='de-section__title'>📊 Technical Indicators</h2>
          <div className='de-section__grid de-section__grid--indicators'>
            {filteredIndicators.map(indicator => (
              <div 
                key={indicator.id} 
                className={`de-indicator-card ${activeIndicator === indicator.id ? 'de-indicator-card--active' : ''}`}
                onClick={() => setActiveIndicator(activeIndicator === indicator.id ? null : indicator.id)}
              >
                <div className='de-indicator-card__header'>
                  <div className='de-indicator-card__title-group'>
                    <span className='de-indicator-card__acronym'>{indicator.acronym}</span>
                    <h3 className='de-indicator-card__name'>{indicator.name}</h3>
                  </div>
                  <span className='de-indicator-card__category de-indicator-card__category--' + indicator.category}>
                    {indicator.category}
                  </span>
                </div>
                <p className='de-indicator-card__description'>{indicator.description}</p>
                {activeIndicator === indicator.id && (
                  <div className='de-indicator-card__details'>
                    <div className='de-indicator-card__detail-row'>
                      <strong>Typical Settings:</strong>
                      <span>{indicator.settings}</span>
                    </div>
                    <div className='de-indicator-card__detail-row'>
                      <strong>Strengths:</strong>
                      <ul className='de-indicator-card__list'>
                        {indicator.strengths.map((strength, i) => (
                          <li key={i} className='de-indicator-card__list-item de-indicator-card__list-item--strength'>{strength}</li>
                        ))}
                      </ul>
                    </div>
                    <div className='de-indicator-card__detail-row'>
                      <strong>Weaknesses:</strong>
                      <ul className='de-indicator-card__list'>
                        {indicator.weaknesses.map((weakness, i) => (
                          <li key={i} className='de-indicator-card__list-item de-indicator-card__list-item--weakness'>{weakness}</li>
                        ))}
                      </ul>
                    </div>
                    <div className='de-indicator-card__filter'>
                      <strong>Use as Filter:</strong>
                      <p>{indicator.useAsFilter}</p>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Strategies Section */}
        <section className='de-section'>
          <h2 className='de-section__title'>🎯 Trading Strategies</h2>
          <div className='de-section__grid de-section__grid--strategies'>
            {filteredStrategies.map(strategy => (
              <div 
                key={strategy.id} 
                className={`de-strategy-card ${activeStrategy === strategy.id ? 'de-strategy-card--active' : ''}`}
                onClick={() => setActiveStrategy(activeStrategy === strategy.id ? null : strategy.id)}
              >
                <div className='de-strategy-card__header'>
                  <h3 className='de-strategy-card__name'>{strategy.name}</h3>
                  <div className='de-strategy-card__badges'>
                    <span 
                      className='de-strategy-card__risk'
                      style={{ backgroundColor: getRiskColor(strategy.riskLevel) }}
                    >
                      {strategy.riskLevel.toUpperCase()}
                    </span>
                    <span 
                      className='de-strategy-card__confidence'
                      style={{ backgroundColor: getConfidenceColor(strategy.confidenceScore) }}
                    >
                      {strategy.confidenceScore}%
                    </span>
                  </div>
                </div>
                <p className='de-strategy-card__description'>{strategy.description}</p>
                <div className='de-strategy-card__meta'>
                  <span className='de-strategy-card__meta-item'>Win Rate: {strategy.winRate}</span>
                  <span className='de-strategy-card__meta-item'>Best For: {strategy.bestFor}</span>
                </div>
                {activeStrategy === strategy.id && (
                  <div className='de-strategy-card__steps'>
                    <strong>Steps:</strong>
                    <ol className='de-strategy-card__step-list'>
                      {strategy.steps.map((step, index) => (
                        <li key={index} className='de-strategy-card__step'>{step}</li>
                      ))}
                    </ol>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Analysis Tools Section */}
        <section className='de-section'>
          <h2 className='de-section__title'>🛠️ Analysis Tools</h2>
          <div className='de-section__grid de-section__grid--tools'>
            {ANALYSIS_TOOLS.map(tool => (
              <div 
                key={tool.id} 
                className={`de-tool-card ${activeTool === tool.id ? 'de-tool-card--active' : ''}`}
                onClick={() => setActiveTool(activeTool === tool.id ? null : tool.id)}
              >
                <h3 className='de-tool-card__name'>{tool.name}</h3>
                <p className='de-tool-card__description'>{tool.description}</p>
                {activeTool === tool.id && (
                  <div className='de-tool-card__details'>
                    <div className='de-tool-card__how-to'>
                      <strong>How to Use:</strong>
                      <ol className='de-tool-card__how-list'>
                        {tool.howToUse.map((step, i) => (
                          <li key={i} className='de-tool-card__how-step'>{step}</li>
                        ))}
                      </ol>
                    </div>
                    <div className='de-tool-card__example'>
                      <strong>Example:</strong>
                      <p>{tool.example}</p>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Quick Reference */}
        <section className='de-section'>
          <h2 className='de-section__title'>⚡ Quick Reference</h2>
          <div className='de-quick-ref'>
            <div className='de-quick-ref__grid'>
              <div className='de-quick-ref__card'>
                <h4>Probability Basics</h4>
                <ul>
                  <li>Each digit: 10%</li>
                  <li>Over/Under: 50%</li>
                  <li>Even/Odd: 50%</li>
                  <li>House edge: 3-5%</li>
                </ul>
              </div>
              <div className='de-quick-ref__card'>
                <h4>Risk Guidelines</h4>
                <ul>
                  <li>Conservative: 0.5% / trade</li>
                  <li>Moderate: 1-2% / trade</li>
                  <li>Aggressive: 2-5% / trade</li>
                  <li>Daily stop: 2-10%</li>
                </ul>
              </div>
              <div className='de-quick-ref__card'>
                <h4>Best Times to Trade</h4>
                <ul>
                  <li>Asian session: 00:00-08:00 GMT</li>
                  <li>London session: 08:00-16:00 GMT</li>
                  <li>US session: 13:00-22:00 GMT</li>
                  <li>Avoid: Major news events</li>
                </ul>
              </div>
              <div className='de-quick-ref__card'>
                <h4>Psychology Rules</h4>
                <ul>
                  <li>Always use stop-loss</li>
                  <li>Never revenge trade</li>
                  <li>Journal every trade</li>
                  <li>Take breaks regularly</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className='de-footer'>
          <p className='de-footer__text'>
            This education page is for learning purposes only. Trading carries risk. Always practice proper risk management.
          </p>
          <p className='de-footer__text'>
            Recommended reading: Probability Theory, Technical Analysis, and Trading Psychology books.
          </p>
        </footer>
      </div>
    </div>
  );
});

export default DigitEducation;
