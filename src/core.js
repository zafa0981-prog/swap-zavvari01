// سوآپ زواری — هسته ربات (بدون وابستگی به مرورگر؛ قابل تست در Node)
export const LIVE_TAG = "[واقعی] ";
export const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
export const TX_RE = /^0x[0-9a-fA-F]{64}$/;
export const GP_CHAIN = { ethereum: "1", bsc: "56", polygon: "137", arbitrum: "42161", optimism: "10", base: "8453", avalanche: "43114" };
const DS = "https://api.dexscreener.com/latest/dex";
const GOPLUS = (cid, addr) => `https://api.gopluslabs.io/api/v1/token_security/${cid}?contract_addresses=${addr}`;
const STABLES = new Set(["USDT", "USDC", "DAI", "TUSD", "FDUSD", "USDE", "BUSD", "USDD", "PYUSD", "USD1", "USDS", "USDC.E"]);
const QUERIES = ["USDT", "WETH USDT", "SOL USDT", "BNB USDT", "WBTC USDT", "TRX USDT", "AVAX USDT", "ARB USDT", "OP USDT", "POL USDT"];

export const DEFAULT_CFG = {
  start_balance: 21.0,
  scan_interval_sec: 60,
  chains: ["tron", "ethereum", "bsc", "solana", "polygon", "arbitrum", "optimism", "base", "avalanche"],
  min_liquidity_usd: 300000, min_volume24h_usd: 1000000, min_pair_age_days: 7, min_txns_1h: 30,
  min_buy_ratio_1h: 0.52, h1_range: [0.5, 8.0], h6_min: 0.0, h24_range: [-5.0, 25.0],
  max_trade_pct: 40.0, max_open_positions: 2, stop_loss_pct: 3.0, take_profit_pct: 6.0, max_hold_hours: 24,
  cooldown_minutes: 120, max_trades_per_day: 10, max_daily_loss_pct: 10.0, min_net_profit_usdt: 0.05,
  security_check: true, require_security_check: true, max_tax_pct: 5.0, max_security_checks_per_scan: 6,
  use_live_quotes: true, velora_base: "https://api.paraswap.io", slippage_bps: 100,
  swap_fee_pct: 0.30, half_spread_pct: 0.05, max_slippage_pct: 1.0, expected_capture: 0.5, gas_usd_default: 1.0,
  gas_usd: { ethereum: 3.0, tron: 2.0, bsc: 0.10, solana: 0.02, polygon: 0.03, arbitrum: 0.06, optimism: 0.04, base: 0.03, avalanche: 0.06 },
  walletconnect_project_id: "", max_live_trade_usdt: 10.0,
  usdt_tokens: {
    ethereum: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    bsc: "0x55d398326f99059fF775485246999027B3197955",
    polygon: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    arbitrum: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    optimism: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
    avalanche: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7",
  },
  rpc: {
    ethereum: "https://ethereum-rpc.publicnode.com", bsc: "https://bsc-rpc.publicnode.com",
    polygon: "https://polygon-bor-rpc.publicnode.com", arbitrum: "https://arbitrum-one-rpc.publicnode.com",
    optimism: "https://optimism-rpc.publicnode.com", base: "https://base-rpc.publicnode.com",
    avalanche: "https://avalanche-c-chain-rpc.publicnode.com",
  },
};

const num = (x, d = 0) => { const v = parseFloat(x); return Number.isFinite(v) ? v : d; };
const pad32 = (h) => String(h).toLowerCase().replace(/^0x/, "").padStart(64, "0");
const padBig = (b) => b.toString(16).padStart(64, "0");
const toRaw = (x, dec) => { const m = 9; return dec <= m ? BigInt(Math.round(x * 10 ** dec)) : BigInt(Math.round(x * 10 ** m)) * 10n ** BigInt(dec - m); };
const fromRaw = (b, dec) => Number(b) / 10 ** dec;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (o) => JSON.parse(JSON.stringify(o));
function merge(dst, src) { for (const [k, v] of Object.entries(src || {})) { if (v && typeof v === "object" && !Array.isArray(v) && dst[k] && typeof dst[k] === "object") merge(dst[k], v); else dst[k] = v; } return dst; }

export async function httpJson(url, { data, headers, timeout = 15000 } = {}) {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const t = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
  try {
    const r = await fetch(url, {
      method: data ? "POST" : "GET",
      headers: { Accept: "application/json", ...(data ? { "Content-Type": "application/json" } : {}), ...(headers || {}) },
      body: data ? JSON.stringify(data) : undefined, signal: ctrl ? ctrl.signal : undefined,
    });
    const txt = await r.text();
    if (!r.ok) throw new Error("HTTP " + r.status + " " + txt.slice(0, 200));
    return JSON.parse(txt);
  } finally { if (t) clearTimeout(t); }
}

