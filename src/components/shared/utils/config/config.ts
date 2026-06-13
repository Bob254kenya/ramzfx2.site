import { DerivWSAccountsService } from '@/services/derivws-accounts.service';
import { OAuthTokenExchangeService } from '@/services/oauth-token-exchange.service';
import { getPendingApiToken } from '@/utils/api-token-permissions';
import brandConfig from '../../../../../brand.config.json';

// =============================================================================
// Domain Configuration Map
// Maps each hostname to its specific Deriv APP_ID, OAuth CLIENT_ID, and the
// exact redirect URI registered in that OAuth app. Add a new entry here to
// support an additional domain — no other code changes required.
// =============================================================================

interface DomainConfig {
    clientId: string; // OAuth 2.0 CLIENT_ID (new OAuth app)
    appId: string; // Legacy Deriv APP_ID for intelligent platform routing
    redirectUri: string; // MUST match the redirect URL registered in the OAuth app exactly
    botsFolder: string; // Public folder used by Best Bots XML loading for this domain
    canonicalHost: string; // Preferred host used for redirects and auth/session consistency
    includeLegacyAppIdInOAuth: boolean; // Only enable when the legacy app redirects to this domain
    useLegacyOAuthLogin: boolean; // Use old OAuth app_id login when OAuth2 client setup is not valid yet
    features: DomainFeatureFlags;
}

type MartingaleMode = 'no_martingale' | 'fixed_loss_trigger' | 'consecutive_loss_trigger';

type DomainFeatureFlags = {
    botIdeas: boolean;
    printPopups: boolean;
    autoTrades: boolean;
    manualTrading: boolean;
    scanner: boolean;
    chart: boolean;
};

type MartingaleConfig = {
    mode: MartingaleMode;
    consecutiveLossThreshold: number;
};

type DomainUIConfig = {
    brandName: string;
    primaryColor: string;
    secondaryColor: string;
    accentColor: string;
    logoUrl: string;
    faviconUrl: string;
    headerBgColor: string;
    headerTextColor: string;
    sidebarBgColor: string;
    sidebarTextColor: string;
    buttonPrimaryBg: string;
    buttonPrimaryText: string;
    buttonSecondaryBg: string;
    buttonSecondaryText: string;
    cardBgColor: string;
    cardBorderColor: string;
    textPrimary: string;
    textSecondary: string;
    successColor: string;
    errorColor: string;
    warningColor: string;
    fontFamily: string;
    borderRadius: string;
    showHeaderLogo: boolean;
    showHeaderTitle: boolean;
    showFooter: boolean;
    showDisclaimer: boolean;
    customCssVars: Record<string, string>;
    martingale?: MartingaleConfig;
};

interface DomainConfig {
    clientId: string;
    appId: string;
    redirectUri: string;
    botsFolder: string;
    canonicalHost: string;
    includeLegacyAppIdInOAuth: boolean;
    useLegacyOAuthLogin: boolean;
    features: DomainFeatureFlags;
    ui: DomainUIConfig;
}

interface HostedDomainDefinition {
    primaryDomain: string;
    aliases?: string[];
    clientId: string;
    appId: string;
    botsFolder?: string;
    includeLegacyAppIdInOAuth?: boolean;
    useLegacyOAuthLogin?: boolean;
    features?: Partial<DomainFeatureFlags>;
    redirectUri?: string;
    ui?: Partial<DomainUIConfig>;
}

const DEFAULT_BOTS_FOLDER = 'optimumtraders.site';
const DEFAULT_DOMAIN_FEATURES: DomainFeatureFlags = {
    botIdeas: true,
    printPopups: true,
    autoTrades: true,
    manualTrading: true,
    scanner: true,
    chart: true,
};

const DEFAULT_MARTINGALE_CONFIG: MartingaleConfig = {
    mode: 'fixed_loss_trigger',
    consecutiveLossThreshold: 1,
};

