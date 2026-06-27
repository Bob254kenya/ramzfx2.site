import React, { useEffect, useState } from 'react';
import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import { useLocation, useNavigate } from 'react-router-dom';
import { generateOAuthURL, isDomainFeatureEnabled } from '@/components/shared';
import DesktopWrapper from '@/components/shared_ui/desktop-wrapper';
import Dialog from '@/components/shared_ui/dialog';
import MobileWrapper from '@/components/shared_ui/mobile-wrapper';
import Tabs from '@/components/shared_ui/tabs/tabs';
import TradeTypeConfirmationModal from '@/components/trade-type-confirmation-modal';
import { DBOT_TABS, TAB_IDS } from '@/constants/bot-contents';
import { api_base, updateWorkspaceName } from '@/external/bot-skeleton';
import { CONNECTION_STATUS } from '@/external/bot-skeleton/services/api/observables/connection-status-stream';
import { isDbotRTL } from '@/external/bot-skeleton/utils/workspace';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import {
    disableUrlParameterApplication,
    enableUrlParameterApplication,
    setupTradeTypeChangeListener,
} from '@/utils/blockly-url-param-handler';
import { recordDiagnosticEvent } from '@/utils/diagnostics';
import {
    checkAndShowTradeTypeModal,
    getModalState,
    handleTradeTypeCancel,
    handleTradeTypeConfirm,
    resetUrlParamProcessing,
    setModalStateChangeCallback,
} from '@/utils/trade-type-modal-handler';
import {
    LabelPairedChartLineCaptionRegularIcon,
    LabelPairedChartMixedCaptionRegularIcon,
    LabelPairedChartTrendUpCaptionRegularIcon,
    LabelPairedCircleStarCaptionRegularIcon,
    LabelPairedLightbulbCaptionRegularIcon,
    LabelPairedObjectsColumnCaptionRegularIcon,
    LabelPairedPuzzlePieceTwoCaptionBoldIcon,
    LabelPairedSearchCaptionRegularIcon,
} from '@deriv/quill-icons/LabelPaired';
import { Localize, localize } from '@deriv-com/translations';
import { useDevice } from '@deriv-com/ui';
import RunPanel from '../../components/run-panel';
import AutoTrades from '../auto-trades/auto-trades';
import BestBots from '../best-bots';
import BotIdeas from '../bot-ideas';
import ChartModal from '../chart/chart-modal';
import Dashboard from '../dashboard';
import ManualTrading from '../manual-trading';
import RunStrategy from '../dashboard/run-strategy';
import Analysistool from '../analysistool';
import Scanner from '../scanner';
import './main.scss';

// ==================== LOADER COMPONENT ====================
interface LoaderProps {
    progress?: number;
    message?: string;
    showProgress?: boolean;
    totalDuration?: number; // Total duration in seconds
}

