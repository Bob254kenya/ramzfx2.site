import { TextEncoder } from 'util';
import { buildBestBotsFileUrl, generateOAuthURL, getCanonicalHostForHost, getDomainConfigForHost } from '../config';

describe('DOMAIN_CONFIG', () => {
    it('returns the configured TermicaFX auth and bot folder settings', () => {
        expect(getDomainConfigForHost('termicafx.site')).toMatchObject({
            clientId: '33h4ThjleZotVMiKQ1gE7',
            appId: '124217',
            redirectUri: 'https://termicafx.site/',
            botsFolder: 'optimumtraders.site',
            includeLegacyAppIdInOAuth: true,
            useLegacyOAuthLogin: false,
            features: {
                botIdeas: false,
                printPopups: false,
                autoTrades: true,
                manualTrading: true,
            },
        });
    });

    it('keeps Bot Ideas enabled on Risk Managers', () => {
        expect(getDomainConfigForHost('riskmanagers.site')?.features).toMatchObject({
            botIdeas: true,
            printPopups: true,
            autoTrades: true,
            manualTrading: true,
        });
        expect(getDomainConfigForHost('riskmanagers.site')?.ui.brandName).toBe('Risk Managers');
        expect(getDomainConfigForHost('riskmanagers.site')).toMatchObject({
            redirectUri: 'https://riskmanagers.site/',
            includeLegacyAppIdInOAuth: true,
            useLegacyOAuthLogin: false,
        });
    });

    it.each([
        ['mrzetuzetu.site', '33vlry53HSLhXICBcUURu', '80364', 'Mrzetuzetu', false, 'optimumtraders.site'],
        ['masterhunter.site', '33g5WCS5YOFHD3aWLZZjj', '96223', 'Master Hunter', false],
        ['tradinghubs.site', '33hi7ev9NiDjWY640JuSw', '122208', 'Trading Hubs', false],
        ['mafiahub.site', '331bCUS8izRudblAnSACt', '120589', 'Mafia Hub', false],
    ])(
        'returns auth and bot folder settings for %s',
        (domain, clientId, appId, brandName, useLegacyOAuthLogin, botsFolder = domain) => {
        expect(getDomainConfigForHost(domain)).toMatchObject({
            clientId,
            appId,
            redirectUri: `https://${domain}/`,
            botsFolder,
            canonicalHost: domain,
            includeLegacyAppIdInOAuth: true,
            useLegacyOAuthLogin,
            ui: {
                brandName,
            },
            features: {
                autoTrades: true,
                manualTrading: true,
            },
        });
        expect(getDomainConfigForHost(`www.${domain}`)).toMatchObject({
            clientId,
            appId,
            redirectUri: `https://${domain}/`,
            botsFolder,
            canonicalHost: domain,
            includeLegacyAppIdInOAuth: true,
            useLegacyOAuthLogin,
            ui: {
                brandName,
            },
            features: {
                autoTrades: true,
                manualTrading: true,
            },
        });
        }
    );

    it('maps mrzertuzetu aliases back to the canonical mrzetuzetu host', () => {
        expect(getDomainConfigForHost('mrzertuzetu.site')).toMatchObject({
            redirectUri: 'https://mrzetuzetu.site/',
            botsFolder: 'optimumtraders.site',
            canonicalHost: 'mrzetuzetu.site',
        });
        expect(getCanonicalHostForHost('mrzertuzetu.site')).toBe('mrzetuzetu.site');
        expect(getCanonicalHostForHost('www.mrzetuzetu.site')).toBe('mrzetuzetu.site');
        expect(getCanonicalHostForHost('www.mrzertuzetu.site')).toBe('mrzetuzetu.site');
    });

    it('returns OAuth2-only auth and bot folder settings for Dollarsign', () => {
        expect(getDomainConfigForHost('dollarsigns.site')).toMatchObject({
            clientId: '33uLmMotAXYx94pf0CLe6',
            appId: '',
            redirectUri: 'http://dollarsigns.site/',
            botsFolder: 'dollarsigns.site',
            includeLegacyAppIdInOAuth: false,
            useLegacyOAuthLogin: false,
            ui: {
                brandName: 'Dollarsign',
            },
            features: {
                autoTrades: true,
                manualTrading: true,
            },
        });
        expect(getDomainConfigForHost('www.dollarsigns.site')).toMatchObject({
            clientId: '33uLmMotAXYx94pf0CLe6',
            appId: '',
            redirectUri: 'http://dollarsigns.site/',
            botsFolder: 'dollarsigns.site',
            includeLegacyAppIdInOAuth: false,
            useLegacyOAuthLogin: false,
        });
    });

    it('removes old hosted domain entries that should no longer process login directly', () => {
        expect(getDomainConfigForHost('optimumtraders.site')).toBeUndefined();
        expect(getDomainConfigForHost('www.optimumtraders.site')).toBeUndefined();
        expect(getDomainConfigForHost('newwapi.netlify.app')).toBeUndefined();
    });

    it('builds the Best Bots file URL from the configured bot folder', () => {
        expect(buildBestBotsFileUrl('termicafx.site', 'My Bot.xml')).toBe('/termicafx.site/My%20Bot.xml');
    });

    it.each([
        ['mrzetuzetu.site', '80364', '33vlry53HSLhXICBcUURu'],
        ['masterhunter.site', '96223', '33g5WCS5YOFHD3aWLZZjj'],
        ['tradinghubs.site', '122208', '33hi7ev9NiDjWY640JuSw'],
        ['mafiahub.site', '120589', '331bCUS8izRudblAnSACt'],
    ])('uses the working OAuth2 PKCE login wiring for %s', async (host, appId, clientId) => {
        const originalAppEnv = process.env.APP_ENV;
        const cryptoMock = {
            getRandomValues: (array: Uint8Array) => array.fill(1),
            subtle: {
                digest: jest.fn().mockResolvedValue(new Uint8Array(32).fill(2).buffer),
            },
        };
        const domainConfig = getDomainConfigForHost(host);

        Object.defineProperty(globalThis, 'crypto', {
            configurable: true,
            value: cryptoMock,
        });
        Object.defineProperty(globalThis, 'TextEncoder', {
            configurable: true,
            value: TextEncoder,
        });
        process.env.APP_ENV = 'production';
        expect(domainConfig).toBeDefined();

        const oauthUrl = await generateOAuthURL(undefined, domainConfig!);
        const url = new URL(oauthUrl);

        expect(url.origin + url.pathname).toBe('https://auth.deriv.com/oauth2/auth');
        expect(url.searchParams.get('client_id')).toBe(clientId);
        expect(url.searchParams.get('app_id')).toBe(appId);
        expect(url.searchParams.get('redirect_uri')).toBe(`https://${host}/`);
        expect(url.searchParams.get('response_type')).toBe('code');
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');

        process.env.APP_ENV = originalAppEnv;
    });

    it('keeps Risk Managers on OAuth2 with both client_id and legacy app_id routing', async () => {
        const originalAppEnv = process.env.APP_ENV;
        const cryptoMock = {
            getRandomValues: (array: Uint8Array) => array.fill(1),
            subtle: {
                digest: jest.fn().mockResolvedValue(new Uint8Array(32).fill(2).buffer),
            },
        };
        const domainConfig = getDomainConfigForHost('riskmanagers.site');

        Object.defineProperty(globalThis, 'crypto', {
            configurable: true,
            value: cryptoMock,
        });
        Object.defineProperty(globalThis, 'TextEncoder', {
            configurable: true,
            value: TextEncoder,
        });
        process.env.APP_ENV = 'production';
        expect(domainConfig).toBeDefined();

        const oauthUrl = await generateOAuthURL(undefined, domainConfig!);
        const url = new URL(oauthUrl);

        expect(url.origin + url.pathname).toBe('https://auth.deriv.com/oauth2/auth');
        expect(url.searchParams.get('client_id')).toBe('33cCr2bWsByPgLlormNFw');
        expect(url.searchParams.get('app_id')).toBe('71937');
        expect(url.searchParams.get('redirect_uri')).toBe('https://riskmanagers.site/');
        expect(url.searchParams.get('response_type')).toBe('code');
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');

        process.env.APP_ENV = originalAppEnv;
    });

    it('uses OAuth2 PKCE login without legacy app_id routing for Dollarsign', async () => {
        const originalAppEnv = process.env.APP_ENV;
        const cryptoMock = {
            getRandomValues: (array: Uint8Array) => array.fill(1),
            subtle: {
                digest: jest.fn().mockResolvedValue(new Uint8Array(32).fill(2).buffer),
            },
        };
        const domainConfig = getDomainConfigForHost('dollarsigns.site');

        Object.defineProperty(globalThis, 'crypto', {
            configurable: true,
            value: cryptoMock,
        });
        Object.defineProperty(globalThis, 'TextEncoder', {
            configurable: true,
            value: TextEncoder,
        });
        process.env.APP_ENV = 'production';
        expect(domainConfig).toBeDefined();

        const oauthUrl = await generateOAuthURL(undefined, domainConfig!);
        const url = new URL(oauthUrl);

        expect(url.origin + url.pathname).toBe('https://auth.deriv.com/oauth2/auth');
        expect(url.searchParams.get('client_id')).toBe('33uLmMotAXYx94pf0CLe6');
        expect(url.searchParams.get('app_id')).toBeNull();
        expect(url.searchParams.get('redirect_uri')).toBe('http://dollarsigns.site/');
        expect(url.searchParams.get('response_type')).toBe('code');
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');

        process.env.APP_ENV = originalAppEnv;
    });
});
