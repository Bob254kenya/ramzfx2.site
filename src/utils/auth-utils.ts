/**
 * Utility functions for authentication-related operations
 */
import { clearApiTokenSession } from './api-token-permissions';

/**
 * Clears authentication data from local storage and reloads the page
 */
export const clearAuthData = () => {
    clearApiTokenSession();
    localStorage.removeItem('authToken');
    localStorage.removeItem('active_loginid');
    localStorage.removeItem('client.country');
    localStorage.removeItem('account_type'); // Clear account type when clearing auth data
    localStorage.removeItem('accountsList');
    localStorage.removeItem('clientAccounts');
    localStorage.removeItem('callback_token');
};