export function legCosts(cfg, chain, size, liq, taxPct = 0) {
  const fee = size * cfg.swap_fee_pct / 100, spread = size * cfg.half_spread_pct / 100;
  const impact = 2.0 * size / Math.max(liq, 1), slip = size * impact, tax = size * taxPct / 100;
  const gas = cfg.gas_usd[chain] ?? cfg.gas_usd_default;
  return { fee, spread, slip, slip_pct: impact * 100, tax, gas, total: fee + spread + slip + tax + gas };
}

export class Bot {
  constructor({ store, fetchJson = httpJson, now = () => Date.now() / 1000, queryDelayMs = 300, onChange = () => {} }) {
    this.store = store; this.fetchJson = fetchJson; this.now = now; this.queryDelayMs = queryDelayMs; this.onChange = onChange;
    const saved = store.get("state") || {};
    this.cfg = merge(clone(DEFAULT_CFG), saved.cfg || {});
    this.s = Object.assign({ cash: this.cfg.start_balance, start: this.cfg.start_balance, running: false, live: false, wallet: null,
      positions: [], trades: [], proposal: null, nextId: 1 }, saved);
    this.userCfg = saved.cfg || {}; this.s.cfg = undefined;
    this.lastError = ""; this.busy = false; this.timer = null;
    this.lastScan = { ts: 0, pairs: 0, eligible: 0, best: null, rejects: {} };
    this.secCache = new Map(); this.decCache = new Map();
  }
  save() { const o = Object.assign({}, this.s, { cfg: this.userCfg }); this.store.set("state", o); this.onChange(); }
  setUserCfg(patch) { this.userCfg = merge(this.userCfg || {}, patch); merge(this.cfg, patch); this.save(); }
  // --- وضعیت
  positions(live = false) { return this.s.positions.filter((p) => !!p.live === !!live); }
  equity() { return this.s.cash + this.positions().reduce((a, p) => a + p.qty * (p.last_price || p.entry_price), 0); }
  dayStart() { const d = new Date(this.now() * 1000); d.setHours(0, 0, 0, 0); return d.getTime() / 1000; }
  pnlToday() { return this.s.trades.filter((t) => t.side === "SELL" && t.ts >= this.dayStart() && !t.note.startsWith(LIVE_TAG)).reduce((a, t) => a + (t.pnl || 0), 0); }
  tradesToday() { return this.s.trades.filter((t) => t.side === "BUY" && t.ts >= this.dayStart()).length; }
  liveOn() { return !!this.s.live && !!this.s.wallet; }
  addTrade(t) { this.s.trades.push(Object.assign({ id: this.s.nextId++, ts: this.now() }, t)); if (this.s.trades.length > 500) this.s.trades.shift(); }
  // --- زنجیره (RPC عمومی فقط‌خواندنی)
  async rpc(chain, method, params) {
    const url = this.cfg.rpc[chain]; if (!url) throw new Error("RPC برای " + chain + " تنظیم نشده");
    const d = await this.fetchJson(url, { data: { jsonrpc: "2.0", id: 1, method, params } });
    if (d.error) throw new Error(JSON.stringify(d.error)); return d.result;
  }
  ethCall(chain, to, data) { return this.rpc(chain, "eth_call", [{ to, data }, "latest"]); }
  async decimals(chain, addr) {
    const k = chain + ":" + addr.toLowerCase();
    if (!this.decCache.has(k)) this.decCache.set(k, Number(BigInt(await this.ethCall(chain, addr, "0x313ce567"))));
    return this.decCache.get(k);
  }
  async balanceOf(chain, token, owner) { return BigInt(await this.ethCall(chain, token, "0x70a08231" + pad32(owner))); }
  async allowance(chain, token, owner, spender) { return BigInt(await this.ethCall(chain, token, "0xdd62ed3e" + pad32(owner) + pad32(spender))); }
  async txStatus(chain, h) { const r = await this.rpc(chain, "eth_getTransactionReceipt", [h]); if (!r) return "pending"; return r.status === "0x1" ? "ok" : "failed"; }
  // --- Velora (ParaSwap)
  async veloraPrice(chain, src, dst, amount, sdec, ddec, user) {
    const q = new URLSearchParams({ srcToken: src, destToken: dst, amount: amount.toString(), srcDecimals: sdec, destDecimals: ddec, side: "SELL", network: GP_CHAIN[chain], version: "6.2" });
    if (user) q.set("userAddress", user);
    const d = await this.fetchJson(this.cfg.velora_base + "/prices?" + q.toString());
    const r = d.priceRoute; return { out: BigInt(r.destAmount), gas_usd: num(r.gasCostUSD), route: r };
  }
  veloraBuild(chain, route, src, dst, amount, user) {
    return this.fetchJson(this.cfg.velora_base + "/transactions/" + GP_CHAIN[chain], { data: { srcToken: src, destToken: dst, srcAmount: amount.toString(), slippage: this.cfg.slippage_bps, priceRoute: route, userAddress: user } });
  }
  usdtVerified(c) { const k = this.cfg.usdt_tokens[c.chain]; return !!k && k.toLowerCase() === (c.usdt || "").toLowerCase(); }
  async realRoundtrip(cand, size) {
    if (!this.cfg.use_live_quotes || !GP_CHAIN[cand.chain] || !this.usdtVerified(cand)) return null;
    try {
      const { chain: ch, usdt: u, token: t } = cand;
      const du = await this.decimals(ch, u), dt = await this.decimals(ch, t);
      const q1 = await this.veloraPrice(ch, u, t, toRaw(size, du), du, dt);
      const q2 = await this.veloraPrice(ch, t, u, q1.out, dt, du);
      const tokens = fromRaw(q1.out, dt), back = fromRaw(q2.out, du);
      return { tokens, usdt_back: back, gas_buy: q1.gas_usd, gas_sell: q2.gas_usd, tdec: dt, udec: du, buy_slip_pct: tokens > 0 ? (size / (tokens * cand.price) - 1) * 100 : 99 };
    } catch (e) { this.lastError = "Quote واقعی: " + e.message; return null; }
  }
  // --- اسکن بازار
  async fetchPairs() {
    const seen = new Set(), out = [];
    for (const q of QUERIES) {
      try {
        const d = await this.fetchJson(DS + "/search?q=" + encodeURIComponent(q));
        for (const p of d.pairs || []) { const k = p.chainId + ":" + p.pairAddress; if (!seen.has(k)) { seen.add(k); out.push(p); } }
      } catch (e) { this.lastError = "دریافت قیمت: " + e.message; }
      if (this.queryDelayMs) await sleep(this.queryDelayMs);
    }
    return out;
  }
  evaluate(p, sizeHint) {
    const c = this.cfg, chain = p.chainId, base = p.baseToken || {}, quote = p.quoteToken || {};
    const sym = (base.symbol || "").toUpperCase();
    if (!c.chains.includes(chain)) return [null, "شبکه نامعتبر"];
    if ((quote.symbol || "").toUpperCase() !== "USDT") return [null, "جفت USDT نیست"];
    if (STABLES.has(sym) || !sym) return [null, "استیبل‌کوین"];
    const price = num(p.priceUsd), liq = num((p.liquidity || {}).usd), vol = num((p.volume || {}).h24);
    const pc = p.priceChange || {}, h1 = num(pc.h1), h6 = num(pc.h6), h24 = num(pc.h24);
    const tx = (p.txns || {}).h1 || {}, buys = num(tx.buys), sells = num(tx.sells), created = num(p.pairCreatedAt) / 1000;
    if (price <= 0) return [null, "قیمت نامعتبر"];
    if (liq < c.min_liquidity_usd) return [null, "نقدشوندگی کم"];
    if (vol < c.min_volume24h_usd) return [null, "حجم کم"];
    if (created && this.now() - created < c.min_pair_age_days * 86400) return [null, "استخر جدید"];
    if (buys + sells < c.min_txns_1h || sells < 1) return [null, "تراکنش کم/فروش‌ناپذیر"];
    if (buys / (buys + sells) < c.min_buy_ratio_1h) return [null, "فشار خرید ضعیف"];
    if (h1 < c.h1_range[0] || h1 > c.h1_range[1]) return [null, "مومنتوم ۱ساعته خارج از بازه"];
    if (h6 < c.h6_min) return [null, "روند ۶ساعته منفی"];
    if (h24 < c.h24_range[0] || h24 > c.h24_range[1]) return [null, "تغییر ۲۴ساعته خارج از بازه"];
    const leg = legCosts(c, chain, sizeHint, liq);
    if (leg.slip_pct > c.max_slippage_pct) return [null, "لغزش زیاد"];
    const expected = Math.min(c.take_profit_pct, h1 * c.expected_capture);
    const net = sizeHint * expected / 100 - 2 * leg.total;
    const score = Math.min(h1, 5) * 2 + Math.min(h6, 10) * 0.5 + (buys / (buys + sells) - 0.5) * 20 + Math.min(liq / 1e6, 5) + Math.min(vol / 1e7, 5) - Math.max(0, Math.abs(h24) - 15) * 0.2;
    return [{ symbol: sym, chain, pair: p.pairAddress, token: base.address, usdt: quote.address, price, liq, vol24: vol, h1, h6, h24,
      expected_pct: +expected.toFixed(3), net_expected: +net.toFixed(4), cost_roundtrip: +(2 * leg.total).toFixed(4), score: +score.toFixed(3) }, ""];
  }
  tradeSize() { return Math.round(Math.max(0, Math.min(this.s.cash, this.equity() * this.cfg.max_trade_pct / 100)) * 100) / 100; }
  async scan(size) {
    const pairs = await this.fetchPairs(); size = size ?? this.tradeSize();
    const rejects = {}, good = [];
    for (const p of pairs) { const [cand, why] = this.evaluate(p, Math.max(size, 1)); if (cand) good.push(cand); else rejects[why] = (rejects[why] || 0) + 1; }
    const prof = good.filter((g) => g.net_expected >= this.cfg.min_net_profit_usdt || (this.cfg.use_live_quotes && GP_CHAIN[g.chain]));
    if (good.length && !prof.length) rejects["سود خالص کمتر از حداقل"] = good.length;
    prof.sort((a, b) => b.score - a.score);
    this.lastScan = { ts: this.now(), pairs: pairs.length, eligible: prof.length, best: prof[0] || null, rejects };
    return prof;
  }
  // --- امنیت توکن (GoPlus)
  async security(cand) {
    const c = this.cfg, zero = { buy_tax: 0, sell_tax: 0 };
    if (!c.security_check) return [true, zero, ""];
    const cid = GP_CHAIN[cand.chain];
    if (!cid) return c.require_security_check ? [false, null, "بررسی امنیتی برای این شبکه در دسترس نیست"] : [true, zero, ""];
    const addr = (cand.token || "").toLowerCase(), key = cand.chain + ":" + addr, hit = this.secCache.get(key);
    let res;
    if (hit && this.now() - hit[0] < 6 * 3600) res = hit[1];
    else {
      try { const d = await this.fetchJson(GOPLUS(cid, addr)); res = (d.result || {})[addr]; }
      catch (e) { this.lastError = "بررسی امنیتی: " + e.message; return [false, null, "خطا در بررسی امنیتی"]; }
      this.secCache.set(key, [this.now(), res]);
    }
    if (!res) return [false, null, "توکن در پایگاه امنیتی یافت نشد"];
    const flag = (k) => String(res[k] || "0") === "1";
    if (res.sell_tax == null || res.sell_tax === "" || res.buy_tax == null || res.buy_tax === "") return [false, null, "مالیات خرید/فروش نامشخص"];
    const bt = num(res.buy_tax) * 100, st = num(res.sell_tax) * 100;
    if (flag("is_honeypot")) return [false, null, "Honeypot"];
    if (flag("cannot_buy") || flag("cannot_sell_all")) return [false, null, "امکان خرید/فروش کامل نیست"];
    if (Math.max(bt, st) > c.max_tax_pct) return [false, null, "مالیات توکن زیاد"];
    if (String(res.is_open_source || "0") !== "1") return [false, null, "کد قرارداد منبع‌باز نیست"];
    if (flag("owner_change_balance") || flag("hidden_owner") || flag("can_take_back_ownership")) return [false, null, "کنترل مشکوک مالک"];
    return [true, { buy_tax: bt, sell_tax: st }, ""];
  }
  // --- انتخاب نقطه ورود (مشترک Paper/Live)
  async liveSize(cand) {
    const du = await this.decimals(cand.chain, cand.usdt);
    const bal = fromRaw(await this.balanceOf(cand.chain, cand.usdt, this.s.wallet), du);
    return Math.round(Math.min(this.cfg.max_live_trade_usdt, bal * this.cfg.max_trade_pct / 100) * 100) / 100;
  }
  recentlyTraded(c) { const lim = this.now() - this.cfg.cooldown_minutes * 60; return this.s.trades.some((t) => t.token === c.token && t.chain === c.chain && t.ts >= lim); }
  async findEntry(live) {
    const c = this.cfg, held = new Set(this.positions(live).map((p) => p.chain + ":" + p.token));
    let checks = 0;
    for (const cand of await this.scan(live ? c.max_live_trade_usdt : undefined)) {
      const rej = this.lastScan.rejects, bump = (w) => { rej[w] = (rej[w] || 0) + 1; };
      if (held.has(cand.chain + ":" + cand.token) || this.recentlyTraded(cand)) continue;
      if (checks >= c.max_security_checks_per_scan) break;
      checks++;
      const [ok, sec, why] = await this.security(cand);
      if (!ok) { bump(why); continue; }
      let size;
      try {
        if (live) { if (!this.usdtVerified(cand)) { bump("آدرس USDT این شبکه تأیید نشده"); continue; } size = await this.liveSize(cand); }
        else size = this.tradeSize();
      } catch (e) { this.lastError = "اطلاعات زنجیره: " + e.message; bump("خطا در خواندن اطلاعات زنجیره"); continue; }
      if (size <= 0) { bump("موجودی کافی نیست"); continue; }
      const rt = await this.realRoundtrip(cand, size);
      if (live && !rt) { bump("Quote واقعی در دسترس نیست"); continue; }
      if (rt && rt.buy_slip_pct > c.max_slippage_pct) { bump("لغزش واقعی زیاد"); continue; }
      const tax = size * (sec.buy_tax + sec.sell_tax) / 100;
      let net, src;
      if (rt) { net = size * cand.expected_pct / 100 - (size - rt.usdt_back) - rt.gas_buy - rt.gas_sell - tax; src = "Quote واقعی Velora"; }
      else {
        const lb = legCosts(c, cand.chain, size, cand.liq, sec.buy_tax), ls = legCosts(c, cand.chain, size, cand.liq, sec.sell_tax);
        net = size * cand.expected_pct / 100 - lb.total - ls.total; src = "مدل تخمینی";
      }
      if (net < c.min_net_profit_usdt) { bump("سود خالص پس از هزینه‌ها کم است"); continue; }
      Object.assign(cand, { net_expected: +net.toFixed(4), buy_tax: sec.buy_tax, sell_tax: sec.sell_tax, cost_source: src, cost_roundtrip: +(size * cand.expected_pct / 100 - net).toFixed(4) });
      this.lastScan.best = cand;
      return [cand, size, rt];
    }
    return null;
  }
  // --- معامله شبیه‌سازی‌شده
  buy(cand, size, rt) {
    const c = this.cfg; let gas, qty, fees, src;
    if (rt) { gas = rt.gas_buy; qty = rt.tokens * (1 - (cand.buy_tax || 0) / 100); fees = size - qty * cand.price + gas; src = "Quote واقعی"; }
    else { const l = legCosts(c, cand.chain, size, cand.liq, cand.buy_tax || 0); gas = l.gas; qty = (size - l.fee - l.spread - l.slip - l.tax) / cand.price; fees = l.total; src = "مدل تخمینی"; }
    if (this.s.cash < size + gas || size <= 0) return false;
    this.s.cash -= size + gas;
    this.s.positions.push({ id: this.s.nextId++, symbol: cand.symbol, chain: cand.chain, pair: cand.pair, token: cand.token, entry_price: cand.price, qty, size,
      cost_total: size + gas, liq: cand.liq, opened: this.now(), last_price: cand.price, sell_tax: cand.sell_tax || 0, live: 0,
      usdt: rt ? cand.usdt : null, tdec: rt ? rt.tdec : null, udec: rt ? rt.udec : null });
    this.addTrade({ symbol: cand.symbol, chain: cand.chain, token: cand.token, side: "BUY", usdt: size, price: cand.price, fees, pnl: null, note: `${src} — سود خالص مورد انتظار ${cand.net_expected.toFixed(3)}` });
    this.save(); return true;
  }
  async sell(pos, price, why) {
    const gross = pos.qty * price, tax = pos.sell_tax || 0; let proceeds = null, src = "مدل تخمینی";
    if (this.cfg.use_live_quotes && pos.usdt && pos.tdec != null) {
      try { const q = await this.veloraPrice(pos.chain, pos.token, pos.usdt, toRaw(pos.qty, pos.tdec), pos.tdec, pos.udec);
        proceeds = fromRaw(q.out, pos.udec) * (1 - tax / 100) - q.gas_usd; src = "Quote واقعی"; } catch (e) { /* fallback */ }
    }
    if (proceeds === null) proceeds = gross - legCosts(this.cfg, pos.chain, gross, pos.liq, tax).total;
    const pnl = proceeds - pos.cost_total;
    this.s.cash += proceeds; this.s.positions = this.s.positions.filter((p) => p.id !== pos.id);
    this.addTrade({ symbol: pos.symbol, chain: pos.chain, token: pos.token, side: "SELL", usdt: gross, price, fees: gross - proceeds, pnl, note: `${why} (${src})` });
    this.save();
  }
  exitReason(pos, price) {
    const c = this.cfg, ratio = price / pos.entry_price - 1, heldH = (this.now() - pos.opened) / 3600;
    if (ratio <= -c.stop_loss_pct / 100) return "حد ضرر";
    if (ratio >= c.take_profit_pct / 100) return "حد سود";
    if (heldH >= c.max_hold_hours) return "پایان مدت نگهداری";
    return null;
  }
  async updatePositions() {
    for (const pos of [...this.s.positions]) {
      let price = null;
      try {
        const d = await this.fetchJson(`${DS}/pairs/${pos.chain}/${pos.pair}`);
        const lst = d.pairs || (d.pair ? [d.pair] : []);
        if (lst.length) { price = num(lst[0].priceUsd); const liq = num((lst[0].liquidity || {}).usd, pos.liq); if (liq > 0) pos.liq = liq; }
      } catch (e) { this.lastError = "به‌روزرسانی موقعیت: " + e.message; }
      if (!price || price <= 0) continue;
      pos.last_price = price;
      const why = this.exitReason(pos, price);
      if (!why) continue;
      if (pos.live) { if (!pos.pending_tx) this.propose({ kind: "SELL", pos_id: pos.id, symbol: pos.symbol, chain: pos.chain, token: pos.token, usdt: pos.usdt, why }); }
      else await this.sell(pos, price, why);
    }
    this.save();
  }
  // --- معامله واقعی با تأیید کاربر
  proposal() { const p = this.s.proposal; if (p && this.now() - p.created > 900) { this.s.proposal = null; this.save(); return null; } return p; }
  propose(p) { if (this.proposal()) return; p.created = this.now(); p.id = String(Math.floor(this.now() * 1000)); this.s.proposal = p; this.save(); }
  dismiss() { this.s.proposal = null; this.save(); }
  async livePrepare(pid) {
    const p = this.proposal(), w = this.s.wallet;
    if (!p || p.id !== String(pid)) throw new Error("پیشنهاد منقضی یا نامعتبر است");
    if (!w) throw new Error("کیف پول وصل نیست");
    const ch = p.chain; if (!GP_CHAIN[ch]) throw new Error("شبکه پشتیبانی نمی‌شود");
    const { usdt, token } = p, du = await this.decimals(ch, usdt), dt = await this.decimals(ch, token);
    let src, dst, sdec, ddec, amount;
    if (p.kind === "BUY") {
      src = usdt; dst = token; sdec = du; ddec = dt; amount = toRaw(p.size, du);
      if ((await this.balanceOf(ch, usdt, w)) < amount) throw new Error("موجودی USDT کافی نیست");
    } else {
      const pos = this.s.positions.find((x) => x.id === p.pos_id); if (!pos) throw new Error("موقعیت یافت نشد");
      src = token; dst = usdt; sdec = dt; ddec = du; amount = await this.balanceOf(ch, token, w);
      if (amount <= 0n) throw new Error("موجودی توکن صفر است");
    }
    const q = await this.veloraPrice(ch, src, dst, amount, sdec, ddec, w);
    const tx = await this.veloraBuild(ch, q.route, src, dst, amount, w);
    const to = tx.to || "";
    if (!ADDR_RE.test(to) || !String(tx.data || "").startsWith("0x")) throw new Error("پاسخ ساخت تراکنش نامعتبر است");
    if (!["0", "0x0"].includes(String(tx.value ?? "0"))) throw new Error("تراکنش مبلغ بومی غیرمنتظره دارد؛ رد شد");
    if (tx.chainId && Number(tx.chainId) !== Number(GP_CHAIN[ch])) throw new Error("شناسه شبکه تراکنش با انتظار نمی‌خواند");
    if (tx.from && tx.from.toLowerCase() !== w.toLowerCase()) throw new Error("آدرس فرستنده با کیف پول نمی‌خواند");
    const ca = q.route.contractAddress; if (ca && ca.toLowerCase() !== to.toLowerCase()) throw new Error("مقصد تراکنش با مسیر Quote نمی‌خواند؛ رد شد");
    const outH = fromRaw(q.out, ddec);
    if (p.kind === "BUY" && outH > 0 && p.price) { const slip = (p.size / (outH * p.price) - 1) * 100; if (slip > this.cfg.max_slippage_pct) throw new Error(`لغزش فعلی ${slip.toFixed(2)}٪ بیشتر از سقف مجاز است`); }
    Object.assign(p, { expected_out: outH, gas_usd: q.gas_usd }); this.save();
    const base = { chain: ch, summary: { out: outH, gas_usd: q.gas_usd, slippage_bps: this.cfg.slippage_bps } };
    const allow = await this.allowance(ch, src, w, to), chainId = Number(GP_CHAIN[ch]);
    if (allow < amount) {
      if (allow > 0n && ch === "ethereum" && src.toLowerCase() === (this.cfg.usdt_tokens.ethereum || "").toLowerCase())
        return { ...base, step: "approve0", label: "گام ۱: صفر کردن مجوز قبلی USDT", tx: { from: w, to: src, data: "0x095ea7b3" + pad32(to) + padBig(0n), value: "0", chainId } };
      return { ...base, step: "approve", label: "مجوز مصرف دقیقاً همین مقدار (Approve)", tx: { from: w, to: src, data: "0x095ea7b3" + pad32(to) + padBig(amount), value: "0", chainId } };
    }
    return { ...base, step: "swap", label: "ارسال Swap به Trust Wallet برای تأیید نهایی", tx: { from: w, to, data: tx.data, value: "0", chainId } };
  }
  async liveSubmitted(pid, hash) {
    const p = this.proposal();
    if (!p || p.id !== String(pid) || !TX_RE.test(hash || "")) throw new Error("پیشنهاد یا هش نامعتبر است");
    if (p.kind === "BUY") {
      const du = await this.decimals(p.chain, p.usdt), dt = await this.decimals(p.chain, p.token);
      this.s.positions.push({ id: this.s.nextId++, symbol: p.symbol, chain: p.chain, pair: p.pair, token: p.token, entry_price: p.price,
        qty: (p.expected_out || 0) * (1 - (p.buy_tax || 0) / 100), size: p.size, cost_total: p.size + (p.gas_usd || 0), liq: p.liq, opened: this.now(),
        last_price: p.price, sell_tax: p.sell_tax || 0, live: 1, usdt: p.usdt, tdec: dt, udec: du, pending_tx: hash, pending_kind: "BUY" });
    } else {
      const pos = this.s.positions.find((x) => x.id === p.pos_id);
      if (pos) Object.assign(pos, { pending_tx: hash, pending_kind: "SELL", expected_usdt: p.expected_out || 0 });
    }
    this.s.proposal = null; this.s.inflight = null; this.save();
  }
  // اگر برنامه هنگام رفتن به Trust Wallet بسته/متوقف شد و هش تراکنش را نگرفت، با تغییر موجودی تشخیص می‌دهیم
  async markInflight(pid) {
    const p = this.proposal(); if (!p || p.id !== String(pid)) return;
    const w = this.s.wallet, held = p.kind === "BUY" ? p.token : p.token;
    this.s.inflight = { ...p, ts: this.now(), before: (await this.balanceOf(p.chain, held, w)).toString() }; this.save();
  }
  async reconcile() {
    const f = this.s.inflight; if (!f || this.now() - f.ts < 90) return;
    try {
      const dt = await this.decimals(f.chain, f.token), now = await this.balanceOf(f.chain, f.token, this.s.wallet), before = BigInt(f.before);
      if (f.kind === "BUY" && now > before) {
        const qty = fromRaw(now - before, dt), du = await this.decimals(f.chain, f.usdt);
        this.s.positions.push({ id: this.s.nextId++, symbol: f.symbol, chain: f.chain, pair: f.pair, token: f.token, entry_price: f.price, qty, size: f.size,
          cost_total: f.size + (f.gas_usd || 0), liq: f.liq, opened: this.now(), last_price: f.price, sell_tax: f.sell_tax || 0, live: 1, usdt: f.usdt, tdec: dt, udec: du });
        this.addTrade({ symbol: f.symbol, chain: f.chain, token: f.token, side: "BUY", usdt: f.size, price: f.price, fees: f.gas_usd || 0, pnl: null, note: LIVE_TAG + "تشخیص با تغییر موجودی" });
        this.s.inflight = null;
      } else if (f.kind === "SELL" && now < before / 2n) {
        const pos = this.s.positions.find((x) => x.id === f.pos_id);
        if (pos) { const pnl = (f.expected_out || 0) - pos.cost_total; this.s.positions = this.s.positions.filter((x) => x.id !== pos.id);
          this.addTrade({ symbol: f.symbol, chain: f.chain, token: f.token, side: "SELL", usdt: f.expected_out || 0, price: pos.last_price, fees: 0, pnl, note: LIVE_TAG + "تشخیص با تغییر موجودی (تقریبی)" }); }
        this.s.inflight = null;
      } else if (this.now() - f.ts > 900) this.s.inflight = null;
      this.save();
    } catch (e) { this.lastError = "تطبیق تراکنش: " + e.message; }
  }
  async checkPending() {
    for (const pos of [...this.s.positions]) {
      if (!pos.live || !pos.pending_tx) continue;
      try {
        const st = await this.txStatus(pos.chain, pos.pending_tx);
        if (st === "pending") continue;
        if (pos.pending_kind === "BUY") {
          if (st === "ok") {
            pos.qty = fromRaw(await this.balanceOf(pos.chain, pos.token, this.s.wallet), pos.tdec); const h = pos.pending_tx; pos.pending_tx = null; pos.pending_kind = null;
            this.addTrade({ symbol: pos.symbol, chain: pos.chain, token: pos.token, side: "BUY", usdt: pos.size, price: pos.entry_price, fees: pos.cost_total - pos.size, pnl: null, note: LIVE_TAG + "تأییدشده در بلاکچین " + h.slice(0, 12) });
          } else { this.s.positions = this.s.positions.filter((p) => p.id !== pos.id); this.lastError = "تراکنش خرید ناموفق بود (revert)"; }
        } else if (st === "ok") {
          const pnl = (pos.expected_usdt || 0) - pos.cost_total; this.s.positions = this.s.positions.filter((p) => p.id !== pos.id);
          this.addTrade({ symbol: pos.symbol, chain: pos.chain, token: pos.token, side: "SELL", usdt: pos.expected_usdt || 0, price: pos.last_price, fees: 0, pnl, note: LIVE_TAG + "سود/زیان تقریبی بر پایه Quote " + pos.pending_tx.slice(0, 12) });
        } else { pos.pending_tx = null; pos.pending_kind = null; this.lastError = "تراکنش فروش ناموفق بود (revert)"; }
      } catch (e) { this.lastError = "بررسی تراکنش: " + e.message; }
    }
    this.save();
  }
  // --- چرخه اصلی
  async cycle() {
    if (this.busy) return; this.busy = true;
    try {
      const c = this.cfg; await this.updatePositions(); await this.checkPending(); await this.reconcile();
      const live = this.liveOn();
      if (!live && this.pnlToday() <= -this.s.start * c.max_daily_loss_pct / 100) { this.lastError = "سقف ضرر روزانه فعال شد؛ معاملات جدید متوقف است."; return; }
      if (this.tradesToday() >= c.max_trades_per_day || this.positions(live).length >= c.max_open_positions) return;
      if (live && (this.proposal() || this.s.positions.some((p) => p.pending_tx))) return;
      const found = await this.findEntry(live); if (!found) return;
      const [cand, size, rt] = found;
      if (live) this.propose({ kind: "BUY", symbol: cand.symbol, chain: cand.chain, token: cand.token, usdt: cand.usdt, pair: cand.pair, price: cand.price, liq: cand.liq,
        size, net_expected: cand.net_expected, buy_tax: cand.buy_tax, sell_tax: cand.sell_tax, cost_source: cand.cost_source });
      else this.buy(cand, size, rt);
    } catch (e) { this.lastError = e.message; } finally { this.busy = false; this.onChange(); }
  }
  start() { this.s.running = true; this.save(); this.arm(); }
  stop() { this.s.running = false; this.save(); if (this.timer) { clearInterval(this.timer); this.timer = null; } }
  arm() { if (this.timer) clearInterval(this.timer); this.cycle(); this.timer = setInterval(() => this.cycle(), this.cfg.scan_interval_sec * 1000); }
  setWallet(a) { if (a && !ADDR_RE.test(a)) throw new Error("آدرس نامعتبر"); this.s.wallet = a || null; if (!a) this.s.live = false; this.save(); }
  setLive(on) { if (on && !this.s.wallet) throw new Error("ابتدا کیف پول را وصل کنید"); this.s.live = !!on; if (!on) this.s.proposal = null; this.save(); }
  async balances() {
    if (!this.s.wallet) throw new Error("کیف پول وصل نیست"); const out = {};
    for (const [ch, a] of Object.entries(this.cfg.usdt_tokens)) { try { out[ch] = +fromRaw(await this.balanceOf(ch, a, this.s.wallet), await this.decimals(ch, a)).toFixed(4); } catch { out[ch] = null; } }
    return out;
  }
  reset() { this.stop(); this.s.positions = this.s.positions.filter((p) => p.live); this.s.trades = this.s.trades.filter((t) => t.note.startsWith(LIVE_TAG)); this.s.cash = this.cfg.start_balance; this.s.start = this.cfg.start_balance; this.save(); }
  state() {
    const eq = this.equity(), pos = this.s.positions.map((p) => ({ ...p, value: p.qty * (p.last_price || p.entry_price), pnl_pct: ((p.last_price || p.entry_price) / p.entry_price - 1) * 100 }));
    return { running: this.s.running, cash: this.s.cash, equity: eq, start: this.s.start, pnl_total: eq - this.s.start, pnl_today: this.pnlToday(), trades_total: this.s.trades.length,
      fees_total: this.s.trades.reduce((a, t) => a + (t.fees || 0), 0), positions: pos, last_scan: this.lastScan, last_error: this.lastError,
      trades: [...this.s.trades].reverse().slice(0, 30), wallet: this.s.wallet, live: this.liveOn(), proposal: this.proposal(), cfg: this.cfg };
  }
}
