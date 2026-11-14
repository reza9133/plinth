import { $, $$, esc, short, gen, lc, qs, dur, when, toast, copy, loading, spinner, addrLink, clock, read, send, ask, modal, closeModal, W, openWalletModal, onWrongNet, mountChrome, parseEther, commitment, secrets, newSalt, balanceOf, faucet, EXPLORER, CONTRACT } from "./core.js";

mountChrome();
const GATE = ["Waiting for the gate", "Cleared", "Unsure", "Refused", "Vetoed"], GATE_CLS = ["", "ok", "warn", "bad", "bad"];
const OUT = ["Pending", "Won", "Lost", "Excluded", "Forfeited"], STAGE = ["Open", "On display", "Void", "Released", "Taken down"];
const PHASE_LABEL = { IDLE: "Idle", BID: "Bidding", REVIEW: "Review", REVEAL: "Reveal", SETTLE: "Ready to settle", FINAL: "Finished" };
const mine = (a) => W.account && lc(a) === lc(W.account);
const fail = (box, e) => (box.innerHTML = `<div class="empty">Could not read the contract: ${esc(e?.shortMessage || e?.message || e)}<br><button class="btn sm" onclick="location.reload()" style="margin-top:10px">Try again</button></div>`);
const run = async (p, after) => { try { await p(); toast("Done"); await after?.(); } catch { /* send() already told the user */ } };
function tick() { $$("[data-until]").forEach((e) => { const t = +e.dataset.until - clock.now(); e.textContent = t > 0 ? dur(t) : "now"; }); }
setInterval(tick, 1000);
const pages = {};

/* ---------- home ---------- */
pages.home = async () => {
  try {
    const [s, v] = await Promise.all([read("stats"), read("solvency")]);
    const set = (k, t) => $$(`[data-stat="${k}"]`).forEach((e) => (e.textContent = t));
    set("slots", s.slots); set("bids", s.bids); set("settled", s.settled); set("reads", s.reads); set("volume", gen(s.volume));
    $$("[data-solv]").forEach((e) => { e.className = "pill " + (v.balanced ? "ok" : "bad"); e.textContent = v.balanced ? "Books balanced on chain" : "Books do not balance!"; });
  } catch { $$("[data-stat]").forEach((e) => (e.textContent = "–")); }
};

/* ---------- slot cards ---------- */
async function slotCard(s) {
  const [st, cur] = await Promise.all([read("status", [s.id]), read("current", [s.id])]); clock.set(st.now);
  return `<a class="card lnk" href="slot.html?id=${s.id}"><div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px"><span class="pill teal">Slot #${s.id}</span><span class="pill ${st.paused ? "warn" : "vio"}">${st.paused ? "Paused" : PHASE_LABEL[st.phase]}</span>${st.can_bid ? '<span class="pill ok">Open for bids</span>' : ""}</div>
  <h3>${esc(s.name)}</h3><p class="mut sm" style="margin:0 0 12px">${s.rules.length} rule${s.rules.length > 1 ? "s" : ""} · deposit ${gen(s.max_bid)} · reserve ${gen(s.reserve)}</p>
  ${cur.occupied ? `<p style="margin:0"><b>On display:</b> “${esc(cur.creative.slice(0, 90))}${cur.creative.length > 90 ? "…" : ""}”</p>` : '<p class="mut" style="margin:0">Nothing on display yet.</p>'}</a>`;
}
pages.slots = async () => {
  const box = $("#list"); box.innerHTML = loading();
  try {
    const rows = await read("list_slots", [0, 50]);
    box.innerHTML = rows.length ? `<div class="grid g3">${(await Promise.all(rows.map(slotCard))).join("")}</div>` : `<div class="empty">No slot exists yet. <a href="create.html">Open the first one.</a></div>`;
  } catch (e) { fail(box, e); }
};

