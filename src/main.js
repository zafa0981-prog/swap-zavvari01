import { Capacitor } from "@capacitor/core";
import { KeepAwake } from "@capacitor-community/keep-awake";
import { AppLauncher } from "@capacitor/app-launcher";
import { BackgroundMode } from "@anuradev/capacitor-background-mode";
import { EthereumProvider } from "@walletconnect/ethereum-provider";
import QRCode from "qrcode";
import { Bot, ADDR_RE } from "./core.js";

const $ = (id) => document.getElementById(id);
const f = (x, d = 2) => (x == null ? "-" : Number(x).toFixed(d));
const sg = (x, d = 3) => (x >= 0 ? "+" : "") + Number(x).toFixed(d);
const cl = (x) => (x >= 0 ? "up" : "dn");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
const stat = (t, v, c) => `<div class="stat"><span class="lab">${t}</span><b class="${c || ""}">${v}</b></div>`;

const store = {
  get: (k) => { try { return JSON.parse(localStorage.getItem("zavari_" + k)); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem("zavari_" + k, JSON.stringify(v)); } catch (e) { /* storage full */ } },
};
const bot = new Bot({ store, onChange: () => { render(); bgNotify(); } });
const CHAINS = [1, 56, 137, 42161, 10, 8453, 43114];
let wc = null, awake = false;
const native = Capacitor.isNativePlatform();

/* ---------- روشن ماندن صفحه + اجرا در پس‌زمینه ---------- */
let bgState = "off";   // off | on | needs_battery | unsupported | error
function setAwakeUi() {
  $("awake").className = "awake" + (awake || bgState === "on" ? " ok" : "");
  const bg = { off: "پس‌زمینه: غیرفعال", on: "پس‌زمینه: فعال (با خاموش‌بودن صفحه هم کار می‌کند)", needs_battery: "پس‌زمینه: مجوز «بدون محدودیت باتری» را بده",
    unsupported: "پس‌زمینه: فقط در اپ اندروید", error: "پس‌زمینه: خطا در فعال‌سازی" }[bgState];
  $("awtxt").textContent = (awake ? "صفحه روشن می‌ماند · " : "") + bg;
}
async function keepAwake(on) {
  try { if (on) await KeepAwake.keepAwake(); else await KeepAwake.allowSleep(); awake = on; }
  catch (e) { try { if (on && navigator.wakeLock) { await navigator.wakeLock.request("screen"); awake = true; } } catch { awake = false; } }
  setAwakeUi();
}
async function bgStart() {
  if (!native) { bgState = "unsupported"; setAwakeUi(); return; }
  try {
    try { await BackgroundMode.requestNotificationsPermission(); } catch { /* ignore */ }
    await BackgroundMode.enable({ title: "سوآپ زواری", text: "ربات در حال اجراست", silent: false, resume: true, hidden: false,
      disableWebViewOptimization: true, allowClose: false, channelName: "سوآپ زواری", channelDescription: "اجرای ربات در پس‌زمینه" });
    bgState = "on";
    const b = await BackgroundMode.checkBatteryOptimizations();
    if (b.enabled) { const r = await BackgroundMode.requestDisableBatteryOptimizations(); if (r.enabled) bgState = "needs_battery"; }
  } catch (e) { bgState = "error"; }
  setAwakeUi();
}
async function bgStop() { if (!native) return; try { await BackgroundMode.disable(); } catch { /* ignore */ } bgState = "off"; setAwakeUi(); }
let lastNotif = 0;
function bgNotify() {
  if (!native || bgState === "off" || Date.now() - lastNotif < 30000) return; lastNotif = Date.now();
  const S = bot.state();
  BackgroundMode.updateNotification({ text: `موجودی ${S.equity.toFixed(2)} USDT · باز: ${S.positions.length} · ${S.live ? "واقعی" : "آزمایشی"}` }).catch(() => {});
}