const DEFAULT_DOMAIN_UI: DomainUIConfig = {
    brandName: 'Ramzfx Bot',
    primaryColor: '#f97316',
    secondaryColor: '#1a1a2e',
    accentColor: '#2196f3',
    logoUrl: '',
    faviconUrl: '',
    headerBgColor: '#1a1a2e',
    headerTextColor: '#ffffff',
    sidebarBgColor: '#16213e',
    sidebarTextColor: '#e0e0e0',
    buttonPrimaryBg: '#f97316',
    buttonPrimaryText: '#ffffff',
    buttonSecondaryBg: '#2d2d44',
    buttonSecondaryText: '#e0e0e0',
    cardBgColor: '#1e1e32',
    cardBorderColor: '#2d2d44',
    textPrimary: '#ffffff',
    textSecondary: '#a0a0b0',
    successColor: '#4caf50',
    errorColor: '#f44336',
    warningColor: '#ff9800',
    fontFamily: "'Inter', 'Segoe UI', sans-serif",
    borderRadius: '8px',
    showHeaderLogo: true,
    showHeaderTitle: true,
    showFooter: true,
    showDisclaimer: true,
    customCssVars: {},
    martingale: DEFAULT_MARTINGALE_CONFIG,
};

const createHostedDomainEntries = ({
    primaryDomain,
    aliases = [],
    clientId,
    appId,
    botsFolder = primaryDomain,
    includeLegacyAppIdInOAuth = true,
    useLegacyOAuthLogin = false,
    features = {},
    redirectUri = `https://${primaryDomain}/`,
    ui = {},
}: HostedDomainDefinition): Record<string, DomainConfig> => {
    const config: DomainConfig = {
        clientId,
        appId,
        redirectUri,
        botsFolder,
        canonicalHost: primaryDomain,
        includeLegacyAppIdInOAuth,
        useLegacyOAuthLogin,
        features: {
            ...DEFAULT_DOMAIN_FEATURES,
            ...features,
        },
        ui: {
            ...DEFAULT_DOMAIN_UI,
            ...ui,
        },
    };

    return [primaryDomain, ...aliases].reduce<Record<string, DomainConfig>>((accumulator, hostname) => {
        accumulator[hostname] = config;
        return accumulator;
    }, {});
};

export const DOMAIN_CONFIG: Record<string, DomainConfig> = {
    // ── Primary production domain ────────────────────────────────────────────
    // New OAuth app registered redirect: https://ramzfx.site/ (trailing slash)
    ...createHostedDomainEntries({
        primaryDomain: 'ramzfx.site',
        aliases: ['www.ramzfx.site'],
        clientId: '33aa3kMiZIo6H3svJWwvu',
        appId: '133749',
        redirectUri: 'https://ramzfx.site/',
        botsFolder: 'termicafx.site',
        includeLegacyAppIdInOAuth: true,
        features: {
            autoTrades: true,
            manualTrading: true,
        },
        ui: {
            brandName: 'RAMZFX | YOUR ULTIMATE IN AUTOMATION',
        },
    }),
    // ── Additional production domain ─────────────────────────────────────────
    ...createHostedDomainEntries({
        primaryDomain: 'termicafx.site',
        aliases: ['www.termicafx.site'],
        clientId: '33h4ThjleZotVMiKQ1gE7',
        appId: '124217',
        redirectUri: 'https://termicafx.site/',
        botsFolder: 'optimumtraders.site',
        includeLegacyAppIdInOAuth: true,
        features: {
            botIdeas: false,
            printPopups: false,
        },
    }),
    // Dedicated branded domains wired with the same OAuth2 flow as the working domains.
    ...createHostedDomainEntries({
        primaryDomain: 'mrzetuzetu.site',
        aliases: ['www.mrzetuzetu.site', 'mrzertuzetu.site', 'www.mrzertuzetu.site'],
        clientId: '33vlry53HSLhXICBcUURu',
        appId: '80364',
        redirectUri: 'https://mrzetuzetu.site/',
        botsFolder: 'optimumtraders.site',
        includeLegacyAppIdInOAuth: true,
        features: {
            autoTrades: true,
            manualTrading: true,
        },
        ui: {
            brandName: 'Mrzetuzetu',
        },
    }),
    ...createHostedDomainEntries({
        primaryDomain: 'masterhunter.site',
        aliases: ['www.masterhunter.site'],
        clientId: '33g5WCS5YOFHD3aWLZZjj',
        appId: '96223',
        redirectUri: 'https://masterhunter.site/',
        botsFolder: 'masterhunter.site',
        includeLegacyAppIdInOAuth: true,
        features: {
            autoTrades: true,
            manualTrading: true,
        },
        ui: {
            brandName: 'Master Hunter',
        },
    }),
    ...createHostedDomainEntries({
        primaryDomain: 'tradinghubs.site',
        aliases: ['www.tradinghubs.site'],
        clientId: '33hi7ev9NiDjWY640JuSw',
        appId: '122208',
        redirectUri: 'https://tradinghubs.site/',
        botsFolder: 'tradinghubs.site',
        includeLegacyAppIdInOAuth: true,
        features: {
            autoTrades: true,
            manualTrading: true,
        },
        ui: {
            brandName: 'Trading Hubs',
        },
    }),
    ...createHostedDomainEntries({
        primaryDomain: 'mafiahub.site',
        aliases: ['www.mafiahub.site'],
        clientId: '331bCUS8izRudblAnSACt',
        appId: '120589',
        redirectUri: 'https://mafiahub.site/',
        botsFolder: 'mafiahub.site',
        includeLegacyAppIdInOAuth: true,
        features: {
            autoTrades: true,
            manualTrading: true,
        },
        ui: {
            brandName: 'Mafia Hub',
        },
    }),
    ...createHostedDomainEntries({
        primaryDomain: 'dollarsigns.site',
        aliases: ['www.dollarsigns.site'],
        clientId: '33uLmMotAXYx94pf0CLe6',
        appId: '',
        redirectUri: 'http://dollarsigns.site/',
        botsFolder: 'dollarsigns.site',
        includeLegacyAppIdInOAuth: false,
        features: {
            autoTrades: true,
            manualTrading: true,
        },
        ui: {
            brandName: 'Dollarsign',
        },
    }),
};

