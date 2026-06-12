import React from 'react';
import classNames from 'classnames';
import Text from '../text/text';
import './loading.scss'; // Import the SCSS file

export type TLoadingProps = React.HTMLProps<HTMLDivElement> & {
    is_fullscreen: boolean;
    is_slow_loading: boolean;
    status: string[];
    theme: string;
    backgroundImage?: string;
    overlayOpacity?: number;
};

const Loading = ({ 
    className, 
    id, 
    is_fullscreen = true, 
    is_slow_loading, 
    status, 
    theme = 'ramzfx',
    backgroundImage = '/images/loading-bg.jpg',
    overlayOpacity = 0.7
}: Partial<TLoadingProps>) => {
    const theme_class = theme ? `barspinner-${theme}` : 'barspinner-ramzfx';
    
    const backgroundStyle = backgroundImage ? {
        backgroundImage: `url(${backgroundImage})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat'
    } : {};

    const overlayStyle = {
        '--overlay-opacity': overlayOpacity
    } as React.CSSProperties;

    return (
        <div
            data-testid='dt_initial_loader'
            style={backgroundStyle}
            className={classNames(
                'initial-loader',
                {
                    'initial-loader--fullscreen': is_fullscreen,
                    'initial-loader--has-background': backgroundImage
                },
                className
            )}
        >
            <div className="initial-loader__overlay" style={overlayStyle}></div>
            <div className='ramzfx-loading-container'>
                <div className="ramzfx-logo">
                    <svg width="50" height="50" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M50 10 L90 30 L90 70 L50 90 L10 70 L10 30 Z" stroke="currentColor" strokeWidth="2" fill="none"/>
                        <circle cx="50" cy="50" r="15" stroke="currentColor" strokeWidth="2" fill="none"/>
                        <text x="50" y="55" textAnchor="middle" fill="currentColor" fontSize="12" fontWeight="bold">FX</text>
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
                {is_slow_loading &&
                    status?.map((text, inx) => (
                        <Text as='h3' color='prominent' size='xs' align='center' key={inx}>
                            {text}
                        </Text>
                    ))}
                <div className="ramzfx-loading-text">RAMZFX</div>
            </div>
        </div>
    );
};

export default Loading;
