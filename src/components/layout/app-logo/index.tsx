// Simplified logo component showing "Powered by Deriv" text
import { localize } from '@deriv-com/translations';
import { useDevice } from '@deriv-com/ui';
import './app-logo.scss';

interface SocialLink {
    icon: string;
    label: string;
    url: string;
}

const socialLinks: SocialLink[] = [
    { icon: '📱', label: 'WhatsApp', url: 'https://wa.me/+254757261120' },
    { icon: '✈️', label: 'Telegram', url: 'https://t.me/+YDUwvuuVDYg5NjE0' },
    { icon: '▶️', label: 'YouTube', url: 'https://www.youtube.com/@ceoramz' },
    { icon: '🎵', label: 'TikTok', url: 'https://tiktok.com/@ceoramz' },
    { icon: '📷', label: 'Instagram', url: 'https://www.instagram.com/ramztrader.site' },
    { icon: '💬', label: 'Discord', url: 'https://www.facebook.com/profile.php?id=61573399294689' },
    { icon: '🐦', label: 'Twitter', url: 'https://www.instagram.com/ramztrader.site' },
];

export const AppLogo = () => {
    const { isDesktop } = useDevice();

    // Only render on desktop screens
    if (!isDesktop) return null;

    return (
        <div className='app-header__logo-wrapper'>
            <div className='logo-container'>
                <a href='/' className='app-header__logo' aria-label={localize('Home')}>
                    <span className='powered-by-text'>
                        <span className='logo-prefix'>Powered by</span>
                        <span className='logo-main'>RAMZ FX</span>
                    </span>
                </a>
            </div>
            
            <div className='social-links'>
                {socialLinks.map((social) => (
                    <a
                        key={social.label}
                        href={social.url}
                        target='_blank'
                        rel='noopener noreferrer'
                        className='social-link'
                        aria-label={social.label}
                        title={social.label}
                    >
                        <span className='social-icon'>{social.icon}</span>
                    </a>
                ))}
            </div>
        </div>
    );
};
