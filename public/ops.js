/* Daily operations screens: the Cash and Buying tabs, plus the books and reminder panels
   in Store. The server holds every rule (lib/ops.js); these screens show what it decides. */
"use strict";
(() => {
const { S, $, $$, esc, P, fmtDate, fmtStamp, today, addDays, status, head, show, back, toast, errMsg, guarded, armed, render, activeDealers, r2, METHODS } = window.LedgerUI;
const call = (m, u, b) => window.APP.call(m, u, b);
const near = (a, b) => Math.abs(a - b) <= 0.004;
const peso = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + P(Math.abs(n));
const dealerName = (id) => (S.dealers.get(id) || {}).name || "Unknown dealer";
const isOwner = () => !!S.acct && S.acct.role === "owner";
const rows = (m) => [...m.entries()];
const panel = (title, body, side = "") => `<section class="panel"><div class="panel-head"><h2>${title}</h2>${side}</div>${body}</section>`;
const table = (head, body) => `<div class="tbl-wrap"><table class="ops-tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
const none = (t) => `<p class="small muted" style="margin:0">${t}</p>`;
const num = (id, v = "", extra = "") => `<input id="${id}" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(v)}" ${extra}>`;

/* ---------- counts shown on the overview ---------- */
function unclosedDays() {
  const t0 = today(), days = new Set();
  S.txns.forEach((t) => { if (t.type === "payment" && !t.voided && t.date < t0 && t.date >= addDays(t0, -14)) days.add(t.date); });
  return [...days].filter((d) => (S.cashcloses.get(d) || {}).status !== "closed").sort();
}
const pendingProofs = () => rows(S.proofs).filter(([, p]) => p.status === "pending").sort((a, b) => a[1].submittedAt - b[1].submittedAt);
const pendingRemits = () => rows(S.remittances).filter(([, r]) => r.status === "pending");
const openChecks = () => rows(S.txns).filter(([, t]) => t.check && t.check.status === "pending" && !t.voided).sort((a, b) => a[1].check.date.localeCompare(b[1].check.date));
function notices() {
  if (!S.canWrite) return "";
  const out = [], days = unclosedDays(), proofs = pendingProofs().length, remits = S.canAdmin ? pendingRemits().length : 0, due = openChecks().filter(([, t]) => t.check.date <= today()).length;
  const fails = S.canAdmin ? rows(S.reminders).filter(([, r]) => r.status === "failed").length : 0;
  const note = (cls, text, label, go) => out.push(`<div class="notice ${cls}"><p>${text}</p><button class="btn sm" data-act="${go}" type="button">${label}</button></div>`);
  if (days.length) note("warn", `<b>${days.length} day${days.length === 1 ? "" : "s"} not closed yet.</b> Oldest: ${fmtDate(days[0])}.`, "Close the day", "go-cash");
  if (proofs) note("info", `<b>${proofs} proof${proofs === 1 ? "" : "s"} of payment to check.</b>`, "Review", "go-cash");
  if (remits) note("warn", `<b>${remits} remittance${remits === 1 ? "" : "s"} with a difference.</b>`, "Review", "go-cash");
  if (due) note("info", `<b>${due} check${due === 1 ? "" : "s"} ready for deposit.</b>`, "See checks", "go-cash");
  if (fails) note("warn", `<b>${fails} reminder${fails === 1 ? "" : "s"} failed to send.</b>`, "See reminders", "go-store");
  return out.join("");
}

/* ---------- Cash tab ---------- */
function myRoute() {
  const t0 = today(), soon = addDays(t0, 7), list = activeDealers().filter(([, d]) => d.collectorId === S.me).map(([id, d]) => ({ id, d, st: status(id) }))
    .filter(({ st }) => st.balance > 0 && (st.overdue > 0 || (st.nextDue && st.nextDue <= soon)))
    .sort((a, b) => (a.d.routeOrder ?? 9999) - (b.d.routeOrder ?? 9999) || b.st.overdue - a.st.overdue);
  return panel("My route today", list.length ? table(`<th>Dealer</th><th class="r">Balance</th><th class="r">Overdue</th><th></th>`, list.map(({ id, d, st }) =>
    `<tr><td><b>${esc(d.name)}</b><div class="small muted">${esc(d.area || "")}${d.phone ? ` · <a href="tel:${esc(d.phone)}">${esc(d.phone)}</a>` : ""}</div></td><td class="r num">${P(st.balance)}</td><td class="r num">${st.overdue ? P(st.overdue) : "—"}</td><td class="r"><button class="btn sm" data-act="pay-for" data-id="${esc(id)}" type="button">+ Payment</button></td></tr>`).join("")) : none("Nobody on your route is overdue or due in the next 7 days."),
    `<button class="btn sm primary" data-act="ops-remit" type="button">Hand in remittance</button>`);
}
function remitPanel() {
  const list = pendingRemits();
  if (!S.canAdmin || !list.length) return "";
  return panel("Remittances with a difference", table(`<th>Collector</th><th>Day</th><th class="r">Handed in</th><th class="r">Recorded</th><th class="r">Difference</th><th></th>`, list.map(([id, r]) =>
    `<tr><td><b>${esc(r.collectorName)}</b>${r.note ? `<div class="small muted">${esc(r.note)}</div>` : ""}</td><td class="nowrap">${fmtDate(r.date)}</td><td class="r num">${P(r.cash + r.checks)}</td><td class="r num">${P(r.expectedCash + r.expectedChecks)}</td><td class="r num"><b>${peso(r.diff)}</b></td><td class="r"><button class="btn sm" data-act="ops-remit-ok" data-id="${esc(id)}" type="button">Approve</button></td></tr>`).join("")));
}
function proofPanel() {
  const list = pendingProofs();
  return panel(`Proof of payment${list.length ? ` <span class="pill warn">${list.length}</span>` : ""}`, list.length ? table(`<th>Dealer</th><th>Paid</th><th class="r">Amount</th><th></th>`, list.map(([id, p]) =>
    `<tr><td><b>${esc(dealerName(p.dealerId))}</b>${p.refUsedOn ? `<div class="small"><span class="pill bad">Reference already used on ${esc(p.refUsedOn)}</span></div>` : ""}<div class="small">${p.photos.map((a, i) => `<a href="/_blob/${esc(a)}" target="_blank" rel="noopener">Photo ${i + 1}</a>`).join(" · ")}</div></td><td class="small">${fmtDate(p.date)} · ${esc(p.method)}${p.ref ? `<div class="muted">Ref ${esc(p.ref)}</div>` : ""}</td><td class="r num">${P(p.amount)}</td><td class="r"><div class="actions" style="justify-content:flex-end"><button class="btn sm primary" data-act="ops-proof-ok" data-id="${esc(id)}" type="button">Approve</button><button class="btn sm" data-act="ops-proof-no" data-id="${esc(id)}" type="button">Reject</button></div></td></tr>`).join("")) : none("Nothing waiting. Dealers can send receipts from their portal."));
}
function checkPanel() {
  const list = openChecks(), t0 = today();
  return panel("Checks to deposit", list.length ? table(`<th>Check date</th><th>Dealer</th><th>Check</th><th class="r">Amount</th><th></th>`, list.map(([id, t]) =>
    `<tr><td class="nowrap">${fmtDate(t.check.date)}${t.check.date > t0 ? `<div class="small"><span class="pill warn">Post-dated</span></div>` : `<div class="small"><span class="pill good">Ready</span></div>`}</td><td><b>${esc(dealerName(t.dealerId))}</b><div class="small muted">${esc(t.no || "")}</div></td><td class="small">${esc(t.check.bank)} · ${esc(t.check.number)}</td><td class="r num">${P(t.amount)}</td><td class="r"><div class="actions" style="justify-content:flex-end"><button class="btn sm" data-act="ops-check-ok" data-id="${esc(id)}" type="button">Cleared</button><button class="btn sm danger" data-act="ops-check-bad" data-id="${esc(id)}" type="button">Bounced</button></div></td></tr>`).join("")) : none("No checks waiting."));
}
function closePanel() {
  const closed = rows(S.cashcloses).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 30), days = unclosedDays();
  return panel("Daily cash close", `${days.length ? `<p class="small" style="margin-top:0">Not closed: ${days.map((d) => `<button class="btn sm" data-act="ops-close" data-id="${d}" type="button">${fmtDate(d)}</button>`).join(" ")}</p>` : ""}
    ${closed.length ? table(`<th>Day</th><th class="r">Recorded</th><th class="r">Difference</th><th>Closed by</th><th></th>`, closed.map(([d, c]) => {
      const rec = r2(Object.values(c.rows).reduce((a, r) => a + r.expected, 0));
      return `<tr><td class="nowrap">${fmtDate(d)}${c.status === "closed" ? "" : ` <span class="pill warn">Reopened</span>`}</td><td class="r num">${P(rec)}</td><td class="r num">${c.diff ? `<b>${peso(c.diff)}</b>` : "—"}</td><td class="small">${esc(c.closedByName || "")}${c.note ? `<div class="muted">${esc(c.note)}</div>` : ""}</td><td class="r">${c.status !== "closed" ? `<button class="btn sm" data-act="ops-close" data-id="${d}" type="button">Close again</button>` : isOwner() ? `<button class="btn sm" data-act="ops-reopen" data-id="${d}" type="button">Reopen</button>` : ""}</td></tr>`;
    }).join("")) : none("No days closed yet.")}`, `<button class="btn sm primary" data-act="ops-close" data-id="${today()}" type="button">Close today</button>`);
}
function collectorReport() {
  if (!S.canAdmin) return "";
  const from = today().slice(0, 8) + "01", out = new Map(), team = (S.team || []).filter((u) => u.collector);
  team.forEach((u) => out.set(u.id, { name: u.name, collected: 0, handed: 0, diff: 0, off: 0, overdue: 0 }));
  S.txns.forEach((t) => { const c = out.get(t.collectorId); if (c && t.type === "payment" && !t.voided && t.date >= from) c.collected = r2(c.collected + t.amount); });
  rows(S.remittances).forEach(([, r]) => { const c = out.get(r.collectorId); if (c && r.date >= from) { c.handed = r2(c.handed + r.cash + r.checks); c.diff = r2(c.diff + r.diff); if (!near(r.diff, 0)) c.off++; } });
  S.dealers.forEach((d, id) => { const c = out.get(d.collectorId); if (c) c.overdue = r2(c.overdue + status(id).overdue); });
  if (!out.size) return "";
  return panel("Collectors this month", table(`<th>Collector</th><th class="r">Collected</th><th class="r">Handed in</th><th class="r">Differences</th><th class="r">Collection rate</th>`, [...out.values()].map((c) => {
    const base = c.collected + c.overdue;
    return `<tr><td><b>${esc(c.name)}</b></td><td class="r num">${P(c.collected)}</td><td class="r num">${P(c.handed)}</td><td class="r num">${c.off ? `${c.off} · ${peso(c.diff)}` : "—"}</td><td class="r num">${base ? Math.round((c.collected / base) * 100) + "%" : "—"}</td></tr>`;
  }).join("")) + `<p class="small muted" style="margin-bottom:0">Collection rate = collected ÷ (collected + still overdue on their route).</p>`);
}
function vCash() {
  if (!S.canWrite) return panel("Cash", none("Daily cash work is for the store team."));
  return `<div class="stack">${S.acct && S.acct.collector ? myRoute() : ""}${remitPanel()}<div class="grid2e"><div class="stack">${closePanel()}</div><div class="stack">${proofPanel()}${checkPanel()}</div></div>${collectorReport()}</div>`;
}