export const getDomainConfigForHost = (hostname: string): DomainConfig | undefined => DOMAIN_CONFIG[hostname];
export const getCanonicalHostForHost = (hostname: string): string | undefined => DOMAIN_CONFIG[hostname]?.canonicalHost;

/**
 * Returns the DomainConfig for the current hostname.
 * Falls back to env vars (for local / Replit dev) when the hostname is not
 * listed in DOMAIN_CONFIG.
 */
export const getDomainConfig = (): DomainConfig => {
    const hostname = window.location.hostname;
    const domain_config = getDomainConfigForHost(hostname);
    if (domain_config) {
        return domain_config;
    }
    // Fallback — used on localhost and Replit dev domains
    return {
        clientId: process.env.CLIENT_ID || '',
        appId: process.env.APP_ID || '71937',
        redirectUri: process.env.REDIRECT_URI || window.location.origin,
        botsFolder: process.env.BOTS_FOLDER || DEFAULT_BOTS_FOLDER,
        canonicalHost: hostname,
        includeLegacyAppIdInOAuth: true,
        useLegacyOAuthLogin: false,
        features: DEFAULT_DOMAIN_FEATURES,
        ui: DEFAULT_DOMAIN_UI,
    };
};

/**
 * Returns the registered production hostname for the current domain.
 * Used when we need to know which domain is active in production.
 */
export const getCurrentProductionDomain = () =>
    Object.keys(DOMAIN_CONFIG).find(domain => window.location.hostname === domain);

export const getBestBotsFolder = () => getDomainConfig().botsFolder;

export const getDomainFeatures = () => getDomainConfig().features;

export const isDomainFeatureEnabled = (feature: keyof DomainFeatureFlags) => getDomainFeatures()[feature];

export const getDomainUIConfig = (): DomainUIConfig => getDomainConfig().ui;

export const getMartingaleConfig = (): MartingaleConfig => {
    const ui = getDomainUIConfig();
    return ui.martingale ?? DEFAULT_MARTINGALE_CONFIG;
};

export const getMartingaleMode = (): MartingaleMode => getMartingaleConfig().mode;

export const getConsecutiveLossThreshold = (): number => getMartingaleConfig().consecutiveLossThreshold;

export const isMartingaleEnabled = (): boolean => {
    const mode = getMartingaleMode();
    return mode !== 'no_martingale';
};