const Loader: React.FC<LoaderProps> = ({ 
    progress: externalProgress, 
    message = 'Loading...', 
    showProgress = true,
    totalDuration = 15 // Default 15 seconds
}) => {
    const [internalProgress, setInternalProgress] = useState(0);
    const [currentMessage, setCurrentMessage] = useState(message);
    const progress = externalProgress !== undefined ? externalProgress : internalProgress;

    // Progress messages based on percentage
    const getProgressMessage = (progressValue: number): string => {
        if (progressValue < 10) return 'Initializing system...';
        if (progressValue < 20) return 'Loading core modules...';
        if (progressValue < 30) return 'Connecting to servers...';
        if (progressValue < 40) return 'Loading RAMFX engine...';
        if (progressValue < 50) return 'Configuring trading tools...';
        if (progressValue < 60) return 'Loading bot strategies...';
        if (progressValue < 70) return 'Setting up workspace...';
        if (progressValue < 80) return 'Optimizing performance...';
        if (progressValue < 90) return 'Finalizing configuration...';
        if (progressValue < 100) return 'Almost ready...';
        return 'Ready!';
    };

    useEffect(() => {
        if (externalProgress === undefined) {
            const startTime = Date.now();
            const totalMs = totalDuration * 1000;
            
            const interval = setInterval(() => {
                const elapsed = Date.now() - startTime;
                const calculatedProgress = Math.min((elapsed / totalMs) * 100, 99);
                
                setInternalProgress(calculatedProgress);
                setCurrentMessage(getProgressMessage(calculatedProgress));
                
                if (calculatedProgress >= 99) {
                    clearInterval(interval);
                    // Set to 100% when complete
                    setTimeout(() => {
                        setInternalProgress(100);
                        setCurrentMessage('Ready!');
                    }, 100);
                }
            }, 50); // Update every 50ms for smooth animation

            return () => clearInterval(interval);
        }
    }, [externalProgress, totalDuration]);

    return (
        <div className="loader-overlay">
            <div className="loader-container">
                {/* RAMFX SVG Logo with Spinning Animation */}
                <div className="loader-logo-wrapper">
                    <svg 
                        className="loader-logo-spin"
                        width="140" 
                        height="140" 
                        viewBox="0 0 200 200" 
                        fill="none" 
                        xmlns="http://www.w3.org/2000/svg"
                    >
                        {/* Outer Glow Ring */}
                        <circle 
                            cx="100" 
                            cy="100" 
                            r="92" 
                            stroke="#00ff00" 
                            strokeWidth="1" 
                            opacity="0.1"
                        />
                        
                        {/* Progress Ring */}
                        <circle 
                            cx="100" 
                            cy="100" 
                            r="92" 
                            stroke="#00ff00" 
                            strokeWidth="3" 
                            strokeDasharray="578.05" 
                            strokeDashoffset={578.05 - (578.05 * Math.min(progress, 100) / 100)}
                            opacity="0.9"
                            className="loader-progress-ring"
                            strokeLinecap="round"
                        />
                        
                        {/* Inner Ring */}
                        <circle 
                            cx="100" 
                            cy="100" 
                            r="70" 
                            stroke="#00ff88" 
                            strokeWidth="1" 
                            opacity="0.2"
                        />
                        
                        {/* RAMFX Text Logo */}
                        <text 
                            x="100" 
                            y="82" 
                            textAnchor="middle" 
                            fill="#00ff00" 
                            fontSize="44" 
                            fontWeight="bold" 
                            fontFamily="'Courier New', monospace"
                            letterSpacing="4"
                            className="loader-logo-text"
                            style={{ textShadow: '0 0 20px rgba(0, 255, 0, 0.3)' }}
                        >
                            RAM
                        </text>
                        <text 
                            x="100" 
                            y="128" 
                            textAnchor="middle" 
                            fill="#00ff88" 
                            fontSize="30" 
                            fontWeight="bold" 
                            fontFamily="'Courier New', monospace"
                            letterSpacing="6"
                            className="loader-logo-text"
                            style={{ textShadow: '0 0 20px rgba(0, 255, 88, 0.3)' }}
                        >
                            FX
                        </text>
                        
                        {/* Center Dot */}
                        <circle 
                            cx="100" 
                            cy="100" 
                            r="4" 
                            fill="#00ff00" 
                            className="loader-center-dot"
                        >
                            <animate 
                                attributeName="r" 
                                values="3;6;3" 
                                dur="1.5s" 
                                repeatCount="indefinite"
                            />
                            <animate 
                                attributeName="opacity" 
                                values="0.5;1;0.5" 
                                dur="1.5s" 
                                repeatCount="indefinite"
                            />
                        </circle>
                        
                        {/* Orbiting Dots */}
                        <g>
                            <circle 
                                cx="100" 
                                cy="100" 
                                r="5" 
                                fill="#00ff00"
                                opacity="0.9"
                            >
                                <animateTransform 
                                    attributeName="transform" 
                                    type="rotate" 
                                    from="0 100 100" 
                                    to="360 100 100" 
                                    dur="4s" 
                                    repeatCount="indefinite"
                                />
                            </circle>
                            <circle 
                                cx="100" 
                                cy="100" 
                                r="4" 
                                fill="#00ff88"
                                opacity="0.7"
                            >
                                <animateTransform 
                                    attributeName="transform" 
                                    type="rotate" 
                                    from="120 100 100" 
                                    to="480 100 100" 
                                    dur="4s" 
                                    repeatCount="indefinite"
                                />
                            </circle>
                            <circle 
                                cx="100" 
                                cy="100" 
                                r="4" 
                                fill="#00ffcc"
                                opacity="0.5"
                            >
                                <animateTransform 
                                    attributeName="transform" 
                                    type="rotate" 
                                    from="240 100 100" 
                                    to="600 100 100" 
                                    dur="4s" 
                                    repeatCount="indefinite"
                                />
                            </circle>
                        </g>
                        
                        {/* Decorative Lines */}
                        <line 
                            x1="100" 
                            y1="12" 
                            x2="100" 
                            y2="28" 
                            stroke="#00ff00" 
                            strokeWidth="2" 
                            opacity="0.6"
                            className="loader-top-line"
                        >
                            <animate 
                                attributeName="opacity" 
                                values="0.3;0.8;0.3" 
                                dur="2s" 
                                repeatCount="indefinite"
                            />
                        </line>
                        <line 
                            x1="100" 
                            y1="172" 
                            x2="100" 
                            y2="188" 
                            stroke="#00ff00" 
                            strokeWidth="2" 
                            opacity="0.6"
                            className="loader-bottom-line"
                        >
                            <animate 
                                attributeName="opacity" 
                                values="0.3;0.8;0.3" 
                                dur="2s" 
                                begin="1s" 
                                repeatCount="indefinite"
                            />
                        </line>
                        <line 
                            x1="12" 
                            y1="100" 
                            x2="28" 
                            y2="100" 
                            stroke="#00ff00" 
                            strokeWidth="2" 
                            opacity="0.4"
                        >
                            <animate 
                                attributeName="opacity" 
                                values="0.2;0.6;0.2" 
                                dur="2.5s" 
                                begin="0.5s" 
                                repeatCount="indefinite"
                            />
                        </line>
                        <line 
                            x1="172" 
                            y1="100" 
                            x2="188" 
                            y2="100" 
                            stroke="#00ff00" 
                            strokeWidth="2" 
                            opacity="0.4"
                        >
                            <animate 
                                attributeName="opacity" 
                                values="0.2;0.6;0.2" 
                                dur="2.5s" 
                                begin="1.5s" 
                                repeatCount="indefinite"
                            />
                        </line>
                    </svg>
                </div>

                {/* Loading Message */}
                <p className="loader-text">{currentMessage}</p>
                
                {/* Progress Bar */}
                {showProgress && (
                    <div className="loader-progress-bar-wrapper">
                        <div className="loader-progress-track">
                            <div 
                                className="loader-progress-fill"
                                style={{ width: `${Math.min(progress, 100)}%` }}
                            />
                        </div>
                        <span className="loader-progress-percentage">
                            {Math.round(Math.min(progress, 100))}%
                        </span>
                    </div>
                )}
                
                {/* Time Remaining */}
                <div className="loader-time-remaining">
                    <span className="loader-time-text">
                        {progress < 100 ? `Loading... ${Math.round((100 - progress) / (100 / 15))}s remaining` : 'Ready!'}
                    </span>
                </div>
            </div>
        </div>
    );
};