async function closeDay(date) {
  let day;
  try { day = await call("GET", "/api/cash/day/" + date); } catch (e) { toast(errMsg(e), "error"); return; }
  const remits = day.remittances.map((r) => `<li>${esc(r.data.collectorName)}: ${P(r.data.cash + r.data.checks)}${near(r.data.diff, 0) ? "" : ` (difference ${peso(r.data.diff)})`}</li>`).join("");
  show(() => [head(`Close ${fmtDate(date)}`, "Count what you actually have, then compare it with what was recorded.") + `<form id="f" class="form-grid">
    ${METHODS.map((m) => `<label class="f">${esc(m)}<span class="hint">Recorded ${P(day.expected[m] || 0)}</span>${num("c-" + m.replace(/\s/g, "_"), day.expected[m] ? "" : "0", `data-m="${esc(m)}"`)}<span class="hint" data-diff="${esc(m)}"></span></label>`).join("")}
    <p class="span" id="c-total"></p>
    ${remits ? `<div class="f span"><span>Collector remittances included</span><ul class="small" style="margin:4px 0">${remits}</ul></div>` : ""}
    <label class="f span">Note<textarea id="c-note" maxlength="500" placeholder="Needed if the count doesn't match"></textarea></label>
    <div class="actions span"><button class="btn primary" type="submit">Close this day</button><button class="btn" type="button" data-back>Cancel</button></div></form>`, (sh) => {
    const inputs = $$("input[data-m]", sh);
    const refresh = () => { let total = 0; inputs.forEach((i) => { const m = i.dataset.m, d = r2((Number(i.value) || 0) - (day.expected[m] || 0)); total = r2(total + d); $(`[data-diff="${m}"]`, sh).textContent = i.value === "" ? "" : near(d, 0) ? "Matches" : `Difference ${peso(d)}`; }); $("#c-total", sh).innerHTML = `<b>Overall difference: ${near(total, 0) ? "none" : peso(total)}</b>`; };
    inputs.forEach((i) => i.addEventListener("input", refresh)); refresh();
    $("#f", sh).addEventListener("submit", (e) => { e.preventDefault(); const counted = Object.fromEntries(inputs.map((i) => [i.dataset.m, Number(i.value) || 0]));
      guarded(e.submitter, async () => { await call("POST", "/api/cash/close", { date, counted, note: $("#c-note", sh).value }); toast(`${fmtDate(date)} closed`); back(); }); });
  }]);
}
function reasonSheet(title, sub, label, go, extra = "") {
  show(() => [head(title, sub) + `<form id="f" class="form-grid">${extra}<label class="f span">${label}<textarea id="r-why" required maxlength="300"></textarea></label><div class="actions span"><button class="btn primary" type="submit">Confirm</button><button class="btn" type="button" data-back>Cancel</button></div></form>`, (sh) => {
    $("#f", sh).addEventListener("submit", (e) => { e.preventDefault(); guarded(e.submitter, async () => { await go($("#r-why", sh).value.trim(), sh); back(); }); });
  }]);
}
function remitForm() {
  const date = today(), mine = rows(S.txns).filter(([, t]) => t.type === "payment" && !t.voided && t.date === date && t.collectorId === S.me).map(([, t]) => t);
  const sum = (m) => r2(mine.filter((t) => t.method === m).reduce((a, t) => a + t.amount, 0));
  show(() => [head("Hand in remittance", fmtDate(date)) + `<form id="f" class="form-grid">
    <label class="f">Cash counted<span class="hint">Recorded ${P(sum("Cash"))}</span>${num("m-cash", "", "required")}</label>
    <label class="f">Checks handed over<span class="hint">Recorded ${P(sum("Check"))}</span>${num("m-chk", sum("Check") ? "" : "0", "required")}</label>
    <label class="f span">Note<textarea id="m-note" maxlength="500"></textarea></label>
    <div class="actions span"><button class="btn primary" type="submit">Hand in</button><button class="btn" type="button" data-back>Cancel</button></div></form>`, (sh) => {
    $("#f", sh).addEventListener("submit", (e) => { e.preventDefault(); guarded(e.submitter, async () => {
      const r = await call("POST", "/api/remittances", { date, cash: Number($("#m-cash", sh).value), checks: Number($("#m-chk", sh).value), note: $("#m-note", sh).value });
      toast(r.data.status === "matched" ? "Remittance matches. Thank you!" : `Sent for approval. Difference ${peso(r.data.diff)}`); back(); }); });
  }]);
}