export const applyDomainUI = (): void => {
    const ui = getDomainUIConfig();
    const root = document.documentElement;
    root.style.setProperty('--domain-primary', ui.primaryColor);
    root.style.setProperty('--domain-secondary', ui.secondaryColor);
    root.style.setProperty('--domain-accent', ui.accentColor);
    root.style.setProperty('--domain-header-bg', ui.headerBgColor);
    root.style.setProperty('--domain-header-text', ui.headerTextColor);
    root.style.setProperty('--domain-sidebar-bg', ui.sidebarBgColor);
    root.style.setProperty('--domain-sidebar-text', ui.sidebarTextColor);
    root.style.setProperty('--domain-btn-primary-bg', ui.buttonPrimaryBg);
    root.style.setProperty('--domain-btn-primary-text', ui.buttonPrimaryText);
    root.style.setProperty('--domain-btn-secondary-bg', ui.buttonSecondaryBg);
    root.style.setProperty('--domain-btn-secondary-text', ui.buttonSecondaryText);
    root.style.setProperty('--domain-card-bg', ui.cardBgColor);
    root.style.setProperty('--domain-card-border', ui.cardBorderColor);
    root.style.setProperty('--domain-text-primary', ui.textPrimary);
    root.style.setProperty('--domain-text-secondary', ui.textSecondary);
    root.style.setProperty('--domain-success', ui.successColor);
    root.style.setProperty('--domain-error', ui.errorColor);
    root.style.setProperty('--domain-warning', ui.warningColor);
    root.style.setProperty('--domain-font-family', ui.fontFamily);
    root.style.setProperty('--domain-border-radius', ui.borderRadius);
    Object.entries(ui.customCssVars).forEach(([key, value]) => {
        root.style.setProperty(key, value);
    });
    if (ui.brandName) {
        document.title = ui.brandName;
    }
};

export const buildBestBotsFileUrl = (bots_folder: string, file_name: string) => {
    const folder = encodeURI(bots_folder);
    return `/${folder}/${encodeURIComponent(file_name)}`;
};

export const getBestBotsFileUrl = (file_name: string) => buildBestBotsFileUrl(getBestBotsFolder(), file_name);

// =============================================================================
// Constants - Server Configuration (from brand.config.json)
// =============================================================================

// WebSocket server URLs
export const WS_SERVERS = {
    STAGING: `${brandConfig.platform.derivws.url.staging}options/ws/public`,
    PRODUCTION: `${brandConfig.platform.derivws.url.production}options/ws/public`,
} as const;

// Classic Deriv WebSocket API used by legacy OAuth tokens.
// DerivAPIBasic expects this `/websockets/v3` protocol for calls such as
// `authorize`, `balance`, `proposal`, `buy`, etc. Legacy `a1-...` tokens do
// not authorize correctly against the newer DerivWS `/trading/v1/...` URLs.
const LEGACY_WS_SERVER = 'wss://ws.derivws.com/websockets/v3';

// Legacy — kept for backward-compat with imports elsewhere
export const PRODUCTION_DOMAINS = {
    COM: brandConfig.platform.hostname.production.com,
} as const;

export const STAGING_DOMAINS = {
    COM: brandConfig.platform.hostname.staging.com,
} as const;

// =============================================================================
// Helper Functions
// =============================================================================

// Helper to check if we're on production domains
export const isProduction = () => {
    if (process.env.APP_ENV === 'production') return true;
    const hostname = window.location.hostname;
    return !!DOMAIN_CONFIG[hostname];
};

export const isLocal = () => /localhost(:\d+)?$/i.test(window.location.hostname);

const getDefaultServerURL = () => {
    const isProductionEnv = isProduction();

    try {
        return isProductionEnv ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
    } catch (error) {
        console.error('Error in getDefaultServerURL:', error);
    }

    // Production defaults to demov2, staging/preview defaults to qa194 (demo)
    return isProductionEnv ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
};

const getLegacyServerURL = () => {
    const { appId } = getDomainConfig();
    return `${LEGACY_WS_SERVER}?app_id=${encodeURIComponent(appId)}`;
};

/**
 * Gets the WebSocket URL using the appropriate authentication flow
 * This function handles both:
 *
 * PKCE OAuth2 Flow (New users):
 * 1. Get access token from auth_info (sessionStorage)
 * 2. Fetch accounts list from derivatives/accounts
 * 3. Store accounts in sessionStorage
 * 4. Get default account (first from list)
 * 5. Fetch OTP and WebSocket URL for that account
 *
 * Legacy OAuth Flow (Legacy users):
 * 1. Check if user has legacy token in localStorage (from ?acct1=...&token1=...)
 * 2. If found, return classic Deriv WebSocket URL with app_id
 * 3. api_base.ts will authorize using api.authorize(token) with the legacy token
 *
 * @returns Promise with WebSocket URL or fallback to default server
 */