/* ---------- Trust Wallet / WalletConnect ---------- */
const wmsg = (t) => { $("wmsg").textContent = t; };
const pmsg = (t) => { $("pmsg").textContent = t; };
async function openUrl(url) {
  try { await AppLauncher.openUrl({ url }); return true; } catch { return false; }
}
async function openTrust(uri) {
  const ok = native && (await openUrl("trust://wc?uri=" + encodeURIComponent(uri)));
  if (!ok) window.location.href = "https://link.trustwallet.com/wc?uri=" + encodeURIComponent(uri);
}
async function initWC() {
  const pid = bot.cfg.walletconnect_project_id;
  if (!pid) throw new Error("اول Project ID را ذخیره کن");
  wc = await EthereumProvider.init({ projectId: pid, optionalChains: CHAINS, showQrModal: false,
    metadata: { name: "سوآپ زواری", description: "Swap Zavari", url: location.origin, icons: [] } });
  wc.on("display_uri", showUri);
  wc.on("disconnect", () => { bot.setWallet(null); wmsg("اتصال قطع شد"); });
  return wc;
}
async function showUri(uri) {
  $("uri").style.display = "block";
  $("dlbtn").onclick = () => openTrust(uri);
  $("curi").onclick = () => navigator.clipboard.writeText(uri).then(() => wmsg("لینک کپی شد"));
  try { $("qr").src = await QRCode.toDataURL(uri, { width: 220, margin: 1 }); } catch { /* optional */ }
  openTrust(uri);
}
async function connectWallet() {
  try {
    wmsg("در حال اتصال…");
    if (!wc) await initWC();
    if (!wc.session) await wc.connect();
    const addr = wc.accounts[0];
    bot.setWallet(addr); $("uri").style.display = "none"; wmsg("متصل شد: " + addr);
  } catch (e) { wmsg("خطا در اتصال: " + (e && e.message ? e.message : e)); }
}
async function restoreWallet() {
  try { if (bot.cfg.walletconnect_project_id && !wc) { await initWC(); if (wc.session && wc.accounts[0]) bot.setWallet(wc.accounts[0]); } } catch { /* silent */ }
}
async function disconnectWallet() {
  try { if (wc && wc.session) await wc.disconnect(); } catch { /* ignore */ }
  bot.setWallet(null); wmsg("قطع شد");
}
async function approveProposal() {
  try {
    const p = bot.proposal(); if (!p) return;
    const addr = bot.s.wallet; if (!wc || !addr) { pmsg("اول کیف پول را وصل کن"); return; }
    for (let i = 0; i < 4; i++) {
      const r = await bot.livePrepare(p.id);
      pmsg(r.label + " — در Trust Wallet تأیید کن");
      const tx = r.tx;
      try { await wc.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + Number(tx.chainId).toString(16) }] }); } catch { /* wallet may switch itself */ }
      if (r.step === "swap") await bot.markInflight(p.id);
      if (native) openUrl("trust://open_coin?asset=c60");
      const hash = await wc.request({ method: "eth_sendTransaction", params: [{ from: addr, to: tx.to, data: tx.data, value: "0x" + BigInt(tx.value || "0").toString(16) }] });
      if (r.step === "swap") { await bot.liveSubmitted(p.id, hash); pmsg("تراکنش ارسال شد: " + hash); return; }
      pmsg("در انتظار تأیید تراکنش Approve در بلاکچین…");
      let ok = false;
      for (let k = 0; k < 60; k++) {
        await new Promise((res) => setTimeout(res, 4000));
        const s = await bot.txStatus(r.chain, hash);
        if (s === "ok") { ok = true; break; }
        if (s === "failed") { pmsg("تراکنش Approve ناموفق بود"); return; }
      }
      if (!ok) { pmsg("زمان انتظار تمام شد"); return; }
    }
  } catch (e) { pmsg("خطا/لغو: " + (e && e.message ? e.message : e)); }
}

