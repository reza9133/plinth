import { createClient } from "https://esm.sh/genlayer-js@1.1.8";
import { studionet } from "https://esm.sh/genlayer-js@1.1.8/chains";
import { keccak256, toHex, formatEther, parseEther } from "https://esm.sh/viem@2.57.13";
import { ERRORS } from "./errors.js";

export { parseEther };
/* ---------- config: change the address here (and nowhere else) after a redeploy ---------- */
export const CONTRACT = "0xcef1d3Fc0638070C097bbceDDD0d362BFD09912A";
export const DEPLOY_TX = "0x3d73fa709fb549d839eff1c8e7e074136977b27c3d0d240d18606322725f50a9";
export const GITHUB = "https://github.com/reza9133/plinth";
export const TWITTER = "https://x.com/amirhp771";
export const CHAIN_ID = 61999, CHAIN_HEX = "0xf22f";
export const RPC = studionet?.rpcUrls?.default?.http?.[0] ?? "https://studio.genlayer.com/api";
export const EXPLORER = "https://explorer-studio.genlayer.com"; // fixed on purpose: the library default points to another explorer
const CHAIN_PARAMS = { chainId: CHAIN_HEX, chainName: "GenLayer Studionet", rpcUrls: [RPC], nativeCurrency: { name: "GEN Token", symbol: "GEN", decimals: 18 }, blockExplorerUrls: [EXPLORER] };

