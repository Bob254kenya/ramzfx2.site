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
    theme = 'ramzfx'
}: Partial<TLoadingProps>) => {
    const theme_class = theme ? `barspinner-${theme}` : 'barspinner-ramzfx';
    
    return (
        <div
            data-testid='dt_initial_loader'
            className={classNames(
                'initial-loader',
                {
                    'initial-loader--fullscreen': is_fullscreen,
                },
                className
            )}
        >
            <div className='ramzfx-loading-container'>
                <div className="ramzfx-logo">
                    <svg width="60" height="60" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M50 10 L90 30 L90 70 L50 90 L10 70 L10 30 Z" stroke="url(#gradient)" strokeWidth="2.5" fill="none"/>
                        <circle cx="50" cy="50" r="15" stroke="url(#gradient)" strokeWidth="2.5" fill="none"/>
                        <text x="50" y="55" textAnchor="middle" fill="url(#gradient)" fontSize="14" fontWeight="bold">FX</text>
                        <defs>
                            <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                                <stop offset="0%" stopColor="#ff6b6b" />
                                <stop offset="50%" stopColor="#4ecdc4" />
                                <stop offset="100%" stopColor="#45b7d1" />
                            </linearGradient>
                        </defs>
                    </svg>
                </div>
                
                <div id={id} className={classNames('initial-loader__barspinner', 'barspinner', theme_class)}>
                    {Array.from(new Array(5)).map((x, inx) => (
                        <div
                            key={inx}
                            className={`initial-loader__barspinner--rect barspinner__rect barspinner__rect--${
                                inx + 1
                            } rect${inx + 1}`}
                        />
                    ))}
                </div>
                
                <div className="ramzfx-brand">
                    <span className="ramzfx-brand-text">RAMZ</span>
                    <span className="ramzfx-brand-highlight">FX</span>
                </div>
                
                {is_slow_loading && status && status.length > 0 && (
                    <div className="ramzfx-status">
                        {status?.map((text, inx) => (
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
