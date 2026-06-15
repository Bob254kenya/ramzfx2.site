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

// ==================== SOCIAL POPUP COMPONENT ====================
const SocialPopup: React.FC = () => {
    const [isVisible, setIsVisible] = useState(true);

    // Add keyframes animation to document head
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

    // Handle close button click with proper event prevention
    const handleClose = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setIsVisible(false);
    };

    // Handle link clicks to prevent any issues
    const handleLinkClick = (e: React.MouseEvent<HTMLAnchorElement>, url: string) => {
        e.preventDefault();
        e.stopPropagation();
        window.open(url, '_blank', 'noopener,noreferrer');
    };

    const popupContainerStyle: React.CSSProperties = {
        position: 'fixed',
        bottom: '25px',
        right: '25px',
        zIndex: 9999,
        animation: 'slideInRight 0.4s ease-out',
        fontFamily: "'Courier New', 'Orbitron', monospace",
    };

    const contentStyle: React.CSSProperties = {
        background: 'linear-gradient(135deg, #0a0a0a 0%, #111111 100%)',
        border: '2px solid #00ff00',
        borderRadius: '16px',
        padding: '20px',
        minWidth: '250px',
        boxShadow: '0 0 30px rgba(0, 255, 0, 0.3), inset 0 0 20px rgba(0, 255, 0, 0.05)',
        position: 'relative',
        backdropFilter: 'blur(10px)',
        transition: 'all 0.3s ease',
    };

    const closeButtonStyle: React.CSSProperties = {
        position: 'absolute',
        top: '10px',
        right: '10px',
        background: '#ff0044',
        color: 'white',
        border: 'none',
        borderRadius: '50%',
        width: '26px',
        height: '26px',
        cursor: 'pointer',
        fontSize: '12px',
        fontWeight: 'bold',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'all 0.2s ease',
        zIndex: 10000,
    };

    const titleStyle: React.CSSProperties = {
        color: '#00ff00',
        margin: '0 0 18px 0',
        textAlign: 'center',
        fontSize: '0.9rem',
        letterSpacing: '2px',
        textTransform: 'uppercase',
        fontWeight: 'bold',
        textShadow: '0 0 8px #00ff00',
    };

    const linksContainerStyle: React.CSSProperties = {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
    };

    const linkStyle: React.CSSProperties = {
        color: '#00ff00',
        textDecoration: 'none',
        padding: '8px 14px',
        border: '1px solid rgba(0, 255, 0, 0.3)',
        borderRadius: '10px',
        transition: 'all 0.25s ease',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        fontSize: '0.85rem',
        fontFamily: 'monospace',
        fontWeight: 500,
        background: 'rgba(0, 0, 0, 0.4)',
        backdropFilter: 'blur(4px)',
    };

    return (
        <div style={popupContainerStyle} onClick={(e) => e.stopPropagation()}>
            <div style={contentStyle}>
                <button 
                    style={closeButtonStyle}
                    onClick={handleClose}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.transform = 'scale(1.1)';
                        e.currentTarget.style.background = '#ff3355';
                        e.currentTarget.style.boxShadow = '0 0 10px #ff0044';
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.transform = 'scale(1)';
                        e.currentTarget.style.background = '#ff0044';
                        e.currentTarget.style.boxShadow = 'none';
                    }}
                    type="button"
                >
                    ✕
                </button>
                <h3 style={titleStyle}>CONNECT WITH US</h3>
                <div style={linksContainerStyle}>
                    <a 
                        href="#"
                        onClick={(e) => handleLinkClick(e, "https://whatsapp.com")}
                        style={linkStyle}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'rgba(0, 255, 0, 0.12)';
                            e.currentTarget.style.transform = 'translateX(6px)';
                            e.currentTarget.style.borderColor = '#00ff00';
                            e.currentTarget.style.boxShadow = '0 0 12px rgba(0, 255, 0, 0.4)';
                            e.currentTarget.style.textShadow = '0 0 4px #00ff00';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'rgba(0, 0, 0, 0.4)';
                            e.currentTarget.style.transform = 'translateX(0)';
                            e.currentTarget.style.borderColor = 'rgba(0, 255, 0, 0.3)';
                            e.currentTarget.style.boxShadow = 'none';
                            e.currentTarget.style.textShadow = 'none';
                        }}
                    >
                        📱 WhatsApp
                    </a>
                    <a 
                        href="#"
                        onClick={(e) => handleLinkClick(e, "https://telegram.org")}
                        style={linkStyle}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'rgba(0, 255, 0, 0.12)';
                            e.currentTarget.style.transform = 'translateX(6px)';
                            e.currentTarget.style.borderColor = '#00ff00';
                            e.currentTarget.style.boxShadow = '0 0 12px rgba(0, 255, 0, 0.4)';
                            e.currentTarget.style.textShadow = '0 0 4px #00ff00';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'rgba(0, 0, 0, 0.4)';
                            e.currentTarget.style.transform = 'translateX(0)';
                            e.currentTarget.style.borderColor = 'rgba(0, 255, 0, 0.3)';
                            e.currentTarget.style.boxShadow = 'none';
                            e.currentTarget.style.textShadow = 'none';
                        }}
                    >
                        ✈️ Telegram
                    </a>
                    <a 
                        href="#"
                        onClick={(e) => handleLinkClick(e, "https://youtube.com")}
                        style={linkStyle}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'rgba(0, 255, 0, 0.12)';
                            e.currentTarget.style.transform = 'translateX(6px)';
                            e.currentTarget.style.borderColor = '#00ff00';
                            e.currentTarget.style.boxShadow = '0 0 12px rgba(0, 255, 0, 0.4)';
                            e.currentTarget.style.textShadow = '0 0 4px #00ff00';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'rgba(0, 0, 0, 0.4)';
                            e.currentTarget.style.transform = 'translateX(0)';
                            e.currentTarget.style.borderColor = 'rgba(0, 255, 0, 0.3)';
                            e.currentTarget.style.boxShadow = 'none';
                            e.currentTarget.style.textShadow = 'none';
                        }}
                    >
                        ▶️ YouTube
                    </a>
                    <a 
                        href="#"
                        onClick={(e) => handleLinkClick(e, "https://tiktok.com")}
                        style={linkStyle}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'rgba(0, 255, 0, 0.12)';
                            e.currentTarget.style.transform = 'translateX(6px)';
                            e.currentTarget.style.borderColor = '#00ff00';
                            e.currentTarget.style.boxShadow = '0 0 12px rgba(0, 255, 0, 0.4)';
                            e.currentTarget.style.textShadow = '0 0 4px #00ff00';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'rgba(0, 0, 0, 0.4)';
                            e.currentTarget.style.transform = 'translateX(0)';
                            e.currentTarget.style.borderColor = 'rgba(0, 255, 0, 0.3)';
                            e.currentTarget.style.boxShadow = 'none';
                            e.currentTarget.style.textShadow = 'none';
                        }}
                    >
                        🎵 TikTok
                    </a>
                    <a 
                        href="#"
                        onClick={(e) => handleLinkClick(e, "https://instagram.com")}
                        style={linkStyle}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'rgba(0, 255, 0, 0.12)';
                            e.currentTarget.style.transform = 'translateX(6px)';
                            e.currentTarget.style.borderColor = '#00ff00';
                            e.currentTarget.style.boxShadow = '0 0 12px rgba(0, 255, 0, 0.4)';
                            e.currentTarget.style.textShadow = '0 0 4px #00ff00';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'rgba(0, 0, 0, 0.4)';
                            e.currentTarget.style.transform = 'translateX(0)';
                            e.currentTarget.style.borderColor = 'rgba(0, 255, 0, 0.3)';
                            e.currentTarget.style.boxShadow = 'none';
                            e.currentTarget.style.textShadow = 'none';
                        }}
                    >
                        📷 Instagram
                    </a>
                    <a 
                        href="#"
                        onClick={(e) => handleLinkClick(e, "https://discord.com")}
                        style={linkStyle}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'rgba(0, 255, 0, 0.12)';
                            e.currentTarget.style.transform = 'translateX(6px)';
                            e.currentTarget.style.borderColor = '#00ff00';
                            e.currentTarget.style.boxShadow = '0 0 12px rgba(0, 255, 0, 0.4)';
                            e.currentTarget.style.textShadow = '0 0 4px #00ff00';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'rgba(0, 0, 0, 0.4)';
                            e.currentTarget.style.transform = 'translateX(0)';
                            e.currentTarget.style.borderColor = 'rgba(0, 255, 0, 0.3)';
                            e.currentTarget.style.boxShadow = 'none';
                            e.currentTarget.style.textShadow = 'none';
                        }}
                    >
                        💬 Discord
                    </a>
                    <a 
                        href="#"
                        onClick={(e) => handleLinkClick(e, "https://twitter.com")}
                        style={linkStyle}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'rgba(0, 255, 0, 0.12)';
                            e.currentTarget.style.transform = 'translateX(6px)';
                            e.currentTarget.style.borderColor = '#00ff00';
                            e.currentTarget.style.boxShadow = '0 0 12px rgba(0, 255, 0, 0.4)';
                            e.currentTarget.style.textShadow = '0 0 4px #00ff00';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'rgba(0, 0, 0, 0.4)';
                            e.currentTarget.style.transform = 'translateX(0)';
                            e.currentTarget.style.borderColor = 'rgba(0, 255, 0, 0.3)';
                            e.currentTarget.style.boxShadow = 'none';
                            e.currentTarget.style.textShadow = 'none';
                        }}
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

    // Trade type modal state
    const [tradeTypeModalState, setTradeTypeModalState] = useState(getModalState());

    /**
     * Helper function to get modal props with enhanced type safety and clear documentation
     *
     * Props serve distinct purposes:
     * - current_trade_type: Technical identifier for API/internal use (format: "category/type")
     * - current_trade_type_display_name: Human-readable name for UI display
     *
     * This separation ensures proper data flow between technical systems and user interface
     */
    const getTradeTypeModalProps = () => {
        const { tradeTypeData } = tradeTypeModalState;

        return {
            is_visible: tradeTypeModalState.isVisible,
            trade_type_display_name: tradeTypeData?.displayName || '',

            // Technical identifier for internal/API use (e.g., "callput/callput")
            // Used by backend systems and technical integrations
            current_trade_type: tradeTypeData?.currentTradeType
                ? `${tradeTypeData.currentTradeType.tradeTypeCategory}/${tradeTypeData.currentTradeType.tradeType}`
                : 'N/A',

            // Human-readable display name for UI (e.g., "Rise/Fall")
            // Used for user-facing text and modal content
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

    // Set up modal state change listener
    React.useEffect(() => {
        setModalStateChangeCallback(new_state => {
            setTradeTypeModalState(new_state);
        });
    }, [is_loading]);

    // Reset URL parameter processing when location changes
    React.useEffect(() => {
        resetUrlParamProcessing();
    }, [location.search]);

    React.useEffect(() => {
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

    React.useEffect(() => {
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

    React.useEffect(() => {
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

    React.useEffect(() => {
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

    React.useEffect(() => {
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
            <div className='main'>
                <div
                    className={classNames('main__container', {
                        'main__container--active': active_tour && active_tab === DASHBOARD && !isDesktop,
                        'main__container--with-open-run-panel': isDesktop && is_drawer_open,
                    })}
                >
                    <div>
                        {!isDesktop && left_tab_shadow && <span className='tabs-shadow tabs-shadow--left' />}{' '}
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
                        {!isDesktop && right_tab_shadow && <span className='tabs-shadow tabs-shadow--right' />}{' '}
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
