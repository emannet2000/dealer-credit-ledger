(() => {
"use strict";
const $=(s,el=document)=>el.querySelector(s);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const peso=new Intl.NumberFormat("en-PH",{style:"currency",currency:"PHP"}); const P=n=>peso.format(Number(n)||0);
const r2=n=>Math.round((Number(n)||0)*100)/100;
const pad=n=>String(n).padStart(2,"0"); const ymd=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; const today=()=>ymd(new Date());
const daysBetween=(a,b)=>Math.round((new Date(b+"T00:00:00")-new Date(a+"T00:00:00"))/864e5);
const fmtDate=s=>s?new Date(s+"T00:00:00").toLocaleDateString("en-PH",{month:"short",day:"numeric",year:"numeric"}):"—";
const LABEL={sale:"Delivery",payment:"Payment",return:"Return",refund:"Refund"};
function toast(m){ document.querySelectorAll(".toast").forEach(x=>x.remove()); const t=document.createElement("div"); t.className="toast"; t.setAttribute("role","status"); t.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg><span></span>'; t.lastChild.textContent=m; document.body.appendChild(t); setTimeout(()=>t.remove(),2800); }
async function api(method,url,body){ const orderId=url.startsWith("/api/c/orders/")?url.split("/").pop():null;const version=orderId&&S.orders.find(o=>o._id===orderId)?._version; const r=await fetch(url,{method,credentials:"same-origin",headers:{...(body?{"Content-Type":"application/json"}:{}),...(version?{"If-Match":String(version)}:{}),...(orderId&&method!=="GET"?{"Idempotency-Key":"portal_"+orderId+"_"+(!body?.data?.status?"new":version||"new")}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
  if(r.status===401){ location.href="/login"; throw new Error("Signed out"); } const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(d.message||"Something went wrong. Try again."); return d; }

const S={me:null,dealer:null,txns:[],products:[],orders:[],settings:{},tab:"unpaid",q:"",cart:new Map()};
try{ const c=JSON.parse(localStorage.getItem("portal-cart")||"[]"); S.cart=new Map(c); }catch(e){}
const saveCart=()=>{ try{ localStorage.setItem("portal-cart",JSON.stringify([...S.cart])); }catch(e){} };
const myPct=()=>{ const d=S.dealer||{}, s=S.settings; return d.discountPct!=null&&d.discountPct!==""?Number(d.discountPct):Number(s.discountPct??25); };
const promoOn=p=>!!(p&&p.promo&&Number(p.promo.price)>0&&(!p.promo.from||today()>=p.promo.from)&&(!p.promo.to||today()<=p.promo.to));
const unitPrice=p=>promoOn(p)?Number(p.promo.price):(Number(p.srp)||0);
const prodPct=p=>promoOn(p)&&p.promo.noDiscount?0:(p.discountPct!=null&&p.discountPct!==""?Number(p.discountPct):myPct());
const discLabel=o=>o.discountPct!=null?`Less ${o.discountPct}% dealer discount`:"Less dealer discount";
function cartTotals(){ let sub=0, disc=0, n=0; const pcts=new Set(); S.cart.forEach((q,pid)=>{ const p=S.products.find(x=>x._id===pid); if(p){ sub+=q*unitPrice(p); disc+=q*unitPrice(p)*prodPct(p)/100; n+=q; pcts.add(prodPct(p)); } }); sub=r2(sub); disc=r2(disc); return {sub,disc,total:r2(sub-disc),n,lines:S.cart.size,pct:pcts.size===1?[...pcts][0]:null}; }
const ORD_L={new:"Received",preparing:"Preparing",ready:"Ready for pickup",released:"Released to you",cancelled:"Cancelled"};
const ORD_C={new:"neutral",preparing:"warn",ready:"good",released:"neutral",cancelled:"bad"};
const STEP={new:1,preparing:2,ready:3,released:4};
const live=()=>S.txns.filter(t=>!t.voided).sort((a,b)=>(a.date||"").localeCompare(b.date||"")||(a.createdAt||0)-(b.createdAt||0));
function compute(){
  const tx=live(),t0=today(),queue=[],settled=[],runAt=new Map();let run=0;
  tx.forEach(t=>{run=r2(run+(["sale","refund"].includes(t.type)?t.amount:-t.amount));runAt.set(t,run);});
  const result=LedgerAllocations.compute(tx.map(t=>({id:t._id,data:t}))),paidAt=new Map();
  for(const [id,c] of Object.entries(result.byCredit))for(const l of c.lines){const t=tx.find(t=>t._id===id);paidAt.set(l.id,[paidAt.get(l.id)||"",t.date].sort().pop());}
  for(const s of result.sales){const t=tx.find(t=>t._id===s.id);if(s.remaining>0.004)queue.push({t,rem:s.remaining});else settled.push({t,paid:[t.date,paidAt.get(s.id)||t.date].sort().pop()});}
  const open=queue.map(q=>({...q,late:q.t.dueDate&&q.t.dueDate<t0?daysBetween(q.t.dueDate,t0):0}));
  const onTime=settled.filter(s=>!s.t.dueDate||s.paid<=s.t.dueDate).length;
  return {balance:run,open,overdue:r2(open.filter(o=>o.late).reduce((a,o)=>a+o.rem,0)),maxLate:open.reduce((m,o)=>Math.max(m,o.late),0),
    nextDue:open.filter(o=>!o.late).sort((a,b)=>a.t.dueDate.localeCompare(b.t.dueDate))[0]||null,settled:settled.length,onTime,runAt,
    lastPay:tx.filter(t=>t.type==="payment").pop()||null};
}
function render(){
  const d=S.dealer, s=S.settings; if(!d){ $("#main").innerHTML=`<div class="card"><div class="empty">Your dealer account isn't linked yet. Ask ${esc(s.storeName||"the store")} to check your portal access.</div></div>`; return; }
  $("#store").textContent=s.storeName||"Dealer portal"; $("#hello").textContent=`Hi, ${d.name.split(" ")[0]}!`;
  const c=compute(), hold=c.maxLate>(Number(s.holdDays)||60);
  const avail=d.creditLimit?Math.max(0,d.creditLimit-c.balance):null;
  let html=`<section class="card bal"><div class="lbl">${c.balance<0?"Credit in your favor":"Your balance"}</div><div class="big num">${P(Math.abs(c.balance))}</div>
    <div class="bal-grid">
      <div><span class="small muted">Overdue</span><b class="num ${c.overdue?"bad-t":""}">${P(c.overdue)}</b></div>
      <div><span class="small muted">Next due</span><b class="num">${c.nextDue?fmtDate(c.nextDue.t.dueDate):"—"}</b>${c.nextDue?`<span class="small muted num">${P(c.nextDue.rem)}</span>`:""}</div>
      ${d.creditLimit?`<div><span class="small muted">Credit limit</span><b class="num">${P(d.creditLimit)}</b></div><div><span class="small muted">Available</span><b class="num">${P(avail)}</b></div>`:""}
      <div><span class="small muted">Last payment</span><b class="num">${c.lastPay?P(c.lastPay.amount):"—"}</b>${c.lastPay?`<span class="small muted">${fmtDate(c.lastPay.date)}</span>`:""}</div>
      <div><span class="small muted">Paid on time</span><b class="num">${c.settled?Math.round(c.onTime/c.settled*100)+"%":"—"}</b>${c.settled?`<span class="small muted">${c.onTime} of ${c.settled} deliveries</span>`:""}</div>
    </div></section>`;
  if(hold) html+=`<div class="notice bad"><b>Your account is on hold.</b> Your oldest unpaid delivery is ${c.maxLate} days late. Please pay the overdue amount so the store can release new products to you.</div>`;
  else if(c.overdue) html+=`<div class="notice warn"><b>${P(c.overdue)} is past due.</b> Please pay soon to keep your account in good standing.</div>`;
  if(s.paymentInfo) html+=`<section class="card"><div class="pay"><div><h3 style="font-size:16px">How to pay</h3><p>${esc(s.paymentInfo)}</p></div><button class="btn sm" id="copyPay" type="button">Copy</button></div>${s.phone?`<p class="small muted" style="margin:8px 0 0">Questions? Contact ${esc(s.storeName||"the store")}: ${esc(s.phone)}</p>`:""}</section>`;
  const openOrders=S.orders.filter(o=>["new","preparing","ready"].includes(o.status)).length;
  const tabs=[["unpaid",`Unpaid (${c.open.length})`],["catalog","Order"],["orders",`My orders${openOrders?` (${openOrders})`:""}`],["history","History"],["account","Account"]];
  html+=`<div class="tabs" role="tablist">${tabs.map(([k,l])=>`<button class="tab" role="tab" type="button" data-tab="${k}" aria-selected="${S.tab===k}">${l}</button>`).join("")}</div>`;
  if(S.tab==="unpaid") html+=c.open.length?`<div class="list">${c.open.slice().reverse().map(o=>`<button class="row" type="button" data-rc="${esc(o.t._id)}"><div><b>${esc(o.t.no||LABEL.sale)}</b><div class="small muted">Released ${fmtDate(o.t.date)} · due ${fmtDate(o.t.dueDate)}</div>${o.rem<o.t.amount-0.004?`<div class="small" style="color:var(--good)">${P(o.t.amount-o.rem)} of ${P(o.t.amount)} paid</div>`:""}</div><div class="r"><b class="num">${P(o.rem)}</b><div>${o.late?`<span class="pill bad">${o.late} days late</span>`:`<span class="pill neutral">Not yet due</span>`}</div></div></button>`).join("")}</div>`:`<div class="empty">You have no unpaid deliveries. Salamat po!</div>`;
  if(S.tab==="history"){ const all=S.txns.slice().sort((a,b)=>(b.date||"").localeCompare(a.date||"")||(b.createdAt||0)-(a.createdAt||0));
    html+=all.length?`<div class="list">${all.map(t=>`<button class="row ${t.voided?"void":""}" type="button" data-rc="${esc(t._id)}"><div><b>${esc(t.opening?"Opening balance":t.payKind==="partial"?"Partial payment":t.payKind==="full"?"Full payment":LABEL[t.type])} ${esc(t.no||"")}</b><div class="small muted">${fmtDate(t.date)}${t.type==="payment"?" · "+esc(t.method||""):""}${t.voided?" · cancelled":""}</div></div><div class="r"><b class="num amt">${["sale","refund"].includes(t.type)?"":"−"}${P(t.amount)}</b>${t.voided?"":`<div class="small muted num">Balance ${P(c.runAt.get(t))}</div>`}</div></button>`).join("")}</div>`:`<div class="empty">No transactions yet.</div>`; }
  if(S.tab==="catalog"){ const pct=d.discountPct!=null&&d.discountPct!==""?Number(d.discountPct):Number(s.discountPct??25); const q=S.q.toLowerCase();
    const list=S.products.filter(p=>!q||[p.name,p.code,p.category].join(" ").toLowerCase().includes(q)).sort((a,b)=>a.name.localeCompare(b.name));
    html+=`<label style="margin-bottom:12px">Search products<input id="q" type="search" value="${esc(S.q)}" placeholder="Name, code or category"></label>
      ${s.catalogName?`<p class="small" style="margin:0 0 6px"><b>${esc(s.catalogName)}</b></p>`:""}<p class="small muted" style="margin:0 0 10px">Add what you need and send your order. ${esc(s.storeName||"The store")} prepares it before you arrive. Prices are SRP less your ${pct}% dealer discount.</p>
      ${hold?`<div class="notice bad">Your account is on hold. You can still send an order, but it may only be released after you pay the overdue amount.</div>`:""}
      ${list.length?`<div class="cat">${list.map(p=>`<div class="prod">${p.imageId?`<img src="/_blob/${encodeURIComponent(p.imageId)}" alt="" loading="lazy">`:`<div class="ph">No photo</div>`}<div class="t"><b>${esc(p.name)}</b>${promoOn(p)?`<span class="pill warn" style="align-self:flex-start">PROMO</span><span class="muted num"><s>SRP ${P(p.srp)}</s> ${P(p.promo.price)}</span>`:p.srp?`<span class="muted num">SRP ${P(p.srp)}</span>`:""}${p.srp||promoOn(p)?`<span class="num">Your price <b>${P(unitPrice(p)*(1-prodPct(p)/100))}</b></span>`:""}${p.available?`<span class="pill good" style="align-self:flex-start">Available</span>`:`<span class="pill neutral" style="align-self:flex-start">Out of stock</span>`}
        ${p.srp?(S.cart.get(p._id)?`<div class="qty"><button class="btn" type="button" data-q="-1" data-p="${esc(p._id)}" aria-label="One less ${esc(p.name)}">−</button><input class="num" type="number" min="0" inputmode="numeric" id="q-${esc(p._id)}" data-setq="${esc(p._id)}" value="${S.cart.get(p._id)}" aria-label="Quantity of ${esc(p.name)}"><button class="btn" type="button" data-q="1" data-p="${esc(p._id)}" aria-label="One more ${esc(p.name)}">+</button></div>`:`<button class="btn sm add" type="button" data-q="1" data-p="${esc(p._id)}">Add</button>`):""}</div></div>`).join("")}</div>`:`<div class="empty">No products found.</div>`}`; }
  if(S.tab==="orders"){ const list=S.orders.slice().sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    html+=list.length?`<div class="list">${list.map(o=>`<button class="row" type="button" data-ord="${esc(o._id)}"><div><b>${esc(o.no||"Order")}</b><div class="small muted">Placed ${new Date(o.createdAt).toLocaleDateString("en-PH",{month:"short",day:"numeric"})}${o.pickupDate?` · pickup ${fmtDate(o.pickupDate)}`:""} · ${(o.items||[]).reduce((a,i)=>a+i.qty,0)} pcs</div></div><div class="r"><b class="num">${P(o.amount)}</b><div><span class="pill ${ORD_C[o.status]}">${ORD_L[o.status]}</span></div></div></button>`).join("")}</div>`:`<div class="empty">No orders yet. Open the Order tab to send your first one.</div>`; }
  if(S.tab==="account") html+=`<section class="card"><dl class="kv"><dt>Name</dt><dd>${esc(d.name)}</dd>${d.phone?`<dt>Mobile</dt><dd>${esc(d.phone)}</dd>`:""}${d.area?`<dt>Address</dt><dd>${esc(d.area)}</dd>`:""}${d.terms!=null?`<dt>Payment terms</dt><dd>${d.terms} days</dd>`:""}<dt>Username</dt><dd>${esc(S.me.username)}</dd></dl></section>
    <section class="card"><h3 style="font-size:16px;margin-bottom:10px">Change password</h3><form id="pw"><label>Current password<input id="pw1" type="password" autocomplete="current-password" required></label><label>New password<input id="pw2" type="password" autocomplete="new-password" minlength="8" required></label><button class="btn primary" type="submit">Change password</button></form></section>`;
  const act=document.activeElement, fid=act&&act.id, pos=act&&act.selectionStart;
  $("#main").innerHTML=html; $("#main").removeAttribute("aria-busy");
  const T=cartTotals(); $("#cartbar").hidden=!T.lines||S.tab!=="catalog"; $("#cb-n").textContent=`${T.lines} product${T.lines===1?"":"s"} · ${T.n} pcs`; $("#cb-t").textContent=`Estimated ${P(T.total)}`;
  if(fid){ const el=document.getElementById(fid); if(el&&el.closest("#main")){ el.focus(); try{ if(pos!=null) el.setSelectionRange(pos,pos); }catch(e){} } }
}
function receipt(id){
  const t=S.txns.find(x=>x._id===id); if(!t) return; const s=S.settings, items=t.items||[], c=compute();
  const title=t.opening?"OPENING BALANCE":{sale:"DELIVERY RECEIPT",payment:"ACKNOWLEDGEMENT RECEIPT",return:"RETURN SLIP"}[t.type];
  $("#modalRoot").innerHTML=`<div class="overlay" id="ov"><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div style="display:flex;justify-content:flex-end;margin-bottom:10px"><button class="btn sm" id="close" type="button">Close</button></div>
    <article class="receipt"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:8px"><b>${esc(s.storeName||"")}</b><div style="text-align:right;font-size:13px"><b>${title}</b><div>No. ${esc(t.no||"—")}</div><div>${fmtDate(t.date)}</div></div></div>
    ${t.voided?`<p style="color:#b3261e;font-weight:700">This record was cancelled.</p>`:""}
    ${items.length?`<table><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Amount</th></tr></thead><tbody>${items.map(i=>`<tr><td>${esc(i.name)}<div style="color:#666;font-size:12px">${P(i.price)} each</div></td><td class="r">${i.qty}</td><td class="r">${P(i.qty*i.price)}</td></tr>`).join("")}</tbody></table>
      ${t.pctDiscount?`<div style="display:flex;justify-content:space-between"><span>Total at SRP</span><span>${P(t.subtotal)}</span></div><div style="display:flex;justify-content:space-between"><span>${discLabel(t)}</span><span>−${P(t.pctDiscount)}</span></div>`:""}${t.discount?`<div style="display:flex;justify-content:space-between"><span>Extra discount</span><span>−${P(t.discount)}</span></div>`:""}`:""}
    <div class="rc-total" style="margin-top:8px"><span>${t.type==="sale"?"Total on credit":t.type==="payment"?"Amount received":t.type==="refund"?"Amount refunded":"Total credited"}</span><b>${P(t.amount)}</b></div>
    ${t.type==="sale"?`<p>Due date: <b>${fmtDate(t.dueDate)}</b></p>`:""}${["payment","refund"].includes(t.type)?`<p>Method ${esc(t.method||"")}${t.ref?" · Ref "+esc(t.ref):""}</p>`:""}
    ${t.voided?"":`<p>Your balance after this: <b>${P(c.runAt.get(t))}</b></p>`}
    ${t.type==="payment"&&(t.applied||[]).length?`<table><thead><tr><th>Applied to</th><th class="r">Paid</th><th class="r">Still owed</th></tr></thead><tbody>${t.applied.map(a=>`<tr><td>${esc(a.no)}</td><td class="r">${P(a.amount)}</td><td class="r">${a.left>0.004?P(a.left):"Fully paid"}</td></tr>`).join("")}</tbody></table>`:""}
    <p style="font-size:12px;color:#666;text-align:center;margin-bottom:0">This is not an official receipt.</p></article></div></div>`;
  const close=()=>{ $("#modalRoot").innerHTML=""; };
  $("#close").addEventListener("click",close); $("#ov").addEventListener("mousedown",e=>{ if(e.target.id==="ov") close(); });
  $("#close").focus();
}
function modal(html,mount){ $("#modalRoot").innerHTML=`<div class="overlay" id="ov"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  const close=()=>{ $("#modalRoot").innerHTML=""; }; $("#ov").addEventListener("mousedown",e=>{ if(e.target.id==="ov") close(); }); const cl=$("#close"); if(cl){ cl.addEventListener("click",close); cl.focus(); } mount&&mount(close); }
function reviewOrder(){
  const requestId=(crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random()).replace(/[^A-Za-z0-9]/g,"").slice(0,20);
  const tomorrow=(()=>{ const d=new Date(); d.setDate(d.getDate()+1); return ymd(d); })();
  const draw=()=>{ const T=cartTotals(); const rows=[...S.cart].map(([pid,q])=>{ const p=S.products.find(x=>x._id===pid); return p?{p,q}:null; }).filter(Boolean);
    return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><h2 style="font-size:20px">Review your order</h2><button class="btn sm" id="close" type="button">Close</button></div>
    <table class="otbl"><thead><tr><th>Product</th><th class="r">Qty</th><th class="r">Amount</th></tr></thead><tbody>${rows.map(({p,q})=>`<tr><td><b>${esc(p.name)}</b><div class="small muted num">SRP ${P(unitPrice(p))}</div></td><td class="r"><div class="qty" style="justify-content:flex-end;margin:0"><button class="btn" type="button" data-q="-1" data-p="${esc(p._id)}" aria-label="One less">${q>1?"−":"✕"}</button><span class="num" style="min-width:28px;text-align:center">${q}</span><button class="btn" type="button" data-q="1" data-p="${esc(p._id)}" aria-label="One more">+</button></div></td><td class="r num">${P(q*unitPrice(p))}</td></tr>`).join("")}</tbody></table>
    <div style="margin:10px 0 14px"><div class="tot"><span class="muted">Total at SRP</span><span class="num">${P(T.sub)}</span></div><div class="tot"><span class="muted">${T.pct!=null?`Less ${T.pct}% dealer discount`:"Less dealer discount"}</span><span class="num">−${P(T.disc)}</span></div><div class="tot g"><span>Estimated total</span><span class="num">${P(T.total)}</span></div>
    <p class="small muted" style="margin:6px 0 0">The store confirms the final amount when you pick up. It's added to your account as a credit delivery.</p></div>
    <form id="of"><label>Pickup date<input id="o-date" type="date" min="${today()}" value="${tomorrow}"></label><label>Note for the store (optional)<input id="o-note" maxlength="500" placeholder="e.g. I'll come after lunch"></label><button class="btn primary" type="submit" id="o-send" ${rows.length?"":"disabled"}>Send order</button></form>`; };
  modal(draw(),function mount(close){
    $("#ov").addEventListener("click",e=>{ const b=e.target.closest("[data-q]"); if(!b) return; bump(b.dataset.p,+b.dataset.q); if(!S.cart.size){ close(); render(); return; } const keep={d:$("#o-date").value,n:$("#o-note").value}; $(".modal").innerHTML=draw(); $("#o-date").value=keep.d; $("#o-note").value=keep.n; rebind(close); });
    rebind(close);
  });
  function rebind(close){
    $("#close").addEventListener("click",close);
    $("#of").addEventListener("submit",async e=>{ e.preventDefault(); const b=$("#o-send"); b.disabled=true; b.textContent="Sending…";
      try{ const id=requestId;
        const r=await api("PUT","/api/c/orders/"+id,{data:{items:[...S.cart].map(([productId,qty])=>({productId,qty})),pickupDate:$("#o-date").value||null,note:$("#o-note").value.trim()}});
        S.cart.clear(); saveCart(); close(); S.tab="orders"; await load(); toast(`Order ${r.data.no} sent. We'll prepare it for you.`);
      }catch(err){ toast(err.message); b.disabled=false; b.textContent="Send order"; } }); }
}
function orderDetail(id){
  const o=S.orders.find(x=>x._id===id); if(!o) return; const step=STEP[o.status]||0;
  modal(`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><h2 style="font-size:20px">Order ${esc(o.no||"")}</h2><button class="btn sm" id="close" type="button">Close</button></div>
    <span class="pill ${ORD_C[o.status]}">${ORD_L[o.status]}</span>${o.cancelReason?` <span class="small muted">${esc(o.cancelReason)}</span>`:""}
    ${o.status!=="cancelled"?`<div class="steps" aria-hidden="true">${[1,2,3,4].map(k=>`<span class="${k<=step?"on":""}"></span>`).join("")}</div><div class="small muted" style="display:flex;justify-content:space-between"><span>Received</span><span>Preparing</span><span>Ready</span><span>Released</span></div>`:""}
    <table class="otbl" style="margin-top:12px"><thead><tr><th>Product</th><th class="r">Qty</th><th class="r">Amount</th></tr></thead><tbody>${(o.items||[]).map(i=>`<tr><td>${esc(i.name)}</td><td class="r num">${i.qty}</td><td class="r num">${P(i.qty*i.price)}</td></tr>`).join("")}</tbody></table>
    <div style="margin:10px 0"><div class="tot"><span class="muted">Total at SRP</span><span class="num">${P(o.subtotal)}</span></div><div class="tot"><span class="muted">${discLabel(o)}</span><span class="num">−${P(o.pctDiscount)}</span></div><div class="tot g"><span>Estimated total</span><span class="num">${P(o.amount)}</span></div></div>
    <dl class="kv"><dt>Pickup</dt><dd>${o.pickupDate?fmtDate(o.pickupDate):"Anytime"}</dd>${o.note?`<dt>Your note</dt><dd>${esc(o.note)}</dd>`:""}${o.saleNo?`<dt>Delivery receipt</dt><dd>${esc(o.saleNo)}</dd>`:""}</dl>
    ${o.status==="new"?`<button class="btn" type="button" id="o-cancel" style="margin-top:14px;color:var(--bad);border-color:var(--bad)">Cancel this order</button>`:o.status==="preparing"||o.status==="ready"?`<p class="small muted" style="margin-top:12px">Need to change something? Message ${esc(S.settings.storeName||"the store")}${S.settings.phone?" at "+esc(S.settings.phone):""}.</p>`:""}`,
  close=>{ const c=$("#o-cancel"); if(c) c.addEventListener("click",async()=>{ if(!c.dataset.armed){ c.dataset.armed="1"; c.textContent="Tap again to cancel"; return; } c.disabled=true;
    try{ await api("PATCH","/api/c/orders/"+encodeURIComponent(id),{data:{status:"cancelled"}}); close(); await load(); toast("Order cancelled"); }catch(err){ toast(err.message); c.disabled=false; } }); });
}
function bump(pid,d){ const q=Math.max(0,(S.cart.get(pid)||0)+d); if(q) S.cart.set(pid,q); else S.cart.delete(pid); saveCart(); }
document.addEventListener("keydown",e=>{ if(e.key==="Escape") $("#modalRoot").innerHTML=""; });
document.addEventListener("click",e=>{
  const tb=e.target.closest("[data-tab]"); if(tb){ S.tab=tb.dataset.tab; render(); const m=$("#main"); m.classList.remove("tab-in"); void m.offsetWidth; m.classList.add("tab-in"); return; }
  const rc=e.target.closest("[data-rc]"); if(rc){ receipt(rc.dataset.rc); return; }
  const od=e.target.closest("[data-ord]"); if(od){ orderDetail(od.dataset.ord); return; }
  if(e.target.closest("#ov")) return;
  const qb=e.target.closest("[data-q]"); if(qb){ bump(qb.dataset.p,+qb.dataset.q); render(); return; }
  if(e.target.id==="cb-go"){ reviewOrder(); return; }
  if(e.target.id==="copyPay"){ const txt=S.settings.paymentInfo||""; try{ navigator.clipboard.writeText(txt).then(()=>toast("Copied"),()=>toast("Select the text to copy it")); }catch(_){ toast("Select the text to copy it"); } }
});
document.addEventListener("input",e=>{ if(e.target.id==="q"){ S.q=e.target.value; render(); } });
document.addEventListener("change",e=>{ const pid=e.target.dataset&&e.target.dataset.setq; if(pid){ const q=Math.max(0,Math.round(Number(e.target.value)||0)); if(q) S.cart.set(pid,q); else S.cart.delete(pid); saveCart(); render(); } });
document.addEventListener("submit",async e=>{ if(e.target.id!=="pw") return; e.preventDefault(); const b=e.target.querySelector("button"); b.disabled=true;
  try{ await api("POST","/api/me/password",{current:$("#pw1").value,next:$("#pw2").value}); toast("Password changed"); e.target.reset(); }catch(err){ toast(err.message); } b.disabled=false; });
$("#logout").addEventListener("click",()=>api("POST","/api/logout").finally(()=>location.href="/login"));

async function load(){
  try{
    const [me,dealers,txns,products,settings,orders]=await Promise.all([api("GET","/api/me"),api("GET","/api/c/dealers"),api("GET","/api/c/txns"),api("GET","/api/c/products"),api("GET","/api/c/settings"),api("GET","/api/c/orders")]);
    S.orders=orders.map(r=>({...r.data,_id:r.id,_version:r.version}));
    S.me=me; S.dealer=dealers[0]?dealers[0].data:null; S.txns=txns.map(r=>({...r.data,_id:r.id})); S.products=products.map(r=>({...r.data,_id:r.id})); for(const k of [...S.cart.keys()]) if(!S.products.find(p=>p._id===k)) S.cart.delete(k); S.settings=settings[0]?settings[0].data:{};
    $("#sync").textContent="Updated "+new Date().toLocaleTimeString("en-PH",{hour:"numeric",minute:"2-digit"}); render();
  }catch(e){ $("#sync").textContent="Couldn't load your account. Check your internet connection."; }
}
load();
let t; const later=()=>{ clearTimeout(t); t=setTimeout(load,300); };
if(window.EventSource){ const es=new EventSource("/api/events"); es.addEventListener("change",later); }
document.addEventListener("visibilitychange",()=>{ if(document.visibilityState==="visible") load(); });
})();
