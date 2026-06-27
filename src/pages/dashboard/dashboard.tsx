// TODO: Complete MobX integration for popup functionality
// Some code is kept commented out pending popup integration
import React from 'react';
import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import GoogleDrive from '@/components/load-modal/google-drive';
import Dialog from '@/components/shared_ui/dialog';
import MobileFullPageModal from '@/components/shared_ui/mobile-full-page-modal';
import Text from '@/components/shared_ui/text';
import { DBOT_TABS } from '@/constants/bot-contents';
import { useStore } from '@/hooks/useStore';
import { Localize, localize } from '@deriv-com/translations';
import { useDevice } from '@deriv-com/ui';
/* [AI] - Analytics event tracking removed - see migrate-docs/MONITORING_PACKAGES.md for re-implementation guide */
/* [/AI] */
import DashboardBotList from './bot-list/dashboard-bot-list';

type TCardProps = {
    has_dashboard_strategies: boolean;
    is_mobile: boolean;
};

type TCardArray = {
    id: string;
    label: string;
    description: string;
    color: string;
    callback: () => void;
};

// Color mapping for each card type
const CARD_COLORS = {
    'my-computer': {
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        hover: 'linear-gradient(135deg, #5a67d8 0%, #6b46a1 100%)',
        text: '#ffffff'
    },
    'google-drive': {
        background: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
        hover: 'linear-gradient(135deg, #e881f5 0%, #e84a5f 100%)',
        text: '#ffffff'
    },
    'bot-builder': {
        background: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
        hover: 'linear-gradient(135deg, #3a9af0 0%, #00d4e8 100%)',
        text: '#ffffff'
    },
    'quick-strategy': {
        background: 'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
        hover: 'linear-gradient(135deg, #36d96b 0%, #2ee8c6 100%)',
        text: '#1a1a2e'
    }
};

// Alternative color scheme - more professional/neutral
const PROFESSIONAL_COLORS = {
    'my-computer': {
        background: '#2d3436',
        hover: '#3d4447',
        text: '#ffffff'
    },
    'google-drive': {
        background: '#0984e3',
        hover: '#0873c9',
        text: '#ffffff'
    },
    'bot-builder': {
        background: '#00b894',
        hover: '#00a381',
        text: '#ffffff'
    },
    'quick-strategy': {
        background: '#fdcb6e',
        hover: '#f5c04a',
        text: '#2d3436'
    }
};

// Another alternative - soft pastel colors
const PASTEL_COLORS = {
    'my-computer': {
        background: '#a8a4ff',
        hover: '#9793f0',
        text: '#2d3436'
    },
    'google-drive': {
        background: '#ff9ff3',
        hover: '#f08ae6',
        text: '#2d3436'
    },
    'bot-builder': {
        background: '#74b9ff',
        hover: '#5fa8e8',
        text: '#2d3436'
    },
    'quick-strategy': {
        background: '#55efc4',
        hover: '#3ddbaf',
        text: '#2d3436'
    }
};

// Choose your preferred color scheme here
const COLORS = CARD_COLORS; // Change to PROFESSIONAL_COLORS or PASTEL_COLORS as needed

// Motivational quotes for the rotating display
const MOTIVATIONAL_QUOTES = [
    "DISCIPLINE BEATS EMOTION EVERY TRADE.",
    "PATIENCE CREATES PROFITABLE TRADING OPPORTUNITIES.",
    "TRUST YOUR STRATEGY, ALWAYS EXECUTE.",
    "SMALL GAINS BUILD LASTING WEALTH.",
    "RISK LESS, EARN MUCH MORE.",
    "CONSISTENCY BEATS LUCK EVERY TIME.",
    "TRADE SMART, NEVER CHASE LOSSES.",
    "FOCUS, ANALYZE, EXECUTE, REPEAT, SUCCEED."
];

