type TBrandLogoProps = {
    width?: number;
    height?: number;
    fill?: string;
    className?: string;
};

export const BrandLogo = ({ className = '' }: TBrandLogoProps) => {
    return (
        <img
            src='/brand-logo-cropped.png'
            alt='Ramzfx Trading Hub'
            className={className}
            style={{
                display: 'block',
                maxWidth: '100%',
                height: 'auto',
            }}
        />
    );
};