/* ---------- نمایش ---------- */
function render() {
  const S = bot.state(), L = S.last_scan, b = L.best, P = S.proposal;
  $("pill").className = "pill" + (S.running ? " on" : "");
  $("stxt").textContent = S.running ? "در حال اجرا" : "خاموش";
  $("st").disabled = S.running; $("sp").disabled = !S.running;
  $("eq").textContent = f(S.equity);
  $("pt").textContent = sg(S.pnl_today); $("pt").className = cl(S.pnl_today);
  $("pa").textContent = sg(S.pnl_total); $("pa").className = cl(S.pnl_total);
  $("modebar").textContent = S.live ? `معامله واقعی فعال است: ربات فقط پیشنهاد می‌دهد؛ هیچ تراکنشی بدون تأیید تو در Trust Wallet ارسال نمی‌شود. سقف هر معامله: ${S.cfg.max_live_trade_usdt} USDT.` : "حالت آزمایشی (Paper): هیچ تراکنش واقعی ارسال نمی‌شود. سود تضمین‌شده‌ای وجود ندارد.";
  $("live").textContent = "معامله واقعی: " + (S.live ? "روشن" : "خاموش"); $("live").className = S.live ? "live-on" : "";
  $("wstate").textContent = S.wallet ? "متصل: " + S.wallet : "متصل نیست";
  $("stats").innerHTML = stat("موجودی USDT (آزمایشی)", f(S.cash)) + stat("ارز انتخاب‌شده", b ? esc(b.symbol) : "-") + stat("شبکه", b ? esc(b.chain) : "-") +
    stat("قیمت لحظه‌ای", b ? f(b.price, 6) : "-") + stat("تعداد معاملات", S.trades_total) + stat("معاملات باز", S.positions.length) +
    stat("کل کارمزد و هزینه", f(S.fees_total, 3)) + stat("سرمایه اولیه", f(S.start));
  $("propcard").style.display = P ? "block" : "none";
  if (P) $("proptxt").innerHTML = (P.kind === "BUY" ? "خرید " : "فروش ") + `<b>${esc(P.symbol)}</b> روی <b>${esc(P.chain)}</b>` +
    (P.kind === "BUY" ? ` — مبلغ <b>${f(P.size)}</b> USDT — سود خالص مورد انتظار <b>${f(P.net_expected, 3)}</b> (${esc(P.cost_source)})` : " — دلیل: " + esc(P.why)) +
    "<br>قبل از امضا، مبلغ، کارمزد و لغزش نهایی را در Trust Wallet دوباره ببین.";
  $("pos").innerHTML = S.positions.length ? "<table><tr><th>ارز</th><th>شبکه</th><th>نوع</th><th>ورود</th><th>اکنون</th><th>٪</th><th>ارزش</th></tr>" +
    S.positions.map((p) => `<tr><td>${esc(p.symbol)}</td><td>${esc(p.chain)}</td><td>${p.live ? '<span class="tag real">واقعی' + (p.pending_tx ? " · در انتظار" : "") + "</span>" : '<span class="tag buy">آزمایشی</span>'}</td><td>${f(p.entry_price, 6)}</td><td>${f(p.last_price, 6)}</td><td class="${cl(p.pnl_pct)}" dir="ltr">${sg(p.pnl_pct, 2)}</td><td>${f(p.value)}</td></tr>`).join("") + "</table>"
    : '<div class="empty">موقعیت بازی وجود ندارد</div>';
  const r = Object.entries(L.rejects || {}).map((e) => esc(e[0]) + ": " + e[1]).join(" · ");
  $("scan").innerHTML = (L.ts ? "ساعت " + new Date(L.ts * 1000).toLocaleTimeString() : "هنوز اسکن نشده") + ` — جفت‌ارز: ${L.pairs} — واجد شرایط: ${L.eligible}` + (r ? "<br>ردشده‌ها: " + r : "") +
    (b && b.cost_source ? `<br>سود خالص مورد انتظار: ${f(b.net_expected, 3)} · هزینه رفت‌وبرگشت: ${f(b.cost_roundtrip, 3)} USDT (${esc(b.cost_source)})` : "");
  $("trd").innerHTML = S.trades.length ? "<table><tr><th>زمان</th><th>نوع</th><th>ارز</th><th>مبلغ</th><th>هزینه</th><th>سود</th><th>توضیح</th></tr>" +
    S.trades.map((t) => `<tr><td>${new Date(t.ts * 1000).toLocaleString()}</td><td><span class="tag ${t.side === "BUY" ? "buy" : "sell"}">${t.side === "BUY" ? "خرید" : "فروش"}</span></td><td>${esc(t.symbol)}</td><td>${f(t.usdt)}</td><td>${f(t.fees, 3)}</td><td class="${t.pnl == null ? "" : cl(t.pnl)}" dir="ltr">${t.pnl == null ? "-" : sg(t.pnl)}</td><td>${esc(t.note)}</td></tr>`).join("") + "</table>"
    : '<div class="empty">هنوز معامله‌ای انجام نشده</div>';
  $("err").textContent = S.last_error || "";
}
function fillSettings() {
  const c = bot.cfg;
  $("pid").value = c.walletconnect_project_id || ""; $("set_maxlive").value = c.max_live_trade_usdt;
  $("set_sl").value = c.stop_loss_pct; $("set_tp").value = c.take_profit_pct; $("set_base").value = c.usdt_tokens.base || "";
}
$("st").onclick = () => { bot.start(); keepAwake(true); bgStart(); };
$("sp").onclick = () => { bot.stop(); keepAwake(false); bgStop(); };
$("rs").onclick = () => { if (confirm("همه معاملات آزمایشی پاک و موجودی به ۲۱ USDT برگردد؟")) { bot.reset(); keepAwake(false); bgStop(); } };
$("pidsave").onclick = () => { bot.setUserCfg({ walletconnect_project_id: $("pid").value.trim() }); wc = null; wmsg("ذخیره شد"); };
$("wcon").onclick = connectWallet; $("wcoff").onclick = disconnectWallet;
$("live").onclick = () => {
  const on = !bot.state().live;
  if (on && !confirm("معامله واقعی فعال شود؟ ربات فقط پیشنهاد می‌دهد و هر تراکنش باید در Trust Wallet تأیید شود. ریسک از دست دادن سرمایه وجود دارد.")) return;
  try { bot.setLive(on); } catch (e) { wmsg(e.message); }
};
$("bal").onclick = async () => { try { const b = await bot.balances(); $("balbox").textContent = Object.entries(b).map((e) => e[0] + ": " + (e[1] == null ? "خطا" : e[1])).join(" | "); } catch (e) { $("balbox").textContent = e.message; } };
$("pa_ok").onclick = approveProposal;
$("pa_no").onclick = () => bot.dismiss();
$("set_save").onclick = () => {
  const n = (id) => parseFloat($(id).value.replace(",", ".")), ml = n("set_maxlive"), sl = n("set_sl"), tp = n("set_tp"), base = $("set_base").value.trim();
  if (!(ml > 0 && sl > 0 && tp > 0)) { $("set_msg").textContent = "مقادیر عددی باید بزرگ‌تر از صفر باشند"; return; }
  if (base && !ADDR_RE.test(base)) { $("set_msg").textContent = "آدرس USDT نامعتبر است"; return; }
  const patch = { max_live_trade_usdt: ml, stop_loss_pct: sl, take_profit_pct: tp };
  if (base) patch.usdt_tokens = { base };
  bot.setUserCfg(patch); $("set_msg").textContent = "ذخیره شد";
};
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && bot.s.running) { keepAwake(true); bot.cycle(); } });

fillSettings(); render(); setAwakeUi();
if (bot.s.running) { bot.arm(); keepAwake(true); bgStart(); }
restoreWallet();
setInterval(render, 4000);
