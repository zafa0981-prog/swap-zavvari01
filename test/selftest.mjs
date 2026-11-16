import { Bot, DEFAULT_CFG, LIVE_TAG } from "../src/core.js";

const USDT = "0x" + "a1".repeat(20), TOKEN = "0x" + "b2".repeat(20), ROUTER = "0x" + "ab".repeat(20), WALLET = "0x" + "12".repeat(20);
const T0 = Math.floor(Date.now() / 1000);
let clock = T0;
const st = { price: 1.0, allow: 0n, receipt: null, buildValue: "0", tokenBal: 8300000000000000000n };
const pair = { chainId: "base", pairAddress: "0xpair", baseToken: { symbol: "ABC", address: TOKEN }, quoteToken: { symbol: "USDT", address: USDT },
  priceUsd: "1.0", liquidity: { usd: 5e6 }, volume: { h24: 3e7 }, priceChange: { h1: 5.0, h6: 3.0, h24: 5.0 },
  txns: { h1: { buys: 300, sells: 200 } }, pairCreatedAt: (T0 - 90 * 86400) * 1000 };
const badLiq = { ...pair, pairAddress: "0xbad", liquidity: { usd: 1000 }, baseToken: { symbol: "BAD", address: "0xbad" } };
const eth = { ...pair, chainId: "ethereum", pairAddress: "0xeth", baseToken: { symbol: "ETHX", address: "0xeth" } };
const good = { is_honeypot: "0", cannot_buy: "0", cannot_sell_all: "0", buy_tax: "0", sell_tax: "0", is_open_source: "1", hidden_owner: "0", can_take_back_ownership: "0", owner_change_balance: "0" };
const secDb = { [TOKEN.toLowerCase()]: good, "0xhp": { ...good, is_honeypot: "1" }, "0xtax": { ...good, sell_tax: "0.3" }, "0xclosed": { ...good, is_open_source: "0" } };
const rpcUrls = new Set(Object.values(DEFAULT_CFG.rpc));

async function fake(url, opt = {}) {
  if (rpcUrls.has(url)) {
    const d = opt.data;
    if (d.method === "eth_getTransactionReceipt") return { result: st.receipt };
    const { data, to } = d.params[0], sel = data.slice(0, 10), t = to.toLowerCase();
    if (sel === "0x313ce567") return { result: "0x" + (t === USDT ? 6 : 18).toString(16) };
    if (sel === "0x70a08231") return { result: "0x" + (t === USDT ? 100000000n : st.tokenBal).toString(16) };
    if (sel === "0xdd62ed3e") return { result: "0x" + st.allow.toString(16) };
    throw new Error("unexpected rpc " + sel);
  }
  if (url.includes("gopluslabs")) { const a = url.split("contract_addresses=")[1]; return { result: secDb[a] ? { [a]: secDb[a] } : {} }; }
  if (url.includes("/prices")) {
    const q = new URL(url).searchParams, amt = BigInt(q.get("amount"));
    const out = q.get("srcToken").toLowerCase() === USDT ? BigInt(Math.floor(Number(amt) / 1e6 / st.price * 0.998 * 1e18)) : BigInt(Math.floor(Number(amt) / 1e18 * st.price * 0.998 * 1e6));
    return { priceRoute: { destAmount: out.toString(), gasCostUSD: "0.02", contractAddress: ROUTER } };
  }
  if (url.includes("/transactions/")) return { to: ROUTER, data: "0xdeadbeef", value: st.buildValue, chainId: 8453, from: WALLET };
  if (url.includes("/search")) return { pairs: [pair, badLiq, eth] };
  return { pairs: [{ ...pair, priceUsd: String(st.price) }] };
}
const mem = () => { const m = new Map(); return { get: (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), set: (k, v) => m.set(k, JSON.stringify(v)), m }; };
const mk = (store, f = fake) => new Bot({ store, fetchJson: f, now: () => clock, queryDelayMs: 0 });
let all = true;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) all = false; };
const throws = async (fn) => { try { await fn(); return false; } catch { return true; } };

const store = mem();
let bot = mk(store);
ok(bot.evaluate(pair, 8.4)[0] !== null, "good pair accepted by filters");
ok(bot.evaluate(badLiq, 8.4)[1] === "نقدشوندگی کم", "low-liquidity pair rejected");
ok(bot.evaluate(eth, 8.4)[0].net_expected < 0, "ethereum gas (model) makes small trade unprofitable");
const sc = (t, c = "base") => bot.security({ chain: c, token: t });
ok((await sc(TOKEN))[0], "clean token passes security");
ok((await sc("0xhp"))[2] === "Honeypot", "honeypot rejected");
ok((await sc("0xtax"))[2] === "مالیات توکن زیاد", "high-tax token rejected");
ok(!(await sc("0xclosed"))[0], "closed-source token rejected");
ok(!(await sc("0xunknown"))[0], "unknown token rejected");
ok(!(await sc("So111", "solana"))[0], "solana rejected while unchecked");