const Cards = observer(({ is_mobile, has_dashboard_strategies }: TCardProps) => {
    const { dashboard, load_modal, quick_strategy } = useStore();
    const { toggleLoadModal, setActiveTabIndex } = load_modal;
    const { isDesktop } = useDevice();
    const { onCloseDialog, dialog_options, is_dialog_open, setActiveTab, setPreviewOnPopup } = dashboard;
    const { setFormVisibility } = quick_strategy;

    const [hoveredCard, setHoveredCard] = React.useState<string | null>(null);
    const [currentQuoteIndex, setCurrentQuoteIndex] = React.useState(0);
    const [displayedText, setDisplayedText] = React.useState('');
    const [isDeleting, setIsDeleting] = React.useState(false);
    const [charIndex, setCharIndex] = React.useState(0);

    const openFileLoader = () => {
        toggleLoadModal();
        setActiveTabIndex(is_mobile ? 0 : 1);
        setActiveTab(DBOT_TABS.BOT_BUILDER);
    };

    const openGoogleDriveDialog = () => {
        const google_drive_tab_index = isDesktop ? 2 : 1;
        toggleLoadModal();
        setActiveTabIndex(google_drive_tab_index);
        setActiveTab(DBOT_TABS.BOT_BUILDER);
    };

    const actions: TCardArray[] = [
        {
            id: 'my-computer',
            label: is_mobile ? localize('Local') : localize('My computer'),
            description: is_mobile ? localize('Open local file') : localize('Import from computer'),
            color: COLORS['my-computer'],
            callback: () => {
                openFileLoader();
            },
        },
        {
            id: 'google-drive',
            label: localize('Google Drive'),
            description: localize('Import from cloud'),
            color: COLORS['google-drive'],
            callback: () => {
                openGoogleDriveDialog();
            },
        },
        {
            id: 'bot-builder',
            label: localize('Bot Builder'),
            description: localize('Create from scratch'),
            color: COLORS['bot-builder'],
            callback: () => {
                setActiveTab(DBOT_TABS.BOT_BUILDER);
            },
        },
        {
            id: 'quick-strategy',
            label: localize('Quick strategy'),
            description: localize('Start with template'),
            color: COLORS['quick-strategy'],
            callback: () => {
                setActiveTab(DBOT_TABS.BOT_BUILDER);
                setFormVisibility(true);
            },
        },
    ];

    // Typing animation effect
    React.useEffect(() => {
        const currentQuote = MOTIVATIONAL_QUOTES[currentQuoteIndex];
        
        if (!isDeleting && charIndex < currentQuote.length) {
            // Typing
            const timeout = setTimeout(() => {
                setDisplayedText(prev => prev + currentQuote[charIndex]);
                setCharIndex(prev => prev + 1);
            }, 80); // Speed of typing
            
            return () => clearTimeout(timeout);
        } else if (isDeleting && charIndex > 0) {
            // Deleting
            const timeout = setTimeout(() => {
                setDisplayedText(prev => prev.slice(0, -1));
                setCharIndex(prev => prev - 1);
            }, 40); // Speed of deleting
            
            return () => clearTimeout(timeout);
        } else if (!isDeleting && charIndex === currentQuote.length) {
            // Pause after typing complete
            const timeout = setTimeout(() => {
                setIsDeleting(true);
            }, 3000); // Display full text for 3 seconds
            
            return () => clearTimeout(timeout);
        } else if (isDeleting && charIndex === 0) {
            // Move to next quote after deletion
            setIsDeleting(false);
            setCurrentQuoteIndex((prev) => (prev + 1) % MOTIVATIONAL_QUOTES.length);
        }
    }, [charIndex, isDeleting, currentQuoteIndex]);

    return React.useMemo(
        () => (
            <div
                className={classNames('tab__dashboard__table', {
                    'tab__dashboard__table--minimized': has_dashboard_strategies && is_mobile,
                })}
            >
                {/* Motivational Quote Display */}
                <div className="motivational-quote-container">
                    <div className="motivational-quote-wrapper">
                        <span className="greeting-text">👋 HELLO TRADERS!</span>
                        <span className="quote-text">
                            {displayedText}
                            <span className="cursor-blink">|</span>
                        </span>
                    </div>
                </div>

                <div
                    className={classNames('tab__dashboard__table__tiles', {
                        'tab__dashboard__table__tiles--minimized': has_dashboard_strategies && is_mobile,
                    })}
                    id='tab__dashboard__table__tiles'
                >
                    {actions.map(action => {
                        const { description, callback, id, label, color } = action;
                        const isHovered = hoveredCard === id;
                        
                        return (
                            <div
                                key={id}
                                className={classNames('tab__dashboard__table__block', {
                                    'tab__dashboard__table__block--minimized': has_dashboard_strategies && is_mobile,
                                })}
                                onMouseEnter={() => setHoveredCard(id)}
                                onMouseLeave={() => setHoveredCard(null)}
                                style={{
                                    background: isHovered ? color.hover : color.background,
                                    transition: 'all 0.3s ease',
                                    transform: isHovered ? 'translateY(-4px)' : 'translateY(0)',
                                    boxShadow: isHovered ? '0 8px 25px rgba(0,0,0,0.2)' : '0 4px 15px rgba(0,0,0,0.1)',
                                    borderRadius: '12px',
                                    padding: '20px',
                                    cursor: 'pointer',
                                    height: is_mobile ? '120px' : '150px',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    justifyContent: 'center',
                                    alignItems: 'center',
                                    textAlign: 'center',
                                }}
                            >
                                <div
                                    id={id}
                                    onClick={() => callback()}
                                    style={{
                                        display: 'flex',
                                        flexDirection: 'column',
                                        justifyContent: 'center',
                                        alignItems: 'center',
                                        gap: '8px',
                                        width: '100%',
                                        height: '100%',
                                    }}
                                >
                                    <Text
                                        color={color.text === '#ffffff' ? 'white' : 'prominent'}
                                        size={is_mobile ? 'sm' : 'md'}
                                        weight='bold'
                                        style={{
                                            color: color.text,
                                            fontSize: is_mobile ? '14px' : '18px',
                                            letterSpacing: '0.5px',
                                        }}
                                    >
                                        {label}
                                    </Text>
                                    <Text
                                        color={color.text === '#ffffff' ? 'white' : 'prominent'}
                                        size={is_mobile ? 'xxs' : 'xs'}
                                        style={{
                                            color: color.text,
                                            opacity: 0.85,
                                            fontSize: is_mobile ? '10px' : '12px',
                                        }}
                                    >
                                        {description}
                                    </Text>
                                </div>
                            </div>
                        );
                    })}

                    {!isDesktop ? (
                        <Dialog
                            title={dialog_options.title}
                            is_visible={is_dialog_open}
                            onCancel={onCloseDialog}
                            is_mobile_full_width
                            className='dc-dialog__wrapper--google-drive'
                            has_close_icon
                        >
                            <GoogleDrive />
                        </Dialog>
                    ) : (
                        <MobileFullPageModal
                            is_modal_open={is_dialog_open}
                            className='load-strategy__wrapper'
                            header={localize('Load strategy')}
                            onClickClose={() => {
                                setPreviewOnPopup(false);
                                onCloseDialog();
                            }}
                            height_offset='80px'
                        >
                            <div label='Google Drive' className='google-drive-label'>
                                <GoogleDrive />
                            </div>
                        </MobileFullPageModal>
                    )}
                </div>
                <DashboardBotList />
            </div>
        ),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [is_dialog_open, has_dashboard_strategies, hoveredCard, displayedText]
    );
});

export default Cards;