// ==================== SOCIAL POPUP COMPONENT ====================
const SocialPopup: React.FC = () => {
    const [isVisible, setIsVisible] = useState(true);

    React.useEffect(() => {
        const styleSheet = document.createElement("style");
        styleSheet.textContent = `
            @keyframes slideInRight {
                from {
                    opacity: 0;
                    transform: translateX(120px);
                }
                to {
                    opacity: 1;
                    transform: translateX(0);
                }
            }
        `;
        document.head.appendChild(styleSheet);
        
        return () => {
            document.head.removeChild(styleSheet);
        };
    }, []);

    if (!isVisible) return null;

    const handleClose = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setIsVisible(false);
    };

    const handleLinkClick = (e: React.MouseEvent<HTMLAnchorElement>, url: string) => {
        e.preventDefault();
        e.stopPropagation();
        window.open(url, '_blank', 'noopener,noreferrer');
    };

    return (
        <div className="social-popup" onClick={(e) => e.stopPropagation()}>
            <div className="social-content">
                <button 
                    className="social-close"
                    onClick={handleClose}
                    type="button"
                >
                    ✕
                </button>
                <h3>CONNECT WITH US</h3>
                <div className="social-links">
                    <a 
                        href="#"
                        onClick={(e) => handleLinkClick(e, "https://wa.me/+254757261120")}
                    >
                        📱 WhatsApp
                    </a>
                    <a 
                        href="#"
                        onClick={(e) => handleLinkClick(e, "https://t.me/+YDUwvuuVDYg5NjE0")}
                    >
                        ✈️ Telegram
                    </a>
                    <a 
                        href="#"
                        onClick={(e) => handleLinkClick(e, "https://www.youtube.com/@ceoramz")}
                    >
                        ▶️ YouTube
                    </a>
                    <a 
                        href="#"
                        onClick={(e) => handleLinkClick(e, "https://tiktok.com/@ceoramz")}
                    >
                        🎵 TikTok
                    </a>
                    <a 
                        href="#"
                        onClick={(e) => handleLinkClick(e, "https://www.instagram.com/ramztrader.site?igsh=aDY1aGFiMGpobHJi")}
                    >
                        📷 Instagram
                    </a>
                    <a 
                        href="#"
                        onClick={(e) => handleLinkClick(e, "https://www.facebook.com/profile.php?id=61573399294689")}
                    >
                        💬 Discord
                    </a>
                    <a 
                        href="#"
                        onClick={(e) => handleLinkClick(e, "https://www.instagram.com/ramztrader.site?igsh=aDY1aGFiMGpobHJi")}
                    >
                        🐦 Twitter
                    </a>
                </div>
            </div>
        </div>
    );
};
// ==============================================

