// Perps venues other than Hyperliquid, for the perps page (src/perps.js).
//
// The page was built on Hyperliquid, so every other venue is an adapter that
// hands back Hyperliquid-shaped data: then the chart, book, ticket, positions,
// orders, alerts and PnL cards work unchanged, and only the fetching and the
// signing differ. Hyperliquid itself stays native in perps.js (it has extras
// the others don't: HIP-3, the top-traders view, unified accounts).
//
// An adapter is an object:
//
//   id, name, site                     'pacifica', 'Pacifica', 'https://app.pacifica.fi'
//   key: { kind, label, help }         what signs: 'sol' (keys.v1.sol), 'evm' (keys.v1.evm) or
//                                      'apikey' (an exchange-issued key pair the user pastes)
//   collateral                         'USDC', 'USDT', ...
//
//   markets()            -> [Market]   every live market, prices filled in
//   watchPrices(markets, onUpdate)     keep mid/mark/funding/oi/volume/change fresh; returns stop()
//   candles(coin, interval, startMs, endMs) -> [{ t, o, h, l, c, v }] oldest first
//   subCandles(coin, interval, cb)     live candle updates cb({ t,o,h,l,c,v }); returns stop()
//   subBook(coin, cb)                  cb({ levels: [bids, asks] }) where each level is
//                                      { px, sz, n } (strings ok), best first; returns stop()
//   subTrades(coin, cb)  (optional)    cb([{ px, sz, side: 'B'|'A', time }]); returns stop()
//
//   connect(secret)      -> Session     secret is what key.kind names; throws if unusable
//
// A Market (Hyperliquid's shape, as src/hyperliquid.js hlMarkets makes them):
//   { coin, label, dex: '', dexName, asset: null, szDecimals, pxDecimals?, tick, lot, minNotional,
//     maxLeverage, onlyIsolated, collateral, mid, mark, oracle, change (24h %), funding (per hour,
//     fraction), oi (in coins), volume (24h, USD), delisted: false }
//
// A Session:
//   address                                           the account id shown in the header
//   state()   -> { st, orders, fills, fees }          one poll of the account:
//      st:     { marginSummary: { accountValue }, withdrawable, crossMarginSummary: { accountValue, totalNtlPos },
//                crossMaintenanceMarginUsed, assetPositions: [{ position: { coin, szi, entryPx, positionValue,
//                unrealizedPnl, returnOnEquity, liquidationPx, marginUsed, leverage: { type, value } } }] }
//      orders: [{ coin, oid, side: 'B'|'A', sz, limitPx, orderType, reduceOnly, isTrigger, triggerPx, timestamp }]
//      fills:  [{ coin, oid, side: 'B'|'A', px, sz, time, dir, closedPnl, fee, feeToken, startPosition? }] newest first
//      fees:   { taker, maker } as fractions
//   order({ coin, isBuy, sz, type: 'market'|'limit', px, slippage (%), reduceOnly, tif, tp, sl }) -> { ok, msg, id }
//   cancel(coin, oid), cancelAll(), setLeverage(coin, lev, cross), setTpsl(coin, { tp, sl })
//   pollMs                                            how often the page calls state()
//
// Errors come back as thrown Error with the venue's own message.

import { pacifica } from './pacifica.js';
import { aster } from './aster.js';
import { backpack, setBackpackBase } from './backpack.js';
import { lighter } from './lighter.js';

export const VENUES = {
  pacifica,
  aster,
  backpack,
  lighter,
};
export { setBackpackBase };
export const VENUE_IDS = ['hl', ...Object.keys(VENUES)];
export const venueName = (id) => (id === 'hl' ? 'Hyperliquid' : VENUES[id]?.name || id);

export { stepDecimals, toStep } from './util.js';