export const getSocketURL = async (): Promise<string> => {
    try {
        // Check PKCE OAuth first (new platform users)
        const authInfo = OAuthTokenExchangeService.getAuthInfo();
        if (authInfo?.access_token) {
            console.log('[getSocketURL] PKCE user detected - fetching authenticated WebSocket URL');
            // Use the DerivWSAccountsService to get authenticated WebSocket URL
            const wsUrl = await DerivWSAccountsService.getAuthenticatedWebSocketURL(authInfo.access_token);
            return wsUrl;
        }

        // Check for legacy token in localStorage (legacy platform users)
        // Legacy tokens are stored by storeLegacyAccounts() from OAuth redirect params
        const accountsList_raw = localStorage.getItem('accountsList');
        const pendingApiToken = getPendingApiToken();
        if (pendingApiToken) {
            const legacyWsUrl = getLegacyServerURL();
            console.log('[getSocketURL] API token login detected - using classic WebSocket URL');
            return legacyWsUrl;
        }

        if (accountsList_raw) {
            try {
                const accountsList = JSON.parse(accountsList_raw);
                const active_loginid = localStorage.getItem('active_loginid');
                if (active_loginid && accountsList[active_loginid]) {
                    const legacyWsUrl = getLegacyServerURL();
                    console.log('[getSocketURL] Legacy user detected with token - using classic WebSocket URL');
                    // For legacy users, DerivAPIBasic must connect to classic `/websockets/v3`.
                    // The newer DerivWS `/trading/v1/options/ws/public` endpoint can open, but
                    // legacy `api.authorize(token)` will not complete there.
                    return legacyWsUrl;
                }
            } catch (e) {
                console.error('[getSocketURL] Error parsing legacy accountsList:', e);
            }
        }

        // No authentication found
        console.log('[getSocketURL] No authentication found - returning default server URL');
        return getDefaultServerURL();
    } catch (error) {
        console.error('[DerivWS] Error in getSocketURL:', error);
        return getDefaultServerURL();
    }
};

export const getDebugServiceWorker = () => {
    const debug_service_worker_flag = window.localStorage.getItem('debug_service_worker');
    if (debug_service_worker_flag) return !!parseInt(debug_service_worker_flag);

    return false;
};

/**
 * Generates a cryptographically secure CSRF token
 * @returns A random base64url-encoded string
 */
const generateCSRFToken = (): string => {
    // Generate 32 random bytes (256 bits) for strong security
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);

    // Convert to base64url encoding (URL-safe)
    const base64 = btoa(String.fromCharCode(...array));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
};

/**
 * Generates a PKCE code verifier (random string)
 * @returns A cryptographically random base64url-encoded string (43-128 characters)
 */
const generateCodeVerifier = (): string => {
    // Generate 32 random bytes (will result in 43 characters after base64url encoding)
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);

    // Convert to base64url encoding (URL-safe, no padding)
    const base64 = btoa(String.fromCharCode(...array));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
};

/**
 * Generates a PKCE code challenge from a code verifier using SHA-256
 * @param verifier The code verifier string
 * @returns Promise that resolves to the base64url-encoded SHA-256 hash
 */
const generateCodeChallenge = async (verifier: string): Promise<string> => {
    // Encode the verifier as UTF-8
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);

    // Hash with SHA-256
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);

    // Convert to base64url encoding
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const base64 = btoa(String.fromCharCode(...hashArray));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
};

/**
 * Stores PKCE code verifier in sessionStorage for token exchange
 * @param verifier The code verifier to store
 */
const storeCodeVerifier = (verifier: string): void => {
    sessionStorage.setItem('oauth_code_verifier', verifier);
    // Also store timestamp for verifier expiration (e.g., 10 minutes)
    sessionStorage.setItem('oauth_code_verifier_timestamp', Date.now().toString());
};

/**
 * Retrieves and validates the stored PKCE code verifier
 * @returns The code verifier if valid and not expired, null otherwise
 */
export const getCodeVerifier = (): string | null => {
    const verifier = sessionStorage.getItem('oauth_code_verifier');
    const timestamp = sessionStorage.getItem('oauth_code_verifier_timestamp');

    if (!verifier || !timestamp) {
        return null;
    }

    // Check if verifier is expired (10 minutes = 600000ms)
    const verifierAge = Date.now() - parseInt(timestamp, 10);
    if (verifierAge > 600000) {
        // Clean up expired verifier
        sessionStorage.removeItem('oauth_code_verifier');
        sessionStorage.removeItem('oauth_code_verifier_timestamp');
        return null;
    }

    return verifier;
};

