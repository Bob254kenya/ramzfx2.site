import React from 'react';
import classNames from 'classnames';
import Text from '../text/text';
import './loading.scss';

export type TLoadingProps = React.HTMLProps<HTMLDivElement> & {
    is_fullscreen: boolean;
    is_slow_loading: boolean;
    status: string[];
    theme: string;
};

const Loading = ({
    className,
    id,
    is_fullscreen = true,
    is_slow_loading,
    status,
    theme = 'ramzfx',
}: Partial<TLoadingProps>) => {
    const theme_class = theme ? `barspinner-${theme}` : 'barspinner-ramzfx';

    return (
        <div
            data-testid='dt_initial_loader'
            className={classNames(
                'initial-loader',
                { 'initial-loader--fullscreen': is_fullscreen },
                className
            )}
        >
            {/* Ambient orbs */}
            <div className='rl-orb rl-orb--1' aria-hidden='true' />
            <div className='rl-orb rl-orb--2' aria-hidden='true' />
            <div className='rl-orb rl-orb--3' aria-hidden='true' />

            <div className='ramzfx-loading-container'>
                {/* Logo */}
                <div className='ramzfx-logo'>
                    <svg width='64' height='64' viewBox='0 0 100 100' fill='none' xmlns='http://www.w3.org/2000/svg'>
                        <defs>
                            <linearGradient id='rl-grad' x1='0%' y1='0%' x2='100%' y2='100%'>
                                <stop offset='0%' stopColor='#60a5fa' />
                                <stop offset='50%' stopColor='#3b82f6' />
                                <stop offset='100%' stopColor='#1d4ed8' />
                            </linearGradient>
                            <filter id='rl-glow'>
                                <feGaussianBlur stdDeviation='3' result='coloredBlur' />
                                <feMerge>
                                    <feMergeNode in='coloredBlur' />
                                    <feMergeNode in='SourceGraphic' />
                                </feMerge>
                            </filter>
                        </defs>
                        <path
                            d='M50 8 L92 32 L92 68 L50 92 L8 68 L8 32 Z'
                            stroke='url(#rl-grad)'
                            strokeWidth='2'
                            fill='rgba(59,130,246,0.08)'
                            filter='url(#rl-glow)'
                        />
                        <circle
                            cx='50' cy='50' r='16'
                            stroke='url(#rl-grad)'
                            strokeWidth='2'
                            fill='rgba(59,130,246,0.12)'
                        />
                        <text
                            x='50' y='55'
                            textAnchor='middle'
                            fill='url(#rl-grad)'
                            fontSize='13'
                            fontWeight='800'
                            fontFamily="'Inter', sans-serif"
                            letterSpacing='1'
                        >
                            FX
                        </text>
                    </svg>
                </div>

                {/* Brand name */}
                <div className='ramzfx-brand'>
                    <span className='ramzfx-brand-text'>RAMZ</span>
                    <span className='ramzfx-brand-highlight'>FX</span>
                </div>

                {/* Bar spinner */}
                <div id={id} className={classNames('initial-loader__barspinner', 'barspinner', theme_class)}>
                    {Array.from(new Array(5)).map((_, inx) => (
                        <div
                            key={inx}
                            className={`initial-loader__barspinner--rect barspinner__rect barspinner__rect--${inx + 1} rect${inx + 1}`}
                        />
                    ))}
                </div>

                {/* Tagline */}
                <p className='ramzfx-tagline'>Connecting to markets…</p>

                {/* Slow-load status messages */}
                {is_slow_loading && status && status.length > 0 && (
                    <div className='ramzfx-status'>
                        {status.map((text, inx) => (
                            <Text as='h3' color='prominent' size='xs' align='center' key={inx}>
                                {text}
                            </Text>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default Loading;