bot.setUserCfg({ usdt_tokens: { base: USDT } });
bot.s.running = true; await bot.cycle();
ok(bot.positions().length === 1 && bot.positions()[0].usdt === USDT, "paper buy opened with real-quote data, cash=" + bot.s.cash.toFixed(4));
ok(bot.s.trades[0].note.includes("Quote واقعی"), "buy used real quote");
st.price = 1.07; await bot.cycle();
ok(bot.positions().length === 0, "take-profit sold");
const pnl = bot.s.trades.find((t) => t.side === "SELL").pnl;
ok(Math.abs(bot.s.cash - 21 - pnl) < 1e-9, "pnl " + pnl.toFixed(4) + " matches cash change");
const bot2 = mk(store);
ok(Math.abs(bot2.s.cash - bot.s.cash) < 1e-12 && bot2.cfg.usdt_tokens.base === USDT, "state + user config restored from storage");
const off = mk(store, async () => { throw new Error("offline"); }); await off.cycle();
ok(off.lastError !== "" && Math.abs(off.s.cash - bot.s.cash) < 1e-12, "offline handled, balance intact");

// --- معامله واقعی
st.price = 1.0;
const lb = mk(mem()); lb.setUserCfg({ usdt_tokens: { base: USDT } });
ok(await throws(() => lb.setLive(true)), "live refused without wallet");
lb.setWallet(WALLET); lb.setLive(true); await lb.cycle();
const pr = lb.proposal();
ok(pr && pr.kind === "BUY" && pr.size === 10, "BUY proposal created (no tx sent), size=" + (pr && pr.size));
ok(lb.positions(true).length === 0 && lb.s.cash === 21, "nothing executed before user approval");
const s1 = await lb.livePrepare(pr.id);
ok(s1.step === "approve" && s1.tx.data.startsWith("0x095ea7b3") && s1.tx.to === USDT, "step 1 = exact-amount approve on USDT");
st.allow = 10n ** 12n;
const s2 = await lb.livePrepare(pr.id);
ok(s2.step === "swap" && s2.tx.to === ROUTER && s2.tx.value === "0", "step 2 = swap to router");
st.buildValue = "5"; ok(await throws(() => lb.livePrepare(pr.id)), "unexpected native value rejected"); st.buildValue = "0";
await lb.liveSubmitted(pr.id, "0x" + "cd".repeat(32));
ok(lb.positions(true).length === 1 && !!lb.positions(true)[0].pending_tx, "position recorded as pending after submit");
st.receipt = { status: "0x1" }; await lb.checkPending();
ok(lb.positions(true).length === 1 && !lb.positions(true)[0].pending_tx && Math.abs(lb.positions(true)[0].qty - 8.3) < 1e-9, "pending confirmed on-chain, qty from balance");
st.price = 1.07; await lb.cycle();
const pr2 = lb.proposal();
ok(pr2 && pr2.kind === "SELL", "SELL proposal created at take-profit");
st.allow = 0n; const sp = await lb.livePrepare(pr2.id);
ok(sp.step === "approve" && sp.tx.to === TOKEN, "sell first needs token approve");
st.allow = 10n ** 30n; const sp2 = await lb.livePrepare(pr2.id);
ok(sp2.step === "swap" && sp2.tx.to === ROUTER, "sell swap step prepared");
await lb.liveSubmitted(pr2.id, "0x" + "ef".repeat(32)); await lb.checkPending();
ok(lb.positions(true).length === 0 && lb.s.trades.filter((t) => t.note.startsWith(LIVE_TAG)).length === 2, "live position closed, 2 live trades logged");

// --- بازیابی وقتی هش گرفته نشد (برنامه هنگام رفتن به Trust Wallet متوقف شد)
st.price = 1.0; st.receipt = null; st.tokenBal = 0n;
const rb = mk(mem()); rb.setUserCfg({ usdt_tokens: { base: USDT } }); rb.setWallet(WALLET); rb.setLive(true); await rb.cycle();
const pr3 = rb.proposal(); await rb.livePrepare(pr3.id); await rb.markInflight(pr3.id);
st.tokenBal = 8300000000000000000n; clock += 120; await rb.reconcile();
ok(rb.positions(true).length === 1 && Math.abs(rb.positions(true)[0].qty - 8.3) < 1e-9, "inflight BUY reconciled from balance change");

console.log(all ? "\nALL PASSED" : "\nSOME TESTS FAILED");
process.exit(all ? 0 : 1);