/**
 * Clears PKCE code verifier from sessionStorage after successful token exchange
 */
export const clearCodeVerifier = (): void => {
    sessionStorage.removeItem('oauth_code_verifier');
    sessionStorage.removeItem('oauth_code_verifier_timestamp');
};

/**
 * Stores CSRF token in sessionStorage for validation after OAuth callback
 * @param token The CSRF token to store
 */
const storeCSRFToken = (token: string): void => {
    sessionStorage.setItem('oauth_csrf_token', token);
    // Also store timestamp for token expiration (e.g., 10 minutes)
    sessionStorage.setItem('oauth_csrf_token_timestamp', Date.now().toString());
};

/**
 * Validates CSRF token from OAuth callback
 * @param token The token to validate
 * @returns true if token is valid and not expired
 */
export const validateCSRFToken = (token: string): boolean => {
    const storedToken = sessionStorage.getItem('oauth_csrf_token');
    const timestamp = sessionStorage.getItem('oauth_csrf_token_timestamp');

    if (!storedToken || !timestamp) {
        return false;
    }

    // Check if token matches
    if (storedToken !== token) {
        return false;
    }

    // Check if token is expired (10 minutes = 600000ms)
    const tokenAge = Date.now() - parseInt(timestamp, 10);
    if (tokenAge > 600000) {
        // Clean up expired token
        sessionStorage.removeItem('oauth_csrf_token');
        sessionStorage.removeItem('oauth_csrf_token_timestamp');
        return false;
    }

    return true;
};

/**
 * Clears CSRF token from sessionStorage after successful validation
 */
export const clearCSRFToken = (): void => {
    sessionStorage.removeItem('oauth_csrf_token');
    sessionStorage.removeItem('oauth_csrf_token_timestamp');
};

export const generateOAuthURL = async (prompt?: string, domainConfig = getDomainConfig()) => {
    try {
        // Resolve config for the current domain (auto-selects the right
        // CLIENT_ID, APP_ID, and redirect URI from DOMAIN_CONFIG)
        const domainCfg = domainConfig;
        const { clientId, appId, redirectUri, includeLegacyAppIdInOAuth } = {
            clientId: domainCfg.clientId,
            appId: domainCfg.appId,
            redirectUri: domainCfg.redirectUri,
            includeLegacyAppIdInOAuth: domainCfg.includeLegacyAppIdInOAuth,
        };

        if (domainCfg.useLegacyOAuthLogin && appId) {
            const params = new URLSearchParams({ app_id: appId });
            if (prompt) {
                params.set('prompt', prompt);
            }
            return `https://oauth.deriv.com/oauth2/authorize?${params.toString()}`;
        }

        // Use brand config for the OAuth2 base URL
        const environment = isProduction() ? 'production' : 'staging';
        const hostname = brandConfig?.platform.auth2_url?.[environment];

        if (hostname && clientId) {
            // Generate CSRF token for security
            const csrfToken = generateCSRFToken();
            storeCSRFToken(csrfToken);

            // Generate PKCE parameters
            const codeVerifier = generateCodeVerifier();
            const codeChallenge = await generateCodeChallenge(codeVerifier);
            storeCodeVerifier(codeVerifier);

            // redirectUri is sourced from DOMAIN_CONFIG and must match the URL
            // registered in the Deriv OAuth app for clientId exactly.
            const params = new URLSearchParams({
                scope: 'trade account_manage',
                response_type: 'code',
                client_id: clientId,
                redirect_uri: redirectUri,
                state: csrfToken,
                code_challenge: codeChallenge,
                code_challenge_method: 'S256',
            });

            // Optional: prompt parameter (e.g. 'registration' for signup flow)
            if (prompt) {
                params.set('prompt', prompt);
            }

            // Include legacy app_id for intelligent platform routing
            // According to Deriv OAuth 2.0 docs: "Deriv will check whether the user belongs
            // to the old or new platform and route them to the appropriate version of your app."
            // This allows the app to support both:
            // - New users who use PKCE OAuth (returns access_token)
            // - Legacy users who have old accounts (returns via legacy OAuth params)
            // Both token types are then handled appropriately by the app
            if (includeLegacyAppIdInOAuth && appId) {
                params.set('app_id', appId);
            }

            return `${hostname}auth?${params.toString()}`;
        }
    } catch (error) {
        console.error('Error generating OAuth URL:', error);
    }

    return ``;
};
