/* Daily operations screens: the Cash and Buying tabs, plus the books and reminder panels
   in Store. The server holds every rule (lib/ops.js); these screens show what it decides. */
"use strict";
(() => {
const { lsGet, lsSet, S, $, $$, esc, P, fmtDate, fmtStamp, today, addDays, status, head, show, back, toast, errMsg, guarded, armed, render, activeDealers, r2, METHODS } = window.LedgerUI;
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
  const voids = S.canAdmin ? rows(S.signoffs).filter(([, r]) => r.status === "pending").length : 0;
  if (voids) note("warn", `<b>${voids} void${voids === 1 ? "" : "s"} waiting for your approval.</b>`, "Review", "go-cash");
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
function signoffPanel() {
  const list = rows(S.signoffs).filter(([, r]) => r.status === "pending");
  if (!S.canAdmin || !list.length) return "";
  return panel("Voids to approve", table(`<th>Record</th><th>Dealer</th><th class="r">Amount</th><th></th>`, list.map(([id, r]) =>
    `<tr><td><b>${esc(r.no)}</b><div class="small muted">${esc(r.requestedByName)}: ${esc(r.reason)}</div></td><td>${esc(dealerName(r.dealerId))}</td><td class="r num">${P(r.amount)}</td><td class="r"><div class="actions" style="justify-content:flex-end"><button class="btn sm danger" data-act="ops-so-ok" data-id="${esc(id)}" type="button">Approve void</button><button class="btn sm" data-act="ops-so-no" data-id="${esc(id)}" type="button">Refuse</button></div></td></tr>`).join("")));
}
function expensesInRange(from, to) { return rows(S.expenses).filter(([, e]) => !e.voided && e.date >= from && e.date <= to); }
function expensePanel() {
  const from = today().slice(0, 8) + "01", list = expensesInRange(from, today()).sort((a, b) => b[1].date.localeCompare(a[1].date)), total = r2(list.reduce((a, [, e]) => a + e.amount, 0));
  return panel(`Expenses this month${list.length ? ` <span class="small muted">${P(total)}</span>` : ""}`, list.length ? table(`<th>Day</th><th>For</th><th class="r">Amount</th><th></th>`, list.slice(0, 25).map(([id, e]) =>
    `<tr><td class="nowrap">${fmtDate(e.date)}</td><td><b>${esc(e.category)}</b><div class="small muted">${esc([e.payee, e.method, e.note].filter(Boolean).join(" · "))}</div></td><td class="r num">${P(e.amount)}</td><td class="r"><button class="btn sm" data-act="ops-exp" data-id="${esc(id)}" type="button">Edit</button></td></tr>`).join("")) : none("No expenses recorded this month."),
    `<button class="btn sm primary" data-act="ops-exp" type="button">+ Expense</button>`);
}
const EXP_CATS = ["Rent", "Salaries", "Fuel and transport", "Utilities", "Supplies", "Repairs", "Taxes and fees", "Other"];
function expenseForm(id) {
  const e = id ? S.expenses.get(id) : { date: today(), category: "", amount: "", method: "Cash", payee: "", note: "" };
  show(() => [head(id ? "Edit expense" : "New expense", "Money that left the business, other than paying for stock.") + `<form id="f" class="form-grid">
    <label class="f">Date<input id="x-date" type="date" required max="${today()}" value="${esc(e.date)}"></label>
    <label class="f">Amount (₱)${num("x-amt", e.amount, "required")}</label>
    <label class="f">Category<input id="x-cat" list="x-cats" required maxlength="60" value="${esc(e.category)}"><datalist id="x-cats">${EXP_CATS.map((c) => `<option value="${esc(c)}">`).join("")}</datalist></label>
    <label class="f">Paid by<select id="x-method">${METHODS.map((m) => `<option ${e.method === m ? "selected" : ""}>${esc(m)}</option>`).join("")}</select></label>
    <label class="f span">Paid to<input id="x-payee" maxlength="120" value="${esc(e.payee)}"></label>
    <label class="f span">Note<input id="x-note" maxlength="300" value="${esc(e.note)}"></label>
    <div class="actions span"><button class="btn primary" type="submit">Save</button>${id ? `<button class="btn danger" type="button" id="x-void" style="margin-left:auto">Void</button>` : `<button class="btn" type="button" data-back>Cancel</button>`}</div></form>`, (sh) => {
    const body = () => ({ date: $("#x-date", sh).value, amount: Number($("#x-amt", sh).value), category: $("#x-cat", sh).value, method: $("#x-method", sh).value, payee: $("#x-payee", sh).value, note: $("#x-note", sh).value });
    const v = $("#x-void", sh); if (v) v.addEventListener("click", () => { if (armed(v, "Tap again to void")) guarded(v, async () => { await call("PUT", "/api/c/expenses/" + id, { data: { ...body(), voided: true } }); toast("Expense voided"); back(); }); });
    $("#f", sh).addEventListener("submit", (ev) => { ev.preventDefault(); guarded(ev.submitter, async () => { await call("PUT", "/api/c/expenses/" + (id || window.APP.newId()), { data: body() }); toast("Expense saved"); back(); }); });
  }]);
}
function netProfitKpi(gross, [from, to]) {
  const spent = r2(expensesInRange(from, to).reduce((a, [, e]) => a + e.amount, 0)), net = r2(gross - spent);
  return `<div class="kpi ${net < 0 ? "bad" : "good"}"><div class="lbl">Net profit</div><div class="val num">${P(net)}</div><div class="sub">Gross profit less ${P(spent)} expenses</div></div>`;
}
function vCash() {
  if (!S.canWrite) return panel("Cash", none("Daily cash work is for the store team."));
  return `<div class="stack">${S.acct && S.acct.collector ? myRoute() : ""}${signoffPanel()}${remitPanel()}<div class="grid2e"><div class="stack">${closePanel()}${expensePanel()}</div><div class="stack">${proofPanel()}${checkPanel()}</div></div>${collectorReport()}</div>`;
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
  const bills = pos.flatMap(([id, p]) => (p.receipts || []).map((r, i) => ({ id, p, i, inv: r.invoice })).filter((x) => x.inv)).sort((a, b) => String(a.inv.dueDate || "9").localeCompare(String(b.inv.dueDate || "9")));
  const left = (inv) => r2(inv.amount - (inv.paid || 0)), owed = r2(bills.reduce((a, x) => a + left(x.inv), 0)), t0 = today();
  return `<div class="stack">${panel("Purchase orders", pos.length ? table(`<th>No.</th><th>Supplier</th><th>Ordered</th><th>Status</th><th class="r">Outstanding</th><th></th>`, pos.map(([id, p]) => {
    const left = p.lines.reduce((a, l) => a + l.qty - (l.received || 0), 0), open = ["ordered", "partial"].includes(p.status);
    return `<tr><td><b>${esc(p.no)}</b></td><td>${esc((S.suppliers.get(p.supplierId) || {}).name || "")}</td><td class="nowrap">${fmtDate(p.date)}</td><td><span class="pill ${PO_C[p.status]}">${PO_L[p.status]}</span></td><td class="r num">${p.status === "cancelled" ? "—" : left}</td><td class="r"><div class="actions" style="justify-content:flex-end">${open ? `<button class="btn sm primary" data-act="ops-receive" data-id="${esc(id)}" type="button">Receive</button>` : ""}${S.canAdmin && ["draft", "ordered"].includes(p.status) ? `<button class="btn sm" data-act="ops-po" data-id="${esc(id)}" type="button">Edit</button>` : ""}</div></td></tr>`;
  }).join("")) : none("No purchase orders yet."), S.canAdmin ? `<button class="btn sm primary" data-act="ops-po" type="button">+ Purchase order</button>` : "")}
  ${bills.length ? panel(`Supplier invoices${owed ? ` <span class="small muted">You owe ${P(owed)}</span>` : ""}`, table(`<th>Invoice</th><th>Supplier</th><th>Due</th><th class="r">Amount</th><th class="r">Unpaid</th><th></th>`, bills.map(({ id, p, i, inv }) => `<tr><td><b>${esc(inv.no)}</b><div class="small muted">${esc(p.no)}</div></td><td>${esc((S.suppliers.get(p.supplierId) || {}).name || "")}</td><td class="nowrap">${inv.dueDate ? fmtDate(inv.dueDate) : "—"}${left(inv) > 0 && inv.dueDate && inv.dueDate < t0 ? ` <span class="pill bad">Overdue</span>` : ""}</td><td class="r num">${P(inv.amount)}</td><td class="r num">${left(inv) > 0 ? P(left(inv)) : `<span class="pill good">Paid</span>`}</td><td class="r">${S.canAdmin && left(inv) > 0 ? `<button class="btn sm" data-act="ops-bill" data-id="${esc(id)}" data-i="${i}" type="button">Pay</button>` : ""}</td></tr>`).join(""))) : ""}
  ${locationPanel()}
  ${panel("Suppliers", `<div class="actions" style="margin-bottom:10px"><input id="sup-q" type="search" placeholder="Search suppliers" aria-label="Search suppliers" value="${esc(S.supQ || "")}" style="flex:1;min-width:160px"><label class="chk"><input type="checkbox" data-act="ops-sup-all" ${S.supAll ? "checked" : ""}> Show archived</label></div>
    ${sup.length ? table(`<th>Supplier</th><th>Contact</th><th class="r">Terms</th><th></th>`, sup.map(([id, s]) => `<tr><td><b>${esc(s.name)}</b>${s.active === false ? ` <span class="pill neutral">Archived</span>` : ""}</td><td class="small">${esc(s.contact)}${s.phone ? ` · ${esc(s.phone)}` : ""}</td><td class="r num">${s.terms} days</td><td class="r">${S.canAdmin ? `<button class="btn sm" data-act="ops-sup" data-id="${esc(id)}" type="button">Edit</button>` : ""}</td></tr>`).join("")) : none("No suppliers to show.")}`, S.canAdmin ? `<button class="btn sm primary" data-act="ops-sup" type="button">+ Supplier</button>` : "")}</div>`;
}
function billForm(id, i) {
  const p = S.purchases.get(id), inv = p.receipts[i].invoice, due = r2(inv.amount - (inv.paid || 0));
  show(() => [head(`Pay invoice ${esc(inv.no)}`, `${P(due)} unpaid`) + `<form id="f" class="form-grid">
    <label class="f">Amount (₱)${num("y2-amt", due, `required max="${due}"`)}</label>
    <label class="f">Date<input id="y2-date" type="date" required max="${today()}" value="${today()}"></label>
    <label class="f">Paid by<select id="y2-method">${METHODS.map((m) => `<option>${esc(m)}</option>`).join("")}</select></label>
    <label class="f">Reference<input id="y2-ref" maxlength="80"></label>
    <div class="actions span"><button class="btn primary" type="submit">Record payment</button><button class="btn" type="button" data-back>Cancel</button></div></form>`, (sh) => {
    $("#f", sh).addEventListener("submit", (e) => { e.preventDefault(); guarded(e.submitter, async () => { await call("POST", `/api/purchases/${id}/pay`, { receipt: i, amount: Number($("#y2-amt", sh).value), date: $("#y2-date", sh).value, method: $("#y2-method", sh).value, ref: $("#y2-ref", sh).value }); toast("Supplier payment recorded"); back(); }); });
  }]);
}
/* ---------- stock locations ---------- */
function locationPanel() {
  const locs = rows(S.locations).filter(([, l]) => l.active !== false), placed = rows(S.products).filter(([, p]) => p.active !== false && Object.keys(p.stockAt || {}).length);
  const cells = (p) => { const at = p.stockAt || {}, out = Number(p.stock) - Object.values(at).reduce((a, v) => a + Number(v), 0); return `<td class="r num">${out}</td>${locs.map(([k]) => `<td class="r num">${at[k] || "—"}</td>`).join("")}`; };
  return panel("Stock locations", `${locs.length ? `<p class="small" style="margin-top:0">Stock not moved anywhere stays at the Main store.</p>` : none("Add a warehouse, van or collector here to track where stock is.")}
    ${locs.length && placed.length ? table(`<th>Product</th><th class="r">Main store</th>${locs.map(([, l]) => `<th class="r">${esc(l.name)}</th>`).join("")}`, placed.map(([, p]) => `<tr><td><b>${esc(p.name)}</b></td>${cells(p)}</tr>`).join("")) : ""}`,
    `<div class="actions">${locs.length ? `<button class="btn sm primary" data-act="ops-move" type="button">Move stock</button>` : ""}${S.canAdmin ? `<button class="btn sm" data-act="ops-loc" type="button">+ Location</button>` : ""}</div>`);
}
function moveForm() {
  const locs = rows(S.locations).filter(([, l]) => l.active !== false), opt = `<option value="">Main store</option>${locs.map(([k, l]) => `<option value="${esc(k)}">${esc(l.name)}</option>`).join("")}`;
  show(() => [head("Move stock", "The total stays the same. Only where it sits changes.") + `<form id="f" class="form-grid">
    <label class="f span">Product<select id="v2-p" required><option value="">Choose…</option>${rows(S.products).filter(([, p]) => p.active !== false).sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([k, p]) => `<option value="${esc(k)}">${esc(p.name)}</option>`).join("")}</select></label>
    <label class="f">From<select id="v2-from">${opt}</select></label><label class="f">To<select id="v2-to">${opt}</select></label>
    <label class="f">Quantity<input id="v2-q" type="number" min="1" step="1" required></label><label class="f">Note<input id="v2-note" maxlength="200"></label>
    <div class="actions span"><button class="btn primary" type="submit">Move</button><button class="btn" type="button" data-back>Cancel</button></div></form>`, (sh) => {
    $("#f", sh).addEventListener("submit", (e) => { e.preventDefault(); guarded(e.submitter, async () => { await call("POST", "/api/stock/transfer", { productId: $("#v2-p", sh).value, from: $("#v2-from", sh).value, to: $("#v2-to", sh).value, qty: Number($("#v2-q", sh).value), note: $("#v2-note", sh).value }); toast("Stock moved"); back(); }); });
  }]);
}
/* ---------- merge duplicates ---------- */
function mergeForm(kind, keepId) {
  const dealers = kind === "dealers", all = dealers ? S.dealers : S.products, keep = all.get(keepId), others = rows(all).filter(([k, x]) => k !== keepId && !x.anonymised).sort((a, b) => a[1].name.localeCompare(b[1].name));
  const line = (k) => { const x = all.get(k); return dealers ? `Balance ${P(status(k).balance)}${x.phone ? " · " + x.phone : ""}` : `Stock ${x.stock}${x.code ? " · " + x.code : ""}`; };
  show(() => [head("Merge a duplicate", `Everything from the other record moves to ${esc(keep.name)}, which stays.`) + `<form id="f" class="form-grid">
    <label class="f span">Keep<input value="${esc(keep.name)}" disabled><span class="hint">${esc(line(keepId))}</span></label>
    <label class="f span">Merge this one into it<select id="g2-src" required><option value="">Choose…</option>${others.map(([k, x]) => `<option value="${esc(k)}">${esc(x.name)}${x.active === false ? " (archived)" : ""}</option>`).join("")}</select><span class="hint" id="g2-info"></span></label>
    <div class="notice warn span"><p class="small">This can't be undone. ${dealers ? "Sales, payments, orders, contact notes and portal accounts move across, and the balances add up." : "Sales, orders, purchase orders and stock history move across, and the stock adds up."} It is saved in the activity log.</p></div>
    <div class="actions span"><button class="btn danger" type="submit">Merge</button><button class="btn" type="button" data-back>Cancel</button></div></form>`, (sh) => {
    const src = $("#g2-src", sh); src.addEventListener("change", () => { $("#g2-info", sh).textContent = src.value ? line(src.value) : ""; });
    $("#f", sh).addEventListener("submit", (e) => { e.preventDefault(); const btn = e.submitter; if (armed(btn, "Tap again to merge")) guarded(btn, async () => { await call("POST", "/api/merge/" + kind, { keepId, mergeId: src.value }); toast("Records merged"); window.LedgerUI.closeAll(); }); });
  }]);
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
function controlsPanel() {
  if (!S.canAdmin) return "";
  const c = { voidOver: 1000, discountOverPct: 10, ...(S.settings.controls || {}) };
  return panel("Staff limits", `<p class="small" style="margin-top:0">Above these, staff send the action to you for approval. Leave a box blank for no limit.</p><form id="ctlForm" class="form-grid">
    <label class="f">Voids from (₱)${num("ct-void", c.voidOver ?? "")}</label><label class="f">Discounts over (%)${num("ct-disc", c.discountOverPct ?? "")}</label>
    <div class="actions span"><button class="btn sm primary" type="submit">Save</button></div></form>`);
}
const gb = (n) => (n / 1e9).toFixed(1) + " GB", mb = (n) => (n / 1e6).toFixed(1) + " MB";
function healthPanel() {
  if (!S.canAdmin) return "";
  const h = S.health;
  return panel("System health", !h ? none("Checking…") : `${h.problems.map((p) => `<div class="notice bad"><p>${esc(p)}</p></div>`).join("")}<dl class="kv"><dt>Running since</dt><dd>${fmtStamp(h.startedAt)}</dd><dt>Database</dt><dd>${mb(h.dbBytes)}</dd>${h.disk ? `<dt>Disk free</dt><dd>${gb(h.disk.free)} of ${gb(h.disk.total)}</dd>` : ""}<dt>Last backup</dt><dd>${h.lastBackupAt ? fmtStamp(h.lastBackupAt) : "None yet"}</dd><dt>Errors today</dt><dd>${h.errorsToday}</dd></dl>
    ${h.errors.length ? `<ul class="small muted">${h.errors.slice(0, 5).map((e) => `<li>${fmtStamp(e.at)}: ${esc(e.message)}</li>`).join("")}</ul>` : ""}${h.alertsConfigured ? "" : `<p class="small muted" style="margin-bottom:0">Set ALERT_WEBHOOK_URL so problems reach you without opening this page.</p>`}`,
    `<button class="btn sm" data-act="ops-health" type="button">Refresh</button>`);
}
const pushable = () => window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
function devicePanel() {
  const paper = lsGet("paper") || "", on = pushable() && Notification.permission === "granted" && lsGet("push") === "1";
  return panel("This device", `<div class="form-grid"><label class="f">Receipt printer<select id="dv-paper">${[["", "Normal paper (A4)"], ["80", "Thermal, 80 mm"], ["58", "Thermal, 58 mm"]].map(([v, l]) => `<option value="${v}" ${paper === v ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>
    ${S.canWrite ? (pushable() ? `<div class="actions" style="margin-top:10px"><button class="btn sm ${on ? "" : "primary"}" data-act="${on ? "ops-push-off" : "ops-push-on"}" type="button">${on ? "Turn off notifications" : "Turn on notifications"}</button></div><p class="small muted" style="margin-bottom:0">For new orders, approvals and payment proofs, even with the app closed. On iPhone, add the app to the Home Screen first.</p>` : `<p class="small muted" style="margin-bottom:0">Notifications need the site on HTTPS in a supported browser.</p>`) : ""}`);
}
function applyPaper(v) {
  document.documentElement.dataset.paper = v || "";
  let st = $("#paper-css");
  if (!st) { st = document.createElement("style"); st.id = "paper-css"; document.head.append(st); }
  st.textContent = v ? `@page{size:${v}mm auto;margin:2mm}` : "";
}
applyPaper(lsGet("paper"));
const b64key = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
async function pushOn() {
  if (await Notification.requestPermission() !== "granted") { toast("Notifications are blocked in this browser's settings.", "error"); return; }
  const reg = await navigator.serviceWorker.ready, { key } = await call("GET", "/api/push/key");
  const old = await reg.pushManager.getSubscription(); if (old) await old.unsubscribe();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64key(key) });
  await call("POST", "/api/push/subscribe", { subscription: sub.toJSON() });
  lsSet("push", "1"); toast("Notifications turned on"); render();
}
async function pushOff() {
  const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
  if (sub) { await call("POST", "/api/push/unsubscribe", { endpoint: sub.endpoint }); await sub.unsubscribe(); }
  lsSet("push", "0"); toast("Notifications turned off"); render();
}
function passwordPanel(owner) {
  if (!owner) return "";
  if (!S.pwAsked) { S.pwAsked = true; call("GET", "/api/password/requests").then((r) => { S.pwRequests = r; if (r.length) render(); }, () => {}); }
  const list = S.pwRequests || [];
  return list.length ? `<div class="stack" style="margin-bottom:16px">${panel("Forgot password", table(`<th>Person</th><th>Asked</th><th></th>`, list.map((r) => `<tr><td><b>${esc(r.name)}</b><div class="small muted">${esc(r.username)}</div></td><td class="small">${fmtStamp(r.at)}</td><td class="r"><button class="btn sm" data-act="edit-user" data-id="${esc(r.id)}" type="button">Set new password</button></td></tr>`).join("")))}</div>` : "";
}
const storePanels = () => { if (S.canAdmin && !S.healthAsked) { S.healthAsked = true; loadHealth(); } return `<div class="stack" style="margin-bottom:16px">${booksPanel()}${controlsPanel()}${reminderPanel()}${routePanel()}${devicePanel()}${healthPanel()}</div>`; };
const loadHealth = () => call("GET", "/api/status").then((h) => { S.health = h; render(); }, () => {});
/* ---------- barcode scanning: a USB scanner types into the box; a phone uses its camera ---------- */
async function scanInto(sel) {
  const input = $(sel);
  if (!("BarcodeDetector" in window) || !navigator.mediaDevices) { input.focus(); toast("This browser can't scan with the camera. Use a USB scanner or type the number.", "error"); return; }
  const box = document.createElement("div"); box.className = "scan-box";
  box.innerHTML = `<video playsinline muted></video><button class="btn" type="button">Close</button>`;
  document.body.append(box);
  let stream, done = false;
  const stop = () => { done = true; if (stream) stream.getTracks().forEach((t) => t.stop()); box.remove(); };
  box.querySelector("button").addEventListener("click", stop);
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    const v = box.querySelector("video"), det = new BarcodeDetector(); v.srcObject = stream; await v.play();
    const tick = async () => {
      if (done) return;
      const found = await det.detect(v).catch(() => []);
      if (found.length) { stop(); input.value = found[0].rawValue; input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return; }
      setTimeout(tick, 200);
    };
    tick();
  } catch (e) { stop(); toast("The camera couldn't be opened.", "error"); }
}
document.addEventListener("click", (e) => { const b = e.target.closest("[data-scan]"); if (b) scanInto(b.dataset.scan); });
document.addEventListener("change", (e) => { if (e.target.id === "dv-paper") { lsSet("paper", e.target.value); applyPaper(e.target.value); toast("Printer saved for this device"); } });
document.addEventListener("change", (e) => { if (e.target.id === "y-method") { const c = $("#y-check"); if (c) c.hidden = e.target.value !== "Check"; } });
document.addEventListener("input", (e) => { if (e.target.id === "sup-q") { S.supQ = e.target.value; render(); } });
document.addEventListener("submit", (e) => {
  if (e.target.id === "remForm") { e.preventDefault();
    const days = $("#rm-days").value.split(/[,\s]+/).map((x) => Number(x.replace("−", "-"))).filter((n) => Number.isInteger(n));
    guarded(e.submitter, async () => { await window.LedgerUI.saveStore({ reminders: { enabled: $("#rm-on").checked, days }, reminderAuto: $("#rm-msg").value.trim() }); toast("Reminder settings saved"); });
  }
  if (e.target.id === "ctlForm") { e.preventDefault(); guarded(e.submitter, async () => { await window.LedgerUI.saveStore({ controls: { voidOver: $("#ct-void").value, discountOverPct: $("#ct-disc").value } }); toast("Staff limits saved"); }); }
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
  "ops-exp": () => expenseForm(id), "ops-bill": () => billForm(id, Number(a.dataset.i)), "ops-merge": () => mergeForm(a.dataset.kind, id), "ops-move": moveForm,
  "ops-loc": () => reasonSheet("New location", "A warehouse, van or collector who holds stock.", "Name", (name) => call("PUT", "/api/c/locations/" + window.APP.newId(), { data: { name } })),
  "ops-so-ok": () => { if (armed(a, "Tap to approve")) guarded(a, async () => { await call("POST", `/api/signoffs/${id}/approve`, {}); toast("Record voided"); }); },
  "ops-so-no": () => reasonSheet("Refuse this void", "The record stays as it is.", "Reason", (reason) => call("POST", `/api/signoffs/${id}/reject`, { reason })),
  "ops-health": () => guarded(a, loadHealth), "ops-push-on": () => guarded(a, pushOn), "ops-push-off": () => guarded(a, pushOff),
  "ops-sup": () => supplierForm(id), "ops-sup-all": () => { S.supAll = a.checked; render(); }, "ops-po": () => poForm(id), "ops-receive": () => receiveForm(id),
  "ops-books-close": () => show(() => [head("Close a period", "Nobody can change records on or before this date until it is reopened.") + `<form id="f" class="form-grid"><label class="f span">Close through<input id="b-date" type="date" required max="${addDays(today(), -1)}"></label><div class="actions span"><button class="btn primary" type="submit">Close the books</button><button class="btn" type="button" data-back>Cancel</button></div></form>`, (sh) => {
    $("#f", sh).addEventListener("submit", (e) => { e.preventDefault(); guarded(e.submitter, async () => { await call("POST", "/api/periods/close", { through: $("#b-date", sh).value }); toast("Books closed"); back(); }); }); }]),
  "ops-books-open": () => reasonSheet("Reopen the books", "This is logged. Keep a date to reopen only the most recent part.", "Reason", (reason, sh) => call("POST", "/api/periods/reopen", { reason, to: $("#b-to", sh).value }), `<label class="f span">Stay closed through (optional)<input id="b-to" type="date"></label>`),
  "ops-rem-run": () => guarded(a, async () => { const r = await call("POST", "/api/reminders/run", {}); toast(`${r.sent} sent, ${r.failed} failed`, r.failed ? "error" : undefined); }),
})[a.dataset.act];

window.LedgerOps = { views: { cash: vCash, buying: vBuying }, actions, notices, storePanels, passwordPanel, netProfitKpi };
})();
