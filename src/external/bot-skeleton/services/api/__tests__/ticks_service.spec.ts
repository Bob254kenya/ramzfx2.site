import { Map } from 'immutable';

let messageCallback: ((message: { data: unknown }) => void) | undefined;

jest.mock('../api-base', () => ({
    api_base: {
        api: {
            onMessage: () => ({
                subscribe: (callback: (message: { data: unknown }) => void) => {
                    messageCallback = callback;
                    return { unsubscribe: jest.fn() };
                },
            }),
        },
        pushSubscription: jest.fn(),
        pip_sizes: {},
    },
}));

jest.mock('../../tradeEngine/utils/helpers', () => ({
    doUntilDone: jest.fn(),
    getUUID: jest.fn(() => 'test-listener-key'),
}));

jest.mock('../../../utils/observer', () => ({
    observer: {
        emit: jest.fn(),
    },
}));

describe('TicksService', () => {
    beforeEach(() => {
        jest.resetModules();
        messageCallback = undefined;
    });

    it('accepts the first live tick when cached tick history is empty', async () => {
        const { default: TicksService } = await import('../ticks_service');
        const service = new TicksService();

        service.ticks = Map().set('R_100', []);

        expect(() =>
            messageCallback?.({
                data: {
                    msg_type: 'tick',
                    tick: { symbol: 'R_100', id: 'tick-subscription', epoch: 1717420000, quote: 123.45 },
                },
            })
        ).not.toThrow();

        expect(service.ticks.get('R_100')).toEqual([{ epoch: 1717420000, quote: 123.45 }]);
    });

    it('accepts the first live candle when cached candle history is empty', async () => {
        const { default: TicksService } = await import('../ticks_service');
        const service = new TicksService();

        service.candles = Map().setIn(['R_100', 60], []);

        expect(() =>
            messageCallback?.({
                data: {
                    msg_type: 'ohlc',
                    ohlc: {
                        symbol: 'R_100',
                        granularity: 60,
                        id: 'ohlc-subscription',
                        open_time: 1717420000,
                        open: 120,
                        high: 130,
                        low: 110,
                        close: 125,
                    },
                },
            })
        ).not.toThrow();

        expect(service.candles.getIn(['R_100', 60])).toEqual([
            { epoch: 1717420000, open: 120, high: 130, low: 110, close: 125 },
        ]);
    });
});