/* ---------- Buying tab ---------- */
const PO_L = { draft: "Draft", ordered: "Ordered", partial: "Partly received", received: "Received", cancelled: "Cancelled" };
const PO_C = { draft: "neutral", ordered: "warn", partial: "warn", received: "good", cancelled: "bad" };
function vBuying() {
  if (!S.canWrite) return panel("Buying", none("Purchasing is for the store team."));
  const q = (S.supQ || "").toLowerCase(), sup = rows(S.suppliers).filter(([, s]) => (S.supAll || s.active !== false) && [s.name, s.contact, s.phone].join(" ").toLowerCase().includes(q)).sort((a, b) => a[1].name.localeCompare(b[1].name));
  const pos = rows(S.purchases).sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
  const bills = pos.flatMap(([, p]) => (p.receipts || []).filter((r) => r.invoice).map((r) => ({ p, inv: r.invoice }))).sort((a, b) => String(a.inv.dueDate || "9").localeCompare(String(b.inv.dueDate || "9")));
  return `<div class="stack">${panel("Purchase orders", pos.length ? table(`<th>No.</th><th>Supplier</th><th>Ordered</th><th>Status</th><th class="r">Outstanding</th><th></th>`, pos.map(([id, p]) => {
    const left = p.lines.reduce((a, l) => a + l.qty - (l.received || 0), 0), open = ["ordered", "partial"].includes(p.status);
    return `<tr><td><b>${esc(p.no)}</b></td><td>${esc((S.suppliers.get(p.supplierId) || {}).name || "")}</td><td class="nowrap">${fmtDate(p.date)}</td><td><span class="pill ${PO_C[p.status]}">${PO_L[p.status]}</span></td><td class="r num">${p.status === "cancelled" ? "—" : left}</td><td class="r"><div class="actions" style="justify-content:flex-end">${open ? `<button class="btn sm primary" data-act="ops-receive" data-id="${esc(id)}" type="button">Receive</button>` : ""}${S.canAdmin && ["draft", "ordered"].includes(p.status) ? `<button class="btn sm" data-act="ops-po" data-id="${esc(id)}" type="button">Edit</button>` : ""}</div></td></tr>`;
  }).join("")) : none("No purchase orders yet."), S.canAdmin ? `<button class="btn sm primary" data-act="ops-po" type="button">+ Purchase order</button>` : "")}
  ${bills.length ? panel("Supplier invoices", table(`<th>Invoice</th><th>Supplier</th><th>Due</th><th class="r">Amount</th>`, bills.map(({ p, inv }) => `<tr><td><b>${esc(inv.no)}</b><div class="small muted">${esc(p.no)}</div></td><td>${esc((S.suppliers.get(p.supplierId) || {}).name || "")}</td><td class="nowrap">${inv.dueDate ? fmtDate(inv.dueDate) : "—"}</td><td class="r num">${P(inv.amount)}</td></tr>`).join(""))) : ""}
  ${panel("Suppliers", `<div class="actions" style="margin-bottom:10px"><input id="sup-q" type="search" placeholder="Search suppliers" aria-label="Search suppliers" value="${esc(S.supQ || "")}" style="flex:1;min-width:160px"><label class="chk"><input type="checkbox" data-act="ops-sup-all" ${S.supAll ? "checked" : ""}> Show archived</label></div>
    ${sup.length ? table(`<th>Supplier</th><th>Contact</th><th class="r">Terms</th><th></th>`, sup.map(([id, s]) => `<tr><td><b>${esc(s.name)}</b>${s.active === false ? ` <span class="pill neutral">Archived</span>` : ""}</td><td class="small">${esc(s.contact)}${s.phone ? ` · ${esc(s.phone)}` : ""}</td><td class="r num">${s.terms} days</td><td class="r">${S.canAdmin ? `<button class="btn sm" data-act="ops-sup" data-id="${esc(id)}" type="button">Edit</button>` : ""}</td></tr>`).join("")) : none("No suppliers to show.")}`, S.canAdmin ? `<button class="btn sm primary" data-act="ops-sup" type="button">+ Supplier</button>` : "")}</div>`;
}
function supplierForm(id) {
  const s = id ? S.suppliers.get(id) : { name: "", contact: "", phone: "", address: "", terms: 30, notes: "" };
  show(() => [head(id ? "Edit supplier" : "New supplier") + `<form id="f" class="form-grid">
    <label class="f span">Name<input id="v-name" required maxlength="120" value="${esc(s.name)}"></label>
    <label class="f">Contact person<input id="v-contact" maxlength="120" value="${esc(s.contact)}"></label>
    <label class="f">Phone<input id="v-phone" maxlength="40" value="${esc(s.phone)}"></label>
    <label class="f">Payment terms (days)<input id="v-terms" type="number" min="0" step="1" value="${esc(s.terms)}"></label>
    <label class="f span">Address<textarea id="v-addr" maxlength="300">${esc(s.address)}</textarea></label>
    <label class="f span">Notes<textarea id="v-notes" maxlength="1000">${esc(s.notes)}</textarea></label>
    ${id ? `<label class="chk span"><input type="checkbox" id="v-active" ${s.active !== false ? "checked" : ""}> Active</label>` : ""}
    <div class="actions span"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-back>Cancel</button></div></form>`, (sh) => {
    $("#f", sh).addEventListener("submit", (e) => { e.preventDefault(); const data = { name: $("#v-name", sh).value, contact: $("#v-contact", sh).value, phone: $("#v-phone", sh).value, terms: Number($("#v-terms", sh).value), address: $("#v-addr", sh).value, notes: $("#v-notes", sh).value, active: id ? $("#v-active", sh).checked : true };
      guarded(e.submitter, async () => { await call("PUT", "/api/c/suppliers/" + (id || window.APP.newId()), { data }); toast("Supplier saved"); back(); }); });
  }]);
}
function poForm(id) {
  const p = id ? S.purchases.get(id) : null, sup = rows(S.suppliers).filter(([, s]) => s.active !== false), prods = rows(S.products).filter(([, x]) => x.active !== false).sort((a, b) => a[1].name.localeCompare(b[1].name));
  if (!sup.length) { toast("Add a supplier first"); return; }
  const lineRow = (l = {}) => `<div class="form-grid po-line span"><label class="f">Product<select data-l="p"><option value="">Choose…</option>${prods.map(([k, x]) => `<option value="${esc(k)}" data-cost="${esc(x.cost ?? "")}" ${l.productId === k ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label><label class="f">Quantity<input data-l="q" type="number" min="1" step="1" value="${esc(l.qty ?? "")}"></label><label class="f">Cost each (₱)<input data-l="c" type="number" min="0" step="0.01" value="${esc(l.cost ?? "")}"></label></div>`;
  show(() => [head(p ? `Edit ${esc(p.no)}` : "New purchase order") + `<form id="f" class="form-grid">
    <label class="f span">Supplier<select id="o-sup" required><option value="">Choose…</option>${sup.map(([k, s]) => `<option value="${esc(k)}" ${p && p.supplierId === k ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
    <label class="f">Order date<input id="o-date" type="date" required value="${esc(p ? p.date : today())}"></label>
    <label class="f">Expected<input id="o-exp" type="date" value="${esc((p && p.expected) || "")}"></label>
    <div class="span" id="o-lines">${(p ? p.lines : [{}]).map(lineRow).join("")}</div>
    <div class="actions span"><button class="btn sm" id="o-add" type="button">+ Another product</button><b id="o-total" class="num"></b></div>
    <label class="f span">Note<textarea id="o-note" maxlength="500">${esc((p && p.note) || "")}</textarea></label>
    <div class="actions span"><button class="btn primary" type="submit" value="ordered">Save as ordered</button><button class="btn" type="submit" value="draft">Save as draft</button>${p ? `<button class="btn danger" type="button" id="o-cancel" style="margin-left:auto">Cancel this order</button>` : `<button class="btn" type="button" data-back>Cancel</button>`}</div></form>`, (sh) => {
    const lines = () => $$(".po-line", sh).map((r) => ({ productId: $("[data-l=p]", r).value, qty: Number($("[data-l=q]", r).value), cost: Number($("[data-l=c]", r).value) })).filter((l) => l.productId);
    const sum = () => { $("#o-total", sh).textContent = "Total " + P(lines().reduce((a, l) => a + l.qty * l.cost, 0)); }; sum();
    $("#o-lines", sh).addEventListener("input", (e) => { if (e.target.dataset.l === "p") { const c = e.target.selectedOptions[0].dataset.cost, inp = $("[data-l=c]", e.target.closest(".po-line")); if (c && !inp.value) inp.value = c; } sum(); });
    $("#o-add", sh).addEventListener("click", () => $("#o-lines", sh).insertAdjacentHTML("beforeend", lineRow()));
    const c = $("#o-cancel", sh); if (c) c.addEventListener("click", () => { if (armed(c, "Tap again to cancel")) guarded(c, async () => { await call("PUT", "/api/c/purchases/" + id, { data: { ...p, status: "cancelled" } }); toast("Purchase order cancelled"); back(); }); });
    $("#f", sh).addEventListener("submit", (e) => { e.preventDefault(); const data = { supplierId: $("#o-sup", sh).value, date: $("#o-date", sh).value, expected: $("#o-exp", sh).value, lines: lines(), note: $("#o-note", sh).value, status: e.submitter.value };
      guarded(e.submitter, async () => { const r = await call("PUT", "/api/c/purchases/" + (id || window.APP.newId()), { data }); toast(`${r.data.no} saved`); back(); }); });
  }]);
}
function receiveForm(id) {
  const p = S.purchases.get(id), open = p.lines.filter((l) => l.qty > (l.received || 0));
  show(() => [head(`Receive ${esc(p.no)}`, "Enter what actually arrived. The rest stays outstanding.") + `<form id="f" class="form-grid">
    <label class="f">Date received<input id="g-date" type="date" required max="${today()}" value="${today()}"></label>
    <label class="f">Delivery reference<input id="g-ref" maxlength="80"></label>
    ${open.map((l) => `<label class="f span">${esc(l.name)}<span class="hint">Outstanding ${l.qty - (l.received || 0)}</span><input type="number" min="0" max="${l.qty - (l.received || 0)}" step="1" data-p="${esc(l.productId)}" value="${l.qty - (l.received || 0)}"></label>`).join("")}
    <h3 class="span form-sec">Supplier invoice (optional)</h3>
    <label class="f">Invoice no.<input id="g-inv" maxlength="80"></label>
    <label class="f">Amount (₱)${num("g-amt")}</label>
    <label class="f">Due date<input id="g-due" type="date"></label>
    <div class="actions span"><button class="btn primary" type="submit">Receive goods</button><button class="btn" type="button" data-back>Cancel</button></div></form>`, (sh) => {
    $("#f", sh).addEventListener("submit", (e) => { e.preventDefault(); const lines = $$("[data-p]", sh).map((i) => ({ productId: i.dataset.p, qty: Number(i.value) || 0 }));
      guarded(e.submitter, async () => { await call("POST", `/api/purchases/${id}/receive`, { date: $("#g-date", sh).value, ref: $("#g-ref", sh).value, lines, invoice: { no: $("#g-inv", sh).value, amount: Number($("#g-amt", sh).value) || 0, dueDate: $("#g-due", sh).value } }); toast("Goods received and stock updated"); back(); }); });
  }]);
}

/* ---------- Store panels ---------- */
function booksPanel() {
  const s = S.settings, log = (s.periodLog || []).slice(-5).reverse();
  return panel("Close the books", `<p class="small" style="margin-top:0">${s.closedThrough ? `Closed through <b>${fmtDate(s.closedThrough)}</b>. Records on or before that date can't be added, changed or voided. Corrections go in as adjustments dated after it.` : "No period is closed yet. Closing stops anyone changing records you have already reported."}</p>
    ${S.canAdmin ? `<div class="actions"><button class="btn sm primary" data-act="ops-books-close" type="button">Close a period</button>${s.closedThrough ? `<button class="btn sm" data-act="ops-books-open" type="button">Reopen</button>` : ""}</div>` : ""}
    ${log.length ? `<ul class="small muted" style="margin-bottom:0">${log.map((e) => `<li>${e.action === "close" ? `Closed through ${fmtDate(e.through)}` : `Reopened${e.through ? ` back to ${fmtDate(e.through)}` : ""}: ${esc(e.reason)}`} · ${esc(e.byName || "")}, ${fmtStamp(e.at)}</li>`).join("")}</ul>` : ""}`);
}
function reminderPanel() {
  if (!S.canAdmin) return "";
  const r = S.settings.reminders || {}, log = rows(S.reminders).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 12);
  return panel("Automatic payment reminders", `<form id="remForm" class="form-grid">
    <label class="chk span"><input type="checkbox" id="rm-on" ${r.enabled ? "checked" : ""}> Send reminders automatically</label>
    <label class="f span">When, in days from the due date<input id="rm-days" value="${esc((r.days || [-3, 0, 7]).join(", "))}"><span class="hint">−3 is 3 days before, 0 is the due date, 7 is 7 days overdue.</span></label>
    <label class="f span">Message<textarea id="rm-msg" maxlength="400" placeholder="Leave blank for the standard message">${esc(S.settings.reminderAuto || "")}</textarea><span class="hint">You can use {name}, {amount}, {due}, {store} and {contact}.</span></label>
    <div class="actions span"><button class="btn sm primary" type="submit">Save</button><button class="btn sm" data-act="ops-rem-run" type="button">Send due reminders now</button></div></form>
    ${log.length ? `<h3 style="font-size:14px;margin:14px 0 6px">Recent reminders</h3>` + table(`<th>Dealer</th><th>When</th><th>Result</th>`, log.map(([, m]) => `<tr><td>${esc(dealerName(m.dealerId))}<div class="small muted">${esc(m.channel || "no contact")}${m.to ? " · " + esc(m.to) : ""}</div></td><td class="small nowrap">${fmtStamp(m.at)}</td><td class="small">${m.status === "sent" ? `<span class="pill good">Sent</span>` : `<span class="pill bad">Failed</span> ${esc(m.error || "")}`}</td></tr>`).join("")) : ""}`);
}
function routePanel() {
  if (!S.canAdmin) return "";
  const team = (S.team || []).filter((u) => u.collector && u.active), areas = [...new Set(activeDealers().map(([, d]) => (d.area || "").trim()).filter(Boolean))].sort();
  if (!team.length) return panel("Collector routes", none("Mark a team member as a collector in their account first."));
  return panel("Collector routes", `<p class="small" style="margin-top:0">Assign a whole area here, or one dealer at a time in their dealer form.</p><form id="routeForm" class="form-grid">
    <label class="f">Area<select id="rt-area" required><option value="">Choose…</option>${areas.map((a) => `<option>${esc(a)}</option>`).join("")}</select></label>
    <label class="f">Collector<select id="rt-who" required><option value="">Choose…</option>${team.map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join("")}</select></label>
    <div class="actions span"><button class="btn sm primary" type="submit">Assign area</button></div></form>`);
}
const storePanels = () => `<div class="stack" style="margin-bottom:16px">${booksPanel()}${reminderPanel()}${routePanel()}</div>`;
document.addEventListener("change", (e) => { if (e.target.id === "y-method") { const c = $("#y-check"); if (c) c.hidden = e.target.value !== "Check"; } });
document.addEventListener("input", (e) => { if (e.target.id === "sup-q") { S.supQ = e.target.value; render(); } });
document.addEventListener("submit", (e) => {
  if (e.target.id === "remForm") { e.preventDefault();
    const days = $("#rm-days").value.split(/[,\s]+/).map((x) => Number(x.replace("−", "-"))).filter((n) => Number.isInteger(n));
    guarded(e.submitter, async () => { await window.LedgerUI.saveStore({ reminders: { enabled: $("#rm-on").checked, days }, reminderAuto: $("#rm-msg").value.trim() }); toast("Reminder settings saved"); });
  }
  if (e.target.id === "routeForm") { e.preventDefault(); const area = $("#rt-area").value, who = $("#rt-who").value;
    guarded(e.submitter, async () => { const list = activeDealers().filter(([, d]) => (d.area || "").trim() === area); for (const [id] of list) await call("PATCH", "/api/c/dealers/" + id, { data: { collectorId: who } }); toast(`${list.length} dealer${list.length === 1 ? "" : "s"} assigned`); });
  }
});

/* ---------- actions ---------- */
const actions = (a, id) => ({
  "go-cash": () => window.LedgerUI.goView("cash"),
  "ops-close": () => closeDay(id), "ops-remit": remitForm,
  "ops-reopen": () => reasonSheet(`Reopen ${fmtDate(id)}`, "Payments for this day can be changed again until you close it.", "Reason", (reason) => call("POST", "/api/cash/reopen", { date: id, reason })),
  "ops-remit-ok": () => reasonSheet("Approve remittance", "Record what happened with the difference.", "Note", (note) => call("POST", `/api/remittances/${encodeURIComponent(id)}/decide`, { note })),
  "ops-check-ok": () => { if (armed(a, "Tap to confirm")) guarded(a, async () => { await call("POST", `/api/checks/${id}/clear`, {}); toast("Check cleared"); }); },
  "ops-check-bad": () => reasonSheet("Bounced check", "This reverses the payment, so the dealer owes that amount again.", "Reason", (reason, sh) => call("POST", `/api/checks/${id}/bounce`, { reason, fee: Number($("#b-fee", sh).value) || 0 }), `<label class="f span">Bounce fee (₱, optional)${num("b-fee")}</label>`),
  "ops-proof-ok": () => { if (armed(a, "Tap to approve")) guarded(a, async () => { const r = await call("POST", `/api/proofs/${id}/approve`, {}); toast(`Payment ${r.no} recorded`); }); },
  "ops-proof-no": () => reasonSheet("Reject proof of payment", "The dealer sees this reason.", "Reason", (reason) => call("POST", `/api/proofs/${id}/reject`, { reason })),
  "ops-sup": () => supplierForm(id), "ops-sup-all": () => { S.supAll = a.checked; render(); }, "ops-po": () => poForm(id), "ops-receive": () => receiveForm(id),
  "ops-books-close": () => show(() => [head("Close a period", "Nobody can change records on or before this date until it is reopened.") + `<form id="f" class="form-grid"><label class="f span">Close through<input id="b-date" type="date" required max="${addDays(today(), -1)}"></label><div class="actions span"><button class="btn primary" type="submit">Close the books</button><button class="btn" type="button" data-back>Cancel</button></div></form>`, (sh) => {
    $("#f", sh).addEventListener("submit", (e) => { e.preventDefault(); guarded(e.submitter, async () => { await call("POST", "/api/periods/close", { through: $("#b-date", sh).value }); toast("Books closed"); back(); }); }); }]),
  "ops-books-open": () => reasonSheet("Reopen the books", "This is logged. Keep a date to reopen only the most recent part.", "Reason", (reason, sh) => call("POST", "/api/periods/reopen", { reason, to: $("#b-to", sh).value }), `<label class="f span">Stay closed through (optional)<input id="b-to" type="date"></label>`),
  "ops-rem-run": () => guarded(a, async () => { const r = await call("POST", "/api/reminders/run", {}); toast(`${r.sent} sent, ${r.failed} failed`, r.failed ? "error" : undefined); }),
})[a.dataset.act];

window.LedgerOps = { views: { cash: vCash, buying: vBuying }, actions, notices, storePanels };
})();