/* ---------- one slot ---------- */
pages.slot = async () => {
  const id = +qs("id"), root = $("#slot"); let S, formKey = "";
  if (!Number.isInteger(id) || id < 0) return (root.innerHTML = `<div class="empty">Open a slot from the <a href="slots.html">list</a>.</div>`);
  root.innerHTML = loading();
  const isCur = () => mine(S.slot.curator);
  async function load() {
    try {
      const [slot, st, cur, rounds] = await Promise.all([read("get_slot", [id]), read("status", [id]), read("current", [id]), read("rounds_of", [id, 0, 8])]);
      clock.set(st.now); const bids = rounds[0] ? await read("bids_of_round", [rounds[0].id, 0, 50]) : [];
      S = { slot, st, cur, rounds, bids }; draw();
    } catch (e) { fail(root, e); }
  }
  const reload = () => load();
  function draw() {
    const { slot: s, st, cur, rounds, bids } = S, L = rounds[0], phase = L && L.stage === 0 ? L.phase : st.phase, now = clock.now();
    const key = `${st.can_bid}|${W.account}`, keep = formKey === key && $("#bidForm");
    const secs = (x) => dur(x);
    root.innerHTML = `
    <div class="crumb"><a href="slots.html">Slots</a> / #${id}</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center"><h1 style="font-size:clamp(2rem,4vw,3rem);margin:0">${esc(s.name)}</h1><span class="pill ${s.paused ? "warn" : "vio"}">${s.paused ? "Paused" : PHASE_LABEL[phase] ?? phase}</span>${isCur() ? '<span class="pill teal">You are the curator</span>' : ""}</div>
    <p class="mut">Curator ${addrLink(s.curator)} · beneficiary ${addrLink(s.beneficiary)}</p>
    <div class="grid g2" style="margin:22px 0"><div class="card"><h3>Rules of this slot</h3><ol style="margin:0;padding-inline-start:20px">${s.rules.map((r) => `<li>${esc(r)}</li>`).join("")}</ol><p class="hint">The AI gate checks every message against each of these rules. It never sees prices.</p></div>
    <div class="card"><h3>Terms</h3><div class="kv"><div><small>Deposit (highest price)</small><b>${gen(s.max_bid)}</b></div><div><small>Reserve</small><b>${gen(s.reserve)}</b></div><div><small>Display time</small><b>${secs(s.hold)}</b></div><div><small>Bid / review / reveal</small><b>${secs(s.bid_secs)} / ${secs(s.review_secs)} / ${secs(s.reveal_secs)}</b></div><div><small>Forfeit if not revealed</small><b>${s.forfeit_bps / 100}%</b></div><div><small>Rounds so far</small><b>${s.rounds}</b></div></div></div></div>
    ${cur.occupied ? `<div class="shown" style="margin-bottom:22px"><small>On display for another <b data-until="${cur.until}">${dur(cur.until - now)}</b> · paid ${gen(cur.price)} by ${addrLink(cur.bidder)}</small><q>“${esc(cur.creative)}”</q>${cur.link ? `<p style="margin:10px 0 0"><a style="color:#fff" href="${esc(cur.link)}" target="_blank" rel="noopener nofollow">${esc(cur.link)}</a></p>` : ""}</div>` : `<div class="empty" style="margin-bottom:22px">Nothing is on display. The next winner takes the pedestal.</div>`}
    <div class="phases" style="margin-bottom:26px">${["BID", "REVIEW", "REVEAL"].map((p, i) => `<div class="${phase === p ? "cur" : ""}"><b>${["1. Bid", "2. Review", "3. Reveal"][i]}</b><p class="mut sm" style="margin:6px 0 0">${["Commit to a secret price, lock the deposit.", "The AI gate and the curator read every message. No price is visible.", "Cleared bidders show their price. Highest wins, pays the second price."][i]}</p>${phase === p && st.ends_at ? `<p style="margin:8px 0 0" class="sm"><b data-until="${st.ends_at}">${dur(st.ends_at - now)}</b> left</p>` : ""}</div>`).join("")}</div>
    ${phase === "IDLE" && st.opens_at ? `<p class="mut">The next round can open in <b data-until="${st.opens_at}">${dur(st.opens_at - now)}</b>.</p>` : ""}
    <div id="bidbox"></div>
    <h2 style="margin-top:38px">Bids in the latest round</h2><div id="bids">${bids.length ? bids.map(bidHtml).join("") : '<div class="empty">No bids yet.</div>'}</div>
    <div class="cta" id="roundActs">${roundActs(L, phase)}</div>
    ${isCur() ? `<div class="card" style="margin-top:30px"><h3>Curator tools</h3><div class="cta" style="margin:0"><button class="btn" data-act="pause">${s.paused ? "Allow new bids again" : "Pause new bids"}</button><button class="btn" data-act="benef">Change beneficiary</button></div><p class="hint">A running round always goes on to its end, so no money gets stuck.</p></div>` : ""}
    <h2 style="margin-top:38px">Round history</h2>${rounds.length ? `<div class="card tw"><table><tr><th>Round</th><th>Stage</th><th>Bids</th><th>Revealed</th><th>Price</th><th>Opened</th></tr>${rounds.map((r) => `<tr><td>#${r.index + 1}</td><td><span class="pill">${STAGE[r.stage]}</span> ${r.note ? `<span class="sm mut">${esc(r.note)}</span>` : ""}</td><td>${r.bids}</td><td>${r.valid}</td><td>${r.winner >= 0 ? gen(r.price) : "-"}</td><td class="sm">${when(r.opened)}</td></tr>`).join("")}</table></div>` : '<div class="empty">No rounds yet.</div>'}`;
    if (keep) { /* the form lives in its own node so typing is never lost by a refresh */ $("#bidbox").replaceWith(keep); } else { formKey = key; bidForm(); }
    wire(); tick();
  }
  function bidHtml(b) {
    const phase = S.rounds[0]?.phase, r = b.review, isMine = mine(b.bidder), now = clock.now(), L = S.rounds[0];
    const half = L.bid_end + (L.review_end - L.bid_end) / 2, a = [];
    if (phase === "REVIEW" && b.gate === 0) { a.push(`<button class="btn sm" data-act="screen" data-id="${b.id}">Ask the AI gate</button>`); if (now >= half) a.push(`<button class="btn sm" data-act="escalate" data-id="${b.id}">Hand to curator</button>`); }
    if (phase === "REVIEW" && b.gate === 3 && isMine && !b.appealed) a.push(`<button class="btn sm" data-act="appeal" data-id="${b.id}">Appeal once</button>`);
    if (phase === "REVEAL" && b.gate === 1 && isMine && !b.revealed) a.push(`<button class="btn sm pri" data-act="reveal" data-id="${b.id}">Reveal my price</button>`);
    if (phase === "REVIEW" && isCur()) { if (b.gate === 2) a.push(`<button class="btn sm" data-act="clear" data-id="${b.id}">Clear</button>`); if ([0, 1, 2].includes(b.gate)) a.push(`<button class="btn sm dng" data-act="veto" data-id="${b.id}">Veto</button>`); }
    return `<div class="bid"><div class="top"><b>Bid #${b.id}</b><span class="pill ${GATE_CLS[b.gate]}">${GATE[b.gate]}${b.gate && b.by === 1 ? " by AI" : b.by === 2 ? " by curator" : ""}</span>${isMine ? '<span class="pill teal">yours</span>' : ""}${b.revealed ? `<span class="pill vio">price ${gen(b.amount)}</span>` : ""}${b.outcome ? `<span class="pill ${b.outcome === 1 ? "ok" : ""}">${OUT[b.outcome]}</span>` : ""}<span class="mut sm">${addrLink(b.bidder)}</span></div>
    <div>“${esc(b.creative)}”${b.link ? ` <a class="sm" href="${esc(b.link)}" target="_blank" rel="noopener nofollow">${esc(b.link)}</a>` : ""}</div>
    ${r?.reason ? `<div class="sm mut">Gate: ${esc(r.reason)}${r.marks?.length ? ` · marks ${esc(r.marks.join(","))} (0 meets, 1 unsure, 2 breaks)` : ""}</div>` : ""}${b.appeal_note ? `<div class="sm mut">Appeal note: ${esc(b.appeal_note)}</div>` : ""}${b.veto_note ? `<div class="sm mut">Veto note: ${esc(b.veto_note)}</div>` : ""}${b.outcome ? `<div class="sm mut">Refunded ${gen(b.refunded)}${b.forfeited !== "0" ? ` · forfeited ${gen(b.forfeited)}` : ""}${b.paid !== "0" ? ` · paid ${gen(b.paid)}` : ""}</div>` : ""}${a.length ? `<div class="acts">${a.join("")}</div>` : ""}</div>`;
  }
  function roundActs(L, phase) {
    if (!L) return ""; const out = [];
    if (L.stage === 0 && phase === "SETTLE") out.push(`<button class="btn grad" data-act="settle">Settle this round</button>`);
    if (L.stage === 1 && clock.now() >= L.shown_until) out.push(`<button class="btn pri" data-act="release" data-id="${L.id}">Release the price to the beneficiary</button>`);
    if (L.stage === 1 && clock.now() < L.shown_until && isCur()) out.push(`<button class="btn dng" data-act="takedown" data-id="${L.id}">Take the display down</button>`);
    return out.join("");
  }
  function bidForm() {
    const { slot: s, st } = S, box = $("#bidbox"); let why = "";
    if (!W.account) why = `<button class="btn pri" id="bc">Connect a wallet to bid</button>`;
    else if (mine(s.curator) || mine(s.beneficiary)) why = "The curator and the beneficiary cannot bid on their own slot.";
    else if (s.paused) why = "This slot is paused. No new bids are accepted.";
    else if (!st.can_bid) why = "Bidding is closed right now. A new round opens with the first bid after the previous one is settled.";
    if (why) { box.innerHTML = `<div class="card"><h3>Place a sealed bid</h3><p class="mut" style="margin:0">${why}</p></div>`; $("#bc") && ($("#bc").onclick = openWalletModal); return; }
    box.innerHTML = `<form class="card" id="bidForm"><h3>Place a sealed bid</h3><p class="mut sm" style="margin-top:0">You lock <b>${gen(s.max_bid)}</b> as a deposit. Your price stays secret until the reveal phase; whatever you do not pay comes back when the round settles.</p>
    <label for="cr">Your message <span class="mut">(8–280 characters)</span></label><textarea id="cr" minlength="8" maxlength="280" required placeholder="What should stand on the pedestal?"></textarea>
    <label for="lk">Link <span class="mut">(optional, public http/https address)</span></label><input id="lk" type="url" placeholder="https://example.com">
    <label for="pr">Your secret price in GEN <span class="mut">(${gen(s.reserve)} to ${gen(s.max_bid)})</span></label><input id="pr" required inputmode="decimal" placeholder="${gen(s.reserve).replace(" GEN", "")}">
    <p class="hint">Highest price wins and pays the <b>second-highest</b> price, so bidding what the turn is truly worth is the best move. The price and a random salt are kept in this browser, so you can reveal later. Back them up on the <a href="account.html">My Plinth</a> page.</p>
    <button class="btn grad" style="margin-top:12px">Lock deposit and bid</button></form>`;
    $("#bidForm").onsubmit = async (e) => {
      e.preventDefault(); let wei;
      try { wei = parseEther($("#pr").value.trim()); } catch { return toast("Enter the price as a number, for example 0.05", true); }
      if (wei < BigInt(s.reserve) || wei > BigInt(s.max_bid)) return toast(`The price must be between ${gen(s.reserve)} and ${gen(s.max_bid)}.`, true);
      const salt = newSalt(), commit = commitment(id, W.account, wei, salt);
      secrets.put(commit, { slot: id, bidder: lc(W.account), amount: wei.toString(), salt, at: Date.now() });
      run(() => send("bid", [id, $("#cr").value.trim(), $("#lk").value.trim(), commit], { value: BigInt(s.max_bid), title: "Placing your sealed bid" }), () => { formKey = ""; return reload(); });
    };
  }
  function wire() {
    $$("[data-act]", root).forEach((b) => (b.onclick = () => act(b.dataset.act, +b.dataset.id)));
  }
  async function act(a, bid) {
    const go = (fn, args, title) => run(() => send(fn, args, { title }), reload);
    if (a === "screen") return go("screen", [bid], "The AI gate is reading the message");
    if (a === "escalate") return go("escalate", [bid], "Handing the bid to the curator");
    if (a === "settle") return go("settle", [id], "Settling the round");
    if (a === "release") return go("release", [bid], "Releasing the price");
    if (a === "clear") return go("clear", [bid], "Clearing the bid");
    if (a === "pause") return go("set_paused", [id, !S.slot.paused], S.slot.paused ? "Allowing bids again" : "Pausing the slot");
    if (a === "appeal" || a === "veto" || a === "takedown") {
      const v = await ask({ title: { appeal: "Appeal the refusal", veto: "Veto this bid", takedown: "Take the display down" }[a], note: a === "appeal" ? "Say why the message complies. This is an argument, not an instruction; notes that try to instruct the reader are rejected." : "The note is public.", fields: [{ name: "note", label: "Note (8–200 characters)", area: true, min: 8, max: 200 }] });
      if (v) go(a, [bid, v.note.trim()], "Sending");
      return;
    }
    if (a === "benef") { const v = await ask({ title: "Change beneficiary", note: "Applies to rounds that open from now on. Leave the address empty to use the curator.", fields: [{ name: "who", label: "Address (0x…)" }] }); if (v) go("set_beneficiary", [id, v.who.trim()], "Changing beneficiary"); return; }
    if (a === "reveal") {
      const b = S.bids.find((x) => x.id === bid); let sec = secrets.get(b.commit);
      if (!sec) { const v = await ask({ title: "Reveal your price", note: "This browser has no record of this bid. Enter the price and the salt you used.", fields: [{ name: "price", label: "Price in GEN" }, { name: "salt", label: "Salt" }] }); if (!v) return; try { sec = { amount: parseEther(v.price.trim()).toString(), salt: v.salt.trim() }; } catch { return toast("That price is not a number.", true); } }
      if (commitment(b.slot, b.bidder, BigInt(sec.amount), sec.salt) !== b.commit) return toast("That price and salt do not match your commitment.", true);
      return go("reveal", [bid, BigInt(sec.amount), sec.salt], "Revealing your price");
    }
  }
  window.addEventListener("plinth:wallet", () => S && draw());
  await load(); setInterval(() => { if (!$(".ov") && !$("#bidForm textarea:focus,#bidForm input:focus")) load(); }, 20000);
};

