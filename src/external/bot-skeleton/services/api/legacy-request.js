export const isLegacyOAuthSession = () => {
    try {
        const activeLoginId = localStorage.getItem('active_loginid');
        const accountsListRaw = localStorage.getItem('accountsList');

        if (!activeLoginId || !accountsListRaw) return false;

        const accountsList = JSON.parse(accountsListRaw);
        return !!accountsList?.[activeLoginId];
    } catch (error) {
        console.error('[LegacyRequest] Failed to detect legacy OAuth session:', error);
        return false;
    }
};

export const getSymbolRequestField = symbol => (isLegacyOAuthSession() ? { symbol } : { underlying_symbol: symbol });

export const removeUndefinedFields = value => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(removeUndefinedFields);

    return Object.entries(value).reduce((cleaned, [key, fieldValue]) => {
        if (fieldValue !== undefined) cleaned[key] = removeUndefinedFields(fieldValue);
        return cleaned;
    }, {});
};
