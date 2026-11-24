// Early Traction Rider — a paper bot for the pump.fun replay (agent-fun/replay/v2).
//
// Idea, in one line: most new pump.fun curves die fast, a few run to completion
// (~14.7x from the create price), so buy small only once a curve shows real
// traction, cut losers fast, bank half on a good run, and let the rest ride
// behind a trailing stop so a runner can pay for many small losses.
//
// What the dev data showed: a coin that reaches 20 distinct buyers usually does
// it within ~30 slots of its CreateEvent, at about 1.8x the create price; a third
// of those reach 3x from create within the next 2000 slots and a few complete.
// The creator selling early, or one wallet dominating the early buys, marks the
// launches that dump instead, so both are filtered out. Curves that complete in
// their first slot (a single whale sweeping the curve) cannot be bought by any
// bot that has to see the trades first, so the bot does not chase them.
//
// How it reads a batch: every batch carries the slot, the curve events for that
// slot (CreateEvent / TradeEvent / CompleteEvent) and the fills of our own
// orders decided on earlier batches. The hello message sets the caps (at most 5
// open positions, at most 1% of a curve's real SOL reserve per reply, at most 16
// orders per batch) and the capital (10 SOL). All decisions are pure functions
// of the batches seen so far: no clock, no randomness, no I/O, so the two
// graded executions produce byte-identical action logs.
//
// Entry (one first buy per coin, 0.05 SOL):
//   - the curve is young (under 600 slots since its CreateEvent) and liquid
//     enough to take a meaningful buy (real SOL between 5 and 85),
//   - at least 20 trades, at least 20 distinct buyers, net buy flow over the
//     last 20 trades at least +0.2 SOL, no single buyer over 60% of it,
//   - price up 20-300% from the create price and within 15% of its high so far
//     (rising, not already faded),
//   - the creator has not sold and their own buys are under 2.5 SOL.
//   While the price keeps rising at least 12% above the last buy and flow stays
//   positive, the position may be added to, up to 0.05 SOL total in the shipped
//   settings (adds are off by default; the knobs stay for research).
//
// Exits (sell the whole position unless noted):
//   - stop loss: liquidation value at or below 85% of cost,
//   - take profit: at 125% of cost sell half the tokens, then trail the rest:
//     sell the rest once the value falls 25% from its peak,
//   - fade: net flow over the last 20 trades below -0.5 SOL while under water,
//   - the creator sells while we hold, no trade for 1000 slots, or 3000 slots
//     held — sell everything.
//   A curve that completes is closed by the replay itself.
//
// Guardrail pacing: the entry bar alone should trade far more than the 20
// coins the minimum bar needs, but if round trips lag the pace (fewer than 20
// distinct coins with a completed round trip once 150k slots have passed),
// buy 0.01 SOL probes of the most liquid recently-traded curves and sell them
// on the next batch. Probes are a safety net, not the strategy.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  minAge: number;
  maxAge: number;
  maxRecentRunup: number;
  minRealSol: number;
  maxRealSol: number;
  minTrades: number;
  minBuyers: number;
  minNetFlowSol: number;
  maxBuyerShare: number;
  minRunup: number;
  maxRunup: number;
  nearHigh: number;
  maxDevBuySol: number;
  firstBuySol: number;
  addBuySol: number;
  maxSpentSol: number;
  addStep: number;
  stopLoss: number;
  takeProfit: number;
  trailDrop: number;
  fadeNetSol: number;
  staleSlots: number;
  maxHoldSlots: number;
  buySlipBps: number;
  sellSlipBps: number;
  maxMainOpen: number;
  probeSol: number;
  probeAfterSlots: number;
  probeMinRealSol: number;
  skipDevSold: boolean;
  debug: boolean;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 600,
  minRealSol: 5,
  maxRealSol: 85,
  minTrades: 20,
  minBuyers: 20,
  minNetFlowSol: 0.2,
  maxBuyerShare: 0.6,
  minRunup: 0.2,
  maxRunup: 3.0,
  nearHigh: 0.85,
  maxDevBuySol: 2.5,
  firstBuySol: 0.05,
  addBuySol: 0.03,
  maxSpentSol: 0.05,
  addStep: 0.12,
  stopLoss: 0.85,
  takeProfit: 1.25,
  trailDrop: 0.25,
  fadeNetSol: -0.5,
  staleSlots: 1000,
  maxHoldSlots: 3000,
  buySlipBps: 2000,
  sellSlipBps: 10000,
  maxMainOpen: 5,
  probeSol: 0.01,
  probeAfterSlots: 150000,
  probeMinRealSol: 10,
  skipDevSold: true,
  debug: false,
}

