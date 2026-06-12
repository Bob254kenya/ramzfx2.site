# Page Setup and Integration Guide

## Overview

All new pages have been created and integrated. This guide explains the structure, required APIs, and how to ensure everything works correctly.

## Pages Created

### 1. **Bot Ideas** (`src/pages/bot-ideas/`)

- **Purpose**: Community-driven bot idea submission and development
- **Features**:
    - Submit bot ideas with descriptions
    - Attach XML bots to ideas
    - Edit/delete your own ideas
    - Load ideas into Bot Builder
    - View stats and ratings
- **Key Files**:
    - `bot-ideas.tsx` - Main component
    - `components/submit-form.tsx` - Idea submission form
    - `types.ts` - TypeScript types
    - `bot-ideas.scss` - Styling

### 2. **Best Bots** (Already exists in `src/pages/best-bots/`)

- **Purpose**: Display pre-built high-performing trading bots
- **Features**:
    - Load any best bot directly
    - View performance statistics
    - Star ratings based on win rate

### 3. **Dashboard** (Already exists in `src/pages/dashboard/`)

- **Purpose**: Monitor active bots and trading performance

### 4. **Bot Builder** (Already exists in `src/pages/bot-builder/`)

- **Purpose**: Visual programming interface using Blockly

### 5. **Auto Trades** (`src/pages/auto-trades/`)

- **Purpose**: Automated multi-market trading
- **Features**: Market configuration, stake management, runs configuration

### 6. **Combo** (`src/pages/combo/`)

- **Purpose**: Simultaneous multi-market trading with streak detection
- **Features**:
    - Configure multiple markets with different contract types
    - Streak-based trigger system
    - Martingale multiplier
    - Real-time live quote display
    - Cooldown period after consecutive losses
    - Take Profit/Stop Loss limits

### 7. **Scanner** (`src/pages/scanner/`)

- **Purpose**: AI-powered market signal detection
- **Features**:
    - Real-time signal generation
    - Confidence scoring
    - Auto-load to Bot Builder
    - Statistical edge calculation

### 8. **Charts** (Already exists in `src/pages/chart/`)

- **Purpose**: Technical analysis with SmartCharts

### 9. **Tutorials** (Already exists in `src/pages/tutorials/`)

- **Purpose**: Learning resources and guides

## API Integration

### Required Backend Endpoints

See `API_ENDPOINTS.md` for complete endpoint specifications. Key endpoints:

- `/api/bot-ideas` - CRUD operations for bot ideas
- `/api/best-bot-stats` - Statistics for best bots
- `/api/scanner/signal` - AI scanner signals

### API Polling & Real-time Data

- **Bot Ideas**: Auto-fetches every 30 seconds
- **Best Bots Stats**: Auto-fetches every 30 seconds
- **Scanner**: Polls for new signals, with countdown to next scan
- **Combo/Auto Trades**: WebSocket subscriptions for live market ticks

## State Management

All pages use MobX stores accessed via `useStore()` hook:

```typescript
const { client, dashboard, toolbar, run_panel, transactions } = useStore();
```

**Key stores**:

- `client` - User authentication, login status
- `dashboard` - Active tab, UI state
- `toolbar` - Strategy protection, workflow
- `run_panel` - Bot execution, logs, drawer
- `transactions` - Trade history

## Verification Checklist

✅ **Type Safety**

- All pages have TypeScript support
- No diagnostic errors found
- Types defined in respective `types.ts` files

✅ **Imports & Dependencies**

- All external imports available
- Path aliases (`@/`) working correctly
- MobX observer pattern implemented

✅ **Data Fetching**

- API_BASE endpoint configured (`/api`)
- Error handling implemented
- Retry logic with exponential backoff
- Loading states defined

✅ **User Authentication**

- Login checks before mutations
- User ID validation
- Permission-based actions (edit/delete own ideas)

✅ **UI/UX**

- Responsive design with mobile support
- Loading spinners and skeleton states
- Error messages and notifications
- Success/failure feedback

## Common Patterns Used

### Fetching Data

```typescript
const fetchData = useCallback(async () => {
    try {
        const res = await fetch(`${API_BASE}/endpoint`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setData(data);
    } catch (err) {
        setError(err.message);
    }
}, []);
```

### Showing Notifications

```typescript
const showNotification = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 5000);
};
```

### Loading into Bot Builder

```typescript
await load({
    block_string: xmlString,
    file_name: 'Bot Name',
    workspace: window.Blockly?.derivWorkspace,
    from: save_types.LOCAL,
    drop_event: {},
    strategy_id: null,
    showIncompatibleStrategyDialog: false,
});
setActiveTab(DBOT_TABS.BOT_BUILDER);
```

## Troubleshooting

### "API not found" errors

→ Ensure backend server is running and `/api` endpoints are implemented

### Pages not showing

→ Check DBOT_TABS constant in `src/constants/bot-contents.ts`

### WebSocket connection issues

→ Verify Deriv API authorization via `api_base.is_authorized`

### Form submission failures

→ Check user is logged in: `client.is_logged_in && client.loginid`
