import { isDemoAccount } from './account-helpers';

export const API_TOKEN_AUTH_METHOD_KEY = 'auth_method';
export const API_TOKEN_AUTH_METHOD = 'api_token';
export const API_TOKEN_SCOPES_KEY = 'api_token_scopes';
export const API_TOKEN_PENDING_KEY = 'pending_api_token';
export const API_TOKEN_ACCOUNT_DETAILS_KEY = 'api_token_account_details';
export const API_TOKEN_LOGIN_ERROR_KEY = 'api_token_login_error';

export type ApiTokenScope = 'read' | 'trade' | 'payments' | 'admin' | 'trading_information' | string;

export type ApiTokenAccountDetails = {
    account_id: string;
    balance: number;
    currency: string;
    account_type: 'demo' | 'real';
    status: string;
};

export const normalizeApiTokenInput = (input: string): string => {
    const trimmed = input.trim();
    if (!trimmed) return '';

    try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const value = parsed.token || parsed.api_token || parsed.access_token || parsed.authToken;
        return typeof value === 'string' ? normalizeApiTokenInput(value) : trimmed;
    } catch {
        return trimmed.replace(/^Bearer\s+/i, '').trim();
    }
};

export const normalizeScopes = (scopes: unknown): ApiTokenScope[] => {
    if (Array.isArray(scopes)) return scopes.map(scope => String(scope).trim()).filter(Boolean);
    if (typeof scopes === 'string')
        return scopes
            .split(/\s+/)
            .map(scope => scope.trim())
            .filter(Boolean);
    return [];
};

export const startApiTokenSession = (token: string) => {
    localStorage.setItem(API_TOKEN_AUTH_METHOD_KEY, API_TOKEN_AUTH_METHOD);
    localStorage.setItem(API_TOKEN_PENDING_KEY, token);
    localStorage.setItem('authToken', token);
    localStorage.removeItem('active_loginid');
    localStorage.removeItem('accountsList');
    localStorage.removeItem('clientAccounts');
    localStorage.removeItem('account_type');
    localStorage.removeItem(API_TOKEN_SCOPES_KEY);
    localStorage.removeItem(API_TOKEN_ACCOUNT_DETAILS_KEY);
    localStorage.removeItem(API_TOKEN_LOGIN_ERROR_KEY);
};

export const completeApiTokenSession = ({
    loginid,
    token,
    currency,
    scopes,
}: {
    loginid: string;
    token: string;
    currency?: string;
    scopes: ApiTokenScope[];
}) => {
    const accountsList = { [loginid]: token };
    const clientAccounts = {
        [loginid]: {
            loginid,
            token,
            currency: currency || 'USD',
        },
    };

    localStorage.setItem(API_TOKEN_AUTH_METHOD_KEY, API_TOKEN_AUTH_METHOD);
    localStorage.setItem('active_loginid', loginid);
    localStorage.setItem('authToken', token);
    localStorage.setItem('accountsList', JSON.stringify(accountsList));
    localStorage.setItem('clientAccounts', JSON.stringify(clientAccounts));
    localStorage.setItem('account_type', isDemoAccount(loginid) ? 'demo' : 'real');
    localStorage.setItem(API_TOKEN_SCOPES_KEY, JSON.stringify(scopes));
    localStorage.removeItem(API_TOKEN_PENDING_KEY);
    localStorage.removeItem(API_TOKEN_LOGIN_ERROR_KEY);
};

export const clearApiTokenSession = () => {
    localStorage.removeItem(API_TOKEN_AUTH_METHOD_KEY);
    localStorage.removeItem(API_TOKEN_PENDING_KEY);
    localStorage.removeItem(API_TOKEN_SCOPES_KEY);
    localStorage.removeItem(API_TOKEN_ACCOUNT_DETAILS_KEY);
    localStorage.removeItem(API_TOKEN_LOGIN_ERROR_KEY);
};

export const isApiTokenSession = () => localStorage.getItem(API_TOKEN_AUTH_METHOD_KEY) === API_TOKEN_AUTH_METHOD;

export const getPendingApiToken = () => localStorage.getItem(API_TOKEN_PENDING_KEY) || '';

export const getApiTokenScopes = (): ApiTokenScope[] => {
    try {
        return normalizeScopes(JSON.parse(localStorage.getItem(API_TOKEN_SCOPES_KEY) || '[]'));
    } catch {
        return [];
    }
};

export const hasApiTokenScope = (scope: ApiTokenScope) => {
    if (!isApiTokenSession()) return true;
    return getApiTokenScopes().includes(scope);
};

export const canAccessApiTokenBalance = () => hasApiTokenScope('read');

export const canTradeWithApiToken = () => hasApiTokenScope('trade');

export const getApiTokenPermissionError = (scope: ApiTokenScope) =>
    `The provided API token does not include the required "${scope}" scope.`;

export const assertApiTokenScope = (scope: ApiTokenScope) => {
    if (!hasApiTokenScope(scope)) {
        throw new Error(getApiTokenPermissionError(scope));
    }
};

export const buildApiTokenAccountDetails = ({
    loginid,
    balance,
    currency,
    status,
}: {
    loginid: string;
    balance: number;
    currency: string;
    status?: string;
}): ApiTokenAccountDetails => ({
    account_id: loginid,
    balance,
    currency,
    account_type: isDemoAccount(loginid) ? 'demo' : 'real',
    status: status || 'active',
});

export const storeApiTokenAccountDetails = (details: ApiTokenAccountDetails) => {
    localStorage.setItem(API_TOKEN_ACCOUNT_DETAILS_KEY, JSON.stringify(details));
};

export const getApiTokenAccountDetails = (): ApiTokenAccountDetails | null => {
    try {
        const details = localStorage.getItem(API_TOKEN_ACCOUNT_DETAILS_KEY);
        return details ? (JSON.parse(details) as ApiTokenAccountDetails) : null;
    } catch {
        return null;
    }
};

export const setApiTokenLoginError = (message: string) => {
    localStorage.setItem(API_TOKEN_LOGIN_ERROR_KEY, message);
};

export const getApiTokenLoginError = () => localStorage.getItem(API_TOKEN_LOGIN_ERROR_KEY) || '';
