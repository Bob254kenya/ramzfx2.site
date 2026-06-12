import ClientStore from '../client-store';

describe('ClientStore.resetDemoBalance', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('should persist override, update accounts and account_list, and return true', () => {
        const store: any = new ClientStore({} as any);

        // Prepare server balances and accounts
        store.server_balances = { VRTC456: 1000 };
        store.accounts = {
            VRTC456: {
                loginid: 'VRTC456',
                balance: 1000,
                currency: 'USD',
                is_virtual: true,
            },
        };
        store.account_list = [
            {
                loginid: 'VRTC456',
                balance: 1000,
                currency: 'USD',
                isVirtual: true,
            },
        ];

        const result = store.resetDemoBalance('VRTC456', 2500, 'USD');

        expect(result).toBe(true);

        const raw = localStorage.getItem('demo_balance_overrides');
        expect(raw).not.toBeNull();
        const parsed = JSON.parse(raw as string);
        expect(parsed['VRTC456']).toBeDefined();
        expect(parsed['VRTC456'].custom_balance).toBe(2500);

        expect(store.accounts['VRTC456'].balance).toBe(2500);
        const listAcc = store.account_list.find((a: any) => a.loginid === 'VRTC456');
        expect(listAcc).toBeDefined();
        expect(listAcc.balance).toBe(2500);
    });

    it('getDemoBalanceOverride should hydrate from localStorage and return override', () => {
        const store: any = new ClientStore({} as any);

        const override = {
            baseline_server_balance: 1000,
            currency: 'USD',
            custom_balance: 3000,
            last_known_server_balance: 1000,
        };
        localStorage.setItem('demo_balance_overrides', JSON.stringify({ VRTC789: override }));

        const got = store.getDemoBalanceOverride('VRTC789');
        expect(got).toBeDefined();
        expect(got.custom_balance).toBe(3000);
    });
});
