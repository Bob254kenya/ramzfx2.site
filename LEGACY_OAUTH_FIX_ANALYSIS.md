# Legacy OAuth Authentication Fix Analysis

## Root Cause: Missing Account Metadata & Data Fetching

### The Problem Flow

1. ✅ User approves on Deriv OAuth → `?acct1=CR123&token1=a1-xxx&cur1=USD`
2. ✅ Token stored in localStorage
3. ✅ Page reloads
4. ✅ `api_base.init()` called
5. ✅ `api.authorize(token)` succeeds
6. ✅ `api.balance()` called BUT...
7. ❌ **MISSING ACCOUNT LIST DATA**
8. ❌ No account metadata in UI
9. ❌ User appears unlogged in

### Core Issue

**New API (PKCE) Flow:**

```
Code exchange → Token stored in sessionStorage
                ↓
Fetch account list via DerivWSAccountsService.fetchAccountsList(token)
Store accounts in sessionStorage: { account_id, balance, currency, account_type }
                ↓
api_base.init() finds accounts in sessionStorage
Sets account_list in observable store via setAccountList(accountList)
Balance calculation: accounts fetched from REST API
                ↓
✅ UI shows balance & account info
```

**Legacy API (CURRENT) Flow:**

```
Token in URL → storeLegacyAccounts() stores only token in localStorage
               accountsList = { loginid: token }
                ↓
Page reloads, api_base.init()
authorize(token) succeeds
api.balance() returns balance
                ↓
❌ NO ACCOUNT LIST DATA IN STORAGE
❌ account_info has only balance/currency/loginid
❌ No account_type, no account list metadata
❌ Observable store not updated properly
                ↓
❌ UI has no data to display
```

### Key Differences

| Aspect                   | New API                                       | Legacy API (Current)            | Legacy API (NEEDED) |
| ------------------------ | --------------------------------------------- | ------------------------------- | ------------------- |
| **Account List Storage** | sessionStorage via DerivWSAccountsService     | ❌ MISSING                      | ✅ sessionStorage   |
| **Account Metadata**     | {account_id, balance, currency, account_type} | ❌ MISSING                      | ✅ Same as New API  |
| **Observable Update**    | setAccountList() + setAuthData()              | ✅ setAuthData() but incomplete | ✅ BOTH needed      |
| **Balance Fetch**        | Via REST API /accounts endpoint               | ❌ Via WebSocket api.balance()  | ✅ WebSocket OK     |
| **Account Type Stored**  | localStorage (demo/real)                      | ✅ Stored                       | ✅ Already done     |

## The Solution

### Step 1: Fetch Account List for Legacy OAuth (NEW CODE)

After successful authorization, fetch account list using the legacy API token (like PKCE does with REST API).

### Step 2: Store Accounts in sessionStorage

Mirror the new API's approach: store accounts with metadata in sessionStorage.

### Step 3: Update Observable Stores

Call `setAccountList()` and `setAuthData()` to populate UI observables.

### Step 4: Update storeLegacyAccounts() Function

Add account metadata fetching after authorization.

## Implementation Location

**File:** `src/app/App.tsx`
**Function:** `storeLegacyAccounts()`

Currently it only stores tokens. Needs to:

1. Call `api_base.init(true)` first
2. After authorization succeeds
3. Call `setAccountList()` with account data
4. Call `setAuthData()` with complete data

This matches the new API's flow in `oauth-token-exchange.service.ts` lines 204-231.