const LAMPORTS = 1_000_000_000;

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: number;
  user: Pubkey;
  price: number;
}

interface Tape {
  mint: Pubkey;
  createdSlot: number;
  createPrice: number;
  creator: Pubkey;
  devBuySol: number;
  devSold: boolean;
  trades: Tick[];
  buyers: Set<Pubkey>;
  buySol: number;
  highPrice: number;
  decided: boolean;
  counted: boolean;
  entries: number;
  spentSol: number;
  lastBuyPrice: number;
  lastExitSlot: number;
}

interface Held {
  mint: Pubkey;
  openedSlot: number;
  peakValueSol: number;
  partialled: boolean;
  peakRatio: number;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const roundTripped = new Set<Pubkey>();
  const boughtCoins = new Set<Pubkey>();
  const probes = new Map<Pubkey, boolean>(); // mint -> true once its sell is sent
  // Mints with a sell of ours still in flight: the account still shows the
  // tokens until the fill lands, so sending another sell would be rejected
  // for insufficient tokens. Tracked from the orders we send, cleared on fill.
  const sellPending = new Set<Pubkey>();
  let firstSlot = -1;
  let myBuysFilled = 0;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        mint,
        createdSlot: -1,
        createPrice: 0,
        creator: '',
        devBuySol: 0,
        devSold: false,
        trades: [],
        buyers: new Set(),
        buySol: 0,
        highPrice: 0,
        decided: false,
        entries: 0,
        spentSol: 0,
        lastBuyPrice: 0,
        lastExitSlot: -1e12,
      };
      tapes.set(mint, t);
    }
    return t;
  };

  const recent = (t: Tape, n: number): Tick[] => t.trades.slice(-n);

  const netFlow = (t: Tape, n: number): number => {
    let net = 0;
    for (const tk of recent(t, n)) net += tk.isBuy ? tk.sol : -tk.sol;
    return net;
  };

  const topBuyerShare = (t: Tape, n: number): number => {
    const byUser = new Map<Pubkey, number>();
    let total = 0;
    for (const tk of recent(t, n)) {
      if (!tk.isBuy) continue;
      total += tk.sol;
      byUser.set(tk.user, (byUser.get(tk.user) ?? 0) + tk.sol);
    }
    if (total <= 0) return 1;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    return top / total;
  };

  const onBatch = (state: BotState, batch: Batch): OrderInput[] => {
    if (firstSlot < 0) firstSlot = batch.slot;
    const orders: OrderInput[] = [];
    const tx = Number(state.txFeeLamports()) / LAMPORTS;
    const caps = state.hello.caps;

    // Fold this batch's fills into our books first.
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      if (f.side === 'buy') {
        myBuysFilled += 1;
        boughtCoins.add(f.mint);
        const t = tapes.get(f.mint);
        if (t !== undefined) t.spentSol += Number(f.quote_lamports) / LAMPORTS;
      } else {
        roundTripped.add(f.mint);
        probes.delete(f.mint);
        sellPending.delete(f.mint);
      }
    }

    // Fold this batch's events into the tapes.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const t = tapeOf(e.mint);
        t.createdSlot = e.slot;
        t.creator = e.creator;
        t.createPrice = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        t.highPrice = t.createPrice;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        const sol = Number(e.sol_amount) / LAMPORTS;
        const tick: Tick = {
          slot: e.slot,
          isBuy: e.is_buy,
          sol,
          user: e.user,
          price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
        };
        t.trades.push(tick);
        if (t.trades.length > 60) t.trades.splice(0, t.trades.length - 60);
        if (e.is_buy) {
          t.buyers.add(e.user);
          t.buySol += sol;
          if (e.user === t.creator) t.devBuySol += sol;
        } else if (e.user === t.creator) {
          t.devSold = true;
        }
        const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (price > t.highPrice) t.highPrice = price;
      } else {
        const t = tapes.get(e.mint);
        if (t !== undefined) t.decided = true;
        held.delete(e.mint);
      }
    }

    const pushBuy = (mint: Pubkey, solAmount: number): boolean => {
      if (orders.length >= caps.max_orders_per_batch) return false;
      const cap = Number(state.maxBuyLamports(mint)) / LAMPORTS;
      const amount = Math.min(solAmount, cap);
      if (amount < 0.01) return false;
      const free = Number(state.freeCashLamports()) / LAMPORTS;
      let reserved = 0;
      for (const o of orders) if (o.side === 'buy') reserved += Number(o.quote_lamports) / LAMPORTS + tx;
      if (free - reserved < amount + tx) return false;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
        max_slippage_bps: p.buySlipBps,
      });
      return true;
    };

    const pushSellAll = (mint: Pubkey): boolean => {
      if (orders.length >= caps.max_orders_per_batch) return false;
      if (sellPending.has(mint)) return false;
      const pos = state.positions.get(mint);
      if (pos === undefined || pos.token_amount === 0n) return false;
      orders.push({
        side: 'sell',
        mint,
        token_amount: pos.token_amount,
        max_slippage_bps: p.sellSlipBps,
      });
      sellPending.add(mint);
      return true;
    };

    const pushSellPart = (mint: Pubkey, fraction: number): boolean => {
      if (orders.length >= caps.max_orders_per_batch) return false;
      if (sellPending.has(mint)) return false;
      const pos = state.positions.get(mint);
      if (pos === undefined || pos.token_amount === 0n) return false;
      const amount = (pos.token_amount * BigInt(Math.floor(fraction * 1000))) / 1000n;
      if (amount === 0n) return false;
      orders.push({ side: 'sell', mint, token_amount: amount, max_slippage_bps: p.sellSlipBps });
      sellPending.add(mint);
      return true;
    };

    // --- exits for positions we hold ---
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0) continue;
      const valueSol = (Number(pos.token_amount) * price) / LAMPORTS;
      const costSol = Number(pos.cost_lamports) / LAMPORTS;
      if (costSol <= 0) continue;
      const ratio = valueSol / costSol;
      let h = held.get(mint);
      if (h === undefined) {
        h = { mint, openedSlot: batch.slot, peakValueSol: valueSol, peakRatio: ratio, partialled: false };
        held.set(mint, h);
      }
      if (valueSol > h.peakValueSol) h.peakValueSol = valueSol;
      if (ratio > h.peakRatio) h.peakRatio = ratio;
      const t = tapes.get(mint);
      const age = t !== undefined && t.createdSlot >= 0 ? batch.slot - t.createdSlot : 0;
      const heldSlots = batch.slot - h.openedSlot;
      const lastTradeSlot = t !== undefined && t.trades.length > 0 ? t.trades[t.trades.length - 1].slot : batch.slot;

      if (probes.has(mint)) {
        // Probe positions exit on the next batch after they land, whatever the price.
        if (pushSellAll(mint)) {
          const tape = tapes.get(mint);
          if (tape !== undefined) tape.lastExitSlot = batch.slot;
          held.delete(mint);
        }
        continue;
      }
      if (t !== undefined && t.devSold) {
        if (pushSellAll(mint)) {
          t.lastExitSlot = batch.slot;
          held.delete(mint);
        }
        continue;
      }
      if (ratio <= p.stopLoss) {
        if (p.debug) console.error(`exit stop ${mint.slice(0, 8)} slot ${batch.slot} ratio ${ratio.toFixed(3)}`);
        if (pushSellAll(mint)) {
          if (t !== undefined) t.lastExitSlot = batch.slot;
          held.delete(mint);
        }
        continue;
      }
      if (!h.partialled && ratio >= p.takeProfit) {
        if (p.debug) console.error(`exit tp-half ${mint.slice(0, 8)} slot ${batch.slot} ratio ${ratio.toFixed(3)}`);
        if (pushSellPart(mint, 0.5)) h.partialled = true;
        continue;
      }
      if (h.partialled && h.peakRatio >= p.takeProfit && ratio <= h.peakRatio * (1 - p.trailDrop)) {
        if (p.debug) console.error(`exit trail ${mint.slice(0, 8)} slot ${batch.slot} ratio ${ratio.toFixed(3)} peak ${h.peakRatio.toFixed(3)}`);
        if (pushSellAll(mint)) {
          if (t !== undefined) t.lastExitSlot = batch.slot;
          held.delete(mint);
        }
        continue;
      }
      if (t !== undefined && ratio < 1 && netFlow(t, 20) <= p.fadeNetSol) {
        if (p.debug) console.error(`exit fade ${mint.slice(0, 8)} slot ${batch.slot} ratio ${ratio.toFixed(3)} netflow ${netFlow(t, 20).toFixed(2)}`);
        if (pushSellAll(mint)) {
          t.lastExitSlot = batch.slot;
          held.delete(mint);
        }
        continue;
      }
      if (batch.slot - lastTradeSlot >= p.staleSlots || heldSlots >= p.maxHoldSlots || age >= 20000) {
        if (p.debug) console.error(`exit stale/hold ${mint.slice(0, 8)} slot ${batch.slot} ratio ${ratio.toFixed(3)} gap ${batch.slot - lastTradeSlot} held ${heldSlots}`);
        if (pushSellAll(mint)) {
          if (t !== undefined) t.lastExitSlot = batch.slot;
          held.delete(mint);
        }
        continue;
      }
    }

    // --- pyramid adds on positions still showing strength ---
    for (const [mint, pos] of state.positions) {
      if (probes.has(mint)) continue;
      const t = tapes.get(mint);
      const curve = state.curves.get(mint);
      if (t === undefined || curve === undefined || curve.complete) continue;
      if (t.entries >= 3 || t.spentSol >= p.maxSpentSol) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (t.lastBuyPrice <= 0 || price < t.lastBuyPrice * (1 + p.addStep)) continue;
      if (netFlow(t, 20) < p.minNetFlowSol) continue;
      if (pushBuy(mint, p.addBuySol)) {
        t.entries += 1;
        t.lastBuyPrice = price;
      }
    }

    // --- new entries ---
    let openMain = [...state.positions.keys()].filter((m) => !probes.has(m)).length;
    openMain += [...state.pending.values()].filter(
      (po) => po.order.side === 'buy' && !probes.has(po.order.mint),
    ).length;
    if (openMain < p.maxMainOpen) {
      for (const e of batch.events) {
        if (openMain >= p.maxMainOpen) break;
        if (orders.length >= caps.max_orders_per_batch) break;
        if (e.event !== 'TradeEvent' && e.event !== 'CreateEvent') continue;
        const mint = e.mint;
        const t = tapes.get(mint);
        const curve = state.curves.get(mint);
        if (t === undefined || curve === undefined || curve.complete) continue;
        if (t.decided || t.createdSlot < 0) continue;
        if (p.debug && !t.counted && t.buyers.size >= 20) {
          t.counted = true;
          const age0 = batch.slot - t.createdSlot;
          const realSol0 = Number(curve.real_quote_reserves) / LAMPORTS;
          const price0 = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
          const runup0 = t.createPrice > 0 ? price0 / t.createPrice - 1 : -1;
          const fails: string[] = [];
          if (age0 < p.minAge || age0 > p.maxAge) fails.push(`age${age0}`);
          if (realSol0 < p.minRealSol || realSol0 > p.maxRealSol) fails.push(`rq${realSol0.toFixed(1)}`);
          if (runup0 < p.minRunup || runup0 > p.maxRunup) fails.push(`run${runup0.toFixed(2)}`);
          if (t.highPrice > 0 && price0 < t.highPrice * p.nearHigh) fails.push('nearHigh');
          if (netFlow(t, 20) < p.minNetFlowSol) fails.push(`flow${netFlow(t, 20).toFixed(2)}`);
          if (topBuyerShare(t, 20) > p.maxBuyerShare) fails.push('share');
          if (p.skipDevSold && t.devSold) fails.push('devSold');
          if (t.devBuySol > p.maxDevBuySol) fails.push(`devBuy${t.devBuySol.toFixed(1)}`);
          if (curve.trades < p.minTrades) fails.push(`trades${curve.trades}`);
          console.error(`eval ${mint.slice(0, 8)} fails=${fails.join(',') || 'NONE'}`);
        }
        if (state.positions.has(mint)) continue;
        if ([...state.pending.values()].some((po) => po.order.mint === mint)) continue;
        const age = batch.slot - t.createdSlot;
        if (age < p.minAge || age > p.maxAge) continue;
        if (batch.slot - t.lastExitSlot < 300) continue;
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (realSol < p.minRealSol || realSol > p.maxRealSol) continue;
        if (curve.trades < p.minTrades) continue;
        if (t.buyers.size < p.minBuyers) continue;
        if ((p.skipDevSold && t.devSold) || t.devBuySol > p.maxDevBuySol) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (t.createPrice <= 0 || price <= 0) continue;
        const runup = price / t.createPrice - 1;
        if (runup < p.minRunup || runup > p.maxRunup) continue;
        if (t.highPrice > 0 && price < t.highPrice * p.nearHigh) continue;
        if (netFlow(t, 20) < p.minNetFlowSol) continue;
        if (topBuyerShare(t, 20) > p.maxBuyerShare) continue;
        const old = recent(t, 20)[0];
        if (old !== undefined && old.price > 0 && price > old.price * p.maxRecentRunup) continue;
        if (pushBuy(mint, p.firstBuySol)) {
          t.decided = true;
          t.entries = 1;
          t.lastBuyPrice = price;
          openMain += 1;
          if (p.debug) console.error(`enter ${mint.slice(0, 8)} slot ${batch.slot} age ${age} runup ${runup.toFixed(3)} netflow ${netFlow(t, 20).toFixed(2)} realSol ${realSol.toFixed(1)} buyers ${t.buyers.size}`);
        }
      }
    }

    // --- guardrail probes: only if round trips are lagging late in the window ---
    const elapsed = firstSlot < 0 ? 0 : batch.slot - firstSlot;
    if (elapsed >= p.probeAfterSlots && roundTripped.size < 20 && myBuysFilled < 400) {
      if (state.committedPositionCount() < caps.max_open_positions) {
        let bestMint: Pubkey | null = null;
        let bestReal = 0;
        for (const [mint, curve] of state.curves) {
          if (curve.complete || state.positions.has(mint) || probes.has(mint)) continue;
          if (roundTripped.has(mint) || boughtCoins.has(mint)) continue;
          const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
          if (realSol < p.probeMinRealSol) continue;
          const t = tapes.get(mint);
          const lastTrade = t !== undefined && t.trades.length > 0 ? t.trades[t.trades.length - 1].slot : -1e12;
          if (batch.slot - lastTrade > 200) continue;
          if (realSol > bestReal) {
            bestReal = realSol;
            bestMint = mint;
          }
        }
        if (bestMint !== null && pushBuy(bestMint, p.probeSol)) {
          probes.set(bestMint, false);
          const t = tapes.get(bestMint);
          if (t !== undefined) t.decided = true;
        }
      }
    }

    return orders;
  };

  return { onBatch };
}