/* ---------- small helpers ---------- */
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "-");
export const gen = (wei) => { const v = formatEther(BigInt(wei || 0)); return `${v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v} GEN`; };
export const lc = (s) => String(s ?? "").toLowerCase();
export const qs = (k) => new URLSearchParams(location.search).get(k);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const spinner = (s = 38) => `<span class="spw"><span class="cube" style="--s:${s}px"><i></i><i></i><i></i><i></i><i></i><i></i></span></span>`;
export const loading = (t = "Reading the chain…") => `<div class="load">${spinner()}<span>${esc(t)}</span></div>`;
export const addrLink = (a) => `<a class="mono" href="${EXPLORER}/address/${a}" target="_blank" rel="noopener" title="${a}">${short(a)}</a>`;
export function dur(s) { s = Math.max(0, Math.round(s)); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`; }
export const when = (t) => (t ? new Date(t * 1000).toLocaleString() : "-");
export function toast(msg, err = false) {
  let box = $(".toasts"); if (!box) { box = document.createElement("div"); box.className = "toasts"; document.body.append(box); }
  const t = document.createElement("div"); t.className = "toast" + (err ? " err" : ""); t.textContent = msg; box.append(t); setTimeout(() => t.remove(), err ? 7000 : 3800);
}
export async function copy(text) { try { await navigator.clipboard.writeText(text); toast("Copied"); } catch { toast("Copy failed", true); } }
/* clock of the chain: the contract measures phases with its own `now` */
export const clock = { off: 0, set(now) { if (now) this.off = now - Date.now() / 1000; }, now() { return Date.now() / 1000 + this.off; } };

/* ---------- reading ---------- */
export const reader = createClient({ chain: studionet });
export async function read(fn, args = []) {
  let err;
  for (let i = 0; i < 3; i++) {
    try { const v = await reader.readContract({ address: CONTRACT, functionName: fn, args }); return typeof v === "string" ? JSON.parse(v) : v; }
    catch (e) { err = e; await sleep(700 * (i + 1)); }
  }
  throw err;
}
export async function balanceOf(address) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }) });
  const out = await res.json(); return out?.result != null ? BigInt(out.result) : 0n;
}
export async function faucet(address, genAmount = 100) {
  // Studionet only: the simulator tops an account up. The number is written by hand because JSON cannot carry a BigInt.
  const wei = (BigInt(genAmount) * 10n ** 18n).toString();
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: `{"jsonrpc":"2.0","id":1,"method":"sim_fundAccount","params":["${address}",${wei}]}` });
  const out = await res.json(); if (out.error) throw new Error(out.error.message || "The faucet refused.");
}

/* ---------- wallet: EIP-6963 discovery, connect, disconnect, network switch ---------- */
export const W = { providers: new Map(), sel: null, account: null, chainId: null };
const emit = () => { window.dispatchEvent(new CustomEvent("plinth:wallet")); renderWallet(); };
addEventListener("eip6963:announceProvider", (e) => { if (e.detail?.info?.uuid) { W.providers.set(e.detail.info.uuid, e.detail); if ($("#walletList")) renderWalletList(); autoReconnect(e.detail); } });
dispatchEvent(new Event("eip6963:requestProvider"));
export const onWrongNet = () => W.account && W.chainId !== CHAIN_ID;
const onAccounts = (a) => { if (!a?.length) { W.account = null; W.sel = null; } else W.account = a[0]; emit(); };
const onChain = (id) => { W.chainId = parseInt(id, 16); emit(); };
function attach(detail, account, chainHex) {
  if (W.sel && W.sel !== detail) { W.sel.provider.removeListener?.("accountsChanged", onAccounts); W.sel.provider.removeListener?.("chainChanged", onChain); }
  if (W.sel !== detail) { detail.provider.on?.("accountsChanged", onAccounts); detail.provider.on?.("chainChanged", onChain); }
  W.sel = detail; W.account = account; W.chainId = parseInt(chainHex, 16);
}
async function autoReconnect(detail) {
  if (W.account || localStorage.getItem("plinth.rdns") !== detail.info.rdns) return;
  try { const a = await detail.provider.request({ method: "eth_accounts" }); if (a.length) { attach(detail, a[0], await detail.provider.request({ method: "eth_chainId" })); emit(); } } catch { /* stays disconnected */ }
}
export async function connect(detail) {
  try {
    const a = await detail.provider.request({ method: "eth_requestAccounts" });
    attach(detail, a[0], await detail.provider.request({ method: "eth_chainId" }));
    localStorage.setItem("plinth.rdns", detail.info.rdns); emit(); closeModal();
    toast(`Connected with ${detail.info.name}`);
    if (W.chainId !== CHAIN_ID) await switchNetwork();
  } catch (e) { toast(e?.code === 4001 ? "Connection request was rejected." : `Could not connect: ${e?.message ?? e}`, true); }
}
export async function disconnect() {
  const p = W.sel?.provider;
  try { await p?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }); } catch { /* not every wallet can revoke; the site forgets the account anyway */ }
  p?.removeListener?.("accountsChanged", onAccounts); p?.removeListener?.("chainChanged", onChain);
  W.sel = null; W.account = null; W.chainId = null; localStorage.removeItem("plinth.rdns"); emit(); toast("Disconnected");
}
export async function switchNetwork() {
  const p = W.sel?.provider; if (!p) return;
  try { await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] }); }
  catch (e) {
    if (e?.code === 4001) { toast("Network switch was rejected.", true); return; }
    try { await p.request({ method: "wallet_addEthereumChain", params: [CHAIN_PARAMS] }); } catch (e2) { toast(`Could not add the network: ${e2?.message ?? e2}`, true); return; }
  }
  W.chainId = parseInt(await p.request({ method: "eth_chainId" }), 16); emit();
}

/* ---------- writing ---------- */
const FAIL = /ERROR|REVERT|FAIL/i, PASS = /RETURN|SUCCESS/i;
const dump = (v) => { try { return JSON.stringify(v ?? null, (_k, x) => (typeof x === "bigint" ? x.toString() : x)); } catch { return String(v); } };
function outcome(r) {
  const leader = r?.consensus_data?.leader_receipt?.[0] ?? r?.data?.leader_receipt?.[0] ?? r?.leader_receipt?.[0];
  for (const v of [r?.txExecutionResultName, r?.resultName, leader?.execution_result, leader?.result?.status]) {
    if (typeof v !== "string" || !v) continue;
    if (FAIL.test(v)) return { ok: false, text: dump(leader ?? r) }; if (PASS.test(v)) return { ok: true };
  }
  const t = dump(r);
  if (/FINISHED_WITH_ERROR|"execution_result"\s*:\s*"ERROR"/.test(t)) return { ok: false, text: t };
  if (/FINISHED_WITH_RETURN|"execution_result"\s*:\s*"SUCCESS"/.test(t)) return { ok: true };
  return { ok: false, text: t, unknown: true };
}
export const readable = (text) => ERRORS.find((m) => text.includes(m)) ?? (/LLM_ERROR/.test(text) ? "The AI gate gave no usable answer. Try again in a few minutes." : null);
function overlay(title) {
  const o = document.createElement("div"); o.className = "ov";
  o.innerHTML = `<div class="md center" role="dialog" aria-live="polite"><div id="txSp">${spinner(52)}</div><h3 id="txT">${esc(title)}</h3><ol class="steps" style="text-align:start"></ol><p class="sm mut" id="txN"></p><div id="txB"></div></div>`;
  document.body.append(o); return o;
}
export async function send(fn, args, { value = 0n, title = "Sending transaction" } = {}) {
  if (!W.account) { openWalletModal(); throw new Error("Connect a wallet first."); }
  if (W.chainId !== CHAIN_ID) { await switchNetwork(); if (W.chainId !== CHAIN_ID) throw new Error("Switch the wallet to GenLayer Studionet first."); }
  const o = overlay(title), steps = ["Confirm in your wallet", "Validators are deciding", "Done"], ol = $(".steps", o);
  const mark = (i) => { ol.innerHTML = steps.map((s, k) => `<li class="${k < i ? "done" : k === i ? "on" : ""}">${k < i ? "✓" : k === i ? "●" : "○"} ${s}</li>`).join(""); };
  mark(0);
  try {
    const client = createClient({ chain: studionet, account: W.account, provider: W.sel.provider });
    const hash = await client.writeContract({ address: CONTRACT, functionName: fn, args, value });
    mark(1); $("#txN", o).innerHTML = `Transaction <a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noopener" class="mono">${short(hash)}</a>. AI-gated calls can take a minute or two.`;
    const receipt = await client.waitForTransactionReceipt({ hash, status: "ACCEPTED", retries: 200, interval: 3000 });
    const res = outcome(receipt);
    if (!res.ok) throw new Error(readable(res.text ?? "") ?? (res.unknown ? "The receipt could not be read. Check the transaction in the explorer." : "The contract refused this call."));
    mark(3); $("#txSp", o).innerHTML = `<div style="font-size:44px">✅</div>`; $("#txT", o).textContent = "Done"; await sleep(900);
    return { hash, receipt };
  } catch (e) {
    const msg = e?.code === 4001 || /user (rejected|denied)/i.test(e?.message ?? "") ? "You rejected the request in your wallet." : (e?.shortMessage || e?.message || String(e)).slice(0, 300);
    toast(msg, true); throw e;
  } finally { o.remove(); }
}

