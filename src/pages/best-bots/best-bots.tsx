import { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { getBestBotsFileUrl, getBestBotsFolder } from '@/components/shared';
import { DBOT_TABS } from '@/constants/bot-contents';
import { load, save_types } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import { API_BASE } from '@/utils/api-base';
import { setActiveBot } from '@/utils/bot-tracker';
import './best-bots.scss';

type TBot = {
    id: string;
    name: string;
    file: string;
    description: string;
    emoji: string;
};

type TBotStats = {
    bot_id: string;
    total_runs: number;
    profits: number;
    losses: number;
    profit_amount?: number | string | null;
    loss_amount?: number | string | null;
};

type TBotManifestEntry = {
    id?: string;
    name?: string;
    file: string;
    description?: string;
    emoji?: string;
};

const formatMoney = (value: number | string | null | undefined) => {
    const n = Number(value || 0);
    const sign = n < 0 ? '-' : '';
    return `${sign}$${Math.abs(n).toFixed(2)}`;
};

const toBotId = (file: string) =>
    file
        .replace(/\.xml$/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

const createRiskManagersBot = (file: string): TBot => {
    const name = file.replace(/\.xml$/i, '');

    return {
        id: toBotId(file),
        name,
        file,
        description: `${name} loads into Bot Builder and executes through the standard purchase conditions.`,
        emoji: 'RM',
    };
};

const createManifestBot = (entry: TBotManifestEntry): TBot => {
    const name = entry.name || entry.file.replace(/\.xml$/i, '');

    return {
        id: entry.id || toBotId(entry.file),
        name,
        file: entry.file,
        description:
            entry.description || `${name} loads into Bot Builder and executes through the standard purchase conditions.`,
        emoji: entry.emoji || 'BOT',
    };
};

const RISK_MANAGERS_BOTS: TBot[] = [
    'grffy v1.xml',
    'Mr Duke Speed Bot.1.xml',
    'Wealth Generator.xml',
].map(createRiskManagersBot);

const TERMICA_BOTS: TBot[] = [
    {
        id: 'termica-pro',
        name: 'Ramzfx Pro Bot',
        file: 'D1-BY MR.DUKE(+254702490526).xml',
        description: 'Professional Ramzfx strategy tuned for consistent signal execution.',
        emoji: '🔥',
    },
    {
        id: 'termica-classic',
        name: 'Ramzfx Classic Bot',
        file: 'D2 BY--MR.DUKE(+254702490526) (1).xml',
        description: 'Classic Ramzfx setup with simple, reliable trade logic.',
        emoji: '⭐',
    },
    {
        id: 'termica-rise-fall',
        name: 'Ramzfx Rise & Fall Bot',
        file: 'The-D3 rise and fall.xml',
        description: 'Ramzfx trend strategy focused on rise and fall market moves.',
        emoji: '📊',
    },
    {
        id: 'termica-prime',
        name: 'Ramzfx Prime Bot',
        file: 'D4 Update by MR.DUKE(+254702490526)FINAL  (%%%)) (1) (1) (1).xml',
        description: 'Prime Ramzfx configuration with refined entry conditions.',
        emoji: '🏆',
    },
    {
        id: 'termica-original',
        name: 'Ramzfx Original Bot',
        file: 'D5 (Original version +254702490526).xml',
        description: 'Original Ramzfx-styled strategy for dependable bot loading.',
        emoji: '🔵',
    },
    {
        id: 'termica-fx',
        name: 'Termica FX Bot',
        file: 'D6 Deriv by Duke (1).xml',
        description: 'Ramzfx  edition with smooth execution for active traders.',
        emoji: '🎯',
    },
    {
        id: 'termica-devil',
        name: 'Ramzfx Devil Bot',
        file: 'BLACK DEVIL v2( By MR. DUKE).xml',
        description: 'Aggressive Ramzfx strategy with fast reaction logic.',
        emoji: '😈',
    },
    {
        id: 'termica-edge',
        name: 'Ramzfx Edge Bot',
        file: 'grffy.xml',
        description: 'Ramzfx edge setup for volatility-based opportunities.',
        emoji: '🔲',
    },
    {
        id: 'termica-shield',
        name: 'Ramzfx Shield Bot',
        file: 'Kiazala v1 by The Risk Manager (1).xml',
        description: 'Risk-aware Ramzfx bot built for disciplined capital protection.',
        emoji: '🛡️',
    },
    {
        id: 'termica-momentum',
        name: 'Ramzfx Momentum Bot',
        file: 'KUMI NA NNE BORA V2  (1) (1).xml',
        description: 'Momentum-focused Termica strategy with layered entries.',
        emoji: '📈',
    },
    {
        id: 'termica-slow',
        name: 'Ramzfx Pole Bot',
        file: 'Mwenda Pole By The Risk Manager (1).xml',
        description: 'Slow and steady Ramzfx setup for conservative execution.',
        emoji: '🐢',
    },
    {
        id: 'termica-ai',
        name: 'Ramzfx AI Bot',
        file: 'Simba Ai v1.xml',
        description: 'AI-styled Ramzfx bot combining pattern logic and smart exits.',
        emoji: '🦁',
    },
    {
        id: 'termica-turbo',
        name: 'Ramzfx Turbo Bot',
        file: 'Speedhack by mrduke.site 00 (1).xml',
        description: 'Fast Ramzfx execution for high-movement market conditions.',
        emoji: '🚀',
    },
    {
        id: 'termica-digit-pro',
        name: 'Ramzfx  Digit Pro Bot',
        file: 'under 7,8,9= g2 bot 1==.xml',
        description: 'Ramzfx digit strategy for specialised over/under setups.',
        emoji: '🎲',
    },
    {
        id: 'termica-wealth',
        name: 'Ramzfx Wealth Bot',
        file: 'Wealth Generator.xml',
        description: 'Ramzfx wealth strategy focused on structured account growth.',
        emoji: '💰',
    },
];

const OPTIMUM_BOTS: TBot[] = [
    {
        id: 'dollar-printer-original',
        name: 'Dollar Printer Bot Original',
        file: '$DollarprinterbotOrignal$ (1).xml',
        description: 'Original Dollar Printer strategy tuned for steady returns.',
        emoji: '💵',
    },
    {
        id: 'dollar-printer-2025',
        name: 'Dollar Printer 2025 Version',
        file: '1 2025 $Orginal DollarPrinterBot  2025 Version $ (1).xml',
        description: '2025 refreshed Dollar Printer with updated parameters.',
        emoji: '💵',
    },
    {
        id: 'tick-digit-over-2',
        name: 'Tick Digit Over 2',
        file: '1 tick DIgit Over 2.xml',
        description: 'Specialised digit bot targeting over 2 on ticks.',
        emoji: '🔢',
    },
    {
        id: 'alpha-2025',
        name: 'Alpha Version 2025',
        file: '2025 Alpha Version 2025.xml',
        description: 'Alpha 2025 strategy with fresh market logic.',
        emoji: '🚀',
    },
    {
        id: 'candle-mine-v3-updated',
        name: 'Candle Mine v3 Updated',
        file: '3 Updated Version Of Candle Mine????.xml',
        description: 'Improved Candle Mine strategy for pattern trading.',
        emoji: '🕯️',
    },
    {
        id: 'auto-analysis',
        name: 'Auto Analysis Bot',
        file: 'AUTO ANALYSIS BOT.xml',
        description: 'Automated analysis bot that adapts to market conditions.',
        emoji: '📊',
    },
    {
        id: 'candle-mine-3-1',
        name: 'Candle Mine 3.1',
        file: 'Candle mine version 3.1.xml',
        description: 'Stable Candle Mine release version 3.1.',
        emoji: '🕯️',
    },
    {
        id: 'coolkid',
        name: 'CoolKid Bot',
        file: 'COOLKID.xml',
        description: 'Fun and effective CoolKid trading logic.',
        emoji: '😎',
    },
    {
        id: 'deriv-wizard-1',
        name: 'Deriv Wizard 1',
        file: 'Deriv wizard 1.xml',
        description: 'Wizard-style Deriv bot for reliable execution.',
        emoji: '🧙',
    },
    {
        id: 'digit-hyper',
        name: 'Digit Hyper Bot',
        file: 'Digit hyper.xml',
        description: 'High-speed digit trading bot.',
        emoji: '⚡',
    },
    {
        id: 'even-odd-speed',
        name: 'Even Odd Speed Bot',
        file: 'Even odd speed bot.xml',
        description: 'Fast even/odd market speed strategy.',
        emoji: '🏎️',
    },
    {
        id: 'ezekey-sniper-lite',
        name: 'Ezekey Sniper Lite',
        file: 'Ezekey sniper lite.xml',
        description: 'Lightweight sniper bot for precise entries.',
        emoji: '🎯',
    },
    {
        id: 'falcon',
        name: 'Falcon Bot',
        file: 'FALCON BOT.xml',
        description: 'Aggressive Falcon hunting strategy.',
        emoji: '🦅',
    },
    {
        id: 'gibuu-v8-pro',
        name: 'GIBUU V8 Pro',
        file: 'GIBUU V8 PRO.xml',
        description: 'Pro-grade GIBUU V8 trading system.',
        emoji: '🛡️',
    },
    {
        id: 'hennessy-matrix-v5',
        name: 'Hennessy Matrix V5 Original',
        file: 'HENNESSY?? _MATRIX V5 BOT Orig..xml',
        description: 'Original Hennessy Matrix V5 with matrix logic.',
        emoji: '🔷',
    },
    {
        id: 'kathy-entry-point',
        name: 'Kathy Bot Entry With Point',
        file: 'Kathy bot entry with point.xml',
        description: 'Kathy bot using precise entry points.',
        emoji: '📍',
    },
    {
        id: 'm27-original',
        name: 'M27 Original Version',
        file: 'M27 Original version.xml',
        description: 'Classic M27 original strategy.',
        emoji: '🧩',
    },
    {
        id: 'mask-evenodd',
        name: 'Mask EvenOdd Bot',
        file: 'Mask evenodd bot.xml',
        description: 'Masked even/odd detection bot.',
        emoji: '🎭',
    },
    {
        id: 'mask-matches-speed',
        name: 'Mask Matches Speed Bot',
        file: 'mask matches speed bot ??.xml',
        description: 'Speed-optimised matches/differs mask bot.',
        emoji: '🏃',
    },
    {
        id: 'matches-differs',
        name: 'Matches and Differs Bot',
        file: 'MATCHES AND DIFFERS BOT.xml',
        description: 'Dedicated matches & differs trading bot.',
        emoji: '🔄',
    },
    {
        id: 'mega-pro',
        name: 'Mega Pro Bot',
        file: 'MEGA PRO BOT.xml',
        description: 'High-performance Mega Pro strategy.',
        emoji: '⭐',
    },
    {
        id: 'night-cap-printer',
        name: 'Night Cap Printer Bot',
        file: 'NIGHT  CAP PRINTER BOT.xml',
        description: 'Night-time focused cap printer bot.',
        emoji: '🌙',
    },
    {
        id: 'scaplex-ai-sn4',
        name: 'SCAPLEX AI SN4',
        file: 'SCAPLEX   Ai  SN4 (1) (1).xml',
        description: 'SCAPLEX AI SN4 intelligent trading system.',
        emoji: '🤖',
    },
    {
        id: 'scaucer-speed',
        name: 'Scaucer Speed Bot',
        file: 'SCAUCER SPEED BOT ????.xml',
        description: 'High-velocity Scaucer speed trading bot.',
        emoji: '💨',
    },
    {
        id: 'dollar-pro',
        name: 'The Dollar Pro',
        file: 'THE DOLLAR PRO.xml',
        description: 'Premium Dollar Pro trading strategy.',
        emoji: '💎',
    },
    {
        id: 'trend-lover',
        name: 'The Trend Lover',
        file: 'THE TREND LOVER.xml',
        description: 'Trend-following bot designed for strong moves.',
        emoji: '📈',
    },
    {
        id: 'trade-city-v2-1',
        name: 'Trade City Bot v2.1',
        file: 'TRADE CITY BOT VERSION 2.1.xml',
        description: 'Trade City v2.1 city-style market navigation.',
        emoji: '🏙️',
    },
    {
        id: 'ultra-ai-2025',
        name: 'Ultra AI 2025',
        file: 'ULTRA AI 2025.xml',
        description: 'Ultra AI 2025 next-gen intelligent bot.',
        emoji: '🧠',
    },
];

const DOLLARSIGNS_BOTS: TBot[] = [
    {
        id: 'mwenda-pole',
        name: 'Mwenda Pole By The Risk Manager (1)',
        file: 'Mwenda Pole By The Risk Manager (1).xml',
        description: 'Slow and steady conservative approach for low-risk accounts.',
        emoji: '🐢',
    },
    {
        id: 'simba-ai',
        name: 'Simba Ai v1',
        file: 'Simba Ai v1.xml',
        description: 'AI-enhanced strategy combining pattern recognition with smart exits.',
        emoji: '🦁',
    },
    {
        id: 'speedhack',
        name: 'Speedhack by mrduke.site 00 (1)',
        file: 'Speedhack by mrduke.site 00 (1).xml',
        description: 'Ultra-fast tick-based execution for volatile market conditions.',
        emoji: '🚀',
    },
    {
        id: 'd3-rise-fall',
        name: 'The-D3 rise and fall',
        file: 'The-D3 rise and fall.xml',
        description: 'Trend-following strategy targeting rise and fall market patterns.',
        emoji: '📊',
    },
    {
        id: 'under789',
        name: 'under 7,8,9= g2 bot 1==',
        file: 'under 7,8,9= g2 bot 1==.xml',
        description: 'Specialised over/under boundary strategy for digit markets.',
        emoji: '🎲',
    },
    {
        id: 'wealth-generator',
        name: 'Wealth Generator',
        file: 'Wealth Generator.xml',
        description: 'Compound growth strategy built for long-term account building.',
        emoji: '💰',
    },
];

const BOTS_BY_FOLDER: Record<string, TBot[]> = {
    'ramzfx.site': TERMICA_BOTS,
    'termicafx.site': TERMICA_BOTS,
    'optimumtraders.site': OPTIMUM_BOTS,
    'mrzetuzetu.site': OPTIMUM_BOTS,
    'masterhunter.site': RISK_MANAGERS_BOTS,
    'tradinghubs.site': [],
    'mafiahub.site': [],
    'dollarsigns.site': DOLLARSIGNS_BOTS,
};

export const getBestBotsForFolder = (bots_folder: string) => BOTS_BY_FOLDER[bots_folder] ?? [];

const BotCard = observer(({ bot, stats }: { bot: TBot; stats: TBotStats | undefined }) => {
    const { dashboard, toolbar } = useStore();
    const { setActiveTab } = dashboard;
    const [loading, setLoading] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState(false);

    const handleLoad = async () => {
        setLoading(true);
        setError(false);
        try {
            const url = getBestBotsFileUrl(bot.file);
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const xml_text = await res.text();
            const workspace = window.Blockly?.derivWorkspace;
            if (!workspace) throw new Error('Workspace not ready');
            await load({
                block_string: xml_text,
                file_name: bot.name,
                workspace,
                from: save_types.LOCAL,
                drop_event: {},
                strategy_id: null,
                showIncompatibleStrategyDialog: false,
            });
            setActiveBot('best-bot', bot.id, bot.name);
            try {
                toolbar.setStrategyProtected(true);
            } catch {
                // Keep loading the bot even if toolbar protection is unavailable.
            }
            setTimeout(() => {
                const ws = window.Blockly?.derivWorkspace;
                if (ws) {
                    ws.getAllBlocks(false).forEach((block: any) => {
                        if (['before_purchase', 'after_purchase', 'purchase', 'trade_again'].includes(block.type)) {
                            block.setCollapsed(true);
                        }
                    });
                }
            }, 500);
            setLoaded(true);
            setTimeout(() => setLoaded(false), 3000);
            setActiveTab(DBOT_TABS.BOT_BUILDER);
        } catch {
            setError(true);
            setTimeout(() => setError(false), 4000);
        } finally {
            setLoading(false);
        }
    };

    const totalRuns = stats?.total_runs ?? 0;
    const profits = stats?.profits ?? 0;
    const losses = stats?.losses ?? 0;
    const profitAmount = stats?.profit_amount ?? 0;
    const lossAmount = stats?.loss_amount ?? 0;
    const netAmount = Number(profitAmount || 0) - Number(lossAmount || 0);
    const winRate = totalRuns > 0 ? Math.round((profits / totalRuns) * 100) : 0;

    return (
        <div className='bb-card'>
            <div className='bb-card__header'>
                <h3 className='bb-card__name'>{bot.name}</h3>
                <span className={`bb-card__net${netAmount >= 0 ? ' bb-card__net--profit' : ' bb-card__net--loss'}`}>
                    {formatMoney(netAmount)}
                </span>
            </div>

            <div className='bb-card__performance' aria-label={`${bot.name} performance`}>
                <span>
                    <strong>{totalRuns}</strong>
                    Runs
                </span>
                <span>
                    <strong>{winRate}%</strong>
                    Win rate
                </span>
                <span>
                    <strong>{profits}</strong>
                    Wins
                </span>
                <span>
                    <strong>{losses}</strong>
                    Losses
                </span>
            </div>

            <button
                className={`bb-card__btn${loaded ? ' bb-card__btn--loaded' : ''}${error ? ' bb-card__btn--error' : ''}${loading ? ' bb-card__btn--loading' : ''}`}
                onClick={handleLoad}
                disabled={loading}
            >
                {loading ? (
                    <>
                        <span className='bb-card__spinner' aria-hidden='true' />
                        Loading...
                    </>
                ) : loaded ? (
                    <>✓ Loaded</>
                ) : error ? (
                    <>⚠ Retry</>
                ) : (
                    'Load Bot'
                )}
            </button>
        </div>
    );
});

const BestBots = () => {
    const [statsMap, setStatsMap] = useState<Record<string, TBotStats>>({});
    const botsFolder = getBestBotsFolder();
    const [bots, setBots] = useState<TBot[]>(() => getBestBotsForFolder(botsFolder));
    const [pageLoading, setPageLoading] = useState(true);

    useEffect(() => {
        let isMounted = true;
        const configuredBots = getBestBotsForFolder(botsFolder);

        setBots(configuredBots);

        fetch(getBestBotsFileUrl('bots.json'))
            .then(response => {
                if (!response.ok) return [];
                return response.json();
            })
            .then((manifestBots: TBotManifestEntry[]) => {
                if (!isMounted || !Array.isArray(manifestBots)) return;
                const dynamicBots = manifestBots
                    .filter(bot => bot?.file?.toLowerCase().endsWith('.xml'))
                    .map(createManifestBot);
                const mergedBots = [...configuredBots];
                const seenFiles = new Set(mergedBots.map(bot => bot.file));

                dynamicBots.forEach(bot => {
                    if (!seenFiles.has(bot.file)) {
                        mergedBots.push(bot);
                        seenFiles.add(bot.file);
                    }
                });

                setBots(mergedBots);
            })
            .catch(() => {
                if (isMounted) setBots(configuredBots);
            })
            .finally(() => {
                if (isMounted) setPageLoading(false);
            });

        return () => {
            isMounted = false;
        };
    }, [botsFolder]);

    useEffect(() => {
        const loadStats = () => {
            fetch(`${API_BASE}/best-bot-stats`)
                .then(r => r.json())
                .then((rows: TBotStats[]) => {
                    const map: Record<string, TBotStats> = {};
                    rows.forEach(r => {
                        map[r.bot_id] = r;
                    });
                    setStatsMap(map);
                })
                .catch(() => {});
        };
        loadStats();
        const interval = setInterval(loadStats, 30_000);
        return () => clearInterval(interval);
    }, []);

    const rankedBots = [...bots].sort((a, b) => {
        const sa = statsMap[a.id];
        const sb = statsMap[b.id];
        const netA = Number(sa?.profit_amount || 0) - Number(sa?.loss_amount || 0);
        const netB = Number(sb?.profit_amount || 0) - Number(sb?.loss_amount || 0);
        if (netB !== netA) return netB - netA;
        const pa = sa?.profits ?? 0;
        const pb = sb?.profits ?? 0;
        if (pb !== pa) return pb - pa;
        const la = sa?.losses ?? 0;
        const lb = sb?.losses ?? 0;
        return la - lb;
    });

    if (pageLoading) {
        return (
            <div className='best-bots'>
                <div className='best-bots__skeleton-grid'>
                    {Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} className='bb-skeleton'>
                            <div className='bb-skeleton__header'>
                                <div className='bb-skeleton__emoji' />
                                <div className='bb-skeleton__badge' />
                            </div>
                            <div className='bb-skeleton__title' />
                            <div className='bb-skeleton__title bb-skeleton__title--short' />
                            <div className='bb-skeleton__stats'>
                                <div className='bb-skeleton__stat' />
                                <div className='bb-skeleton__stat' />
                                <div className='bb-skeleton__stat' />
                                <div className='bb-skeleton__stat' />
                            </div>
                            <div className='bb-skeleton__btn' />
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div className='best-bots'>
            <div className='best-bots__grid'>
                {rankedBots.length > 0 ? (
                    rankedBots.map(bot => <BotCard key={bot.id} bot={bot} stats={statsMap[bot.id]} />)
                ) : (
                    <p className='best-bots__empty'>No bots configured for this domain yet.</p>
                )}
            </div>
        </div>
    );
};

export default BestBots;