/* ---------- create a slot ---------- */
pages.create = () => {
  const f = $("#createForm"), U = { 60: "minutes", 3600: "hours", 86400: "days" };
  $$("select.unit").forEach((s) => (s.innerHTML = Object.entries(U).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")));
  $("#demo").onclick = () => { const set = (n, v) => (f.elements[n].value = v); set("name", "Plinth demo wall"); set("rules", "No insults, hate or harassment\nNo promotion of gambling or adult content\nNo misleading claims about money or health"); set("max", "0.05"); set("reserve", "0.005"); set("hold", 5); set("bid", 2); set("review", 3); set("reveal", 2); set("forfeit", 10); };
  f.onsubmit = async (e) => {
    e.preventDefault(); const g = (n) => f.elements[n].value.trim(), span = (n) => Math.round(+g(n) * +f.elements[n + "u"].value);
    let max, res; try { max = parseEther(g("max")); res = parseEther(g("reserve")); } catch { return toast("Prices must be numbers.", true); }
    const rules = g("rules").split("\n").map((x) => x.trim()).filter(Boolean);
    if (rules.length < 1 || rules.length > 5 || rules.some((r) => r.length < 8 || r.length > 140 || r.includes("|"))) return toast("Give 1 to 5 rules, 8 to 140 characters each, one per line (no | sign).", true);
    if (g("name").length < 3 || g("name").length > 60) return toast("The name needs 3 to 60 characters.", true);
    if (max < 10n ** 15n || res < 10n ** 15n || res > max) return toast("Prices start at 0.001 GEN and the reserve cannot exceed the highest bid.", true);
    const hold = span("hold"), spans = [span("bid"), span("review"), span("reveal")], fb = Math.round(+g("forfeit") * 100);
    if (hold < 60 || hold > 2592000 || spans.some((x) => x < 60 || x > 1209600)) return toast("Display time: 1 minute to 30 days. Each phase: 1 minute to 14 days.", true);
    if (fb < 500 || fb > 5000) return toast("The forfeit must be between 5% and 50%.", true);
    try {
      await send("create_slot", [g("name"), rules.join("|"), max, res, hold, ...spans, fb, g("benef")], { title: "Opening your slot" });
      const mineSlots = await read("slots_of", [W.account, 0, 1]); toast("Slot created"); location.href = `slot.html?id=${mineSlots[0]?.id ?? ""}`;
    } catch { /* shown */ }
  };
};

/* ---------- account ---------- */
pages.account = async () => {
  const root = $("#acct");
  async function draw() {
    if (!W.account) return (root.innerHTML = `<div class="empty"><p>Connect a wallet to see your slots, bids and saved secrets.</p><button class="btn pri" id="c2">Connect wallet</button></div>`, $("#c2").onclick = openWalletModal);
    root.innerHTML = loading();
    try {
      const [bal, slots, bids] = await Promise.all([balanceOf(W.account), read("slots_of", [W.account, 0, 50]), read("bids_of", [W.account, 0, 50])]);
      const sec = secrets.all();
      root.innerHTML = `<div class="grid g3"><div class="card stat"><b>${gen(bal)}</b><span>Balance of ${addrLink(W.account)}</span></div><div class="card stat"><b>${slots.length}</b><span>Slots you curate</span></div><div class="card stat"><b>${bids.length}</b><span>Bids you placed</span></div></div>
      <div class="card" style="margin-top:18px"><h3>Test GEN</h3><p class="mut" style="margin-top:0">Studionet is a test network. The faucet tops this account up with 100 GEN.</p><button class="btn pri" id="fc">Get 100 test GEN</button></div>
      <h2 style="margin-top:34px">Your bids</h2>${bids.length ? bids.map((b) => `<a class="card lnk" style="display:block;margin-bottom:12px" href="slot.html?id=${b.slot}"><div style="display:flex;gap:8px;flex-wrap:wrap"><b>Bid #${b.id} on slot #${b.slot}</b><span class="pill ${GATE_CLS[b.gate]}">${GATE[b.gate]}</span>${b.outcome ? `<span class="pill ${b.outcome === 1 ? "ok" : ""}">${OUT[b.outcome]}</span>` : ""}${secrets.get(b.commit) ? '<span class="pill teal">secret saved here</span>' : '<span class="pill warn">secret not in this browser</span>'}</div><p class="mut" style="margin:6px 0 0">“${esc(b.creative)}”</p></a>`).join("") : '<div class="empty">No bids yet.</div>'}
      <h2 style="margin-top:34px">Your slots</h2>${slots.length ? `<div class="grid g3">${slots.map((s) => `<a class="card lnk" href="slot.html?id=${s.id}"><h3>${esc(s.name)}</h3><p class="mut sm" style="margin:0">Slot #${s.id} · ${s.rounds} rounds</p></a>`).join("")}</div>` : '<div class="empty">You have not opened a slot. <a href="create.html">Create one.</a></div>'}
      <div class="card" style="margin-top:34px"><h3>Secret prices (${Object.keys(sec).length})</h3><p class="mut" style="margin-top:0">Prices and salts live only in this browser. Without them you cannot reveal, and a cleared bid that never reveals loses part of its deposit. Export a backup and import it on another device.</p><div class="cta" style="margin:0"><button class="btn" id="ex">Export backup</button><label class="btn" style="margin:0">Import backup<input id="im" type="file" accept="application/json" hidden></label></div></div>`;
      $("#fc").onclick = async (e) => { e.target.disabled = true; try { await faucet(W.account); toast("100 GEN added"); draw(); } catch (er) { toast(er.message, true); e.target.disabled = false; } };
      $("#ex").onclick = () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(secrets.all(), null, 2)], { type: "application/json" })); a.download = "plinth-secrets.json"; a.click(); };
      $("#im").onchange = async (e) => { try { const o = JSON.parse(await e.target.files[0].text()); secrets.replace({ ...secrets.all(), ...o }); toast("Backup imported"); draw(); } catch { toast("That file is not a Plinth backup.", true); } };
    } catch (e) { fail(root, e); }
  }
  window.addEventListener("plinth:wallet", draw); draw();
};

await pages[document.body.dataset.page]?.();