/* ---------- modal + prompt ---------- */
export function modal(html) { closeModal(); const o = document.createElement("div"); o.className = "ov"; o.id = "modal"; o.innerHTML = `<div class="md" role="dialog" aria-modal="true">${html}</div>`; o.addEventListener("click", (e) => { if (e.target === o) o.remove(); }); document.body.append(o); return o; }
export const closeModal = () => $("#modal")?.remove();
export function ask({ title, fields, ok = "Confirm", note = "" }) {
  return new Promise((res) => {
    const m = modal(`<h3>${esc(title)}</h3>${note ? `<p class="mut sm">${note}</p>` : ""}<form>${fields.map((f) => `<label>${esc(f.label)}</label>${f.area ? `<textarea name="${f.name}" minlength="${f.min ?? 0}" maxlength="${f.max ?? 500}" required></textarea>` : `<input name="${f.name}" value="${esc(f.value ?? "")}" ${f.type ? `type="${f.type}"` : ""} ${f.step ? `step="${f.step}"` : ""} required>`}`).join("")}<div class="cta"><button class="btn pri">${esc(ok)}</button><button type="button" class="btn" data-x>Cancel</button></div></form>`);
    const done = (v) => { m.remove(); res(v); };
    $("[data-x]", m).onclick = () => done(null); m.addEventListener("click", (e) => { if (e.target === m) res(null); });
    $("form", m).onsubmit = (e) => { e.preventDefault(); done(Object.fromEntries(new FormData(e.target))); };
  });
}

/* ---------- commitment + secrets (kept in this browser; back them up on the account page) ---------- */
export const commitment = (slot, bidder, wei, salt) => keccak256(toHex(`plinth:${slot}:${lc(bidder)}:${wei}:${salt}`)).slice(2);
export const secrets = {
  all() { try { return JSON.parse(localStorage.getItem("plinth.secrets") || "{}"); } catch { return {}; } },
  put(commit, v) { const a = this.all(); a[commit] = v; localStorage.setItem("plinth.secrets", JSON.stringify(a)); },
  get(commit) { return this.all()[commit]; },
  replace(obj) { localStorage.setItem("plinth.secrets", JSON.stringify(obj)); },
};
export const newSalt = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");