const AppWrapper = observer(() => {
    const { connectionStatus } = useApiBase();
    const { dashboard, load_modal, run_panel, quick_strategy, summary_card, blockly_store } = useStore();
    const { is_loading } = blockly_store;
    const {
        active_tab,
        active_tour,
        active_trading_module,
        cancelPendingTradingNavigation,
        confirmPendingTradingNavigation,
        is_leave_trading_dialog_open,
        navigation_stop_in_progress,
        setActiveTab,
        setWebSocketState,
        setActiveTour,
        setTourDialogVisibility,
    } = dashboard;
    const { dashboard_strategies } = load_modal;
    const {
        is_dialog_open,
        is_drawer_open,
        dialog_options,
        onCancelButtonClick,
        onCloseDialog,
        onOkButtonClick,
        stopBot,
    } = run_panel;
    const { is_open } = quick_strategy;
    const { cancel_button_text, ok_button_text, title, message, dismissable, is_closed_on_cancel } = dialog_options as {
        [key: string]: string;
    };
    const { clear } = summary_card;
    const { BOT_BUILDER, BOT_IDEAS, DASHBOARD, AUTO_TRADES, MANUAL_TRADING, SCANNER } = DBOT_TABS;
    const init_render = React.useRef(true);
    const hash = [
        'bot_ideas',
        'best_bots',
        'dashboard',
        'bot_builder',
        'auto_trades',
        'manual_trading',
        'scanner',
        'analysistool',
    ];
    const show_bot_ideas = isDomainFeatureEnabled('botIdeas');
    const show_auto_trades = isDomainFeatureEnabled('autoTrades');
    const show_manual_trading = isDomainFeatureEnabled('manualTrading');
    const show_scanner = isDomainFeatureEnabled('scanner');
    const isMainTabVisible = (tab_index: number) => {
        if (tab_index === BOT_IDEAS) return show_bot_ideas;
        if (tab_index === AUTO_TRADES) return show_auto_trades;
        if (tab_index === MANUAL_TRADING) return show_manual_trading;
        if (tab_index === SCANNER) return show_scanner;
        return true;
    };
    const { isDesktop } = useDevice();
    const location = useLocation();
    const navigate = useNavigate();
    const [left_tab_shadow, setLeftTabShadow] = useState<boolean>(false);
    const [right_tab_shadow, setRightTabShadow] = useState<boolean>(false);

    // Loader states - forced 15 seconds
    const [showGlobalLoader, setShowGlobalLoader] = useState<boolean>(true);
    const [loaderProgress, setLoaderProgress] = useState<number>(0);
    const [loaderMessage, setLoaderMessage] = useState<string>('Initializing...');

    // Trade type modal state
    const [tradeTypeModalState, setTradeTypeModalState] = useState(getModalState());

    /**
     * Helper function to get modal props with enhanced type safety and clear documentation
     */
    const getTradeTypeModalProps = () => {
        const { tradeTypeData } = tradeTypeModalState;

        return {
            is_visible: tradeTypeModalState.isVisible,
            trade_type_display_name: tradeTypeData?.displayName || '',
            current_trade_type: tradeTypeData?.currentTradeType
                ? `${tradeTypeData.currentTradeType.tradeTypeCategory}/${tradeTypeData.currentTradeType.tradeType}`
                : 'N/A',
            current_trade_type_display_name: tradeTypeData?.currentTradeTypeDisplayName || 'N/A',
            onConfirm: handleTradeTypeConfirm,
            onCancel: handleTradeTypeCancel,
        };
    };

    let tab_value: number | string = active_tab;
    const GetHashedValue = (tab: number) => {
        tab_value = location.hash?.split('#')[1];
        if (!tab_value) return isMainTabVisible(tab) ? tab : DBOT_TABS.BEST_BOTS;
        const hash_tab_index = Number(hash.indexOf(String(tab_value)));
        return hash_tab_index >= 0 && isMainTabVisible(hash_tab_index) ? hash_tab_index : DBOT_TABS.BEST_BOTS;
    };
    const active_hash_tab = GetHashedValue(active_tab);

    // Force 15-second loader
    useEffect(() => {
        // Show loader immediately
        setShowGlobalLoader(true);
        setLoaderMessage('Initializing RAMFX System...');
        
        // Progress steps for 15 seconds
        const progressSteps = [
            { time: 1, progress: 5, message: 'Loading core modules...' },
            { time: 2, progress: 10, message: 'Connecting to servers...' },
            { time: 3, progress: 20, message: 'Loading RAMFX engine...' },
            { time: 4, progress: 30, message: 'Configuring trading tools...' },
            { time: 5, progress: 40, message: 'Loading bot strategies...' },
            { time: 6, progress: 50, message: 'Setting up workspace...' },
            { time: 7, progress: 55, message: 'Optimizing performance...' },
            { time: 8, progress: 65, message: 'Loading algorithms...' },
            { time: 9, progress: 75, message: 'Initializing AI models...' },
            { time: 10, progress: 80, message: 'Finalizing configuration...' },
            { time: 11, progress: 85, message: 'Loading user data...' },
            { time: 12, progress: 90, message: 'Almost ready...' },
            { time: 13, progress: 93, message: 'Finalizing setup...' },
            { time: 14, progress: 96, message: 'Preparing workspace...' },
            { time: 15, progress: 100, message: 'Ready!' },
        ];

        let stepIndex = 0;
        const startTime = Date.now();
        const totalDuration = 15000; // 15 seconds in milliseconds

        const interval = setInterval(() => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min((elapsed / totalDuration) * 100, 100);
            
            // Update message based on progress
            const currentStep = progressSteps.find(step => progress <= step.progress);
            if (currentStep) {
                setLoaderMessage(currentStep.message);
            } else {
                setLoaderMessage('Loading...');
            }
            
            setLoaderProgress(progress);
            
            // When complete, hide loader after a brief delay
            if (progress >= 100) {
                clearInterval(interval);
                setLoaderMessage('Ready!');
                setTimeout(() => {
                    setShowGlobalLoader(false);
                    setLoaderProgress(0);
                }, 800);
            }
        }, 50); // Update every 50ms for smooth animation

        return () => clearInterval(interval);
    }, []); // Run once on mount

    // Set up modal state change listener
    useEffect(() => {
        setModalStateChangeCallback(new_state => {
            setTradeTypeModalState(new_state);
        });
    }, [is_loading]);

    // Reset URL parameter processing when location changes
    useEffect(() => {
        resetUrlParamProcessing();
    }, [location.search]);

    useEffect(() => {
        const el_dashboard = document.getElementById('id-dbot-dashboard');
        const el_last_tab = document.getElementById('id-analysistool');

        const observer_dashboard = new window.IntersectionObserver(
            ([entry]) => {
                if (entry.isIntersecting) {
                    setLeftTabShadow(false);
                    return;
                }
                setLeftTabShadow(true);
            },
            {
                root: null,
                threshold: 0.5,
            }
        );

        const observer_last_tab = new window.IntersectionObserver(
            ([entry]) => {
                if (entry.isIntersecting) {
                    setRightTabShadow(false);
                    return;
                }
                setRightTabShadow(true);
            },
            {
                root: null,
                threshold: 0.5,
            }
        );
        if (el_dashboard) observer_dashboard.observe(el_dashboard);
        if (el_last_tab) observer_last_tab.observe(el_last_tab);

        return () => {
            observer_dashboard.disconnect();
            observer_last_tab.disconnect();
        };
    }, []);

    useEffect(() => {
        const is_recoverable_trading_module = active_trading_module === 'auto_trades';

        if (connectionStatus === CONNECTION_STATUS.OPENED) {
            setWebSocketState(true);
            if (is_recoverable_trading_module) {
                run_panel.setShowBotStopMessage?.(false);
                recordDiagnosticEvent('dashboard.trading_connection_recovered', {
                    activeModule: active_trading_module,
                    activeTab: active_tab,
                });
            }
            return;
        }

        if (is_recoverable_trading_module) {
            run_panel.setShowBotStopMessage?.(false);
            setWebSocketState(true);
            recordDiagnosticEvent('dashboard.trading_connection_recovering', {
                activeModule: active_trading_module,
                activeTab: active_tab,
                connectionStatus,
            });
            return;
        }

        if (connectionStatus !== CONNECTION_STATUS.OPENED) {
            const is_bot_running = document.getElementById('db-animation__stop-button') !== null;
            if (!is_bot_running) return;

            clear();
            stopBot();
            api_base.setIsRunning(false);
            setWebSocketState(false);
        }
    }, [active_tab, active_trading_module, clear, connectionStatus, run_panel, setWebSocketState, stopBot]);

    // Update tab shadows height to match bot builder height
    const updateTabShadowsHeight = () => {
        const botBuilderEl = document.getElementById('id-bot-builder');
        const leftShadow = document.querySelector('.tabs-shadow--left') as HTMLElement;
        const rightShadow = document.querySelector('.tabs-shadow--right') as HTMLElement;

        if (botBuilderEl && leftShadow && rightShadow) {
            const height = botBuilderEl.offsetHeight;
            leftShadow.style.height = `${height}px`;
            rightShadow.style.height = `${height}px`;
        }
    };

    useEffect(() => {
        let pollTimeoutId: ReturnType<typeof setTimeout> | null = null;

        // Handle URL trade type parameters when switching to Bot Builder tab
        if (active_tab === BOT_BUILDER) {
            requestAnimationFrame(() => {
                disableUrlParameterApplication();
                setupTradeTypeChangeListener();

                const handleTradeTypeModal = () => {
                    checkAndShowTradeTypeModal(
                        () => {
                            enableUrlParameterApplication();
                        },
                        () => {}
                    );
                };

                if (!blockly_store.is_loading) {
                    setTimeout(() => {
                        handleTradeTypeModal();
                    }, 500);
                } else {
                    let pollAttempts = 0;
                    const maxPollAttempts = 10;

                    const checkBlocklyLoaded = () => {
                        if (!blockly_store.is_loading) {
                            handleTradeTypeModal();
                            return;
                        }

                        if (pollAttempts < maxPollAttempts) {
                            pollAttempts++;
                            pollTimeoutId = setTimeout(checkBlocklyLoaded, 500);
                        } else {
                            console.warn(
                                'Blockly loading timeout after 5 seconds - proceeding without URL parameter check'
                            );
                        }
                    };

                    checkBlocklyLoaded();
                }
            });
        }

        return () => {
            if (pollTimeoutId) {
                clearTimeout(pollTimeoutId);
                pollTimeoutId = null;
            }
        };
    }, [active_tab, is_loading]);

    useEffect(() => {
        updateTabShadowsHeight();

        if (is_open) {
            setTourDialogVisibility(false);
        }
        if (init_render.current) {
            setActiveTab(Number(active_hash_tab));
            if (!isDesktop) handleTabChange(Number(active_hash_tab));
            init_render.current = false;
        } else {
            const currentSearch = window.location.search;
            navigate(`${currentSearch}#${hash[active_tab] || hash[0]}`);
        }
        if (active_tour !== '') {
            setActiveTour('');
        }

        const mainElement = document.querySelector('.main__container');
        if (document.body.style.overflow === 'hidden') {
            document.body.style.overflow = '';
        }
        if (mainElement instanceof HTMLElement) {
            mainElement.classList.remove('no-scroll');
        }
    }, [active_tab]);

    useEffect(() => {
        const trashcan_init_id = setTimeout(() => {
            if (active_tab === BOT_BUILDER && Blockly?.derivWorkspace?.trashcan) {
                const trashcanY = window.innerHeight - 250;
                let trashcanX;
                if (is_drawer_open) {
                    trashcanX = isDbotRTL() ? 380 : window.innerWidth - 460;
                } else {
                    trashcanX = isDbotRTL() ? 20 : window.innerWidth - 100;
                }
                Blockly?.derivWorkspace?.trashcan?.setTrashcanPosition(trashcanX, trashcanY);
            }
        }, 100);

        return () => {
            clearTimeout(trashcan_init_id);
        };
    }, [active_tab, is_drawer_open]);

    useEffect(() => {
        const handleBeforeUnload = (event: BeforeUnloadEvent) => {
            if (!active_trading_module) return;
            recordDiagnosticEvent('window.beforeunload_blocked', {
                activeModule: active_trading_module,
                activeTab: active_tab,
            });
            event.preventDefault();
            event.returnValue = '';
        };

        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => {
            window.removeEventListener('beforeunload', handleBeforeUnload);
        };
    }, [active_trading_module]);

    useEffect(() => {
        let timer: ReturnType<typeof setTimeout>;
        if (dashboard_strategies.length > 0) {
            timer = setTimeout(() => {
                updateWorkspaceName();
            });
        }
        return () => {
            if (timer) clearTimeout(timer);
        };
    }, [dashboard_strategies, active_tab]);

    const handleTabChange = React.useCallback(
        (tab_index: number) => {
            setActiveTab(tab_index);
            if (dashboard.active_tab !== tab_index) return;
            const el_id = TAB_IDS[tab_index];
            if (el_id) {
                const el_tab = document.getElementById(el_id);
                setTimeout(() => {
                    el_tab?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
                }, 10);
            }
        },
        [dashboard, setActiveTab]
    );

    // [AI]
    const handleLoginGeneration = async () => {
        const oauthUrl = await generateOAuthURL();
        if (oauthUrl) {
            window.location.replace(oauthUrl);
        } else {
            console.error('Failed to generate OAuth URL');
        }
    };
    // [/AI]
    
    return (
        <React.Fragment>
            {/* Global Loader - Forced 15 seconds */}
            {showGlobalLoader && (
                <Loader 
                    progress={loaderProgress} 
                    message={loaderMessage}
                    showProgress={true}
                    totalDuration={15}
                />
            )}

            <div className='main'>
                <div
                    className={classNames('main__container', {
                        'main__container--active': active_tour && active_tab === DASHBOARD && !isDesktop,
                        'main__container--with-open-run-panel': isDesktop && is_drawer_open,
                    })}
                >
                    <div>
                        {!isDesktop && left_tab_shadow && <span className='tabs-shadow tabs-shadow--left' />}
                        <Tabs active_index={active_tab} className='main__tabs' onTabItemClick={handleTabChange} top>
                            {show_bot_ideas && (
                                <div
                                    label={
                                        <>
                                            <LabelPairedLightbulbCaptionRegularIcon
                                                height='24px'
                                                width='24px'
                                                fill='#c8a45d'
                                            />
                                            <Localize i18n_default_text='Ramzfx Bot Ideas' />
                                        </>
                                    }
                                    id='id-bot-ideas'
                                >
                                    <BotIdeas />
                                </div>
                            )}
                            <div
                                label={
                                    <>
                                        <LabelPairedCircleStarCaptionRegularIcon
                                            height='24px'
                                            width='24px'
                                            fill='#c8a45d'
                                        />
                                        <Localize i18n_default_text='Free Bots' />
                                    </>
                                }
                                id='id-best-bots'
                            >
                                <BestBots />
                            </div>
                            <div
                                label={
                                    <>
                                        <LabelPairedObjectsColumnCaptionRegularIcon
                                            height='24px'
                                            width='24px'
                                            fill='#c8a45d'
                                        />
                                        <Localize i18n_default_text='Dashboard' />
                                    </>
                                }
                                id='id-dbot-dashboard'
                            >
                                <Dashboard handleTabChange={handleTabChange} />
                            </div>
                            <div
                                label={
                                    <>
                                        <LabelPairedPuzzlePieceTwoCaptionBoldIcon
                                            height='24px'
                                            width='24px'
                                            fill='#c8a45d'
                                        />
                                        <Localize i18n_default_text='Bot Builder' />
                                    </>
                                }
                                id='id-bot-builder'
                            />
                            {show_auto_trades && (
                                <div
                                    label={
                                        <>
                                            <LabelPairedChartTrendUpCaptionRegularIcon
                                                height='24px'
                                                width='24px'
                                                fill='#c8a45d'
                                            />
                                            <Localize i18n_default_text='Ramzfx Ultimate Bot' />
                                        </>
                                    }
                                    id='id-auto-trades'
                                >
                                    <AutoTrades />
                                </div>
                            )}
                            {show_manual_trading && (
                                <div
                                    label={
                                        <>
                                            <LabelPairedChartMixedCaptionRegularIcon
                                                height='24px'
                                                width='24px'
                                                fill='#c8a45d'
                                            />
                                            <Localize i18n_default_text='Manual Trading' />
                                        </>
                                    }
                                    id='id-manual-trading'
                                >
                                    <ManualTrading />
                                </div>
                            )}
                            {show_scanner ? (
                                <div
                                    label={
                                        <>
                                            <LabelPairedSearchCaptionRegularIcon
                                                height='24px'
                                                width='24px'
                                                fill='#c8a45d'
                                            />
                                            <Localize i18n_default_text='ProScanner Tool' />
                                        </>
                                    }
                                    id='id-scanner'
                                >
                                    <Scanner />
                                </div>
                            ) : null}
                            <div
                                label={
                                    <>
                                        <LabelPairedChartLineCaptionRegularIcon
                                            height='24px'
                                            width='24px'
                                            fill='#c8a45d'
                                        />
                                        <Localize i18n_default_text='Ramzfx Analysis Tool' />
                                    </>
                                }
                                id='id-analysistool'
                            >
                                <Analysistool />
                            </div>
                        </Tabs>
                        {!isDesktop && right_tab_shadow && <span className='tabs-shadow tabs-shadow--right' />}
                    </div>
                </div>
            </div>
            <DesktopWrapper>
                <div className='main__run-strategy-wrapper'>
                    <RunStrategy />
                    <RunPanel />
                </div>
                <ChartModal />
            </DesktopWrapper>
            <MobileWrapper>{!is_open && <RunPanel />}</MobileWrapper>
            <Dialog
                cancel_button_text={
                    navigation_stop_in_progress ? undefined : localize('Stay')
                }
                className='dc-dialog__wrapper--fixed'
                confirm_button_text={
                    navigation_stop_in_progress ? localize('Stopping trades...') : localize('Stop and switch')
                }
                has_close_icon={!navigation_stop_in_progress}
                is_mobile_full_width={false}
                is_visible={is_leave_trading_dialog_open}
                onCancel={navigation_stop_in_progress ? undefined : cancelPendingTradingNavigation}
                onClose={navigation_stop_in_progress ? undefined : cancelPendingTradingNavigation}
                onConfirm={() => {
                    if (!navigation_stop_in_progress) {
                        void confirmPendingTradingNavigation();
                    }
                }}
                portal_element_id='modal_root'
                title={localize('Active trading is running')}
                login={handleLoginGeneration}
                dismissable={!navigation_stop_in_progress}
                is_closed_on_cancel={false}
                is_closed_on_confirm={false}
            >
                <Localize i18n_default_text='Leaving this page now can interrupt live executions. Stop the active trades and switch tabs, or stay here and keep the session running.' />
            </Dialog>
            <Dialog
                cancel_button_text={cancel_button_text || localize('Cancel')}
                className='dc-dialog__wrapper--fixed'
                confirm_button_text={ok_button_text || localize('Ok')}
                has_close_icon
                is_mobile_full_width={false}
                is_visible={is_dialog_open}
                onCancel={onCancelButtonClick}
                onClose={onCloseDialog}
                onConfirm={onOkButtonClick || onCloseDialog}
                portal_element_id='modal_root'
                title={title}
                login={handleLoginGeneration}
                dismissable={dismissable}
                is_closed_on_cancel={is_closed_on_cancel}
            >
                {message}
            </Dialog>

            {/* Trade Type Confirmation Modal */}
            {(() => {
                const modalProps = getTradeTypeModalProps();
                return (
                    <TradeTypeConfirmationModal
                        is_visible={modalProps.is_visible}
                        trade_type_display_name={modalProps.trade_type_display_name}
                        current_trade_type={modalProps.current_trade_type}
                        current_trade_type_display_name={modalProps.current_trade_type_display_name}
                        onConfirm={modalProps.onConfirm}
                        onCancel={modalProps.onCancel}
                    />
                );
            })()}

            {/* Social Popup Component */}
            <SocialPopup />
        </React.Fragment>
    );
});

export default AppWrapper;