/* ---------- chrome: header, network banner, wallet UI, footer ---------- */
const NAV = [["index.html", "Home"], ["slots.html", "Slots"], ["create.html", "Create"], ["account.html", "My Plinth"], ["docs.html", "Docs"]];
export function mountChrome() {
  const page = location.pathname.split("/").pop() || "index.html";
  const hd = document.createElement("header"); hd.className = "hd";
  hd.innerHTML = `<div class="wrap"><a class="brand" href="index.html"><img src="assets/logo.svg" alt="">Plinth</a>
  <button class="btn sm burger" id="burger" aria-label="Menu">☰</button>
  <nav class="nav" id="nav">${NAV.map(([h, t]) => `<a href="${h}" class="${h === page || (h === "slots.html" && page === "slot.html") ? "on" : ""}">${t}</a>`).join("")}</nav><span class="sp"></span><div class="wal" id="wal"></div></div><div id="netbar"></div>`;
  document.body.prepend(hd);
  $("#burger").onclick = () => $("#nav").classList.toggle("open");
  const ft = document.createElement("footer"); ft.className = "ft";
  ft.innerHTML = `<div class="wrap"><div><a class="brand" href="index.html" style="margin:0 0 10px"><img src="assets/logo.svg" alt="">Plinth</a><p class="mut sm" style="max-width:34ch">A sealed-bid auction for a public slot. The model reads the words and never sees the money.</p><div class="sponsor"><span>Built on</span><img src="assets/genlayer.png" alt="GenLayer"></div></div>
  <div><b>Explore</b>${NAV.map(([h, t]) => `<a href="${h}">${t}</a>`).join("")}</div>
  <div><b>Links</b><a href="${GITHUB}" target="_blank" rel="noopener">GitHub</a><a href="${TWITTER}" target="_blank" rel="noopener">X / Twitter</a><a href="${EXPLORER}/address/${CONTRACT}" target="_blank" rel="noopener">Contract on the explorer</a><a href="#" id="cpc" class="mono sm">${short(CONTRACT)} (copy)</a></div></div>`;
  document.body.append(ft); $("#cpc").onclick = (e) => { e.preventDefault(); copy(CONTRACT); };
  $$("[data-contract]").forEach((e) => (e.textContent = CONTRACT)); $$("[data-deploytx]").forEach((e) => (e.textContent = DEPLOY_TX));
  renderWallet();
}
function renderWallet() {
  const box = $("#wal"); if (!box) return;
  if (!W.account) box.innerHTML = `<button class="btn pri" id="wc">Connect wallet</button>`;
  else box.innerHTML = `<span class="dot ${onWrongNet() ? "bad" : ""}"></span><span class="mono sm" title="${W.account}">${short(W.account)}</span><button class="btn sm" id="wd">Disconnect</button>`;
  $("#wc") && ($("#wc").onclick = openWalletModal); $("#wd") && ($("#wd").onclick = disconnect);
  const nb = $("#netbar"); if (nb) nb.innerHTML = onWrongNet() ? `<div class="net"><div class="wrap"><span>⚠ Your wallet is on chain ${W.chainId}. Plinth lives on GenLayer Studionet (${CHAIN_ID}).</span><button class="btn sm pri" id="sw">Switch network</button></div></div>` : "";
  $("#sw") && ($("#sw").onclick = switchNetwork);
}
function renderWalletList() {
  const l = $("#walletList"); if (!l) return; const ps = [...W.providers.values()];
  l.innerHTML = ps.length ? ps.map((p, i) => `<button class="wl" data-i="${i}"><img src="${esc(p.info.icon)}" alt="">${esc(p.info.name)}</button>`).join("") : `<p class="mut">No wallet found. Install an EIP-6963 wallet such as MetaMask or Rabby, then reload this page.</p>`;
  $$(".wl", l).forEach((b) => (b.onclick = () => connect(ps[+b.dataset.i])));
}
export function openWalletModal() { modal(`<h3>Connect a wallet</h3><p class="mut sm">Wallets are discovered with EIP-6963, so every installed wallet appears here by name. Plinth will ask it to switch to GenLayer Studionet.</p><div id="walletList"></div>`); renderWalletList(); dispatchEvent(new Event("eip6963:requestProvider")); }
