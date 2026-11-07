(() => {
"use strict";
/* ================= state ================= */
const S = {
  dealers:new Map(), products:new Map(), txns:new Map(), moves:new Map(), orders:new Map(), purchases:new Map(),expenses:new Map(),authorizations:new Map(),dailyClosings:new Map(),suppliers:new Map(),batches:new Map(),bankStatements:new Map(),reminders:new Map(),deliveries:new Map(),supplierApplications:new Map(),approvals:new Map(), reconciliations:new Map(), periodLocks:new Map(), cashierShifts:new Map(), duplicateReviews:new Map(), settings:{},
  loaded:{dealers:false,products:false,txns:false,moves:false,orders:false,purchases:false,expenses:false,authorizations:false,dailyClosings:false,suppliers:false,batches:false,bankStatements:false,reminders:false,deliveries:false,supplierApplications:false,approvals:false,reconciliations:false,periodLocks:false,cashierShifts:false,duplicateReviews:false,settings:false},
  canWrite:true, canAdmin:false, me:null, names:{},
  view:"dashboard", q:"", txFilter:"all", showArchived:false, catFilter:"",
  stockFilter:{product:"",person:"",kind:"",from:"",to:""},profitGroup:"day",reorderLead:14,reorderCover:30,batchProduct:"",batchFilter:"all",reminderFilter:"overdue",dupeDays:7,duplicates:null,duplicatesError:"",
  range:{preset:"month",from:"",to:""}
};
let db=null, downloads=null, assets=null, userNs=null;
const COLS=["dealers","products","txns","moves","orders","approvals","reconciliations","purchases","expenses","authorizations","dailyClosings","suppliers","batches","bankStatements","reminders","deliveries","supplierApplications","periodLocks","cashierShifts","duplicateReviews"];

/* ================= helpers ================= */
const $=(s,el=document)=>el.querySelector(s);
const $$=(s,el=document)=>[...el.querySelectorAll(s)];
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const peso=new Intl.NumberFormat("en-PH",{style:"currency",currency:"PHP"});
const P=n=>peso.format(Number(n)||0);
const r2=n=>Math.round((Number(n)||0)*100)/100;
const pad=n=>String(n).padStart(2,"0");
const ymd=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const today=()=>ymd(new Date());
const addDays=(s,n)=>{const d=new Date(s+"T00:00:00");d.setDate(d.getDate()+Number(n||0));return ymd(d);};
const daysBetween=(a,b)=>Math.round((new Date(b+"T00:00:00")-new Date(a+"T00:00:00"))/864e5);
const fmtDate=s=>s?new Date(s+"T00:00:00").toLocaleDateString("en-PH",{month:"short",day:"numeric",year:"numeric"}):"—";
const fmtStamp=ms=>ms>1e9?new Date(ms).toLocaleString("en-PH",{month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"}):"";
const METHODS=["Cash","GCash","Maya","Bank transfer","Check","Other"];
const TYPE_LABEL={sale:"Credit sale",payment:"Payment",return:"Return",refund:"Customer refund"};
const PREFIX={sale:"DR",payment:"OR",return:"RT",refund:"RF"};
const isLive=t=>!t.voided;
const storeName=()=>S.settings.storeName||"Dealer Credit Ledger";
const holdDays=()=>Number(S.settings.holdDays??60)||60;
const blockOverLimit=()=>S.settings.blockOverLimit!==false;
const lsGet=k=>{ try{ return localStorage.getItem("dcl:"+k); }catch(e){ return null; } };
const lsSet=(k,v)=>{ try{ localStorage.setItem("dcl:"+k,String(v)); }catch(e){} };
const canEditTx=t=>t.type!=="refund"&&!t.saleId&&(S.canAdmin||(S.canWrite&&!!S.me&&t.createdBy===S.me&&t.createdAt>1e9&&ymd(new Date(t.createdAt))===today()));
const DEFAULT_MSG="Hi {name}, magandang araw po! Paalala lang po mula sa {store}: ang balance ninyo ay {balance}, {status}. {payinfo}Salamat po!";
function reminderText(id){
  const d=S.dealers.get(id), st=status(id), s=S.settings;
  const line=st.overdue>0?`at ${P(st.overdue)} na po ang lampas sa due date`:st.nextDue?`due po sa ${fmtDate(st.nextDue)}`:"";
  const pay=s.paymentInfo?`Puwede pong magbayad sa: ${s.paymentInfo}. `:"";
  return (s.reminderTemplate||DEFAULT_MSG).replace(/\{name\}/g,d.name.split(" ")[0]).replace(/\{balance\}/g,P(st.balance)).replace(/\{status\}/g,line)
    .replace(/\{store\}/g,s.storeName||"amin").replace(/\{payinfo\}/g,pay).replace(/\s+,/g,",").replace(/ {2,}/g," ").trim();
}
const openingDoc=(did,amt,date,due,note)=>({type:"sale",opening:true,dealerId:did,date,dueDate:due,items:[],subtotal:amt,discount:0,amount:amt,note:note||"Opening balance",no:nextNo("sale"),createdAt:Date.now(),createdBy:S.me});
const OK_RE=/(recorded|saved|added|updated|copied|removed|deleted|changed|restored|voided|archived|marked|corrected|matched|pasted|unmarked|sent|cancelled|preparing|ready|released)/i;
function toast(msg,kind){
  let box=document.getElementById("toasts"); if(!box){ box=document.createElement("div"); box.id="toasts"; box.setAttribute("role","status"); box.setAttribute("aria-live","polite"); document.body.appendChild(box); }
  kind=kind||(OK_RE.test(msg)?"ok":"info");
  const t=document.createElement("div"); t.className="toast "+kind; t.innerHTML=(typeof ICON!=="undefined"?ICON[kind==="ok"?"check":kind==="error"?"alert":"info"]:"")+"<span></span>"; t.lastChild.textContent=msg; box.appendChild(t);
  while(box.children.length>3) box.firstChild.remove();
  setTimeout(()=>{ t.classList.add("out"); setTimeout(()=>t.remove(),220); },kind==="error"?5000:2800);
}
const nameOf=id=>id?(S.names[id]||"a team member"):"—";
const stamp=()=>({at:Date.now(),by:S.me||null});

/* ================= domain ================= */
function nextNo(type){
  let max=0; const pre=PREFIX[type];
  S.txns.forEach(t=>{ if(t.type===type&&typeof t.no==="string"&&t.no.startsWith(pre+"-")){ const n=parseInt(t.no.slice(pre.length+1),10); if(n>max) max=n; } });
  return `${pre}-${String(max+1).padStart(5,"0")}`;
}
function dealerTxns(id,incVoid){ return [...S.txns.entries()].filter(([,t])=>t.dealerId===id&&(incVoid||isLive(t))).sort((a,b)=>(a[1].date||"").localeCompare(b[1].date||"")||(a[1].createdAt||0)-(b[1].createdAt||0)); }
// Payments and returns settle the oldest credit sales first (FIFO).
function dealerStatus(id){
  const pairs=dealerTxns(id),tx=pairs.map(([,t])=>t),result=LedgerAllocations.compute(pairs.map(([id,data])=>({id,data}))),t0=today();
  const open=result.sales.filter(s=>s.remaining>0.004).map(s=>({...S.txns.get(s.id),remaining:s.remaining,late:s.dueDate&&s.dueDate<t0?daysBetween(s.dueDate,t0):0}));
  return {balance:result.balance,overdue:r2(open.filter(o=>o.late).reduce((n,o)=>n+o.remaining,0)),maxLate:open.reduce((n,o)=>Math.max(n,o.late),0),open,nextDue:open.filter(o=>!o.late).map(o=>o.dueDate).filter(Boolean).sort()[0]||null,lastPay:tx.filter(t=>t.type==="payment").map(t=>t.date).sort().pop()||null};
}
// Credit history: when each delivery was fully paid (FIFO), on-time rate and a simple rating.
function creditHistory(id){
  const pairs=dealerTxns(id),tx=pairs.map(([,t])=>t),t0=today(),result=LedgerAllocations.compute(pairs.map(([id,data])=>({id,data}))),queue=[],settled=[];
  const paidAt=new Map();for(const [creditId,c] of Object.entries(result.byCredit))for(const line of c.lines){const date=S.txns.get(creditId).date;paidAt.set(line.id,[paidAt.get(line.id)||"",date].sort().pop());}
  for(const sale of result.sales){const t=S.txns.get(sale.id);if(sale.remaining>0.004)queue.push({t,rem:sale.remaining});else settled.push({t,paid:[t.date,paidAt.get(sale.id)||t.date].sort().pop()});}
  const rows=[...settled.map(s=>({t:s.t,paid:s.paid,late:s.t.dueDate?Math.max(0,daysBetween(s.t.dueDate,s.paid)):0,days:daysBetween(s.t.date,s.paid)})),
    ...queue.map(q=>({t:q.t,paid:null,rem:q.rem,late:q.t.dueDate&&q.t.dueDate<t0?daysBetween(q.t.dueDate,t0):0}))].sort((a,b)=>(b.t.date||"").localeCompare(a.t.date||""));
  const n=settled.length, done=rows.filter(r=>r.paid), onTime=done.filter(r=>r.late===0).length;
  const avgDays=n?Math.round(done.reduce((a,r)=>a+r.days,0)/n):null, avgLate=n?done.reduce((a,r)=>a+r.late,0)/n:0;
  const worst=rows.reduce((m,r)=>Math.max(m,r.late),0), openLate=rows.filter(r=>!r.paid).reduce((m,r)=>Math.max(m,r.late),0);
  const sum=k=>r2(tx.filter(t=>t.type===k).reduce((a,t)=>a+t.amount,0));
  let score=100; if(n) score-=(1-onTime/n)*40; score-=Math.min(30,avgLate); if(openLate>30) score-=25; if(openLate>holdDays()) score-=40; else if(openLate>0) score-=10;
  const grade=n<2&&!openLate?{g:"New",label:"Not enough history yet",cls:"neutral"}:score>=85?{g:"A",label:"Excellent payer",cls:"good"}:score>=70?{g:"B",label:"Good payer",cls:"good"}:score>=50?{g:"C",label:"Pays late often",cls:"warn"}:{g:"D",label:"High risk",cls:"bad"};
  const months=[]; const d0=new Date(); for(let i=5;i>=0;i--){ const dt=new Date(d0.getFullYear(),d0.getMonth()-i,1); const ym=ymd(dt).slice(0,7);
    const inM=tx.filter(t=>(t.date||"").startsWith(ym)); months.push({label:dt.toLocaleDateString("en-PH",{month:"short",year:"numeric"}),taken:r2(inM.filter(t=>t.type==="sale").reduce((a,t)=>a+t.amount,0)),paid:r2(inM.filter(t=>t.type==="payment").reduce((a,t)=>a+t.amount,0)),ret:r2(inM.filter(t=>t.type==="return").reduce((a,t)=>a+t.amount,0))}); }
  return {rows,n,onTime,avgDays,worst,grade,score:Math.round(score),taken:sum("sale"),paid:sum("payment"),returned:sum("return"),since:tx.length?tx[0].date:null,months};
}
const HIST_CACHE={key:null,map:new Map()};
function history(id){ if(HIST_CACHE.key!==S._ver){HIST_CACHE.key=S._ver;HIST_CACHE.map=new Map();} if(!HIST_CACHE.map.has(id)) HIST_CACHE.map.set(id,creditHistory(id)); return HIST_CACHE.map.get(id); }
const gradePill=h=>`<span class="pill ${h.grade.cls}" title="${esc(h.grade.label)}">${h.grade.g==="New"?"New":"Grade "+h.grade.g}</span>`;
const STATUS_CACHE={key:null,map:new Map()};
function status(id){ const key=S._ver; if(STATUS_CACHE.key!==key){STATUS_CACHE.key=key;STATUS_CACHE.map=new Map();} if(!STATUS_CACHE.map.has(id)) STATUS_CACHE.map.set(id,dealerStatus(id)); return STATUS_CACHE.map.get(id); }
function stockEffect(t){
  const m={}; if(!t||t.voided) return m;
  if(t.type==="sale") (t.items||[]).forEach(i=>m[i.productId]=(m[i.productId]||0)-i.qty);
  if(t.type==="return"&&t.restock) (t.items||[]).forEach(i=>m[i.productId]=(m[i.productId]||0)+i.qty);
  return m;
}
function diffEffect(oldT,newT){ const a=stockEffect(oldT), b=stockEffect(newT), m={}; new Set([...Object.keys(a),...Object.keys(b)]).forEach(k=>{const d=(b[k]||0)-(a[k]||0); if(d) m[k]=d;}); return m; }
function statusPill(st,d){
  if(st.balance<0) return `<span class="pill good">Credit ${P(-st.balance)}</span>`;
  if(st.balance===0) return `<span class="pill good">Paid up</span>`;
  if(st.maxLate>holdDays()) return `<span class="pill bad">On hold · ${st.maxLate} days late</span>`;
  if(st.maxLate>0) return `<span class="pill warn">${st.maxLate} days late</span>`;
  if(d.creditLimit&&st.balance>d.creditLimit) return `<span class="pill warn">Over limit</span>`;
  return `<span class="pill neutral">On time</span>`;
}
const samplePill=x=>x&&x.sample?` <span class="pill sample">Example</span>`:"";
const imgUrl=id=>"/_blob/"+encodeURIComponent(id);
const thumb=(p,sm)=>p&&p.imageId?`<img class="thumb${sm?" sm":""}" src="${imgUrl(p.imageId)}" alt="" loading="lazy">`:`<span class="thumb ph${sm?" sm":""}" aria-hidden="true">No photo</span>`;
const activeDealers=()=>[...S.dealers.entries()].filter(([,d])=>d.active!==false).sort((a,b)=>a[1].name.localeCompare(b[1].name));
const activeProducts=()=>[...S.products.entries()].filter(([,p])=>p.active!==false).sort((a,b)=>a[1].name.localeCompare(b[1].name));
async function shrinkImage(file){
  try{ const bmp=await createImageBitmap(file); const s=Math.min(1,900/Math.max(bmp.width,bmp.height));
    const c=document.createElement("canvas"); c.width=Math.round(bmp.width*s); c.height=Math.round(bmp.height*s);
    c.getContext("2d").drawImage(bmp,0,0,c.width,c.height);
    return await new Promise(res=>c.toBlob(b=>res(b||file),"image/jpeg",0.85)); }catch(e){ return file; }
}
function errMsg(e){
  if(e&&e.userMsg) return e.userMsg;
  if(e&&e.code==="invalid_argument") return "You don't have permission to change this. Ask the ledger owner for Contributor or Editor access.";
  if(e&&e.code==="quota_exceeded") return "The ledger is full. Download a backup, then remove old example or test records.";
  if(e&&e.code==="rate_limited") return "Too many changes at once. Wait a moment and try again.";
  return "Couldn't save. Check your connection and try again.";
}
async function guarded(btn,fn){
  const label=btn&&btn.textContent; if(btn) btn.disabled=true;
  try{ await fn(); }catch(e){ console.error(e); toast(errMsg(e),"error"); if(btn&&btn.isConnected){ btn.disabled=false; btn.textContent=label; } }
}
function armed(btn,label){ if(btn.dataset.armed) return true; btn.dataset.armed="1"; const old=btn.textContent; btn.textContent=label; setTimeout(()=>{ if(btn.isConnected){ delete btn.dataset.armed; btn.textContent=old; } },4000); return false; }
async function save(name,data){ if(!downloads){ toast("Downloads aren't available here."); return; } try{ await downloads.save({filename:name,data}); toast("File saved"); return true; }catch(e){ if(!e||e.code!=="declined") toast("Couldn't save the file."); } }
const csv=rows=>rows.map(r=>r.map(v=>`"${String(v??"").replace(/"/g,'""')}"`).join(",")).join("\n");
async function resolveNames(ids){
  if(!userNs) return; const need=[...new Set(ids.filter(Boolean))].filter(id=>!(id in S.names)); if(!need.length) return;
  need.forEach(id=>S.names[id]=S.names[id]||"");
  try{ const ps=await userNs.profiles(need); let ch=false; need.forEach(id=>{ const n=ps&&ps[id]&&ps[id].name; if(n){ S.names[id]=(id===S.me?n+" (you)":n); ch=true; } }); if(ch) paintSheet(true,true); }catch(e){}
}

/* ================= main views ================= */
function render(){
  const collapsed=lsGet("sidebarCollapsed")==="true";
  document.body.classList.toggle("nav-collapsed",collapsed);
  const toggle=$("#sidebarToggle");if(toggle){toggle.setAttribute("aria-expanded",String(!collapsed));toggle.title=collapsed?"Expand sidebar":"Collapse sidebar";toggle.setAttribute("aria-label",toggle.title);}
  $$(".sidebar .tab").forEach(b=>{if(!b.querySelector(".nav-icon")){const badge=b.querySelector(".pill");const label=VIEW_L[b.dataset.view]||b.textContent.trim();b.title=label;b.setAttribute("aria-label",label);b.innerHTML=`<span class="nav-icon" aria-hidden="true">${ICON[b.dataset.view]||ICON.overview}</span><span class="nav-label">${esc(label)}</span>`;if(badge)b.appendChild(badge);}});
  $$(".tab").forEach(b=>b.setAttribute("aria-current",b.dataset.view===S.view?"page":"false"));
  $("#topActions").hidden=!S.canWrite;
  $("#storeName").textContent=storeName();
  { const n=activeOrders().filter(([,o])=>o.status==="new").length; const b=$("#ordBadge"); b.hidden=!n; b.textContent=n; $("#ordersTab").hidden=!window.APP; }
  const closingTab=$('.sidebar [data-view="closing"]');if(closingTab)closingTab.hidden=!S.canAdmin;
  const bankTab=$('.sidebar [data-view="bank"]');if(bankTab)bankTab.hidden=!S.canAdmin;
  const periodsTab=$('.sidebar [data-view="periods"]');if(periodsTab)periodsTab.hidden=!S.canAdmin;
  const duplicatesTab=$('.sidebar [data-view="duplicates"]');if(duplicatesTab)duplicatesTab.hidden=!S.canAdmin;
  renderBottomNav();
  if(!db||!Object.values(S.loaded).every(Boolean)) return;
  const act=document.activeElement, fid=act&&act.closest&&act.closest("#main")&&act.id, pos=act&&act.selectionStart;
  const mainEl=$("#main"); if(S._lastView!==S.view){ S._lastView=S.view; mainEl.classList.remove("view-in"); void mainEl.offsetWidth; mainEl.classList.add("view-in"); }
  $("#main").innerHTML=`<div class="page-heading"><h2>${esc(VIEW_L[S.view]||"Dashboard")}</h2><p>${esc(storeName())} / ${esc(VIEW_L[S.view]||"Dashboard")}</p></div>`+({dashboard:vDashboard,overview:vOverview,orders:vOrders,collect:vCollect,dealers:vDealers,products:vProducts,stock:vStockHistory,profit:vProfit,purchases:vPurchases,expenses:vExpenses,reorder:vReorder,losses:vLosses,controls:vControls,closing:vClosing,shifts:vShifts,periods:vPeriods,duplicates:vDuplicates,suppliers:vSuppliers,bank:vBank,reminders:vReminders,deliveries:vDeliveries,batches:vBatches,refunds:vRefunds,activity:vActivity,reports:vReports,store:vStore}[S.view]||vOverview)();
  if(S.view==="reports") mountTrend();
  if(S.view==="duplicates"&&S.canAdmin&&!S.duplicates&&!S.duplicatesError&&!S._dupeLoading)loadDuplicates();
  if(fid){ const el=document.getElementById(fid); if(el){ el.focus(); try{ if(pos!=null) el.setSelectionRange(pos,pos);}catch(e){} } }
}
function sampleBanner(){
  const any=[S.dealers,S.products,S.txns,S.moves].some(m=>[...m.values()].some(x=>x.sample));
  if(!any||!S.canWrite) return "";
  return `<div class="notice info"><p><b>These are example records</b> showing how the ledger works. Remove them before entering your real dealers and products.</p><button class="btn sm" data-act="clear-samples" type="button">Remove examples</button></div>`;
}
function emptyStart(){
  return `<section class="panel"><div class="empty"><h3>Start your ledger</h3><p>Add your dealers and products, then record each credit sale and payment. Balances, due dates and overdue accounts are worked out for you.</p>
  ${S.canWrite?`<div class="actions" style="justify-content:center;margin-top:12px"><button class="btn primary" data-act="new-dealer" type="button">Add a dealer</button><button class="btn" data-act="new-product" type="button">Add a product</button></div>`:""}</div></section>`;
}
/* ---------- supplier directory, reminders, batches, reconciliation and proof ---------- */
function supplierFor(p){return p.supplierId||[...S.suppliers].find(([,s])=>[s.name,...(s.aliases||[])].some(n=>n.toLowerCase()===String(p.supplier||"").toLowerCase()))?.[0]||"name:"+String(p.supplier||"").toLowerCase();}
function vSuppliers(){const rows=[...S.suppliers].sort((a,b)=>a[1].name.localeCompare(b[1].name));return `<section class="panel"><div class="panel-head"><h2>Supplier directory</h2>${S.canWrite?`<button class="btn primary" data-act="new-supplier" type="button">Add supplier</button>`:""}</div>${rows.length?`<div class="tbl-wrap"><table><thead><tr><th>Supplier</th><th>Contact</th><th>Payment terms</th><th class="r">Net unpaid / credit</th><th></th></tr></thead><tbody>${rows.map(([id,s])=>{const purchases=[...S.purchases.values()].filter(p=>supplierFor(p)===id),balance=purchases.reduce((n,p)=>n+supplierBill(p)-supplierPaid(p),0);return `<tr><td><b>${esc(s.name)}</b>${s.active===false?` <span class="pill neutral">Archived</span>`:""}<div class="small muted">${esc(s.address)}</div></td><td>${esc(s.contactPerson)}<div class="small">${esc(s.phone)} ${esc(s.email)}</div></td><td>${s.paymentTerms} days</td><td class="r num">${balance<0?"Credit ":""}${P(Math.abs(balance))}</td><td><button class="btn sm" data-act="view-supplier" data-id="${esc(id)}" type="button">Open</button></td></tr>`;}).join("")}</tbody></table></div>`:`<p class="small muted">Add supplier contacts and terms, then select them when creating purchase orders.</p>`}</section>`;}
function supplierForm(id){const old=S.suppliers.get(id),ref=db.collection("suppliers").doc(id||undefined);show(()=>[head(old?"Edit supplier":"Add supplier")+`<form id="supplier-form" class="form-grid"><label class="f span">Supplier name<input id="su-name" required maxlength="160" value="${esc(old?.name||"")}"></label><label class="f">Contact person<input id="su-contact" maxlength="160" value="${esc(old?.contactPerson||"")}"></label><label class="f">Phone<input id="su-phone" type="tel" value="${esc(old?.phone||"")}"></label><label class="f">Email<input id="su-email" type="email" value="${esc(old?.email||"")}"></label><label class="f">Payment terms (days)<input id="su-terms" type="number" min="0" max="365" step="1" required value="${old?.paymentTerms??30}"></label><label class="f span">Address<input id="su-address" value="${esc(old?.address||"")}"></label><label class="f span">Notes<textarea id="su-notes">${esc(old?.notes||"")}</textarea></label>${old?`<label class="chk span"><input id="su-active" type="checkbox" ${old.active!==false?"checked":""}> Active supplier</label>`:""}<button class="btn primary" type="submit">Save supplier</button></form>`,sh=>$("#supplier-form",sh).addEventListener("submit",e=>{e.preventDefault();guarded(e.submitter,async()=>{await ref.set({name:$("#su-name",sh).value.trim(),contactPerson:$("#su-contact",sh).value.trim(),phone:$("#su-phone",sh).value.trim(),email:$("#su-email",sh).value.trim(),address:$("#su-address",sh).value.trim(),paymentTerms:Number($("#su-terms",sh).value),notes:$("#su-notes",sh).value.trim(),active:!old||$("#su-active",sh).checked},{version:old?._version});toast("Supplier saved");back();});})]);}
function supplierSheet(id){show(()=>{const s=S.suppliers.get(id),orders=[...S.purchases].filter(([,p])=>supplierFor(p)===id);return [head(esc(s.name))+`<dl class="kv"><dt>Contact</dt><dd>${esc(s.contactPerson||"—")}</dd><dt>Phone</dt><dd>${esc(s.phone||"—")}</dd><dt>Email</dt><dd>${esc(s.email||"—")}</dd><dt>Address</dt><dd>${esc(s.address||"—")}</dd><dt>Payment terms</dt><dd>${s.paymentTerms} days</dd></dl><p>${esc(s.notes)}</p><div class="actions">${S.canAdmin?`<button class="btn" data-act="edit-supplier" data-id="${esc(id)}" type="button">Edit / archive supplier</button>`:""}${S.canWrite&&s.active!==false?`<button class="btn primary" data-act="purchase-supplier" data-id="${esc(id)}" type="button">New purchase order</button>`:""}</div><h3 style="margin-top:20px">Purchase history</h3>${orders.map(([pid,p])=>`<p><button class="btn sm" data-act="view-purchase" data-id="${esc(pid)}" type="button">${esc(p.no)}</button> ${fmtDate(p.date)} · ${esc(p.status)} · Balance ${P(supplierBill(p)-supplierPaid(p))}</p>`).join("")||`<p class="small muted">No purchases yet.</p>`}`];},true);}
function applySupplierCreditForm(sourceId){const source=S.purchases.get(sourceId),credit=r2(supplierPaid(source)-supplierBill(source)),targets=[...S.purchases].filter(([id,p])=>id!==sourceId&&supplierFor(p)===supplierFor(source)&&supplierBill(p)>supplierPaid(p));show(()=>[head("Apply supplier credit",P(credit)+" available")+`<form id="apply-credit" class="form-grid"><label class="f span">Purchase bill to pay<select id="ac-target" required><option value="">Choose unpaid bill…</option>${targets.map(([id,p])=>`<option value="${esc(id)}">${esc(p.no)} · ${P(supplierBill(p)-supplierPaid(p))} unpaid</option>`).join("")}</select></label><label class="f">Date<input id="ac-date" type="date" required max="${today()}" value="${today()}"></label><label class="f">Amount (₱)<input id="ac-amount" type="number" min="0.01" max="${credit}" step="0.01" required></label><label class="f span">Note<input id="ac-note"></label><p class="small muted span">This transfers existing supplier credit between bills. It is not a cash payment.</p><button class="btn primary" type="submit">Apply credit</button></form>`,sh=>$("#apply-credit",sh).addEventListener("submit",e=>{e.preventDefault();guarded(e.submitter,async()=>{const targetId=$("#ac-target",sh).value;await window.APP.request("POST","/api/supplier-applications",{sourceId,targetId,sourceVersion:source._version,targetVersion:S.purchases.get(targetId)?._version,date:$("#ac-date",sh).value,amount:Number($("#ac-amount",sh).value),note:$("#ac-note",sh).value.trim()});toast("Supplier credit applied");back();});})]);}
function supplierApplicationHistory(id,p){const entries=[...(p.applicationsIn||[]),...(p.applicationsOut||[])];return `<section class="panel" style="margin-top:16px"><div class="panel-head"><h3>Credit applications</h3>${S.canAdmin&&supplierPaid(p)>supplierBill(p)?`<button class="btn sm" data-act="apply-supplier-credit" data-id="${esc(id)}" type="button">Apply credit to another bill</button>`:""}</div>${entries.map(e=>`<p>${fmtDate(e.date)} · ${P(e.amount)} · ${e.sourceId===id?"To "+esc(S.purchases.get(e.targetId)?.no||"purchase"):"From "+esc(S.purchases.get(e.sourceId)?.no||"purchase")}${e.voided?" · Voided":S.canAdmin?` <button class="btn sm" data-act="void-credit-application" data-id="${esc(e.id)}" type="button">Void</button>`:""}</p>`).join("")||`<p class="small muted">No credit applications.</p>`}</section>`;}
function voidCreditApplication(id){const e=S.supplierApplications.get(id);show(()=>[head("Void supplier credit application")+`<form id="void-application"><label class="f">Reason<input id="va-reason" required></label><button class="btn danger" type="submit">Void application</button></form>`,sh=>$("#void-application",sh).addEventListener("submit",event=>{event.preventDefault();guarded(event.submitter,async()=>{await window.APP.request("POST",`/api/supplier-applications/${encodeURIComponent(id)}/void`,{version:e._version,sourceVersion:S.purchases.get(e.sourceId)?._version,targetVersion:S.purchases.get(e.targetId)?._version,reason:$("#va-reason",sh).value.trim()});toast("Credit application voided");back();});})]);}
function vBatches(){const date=today(),limit=addDays(date,30),rows=[...S.batches].filter(([,b])=>(!S.batchProduct||b.productId===S.batchProduct)&&(S.batchFilter==="all"||S.batchFilter==="expired"&&b.expiryDate&&b.expiryDate<date&&b.remainingQty>0||S.batchFilter==="expiring"&&b.expiryDate&&b.expiryDate>=date&&b.expiryDate<=limit&&b.remainingQty>0||S.batchFilter==="unknown"&&!b.expiryDate&&b.remainingQty>0)).sort((a,b)=>(a[1].expiryDate||"9999").localeCompare(b[1].expiryDate||"9999"));return `<section class="panel"><div class="panel-head"><h2>Batches and expiry</h2>${S.canAdmin&&[...S.products.values()].some(p=>!p.batchTracked)?`<button class="btn" data-act="initialize-batches" type="button">Classify existing stock</button>`:""}${S.canWrite?`<button class="btn" data-act="stock-in" type="button">Receive stock</button>`:""}</div><p class="small muted">Sales use the earliest-expiring unexpired stock first. Expired units remain on hand but cannot be sold. Opening stock has unknown batch details until updated.</p><div class="toolbar"><label class="f">Product<select id="batch-product"><option value="">All products</option>${[...S.products].map(([id,p])=>`<option value="${esc(id)}" ${id===S.batchProduct?"selected":""}>${esc(p.name)}</option>`).join("")}</select></label><label class="f">Show<select id="batch-filter">${[["all","All batches"],["expiring","Expires within 30 days"],["expired","Expired stock"],["unknown","Unknown expiry"]].map(([v,l])=>`<option value="${v}" ${S.batchFilter===v?"selected":""}>${l}</option>`).join("")}</select></label></div>${rows.length?`<div class="tbl-wrap"><table><thead><tr><th>Product / batch</th><th>Expiry</th><th class="r">Remaining</th><th>Source</th><th></th></tr></thead><tbody>${rows.slice(0,300).map(([id,b])=>`<tr><td><b>${esc(S.products.get(b.productId)?.name||b.productId)}</b><div class="small">${esc(b.code)}</div></td><td>${b.expiryDate?fmtDate(b.expiryDate):"Unknown"}${b.expiryDate&&b.expiryDate<date&&b.remainingQty>0?` <span class="pill bad">Expired</span>`:""}</td><td class="r num">${b.remainingQty}</td><td>${esc(b.reference||b.source)}</td><td>${S.canAdmin?`<button class="btn sm" data-act="edit-batch" data-id="${esc(id)}" type="button">Edit details</button>`:""}</td></tr>`).join("")}</tbody></table></div>`:`<p class="small muted">No matching batches. Existing stock is classified when its next movement is recorded.</p>`}</section>`;}
function initializeBatchesForm(){show(()=>[head("Classify existing stock")+`<form id="initialize-batches" class="form-grid"><label class="f span">Product<select id="ib-product">${[...S.products].filter(([,p])=>!p.batchTracked).map(([id,p])=>`<option value="${esc(id)}">${esc(p.name)} · ${p.stock} on hand</option>`).join("")}</select></label><label class="f">Batch code<input id="ib-code" placeholder="Opening / legacy stock"></label><label class="f">Expiry date<input id="ib-expiry" type="date"></label><p class="small muted span">Classifies current stock without changing its quantity or value. Leave expiry blank when unknown.</p><button class="btn primary" type="submit">Classify stock</button></form>`,sh=>$("#initialize-batches",sh).addEventListener("submit",e=>{e.preventDefault();guarded(e.submitter,async()=>{const id=$("#ib-product",sh).value;await window.APP.request("POST","/api/batches/initialize",{productId:id,version:S.products.get(id)._version,code:$("#ib-code",sh).value.trim(),expiryDate:$("#ib-expiry",sh).value||null});toast("Existing stock classified");back();});})]);}
function batchForm(id){const b=S.batches.get(id);show(()=>[head("Edit batch details")+`<form id="batch-form" class="form-grid"><label class="f span">Batch code<input id="bt-code" required maxlength="160" value="${esc(b.code)}"></label><label class="f">Expiry date<input id="bt-expiry" type="date" value="${b.expiryDate||""}"></label><p class="small muted span">This changes the label and expiry only. Use a stock adjustment to change quantities.</p><button class="btn primary" type="submit">Save batch details</button></form>`,sh=>$("#batch-form",sh).addEventListener("submit",e=>{e.preventDefault();guarded(e.submitter,async()=>{await window.APP.request("PATCH",`/api/batches/${encodeURIComponent(id)}`,{version:b._version,code:$("#bt-code",sh).value.trim(),expiryDate:$("#bt-expiry",sh).value||null});toast("Batch details saved");back();});})]);}
function reminderPromise(id){const promises=[...S.reminders.values()].filter(r=>r.dealerId===id).sort((a,b)=>b.createdAt-a.createdAt),last=promises[0];if(!last||last.outcome!=="Promise to pay")return null;const paid=[...S.txns.values()].filter(t=>!t.voided&&t.type==="payment"&&t.dealerId===id&&t.createdAt>=last.createdAt&&t.date>=last.date).reduce((n,t)=>n+t.amount,0);return {...last,remaining:Math.max(0,r2(last.promiseAmount-paid))};}
function vReminders(){const rows=activeDealers().map(([id,d])=>({id,d,st:status(id),promise:reminderPromise(id)})).filter(r=>r.st.balance>0&&(S.reminderFilter==="all"||S.reminderFilter==="overdue"&&r.st.overdue>0||S.reminderFilter==="upcoming"&&r.st.nextDue&&r.st.nextDue<=addDays(today(),7)||S.reminderFilter==="promises"&&r.promise?.remaining>0));return `<section class="panel"><h2>Collection reminders</h2><p class="small muted">Copy a reminder to send yourself, then record the contact and any promise to pay. Messages are not sent automatically.</p><div class="toolbar"><label class="f">Show<select id="reminder-filter">${[["overdue","Overdue balances"],["upcoming","Due within 7 days"],["promises","Open promises to pay"],["all","All outstanding balances"]].map(([v,l])=>`<option value="${v}" ${S.reminderFilter===v?"selected":""}>${l}</option>`).join("")}</select></label></div>${rows.length?`<div class="tbl-wrap"><table><thead><tr><th>Dealer</th><th class="r">Balance / overdue</th><th>Next due / promise</th><th>Actions</th></tr></thead><tbody>${rows.map(({id,d,st,promise})=>`<tr><td><button class="btn sm" data-dealer="${esc(id)}" type="button">${esc(d.name)}</button><div class="small">${esc(d.phone||"")}</div></td><td class="r num">${P(st.balance)}<div class="small">${P(st.overdue)} overdue</div></td><td>${st.nextDue?fmtDate(st.nextDue):"—"}${promise?.remaining>0?`<div class="small ${promise.promiseDate<today()?"bad-t":""}">Promised ${P(promise.remaining)} by ${fmtDate(promise.promiseDate)}</div>`:""}</td><td><div class="actions"><button class="btn sm" data-act="remind-copy" data-id="${esc(id)}" type="button">Copy reminder</button>${S.canWrite?`<button class="btn sm" data-act="record-contact" data-id="${esc(id)}" type="button">Record contact</button>`:""}<button class="btn sm" data-act="contact-history" data-id="${esc(id)}" type="button">History</button></div></td></tr>`).join("")}</tbody></table></div>`:`<p class="small muted">No dealers match this list.</p>`}</section>`;}
function contactForm(id){show(()=>[head("Record collection contact",esc(S.dealers.get(id)?.name))+`<form id="contact-form" class="form-grid"><label class="f">Contact date<input id="ct-date" type="date" required max="${today()}" value="${today()}"></label><label class="f">Channel<select id="ct-channel">${["Call","SMS","Messenger","Email","In person","Other"].map(m=>`<option>${m}</option>`).join("")}</select></label><label class="f span">Outcome<select id="ct-outcome">${["Reminder recorded","No answer","Promise to pay","Follow up"].map(m=>`<option>${m}</option>`).join("")}</select></label><div id="ct-promise" class="span form-grid" hidden><label class="f">Promised date<input id="ct-pdate" type="date"></label><label class="f">Promised amount (₱)<input id="ct-amount" type="number" min="0.01" step="0.01"></label></div><label class="f span">Note<textarea id="ct-note" required></textarea></label><button class="btn primary" type="submit">Save contact</button></form>`,sh=>{$("#ct-outcome",sh).addEventListener("change",()=>$("#ct-promise",sh).hidden=$("#ct-outcome",sh).value!=="Promise to pay");$("#contact-form",sh).addEventListener("submit",e=>{e.preventDefault();guarded(e.submitter,async()=>{await window.APP.request("POST","/api/reminders",{dealerId:id,date:$("#ct-date",sh).value,channel:$("#ct-channel",sh).value,outcome:$("#ct-outcome",sh).value,promiseDate:$("#ct-pdate",sh).value,promiseAmount:Number($("#ct-amount",sh).value),note:$("#ct-note",sh).value.trim()});toast("Collection contact recorded");back();});});}]);}
function contactHistory(id){show(()=>[head("Collection contact history",esc(S.dealers.get(id)?.name))+[...S.reminders.values()].filter(r=>r.dealerId===id).sort((a,b)=>b.createdAt-a.createdAt).map(r=>`<section class="panel" style="margin-bottom:12px"><b>${fmtDate(r.date)} · ${esc(r.channel)} · ${esc(r.outcome)}</b><p>${esc(r.note)}</p>${r.promiseDate?`<p>Promised ${P(r.promiseAmount)} by ${fmtDate(r.promiseDate)}</p>`:""}<p class="small muted">${esc(nameOf(r.createdBy))} · ${fmtStamp(r.createdAt)}</p></section>`).join("")]);}
function vDeliveries(){const rows=[...S.txns].filter(([,t])=>t.type==="sale"&&!t.opening&&!t.voided&&t.items?.length).sort((a,b)=>b[1].createdAt-a[1].createdAt);return `<section class="panel"><h2>Delivery confirmations</h2><p class="small muted">Record the recipient, delivery date and signature, with an optional proof photo. A changed or voided sale makes its confirmation need review.</p>${rows.length?`<div class="tbl-wrap"><table><thead><tr><th>Sale / dealer</th><th>Status</th><th>Recipient / date</th><th></th></tr></thead><tbody>${rows.map(([id,t])=>{const delivery=[...S.deliveries].find(([,d])=>d.saleId===id),d=delivery?.[1];return `<tr><td>${esc(t.no)}<div>${esc(S.dealers.get(t.dealerId)?.name||"")}</div></td><td>${esc(d?.status||"Not confirmed")}</td><td>${esc(d?.recipient||"—")} ${d?.date?fmtDate(d.date):""}</td><td>${d?`<button class="btn sm" data-act="view-delivery" data-id="${esc(delivery[0])}" type="button">View proof</button>`:""}${S.canWrite?` <button class="btn sm" data-act="confirm-delivery" data-id="${esc(id)}" type="button">${d?"Replace confirmation":"Confirm delivery"}</button>`:""}</td></tr>`;}).join("")}</tbody></table></div>`:`<p class="small muted">Itemized credit sales will appear here.</p>`}</section>`;}
function deliveryForm(saleId){const sale=S.txns.get(saleId),old=[...S.deliveries.values()].find(d=>d.saleId===saleId);show(()=>[head("Confirm delivery",esc(sale.no))+`<form id="delivery-form" class="form-grid"><label class="f">Recipient<input id="dv-recipient" required maxlength="160" value="${esc(old?.recipient||S.dealers.get(sale.dealerId)?.name||"")}"></label><label class="f">Delivered date<input id="dv-date" type="date" required min="${sale.date}" max="${today()}" value="${today()}"></label><div class="f span"><span>Recipient signature</span><canvas id="dv-signature" width="600" height="200" style="width:100%;height:160px;border:1px solid var(--line);background:#fff;touch-action:none;border-radius:8px" aria-label="Draw recipient signature"></canvas><button class="btn sm" type="button" id="dv-clear">Clear signature</button></div><label class="f span">Proof photo (optional)<input id="dv-photo" type="file" accept="image/*"></label><label class="f span">Note<input id="dv-note" value="${esc(old?.note||"")}"></label>${old?`<label class="f span">Reason for replacing confirmation<input id="dv-reason" required></label>`:""}<button class="btn primary" type="submit">Save delivery confirmation</button></form>`,sh=>{const canvas=$("#dv-signature",sh),ctx=canvas.getContext("2d");let drawing=false,signed=false;ctx.fillStyle="#fff";ctx.fillRect(0,0,canvas.width,canvas.height);ctx.strokeStyle="#111";ctx.lineWidth=3;ctx.lineCap="round";const point=e=>{const r=canvas.getBoundingClientRect();return [(e.clientX-r.left)*canvas.width/r.width,(e.clientY-r.top)*canvas.height/r.height];};canvas.addEventListener("pointerdown",e=>{e.preventDefault();drawing=true;signed=true;try{canvas.setPointerCapture(e.pointerId);}catch(_){}ctx.beginPath();ctx.moveTo(...point(e));});canvas.addEventListener("pointermove",e=>{if(drawing){e.preventDefault();ctx.lineTo(...point(e));ctx.stroke();}});canvas.addEventListener("pointerup",()=>drawing=false);canvas.addEventListener("pointercancel",()=>drawing=false);$("#dv-clear",sh).addEventListener("click",()=>{ctx.fillRect(0,0,canvas.width,canvas.height);signed=false;});$("#delivery-form",sh).addEventListener("submit",e=>{e.preventDefault();if(!signed){toast("Ask the recipient to sign before saving");return;}guarded(e.submitter,async()=>{const signature=await new Promise(resolve=>canvas.toBlob(resolve,"image/png")),uploaded=await assets.upload(signature),file=$("#dv-photo",sh).files[0],proof=file?await assets.upload(await shrinkImage(file)):null;await window.APP.request("POST","/api/deliveries",{saleId,saleVersion:sale._version,version:old?._version,recipient:$("#dv-recipient",sh).value.trim(),date:$("#dv-date",sh).value,signatureAssetId:uploaded.id,proofAssetId:proof?.id||old?.proofAssetId||null,note:$("#dv-note",sh).value.trim(),reason:$("#dv-reason",sh)?.value.trim()});toast("Delivery confirmed");back();});});}]);}
function deliverySheet(id){show(()=>{const d=S.deliveries.get(id);return [head("Delivery proof",esc(S.txns.get(d.saleId)?.no||""))+`<dl class="kv"><dt>Status</dt><dd>${esc(d.status)}</dd><dt>Recipient</dt><dd>${esc(d.recipient)}</dd><dt>Date</dt><dd>${fmtDate(d.date)}</dd><dt>Recorded by</dt><dd>${esc(nameOf(d.createdBy))} · ${fmtStamp(d.createdAt)}</dd></dl><h3>Signature</h3><img src="${imgUrl(d.signatureAssetId)}" alt="Recipient signature" style="max-height:200px;background:#fff">${d.proofAssetId?`<h3>Proof photo</h3><a href="${imgUrl(d.proofAssetId)}" target="_blank" rel="noopener"><img src="${imgUrl(d.proofAssetId)}" alt="Delivery proof" style="max-height:300px"></a>`:""}<p>${esc(d.note||"")}</p>${S.canWrite&&!d.voided?`<button class="btn danger" data-act="void-delivery" data-id="${esc(id)}" type="button">Void confirmation</button>`:""}${d.history?.length?`<p class="small muted">${d.history.length} earlier confirmation(s) retained.</p>`:""}`];},true);}
function voidDelivery(id){const d=S.deliveries.get(id);show(()=>[head("Void delivery confirmation")+`<form id="void-delivery"><label class="f">Reason<input id="vd-reason" required></label><button class="btn danger" type="submit">Void confirmation</button></form>`,sh=>$("#void-delivery",sh).addEventListener("submit",e=>{e.preventDefault();guarded(e.submitter,async()=>{await window.APP.request("POST",`/api/deliveries/${encodeURIComponent(id)}/void`,{version:d._version,reason:$("#vd-reason",sh).value.trim()});toast("Delivery confirmation voided");back();});})]);}
function vRefunds(){const rows=[...S.txns].filter(([,t])=>t.type==="refund").sort((a,b)=>b[1].createdAt-a[1].createdAt);return `<section class="panel"><div class="panel-head"><h2>Customer refunds</h2>${S.canAdmin?`<button class="btn primary" data-act="new-customer-refund" type="button">Record refund paid</button>`:""}</div><p class="small muted">Refund available dealer credit after returns or overpayment. This records actual money paid out and reduces the remaining credit; it does not reduce sales revenue a second time.</p>${rows.length?`<div class="tbl-wrap"><table><thead><tr><th>Date / reference</th><th>Dealer</th><th>Method</th><th class="r">Amount paid out</th><th></th></tr></thead><tbody>${rows.map(([id,t])=>`<tr class="${t.voided?"void":""}"><td>${fmtDate(t.date)}<div>${esc(t.no)}</div>${t.voided?`<span class="pill neutral">Voided</span>`:""}</td><td>${esc(S.dealers.get(t.dealerId)?.name||"")}</td><td>${esc(t.method)}</td><td class="r num">${P(t.amount)}</td><td><button class="btn sm" data-act="receipt" data-id="${esc(id)}" type="button">Receipt</button>${S.canAdmin&&!t.voided?` <button class="btn sm" data-act="void-customer-refund" data-id="${esc(id)}" type="button">Void</button>`:""}</td></tr>`).join("")}</tbody></table></div>`:`<p class="small muted">No customer refunds recorded.</p>`}</section>`;}
function customerRefundForm(dealerId){show(()=>[head("Customer refund paid")+`<form id="refund-form" class="form-grid"><label class="f span">Dealer<select id="cu-dealer" required><option value="">Choose dealer…</option>${activeDealers().filter(([id])=>status(id).balance<0).map(([id,d])=>`<option value="${esc(id)}" ${dealerId===id?"selected":""}>${esc(d.name)} · ${P(-status(id).balance)} credit</option>`).join("")}</select></label><label class="f">Date paid<input id="cu-date" type="date" required max="${today()}" value="${today()}"></label><label class="f">Amount paid (₱)<input id="cu-amount" type="number" min="0.01" step="0.01" required></label><label class="f">Method<select id="cu-method">${METHODS.map(m=>`<option>${m}</option>`).join("")}</select></label><label class="f">Payment reference<input id="cu-ref"></label><label class="f span">Related return (optional)<select id="cu-return"><option value="">Overpayment / general credit</option></select></label><label class="f span">Reason<input id="cu-reason" required></label><button class="btn primary" type="submit">Record refund paid</button></form>`,sh=>{const update=()=>{const id=$("#cu-dealer",sh).value;$("#cu-amount",sh).max=String(Math.max(0,-status(id).balance));$("#cu-return",sh).innerHTML=`<option value="">Overpayment / general credit</option>`+[...S.txns].filter(([,t])=>t.type==="return"&&!t.voided&&t.dealerId===id).map(([id,t])=>`<option value="${esc(id)}">${esc(t.no)} · ${P(t.amount)}</option>`).join("");};$("#cu-dealer",sh).addEventListener("change",update);if(dealerId)update();$("#refund-form",sh).addEventListener("submit",e=>{e.preventDefault();guarded(e.submitter,async()=>{await window.APP.request("POST","/api/customer-refunds",{dealerId:$("#cu-dealer",sh).value,date:$("#cu-date",sh).value,amount:Number($("#cu-amount",sh).value),method:$("#cu-method",sh).value,reference:$("#cu-ref",sh).value.trim(),sourceReturnId:$("#cu-return",sh).value||null,reason:$("#cu-reason",sh).value.trim()});toast("Customer refund recorded");back();});});}]);}
function voidCustomerRefund(id){const t=S.txns.get(id);show(()=>[head("Void customer refund")+`<form id="void-customer-refund"><label class="f">Reason<input id="vr-reason" required></label><button class="btn danger" type="submit">Void refund</button></form>`,sh=>$("#void-customer-refund",sh).addEventListener("submit",e=>{e.preventDefault();guarded(e.submitter,async()=>{await window.APP.request("POST",`/api/customer-refunds/${encodeURIComponent(id)}/void`,{version:t._version,reason:$("#vr-reason",sh).value.trim()});toast("Customer refund voided");back();});})]);}
function refundReceiptSheet(id){show(()=>{const t=S.txns.get(id),dealer=S.dealers.get(t.dealerId);return [head("Customer refund receipt")+`<button class="btn" type="button" id="refund-print">Print</button><article class="receipt"><h2>${esc(storeName())}</h2><h3>CUSTOMER REFUND · ${esc(t.no)}</h3>${t.voided?`<p>VOIDED</p>`:""}<dl class="kv"><dt>Dealer</dt><dd>${esc(dealer?.name||"")}</dd><dt>Date paid</dt><dd>${fmtDate(t.date)}</dd><dt>Amount refunded</dt><dd>${P(t.amount)}</dd><dt>Method</dt><dd>${esc(t.method)}</dd><dt>Reference</dt><dd>${esc(t.ref||"—")}</dd><dt>Reason</dt><dd>${esc(t.note)}</dd></dl></article>`,sh=>$("#refund-print",sh).addEventListener("click",()=>window.print())];},true);}
function attachmentsMarkup(attachments){return (attachments||[]).map(a=>`<a href="${imgUrl(a.id)}" target="_blank" rel="noopener">${esc(a.name||"Receipt")}</a>`).join(" · ");}
async function expenseDocuments(sh,old){const kept=(old?.attachments||[]).filter(a=>!$$("[data-remove-attachment]",sh).some(i=>i.checked&&i.dataset.removeAttachment===a.id)),files=[...$("#ex-files",sh).files];if(kept.length+files.length>5)throw {userMsg:"Attach up to five files per expense."};for(const f of files){const file=f.type.startsWith("image/")?await shrinkImage(f):f,uploaded=await window.APP.uploadDocument(file,file.type||f.type||"application/pdf");kept.push({id:uploaded.id,name:f.name});}return kept;}
function bankLedgerEvents(){return LedgerInsights.bankEvents([...S.txns],[...S.expenses],[...S.purchases]);}
function bankLineStatus(line,events){return line.status==="matched"&&(line.matches||[]).some(m=>events.find(e=>e.id===m.id)?.stamp!==m.stamp)?"needs review":line.status;}
function vBank(){if(!S.canAdmin)return `<section class="panel">Bank reconciliation is available to the owner and editors.</section>`;const events=bankLedgerEvents(),rows=[...S.bankStatements].sort((a,b)=>b[1].createdAt-a[1].createdAt);return `<section class="panel" style="margin-bottom:16px"><div class="panel-head"><h2>Bank reconciliation</h2><div class="actions"><button class="btn primary" data-act="import-bank" type="button">Import statement CSV</button><button class="btn" data-act="export-bank" type="button">Export reconciliation CSV</button></div></div><p class="small muted">Match statement lines to recorded dealer collections, customer refunds, expenses and supplier payments/refunds. Matching does not create or change cash records. Changed ledger entries make existing matches need review.</p></section>${rows.map(([id,s])=>{const inflow=s.lines.filter(l=>l.amount>0).reduce((n,l)=>n+l.amount,0),outflow=-s.lines.filter(l=>l.amount<0).reduce((n,l)=>n+l.amount,0);return `<section class="panel" style="margin-bottom:16px"><div class="panel-head"><h2>${esc(s.bank)} · ${esc(s.method)}</h2><span class="small muted">${s.lines.length} lines · In ${P(inflow)} · Out ${P(outflow)}</span></div><div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Description / reference</th><th class="r">Signed amount</th><th>Status / ledger match</th><th></th></tr></thead><tbody>${s.lines.slice(0,300).map(l=>`<tr><td>${fmtDate(l.date)}</td><td>${esc(l.description)}<div class="small muted">${esc(l.reference)}</div></td><td class="r num">${P(l.amount)}</td><td><span class="pill ${bankLineStatus(l,events)==="matched"?"good":bankLineStatus(l,events)==="needs review"?"bad":"neutral"}">${esc(bankLineStatus(l,events))}</span><div class="small">${(l.matches||[]).map(m=>esc(m.label)).join(" · ")}</div>${l.note?`<div class="small muted">${esc(l.note)}</div>`:""}</td><td><button class="btn sm" data-act="match-bank" data-id="${esc(id)}" data-line="${esc(l.id)}" type="button">Review / match</button></td></tr>`).join("")}</tbody></table></div>${s.lines.length>300?`<p class="small muted">Showing 300 lines. Export includes all lines.</p>`:""}</section>`;}).join("")||`<section class="panel"><p class="small muted">No bank statements imported.</p></section>`}`;}
function bankCsvRows(value){const table=parseTable(value);if(table.length<2)return [];const h=table[0].map(x=>x.toLowerCase().trim()),index=(...names)=>h.findIndex(v=>names.includes(v)),date=index("date","transaction date","posting date"),amount=index("amount","signed amount"),credit=index("credit","deposit","money in"),debit=index("debit","withdrawal","money out"),description=index("description","details","narration"),reference=index("reference","reference no","reference number"),externalId=index("id","transaction id");if(date<0||amount<0&&credit<0&&debit<0)throw {userMsg:"CSV needs a Date column and Amount, or Credit and Debit columns."};const number=s=>{const raw=String(s||"").replace(/[₱,\s]/g,"");return raw===""?0:raw.startsWith("(")&&raw.endsWith(")")?-Number(raw.slice(1,-1)):Number(raw);};return table.slice(1).map(r=>({date:r[date],amount:amount>=0?number(r[amount]):number(r[credit])-number(r[debit]),description:r[description]||"",reference:r[reference]||"",externalId:r[externalId]||""}));}
function bankImportForm(){show(()=>[head("Import bank statement CSV")+`<form id="bank-import" class="form-grid"><label class="f">Bank / account label<input id="bi-bank" required placeholder="e.g. BDO business account"></label><label class="f">Ledger payment method<select id="bi-method">${METHODS.map(m=>`<option ${m==="Bank transfer"?"selected":""}>${m}</option>`).join("")}</select></label><label class="f span">CSV file<input id="bi-file" type="file" accept=".csv,text/csv"></label><label class="f span">CSV contents<textarea id="bi-text" rows="7" required placeholder="Date,Description,Reference,Amount&#10;2026-01-01,Dealer payment,DEP-001,500.00"></textarea><span class="hint">Use YYYY-MM-DD dates. Positive amounts are money in; negative amounts are money out. Credit and Debit columns are also supported. Existing identical lines are skipped.</span></label><div class="span" id="bi-preview"></div><div class="actions span"><button class="btn" id="bi-check" type="button">Preview rows</button><button class="btn primary" type="submit">Import statement</button></div></form>`,sh=>{const preview=()=>{try{const rows=bankCsvRows($("#bi-text",sh).value);$("#bi-preview",sh).innerHTML=`<p>${rows.length} statement rows</p><div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Description</th><th>Amount</th></tr></thead><tbody>${rows.slice(0,8).map(r=>`<tr><td>${esc(r.date)}</td><td>${esc(r.description)}</td><td>${Number.isFinite(r.amount)?P(r.amount):"Invalid amount"}</td></tr>`).join("")}</tbody></table></div>`;}catch(e){toast(e.userMsg||e.message,"error");}};$("#bi-file",sh).addEventListener("change",async e=>{if(e.target.files[0]){$("#bi-text",sh).value=await e.target.files[0].text();preview();}});$("#bi-check",sh).addEventListener("click",preview);$("#bank-import",sh).addEventListener("submit",e=>{e.preventDefault();guarded(e.submitter,async()=>{const result=await window.APP.request("POST","/api/bank/import",{bank:$("#bi-bank",sh).value.trim(),method:$("#bi-method",sh).value,lines:bankCsvRows($("#bi-text",sh).value)});toast(`Imported ${result.imported} bank lines; skipped ${result.duplicates} duplicates`);back();});});}]);}
function bankMatchForm(id,lineId){const statement=S.bankStatements.get(id),line=statement.lines.find(l=>l.id===lineId),used=new Set([...S.bankStatements].flatMap(([sid,s])=>s.lines.filter(l=>!(sid===id&&l.id===lineId)&&l.status==="matched").flatMap(l=>(l.matches||[]).map(m=>m.id)))),events=bankLedgerEvents().filter(e=>e.method===statement.method&&!used.has(e.id)),selected=new Set((line.matches||[]).map(m=>m.id));show(()=>[head("Match bank line",fmtDate(line.date)+" · "+P(line.amount))+`<p>${esc(line.description)} · ${esc(line.reference)}</p><form id="bank-match"><label class="f">Find a ledger entry<input id="bm-search" type="search" placeholder="Reference, invoice or category"></label><div id="bm-events" class="tbl-wrap" style="max-height:340px;overflow:auto"></div><p id="bm-total" role="status"></p><label class="f">Note / reason for ignoring<input id="bm-note" value="${esc(line.note||"")}"></label><div class="actions"><button class="btn primary" type="submit">Save match</button><button class="btn" id="bm-unmatch" type="button">Remove match</button><button class="btn" id="bm-ignore" type="button">Ignore with reason</button></div></form>`,sh=>{const total=()=>{$("#bm-total",sh).textContent=`Selected ${P(events.filter(e=>selected.has(e.id)).reduce((n,e)=>n+e.amount,0))} · Bank line ${P(line.amount)}`;};const draw=()=>{const q=$("#bm-search",sh).value.toLowerCase();$("#bm-events",sh).innerHTML=`<table><thead><tr><th>Select</th><th>Ledger entry</th><th>Date</th><th class="r">Amount</th></tr></thead><tbody>${events.filter(e=>[e.label,e.reference,e.date].join(" ").toLowerCase().includes(q)||selected.has(e.id)).sort((a,b)=>Math.abs(a.amount-line.amount)-Math.abs(b.amount-line.amount)).slice(0,200).map(e=>`<tr><td><input type="checkbox" data-bank-event="${esc(e.id)}" ${selected.has(e.id)?"checked":""} aria-label="Match ${esc(e.label)}"></td><td>${esc(e.label)}<div class="small muted">${esc(e.reference)}</div></td><td>${fmtDate(e.date)}</td><td class="r num">${P(e.amount)}</td></tr>`).join("")}</tbody></table>`;total();};draw();$("#bm-search",sh).addEventListener("input",draw);$("#bm-events",sh).addEventListener("change",e=>{const id=e.target.dataset.bankEvent;if(id){e.target.checked?selected.add(id):selected.delete(id);total();}});const post=(action,button)=>guarded(button,async()=>{await window.APP.request("POST",`/api/bank/${encodeURIComponent(id)}/lines/${encodeURIComponent(lineId)}`,{version:statement._version,action,eventIds:[...selected],note:$("#bm-note",sh).value.trim()});toast(action==="match"?"Bank line matched":action==="ignore"?"Bank line ignored":"Bank match removed");back();});$("#bank-match",sh).addEventListener("submit",e=>{e.preventDefault();post("match",e.submitter);});$("#bm-unmatch",sh).addEventListener("click",e=>post("unmatch",e.currentTarget));$("#bm-ignore",sh).addEventListener("click",e=>post("ignore",e.currentTarget));}]);}

/* ---------- supplier credits, operating controls and daily closing ---------- */
async function controlledSave(ref,data,options={}){
  try{return options.merge?await ref.update(data,options):await ref.set(data,options);}catch(e){
    if(e.code!=="approval_required")throw e;
    const [collection,id]=ref.path.split("/"),version=options.version??S[collection]?.get(id)?._version;
    await window.APP.request("POST","/api/authorizations",{collection,id,data,merge:!!options.merge,version:version??null,reason:data.note||data.correctionReason||`Review this ${VIEW_L[collection]||collection} entry`});
    toast("Sent for owner approval. The entry will post after approval.");return {pendingApproval:true};
  }
}
const supplierCredits=p=>r2((p.returns||[]).filter(r=>!r.voided).reduce((n,r)=>n+r.creditAmount,0));
function supplierReturnForm(id){
  const p=S.purchases.get(id),version=p._version,returned={};for(const r of p.returns||[])if(!r.voided)for(const i of r.items)returned[i.productId]=(returned[i.productId]||0)+i.qty;
  show(()=>[head("Return goods to supplier",esc(p.no)+" · "+esc(p.supplier))+`<form id="supplier-return" class="form-grid"><label class="f">Date returned<input id="sr-date" type="date" required max="${today()}" value="${today()}"></label><label class="f">Credit / return reference<input id="sr-ref" required maxlength="160"></label><label class="f span">Reason<input id="sr-reason" required maxlength="500"></label><div class="span tbl-wrap"><table><thead><tr><th>Product</th><th>Returnable</th><th>Return now</th><th class="r">Credit per unit</th></tr></thead><tbody>${p.items.filter(i=>i.receivedQty>(returned[i.productId]||0)).map(i=>`<tr><td>${esc(S.products.get(i.productId)?.name||i.productId)}</td><td>${i.receivedQty-(returned[i.productId]||0)}</td><td><input data-supplier-return="${esc(i.productId)}" type="number" min="0" max="${i.receivedQty-(returned[i.productId]||0)}" step="1" value="0" aria-label="${esc(S.products.get(i.productId)?.name)} supplier return quantity"></td><td class="r num">${P(i.unitCost)}</td></tr>`).join("")}</tbody></table></div><p class="small muted span">Stock leaves inventory and the original purchase cost becomes a supplier credit. Credits above the unpaid bill remain owed to you until a refund is received.</p><div class="actions span"><button class="btn primary" type="submit">Record return and credit</button></div></form>`,sh=>$("#supplier-return",sh).addEventListener("submit",e=>{e.preventDefault();guarded(e.submitter,async()=>{const items=$$("[data-supplier-return]",sh).filter(i=>Number(i.value)>0).map(i=>({productId:i.dataset.supplierReturn,qty:Number(i.value)}));await window.APP.request("POST",`/api/purchases/${encodeURIComponent(id)}/returns`,{version,date:$("#sr-date",sh).value,reference:$("#sr-ref",sh).value.trim(),reason:$("#sr-reason",sh).value.trim(),items});toast("Supplier return and credit recorded");back();});})]);
}
function supplierRefundForm(id){
  const p=S.purchases.get(id),version=p._version,balance=r2(supplierPaid(p)-supplierBill(p));
  show(()=>[head("Supplier refund received",P(balance)+" credit available")+`<form id="supplier-refund" class="form-grid"><label class="f">Date received<input id="rf-date" type="date" required max="${today()}" value="${today()}"></label><label class="f">Amount received (₱)<input id="rf-amount" type="number" min="0.01" max="${balance}" step="0.01" value="${balance}" required></label><label class="f">Method<select id="rf-method">${METHODS.map(m=>`<option>${m}</option>`).join("")}</select></label><label class="f">Reference<input id="rf-ref" maxlength="500"></label><button class="btn primary" type="submit">Record refund received</button></form>`,sh=>$("#supplier-refund",sh).addEventListener("submit",e=>{e.preventDefault();guarded(e.submitter,async()=>{await window.APP.request("POST",`/api/purchases/${encodeURIComponent(id)}/refunds`,{version,date:$("#rf-date",sh).value,amount:Number($("#rf-amount",sh).value),method:$("#rf-method",sh).value,reference:$("#rf-ref",sh).value.trim()});toast("Supplier refund recorded");back();});})]);
}
function voidSupplierEvent(id,eventId,kind){const p=S.purchases.get(id),version=p._version;show(()=>[head(kind==="returns"?"Void supplier return and credit":"Void supplier refund")+`<form id="void-supplier-event"><label class="f">Reason<input id="sv-reason" required></label><button class="btn danger" type="submit">Void record</button></form>`,sh=>$("#void-supplier-event",sh).addEventListener("submit",e=>{e.preventDefault();guarded(e.submitter,async()=>{await window.APP.request("POST",`/api/purchases/${encodeURIComponent(id)}/${kind}/${encodeURIComponent(eventId)}/void`,{version,reason:$("#sv-reason",sh).value.trim()});toast("Supplier record voided");back();});})]);}
function supplierCreditHistory(id,p){return `<section class="panel" style="margin-top:20px"><h3>Supplier returns and credits</h3><p>Credits issued: <b>${P(supplierCredits(p))}</b>${supplierPaid(p)>supplierBill(p)?` · Supplier owes you <b>${P(supplierPaid(p)-supplierBill(p))}</b>`:""}</p><div class="actions">${S.canAdmin&&p.items.some(i=>i.receivedQty>0)?`<button class="btn" data-act="supplier-return" data-id="${esc(id)}" type="button">Return goods / credit</button>`:""}${S.canAdmin&&supplierPaid(p)>supplierBill(p)?`<button class="btn primary" data-act="supplier-refund" data-id="${esc(id)}" type="button">Receive supplier refund</button>`:""}</div>${(p.returns||[]).map(r=>`<p>${fmtDate(r.date)} · ${esc(r.reference)} · ${P(r.creditAmount)} credit · ${esc(r.reason)}${r.voided?" · Voided":S.canAdmin?` <button class="btn sm" data-act="void-supplier-return" data-id="${esc(id)}" data-event="${esc(r.id)}" type="button">Void return</button>`:""}</p>`).join("")||`<p class="small muted">No supplier returns.</p>`}<h3>Refunds received</h3>${(p.refunds||[]).map(r=>`<p>${fmtDate(r.date)} · ${P(r.amount)} · ${esc(r.method)} · ${esc(r.reference)}${r.voided?" · Voided":S.canAdmin?` <button class="btn sm" data-act="void-supplier-refund" data-id="${esc(id)}" data-event="${esc(r.id)}" type="button">Void refund</button>`:""}</p>`).join("")||`<p class="small muted">No refunds received.</p>`}</section>`;}
function lossData(){const [from,to]=rangeDates();return {...LedgerInsights.lossReport([...S.moves].map(([id,m])=>({...m,id})),from,to),from,to};}
function vLosses(){const R=lossData();return `<section class="panel"><div class="panel-head"><h2>Stock losses</h2><div class="actions">${S.canWrite?`<button class="btn" data-act="stock-in" type="button">Record stock adjustment</button>`:""}<button class="btn" data-act="export-losses" type="button">Export CSV</button></div></div><p class="small muted">Damaged, expired, missing stock and negative count adjustments, valued at the saved inventory cost. Supplier returns are shown in purchase credits instead.</p><div class="toolbar">${periodControls()}</div><div class="kpis"><div class="kpi bad"><div class="lbl">Known stock loss cost</div><div class="val">${P(R.total)}</div></div><div class="kpi"><div class="lbl">Units lost</div><div class="val">${R.units}</div></div></div>${R.unknown?`<div class="notice warn">${R.unknown} loss records have unknown costs and are excluded from the cost total.</div>`:""}${R.rows.length?`<div class="tbl-wrap"><table><thead><tr><th>Date / product</th><th>Reason / note</th><th>Recorded by</th><th class="r">Units</th><th class="r">Loss cost</th></tr></thead><tbody>${R.rows.map(m=>`<tr><td>${fmtDate(m.date)}<div>${esc(S.products.get(m.productId)?.name||m.productId)}</div></td><td>${esc(m.reason)}<div class="small muted">${esc(m.note)}</div></td><td>${esc(nameOf(m.createdBy))}</td><td class="r">${m.units}</td><td class="r num">${m.cost==null?"Unknown":P(m.cost)}</td></tr>`).join("")}</tbody></table></div>`:`<p class="small muted">No stock losses in this period.</p>`}</section>`;}
function vControls(){
  const owner=S.acct?.role==="owner",limits=[["approvalExpenseLimit","Expenses",5000],["approvalPurchaseLimit","Purchase orders",20000],["approvalStockLimit","Manual stock adjustments",10000]],rows=[...S.authorizations].sort((a,b)=>b[1].createdAt-a[1].createdAt);
  return `<section class="panel" style="margin-bottom:20px"><h2>Owner approval limits</h2><p class="small muted">Entries at or above these amounts require owner approval when recorded by another team member. Set a limit to 0 to disable it. Unknown-cost stock adjustments require review when that control is enabled.</p><form id="limits-form" class="form-grid">${limits.map(([key,label,value])=>`<label class="f">${label} (₱)<input data-limit="${key}" type="number" min="0" max="1000000000" step="0.01" required value="${S.settings[key]??value}" ${owner?"":"disabled"}></label>`).join("")}${owner?`<div class="actions span"><button class="btn primary" type="submit">Save approval limits</button></div>`:""}</form></section><section class="panel"><h2>${owner?"Approval requests":"Your approval requests"}</h2>${rows.length?rows.map(([id,a])=>`<section class="panel" style="margin-bottom:12px"><div class="panel-head"><b>${esc(a.collection==="stockBatch"?"Stock count":VIEW_L[a.collection]||a.collection)} · ${a.value==null?"Cost unknown":P(a.value)}</b><span class="pill ${a.status==="pending"?"warn":a.status==="rejected"?"bad":"good"}">${a.status==="consumed"?"Approved and posted":esc(a.status)}</span></div><p class="small">${fmtStamp(a.createdAt)} · ${esc(nameOf(a.requestedBy))}</p><p>${esc(a.reason)}</p><p class="small">${esc(a.body.supplier||a.body.category||S.products.get(a.body.productId)?.name||"")} ${a.body.qty!=null?`· Quantity ${a.body.qty}`:""} ${a.body.date?`· ${fmtDate(a.body.date)}`:""}</p>${a.body.records?`<div class="tbl-wrap"><table><thead><tr><th>Product</th><th>Stock change</th></tr></thead><tbody>${a.body.records.map(r=>`<tr><td>${esc(S.products.get(r.data.productId)?.name||r.data.productId)}</td><td>${r.data.qty}</td></tr>`).join("")}</tbody></table></div>`:""}${a.body.items?`<div class="tbl-wrap"><table><thead><tr><th>Product</th><th>Quantity</th><th>Unit cost</th></tr></thead><tbody>${a.body.items.map(i=>`<tr><td>${esc(S.products.get(i.productId)?.name||i.productId)}</td><td>${i.qty}</td><td>${P(i.unitCost)}</td></tr>`).join("")}</tbody></table></div>`:""}${a.decisionReason?`<p class="small">Owner decision: ${esc(a.decisionReason)}</p>`:""}${owner&&a.status==="pending"?`<button class="btn primary" data-act="decide-authorization" data-id="${esc(id)}" type="button">Review / decide</button>`:""}</section>`).join(""):`<p class="small muted">No approval requests.</p>`}</section>`;
}
function authorizationDecision(id){show(()=>[head("Owner approval decision")+`<form id="authorization-decision"><label class="f">Decision<select id="auth-decision"><option value="approved">Approve and post the entry</option><option value="rejected">Reject</option></select></label><label class="f">Reason<input id="auth-reason" required></label><p class="small muted">Approval posts the reviewed entry immediately. Changed stock, closed days, or stale record versions require a new request.</p><button class="btn primary" type="submit">Save decision</button></form>`,sh=>$("#authorization-decision",sh).addEventListener("submit",e=>{e.preventDefault();guarded(e.submitter,async()=>{await window.APP.request("POST",`/api/authorizations/${encodeURIComponent(id)}/decision`,{status:$("#auth-decision",sh).value,reason:$("#auth-reason",sh).value.trim()});toast("Owner decision saved");back();});})]);}
function vClosing(){if(!S.canAdmin)return `<section class="panel"><p>Daily closing is available to the owner and editors.</p></section>`;const rows=[...S.dailyClosings].sort((a,b)=>b[1].date.localeCompare(a[1].date));return `<section class="panel"><div class="panel-head"><h2>Daily closing summary</h2><button class="btn primary" data-act="new-daily-closing" type="button">Count and close a day</button></div><p class="small muted">Compare opening funds, collections, operating expenses and supplier payments/refunds with counted balances. Credit sales and supplier credit notes do not count as money received. Closing locks financial records for that date until the owner reopens it.</p>${rows.length?`<div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Status</th><th class="r">Expected total</th><th class="r">Counted total</th><th class="r">Difference</th><th></th></tr></thead><tbody>${rows.map(([id,d])=>`<tr><td>${fmtDate(d.date)}</td><td>${esc(d.status)}</td><td class="r num">${P(d.channels.reduce((n,c)=>n+c.expected,0))}</td><td class="r num">${P(d.channels.reduce((n,c)=>n+c.counted,0))}</td><td class="r num">${P(d.channels.reduce((n,c)=>n+c.difference,0))}</td><td><button class="btn sm" data-act="view-daily-closing" data-id="${esc(id)}" type="button">Open</button></td></tr>`).join("")}</tbody></table></div>`:`<p class="small muted">No days closed yet.</p>`}</section>`;}
function closingChannels(report){return `<div class="tbl-wrap"><table><thead><tr><th>Method</th><th class="r">Opening</th><th class="r">Collections</th><th class="r">Expenses</th><th class="r">Supplier paid</th><th class="r">Supplier refunds in</th><th class="r">Customer refunds out</th><th class="r">Expected</th>${report.channels[0]?.counted!=null?`<th class="r">Counted</th><th class="r">Difference</th>`:""}</tr></thead><tbody>${report.channels.map(c=>`<tr><td>${esc(c.method)}</td><td class="r num">${P(c.opening)}</td><td class="r num">${P(c.collections)}</td><td class="r num">${P(c.expenses)}</td><td class="r num">${P(c.supplierPayments)}</td><td class="r num">${P(c.supplierRefunds)}</td><td class="r num">${P(c.customerRefunds||0)}</td><td class="r num">${P(c.expected)}</td>${c.counted!=null?`<td class="r num">${P(c.counted)}</td><td class="r num">${P(c.difference)}</td>`:""}</tr>`).join("")}</tbody></table></div>`;}
function dailyClosingForm(){let report=null;show(()=>[head("Count and close the day")+`<form id="daily-close-form"><label class="f">Business date<input id="daily-date" type="date" max="${today()}" required value="${today()}"></label><div class="tbl-wrap"><table><thead><tr><th>Method</th><th>Opening balance</th><th>Counted balance</th></tr></thead><tbody>${METHODS.map(m=>`<tr><td>${m}</td><td><input data-opening="${m}" type="number" min="0" step="0.01" required value="0" aria-label="${m} opening balance"></td><td><input data-counted="${m}" type="number" min="0" step="0.01" required value="0" aria-label="${m} counted balance"></td></tr>`).join("")}</tbody></table></div><label class="f">Explanation / note<input id="daily-note" maxlength="1000" placeholder="Required when counted and expected balances differ"></label><div id="daily-preview" role="status"></div><div class="actions"><button class="btn" type="submit" id="daily-preview-button">Preview expected balances</button><button class="btn primary" type="submit" id="daily-close-confirm" hidden>Close this day</button></div></form>`,sh=>{
  const read=attr=>Object.fromEntries($$("[data-"+attr+"]",sh).map(i=>[i.dataset[attr],Number(i.value)]));
  $("#daily-close-form",sh).addEventListener("submit",e=>{e.preventDefault();const btn=e.submitter||$("#daily-preview-button",sh);guarded(btn,async()=>{const date=$("#daily-date",sh).value,opening=read("opening");if(btn.id==="daily-close-confirm"){if(!report)return;await window.APP.request("POST","/api/daily-closing/close",{date,opening,counted:read("counted"),fingerprint:report.fingerprint,note:$("#daily-note",sh).value.trim()});toast("Business day closed");back();}else{report=await window.APP.request("POST","/api/daily-closing/preview",{date,opening});$("#daily-preview",sh).innerHTML=`<p>Credit sales ${P(report.sales)} · Dealer returns ${P(report.dealerReturns)} · Known stock losses ${P(report.stockLoss)}</p>`+closingChannels(report);$("#daily-close-confirm",sh).hidden=false;btn.disabled=false;}});});
  [$("#daily-date",sh),...$$("[data-opening]",sh)].forEach(i=>i.addEventListener("input",()=>{report=null;$("#daily-preview",sh).innerHTML="";$("#daily-close-confirm",sh).hidden=true;}));
}]);}
function dailyClosingSheet(id){show(()=>{const d=S.dailyClosings.get(id);return [head("Daily closing · "+fmtDate(d.date))+`<p>${esc(d.status)} · ${fmtStamp(d.closedAt)} · ${esc(nameOf(d.closedBy))}</p><p>Credit sales ${P(d.sales)} · Dealer returns ${P(d.dealerReturns)} · Stock losses ${P(d.stockLoss)}</p>${closingChannels(d)}<p>${esc(d.note||"")}</p><div class="actions"><button class="btn" data-act="export-daily-closing" data-id="${esc(id)}" type="button">Export CSV</button>${S.acct?.role==="owner"&&d.status==="closed"?`<button class="btn danger" data-act="reopen-daily-closing" data-id="${esc(id)}" type="button">Reopen day</button>`:""}</div>`];},true);}
function reopenDailyClosing(id){show(()=>[head("Reopen business day")+`<form id="reopen-day"><label class="f">Reason<input id="reopen-day-reason" required></label><button class="btn danger" type="submit">Reopen day</button></form>`,sh=>$("#reopen-day",sh).addEventListener("submit",e=>{e.preventDefault();guarded(e.submitter,async()=>{await window.APP.request("POST",`/api/daily-closing/${encodeURIComponent(id)}/reopen`,{reason:$("#reopen-day-reason",sh).value.trim()});toast("Business day reopened");back();});})]);}

/* ---------- supplier purchasing and expenses ---------- */
const purchaseTotal=p=>r2((p.items||[]).reduce((n,i)=>n+i.qty*i.unitCost,0));
const supplierBill=p=>LedgerInsights.supplierBill(p);
const supplierPaid=p=>LedgerInsights.supplierPaid(p);
function vPurchases(){
  const rows=[...S.purchases].sort((a,b)=>(b[1].createdAt||0)-(a[1].createdAt||0));
  return `<section class="panel"><div class="panel-head"><h2>Purchase orders</h2>${S.canWrite?`<button class="btn primary" data-act="new-purchase" type="button">New purchase order</button>`:""}</div><p class="small muted">Order from suppliers, receive partial deliveries, and track payments against received goods. Supplier payments are separate from operating expenses.</p>${rows.length?`<div class="tbl-wrap"><table><thead><tr><th>Order / supplier</th><th>Expected</th><th>Status</th><th class="r">Order total</th><th class="r">Received bill</th><th class="r">Unpaid</th><th></th></tr></thead><tbody>${rows.map(([id,p])=>`<tr><td><b>${esc(p.no)}</b><div>${esc(p.supplier)}</div></td><td>${fmtDate(p.expectedDate)}${p.expectedDate<today()&&["open","partial"].includes(p.status)?` <span class="pill warn">Late</span>`:""}</td><td>${esc(p.status)}</td><td class="r num">${P(purchaseTotal(p))}</td><td class="r num">${P(supplierBill(p))}</td><td class="r num">${P(supplierBill(p)-supplierPaid(p))}</td><td><button class="btn sm" data-act="view-purchase" data-id="${esc(id)}" type="button">Open</button></td></tr>`).join("")}</tbody></table></div>`:`<p class="small muted">No purchase orders yet.</p>`}</section>`;
}
function purchaseForm(seed){
  if(!activeProducts().length){toast("Add a product first");return;}
  const ref=db.collection("purchases").doc();
  show(()=>[head("New purchase order")+`<form id="po-form" class="form-grid"><label class="f span">Supplier directory<select id="po-supplier-id"><option value="">Enter a supplier name manually</option>${[...S.suppliers].filter(([,v])=>v.active!==false).map(([id,v])=>`<option value="${esc(id)}" ${seed?.supplierId===id?"selected":""}>${esc(v.name)}</option>`).join("")}</select></label><label class="f span">Supplier<input id="po-supplier" required maxlength="160" value="${esc(seed?.supplier||"")}"></label><label class="f">Order date<input id="po-date" type="date" required value="${today()}"></label><label class="f">Expected delivery<input id="po-expected" type="date" required value="${addDays(today(),7)}"></label><p class="small span muted">Enter quantities for the products to order. Leave other quantities at zero.</p><div class="span tbl-wrap"><table><thead><tr><th>Product</th><th>Order quantity</th><th>Unit purchase cost (₱)</th></tr></thead><tbody>${activeProducts().map(([id,p])=>`<tr><td>${esc(p.name)}</td><td><input data-po-qty="${esc(id)}" type="number" min="0" max="9999" step="1" value="${seed?.productId===id?seed.qty:0}" aria-label="${esc(p.name)} order quantity" style="min-width:90px"></td><td><input data-po-cost="${esc(id)}" type="number" min="0" max="1000000000" step="0.01" value="${esc(p.purchaseCost??"")}" aria-label="${esc(p.name)} unit purchase cost" style="min-width:110px"></td></tr>`).join("")}</tbody></table></div><label class="f span">Note<input id="po-note" maxlength="500"></label>${S.acct?.role!=="owner"&&Number(S.settings.approvalPurchaseLimit??20000)>0?`<p class="hint span">Orders of ${P(S.settings.approvalPurchaseLimit??20000)} or more are sent for owner approval before posting.</p>`:""}<div class="actions span"><button class="btn primary" type="submit">Create purchase order</button><button class="btn" data-back type="button">Cancel</button></div></form>`,sh=>{
    const choose=()=>{const supplier=S.suppliers.get($("#po-supplier-id",sh).value);$("#po-supplier",sh).readOnly=!!supplier;if(supplier)$("#po-supplier",sh).value=supplier.name;};$("#po-supplier-id",sh).addEventListener("change",choose);choose();
    $("#po-form",sh).addEventListener("submit",e=>{e.preventDefault();const chosen=$$("[data-po-qty]",sh).filter(i=>Number(i.value)>0);if(chosen.some(i=>$$("[data-po-cost]",sh).find(c=>c.dataset.poCost===i.dataset.poQty).value==="")){toast("Enter a purchase cost for every ordered product");return;}const items=chosen.map(i=>{const cost=$$("[data-po-cost]",sh).find(c=>c.dataset.poCost===i.dataset.poQty);return {productId:i.dataset.poQty,qty:Number(i.value),unitCost:Number(cost.value)};});if(!items.length){toast("Choose at least one product quantity");return;}
      guarded(e.submitter,async()=>{const saved=await controlledSave(ref,{supplier:$("#po-supplier",sh).value.trim(),supplierId:$("#po-supplier-id",sh).value||null,date:$("#po-date",sh).value,expectedDate:$("#po-expected",sh).value,note:$("#po-note",sh).value.trim(),items});if(saved?.pendingApproval){back();return;}toast("Purchase order added");back();});});
  }]);
}
function purchaseSheet(id){
  show(()=>{const p=S.purchases.get(id);if(!p)return [head("Purchase not found")];return [head(esc(p.no),esc(p.supplier))+`<p>Expected ${fmtDate(p.expectedDate)} · <span class="pill neutral">${esc(p.status)}</span></p><div class="kpis"><div class="kpi"><div class="lbl">Order total</div><div class="val">${P(purchaseTotal(p))}</div></div><div class="kpi"><div class="lbl">Received goods</div><div class="val">${P(supplierBill(p))}</div></div><div class="kpi"><div class="lbl">${supplierBill(p)>=supplierPaid(p)?"Unpaid bill":"Supplier credit owed to you"}</div><div class="val">${P(Math.abs(supplierBill(p)-supplierPaid(p)))}</div></div></div><div class="tbl-wrap"><table><thead><tr><th>Product</th><th class="r">Ordered</th><th class="r">Received</th><th class="r">Unit cost</th></tr></thead><tbody>${p.items.map(i=>`<tr><td>${esc(S.products.get(i.productId)?.name||i.productId)}</td><td class="r">${i.qty}</td><td class="r">${i.receivedQty}</td><td class="r">${P(i.unitCost)}</td></tr>`).join("")}</tbody></table></div><p>${esc(p.note||"")}</p><div class="actions">${S.canWrite&&["open","partial"].includes(p.status)?`<button class="btn primary" data-act="receive-purchase" data-id="${esc(id)}" type="button">Receive delivery</button>`:""}${S.canAdmin&&supplierBill(p)>supplierPaid(p)?`<button class="btn" data-act="pay-supplier" data-id="${esc(id)}" type="button">Record supplier payment</button>`:""}${S.canAdmin&&["open","partial"].includes(p.status)?`<button class="btn danger" data-act="cancel-purchase" data-id="${esc(id)}" type="button">Cancel remaining order</button>`:""}</div><h3 style="margin-top:20px">Deliveries</h3>${(p.receipts||[]).map(r=>`<p>${fmtDate(r.date)} · ${esc(r.deliveryRef)} · ${r.items.reduce((n,i)=>n+i.qty,0)} units</p>`).join("")||`<p class="small muted">No deliveries yet.</p>`}<h3>Supplier payments</h3>${(p.payments||[]).map(r=>`<p>${fmtDate(r.date)} · ${P(r.amount)} · ${esc(r.method)} · ${esc(r.reference)}${r.voided?" · Voided":S.canAdmin?` <button class="btn sm" data-act="void-supplier-payment" data-id="${esc(id)}" data-payment="${esc(r.id)}" type="button">Void payment</button>`:""}</p>`).join("")||`<p class="small muted">No payments recorded.</p>`}${supplierCreditHistory(id,p)}${supplierApplicationHistory(id,p)}`];},true);
}
function receivePurchase(id){
  const p=S.purchases.get(id),version=p._version;
  show(()=>[head("Receive delivery",esc(p.no)+" · "+esc(p.supplier))+`<form id="receive-form" class="form-grid"><label class="f">Delivery date<input id="receive-date" type="date" required value="${today()}" max="${today()}"></label><label class="f">Delivery reference<input id="receive-ref" required maxlength="160"></label><div class="span tbl-wrap"><table><thead><tr><th>Product</th><th>Outstanding</th><th>Received now</th><th>Batch code</th><th>Expiry</th></tr></thead><tbody>${p.items.filter(i=>i.receivedQty<i.qty).map(i=>`<tr><td>${esc(S.products.get(i.productId)?.name||i.productId)}</td><td>${i.qty-i.receivedQty}</td><td><input data-receive="${esc(i.productId)}" type="number" min="0" max="${i.qty-i.receivedQty}" step="1" value="0" aria-label="${esc(S.products.get(i.productId)?.name)} received quantity"></td><td><input data-receive-code="${esc(i.productId)}" maxlength="160" aria-label="Batch code for ${esc(S.products.get(i.productId)?.name)}"></td><td><input data-receive-expiry="${esc(i.productId)}" type="date" aria-label="Expiry for ${esc(S.products.get(i.productId)?.name)}"></td></tr>`).join("")}</tbody></table></div><label class="f span">Note<input id="receive-note" maxlength="500"></label><div class="actions span"><button class="btn primary" type="submit">Save delivery</button></div></form>`,sh=>$("#receive-form",sh).addEventListener("submit",e=>{e.preventDefault();const items=$$("[data-receive]",sh).filter(i=>Number(i.value)>0).map(i=>({productId:i.dataset.receive,qty:Number(i.value),batchCode:$$("[data-receive-code]",sh).find(c=>c.dataset.receiveCode===i.dataset.receive).value.trim(),expiryDate:$$("[data-receive-expiry]",sh).find(c=>c.dataset.receiveExpiry===i.dataset.receive).value||null}));guarded(e.submitter,async()=>{await window.APP.request("POST",`/api/purchases/${encodeURIComponent(id)}/receive`,{version,date:$("#receive-date",sh).value,deliveryRef:$("#receive-ref",sh).value.trim(),note:$("#receive-note",sh).value.trim(),items});toast("Delivery recorded");back();});})]);
}
function supplierPayment(id){
  const p=S.purchases.get(id),version=p._version,balance=r2(supplierBill(p)-supplierPaid(p));
  show(()=>[head("Supplier payment",esc(p.no)+" · Balance "+P(balance))+`<form id="supplier-pay" class="form-grid"><label class="f">Date<input id="sp-date" type="date" required max="${today()}" value="${today()}"></label><label class="f">Amount (₱)<input id="sp-amount" type="number" required min="0.01" max="${balance}" step="0.01" value="${balance}"></label><label class="f">Method<select id="sp-method">${METHODS.map(m=>`<option>${m}</option>`).join("")}</select></label><label class="f">Reference<input id="sp-ref" maxlength="500"></label><div class="actions span"><button class="btn primary" type="submit">Record payment</button></div></form>`,sh=>$("#supplier-pay",sh).addEventListener("submit",e=>{e.preventDefault();guarded(e.submitter,async()=>{await window.APP.request("POST",`/api/purchases/${encodeURIComponent(id)}/payments`,{version,date:$("#sp-date",sh).value,amount:Number($("#sp-amount",sh).value),method:$("#sp-method",sh).value,reference:$("#sp-ref",sh).value.trim()});toast("Supplier payment recorded");back();});})]);
}
function voidSupplierPayment(id,paymentId){const p=S.purchases.get(id);show(()=>[head("Void supplier payment")+`<form id="void-sp"><label class="f">Reason<input id="void-sp-reason" required></label><button class="btn danger" type="submit">Void payment</button></form>`,sh=>$("#void-sp",sh).addEventListener("submit",e=>{e.preventDefault();guarded(e.submitter,async()=>{await window.APP.request("POST",`/api/purchases/${encodeURIComponent(id)}/payments/${encodeURIComponent(paymentId)}/void`,{version:p._version,reason:$("#void-sp-reason",sh).value.trim()});toast("Supplier payment voided");back();});})]);}
function cancelPurchase(id){const p=S.purchases.get(id);show(()=>[head("Cancel remaining order",esc(p.no))+`<form id="cancel-po"><label class="f">Reason<input id="cancel-po-reason" required></label><p class="small muted">Received goods and supplier bills remain recorded.</p><button class="btn danger" type="submit">Cancel outstanding quantities</button></form>`,sh=>$("#cancel-po",sh).addEventListener("submit",e=>{e.preventDefault();guarded(e.submitter,async()=>{const saved=await controlledSave(db.doc("purchases/"+id),{status:"cancelled",correctionReason:$("#cancel-po-reason",sh).value.trim()},{version:p._version,merge:true});if(saved?.pendingApproval){back();return;}toast("Outstanding order cancelled");back();});})]);}
function vExpenses(){
  const [from,to]=rangeDates(),rows=[...S.expenses].filter(([,e])=>e.date>=from&&e.date<=to).sort((a,b)=>b[1].date.localeCompare(a[1].date)),total=rows.filter(([,e])=>!e.voided).reduce((n,[,e])=>n+e.amount,0);
  return `<section class="panel"><div class="panel-head"><h2>Operating expenses</h2><div class="actions">${S.canWrite?`<button class="btn primary" data-act="new-expense" type="button">Record expense</button>`:""}<button class="btn" data-act="export-expenses" type="button">Export CSV</button></div></div><p class="small muted">Rent, transport, salaries and other operating costs. Purchase receipts and supplier bill payments are tracked separately to avoid double counting product costs.</p><div class="toolbar">${periodControls()}<b>Total ${P(total)}</b></div>${rows.length?`<div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Category / payee</th><th>Method</th><th>Note</th><th class="r">Amount</th><th></th></tr></thead><tbody>${rows.map(([id,e])=>`<tr class="${e.voided?"void":""}"><td>${fmtDate(e.date)}</td><td>${esc(e.category)}<div class="small muted">${esc(e.payee)}</div>${e.voided?`<span class="pill bad">Voided</span>`:""}</td><td>${esc(e.method)}</td><td>${esc(e.note)}<div class="small">${attachmentsMarkup(e.attachments)}</div></td><td class="r num">${P(e.amount)}</td><td>${S.canAdmin?`<button class="btn sm" data-act="edit-expense" data-id="${esc(id)}" type="button">Edit / void</button>`:""}</td></tr>`).join("")}</tbody></table></div>`:`<p class="small muted">No expenses in this period.</p>`}</section>`;
}
function expenseForm(id){
  const old=id?S.expenses.get(id):null,ref=db.collection("expenses").doc(id||undefined);
  show(()=>[head(old?"Edit expense":"Record expense")+`<form id="expense-form" class="form-grid"><label class="f">Date<input id="ex-date" type="date" required value="${old?.date||today()}"></label><label class="f">Category<input id="ex-category" list="expense-categories" required maxlength="160" value="${esc(old?.category||"")}"><datalist id="expense-categories">${["Rent","Transport","Salaries","Utilities","Supplies","Other"].map(c=>`<option value="${c}">`).join("")}</datalist></label><label class="f">Amount (₱)<input id="ex-amount" type="number" min="0.01" max="1000000000" step="0.01" required value="${esc(old?.amount??"")}"></label><label class="f">Payment method<select id="ex-method">${METHODS.map(m=>`<option ${old?.method===m?"selected":""}>${m}</option>`).join("")}</select></label><label class="f span">Payee<input id="ex-payee" maxlength="500" value="${esc(old?.payee||"")}"></label><label class="f span">Note / receipt reference<input id="ex-note" maxlength="500" value="${esc(old?.note||"")}"></label><div class="f span"><span>Receipts and supporting documents</span>${(old?.attachments||[]).map(a=>`<label class="chk"><input type="checkbox" data-remove-attachment="${esc(a.id)}"> Remove ${esc(a.name)}</label>`).join("")}<input id="ex-files" type="file" multiple accept="image/*,application/pdf"><span class="hint">Up to five receipt photos or PDFs, 10 MB each. ${attachmentsMarkup(old?.attachments)}</span></div>${S.acct?.role!=="owner"&&Number(S.settings.approvalExpenseLimit??5000)>0?`<p class="hint span">Expenses of ${P(S.settings.approvalExpenseLimit??5000)} or more are sent for owner approval.</p>`:""}${old?`<label class="chk span"><input id="ex-void" type="checkbox" ${old.voided?"checked":""}> Void this expense</label><label class="f span">Reason for correction<input id="ex-reason" required></label>`:""}<div class="actions span"><button class="btn primary" type="submit">Save expense</button><button class="btn" type="button" data-back>Cancel</button></div></form>`,sh=>$("#expense-form",sh).addEventListener("submit",e=>{e.preventDefault();guarded(e.submitter,async()=>{const saved=await controlledSave(ref,{attachments:await expenseDocuments(sh,old),date:$("#ex-date",sh).value,category:$("#ex-category",sh).value.trim(),amount:Number($("#ex-amount",sh).value),method:$("#ex-method",sh).value,payee:$("#ex-payee",sh).value.trim(),note:$("#ex-note",sh).value.trim(),...(old?{voided:$("#ex-void",sh).checked,correctionReason:$("#ex-reason",sh).value.trim()}:{})},{version:old?._version});if(saved?.pendingApproval){back();return;}toast("Expense saved");back();});})]);
}
function periodControls(){return `<div class="seg" role="group" aria-label="Period">${[["month","This month"],["last","Last month"],["year","This year"],["custom","Custom"]].map(([v,l])=>`<button type="button" data-preset="${v}" aria-pressed="${S.range.preset===v}">${l}</button>`).join("")}</div>${S.range.preset==="custom"?`<label class="f">From<input type="date" id="rFrom" value="${esc(S.range.from)}"></label><label class="f">To<input type="date" id="rTo" value="${esc(S.range.to)}"></label>`:""}`;}
function reorderData(){return LedgerInsights.reorderPlan([...S.products],[...S.txns.values()],[...S.purchases.values()],today(),S.reorderLead,S.reorderCover);}
function vReorder(){const rows=reorderData();return `<section class="panel"><div class="panel-head"><h2>Low-stock reorder list</h2><button class="btn" data-act="export-reorder" type="button">Export CSV</button></div><p class="small muted">Suggestions use net sales over the last 30 days, stock available after reservations, and outstanding purchase orders. Review quantities and costs before ordering.</p><div class="toolbar"><label class="f">Supplier lead time (days)<input id="reorder-lead" type="number" min="0" max="365" value="${S.reorderLead}"></label><label class="f">Extra stock coverage (days)<input id="reorder-cover" type="number" min="1" max="365" value="${S.reorderCover}"></label></div>${rows.length?`<div class="tbl-wrap"><table><thead><tr><th>Product / supplier</th><th class="r">Available</th><th class="r">On order</th><th class="r">Daily demand</th><th class="r">Target stock</th><th class="r">Suggested order</th><th class="r">Estimated cost</th><th></th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.name)}<div class="small muted">${esc(r.supplier||"Supplier not set")}</div></td><td class="r">${r.available}</td><td class="r">${r.onOrder}</td><td class="r">${r.daily.toFixed(2)}</td><td class="r">${r.target}</td><td class="r"><b>${r.suggested}</b></td><td class="r">${r.unitCost==null?"Cost unknown":P(r.suggested*r.unitCost)}</td><td>${S.canWrite&&r.suggested?`<button class="btn sm" data-act="reorder-purchase" data-id="${esc(r.id)}" type="button">Create PO</button>`:`<span class="small muted">${r.onOrder?"Delivery pending":""}</span>`}</td></tr>`).join("")}</tbody></table></div>`:`<p class="small muted">No products currently need reordering.</p>`}</section>`;}

/* ---------- stock history and profit ---------- */
function stockRows(){
  const f=S.stockFilter;
  return LedgerInsights.stockHistory([...S.moves],[...S.txns]).filter(m=>(!f.product||m.productId===f.product)&&(!f.person||m.createdBy===f.person)&&(!f.from||m.date>=f.from)&&(!f.to||m.date<=f.to)&&(!f.kind||m.kind===f.kind));
}
function vStockHistory(){
  const f=S.stockFilter, all=LedgerInsights.stockHistory([...S.moves],[...S.txns]), rows=stockRows();
  const people=[...new Set(all.map(m=>m.createdBy).filter(Boolean))];
  return `<section class="panel"><div class="panel-head"><h2>Stock history</h2><div class="actions">${S.canWrite?`<button class="btn primary" data-act="stock-in" type="button">Receive / adjust stock</button>`:""}<button class="btn" data-act="export-stock" type="button">Export CSV</button></div></div>
  <p class="small muted">Receipts, starting stock, adjustments, sales and restocked returns. Voided records are shown but do not affect stock.</p>
  <div class="toolbar">
  <label class="f">Product<select data-stock-filter="product"><option value="">All products</option>${[...S.products].map(([id,p])=>`<option value="${esc(id)}" ${f.product===id?"selected":""}>${esc(p.name)}</option>`).join("")}</select></label>
  <label class="f">Added by<select data-stock-filter="person"><option value="">Everyone</option>${people.map(id=>`<option value="${esc(id)}" ${f.person===id?"selected":""}>${esc(S.names[id]||S.team?.find(u=>u.id===id)?.name||id)}</option>`).join("")}</select></label>
  <label class="f">Type<select data-stock-filter="kind"><option value="">All changes</option>${[...new Set(all.map(m=>m.kind))].sort().map(k=>`<option ${f.kind===k?"selected":""} value="${esc(k)}">${esc(k)}</option>`).join("")}</select></label>
  <label class="f">From<input type="date" data-stock-filter="from" value="${esc(f.from)}"></label><label class="f">To<input type="date" data-stock-filter="to" value="${esc(f.to)}"></label><button class="btn sm" data-act="reset-stock-filter" type="button">Reset</button></div>
  ${f.from&&f.to&&f.from>f.to?`<p class="notice warn">Choose an end date on or after the start date.</p>`:""}
  <p class="small muted">${rows.length} matching changes${rows.length>300?" · Showing the latest 300; export includes all matches":""}</p>
  ${rows.length?`<div class="tbl-wrap"><table><thead><tr><th>Date / recorded</th><th>Product</th><th>Added by</th><th>Change</th><th>Supplier / reference</th><th class="r">Unit cost</th><th class="r">Quantity</th></tr></thead><tbody>${rows.slice(0,300).map(m=>`<tr class="${m.voided?"void":""}"><td class="small nowrap">${fmtDate(m.date)}<div class="muted">${fmtStamp(m.createdAt)||"Time unavailable"}</div></td><td>${esc(S.products.get(m.productId)?.name||"Removed product")}</td><td>${esc(S.names[m.createdBy]||S.team?.find(u=>u.id===m.createdBy)?.name||nameOf(m.createdBy))}</td><td>${esc(m.kind)}${m.voided?` <span class="pill bad">Voided</span>`:""}${m.note?`<div class="small muted">${esc(m.note)}</div>`:""}</td><td>${esc(m.supplier||"")}<div>${m.txnId?`<button class="btn sm" data-tx="${esc(m.txnId)}" type="button">${esc(m.reference||"Details")}</button>`:esc(m.reference||"—")}</div></td><td class="r num">${m.unitCost==null?"—":P(m.unitCost)}</td><td class="r num">${m.qty>0?"+":""}${m.qty}</td></tr>`).join("")}</tbody></table></div>`:`<p class="small muted">No stock changes match these filters.</p>`}</section>`;
}
function profitData(){const [from,to]=rangeDates();return {...LedgerInsights.profitReport([...S.txns.values()],from,to,[...S.expenses.values()],[...S.moves.values()],[...S.purchases.values()]),from,to};}
function vProfit(){
  const R=profitData(), grouped=new Map();
  for(const row of R.rows){const key=S.profitGroup==="month"?row.date.slice(0,7):row.date;const p=grouped.get(key)||{date:key,revenue:0,cost:0,profit:0,expenses:0,netProfit:0,stockLoss:0,supplierVariance:0};for(const k of ["revenue","cost","profit","expenses","netProfit","stockLoss","supplierVariance"])p[k]=r2(p[k]+row[k]);grouped.set(key,p);}
  return `<section class="panel" style="margin-bottom:20px"><div class="panel-head"><h2>Profit and operating expenses</h2><button class="btn" data-act="export-profit" type="button">Export daily CSV</button></div>
  <p class="small muted">Sales after discounts and returns, less product purchase costs saved when recorded. New sales use weighted average inventory costs at posting time. Linked restocked returns reverse the original sale cost. Operating expenses and known stock losses are deducted; supplier return value differences are included. Taxes are not included. Backdated entries do not recalculate earlier sale costs.</p>
  <div class="toolbar"><div class="seg" role="group" aria-label="Profit period">${[["month","This month"],["last","Last month"],["year","This year"],["custom","Custom"]].map(([v,l])=>`<button type="button" data-preset="${v}" aria-pressed="${S.range.preset===v}">${l}</button>`).join("")}</div>${S.range.preset==="custom"?`<label class="f">From<input type="date" id="rFrom" value="${esc(S.range.from)}"></label><label class="f">To<input type="date" id="rTo" value="${esc(S.range.to)}"></label>`:`<span class="small muted">${fmtDate(R.from)} – ${fmtDate(R.to)}</span>`}<label class="f">Group by<select id="profitGroup"><option value="day" ${S.profitGroup==="day"?"selected":""}>Day</option><option value="month" ${S.profitGroup==="month"?"selected":""}>Month</option></select></label></div></section>
  ${R.missing||R.excluded||R.unknownLosses||R.unknownSupplierVariance?`<div class="notice warn"><p><b>Partial report.</b> ${R.missing} transactions have no complete saved purchase cost; ${R.excluded} have no item details. These are excluded. ${R.unknownLosses||0} stock losses and ${R.unknownSupplierVariance||0} supplier returns also have unknown values and are excluded. Opening balances and voids are excluded.</p></div>`:""}
  ${R.from>R.to?`<div class="notice warn">Choose an end date on or after the start date.</div>`:""}
  <div class="kpis"><div class="kpi"><div class="lbl">Included net sales</div><div class="val">${P(R.revenue)}</div></div><div class="kpi"><div class="lbl">Product costs</div><div class="val">${P(R.cost)}</div></div><div class="kpi ${R.profit<0?"bad":"good"}"><div class="lbl">Gross profit</div><div class="val">${P(R.profit)}</div></div><div class="kpi"><div class="lbl">Gross margin</div><div class="val">${R.revenue>0?(R.profit/R.revenue*100).toFixed(1)+"%":"—"}</div></div></div>
  <div class="kpis"><div class="kpi"><div class="lbl">Operating expenses</div><div class="val">${P(R.expenses)}</div><button class="btn sm" type="button" data-nav="expenses">View expenses</button></div><div class="kpi ${R.netProfit<0?"bad":"good"}"><div class="lbl">Profit after expenses and losses</div><div class="val">${P(R.netProfit)}</div><div class="sub">${R.missing||R.excluded||R.unknownLosses||R.unknownSupplierVariance?"Partial: missing cost information":"Before taxes"}</div></div></div>
  <div class="notice info"><p>Known stock losses <b>${P(R.stockLoss)}</b> · Supplier return value difference <b>${P(R.supplierVariance)}</b></p><button class="btn sm" type="button" data-nav="losses">View stock losses</button></div>
  <section class="panel"><h2>${S.profitGroup==="month"?"Monthly":"Daily"} results</h2>${grouped.size?`<div class="tbl-wrap"><table><thead><tr><th>Period</th><th class="r">Net sales</th><th class="r">Product costs</th><th class="r">Gross profit</th><th class="r">Expenses</th><th class="r">Stock loss</th><th class="r">Supplier difference</th><th class="r">After costs</th></tr></thead><tbody>${[...grouped.values()].map(r=>`<tr><td>${esc(r.date)}</td><td class="r num">${P(r.revenue)}</td><td class="r num">${P(r.cost)}</td><td class="r num">${P(r.profit)}</td><td class="r num">${P(r.expenses)}</td><td class="r num">${P(r.stockLoss)}</td><td class="r num">${P(r.supplierVariance)}</td><td class="r num">${P(r.netProfit)}</td></tr>`).join("")}</tbody></table></div>`:`<p class="small muted">No transactions with complete purchase costs in this period. Set product purchase costs before recording new sales.</p>`}</section>`;
}
function backupPanel(){
  if(!S.canAdmin)return "";
  const b=S.backupStatus;
  return `<section class="panel" style="margin-bottom:20px"><div class="panel-head"><h2>Server backup status</h2><button class="btn sm" data-act="refresh-backup" type="button">Refresh</button></div>${S.backupError?`<p class="notice warn">${esc(S.backupError)}</p>`:b?`<p><span class="pill ${b.lastError||b.overdue?"warn":"good"}">${b.lastError?"Backup failed":b.overdue?"Backup overdue":"Up to date"}</span></p><dl class="kv"><dt>Last successful backup</dt><dd>${b.lastSuccess?fmtStamp(b.lastSuccess):"No server backup yet"}</dd><dt>Backup file</dt><dd>${esc(b.file||"—")}</dd><dt>Size</dt><dd>${b.size?(b.size/1024/1024).toFixed(2)+" MB":"—"}</dd><dt>Saved backups</dt><dd>${b.count}</dd></dl>${b.lastError?`<p class="small">${esc(b.lastError)}</p>`:""}`:`<p class="small muted">Loading server backup status…</p>`}<p class="small muted">Scheduled daily while the server runs. Marked overdue after 26 hours. New server backups include the database, photo files and a checksum manifest.</p>${b?.recovery?`<p class="notice ${b.recovery.ok?"info":"warn"}"><b>${b.recovery.ok?"Recovery check passed":"Recovery check failed"}</b> · ${fmtStamp(b.recovery.checkedAt)} · ${b.recovery.photos} files · ${b.recovery.records} records${b.lastSuccess>b.recovery.checkedAt?" · A newer backup needs checking":""}${b.recovery.errors?.length?" · "+esc(b.recovery.errors.join(" ")):""}</p>`:""}<div class="actions"><button class="btn" data-act="verify-backup" type="button" ${!b?.file||b?.running?"disabled":""}>Check backup recovery</button><button class="btn primary" type="button" data-act="run-backup" ${b?.running?"disabled":""}>${b?.running?"Backup in progress…":"Back up now"}</button></div></section>`;
}
async function refreshBackup(){
  if(!S.canAdmin||!window.APP)return;
  try{S.backupStatus=await window.APP.request("GET","/api/backup/status");S.backupError="";}catch(e){S.backupError="Could not load backup status. Refresh to try again.";}
  render();
}
function dashboardAlerts(){
  const overdue=[...S.dealers].map(([id,d])=>({id,d,st:status(id)})).filter(x=>x.st.overdue>0).sort((a,b)=>b.st.overdue-a.st.overdue);
  const low=activeProducts().filter(([,p])=>p.reorderLevel!=null&&p.stock<=p.reorderLevel).sort((a,b)=>a[1].stock-b[1].stock);
  const orders=activeOrders();
  return `<section class="panel" style="margin-bottom:20px"><h2>Needs attention</h2><div class="grid2e"><div><h3 class="small">Overdue dealers · ${overdue.length}</h3>${overdue.length?overdue.slice(0,5).map(({id,d,st})=>`<p><button class="btn sm" data-dealer="${esc(id)}" type="button">${esc(d.name)}</button> <span class="small">${P(st.overdue)} · ${st.maxLate} days late</span></p>`).join(""):`<p class="small muted">No overdue balances.</p>`}<button class="btn sm" data-nav="collect" type="button">Open collections</button></div><div><h3 class="small">Low stock · ${low.length}</h3>${low.length?low.slice(0,5).map(([id,p])=>`<p><button class="btn sm" ${S.canWrite?`data-act="stock-for" data-id="${esc(id)}"`:`data-nav="products"`} type="button">${esc(p.name)}</button> <span class="small">${p.stock} on hand · reorder at ${p.reorderLevel}</span></p>`).join(""):`<p class="small muted">No low stock products.</p>`}</div></div><h3 class="small" style="margin-top:16px">Orders awaiting action · ${orders.length}</h3>${orders.length?orders.slice(0,5).map(([id,o])=>`<p><button class="btn sm" data-order="${esc(id)}" type="button">${esc(o.no||"Order")}</button> <span class="small">${esc(S.dealers.get(o.dealerId)?.name||"Dealer")} · ${esc(ORD_L[o.status])}</span></p>`).join(""):`<p class="small muted">No orders awaiting action.</p>`}<button class="btn sm" data-nav="orders" type="button">Open orders</button><div class="actions" style="margin-top:16px"><button class="btn" data-nav="reorder" type="button">Review reorder suggestions</button><button class="btn" data-nav="purchases" type="button">Track supplier deliveries</button></div></section>${backupPanel()}`;
}

function vDashboard(){
  const date=today(), live=[...S.txns.values()].filter(isLive);
  const sales=live.filter(t=>t.type==="sale"&&t.date===date).reduce((n,t)=>n+t.amount,0);
  const payments=live.filter(t=>t.type==="payment"&&t.date===date).reduce((n,t)=>n+t.amount,0);
  const products=activeProducts(), low=products.filter(([,p])=>p.reorderLevel!=null&&p.stock<=p.reorderLevel).length;
  const pending=activeOrders().filter(([,o])=>o.status==="new").length;
  const recent=[...S.txns.entries()].sort((a,b)=>(b[1].createdAt||0)-(a[1].createdAt||0)).slice(0,6);
  return sampleBanner()+healthNotices()+`<div class="panel-head"><div><p class="small muted">${fmtDate(date)} · Your daily business snapshot</p></div></div>
  <div class="kpis">
    <div class="kpi"><div class="lbl">Today's credit sales</div><div class="val num">${P(sales)}</div></div>
    <div class="kpi good"><div class="lbl">Today's collections</div><div class="val num">${P(payments)}</div></div>
    <div class="kpi"><div class="lbl">New orders</div><div class="val num">${pending}</div></div>
    <div class="kpi ${low?"bad":""}"><div class="lbl">Low stock products</div><div class="val num">${low}</div></div>
  </div>
  ${dashboardAlerts()}
  <section class="panel" style="margin-bottom:20px"><h2>Quick access</h2><div class="go-grid">${["overview","orders","collect","products"].filter(v=>v!=="orders"||window.APP).map(v=>`<button class="go" type="button" data-nav="${v}">${ICON[v]}<span>${VIEW_L[v]}</span></button>`).join("")}</div></section>
  <section class="panel"><h2>Recent transactions</h2>${recent.length?`<div class="tbl-wrap"><table><thead><tr><th>Recorded</th><th>Reference</th><th>Dealer</th><th>Type</th><th class="r">Amount</th></tr></thead><tbody>${recent.map(([id,t])=>`<tr><td class="small nowrap">${fmtStamp(t.createdAt)||fmtDate(t.date)}</td><td><button class="btn sm" type="button" data-tx="${esc(id)}">${esc(t.no||"View")}</button></td><td>${esc((S.dealers.get(t.dealerId)||{}).name||"—")}</td><td>${esc(TYPE_LABEL[t.type]||t.type)}${t.voided?" · Voided":""}</td><td class="r num">${P(t.amount)}</td></tr>`).join("")}</tbody></table></div>`:`<p class="small muted">No transactions yet.</p>`}</section>`;
}
function vOverview(){
  if(!S.dealers.size) return sampleBanner()+emptyStart();
  let total=0, overdue=0, owing=0; const od=[], dueSoon=[]; const t0=today(), t7=addDays(t0,7);
  S.dealers.forEach((d,id)=>{ const st=status(id); if(st.balance>0){ total+=st.balance; owing++; } overdue+=st.overdue; if(st.overdue>0) od.push({d,id,st});
    st.open.filter(o=>!o.late&&o.dueDate<=t7).forEach(o=>dueSoon.push({d,id,o})); });
  od.sort((a,b)=>b.st.overdue-a.st.overdue); dueSoon.sort((a,b)=>a.o.dueDate.localeCompare(b.o.dueDate));
  const m=t0.slice(0,7); let salesM=0, payM=0;
  S.txns.forEach(t=>{ if(isLive(t)&&(t.date||"").startsWith(m)){ if(t.type==="sale") salesM+=t.amount; else if(t.type==="payment") payM+=t.amount; } });
  const ag={current:0,d30:0,d60:0,d90:0,d90p:0};
  S.dealers.forEach((d,id)=>status(id).open.forEach(o=>{ const L=o.late; ag[!L?"current":L<=30?"d30":L<=60?"d60":L<=90?"d90":"d90p"]+=o.remaining; }));
  const agTot=Object.values(ag).reduce((a,b)=>a+b,0)||1;
  const segs=[["current","Not yet due","var(--accent)"],["d30","1–30 days late","var(--warn)"],["d60","31–60 days","#d97a2b"],["d90","61–90 days","var(--bad)"],["d90p","Over 90 days","#7a1712"]];
  const low=activeProducts().filter(([,p])=>p.reorderLevel!=null&&p.stock<=p.reorderLevel).sort((a,b)=>a[1].stock-b[1].stock);
  const mn=new Date().toLocaleDateString("en-PH",{month:"long"});
  return sampleBanner()+healthNotices()+`
  <div class="kpis">
    <div class="kpi"><div class="lbl">Total receivables</div><div class="val num">${P(total)}</div><div class="sub">Owed by ${owing} dealer${owing===1?"":"s"}</div></div>
    <div class="kpi ${overdue>0?"bad":""}"><div class="lbl">Overdue</div><div class="val num">${P(overdue)}</div><div class="sub">${od.length} dealer${od.length===1?"":"s"} past due</div></div>
    <div class="kpi"><div class="lbl">Collected in ${mn}</div><div class="val num">${P(payM)}</div><div class="sub">Payments received</div></div>
    <div class="kpi"><div class="lbl">Credit sales in ${mn}</div><div class="val num">${P(salesM)}</div><div class="sub">Released to dealers</div></div>
  </div>
  <div class="grid2">
    <div class="col">
      <section class="panel">
        <div class="panel-head"><h2>Needs collection</h2><span class="small muted">Largest overdue first</span></div>
        ${od.length?`<div class="tbl-wrap"><table><thead><tr><th>Dealer</th><th class="r">Overdue</th><th class="r">Balance</th><th>Status</th></tr></thead><tbody>
        ${od.map(({d,id,st})=>`<tr class="click" tabindex="0" data-dealer="${id}"><td><b>${esc(d.name)}</b>${samplePill(d)}<div class="small muted">${esc(d.phone||"")}${d.area?" · "+esc(d.area):""}</div></td><td class="r num"><b>${P(st.overdue)}</b></td><td class="r num">${P(st.balance)}</td><td>${statusPill(st,d)}</td></tr>`).join("")}
        </tbody></table></div>`:`<div class="empty"><h3>No overdue accounts</h3><p>Every dealer is paid up or still within terms.</p></div>`}
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Due in the next 7 days</h2></div>
        ${dueSoon.length?`<div class="tbl-wrap"><table><tbody>${dueSoon.map(({d,id,o})=>`<tr class="click" tabindex="0" data-dealer="${id}"><td><b>${esc(d.name)}</b><div class="small muted">${esc(o.no||"")} · released ${fmtDate(o.date)}</div></td><td class="small nowrap">Due ${fmtDate(o.dueDate)}</td><td class="r num">${P(o.remaining)}</td></tr>`).join("")}</tbody></table></div>`:`<p class="muted small" style="margin:0">Nothing falls due this week.</p>`}
      </section>
    </div>
    <div class="col">
      <section class="panel">
        <h2>Receivables aging</h2>
        <div class="aging" role="img" aria-label="Aging of unpaid balances">${segs.map(([k,,c])=>ag[k]>0?`<span style="width:${ag[k]/agTot*100}%;background:${c}"></span>`:"").join("")}</div>
        <div class="legend">${segs.map(([k,l,c])=>`<div><span class="small muted"><i class="dot" style="background:${c}"></i>${l}</span><b class="num">${P(ag[k])}</b></div>`).join("")}</div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Low stock</h2>${S.canWrite?`<button class="btn sm" data-act="stock-in" type="button">+ Stock in</button>`:""}</div>
        ${low.length?`<table><tbody>${low.map(([id,p])=>`<tr><td><div class="prod-cell">${thumb(p,1)}<div>${esc(p.name)}${samplePill(p)}</div></div></td><td class="r num"><span class="pill ${p.stock<=0?"bad":"warn"}">${p.stock} left</span></td></tr>`).join("")}</tbody></table>`:`<p class="muted small" style="margin:0">All products are above their reorder level.</p>`}
      </section>
    </div>
  </div>`;
}
function vDealers(){
  const q=S.q.toLowerCase();
  const rows=[...S.dealers.entries()].filter(([,d])=>S.showArchived||d.active!==false).filter(([,d])=>!q||[d.name,d.phone,d.area].join(" ").toLowerCase().includes(q))
    .map(([id,d])=>({id,d,st:status(id)})).sort((a,b)=>b.st.balance-a.st.balance||a.d.name.localeCompare(b.d.name));
  const arch=[...S.dealers.values()].filter(d=>d.active===false).length;
  return sampleBanner()+`<section class="panel">
    <div class="panel-head"><h2>Dealers <span class="muted small">(${S.dealers.size-arch} active)</span></h2><div class="actions">${downloads?`<button class="btn sm" data-act="export-dealers" type="button">Export CSV</button>`:""}${S.canWrite?`<button class="btn primary sm" data-act="new-dealer" type="button">+ Add dealer</button>`:""}</div></div>
    <div class="toolbar"><input id="q" type="search" placeholder="Search name, phone or area" value="${esc(S.q)}" aria-label="Search dealers">${arch?`<label class="chk"><input type="checkbox" id="showArch" ${S.showArchived?"checked":""}> Show ${arch} archived</label>`:""}</div>
    ${rows.length?`<div class="tbl-wrap"><table><thead><tr><th>Dealer</th><th class="r">Balance</th><th>Credit used</th><th>Next due</th><th>Last payment</th><th>Rating</th><th>Status</th></tr></thead><tbody>
    ${rows.map(({id,d,st})=>{ const pct=d.creditLimit?Math.min(100,Math.max(0,st.balance/d.creditLimit*100)):0; const cls=pct>=100?"bad":pct>=80?"warn":"";
      return `<tr class="click" tabindex="0" data-dealer="${id}"><td><b>${esc(d.name)}</b>${samplePill(d)}${d.active===false?` <span class="pill neutral">Archived</span>`:""}<div class="small muted">${esc(d.phone||"")}${d.area?" · "+esc(d.area):""}</div></td>
      <td class="r num"><b>${P(st.balance)}</b></td>
      <td class="small num">${d.creditLimit?`${Math.round(pct)}% of ${P(d.creditLimit)}<div class="meter"><i class="${cls}" style="width:${pct}%"></i></div>`:`<span class="muted">No limit</span>`}</td>
      <td class="small nowrap">${st.nextDue?fmtDate(st.nextDue):"—"}</td><td class="small nowrap">${st.lastPay?fmtDate(st.lastPay):"—"}</td><td>${gradePill(history(id))}</td><td>${statusPill(st,d)}</td></tr>`;}).join("")}
    </tbody></table></div>`:(S.dealers.size?`<div class="empty"><h3>No match</h3><p>No dealer matches “${esc(S.q)}”.</p></div>`:emptyStart())}
  </section>`;
}
function vProducts(){
  const q=S.q.toLowerCase(); const cats=[...new Set([...S.products.values()].map(p=>p.category).filter(Boolean))].sort();
  const rows=[...S.products.entries()].filter(([,p])=>S.showArchived||p.active!==false).filter(([,p])=>!S.catFilter||p.category===S.catFilter)
    .filter(([,p])=>!q||[p.name,p.code,p.category].join(" ").toLowerCase().includes(q)).sort((a,b)=>a[1].name.localeCompare(b[1].name));
  const arch=[...S.products.values()].filter(p=>p.active===false).length;
  const value=activeProducts().reduce((a,[,p])=>a+Math.max(0,p.stock)*p.dealerPrice,0);
  return sampleBanner()+`<section class="panel">
    <div class="panel-head"><h2>Products <span class="muted small">(${S.products.size-arch} active · stock worth ${P(value)} at dealer price)</span></h2>
      <div class="actions">${downloads?`<button class="btn sm" data-act="export-products" type="button">Export CSV</button>`:""}${S.canAdmin?`<button class="btn sm primary" data-act="catalog" type="button">Update catalog</button>`:""}${S.canWrite?`<button class="btn sm" data-act="count" type="button">Stock count</button><button class="btn sm" data-act="stock-in" type="button">+ Stock in</button><button class="btn sm" data-act="new-product" type="button">+ Add product</button>`:""}</div></div>
    ${S.settings.catalogName?`<p class="small muted" style="margin:-4px 0 12px">Current prices: <b>${esc(S.settings.catalogName)}</b>${S.settings.catalogAt?` · updated ${fmtStamp(S.settings.catalogAt)}`:""}</p>`:""}
    <div class="toolbar"><input id="q" type="search" placeholder="Search product, code or category" value="${esc(S.q)}" aria-label="Search products">
      ${cats.length?`<select id="catFilter" aria-label="Category"><option value="">All categories</option>${cats.map(c=>`<option ${c===S.catFilter?"selected":""}>${esc(c)}</option>`).join("")}</select>`:""}
      ${arch?`<label class="chk"><input type="checkbox" id="showArch" ${S.showArchived?"checked":""}> Show ${arch} archived</label>`:""}</div>
    ${rows.length?`<div class="tbl-wrap"><table><thead><tr><th>Product</th><th>Code</th><th class="r">Dealer price</th><th class="r">SRP</th><th class="r">Margin</th><th class="r">Stock</th></tr></thead><tbody>
    ${rows.map(([id,p])=>{ const low=p.reorderLevel!=null&&p.stock<=p.reorderLevel; const mg=p.srp?r2(p.srp-p.dealerPrice):null;
      return `<tr class="${S.canWrite?"click":""}" ${S.canWrite?`tabindex="0" data-product="${id}"`:""}><td><div class="prod-cell">${thumb(p)}<div><b>${esc(p.name)}</b>${samplePill(p)}${p.active===false?` <span class="pill neutral">Archived</span>`:""}<div class="small muted">${esc(p.category||"")}${p.imageLink?`${p.category?" · ":""}<a href="${esc(p.imageLink)}" target="_blank" rel="noopener noreferrer">View picture ↗</a>`:""}</div></div></div></td>
      <td class="small muted">${esc(p.code||"—")}</td><td class="r num">${P(p.dealerPrice)}</td><td class="r num nowrap">${p.srp||promoOn(p)?priceTag(p,1):"—"}</td><td class="r num small">${mg!=null?P(mg):"—"}</td><td class="r num">${low?`<span class="pill ${p.stock<=0?"bad":"warn"}">${p.stock}</span>`:p.stock}</td></tr>`;}).join("")}
    </tbody></table></div>`:`<div class="empty"><h3>${S.products.size?"No match":"No products yet"}</h3><p>${S.products.size?"Try another search or category.":"Add the items you release to dealers, with dealer price and stock on hand."}</p></div>`}
  </section>`;
}
function txDetails(t){
  const it=(t.items||[]).map(i=>`${esc(i.name)} ×${i.qty}`).join(", ");
  const no=t.no?`<span class="small muted">${esc(t.no)}</span> `:"";
  const vd=t.voided?` <span class="pill bad">Voided</span>`:"";
  if(t.opening) return `${no}<span class="pill neutral">Opening balance</span>${vd}<div class="small muted">Due ${fmtDate(t.dueDate)}${t.note&&t.note!=="Opening balance"?" · "+esc(t.note):""}</div>`;
  if(t.type==="sale") return `${no}<span class="pill neutral">Credit sale</span>${vd} <span class="small">${it}</span><div class="small muted">Due ${fmtDate(t.dueDate)}${t.pctDiscount?(t.discountPct!=null?` · less ${t.discountPct}%`:" · less dealer discount"):""}${t.discount?` · less ${P(t.discount)}`:""}${t.note?" · "+esc(t.note):""}</div>`;
  if(t.type==="refund")return `${no}<span class="pill warn">Customer refund</span>${vd}<div class="small muted">${esc(t.method)} · ${esc(t.note)}</div>`;
  if(t.type==="return") return `${no}<span class="pill warn">Return</span>${vd} <span class="small">${it}</span><div class="small muted">${t.restock?"Back to stock":"Not restocked"}${t.note?" · "+esc(t.note):""}</div>`;
  return `${no}<span class="pill good">${t.payKind==="partial"?"Partial payment":t.payKind==="full"?"Full payment":"Payment"}</span>${vd} <span class="small">${esc(t.method||"")}${t.ref?" · Ref "+esc(t.ref):""}</span>${t.note?`<div class="small muted">${esc(t.note)}</div>`:""}`;
}
const sign=t=>["sale","refund"].includes(t.type)?"":"−";
function vActivity(){
  const q=S.q.toLowerCase();
  const rows=[...S.txns.entries()].filter(([,t])=>S.txFilter==="all"?true:S.txFilter==="voided"?t.voided:(t.type===S.txFilter&&!t.voided))
    .filter(([,t])=>{ if(!q) return true; const d=S.dealers.get(t.dealerId); return [d&&d.name,t.no,t.note,t.ref,t.method,(t.items||[]).map(i=>i.name).join(" ")].join(" ").toLowerCase().includes(q); })
    .sort((a,b)=>(b[1].date||"").localeCompare(a[1].date||"")||(b[1].createdAt||0)-(a[1].createdAt||0));
  const shown=rows.slice(0,300);
  return sampleBanner()+`<section class="panel">
    <div class="panel-head"><h2>Transactions</h2><div class="actions">${downloads?`<button class="btn sm" data-act="export-tx" type="button">Export CSV</button>`:""}${S.canWrite?`<button class="btn sm" data-act="new-return" type="button">+ Return</button>`:""}</div></div>
    <div class="toolbar"><input id="q" type="search" placeholder="Search dealer, DR/OR no., product, reference" value="${esc(S.q)}" aria-label="Search transactions">
      <select id="txFilter" aria-label="Type">${[["all","All"],["sale","Credit sales"],["payment","Payments"],["return","Returns"],["voided","Voided"]].map(([v,l])=>`<option value="${v}" ${S.txFilter===v?"selected":""}>${l}</option>`).join("")}</select></div>
    ${rows.length?`<div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Dealer</th><th>Details</th><th class="r">Amount</th></tr></thead><tbody>
    ${shown.map(([id,t])=>{ const d=S.dealers.get(t.dealerId); return `<tr class="click ${t.voided?"void":""}" tabindex="0" data-tx="${id}"><td class="small nowrap">${fmtDate(t.date)}</td><td><b>${esc(d?d.name:"(removed dealer)")}</b>${samplePill(t)}</td><td>${txDetails(t)}</td><td class="r num nowrap amt">${sign(t)}${P(t.amount)}</td></tr>`; }).join("")}
    </tbody></table></div>${rows.length>300?`<p class="small muted">Showing the latest 300 of ${rows.length}. Search or export CSV to see older ones.</p>`:""}`:`<div class="empty"><h3>No transactions</h3><p>Credit sales, payments and returns you record will be listed here.</p></div>`}
  </section>`;
}
function rangeDates(){
  const t=new Date(), y=t.getFullYear(), m=t.getMonth(); const R=S.range;
  if(R.preset==="month") return [ymd(new Date(y,m,1)),ymd(new Date(y,m+1,0))];
  if(R.preset==="last") return [ymd(new Date(y,m-1,1)),ymd(new Date(y,m,0))];
  if(R.preset==="year") return [`${y}-01-01`,`${y}-12-31`];
  return [R.from||"0000-01-01",R.to||"9999-12-31"];
}
function reportData(){
  const [from,to]=rangeDates();
  const tx=[...S.txns.values()].filter(t=>isLive(t)&&t.date>=from&&t.date<=to);
  const tot={sale:0,payment:0,return:0,refund:0,discount:0,count:tx.length}; const byP={}, byD={}, byM={};
  tx.forEach(t=>{ tot[t.type]+=t.amount; if(t.type==="sale") tot.discount+=(t.discount||0)+(t.pctDiscount||0);
    const d=byD[t.dealerId]=byD[t.dealerId]||{sale:0,payment:0,return:0,refund:0}; d[t.type]+=t.amount;
    if(t.type==="payment") byM[t.method||"Other"]=(byM[t.method||"Other"]||0)+t.amount;
    if(t.type!=="payment") (t.items||[]).forEach(i=>{ const p=byP[i.productId]=byP[i.productId]||{name:i.name,qty:0,amt:0,ret:0}; if(t.type==="sale"){p.qty+=i.qty;p.amt+=i.qty*i.price-lineDisc(i,t);} else p.ret+=i.qty; }); });
  return {from,to,tot,byP,byD,byM};
}
function vReports(){
  const R=reportData(); const {tot}=R;
  const prod=Object.entries(R.byP).sort((a,b)=>b[1].amt-a[1].amt);
  const deal=Object.entries(R.byD).sort((a,b)=>b[1].sale-a[1].sale);
  const meth=Object.entries(R.byM).sort((a,b)=>b[1]-a[1]);
  const net=r2(tot.sale-tot.return);
  const pr=[["month","This month"],["last","Last month"],["year","This year"],["custom","Custom"]];
  return `<div class="actions" style="margin-bottom:16px"><button class="btn" data-nav="profit" type="button">Open gross profit report</button></div>`+trendChart()+`<section class="panel" style="margin-bottom:20px">
    <div class="panel-head"><h2>Report period</h2>${downloads?`<button class="btn sm" data-act="export-report" type="button">Export report CSV</button>`:""}</div>
    <div class="toolbar"><div class="seg" role="group" aria-label="Period">${pr.map(([v,l])=>`<button type="button" data-preset="${v}" aria-pressed="${S.range.preset===v}">${l}</button>`).join("")}</div>
    ${S.range.preset==="custom"?`<input type="date" id="rFrom" value="${esc(S.range.from)}" aria-label="From"><span class="muted">to</span><input type="date" id="rTo" value="${esc(S.range.to)}" aria-label="To">`:`<span class="small muted">${fmtDate(R.from)} – ${fmtDate(R.to)}</span>`}</div>
  </section>
  <div class="kpis">
    <div class="kpi"><div class="lbl">Credit sales</div><div class="val num">${P(tot.sale)}</div><div class="sub">${tot.discount?`After ${P(tot.discount)} discounts`:"Released to dealers"}</div></div>
    <div class="kpi"><div class="lbl">Returns</div><div class="val num">${P(tot.return)}</div><div class="sub">Net sales ${P(net)}</div></div>
    <div class="kpi good"><div class="lbl">Collections</div><div class="val num">${P(tot.payment)}</div><div class="sub">${net>0?`${Math.round(tot.payment/net*100)}% of net sales`:"Payments received"}</div></div>
    <div class="kpi"><div class="lbl">Transactions</div><div class="val num">${tot.count}</div><div class="sub">Voided ones not counted</div></div>
  </div>
  <div class="grid2e">
    <section class="panel"><h2>By product</h2>
      ${prod.length?`<div class="tbl-wrap"><table><thead><tr><th>Product</th><th class="r">Sold</th><th class="r">Returned</th><th class="r">Sales</th></tr></thead><tbody>
      ${prod.map(([pid,p])=>`<tr><td><div class="prod-cell">${thumb(S.products.get(pid),1)}<span>${esc(p.name)}</span></div></td><td class="r num">${p.qty}</td><td class="r num">${p.ret||"—"}</td><td class="r num">${P(p.amt)}</td></tr>`).join("")}
      </tbody></table></div>`:`<p class="muted small">No product movement in this period.</p>`}
    </section>
    <div class="col">
      <section class="panel"><h2>By dealer</h2>
        ${deal.length?`<div class="tbl-wrap"><table><thead><tr><th>Dealer</th><th class="r">Sales</th><th class="r">Paid</th><th class="r">Balance now</th></tr></thead><tbody>
        ${deal.map(([id,d])=>{ const dl=S.dealers.get(id); return `<tr class="click" tabindex="0" data-dealer="${id}"><td>${esc(dl?dl.name:"(removed)")}</td><td class="r num">${P(d.sale-d.return)}</td><td class="r num">${P(d.payment)}</td><td class="r num">${P(status(id).balance)}</td></tr>`; }).join("")}
        </tbody></table></div>`:`<p class="muted small">No dealer activity in this period.</p>`}
      </section>
      <section class="panel"><h2>Collections by method</h2>
        ${meth.length?`<table><tbody>${meth.map(([m,a])=>`<tr><td>${esc(m)}</td><td class="r num">${P(a)}</td></tr>`).join("")}</tbody></table>`:`<p class="muted small">No payments in this period.</p>`}
      </section>
    </div>
  </div>`;
}
function vStore(){
  const s=S.settings; const docs=COLS.reduce((a,c)=>a+S[c].size,0)+1;
  return `<div class="grid2e">
  <section class="panel"><h2>Store details</h2>
    <p class="small muted" style="margin-top:0">Shown on dealer statements and at the top of the app.</p>
    <form id="storeForm" class="form-grid">
      <label class="f span">Store name<input id="st-name" value="${esc(s.storeName||"")}" placeholder="e.g. Dela Cruz PC Distributor" ${S.canAdmin?"":"disabled"}></label>
      <label class="f">Contact number<input id="st-phone" value="${esc(s.phone||"")}" ${S.canAdmin?"":"disabled"}></label>
      <label class="f">Address<input id="st-addr" value="${esc(s.address||"")}" ${S.canAdmin?"":"disabled"}></label>
      <label class="f span">How dealers can pay<textarea id="st-pay" placeholder="e.g. GCash 0917 123 4567 (Juan D.) · BDO 0012 3456 7890" ${S.canAdmin?"":"disabled"}>${esc(s.paymentInfo||"")}</textarea></label>
      <label class="f">Default payment terms (days)<input id="st-terms" type="number" min="0" step="1" value="${esc(s.defaultTerms??30)}" ${S.canAdmin?"":"disabled"}></label>
      <label class="f">Statement closing line<input id="st-foot" value="${esc(s.footer??"Salamat po!")}" ${S.canAdmin?"":"disabled"}></label>
      <h3 class="span" style="font-size:15px;margin-top:8px">Pricing</h3>
      <label class="f">Dealer discount on the total (%)<input id="st-pct" type="number" min="0" max="100" step="0.01" value="${esc(s.discountPct??25)}" ${S.canAdmin?"":"disabled"}><span class="hint">Items are priced at SRP, then this is taken off the total. Personal Collection dealers: 25%.</span></label>
      <h3 class="span" style="font-size:15px;margin-top:8px">Credit rules</h3>
      <label class="f">Default credit limit for new dealers (₱)<input id="st-limit" type="number" min="0" step="0.01" value="${esc(s.defaultLimit??"")}" placeholder="e.g. 5000" ${S.canAdmin?"":"disabled"}></label>
      <label class="f">Put dealers on hold after (days late)<input id="st-hold" type="number" min="1" step="1" value="${esc(s.holdDays??60)}" ${S.canAdmin?"":"disabled"}></label>
      <label class="chk span"><input type="checkbox" id="st-block" ${s.blockOverLimit!==false?"checked":""} ${S.canAdmin?"":"disabled"}> Block credit sales over the limit unless the owner approves</label>
      <label class="f span">Collection reminder message<textarea id="st-msg" rows="4" ${S.canAdmin?"":"disabled"}>${esc(s.reminderTemplate||DEFAULT_MSG)}</textarea><span class="hint">{name}, {balance}, {status}, {store} and {payinfo} are filled in for each dealer.</span></label>
      ${S.canAdmin?`<div class="actions span"><button class="btn primary" type="submit">Save store details</button></div>`:`<p class="small muted span" style="margin:0">Only the ledger owner or editors can change store details.</p>`}
    </form>
  </section>
  <div class="col">
    ${teamPanel()}
    ${approvalPanel()}
    ${S.canAdmin?`<section class="panel"><h2>Collection reconciliation</h2><p>Compare recorded payments with counted cash and payment-channel totals.</p><button class="btn" data-act="reconcile" type="button">Reconcile collections</button></section>`:""}
    ${backupPanel()}
    <section class="panel"><h2>Backup and restore</h2>
      <p class="small" style="margin-top:0">Use the complete backup to keep the database, photos and accounts together. The records JSON file is for reviewed imports and excludes photos and accounts. The server also saves daily full backups.</p>
      <div class="actions">${downloads&&S.canAdmin?`<button class="btn primary" data-act="backup" type="button">Download records (.json)</button>`:`<span class="small muted">Downloads aren't available in this view.</span>`}
      ${S.canAdmin?`<a class="btn" href="/api/backup/download" download>Download complete backup (.tar.gz)</a>`:""}${S.acct?.role==="owner"?`<label class="btn" for="restoreFile" style="cursor:pointer">Restore records (.json)…</label><input id="restoreFile" type="file" accept=".json,application/json" hidden>`:""}</div>
      <div id="restoreArea"></div>
    </section>
    <section class="panel"><h2>Ledger health</h2>
      <dl class="kv"><dt>Records</dt><dd class="num">${docs.toLocaleString()}</dd><dt>Dealers</dt><dd>${S.dealers.size}</dd><dt>Products</dt><dd>${S.products.size}</dd><dt>Transactions</dt><dd>${S.txns.size}</dd><dt>Stock movements</dt><dd>${S.moves.size}</dd><dt>Your access</dt><dd>${S.canAdmin?"Owner / Editor":S.canWrite?"Can record sales and payments":"View only"}</dd></dl>
      
      ${sampleBanner()}
    </section>
  </div></div>`;
}

function healthNotices(){
  const out=[];
  const expired=[...S.batches.values()].filter(b=>b.remainingQty>0&&b.expiryDate&&b.expiryDate<today()).reduce((n,b)=>n+b.remainingQty,0),expiring=[...S.batches.values()].filter(b=>b.remainingQty>0&&b.expiryDate&&b.expiryDate>=today()&&b.expiryDate<=addDays(today(),30)).length;if(expired||expiring)out.push(`<div class="notice warn"><p>${expired?`<b>${expired} expired units</b> cannot be sold. `:""}${expiring?`${expiring} batches expire within 30 days.`:""}</p><button class="btn sm" data-nav="batches" type="button">Review expiry</button></div>`);
  const pending=[...S.authorizations.values()].filter(a=>a.status==="pending").length;if(pending)out.push(`<div class="notice info"><p><b>${pending} pending owner approval${pending===1?"":"s"}</b></p><button class="btn sm" type="button" data-nav="controls">Review requests</button></div>`);
  const nNew=[...S.orders.values()].filter(o=>o.status==="new").length, nReady=[...S.orders.values()].filter(o=>o.status==="ready").length;
  if(nNew||nReady) out.push(`<div class="notice info"><p><b>${nNew?`${nNew} new online order${nNew===1?"":"s"}`:""}${nNew&&nReady?" · ":""}${nReady?`${nReady} ready for pickup`:""}.</b> Prepare items before the dealer arrives.</p><button class="btn sm" data-act="go-orders" type="button">Open orders</button></div>`); const real=[...S.dealers.values()].some(d=>!d.sample);
  const hold=[...S.dealers.keys()].filter(id=>status(id).maxLate>holdDays()).length;
  if(hold) out.push(`<div class="notice bad"><p><b>${hold} dealer${hold===1?" is":"s are"} on credit hold</b> (more than ${holdDays()} days late). New credit sales to them are blocked until they pay.</p><button class="btn sm" data-act="go-collect" type="button">Open collection list</button></div>`);
  const nolim=activeDealers().filter(([,d])=>!d.creditLimit).length;
  if(nolim&&S.canWrite) out.push(`<div class="notice warn"><p><b>${nolim} dealer${nolim===1?" has":"s have"} no credit limit.</b> Set one for every dealer, even a high one, so the app can stop risky releases.</p><button class="btn sm" data-act="go-dealers" type="button">Review dealers</button></div>`);
  if(S.products.size&&S.canWrite){ const last=[...S.moves.values()].filter(m=>m.reason==="Stock count").map(m=>m.date).sort().pop();
    if(!last||daysBetween(last,today())>30) out.push(`<div class="notice warn"><p><b>Monthly stock count ${last?"is due":"not done yet"}.</b> ${last?`Last count was ${fmtDate(last)}.`:"Count your stock once a month to catch missing items."}</p><button class="btn sm" data-act="count" type="button">Start stock count</button></div>`); }
  if(downloads&&real&&S.canAdmin){ const lb=Number(lsGet("lastBackup"))||0; const days=lb?Math.floor((Date.now()-lb)/864e5):null;
    if(days===null||days>=7) out.push(`<div class="notice warn"><p><b>${days===null?"No backup downloaded on this device yet.":`Last backup was ${days} days ago.`}</b> Download one every week.</p><button class="btn sm" data-act="backup" type="button">Download backup</button></div>`); }
  return out.join("");
}
function vCollect(){
  const t0=today(), t3=addDays(t0,3), all=!!S.collectAll;
  const rows=[...S.dealers.entries()].map(([id,d])=>({id,d,st:status(id)})).filter(({st})=>st.balance>0&&(all||st.overdue>0||(st.nextDue&&st.nextDue<=t3)))
    .sort((a,b)=>b.st.maxLate-a.st.maxLate||b.st.overdue-a.st.overdue||(a.st.nextDue||"").localeCompare(b.st.nextDue||""));
  const done=rows.filter(r=>r.d.lastReminded===t0).length;
  return sampleBanner()+`<section class="panel">
    <div class="panel-head"><h2>Collection list</h2><span class="small muted">${done} of ${rows.length} reminded today</span></div>
    <div class="toolbar"><div class="seg" role="group" aria-label="Show"><button type="button" data-cf="due" aria-pressed="${!all}">Overdue or due in 3 days</button><button type="button" data-cf="all" aria-pressed="${all}">Everyone with a balance</button></div></div>
    ${rows.length?`<div class="tbl-wrap"><table><thead><tr><th>Dealer</th><th class="r">To collect</th><th>Status</th><th>Last reminded</th><th></th></tr></thead><tbody>
    ${rows.map(({id,d,st})=>`<tr><td><a href="#collect" data-dealer="${id}" style="color:inherit"><b>${esc(d.name)}</b></a>${samplePill(d)}<div class="small" style="user-select:all">${esc(d.phone||"No number")}</div></td>
      <td class="r num nowrap"><b>${P(st.overdue||st.balance)}</b><div class="small muted">${st.overdue?"of "+P(st.balance)+" balance":"due "+fmtDate(st.nextDue)}</div></td>
      <td>${statusPill(st,d)}</td><td class="small nowrap">${d.lastReminded?(d.lastReminded===t0?`<span class="pill good">Today</span>`:fmtDate(d.lastReminded)):"Never"}</td>
      <td class="r"><div class="actions" style="justify-content:flex-end;flex-wrap:nowrap"><button class="btn sm" data-act="remind-copy" data-id="${id}" type="button">Copy message</button>${S.canWrite?`<button class="btn sm" data-act="remind-mark" data-id="${id}" type="button">${d.lastReminded===t0?"Reminded ✓":"Mark reminded"}</button>`:""}</div></td></tr>`).join("")}
    </tbody></table></div>`:`<div class="empty"><h3>Nobody to chase today</h3><p>No dealer is overdue or due in the next 3 days.</p></div>`}
    <p class="small muted" style="margin:12px 0 0">Copy the message, then paste it in Messenger, Viber or SMS. You can change the wording in the Store tab.</p></section>`;
}
function countSheet(){
  const countId=crypto.randomUUID?crypto.randomUUID().slice(0,8):Date.now().toString(36);
  if(!activeProducts().length){ toast("Add a product first"); productForm(); return; }
  show(()=>[head("Monthly stock count","Enter what you actually counted. Leave a box blank to skip that product.")+`<form id="f"><div class="tbl-wrap"><table><thead><tr><th>Product</th><th class="r">In the app</th><th class="r">Counted</th></tr></thead><tbody>
    ${activeProducts().map(([id,p])=>`<tr><td><div class="prod-cell">${thumb(p,1)}<span>${esc(p.name)}</span></div></td><td class="r num">${p.stock}</td><td style="width:120px"><input class="c-in num" data-pid="${id}" id="c-${id}" type="number" min="0" step="1" inputmode="numeric" aria-label="Counted ${esc(p.name)}"></td></tr>`).join("")}
    </tbody></table></div><p class="small" id="c-info"></p><div class="actions"><button class="btn primary" type="submit">Save count</button><button class="btn" type="button" data-back>Cancel</button></div></form>`,sh=>{
    const info=()=>{ let n=0; $$(".c-in",sh).forEach(i=>{ const p=S.products.get(i.dataset.pid); if(p&&i.value!==""&&Math.round(+i.value)!==p.stock) n++; }); $("#c-info",sh).textContent=n?`${n} product${n===1?"":"s"} will be corrected.`:""; };
    sh.addEventListener("input",info);
    $("#f",sh).addEventListener("submit",e=>{ e.preventDefault(); const btn=e.submitter||$("button[type=submit]",sh);
      const ch=$$(".c-in",sh).filter(i=>i.value!==""&&S.products.get(i.dataset.pid)).map(i=>[i.dataset.pid,Math.max(0,Math.round(+i.value))-S.products.get(i.dataset.pid).stock]);
      if(!ch.length){ toast("Enter at least one count"); return; } const diffs=ch.filter(([,d])=>d);
      guarded(btn,async()=>{ const d0=today();
        const records=(diffs.length?diffs:[[ch[0][0],0]]).map(([pid,qty],index)=>({id:"count_"+countId+"_"+index,data:{productId:pid,qty,expectedStock:S.products.get(pid).stock,reason:"Stock count",date:d0,note:"Monthly count"}}));
        try{await window.APP.request("POST","/api/moves/batch",{records,batchId:countId});}catch(e){if(e.code!=="approval_required")throw e;await window.APP.request("POST","/api/authorizations",{collection:"stockBatch",id:countId,data:{records},reason:"Review the monthly stock count adjustments"});toast("Stock count sent for owner approval");back();return;}
        toast(diffs.length?`Stock corrected for ${diffs.length} product${diffs.length===1?"":"s"}`:"Count saved. Everything matched."); back(); });
    });
  }]);
}
function openingForm(dealerId,editId){
  if(!activeDealers().length&&!editId){ toast("Add a dealer first"); dealerForm(); return; }
  const old=editId?S.txns.get(editId):null;
  const recordRef=db.collection("txns").doc(editId||undefined);
  show(()=>[head(old?`Edit opening balance ${esc(old.no||"")}`:"Opening balance","What the dealer already owed before you started using this ledger")+`<form id="f" class="form-grid">
    <label class="f span">Dealer<select id="o-dealer" required><option value="">Choose dealer…</option>${dealerOptions(old?old.dealerId:dealerId)}</select></label>
    <label class="f">Amount owed (₱)<input id="o-amt" type="number" min="0.01" step="0.01" required value="${old?old.amount:""}"></label>
    <label class="f">Date they took the goods<input id="o-date" type="date" required value="${old?old.date:today()}"></label>
    <label class="f">Due date<input id="o-due" type="date" required value="${old?old.dueDate:""}"></label>
    <label class="f span">Note<input id="o-note" value="${esc(old?old.note:"Opening balance")}"></label>
    <p class="hint span" style="margin:0">If they took goods on different dates, add one opening balance per date so the overdue days are right. Stock is not changed.</p>
    ${old?correctionField():""}<div class="actions span"><button class="btn primary" type="submit">${old?"Save changes":"Add opening balance"}</button><button class="btn" type="button" data-back>Cancel</button></div></form>`,sh=>{
    const setDue=()=>{ if(old) return; const d=S.dealers.get($("#o-dealer").value); $("#o-due").value=addDays($("#o-date").value||today(),d?d.terms??30:(S.settings.defaultTerms??30)); };
    setDue(); $("#o-dealer").addEventListener("change",setDue); $("#o-date").addEventListener("change",setDue);
    $("#f",sh).addEventListener("submit",e=>{ e.preventDefault(); const btn=e.submitter||$("button[type=submit]",sh);
      const did=$("#o-dealer").value, amt=r2($("#o-amt").value); if(!did||amt<=0){ toast("Enter the dealer and amount"); return; }
      const f={dealerId:did,date:$("#o-date").value,dueDate:$("#o-due").value,note:$("#o-note").value.trim()};
      const data=old?{...old,...f,amount:amt,subtotal:amt,updated:stamp()}:openingDoc(did,amt,f.date,f.dueDate,f.note);
      if(old)data.correctionReason=$("#correction-reason",sh).value.trim();else{delete data.createdAt;delete data.createdBy;delete data.no;}
      guarded(btn,async()=>{ await recordRef.set(data,{version:old?._version}); toast(old?"Opening balance updated":`Opening balance ${data.no} added`); back(); });
    });
  }]);
}

/* ---------- receipts ---------- */
function balanceAfter(t){ let run=0; for(const [,x] of dealerTxns(t.dealerId)){ run=r2(run+(x.type==="sale"?x.amount:-x.amount)); if(x===t) return run; } return status(t.dealerId).balance; }
const RC_TITLE={sale:"DELIVERY RECEIPT",payment:"ACKNOWLEDGEMENT RECEIPT",return:"RETURN SLIP"};
function receiptText(id){
  const t=S.txns.get(id), d=S.dealers.get(t.dealerId)||{name:"(removed dealer)"}, s=S.settings; const L=[];
  L.push(s.storeName||"Dealer Credit Ledger"); if(s.address||s.phone) L.push([s.address,s.phone].filter(Boolean).join(" · "));
  L.push("",`${t.opening?"OPENING BALANCE":RC_TITLE[t.type]}  ${t.no||""}`,`Date: ${fmtDate(t.date)}`,`Dealer: ${d.name}${d.phone?" ("+d.phone+")":""}`);
  if(t.voided) L.push("*** VOIDED ***");
  if(t.items&&t.items.length){ L.push(""); t.items.forEach((i,k)=>L.push(`${k+1}. ${i.name}\n   ${i.qty} × ${P(i.price)} = ${P(i.qty*i.price)}`)); L.push("");
    if(t.pctDiscount||t.discount) L.push(`${t.pctDiscount?"Total at SRP":"Subtotal"}: ${P(t.subtotal)}`);
    if(t.pctDiscount) L.push(`${discLabel(t)}: −${P(t.pctDiscount)}`);
    if(t.discount) L.push(`Extra discount: −${P(t.discount)}`); }
  L.push(t.type==="sale"?`TOTAL ON CREDIT: ${P(t.amount)}`:t.type==="payment"?`AMOUNT RECEIVED: ${P(t.amount)}`:`TOTAL CREDITED: ${P(t.amount)}`);
  if(t.type==="sale") L.push(`Due date: ${fmtDate(t.dueDate)}`);
  if(t.type==="payment"){ L.push(`Paid by: ${t.method}${t.ref?" · Ref "+t.ref:""}`); if(t.payKind) L.push({full:"FULL PAYMENT",partial:"PARTIAL PAYMENT",advance:"ADVANCE PAYMENT"}[t.payKind]); (t.applied||[]).forEach(a=>L.push(`  ${a.no}: ${P(a.amount)}${a.left>0.004?` (${P(a.left)} still owed)`:" (fully paid)"}`)); }
  if(!t.voided) L.push(`Balance after this: ${P(balanceAfter(t))}`);
  if(t.note&&t.note!=="Opening balance") L.push(`Note: ${t.note}`);
  if(t.type==="sale"&&s.paymentInfo) L.push("","How to pay: "+s.paymentInfo);
  L.push("","This is not an official receipt.",s.footer??"Salamat po!"); return L.join("\n");
}
function receiptSheet(id){
  if(S.txns.get(id)?.type==="refund"){refundReceiptSheet(id);return;}
  show(()=>{ const t=S.txns.get(id); if(!t) return [head("Receipt")+`<div class="empty"><p>Loading the receipt…</p></div>`];
  const d=S.dealers.get(t.dealerId)||{name:"(removed dealer)"}, s=S.settings, items=t.items||[];
  const canPrint=!!window.APP;
  return [`<div class="no-print">${head("Receipt "+esc(t.no||""),canPrint?"Print it or copy the text to send.":"Copy the text and send it to the dealer.")}
    <div class="actions" style="margin-bottom:14px">${canPrint?`<button class="btn primary" type="button" id="rc-print">Print</button>`:""}<button class="btn ${canPrint?"":"primary"}" type="button" id="rc-copy">Copy as text</button><button class="btn" type="button" data-tx="${esc(id)}">Details</button></div></div>
    <article class="receipt" id="rcpt">
      <div class="rc-head"><div><h2>${esc(s.storeName||"Dealer Credit Ledger")}</h2><div class="small">${esc([s.address,s.phone].filter(Boolean).join(" · "))}</div></div>
        <div class="rc-title"><b>${t.opening?"OPENING BALANCE":RC_TITLE[t.type]}</b><div class="num">No. <b>${esc(t.no||"—")}</b></div><div>${fmtDate(t.date)}</div></div></div>
      ${t.voided?`<p class="rc-void">VOIDED${t.voidReason?" · "+esc(t.voidReason):""}</p>`:""}
      <dl class="kv rc-kv"><dt>Dealer</dt><dd><b>${esc(d.name)}</b></dd>${d.phone?`<dt>Mobile</dt><dd>${esc(d.phone)}</dd>`:""}${d.area?`<dt>Address</dt><dd>${esc(d.area)}</dd>`:""}
        ${t.type==="sale"?`<dt>Due date</dt><dd><b>${fmtDate(t.dueDate)}</b>${d.terms!=null?` (${d.terms}-day terms)`:""}</dd>`:""}
        ${t.type==="payment"?`<dt>Paid by</dt><dd>${esc(t.method)}${t.ref?" · Ref "+esc(t.ref):""}</dd>${t.payKind?`<dt>Payment</dt><dd><b>${{full:"Full payment",partial:"Partial payment",advance:"Advance payment"}[t.payKind]}</b></dd>`:""}`:""}</dl>
      ${t.type==="payment"&&(t.applied||[]).length?`<table class="rc-tbl"><thead><tr><th>Applied to</th><th class="r">Paid now</th><th class="r">Still owed</th></tr></thead><tbody>${t.applied.map(a=>`<tr><td>${esc(a.no)}</td><td class="r num">${P(a.amount)}</td><td class="r num">${a.left>0.004?P(a.left):"Fully paid"}</td></tr>`).join("")}</tbody></table>`:""}
      ${items.length?`<table class="rc-tbl"><thead><tr><th>#</th><th>Item</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Amount</th></tr></thead><tbody>
        ${items.map((i,k)=>`<tr><td class="num">${k+1}</td><td>${esc(i.name)}${i.promo?" <small>(promo)</small>":""}${t.discountPct==null&&i.pct!=null?` <small>(less ${i.pct}%)</small>`:""}</td><td class="r num">${i.qty}</td><td class="r num">${P(i.price)}</td><td class="r num">${P(i.qty*i.price)}</td></tr>`).join("")}</tbody>
        <tfoot>${t.pctDiscount||t.discount?`<tr><td colspan="4" class="r">${t.pctDiscount?"Total at SRP":"Subtotal"}</td><td class="r num">${P(t.subtotal)}</td></tr>`:""}${t.pctDiscount?`<tr><td colspan="4" class="r">${discLabel(t)}</td><td class="r num">−${P(t.pctDiscount)}</td></tr>`:""}${t.discount?`<tr><td colspan="4" class="r">Extra discount</td><td class="r num">−${P(t.discount)}</td></tr>`:""}</tfoot></table>`:""}
      <div class="rc-total"><span>${t.type==="sale"?"Total on credit":t.type==="payment"?"Amount received":"Total credited"}</span><b class="num">${P(t.amount)}</b></div>
      ${t.voided?"":`<p class="rc-bal">Balance after this: <b class="num">${P(balanceAfter(t))}</b></p>`}
      ${t.note&&t.note!=="Opening balance"?`<p class="small">Note: ${esc(t.note)}</p>`:""}
      ${t.type==="sale"&&s.paymentInfo?`<p class="small"><b>How to pay:</b> ${esc(s.paymentInfo)}</p>`:""}
      <div class="rc-sign">${t.type==="payment"?`<div><span></span>Received by (store)</div>`:`<div><span></span>Released by</div><div><span></span>Received by (dealer)</div>`}</div>
      <p class="rc-foot">This is not an official receipt. ${esc(s.footer??"Salamat po!")}</p>
    </article>`,sh=>{
    const pr=$("#rc-print",sh); if(pr) pr.addEventListener("click",()=>window.print());
    $("#rc-copy",sh).addEventListener("click",()=>copyText(receiptText(id),"Receipt "+(t.no||"")));
  }]; },true);
}

/* ---------- 12-month trend chart ---------- */
function trendData(){
  const d0=new Date(), out=[];
  for(let i=11;i>=0;i--){ const dt=new Date(d0.getFullYear(),d0.getMonth()-i,1); out.push({ym:ymd(dt).slice(0,7),label:dt.toLocaleDateString("en-PH",{month:"short"}),long:dt.toLocaleDateString("en-PH",{month:"long",year:"numeric"}),sales:0,coll:0}); }
  const idx=Object.fromEntries(out.map((m,k)=>[m.ym,k]));
  S.txns.forEach(t=>{ if(!isLive(t)) return; const k=idx[(t.date||"").slice(0,7)]; if(k===undefined) return;
    if(t.type==="sale"&&!t.opening) out[k].sales+=t.amount; else if(t.type==="payment") out[k].coll+=t.amount; });
  return out;
}
const compactP=n=>n>=1e6?"₱"+(n/1e6).toFixed(n%1e6?1:0)+"M":n>=1e3?"₱"+(n/1e3).toFixed(n%1e3?1:0)+"k":"₱"+Math.round(n);
function niceMax(v){ if(v<=0) return 1000; const p=Math.pow(10,Math.floor(Math.log10(v))); for(const m of [1,2,2.5,5,10]) if(m*p>=v) return m*p; return 10*p; }
function trendChart(){
  const data=trendData(), max=niceMax(Math.max(...data.map(m=>Math.max(m.sales,m.coll))));
  const W=720,H=240,L=52,R=8,T=12,B=28, iw=W-L-R, ih=H-T-B, gw=iw/12, bw=Math.min(18,(gw-10)/2);
  const y=v=>T+ih-(v/max)*ih;
  const bar=(x,v,cls)=>{ if(v<=0) return ""; const h=Math.max(2,(v/max)*ih), r=Math.min(4,h/2), yy=T+ih-h;
    return `<path class="${cls}" d="M${x},${T+ih} V${yy+r} Q${x},${yy} ${x+r},${yy} H${x+bw-r} Q${x+bw},${yy} ${x+bw},${yy+r} V${T+ih} Z"/>`; };
  const ticks=[0,.25,.5,.75,1].map(f=>f*max);
  const svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Credit sales and collections for the last 12 months" class="trend-svg">
    ${ticks.map(v=>`<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" class="grid${v===0?" base":""}"/><text x="${L-8}" y="${y(v)+4}" text-anchor="end" class="ax">${compactP(v)}</text>`).join("")}
    ${data.map((m,k)=>{ const x0=L+k*gw+(gw-(2*bw+2))/2; return `<g>${bar(x0,m.sales,"s1")}${bar(x0+bw+2,m.coll,"s2")}<text x="${L+k*gw+gw/2}" y="${H-8}" text-anchor="middle" class="ax">${m.label}</text><rect x="${L+k*gw}" y="${T}" width="${gw}" height="${ih}" class="hit" data-m="${k}"/></g>`; }).join("")}
  </svg>`;
  const tot=data.reduce((a,m)=>({s:a.s+m.sales,c:a.c+m.coll}),{s:0,c:0});
  return `<section class="panel" style="margin-bottom:20px">
    <div class="panel-head"><h2>Last 12 months</h2><div class="legend-row"><span><i class="sw s1"></i>Credit sales <b class="num">${P(tot.s)}</b></span><span><i class="sw s2"></i>Collections <b class="num">${P(tot.c)}</b></span></div></div>
    <div class="trend" id="trend">${svg}<div class="tip" id="trendTip" hidden></div></div>
    <details class="small" style="margin-top:8px"><summary>Show as table</summary><div class="tbl-wrap"><table><thead><tr><th>Month</th><th class="r">Credit sales</th><th class="r">Collections</th><th class="r">Difference</th></tr></thead><tbody>${data.map(m=>`<tr><td>${m.long}</td><td class="r num">${P(m.sales)}</td><td class="r num">${P(m.coll)}</td><td class="r num">${P(m.coll-m.sales)}</td></tr>`).join("")}</tbody></table></div></details>
  </section>`;
}
function mountTrend(){
  const box=$("#trend"); if(!box) return; const tip=$("#trendTip"); const data=trendData();
  const showTip=(el)=>{ const m=data[el.dataset.m]; const br=box.getBoundingClientRect(), r=el.getBoundingClientRect();
    tip.innerHTML=`<b>${m.long}</b><div><i class="sw s1"></i>Credit sales <span class="num">${P(m.sales)}</span></div><div><i class="sw s2"></i>Collections <span class="num">${P(m.coll)}</span></div>`;
    tip.hidden=false; const x=r.left-br.left+r.width/2; tip.style.left=Math.min(Math.max(8,x-tip.offsetWidth/2),br.width-tip.offsetWidth-8)+"px"; tip.style.top="4px";
    $$(".hit",box).forEach(h=>h.classList.toggle("on",h===el)); };
  $$(".hit",box).forEach(h=>{ h.addEventListener("mouseenter",()=>showTip(h)); h.addEventListener("click",()=>showTip(h)); });
  box.addEventListener("mouseleave",()=>{ tip.hidden=true; $$(".hit",box).forEach(h=>h.classList.remove("on")); });
}

/* ---------- online orders (dealer portal, Node.js server) ---------- */
const ORD_L={new:"New",preparing:"Preparing",ready:"Ready for pickup",released:"Released",cancelled:"Cancelled"};
const ORD_C={new:"bad",preparing:"warn",ready:"good",released:"neutral",cancelled:"neutral"};
const ordPill=o=>`<span class="pill ${ORD_C[o.status]}">${ORD_L[o.status]||esc(o.status)}</span>`;
const activeOrders=()=>[...S.orders.entries()].filter(([,o])=>["new","preparing","ready"].includes(o.status));
function vOrders(){
  const f=S.ordFilter||"active";
  const rows=[...S.orders.entries()].filter(([,o])=>f==="all"||(f==="active"?["new","preparing","ready"].includes(o.status):o.status===f))
    .sort((a,b)=>{ const rank=o=>({new:0,preparing:1,ready:2}[o.status]??3); return rank(a[1])-rank(b[1])||(a[1].pickupDate||"9").localeCompare(b[1].pickupDate||"9")||(b[1].createdAt||0)-(a[1].createdAt||0); });
  const cnt=k=>[...S.orders.values()].filter(o=>o.status===k).length;
  return `<section class="panel">
    <div class="panel-head"><h2>Online orders</h2><span class="small muted">${cnt("new")} new · ${cnt("preparing")} preparing · ${cnt("ready")} ready</span></div>
    <div class="toolbar"><div class="seg" role="group" aria-label="Show">${[["active","To prepare"],["released","Released"],["cancelled","Cancelled"],["all","All"]].map(([v,l])=>`<button type="button" data-of="${v}" aria-pressed="${f===v}">${l}</button>`).join("")}</div></div>
    ${rows.length?`<div class="tbl-wrap"><table><thead><tr><th>Order</th><th>Dealer</th><th>Pickup</th><th class="r">Items</th><th class="r">Amount</th><th>Status</th></tr></thead><tbody>
    ${rows.map(([id,o])=>{ const d=S.dealers.get(o.dealerId); const pcs=(o.items||[]).reduce((a,i)=>a+i.qty,0); const late=o.pickupDate&&o.pickupDate<today()&&["new","preparing","ready"].includes(o.status);
      return `<tr class="click" tabindex="0" data-order="${esc(id)}"><td><b>${esc(o.no||"")}</b><div class="small muted">${fmtStamp(o.createdAt)}</div></td><td>${esc(d?d.name:"(removed dealer)")}</td><td class="small nowrap">${o.pickupDate?fmtDate(o.pickupDate):"Anytime"}${late?` <span class="pill warn">past</span>`:""}</td><td class="r num">${(o.items||[]).length} · ${pcs} pcs</td><td class="r num">${P(o.amount)}</td><td>${ordPill(o)}</td></tr>`; }).join("")}
    </tbody></table></div>`:`<div class="empty"><h3>${f==="active"?"No orders to prepare":"No orders here"}</h3><p>Orders dealers send from their portal appear here as soon as they're placed.</p></div>`}
  </section>`;
}
function orderMessage(o){ const d=S.dealers.get(o.dealerId)||{name:""}; const s=S.settings;
  const m={preparing:`we're now preparing your order ${o.no}`,ready:`your order ${o.no} is ready for pickup${o.pickupDate?` (${fmtDate(o.pickupDate)})`:""}. Total ${P(o.amount)}`,cancelled:`your order ${o.no} was cancelled${o.cancelReason?": "+o.cancelReason:""}`,new:`we received your order ${o.no}`,released:`your order ${o.no} has been released`}[o.status];
  return `Hi ${d.name.split(" ")[0]}, ${m}. ${s.storeName?"– "+s.storeName:""} Salamat po!`.replace(/\s+/g," ").trim(); }
function orderSheet(id){
  show(()=>{ const o=S.orders.get(id); if(!o) return [head("Order")+`<div class="empty"><p>This order was removed.</p></div>`];
  const d=S.dealers.get(o.dealerId), st=d?status(o.dealerId):null, items=o.items||[];
  resolveNames((o.statusHistory||[]).map(h=>h.by));
  const short=items.filter(i=>{ const p=S.products.get(i.productId); return !p||p.stock<i.qty; });
  const open=["new","preparing","ready"].includes(o.status);
  return [head(`Order ${esc(o.no||"")} ${ordPill(o)}`,`${esc(d?d.name:"(removed dealer)")} · placed ${fmtStamp(o.createdAt)}${o.source==="portal"?" from the dealer portal":""}`)+`
    <dl class="kv"><dt>Pickup</dt><dd><b>${o.pickupDate?fmtDate(o.pickupDate):"Anytime"}</b></dd>${o.note?`<dt>Dealer's note</dt><dd>${esc(o.note)}</dd>`:""}
      ${d?`<dt>Dealer balance</dt><dd class="num">${P(st.balance)}${st.overdue?` · <span style="color:var(--bad)">${P(st.overdue)} overdue</span>`:""}</dd>`:""}${o.saleNo?`<dt>Credit sale</dt><dd><b>${esc(o.saleNo)}</b></dd>`:""}${o.cancelReason?`<dt>Cancelled</dt><dd>${esc(o.cancelReason)}</dd>`:""}</dl>
    ${d&&st.maxLate>holdDays()&&open?`<div class="notice bad"><p><b>This dealer is on credit hold</b> (${st.maxLate} days late). Collect payment before releasing${S.canAdmin?", or approve the release":""}.</p></div>`:""}
    ${open&&short.length?`<div class="notice warn"><p><b>Not enough stock</b> for ${short.map(i=>esc(i.name)).join(", ")}.</p></div>`:""}
    <section class="panel" style="margin-bottom:16px"><h2>Items to prepare</h2><div class="tbl-wrap"><table><thead><tr><th>#</th><th>Product</th><th class="r">Qty</th><th class="r">In stock</th><th class="r">Amount</th></tr></thead><tbody>
      ${items.map((i,k)=>{ const p=S.products.get(i.productId); const ok=p&&p.stock>=i.qty; return `<tr><td class="muted num">${k+1}</td><td><div class="prod-cell">${thumb(p,1)}<span>${esc(i.name)}</span></div></td><td class="r num"><b>${i.qty}</b></td><td class="r num">${p?(ok?p.stock:`<span class="pill bad">${p.stock}</span>`):"—"}</td><td class="r num">${P(i.qty*i.price)}</td></tr>`; }).join("")}</tbody>
      <tfoot><tr><td colspan="4" class="r">Total at SRP</td><td class="r num">${P(o.subtotal)}</td></tr><tr><td colspan="4" class="r">${discLabel(o)}</td><td class="r num">−${P(o.pctDiscount)}</td></tr><tr><td colspan="4" class="r">Estimated total</td><td class="r num">${P(o.amount)}</td></tr></tfoot></table></div></section>
    ${S.canWrite?`<div class="actions" style="margin-bottom:16px">
      ${o.status==="new"?`<button class="btn primary" data-ost="preparing" type="button">Start preparing</button>`:""}
      ${o.status==="preparing"?`<button class="btn primary" data-ost="ready" type="button">Mark ready for pickup</button>`:""}
      ${o.status==="ready"||o.status==="preparing"?`<button class="btn ${o.status==="ready"?"primary":""}" id="o-release" type="button">Release as credit sale</button>`:""}
      <button class="btn" id="o-msg" type="button">Copy message to dealer</button>
      ${o.saleId?`<button class="btn" data-tx="${esc(o.saleId)}" type="button">Open ${esc(o.saleNo||"sale")}</button>`:""}
    </div>
    ${open?`<section class="panel"><h2>Cancel this order</h2><div class="actions"><input id="o-reason" placeholder="Reason, e.g. out of stock" style="flex:1;min-width:180px"><button class="btn danger" id="o-cancel" type="button">Cancel order</button></div></section>`:""}`:""}
    ${(o.statusHistory||[]).length?`<h3 style="font-size:14px;margin:16px 0 8px">Timeline</h3><table><tbody>${o.statusHistory.slice().reverse().map(h=>`<tr><td class="small nowrap">${fmtStamp(h.at)}</td><td>${ORD_L[h.status]||esc(h.status)}</td><td class="small muted">${esc(h.by===o.createdBy&&o.source==="portal"?"Dealer":nameOf(h.by))}</td></tr>`).join("")}</tbody></table>`:""}`,sh=>{
    const setStatus=(btn,status,extra)=>guarded(btn,async()=>{ await db.doc("orders/"+id).set({...S.orders.get(id),status,...(extra||{})}); toast(`${o.no} · ${ORD_L[status]}`); });
    $$("[data-ost]",sh).forEach(b=>b.addEventListener("click",()=>setStatus(b,b.dataset.ost)));
    const c=$("#o-cancel",sh); if(c) c.addEventListener("click",()=>{ if(armed(c,"Tap again to cancel")) setStatus(c,"cancelled",{cancelReason:$("#o-reason").value.trim()||"Cancelled by the store"}); });
    const m=$("#o-msg",sh); if(m) m.addEventListener("click",()=>copyText(orderMessage(S.orders.get(id)),"Message to dealer"));
    const r=$("#o-release",sh); if(r) r.addEventListener("click",()=>itemsForm("sale",o.dealerId,null,{orderId:id,items:items.map(i=>({...i})),pct:o.discountPct,note:`Online order ${o.no}`}));
  }]; },true);
}

/* ================= cashier shifts, period locks, duplicate watch ================= */
function monthLabel(m){ return new Date(m+"-01T00:00:00").toLocaleDateString("en-PH",{month:"long",year:"numeric"}); }
function recentMonths(n){ const out=[],d=new Date(); for(let i=0;i<n;i++) out.push(ymd(new Date(d.getFullYear(),d.getMonth()-i,1)).slice(0,7)); return out; }
function monthStats(month){
  const live=rows=>rows.filter(r=>!r.voided&&typeof r.date==="string"&&r.date.slice(0,7)===month);
  const tx=live([...S.txns.values()]),expenses=live([...S.expenses.values()]),moves=live([...S.moves.values()]);
  const sum=type=>r2(tx.filter(t=>t.type===type).reduce((n,t)=>n+Number(t.amount||0),0));
  return {month,transactions:tx.length,sales:sum("sale"),payments:sum("payment"),returns:sum("return"),refunds:sum("refund"),expenses:r2(expenses.reduce((n,e)=>n+Number(e.amount||0),0)),expenseCount:expenses.length,stockMoves:moves.length};
}
function shiftCashTotals(from,to){
  let cashIn=0,cashOut=0;
  S.txns.forEach(t=>{
    if(t.voided||t.method!=="Cash")return; const at=Number(t.createdAt); if(!(at>=from&&at<=to))return;
    if(t.type==="payment")cashIn+=r2(t.amount); else if(t.type==="refund")cashOut+=r2(t.amount);
  });
  S.expenses.forEach(e=>{ if(e.voided||e.method!=="Cash")return; const at=Number(e.createdAt); if(at>=from&&at<=to)cashOut+=r2(e.amount); });
  S.purchases.forEach(p=>{
    for(const ev of p.payments||[]){ if(ev.voided||ev.method!=="Cash")continue; const at=Number(ev.at); if(at>=from&&at<=to)cashOut+=r2(ev.amount); }
    for(const ev of p.refunds||[]){ if(ev.voided||ev.method!=="Cash")continue; const at=Number(ev.at); if(at>=from&&at<=to)cashIn+=r2(ev.amount); }
  });
  return {cashIn:r2(cashIn),cashOut:r2(cashOut)};
}
function vShifts(){
  const rows=[...S.cashierShifts.entries()].sort((a,b)=>(b[1].openedAt||0)-(a[1].openedAt||0));
  const mine=rows.find(([,s])=>s.status==="open"&&s.cashierId===S.me);
  const openCount=rows.filter(([,s])=>s.status==="open").length;
  let mineNotice="";
  if(mine){ const s=mine[1],t=shiftCashTotals(Number(s.openedAt),Date.now()),expected=r2(Number(s.openingCash||0)+t.cashIn-t.cashOut);
    mineNotice=`<div class="notice info"><p><b>Your shift is open${s.register?" at "+esc(s.register):""}.</b> Opening ${P(s.openingCash)}, cash in ${P(t.cashIn)}, cash out ${P(t.cashOut)}. Expected in drawer ${P(expected)}.</p><button class="btn" data-act="close-shift" data-id="${esc(mine[0])}" type="button">Close shift</button></div>`; }
  const table=rows.length?`<div class="tbl-wrap"><table><thead><tr><th>Opened</th><th>Cashier / register</th><th class="r">Opening</th><th class="r">Cash in</th><th class="r">Cash out</th><th class="r">Expected</th><th class="r">Closing</th><th>Variance</th><th></th></tr></thead><tbody>${rows.map(([id,s])=>{
    const open=s.status==="open",t=open?shiftCashTotals(Number(s.openedAt),Date.now()):{cashIn:Number(s.cashIn)||0,cashOut:Number(s.cashOut)||0};
    const expected=open?r2(Number(s.openingCash||0)+t.cashIn-t.cashOut):Number(s.expectedCash)||0,vari=open?null:Number(s.variance)||0;
    return `<tr><td>${fmtDate(s.date)}<div class="small muted">${fmtStamp(s.openedAt)}</div></td><td>${esc(s.cashierName||nameOf(s.cashierId))}${s.register?`<div class="small muted">${esc(s.register)}</div>`:""}</td><td class="r num">${P(s.openingCash)}</td><td class="r num">${P(t.cashIn)}</td><td class="r num">${P(t.cashOut)}</td><td class="r num">${P(expected)}</td><td class="r num">${open?"—":P(s.closingCash)}</td><td>${open?`<span class="pill warn">Open</span>`:`<span class="pill ${vari===0?"good":vari>0?"warn":"bad"}">${vari===0?"Balanced":P(vari)}</span>${s.closeNote?`<div class="small muted">${esc(s.closeNote)}</div>`:""}`}</td><td>${open&&S.canWrite?`<button class="btn sm" data-act="close-shift" data-id="${esc(id)}" type="button">Close</button>`:""}</td></tr>`;
  }).join("")}</tbody></table></div>`:`<p class="small muted">No shifts recorded yet.</p>`;
  return `<section class="panel"><div class="panel-head"><h2>Cashier shifts</h2><div class="actions">${S.canWrite&&!mine?`<button class="btn primary" data-act="new-shift" type="button">Open shift</button>`:""}</div></div><p class="small muted">Record the cash in your drawer when you start and count it when you hand over. Expected cash adds collections and supplier refunds, then subtracts customer refunds, cash expenses and supplier payments recorded during the shift. A shortage or overage needs a note.</p><div class="kpis"><div class="kpi"><div class="lbl">Open shifts</div><div class="val">${openCount}</div></div><div class="kpi"><div class="lbl">Shifts recorded</div><div class="val">${rows.length}</div></div></div>${mineNotice}${table}</section>`;
}
function shiftOpenForm(){
  show(()=>[head("Open cashier shift")+`<form id="shift-open" class="form-grid"><label class="f">Business date<input id="sh-date" type="date" required max="${today()}" value="${today()}"></label><label class="f">Register / drawer<input id="sh-register" maxlength="80" placeholder="e.g. Counter 1"></label><label class="f">Opening cash (₱)<input id="sh-opening" type="number" min="0" max="1000000000" step="0.01" required value="0"></label><label class="f span">Note<input id="sh-note" maxlength="1000"></label><p class="hint span">Only one shift can be open for your account at a time.</p><div class="actions span"><button class="btn primary" type="submit">Open shift</button><button class="btn" type="button" data-back>Cancel</button></div></form>`,sh=>$("#shift-open",sh).addEventListener("submit",e=>{e.preventDefault();guarded(e.submitter,async()=>{await window.APP.request("POST","/api/shifts/open",{date:$("#sh-date",sh).value,register:$("#sh-register",sh).value.trim(),openingCash:Number($("#sh-opening",sh).value),note:$("#sh-note",sh).value.trim()});toast("Cashier shift opened");back();});})]);
}
function shiftCloseForm(id){
  const s=S.cashierShifts.get(id); if(!s)return;
  const t=shiftCashTotals(Number(s.openedAt),Date.now()),expected=r2(Number(s.openingCash||0)+t.cashIn-t.cashOut);
  show(()=>[head("Close cashier shift",fmtDate(s.date)+(s.register?" · "+s.register:""))+`<dl class="kv"><dt>Opening cash</dt><dd class="num">${P(s.openingCash)}</dd><dt>Cash in</dt><dd class="num">${P(t.cashIn)}</dd><dt>Cash out</dt><dd class="num">${P(t.cashOut)}</dd><dt>Expected in drawer</dt><dd class="num"><b>${P(expected)}</b></dd></dl><form id="shift-close" class="form-grid"><label class="f">Closing cash counted (₱)<input id="sc-cash" type="number" min="0" max="1000000000" step="0.01" required value="${expected.toFixed(2)}"></label><label class="f">Variance<div id="sc-variance" class="num" style="padding:8px 0">Balanced</div></label><label class="f span">Note explaining any shortage or overage<input id="sc-note" maxlength="1000"></label><div class="actions span"><button class="btn primary" type="submit">Close shift</button><button class="btn" type="button" data-back>Cancel</button></div></form>`,sh=>{
    const cash=$("#sc-cash",sh),out=$("#sc-variance",sh);
    const update=()=>{const v=r2(Number(cash.value||0)-expected);out.textContent=v===0?"Balanced":`${v>0?"Overage":"Shortage"} ${P(Math.abs(v))}`;out.className="num"+(v===0?" muted":v>0?"":" bad");};
    cash.addEventListener("input",update);update();
    $("#shift-close",sh).addEventListener("submit",e=>{e.preventDefault();const v=r2(Number(cash.value||0)-expected);if(v!==0&&!$("#sc-note",sh).value.trim()){toast("Explain the cash shortage or overage before closing","error");return;}guarded(e.submitter,async()=>{await window.APP.request("POST",`/api/shifts/${encodeURIComponent(id)}/close`,{closingCash:Number(cash.value),note:$("#sc-note",sh).value.trim()});toast("Cashier shift closed");back();});});
  }]);
}
function vPeriods(){
  if(!S.canAdmin)return `<section class="panel"><p>Period locking is available to the owner and editors.</p></section>`;
  const locks=[...S.periodLocks.values()];
  const rows=recentMonths(12).map(m=>({...monthStats(m),lock:locks.find(l=>l.month===m&&l.status==="closed")||null}));
  const table=`<div class="tbl-wrap"><table><thead><tr><th>Month</th><th class="r">Credit sales</th><th class="r">Payments</th><th class="r">Expenses</th><th class="r">Transactions</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(r=>`<tr><td><b>${esc(monthLabel(r.month))}</b></td><td class="r num">${P(r.sales)}</td><td class="r num">${P(r.payments)}</td><td class="r num">${P(r.expenses)}</td><td class="r">${r.transactions}</td><td>${r.lock?`<span class="pill good">Finalized</span>${r.lock.reason?`<div class="small muted">${esc(r.lock.reason)}</div>`:""}`:`<span class="pill neutral">Open</span>`}</td><td>${r.lock?(S.acct?.role==="owner"?`<button class="btn sm" data-act="reopen-period" data-month="${esc(r.month)}" type="button">Reopen</button>`:`<span class="small muted">Owner reopens</span>`):`<button class="btn sm primary" data-act="close-period" data-month="${esc(r.month)}" type="button">Finalize</button>`}</td></tr>`).join("")}</tbody></table></div>`;
  const history=locks.length?`<section class="panel" style="margin-top:16px"><h2>Period history</h2><div class="tbl-wrap"><table><thead><tr><th>Month</th><th>Status</th><th>Reason</th><th>Changed</th></tr></thead><tbody>${[...locks].sort((a,b)=>String(b.month).localeCompare(String(a.month))).map(l=>`<tr><td>${esc(monthLabel(l.month))}</td><td><span class="pill ${l.status==="closed"?"good":"warn"}">${esc(l.status)}</span></td><td>${esc(l.status==="closed"?l.reason:l.reopenReason||l.reason||"")}</td><td>${fmtStamp(l.status==="closed"?l.closedAt:l.reopenedAt)}</td></tr>`).join("")}</tbody></table></div></section>`:"";
  return `<section class="panel"><div class="panel-head"><h2>Monthly period locks</h2></div><p class="small muted">Finalizing a month locks every financial change dated in it: transactions, stock movements, expenses, purchases and imported records. Reopening is restricted to the owner and requires a reason. The last 12 months are shown.</p>${table}</section>${history}`;
}
function periodCloseForm(month){
  const st=monthStats(month);
  show(()=>[head("Finalize "+monthLabel(month))+`<div class="kpis"><div class="kpi"><div class="lbl">Credit sales</div><div class="val">${P(st.sales)}</div></div><div class="kpi"><div class="lbl">Payments</div><div class="val">${P(st.payments)}</div></div><div class="kpi"><div class="lbl">Expenses</div><div class="val">${P(st.expenses)}</div></div></div><p>${st.transactions} transactions · ${st.expenseCount} expenses · ${st.stockMoves} stock movements.</p><form id="period-close"><label class="f span">Reason for finalizing<input id="pc-reason" required maxlength="1000" placeholder="e.g. Month-end accounts reviewed and signed off"></label><p class="hint">Finalizing locks every financial change dated in this month. Only the owner can reopen it later.</p><div class="actions"><button class="btn primary" type="submit">Finalize month</button><button class="btn" type="button" data-back>Cancel</button></div></form>`,sh=>$("#period-close",sh).addEventListener("submit",e=>{e.preventDefault();guarded(e.submitter,async()=>{await window.APP.request("POST",`/api/periods/${encodeURIComponent(month)}/close`,{reason:$("#pc-reason",sh).value.trim()});toast(monthLabel(month)+" finalized");back();});})]);
}
function periodReopenForm(month){
  show(()=>[head("Reopen "+monthLabel(month))+`<form id="period-reopen"><label class="f">Reason for reopening<input id="pr-reason" required maxlength="1000" placeholder="e.g. Late supplier invoice needs recording"></label><p class="hint">Reopening allows financial changes in this month until it is finalized again.</p><div class="actions"><button class="btn danger" type="submit">Reopen month</button><button class="btn" type="button" data-back>Cancel</button></div></form>`,sh=>$("#period-reopen",sh).addEventListener("submit",e=>{e.preventDefault();guarded(e.submitter,async()=>{await window.APP.request("POST",`/api/periods/${encodeURIComponent(month)}/reopen`,{reason:$("#pr-reason",sh).value.trim()});toast(monthLabel(month)+" reopened");back();});})]);
}
function vDuplicates(){
  if(!S.canAdmin)return `<section class="panel"><p>Duplicate review is available to the owner and editors.</p></section>`;
  const d=S.duplicates,groups=d?.groups||[],open=groups.filter(g=>g.status==="open");
  const header=`<section class="panel" style="margin-bottom:16px"><div class="panel-head"><h2>Duplicate watch</h2><div class="actions"><label class="f" style="flex-direction:row;align-items:center;gap:6px;min-width:0">Look back (days)<input id="dupe-days" type="number" min="1" max="90" value="${S.dupeDays}" style="width:84px"></label><button class="btn primary" data-act="scan-duplicates" type="button">Scan now</button></div></div><p class="small muted">Repeated payments, credit sales and expenses with the same dealer, amount, items or payee are grouped within the review window. Nothing is voided automatically: confirm a duplicate or mark it as a false alarm with a reason.</p><div class="kpis"><div class="kpi"><div class="lbl">Open flags</div><div class="val">${open.length}</div></div><div class="kpi"><div class="lbl">Reviewed</div><div class="val">${groups.length-open.length}</div></div></div>${S.duplicatesError?`<div class="notice warn"><p>${esc(S.duplicatesError)}</p></div>`:""}</section>`;
  if(!d)return header+`<section class="panel"><p class="small muted">Scan the ledger to look for repeated payments, invoices and expenses.</p><button class="btn primary" data-act="scan-duplicates" type="button">Scan duplicates</button></section>`;
  if(!groups.length)return header+`<section class="panel"><p class="small muted">No repeated payments, invoices or expenses found in the last ${d.days} days.</p><p class="small muted">Scanned ${fmtStamp(d.scannedAt)}.</p></section>`;
  return header+groups.map(g=>`<section class="panel" style="margin-bottom:12px"><div class="panel-head"><b>${esc(g.kindLabel)} · ${P(g.amount)}</b><span class="pill ${g.status==="reviewed"?"bad":g.status==="ignored"?"neutral":"warn"}">${g.status==="reviewed"?"Confirmed duplicate":g.status==="ignored"?"False alarm":"Open"}</span></div><p>${esc(g.reason)}</p><div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Reference</th><th>Record</th><th class="r">Amount</th></tr></thead><tbody>${g.records.map(r=>`<tr><td>${fmtDate(r.date)}</td><td>${esc(r.no||"—")}</td><td>${esc(r.label)}${r.detail?`<div class="small muted">${esc(r.detail)}</div>`:""}</td><td class="r num">${P(r.amount)}</td></tr>`).join("")}</tbody></table></div>${g.status==="open"?`<div class="actions"><button class="btn danger" data-act="review-duplicate" data-id="${esc(g.id)}" data-status="reviewed" type="button">Confirm duplicate</button><button class="btn" data-act="review-duplicate" data-id="${esc(g.id)}" data-status="ignored" type="button">False alarm</button></div>`:g.review?`<p class="small">${g.status==="reviewed"?"Confirmed":"Ignored"} by ${esc(nameOf(g.review.reviewedBy))} · ${fmtStamp(g.review.reviewedAt)} · ${esc(g.review.reason)}</p>`:""}</section>`).join("")+`<p class="small muted">Scanned ${fmtStamp(d.scannedAt)} · Showing matches within ${d.days} days.</p>`;
}
async function loadDuplicates(){
  if(!S.canAdmin||!window.APP)return;
  if(S._dupeLoading)return;
  S._dupeLoading=true;S.duplicatesError="";
  try{ S.duplicates=await window.APP.request("GET","/api/duplicates?days="+encodeURIComponent(S.dupeDays)); }
  catch(e){ S.duplicatesError=e.userMsg||e.message||"Couldn't scan duplicates."; }
  finally{ S._dupeLoading=false; render(); }
}
function duplicateReviewForm(id,status){
  const g=S.duplicates?.groups.find(x=>x.id===id); if(!g)return;
  const label=status==="reviewed"?"Confirm duplicate":"Mark false alarm";
  show(()=>[head(label,`${g.kindLabel} · ${P(g.amount)}`)+`<p>${esc(g.reason)}</p><form id="duplicate-review"><label class="f span">Reason / finding<input id="dr-reason" required maxlength="1000" placeholder="${status==="reviewed"?"e.g. Same reference keyed twice":"e.g. Legitimate separate deliveries"}"></label><p class="small muted">Reviewing records the decision but never voids or changes the transactions.</p><div class="actions"><button class="btn primary" type="submit">${esc(label)}</button><button class="btn" type="button" data-back>Cancel</button></div></form>`,sh=>$("#duplicate-review",sh).addEventListener("submit",e=>{e.preventDefault();guarded(e.submitter,async()=>{await window.APP.request("POST",`/api/duplicates/${encodeURIComponent(id)}/review`,{status,reason:$("#dr-reason",sh).value.trim(),days:S.dupeDays});toast(status==="reviewed"?"Duplicate confirmed":"Marked as false alarm");back();await loadDuplicates();});})]);
}

/* ---------- icons, quick search, phone navigation ---------- */
const IC=(d,extra="")=>`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
const ICON={
  suppliers:IC('<path d="M3 21V7l9-4 9 4v14M7 10h2M15 10h2M7 14h2M15 14h2M10 21v-4h4v4"/>'),
  batches:IC('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4M8 14h3M8 17h6"/>'),
  bank:IC('<path d="M3 9l9-6 9 6H3M5 10v8M12 10v8M19 10v8M2 21h20"/>'),
  reminders:IC('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>'),
  deliveries:IC('<path d="M3 5h11v13H3zM14 10h4l3 4v4h-7M6 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4M18 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4"/>'),
  refunds:IC('<path d="M8 4 3 9l5 5M3 9h12a6 6 0 0 1 0 12M12 4h8"/>'),
  logout:IC('<path d="M9 3H4v18h5M9 12h12M17 8l4 4-4 4"/>'),
  losses:IC('<path d="M3 8l9-5 9 5v8l-9 5-9-5zM9 12h6"/>'),
  controls:IC('<path d="M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/>'),
  closing:IC('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18M8 15l3 3 5-5"/>'),
  shifts:IC('<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 11h18M8 6V4h8v2M7 16h4"/>'),
  periods:IC('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18"/><rect x="9" y="13" width="6" height="5" rx="1"/><path d="M10 13v-1.5a2 2 0 0 1 4 0V13"/>'),
  duplicates:IC('<rect x="8" y="3" width="12" height="15" rx="2"/><path d="M8 6H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-2"/><path d="M12 9h4M12 13h4"/>'),
  purchases:IC('<path d="M6 3h12v18H6zM9 7h6M9 11h6M9 15h3"/>'),
  expenses:IC('<path d="M3 6h18v14H3zM3 10h18M8 15h8"/>'),
  reorder:IC('<path d="M4 7h14l-3-3M20 17H6l3 3M18 7v5M6 17v-5"/>'),
  dashboard:IC('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
  profit:IC('<path d="M3 20h18M5 16l5-5 4 3 6-9M15 5h5v5"/>'),
  overview:IC('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/>'),
  orders:IC('<path d="M6 2h12l2 5H4z"/><path d="M4 7v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7"/><path d="M9 11a3 3 0 0 0 6 0"/>'),
  collect:IC('<circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .8-3 2s1.3 1.7 3 2 3 .9 3 2-1.3 2-3 2c-1.4 0-2.6-.6-3-1.6"/><path d="M12 6v2M12 16v2"/>'),
  dealers:IC('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.8 3 2.6 3.5 5.2"/>'),
  products:IC('<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>'),
  activity:IC('<path d="M4 6h16M4 12h16M4 18h10"/>'),
  reports:IC('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  store:IC('<path d="M3 9 4.5 4h15L21 9"/><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M5 11.5V20h14v-8.5"/>'),
  more:IC('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>'),
  search:IC('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  plus:IC('<path d="M12 5v14M5 12h14"/>','stroke-width="2.4"'),
  check:IC('<path d="m5 12.5 4.5 4.5L19 7.5"/>','stroke-width="2.4"'),
  alert:IC('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>','stroke-width="2.2"'),
  info:IC('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5v.01"/>','stroke-width="2.2"'),
  sale:IC('<path d="M6 2h12l2 5H4z"/><path d="M4 7v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7"/><path d="M12 11v6M9 14h6"/>'),
  pay:IC('<rect x="2.5" y="6" width="19" height="13" rx="2"/><path d="M2.5 10.5h19M6.5 15h3"/>'),
  ret:IC('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
  stock:IC('<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M12 8v6M9 11h6"/>'),
  person:IC('<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.2-6 8-6s7 2 8 6"/><path d="M19 3v4M17 5h4"/>'),
};
const VIEW_L={dashboard:"Dashboard",overview:"Overview",orders:"Orders",collect:"Collections",dealers:"Dealers",products:"Products",stock:"Stock history",profit:"Profit reports",purchases:"Purchase orders",expenses:"Operating expenses",reorder:"Reorder list",losses:"Stock losses",controls:"Approval controls",closing:"Daily closing",shifts:"Cashier shifts",periods:"Period locks",duplicates:"Duplicate watch",suppliers:"Suppliers",bank:"Bank reconciliation",reminders:"Collection reminders",deliveries:"Delivery proof",batches:"Batches & expiry",refunds:"Customer refunds",activity:"Transactions",reports:"Reports",store:"Store"};
function renderBottomNav(){
  const nav=$("#bnav"); if(!nav) return;
  const main=window.APP?["dashboard","orders","collect","dealers"]:["dashboard","collect","dealers","products"];
  const nNew=[...S.orders.values()].filter(o=>o.status==="new").length;
  const inMore=!main.includes(S.view);
  nav.innerHTML=main.map(v=>`<button type="button" data-nav="${v}" aria-current="${S.view===v?"page":"false"}">${ICON[v]||ICON.overview}<span>${VIEW_L[v]}</span>${v==="orders"&&nNew?`<b class="nbadge">${nNew}</b>`:""}</button>`).join("")+`<button type="button" data-nav="more" aria-current="${inMore?"page":"false"}">${ICON.more}<span>${inMore?VIEW_L[S.view]:"More"}</span></button>`;
  $("#fab").hidden=!S.canWrite;
}
function moreSheet(){
  const views=["dashboard","overview",...(window.APP?["orders"]:[]),"collect","dealers","products","stock","activity","reports","profit","purchases","expenses","reorder","losses","controls","shifts",...(S.canAdmin?["closing","periods","duplicates","bank"]:[]),"suppliers","batches","reminders","deliveries","refunds","store"];
  show(()=>[head("Go to")+`<div class="go-grid">${views.map(v=>`<button type="button" class="go" data-go="${v}" aria-current="${S.view===v?"page":"false"}">${ICON[v]||ICON.overview}<span>${VIEW_L[v]}</span></button>`).join("")}</div><button class="go" style="margin-top:12px;width:100%" data-act="logout" type="button">${ICON.logout}<span>Log out</span></button>`,sh=>{
    sh.addEventListener("click",e=>{ const b=e.target.closest("[data-go]"); if(b) goView(b.dataset.go); });
  }]);
}
function actionSheet(){
  const acts=[["new-sale","sale","Credit sale","Release products on credit"],["new-pay","pay","Payment","Money received from a dealer"],["new-return","ret","Return","Products given back"],["stock-in","stock","Stock in","Delivery from your supplier"],["new-dealer","person","New dealer",""],["new-product","products","New product",""]];
  show(()=>[head("New")+`<div class="act-grid">${acts.map(([a,i,l,d])=>`<button type="button" class="act" data-act="${a}">${ICON[i]}<span><b>${l}</b>${d?`<small>${d}</small>`:""}</span></button>`).join("")}</div>`,sh=>{
    sh.addEventListener("click",e=>{ if(e.target.closest("[data-act]")) stack.pop(); },true);
  }]);
}
function searchSheet(){
  if(stack.length&&stack[stack.length-1].search) return;
  show(()=>[`<div class="search-head"><span class="search-ic">${ICON.search}</span><input id="gs" type="search" placeholder="Dealer, product, DR/OR no., order…" autocomplete="off" aria-label="Search everything"><button class="btn sm" data-close type="button">Esc</button></div><div id="gsr" class="gs-results" role="listbox"></div>`,sh=>{
    const inp=$("#gs",sh), box=$("#gsr",sh); let sel=0, items=[];
    const run=()=>{ const q=inp.value.trim().toLowerCase(); items=[];
      if(!q){ const recent=[...S.txns.entries()].sort((a,b)=>(b[1].createdAt||0)-(a[1].createdAt||0)).slice(0,6);
        recent.forEach(([id,t])=>{ const d=S.dealers.get(t.dealerId); items.push({g:"Recent",ic:t.type==="payment"?"pay":t.type==="return"?"ret":"sale",l:`${t.no||""} · ${d?d.name:""}`,s:`${TYPE_LABEL[t.type]} · ${fmtDate(t.date)}`,a:P(t.amount),go:()=>txSheet(id)}); }); }
      else {
        const hit=(...f)=>f.join(" ").toLowerCase().includes(q);
        [...S.dealers.entries()].filter(([,d])=>hit(d.name,d.phone,d.area)).slice(0,6).forEach(([id,d])=>{ const st=status(id); items.push({g:"Dealers",ic:"dealers",l:d.name,s:[d.phone,d.area].filter(Boolean).join(" · ")||"Dealer",a:P(st.balance),go:()=>dealerSheet(id)}); });
        [...S.orders.entries()].filter(([,o])=>{ const d=S.dealers.get(o.dealerId); return hit(o.no,d&&d.name); }).slice(0,4).forEach(([id,o])=>{ const d=S.dealers.get(o.dealerId); items.push({g:"Orders",ic:"orders",l:`${o.no} · ${d?d.name:""}`,s:ORD_L[o.status],a:P(o.amount),go:()=>orderSheet(id)}); });
        [...S.txns.entries()].filter(([,t])=>{ const d=S.dealers.get(t.dealerId); return hit(t.no,t.ref,d&&d.name); }).sort((a,b)=>(b[1].date||"").localeCompare(a[1].date||"")).slice(0,6).forEach(([id,t])=>{ const d=S.dealers.get(t.dealerId); items.push({g:"Transactions",ic:t.type==="payment"?"pay":t.type==="return"?"ret":"sale",l:`${t.no||""} · ${d?d.name:""}`,s:`${TYPE_LABEL[t.type]} · ${fmtDate(t.date)}${t.voided?" · voided":""}`,a:P(t.amount),go:()=>txSheet(id)}); });
        [...S.products.entries()].filter(([,p])=>hit(p.name,p.code,p.category)).slice(0,6).forEach(([id,p])=>items.push({g:"Products",ic:"products",l:p.name,s:`${p.stock} in stock${p.category?" · "+p.category:""}`,a:p.srp?P(p.srp):"",go:()=>S.canWrite?productForm(id):goView("products")}));
      }
      sel=Math.min(sel,Math.max(0,items.length-1)); let g="";
      box.innerHTML=items.length?items.map((it,k)=>`${it.g!==g?`<div class="gs-g">${g=it.g}</div>`:""}<button type="button" class="gs-item" role="option" data-i="${k}" aria-selected="${k===sel}">${ICON[it.ic]}<span class="gs-t"><b>${esc(it.l)}</b><small>${esc(it.s)}</small></span><span class="num gs-a">${esc(it.a)}</span></button>`).join(""):`<div class="empty" style="padding:28px 8px"><p style="margin:0">${q?`Nothing matches “${esc(inp.value)}”.`:"Type to search dealers, products, receipts and orders."}</p></div>`; };
    const open=k=>{ const it=items[k]; if(!it) return; stack.pop(); it.go(); };
    inp.addEventListener("input",()=>{ sel=0; run(); });
    inp.addEventListener("keydown",e=>{ if(e.key==="ArrowDown"||e.key==="ArrowUp"){ e.preventDefault(); sel=(sel+(e.key==="ArrowDown"?1:-1)+items.length)%Math.max(1,items.length); run(); const a=$(`[data-i="${sel}"]`,box); a&&a.scrollIntoView({block:"nearest"}); } else if(e.key==="Enter"){ e.preventDefault(); open(sel); } });
    box.addEventListener("click",e=>{ const b=e.target.closest("[data-i]"); if(b) open(+b.dataset.i); });
    run(); setTimeout(()=>inp.focus(),30);
  }]); stack[stack.length-1].search=true;
}

/* ---------- monthly catalog update ---------- */
function parseTable(text){
  const rows=[]; const delim=/\t/.test(text)?"\t":(text.split(/\r?\n/)[0].split(";").length>text.split(/\r?\n/)[0].split(",").length?";":",");
  for(const line of text.split(/\r?\n/)){ if(!line.trim()) continue; const cells=[]; let cur="",q=false;
    for(let i=0;i<line.length;i++){ const c=line[i]; if(q){ if(c==='"'&&line[i+1]==='"'){cur+='"';i++;} else if(c==='"') q=false; else cur+=c; } else if(c==='"') q=true; else if(c===delim){ cells.push(cur.trim()); cur=""; } else cur+=c; }
    cells.push(cur.trim()); rows.push(cells); }
  return rows;
}
const money=v=>{ const n=parseFloat(String(v??"").replace(/[₱,\s]|php/gi,"")); return Number.isFinite(n)?r2(n):null; };
function catalogRows(text){
  const rows=parseTable(text); if(!rows.length) return {items:[],cols:null};
  const H=rows[0].map(h=>h.toLowerCase());
  const find=re=>H.findIndex(h=>re.test(h));
  const hasHead=H.some(h=>/name|product|srp|price|code|sku|desc/.test(h));
  const cols=hasHead?{code:find(/code|sku|item ?(no|#)/),name:find(/name|product|desc/),srp:find(/srp|retail|catalog|^price|regular/),promo:find(/promo|sale price|special/),cat:find(/categ|line|group|type/),pct:find(/disc/),from:find(/from|start/),to:find(/until|^to$|end/)}:{code:0,name:1,srp:2,cat:3,promo:4,pct:-1,from:-1,to:-1};
  if(cols.srp===cols.promo) cols.promo=-1;
  const get=(r,k)=>cols[k]>=0?(r[cols[k]]??""):"";
  const items=(hasHead?rows.slice(1):rows).map(r=>({code:get(r,"code"),name:get(r,"name"),srp:money(get(r,"srp")),promo:money(get(r,"promo")),cat:get(r,"cat"),pct:get(r,"pct")===""?null:money(get(r,"pct")),from:get(r,"from"),to:get(r,"to")})).filter(x=>x.name||x.code);
  return {items,cols,hasHead};
}
function catalogSheet(){
  const t=new Date(); const m0=ymd(new Date(t.getFullYear(),t.getMonth(),1)), m1=ymd(new Date(t.getFullYear(),t.getMonth()+1,0));
  const defName=t.toLocaleDateString("en-PH",{month:"long",year:"numeric"})+" catalog";
  show(()=>[head("Update catalog","Paste the new Personal Collection price list, check the changes, then apply them all at once.")+`
    <div class="form-grid">
      <label class="f span">Price list<textarea id="c-text" rows="7" placeholder="Copy rows from Excel or Google Sheets and paste here.&#10;Columns: Code, Product name, SRP, Category, Promo price&#10;&#10;PC-1001	Dishwashing Liquid 1L	145	Home care	&#10;PC-2003	Fabric Conditioner 1L	185	Laundry	159"></textarea><span class="hint">A header row is optional. Columns are recognised by name (code, name, SRP, promo, category, discount); without headers the order above is used. You can also open a CSV file.</span></label>
      <label class="f">Or open a CSV file<input id="c-file" type="file" accept=".csv,.tsv,.txt,text/csv"></label>
      <label class="f">Catalog name<input id="c-name" value="${esc(defName)}"></label>
      <label class="f">Promos start<input id="c-from" type="date" value="${m0}"></label>
      <label class="f">Promos end<input id="c-to" type="date" value="${m1}"></label>
      <label class="chk span"><input type="checkbox" id="c-dp" checked> Update each product's dealer price to SRP less ${storePct()}%</label>
      <label class="chk span"><input type="checkbox" id="c-clr" checked> Remove promos that are not in this catalog</label>
      <label class="chk span"><input type="checkbox" id="c-arch"> Archive products that are not in this catalog</label>
    </div>
    <div id="c-prev" style="margin-top:16px"></div>`,sh=>{
    let plan=null;
    const match=it=>{ const code=it.code.trim().toLowerCase(), nm=it.name.trim().toLowerCase().replace(/\s+/g," ");
      for(const [id,p] of S.products){ if(code&&p.code&&p.code.trim().toLowerCase()===code) return id; }
      for(const [id,p] of S.products){ if(nm&&p.name.trim().toLowerCase().replace(/\s+/g," ")===nm) return id; } return null; };
    const preview=()=>{ const {items,cols,hasHead}=catalogRows($("#c-text",sh).value); const box=$("#c-prev",sh);
      if(!items.length){ plan=null; box.innerHTML=""; return; }
      const seen=new Set(); const rows=items.map(it=>{ const id=match(it); if(id) seen.add(id); const p=id?S.products.get(id):null;
        const st=!p?"new":(it.srp!=null&&Number(p.srp)!==it.srp)?"change":(it.promo?"promo":"same"); return {it,id,p,st}; });
      const bad=rows.filter(r=>r.st==="new"&&!(r.it.srp>0)&&!(r.it.promo>0));
      const missing=[...S.products.entries()].filter(([id,p])=>p.active!==false&&!seen.has(id));
      const c=k=>rows.filter(r=>r.st===k).length, nPromo=rows.filter(r=>r.it.promo).length;
      plan={rows,missing};
      const lab={new:`<span class="pill good">New</span>`,change:`<span class="pill warn">Price change</span>`,promo:`<span class="pill sample">Promo</span>`,same:`<span class="pill neutral">No change</span>`};
      box.innerHTML=`<div class="stat-row"><div class="kpi"><div class="lbl">New products</div><div class="val num">${c("new")}</div></div><div class="kpi"><div class="lbl">Price changes</div><div class="val num">${c("change")}</div></div><div class="kpi"><div class="lbl">Promos</div><div class="val num">${nPromo}</div></div><div class="kpi"><div class="lbl">Not in catalog</div><div class="val num">${missing.length}</div></div></div>
        ${!hasHead?`<p class="small muted">No header row found, so columns were read as Code, Name, SRP, Category, Promo price.</p>`:cols.name<0&&cols.code<0?`<div class="notice bad"><p>Couldn't find a product name or code column. Add a header row like “Code, Name, SRP”.</p></div>`:""}
        ${bad.length?`<div class="notice warn"><p>${bad.length} new product${bad.length===1?" has":"s have"} no SRP and will be skipped.</p></div>`:""}
        <div class="tbl-wrap" style="max-height:340px;overflow:auto"><table><thead><tr><th>Product</th><th class="r">Old SRP</th><th class="r">New SRP</th><th class="r">Promo</th><th>Change</th></tr></thead><tbody>
        ${rows.map(r=>`<tr><td><b>${esc(r.it.name||r.p&&r.p.name||"")}</b><div class="small muted">${esc([r.it.code,r.it.cat].filter(Boolean).join(" · "))}</div></td><td class="r num">${r.p&&r.p.srp?P(r.p.srp):"—"}</td><td class="r num">${r.it.srp!=null?P(r.it.srp):"—"}${r.st==="change"&&r.p.srp?`<div class="small ${r.it.srp>r.p.srp?"":"muted"}">${r.it.srp>r.p.srp?"+":""}${P(r.it.srp-r.p.srp)}</div>`:""}</td><td class="r num">${r.it.promo?P(r.it.promo):"—"}</td><td>${lab[r.st]}</td></tr>`).join("")}
        ${missing.map(([,p])=>`<tr class="void"><td><b>${esc(p.name)}</b><div class="small muted">${esc(p.code||"")}</div></td><td class="r num">${p.srp?P(p.srp):"—"}</td><td class="r">—</td><td class="r">—</td><td><span class="pill neutral">${$("#c-arch",sh).checked?"Will be archived":"Not in catalog"}</span></td></tr>`).join("")}
        </tbody></table></div>
        <div class="actions" style="margin-top:14px"><button class="btn primary" type="button" id="c-apply">Apply ${rows.length-bad.length} update${rows.length-bad.length===1?"":"s"}</button><button class="btn" type="button" data-back>Cancel</button></div><div class="progress" id="c-prog" hidden style="margin-top:10px"><i></i></div>`;
      $$("[data-back]",box).forEach(b=>b.addEventListener("click",back));
      $("#c-apply",box).addEventListener("click",e=>apply(e.currentTarget)); };
    const apply=btn=>guarded(btn,async()=>{
      const name=$("#c-name",sh).value.trim()||defName, from=$("#c-from",sh).value||null, to=$("#c-to",sh).value||null, setDp=$("#c-dp",sh).checked, clr=$("#c-clr",sh).checked, arch=$("#c-arch",sh).checked;
      const pct=storePct(), now=Date.now(); const jobs=[];
      for(const {it,id,p} of plan.rows){
        if(!p&&!(it.srp>0)&&!(it.promo>0)) continue;
        const srp=it.srp!=null?it.srp:(p?p.srp:null);
        const d={...(p||{createdAt:now,createdBy:S.me,active:true,stock:0})};
        d.name=it.name||d.name; if(it.code) d.code=it.code; if(it.cat) d.category=it.cat; d.active=true;
        if(srp!=null&&(!p||Number(p.srp)!==srp)){ d.priceHistory=[...(d.priceHistory||[]),{at:now,by:S.me,catalog:name,from:p?p.srp??null:null,to:srp}].slice(-36); d.srp=srp; }
        if(setDp&&srp) d.dealerPrice=r2(srp*(1-pct/100)); else if(!d.dealerPrice) d.dealerPrice=srp?r2(srp*(1-pct/100)):0;
        if(it.pct!=null) d.discountPct=it.pct;
        if(it.promo) d.promo={price:it.promo,from:it.from||from,to:it.to||to,label:name,noDiscount:!!(p&&p.promo&&p.promo.noDiscount)};
        else if(clr&&d.promo) d.promo=null;
        d.updated=stamp(); jobs.push([id,d]);
      }
      for(const [id,p] of plan.missing){ if(arch) jobs.push([id,{...p,active:false,updated:stamp()}]); else if(clr&&p.promo) jobs.push([id,{...p,promo:null,updated:stamp()}]); }
      await reviewImport("catalog",{records:jobs.map(([id,data])=>({id,data})),settings:S.canAdmin?{...S.settings,catalogName:name,catalogAt:now}:undefined});

    });
    let tmr; $("#c-text",sh).addEventListener("input",()=>{ clearTimeout(tmr); tmr=setTimeout(preview,200); });
    $("#c-arch",sh).addEventListener("change",preview);
    $("#c-file",sh).addEventListener("change",e=>{ const f=e.target.files[0]; if(!f) return; const rd=new FileReader(); rd.onload=()=>{ $("#c-text",sh).value=rd.result; preview(); }; rd.readAsText(f); });
  }]);
}

const lineDisc=(i,t)=>i.qty*i.price*(i.pct!=null?i.pct:(t&&t.discountPct)||0)/100;
const discLabel=t=>t.discountPct!=null?`Less ${t.discountPct}% dealer discount`:"Less dealer discount";
/* ================= sheet stack ================= */
const stack=[];
function show(fn,live,centered=false){ stack.push({fn,live:!!live,centered}); paintSheet(); }
function back(){ stack.pop(); paintSheet(); }
function closeAll(){ stack.length=0; paintSheet(); }
const REDUCE=window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function paintSheet(refresh,force=false){
  const root=$("#sheetRoot"); const top=stack[stack.length-1]; let ov=$("#ov",root);
  if(!top){ if(ov&&!ov.classList.contains("closing")){ ov.classList.add("closing"); document.body.classList.remove("sheet-open"); setTimeout(()=>{ if(!stack.length) root.innerHTML=""; },REDUCE?0:180); } return; }
  if(refresh&&(!top.live||!force&&top.paintedVersion===S._ver)) return;
  const prev=ov&&$(".sheet",ov); const sc=refresh&&prev?prev.scrollTop:0;
  const [html,mount]=top.fn();top.paintedVersion=S._ver;
  if(!ov||ov.classList.contains("closing")){
    root.innerHTML=`<div class="overlay" id="ov"><div class="sheet" role="dialog" aria-modal="true"><div class="sheet-in">${html}</div></div></div>`;
    ov=$("#ov",root); ov.addEventListener("mousedown",e=>{ if(e.target.id==="ov") closeAll(); });
    document.body.classList.add("sheet-open");
  } else $(".sheet",ov).innerHTML=`<div class="sheet-in${refresh?"":" swap"}">${html}</div>`;
  ov.classList.toggle("centered",!!top.centered);
  const sh=$(".sheet",ov);
  $$("[data-close]",sh).forEach(b=>b.addEventListener("click",closeAll));
  $$("[data-back]",sh).forEach(b=>b.addEventListener("click",back));
  sh.scrollTop=refresh?sc:0;
  if(!refresh){ const f=$("input:not([type=file]):not([type=checkbox]),select,textarea",sh); if(f&&!top.search&&window.matchMedia("(pointer:fine)").matches) f.focus({preventScroll:true}); }
  mount&&mount(sh);
}
document.addEventListener("keydown",e=>{ if(e.key==="Escape"&&stack.length) back(); });
const head=(t,sub)=>`<div class="sheet-head"><div style="min-width:0">${stack.length>1?`<button class="btn sm" data-back type="button" style="margin-bottom:8px">← Back</button>`:""}<h2>${t}</h2>${sub?`<div class="muted small">${sub}</div>`:""}</div><button class="btn sm" data-close type="button" aria-label="Close">Close</button></div>`;
const dealerOptions=sel=>{ const list=activeDealers(); if(sel&&!list.find(([id])=>id===sel)&&S.dealers.get(sel)) list.unshift([sel,S.dealers.get(sel)]);
  return list.map(([id,d])=>`<option value="${id}" ${id===sel?"selected":""}>${esc(d.name)} — owes ${P(status(id).balance)}</option>`).join(""); };

/* ---------- dealer ---------- */
function dealerForm(id){
  show(()=>{ const d=id?S.dealers.get(id):{name:"",phone:"",area:"",creditLimit:S.settings.defaultLimit??"",terms:S.settings.defaultTerms??30,notes:""}; const hasTx=id&&dealerTxns(id,true).length;
  return [head(id?"Edit dealer":"New dealer")+`<form id="f" class="form-grid">
    <label class="f">First name<input id="d-first" autocomplete="given-name" maxlength="80" ${!id||d.firstName?"required":""} value="${esc(d.firstName||"")}"></label>
    <label class="f">Middle name<input id="d-middle" autocomplete="additional-name" maxlength="80" value="${esc(d.middleName||"")}"><span class="hint">Optional.</span></label>
    <label class="f">Last name<input id="d-last" autocomplete="family-name" maxlength="80" ${!id||d.lastName?"required":""} value="${esc(d.lastName||"")}"></label>
    ${id&&!d.firstName&&!d.lastName?`<label class="f span">Existing display name<input id="d-name" value="${esc(d.name)}" readonly><span class="hint">Enter first and last names together to update this older profile.</span></label>`:""}
    <label class="f">Age<input id="d-age" type="number" min="0" max="120" step="1" value="${esc(d.age??"")}" placeholder="Unknown"></label>
    <label class="f">Gender<select id="d-gender"><option value="">Not recorded</option>${["Female","Male","Non-binary","Prefer not to say","Other",...(d.gender&&!["Female","Male","Non-binary","Prefer not to say","Other"].includes(d.gender)?[d.gender]:[])].map(g=>`<option value="${esc(g)}" ${d.gender===g?"selected":""}>${esc(g)}</option>`).join("")}</select></label>
    <label class="f">Nationality<input id="d-nationality" maxlength="80" value="${esc(d.nationality||"")}" placeholder="e.g. Filipino"></label>
    <label class="f">Mobile number<input id="d-phone" inputmode="tel" value="${esc(d.phone)}" placeholder="0917 123 4567"></label>
    <label class="f">Area / barangay<input id="d-area" value="${esc(d.area)}" placeholder="e.g. Brgy. San Isidro, QC"></label>
    <label class="f">Credit limit (₱)<input id="d-limit" type="number" min="0" step="0.01" value="${esc(d.creditLimit??"")}" placeholder="Blank = no limit" ${S.canAdmin?"":"disabled"}><span class="hint">${S.canAdmin?"Recommended. Sales over the limit need owner approval.":"Only the owner or an editor can set credit limits."}</span></label>
    <label class="f">Payment terms (days)<input id="d-terms" type="number" min="0" step="1" value="${esc(d.terms??30)}" ${S.canAdmin?"":"disabled"}></label>
    <label class="f">Dealer discount (%)<input id="d-pct" type="number" min="0" max="100" step="0.01" value="${esc(d.discountPct??"")}" placeholder="Store default ${storePct()}%" ${S.canAdmin?"":"disabled"}><span class="hint">Leave blank to use the store default.</span></label>
    ${id?"":`<div class="span notice info" style="margin:0"><p class="small"><b>Already owes you money?</b> Enter what they owe now so balances and overdue days are right from day one.</p></div>
    <label class="f">Current balance owed (₱)<input id="d-ob" type="number" min="0" step="0.01" placeholder="0.00"></label>
    <label class="f">Date they took those goods<input id="d-obdate" type="date" value="${today()}"></label>`}
    <label class="f span">Notes<textarea id="d-notes" placeholder="Collection day, referral, ID on file…">${esc(d.notes)}</textarea></label>
    <p class="err span" id="d-err" style="color:var(--bad);margin:0"></p>
    <div class="actions span"><button class="btn primary" type="submit">${id?"Save changes":"Add dealer"}</button><button class="btn" type="button" data-back>Cancel</button>
    ${id?(hasTx?`<button class="btn" type="button" id="d-arch" style="margin-left:auto">${d.active===false?"Restore dealer":"Archive dealer"}</button>`:`<button class="btn danger" type="button" id="d-del" style="margin-left:auto">Delete dealer</button>`):""}</div></form>`,sh=>{
    $("#f",sh).addEventListener("submit",e=>{ e.preventDefault(); const btn=e.submitter||$("button[type=submit]",sh);
      const firstName=$("#d-first",sh).value.trim(),middleName=$("#d-middle",sh).value.trim(),lastName=$("#d-last",sh).value.trim();
      if((firstName||middleName||lastName)&&(!firstName||!lastName)){toast("Enter both first and last names");return;}
      const name=firstName&&lastName?[firstName,middleName,lastName].filter(Boolean).join(" "):$("#d-name",sh)?.value.trim();if(!name)return;
      const dup=[...S.dealers.entries()].find(([k,x])=>k!==id&&x.name.trim().toLowerCase()===name.toLowerCase());
      if(dup&&!btn.dataset.ok){ $("#d-err").textContent=`A dealer named “${dup[1].name}” already exists. Press the button again to save anyway.`; btn.dataset.ok="1"; return; }
      const lim=$("#d-limit").value.trim();
      const base=id?{...S.dealers.get(id)}:{createdAt:Date.now(),createdBy:S.me,active:true};
      const data={...base,...(firstName&&lastName?{firstName,middleName,lastName}:{}),age:$("#d-age",sh).value===""?null:Number($("#d-age",sh).value),gender:$("#d-gender",sh).value,nationality:$("#d-nationality",sh).value.trim(),name,phone:$("#d-phone").value.trim(),area:$("#d-area").value.trim(),creditLimit:lim===""?null:r2(lim),terms:Math.max(0,Math.round(Number($("#d-terms").value)||0)),discountPct:$("#d-pct").value===""?null:Math.min(100,Math.max(0,Number($("#d-pct").value))),notes:$("#d-notes").value.trim(),updated:stamp()};
      const prevLim=id?(S.dealers.get(id).creditLimit??null):undefined;
      if(prevLim!==data.creditLimit&&(data.creditLimit!=null||id)) data.limitHistory=[...(base.limitHistory||[]),{at:Date.now(),by:S.me,from:prevLim??null,to:data.creditLimit}].slice(-50);
      const ob=id?0:r2($("#d-ob").value), obDate=id?"":($("#d-obdate").value||today());
      guarded(btn,async()=>{ const ref=db.collection("dealers").doc(id||undefined); await ref.set(data);
        if(ob>0) await db.collection("txns").doc().set(openingDoc(ref.id,ob,obDate,addDays(obDate,data.terms),""));
        toast(id?"Dealer updated":ob>0?`Dealer added with ${P(ob)} opening balance`:"Dealer added"); back(); });
    });
    const del=$("#d-del",sh); if(del) del.addEventListener("click",()=>{ if(armed(del,"Tap again to delete")) guarded(del,async()=>{ await db.doc("dealers/"+id).delete(); toast("Dealer deleted"); closeAll(); }); });
    const ar=$("#d-arch",sh); if(ar) ar.addEventListener("click",()=>guarded(ar,async()=>{ const on=S.dealers.get(id).active===false; await db.doc("dealers/"+id).update({active:on,updated:stamp()}); toast(on?"Dealer restored":"Dealer archived. Their history is kept."); back(); }));
  }]; },false,true);
}
function statementText(id){
  const d=S.dealers.get(id), st=status(id), s=S.settings;
  const L=[]; if(s.storeName) L.push(s.storeName); if(s.phone||s.address) L.push([s.address,s.phone].filter(Boolean).join(" · ")); if(L.length) L.push("");
  L.push(`STATEMENT OF ACCOUNT`,`Dealer: ${d.name}`,`As of ${fmtDate(today())}`,"");
  if(st.open.length){ L.push("Unpaid deliveries:"); st.open.forEach(o=>L.push(`• ${o.no?o.no+" · ":""}${fmtDate(o.date)} — ${P(o.remaining)} (due ${fmtDate(o.dueDate)}${o.late?`, ${o.late} days late`:""})`)); L.push(""); }
  L.push(st.balance<0?`Credit in your favor: ${P(-st.balance)}`:`Total balance: ${P(st.balance)}`); if(st.overdue) L.push(`Overdue now: ${P(st.overdue)}`);
  if(st.lastPay) L.push(`Last payment received: ${fmtDate(st.lastPay)}`);
  if(s.paymentInfo){ L.push("","How to pay:",s.paymentInfo); }
  L.push("",s.footer??"Salamat po!"); return L.join("\n");
}
function creditHistoryPanel(id){
  const h=history(id), d=S.dealers.get(id); const lim=(d.limitHistory||[]).slice().reverse();
  resolveNames(lim.map(x=>x.by));
  const maxM=Math.max(1,...h.months.map(m=>Math.max(m.taken,m.paid)));
  const res=r=>r.paid?(r.late?`<span class="pill warn">Paid ${r.late} day${r.late===1?"":"s"} late</span>`:`<span class="pill good">Paid on time</span>`):(r.late?`<span class="pill bad">Unpaid · ${r.late} days late</span>`:`<span class="pill neutral">Unpaid · not yet due</span>`);
  return `<section class="panel" style="margin-bottom:16px">
    <div class="panel-head"><h2>Credit history</h2><div class="actions">${gradePill(h)}<span class="small muted">${esc(h.grade.label)}${h.grade.g!=="New"?` · score ${h.score}/100`:""}</span></div></div>
    <div class="stat-row">
      <div class="kpi"><div class="lbl">Paid on time</div><div class="val num">${h.n?Math.round(h.onTime/h.n*100)+"%":"—"}</div><div class="sub">${h.onTime} of ${h.n} paid deliveries</div></div>
      <div class="kpi"><div class="lbl">Average days to pay</div><div class="val num">${h.avgDays??"—"}</div><div class="sub">From release to fully paid</div></div>
      <div class="kpi ${h.worst>holdDays()?"bad":""}"><div class="lbl">Worst delay</div><div class="val num">${h.worst?h.worst+" days":"None"}</div><div class="sub">Past the due date</div></div>
    </div>
    <dl class="kv"><dt>Dealer since</dt><dd>${h.since?fmtDate(h.since):"—"}</dd><dt>Total credit taken</dt><dd class="num">${P(h.taken)}</dd><dt>Total paid</dt><dd class="num">${P(h.paid)}</dd>${h.returned?`<dt>Total returned</dt><dd class="num">${P(h.returned)}</dd>`:""}</dl>
    <h3 style="font-size:14px;margin:4px 0 8px">Last 6 months</h3>
    <div class="tbl-wrap"><table><thead><tr><th>Month</th><th>Credit taken</th><th>Paid</th></tr></thead><tbody>
      ${h.months.map(m=>`<tr><td class="small nowrap">${m.label}</td><td class="num small"><div class="meter" style="max-width:160px"><i style="width:${m.taken/maxM*100}%;background:var(--warn)"></i></div>${P(m.taken)}</td><td class="num small"><div class="meter" style="max-width:160px"><i style="width:${m.paid/maxM*100}%;background:var(--good)"></i></div>${P(m.paid)}</td></tr>`).join("")}
    </tbody></table></div>
    ${h.rows.length?`<h3 style="font-size:14px;margin:16px 0 8px">Payment record per delivery</h3><div class="tbl-wrap"><table><thead><tr><th>Delivery</th><th>Due</th><th>Fully paid</th><th>Result</th></tr></thead><tbody>
      ${h.rows.slice(0,24).map(r=>`<tr class="click" tabindex="0" data-tx="${esc([...S.txns.entries()].find(([,x])=>x===r.t)?.[0]||"")}"><td class="small"><b>${esc(r.t.no||"")}</b> ${fmtDate(r.t.date)}<div class="muted num">${P(r.t.amount)}${r.rem?` · ${P(r.rem)} left`:""}</div></td><td class="small nowrap">${fmtDate(r.t.dueDate)}</td><td class="small nowrap">${r.paid?fmtDate(r.paid)+`<div class="muted">${r.days} days</div>`:"—"}</td><td>${res(r)}</td></tr>`).join("")}
    </tbody></table></div>${h.rows.length>24?`<p class="small muted">Showing the latest 24 of ${h.rows.length} deliveries.</p>`:""}`:""}
    <h3 style="font-size:14px;margin:16px 0 8px">Credit limit changes</h3>
    ${lim.length?`<table><tbody>${lim.map(x=>`<tr><td class="small nowrap">${fmtStamp(x.at)}</td><td class="small num">${x.from==null?"No limit":P(x.from)} → <b>${x.to==null?"No limit":P(x.to)}</b></td><td class="small muted">${esc(nameOf(x.by))}</td></tr>`).join("")}</tbody></table>`:`<p class="small muted" style="margin:0">No changes recorded. Current limit: ${d.creditLimit?P(d.creditLimit):"none"}.</p>`}
  </section>`;
}
function dealerSheet(id){
  show(()=>{ const d=S.dealers.get(id); if(!d) return [head("Dealer not found")+`<p>This dealer was removed.</p>`];
  const st=status(id); let run=0;
  const all=dealerTxns(id,true).map(([tid,t])=>{ if(isLive(t)) run=r2(run+(["sale","refund"].includes(t.type)?t.amount:-t.amount)); return {tid,t,run}; }).reverse();
  resolveNames([d.createdBy]);
  return [head(esc(d.name)+samplePill(d)+(d.active===false?` <span class="pill neutral">Archived</span>`:""),[d.phone,d.area,d.terms!=null?`${d.terms}-day terms`:""].filter(Boolean).map(esc).join(" · "))+`
    <div class="stat-row">
      <div class="kpi"><div class="lbl">Balance</div><div class="val num">${P(st.balance)}</div></div>
      <div class="kpi ${st.overdue?"bad":""}"><div class="lbl">Overdue</div><div class="val num">${P(st.overdue)}</div></div>
      <div class="kpi"><div class="lbl">Credit limit</div><div class="val num">${d.creditLimit?P(d.creditLimit):"None"}</div>${d.creditLimit?`<div class="sub">${P(Math.max(0,d.creditLimit-st.balance))} available</div>`:""}</div>
    </div>
    ${st.maxLate>holdDays()?`<div class="notice bad"><p><b>On credit hold.</b> The oldest unpaid delivery is ${st.maxLate} days late. New credit sales are blocked until they pay${S.canAdmin?", unless you approve one":""}.</p></div>`:""}
    ${!d.creditLimit&&S.canWrite?`<div class="notice warn"><p>No credit limit set for this dealer. Set one so the app can warn you before risky releases.</p></div>`:""}
    ${S.canWrite?`<div class="actions" style="margin-bottom:16px"><button class="btn primary" data-act="sale-for" data-id="${id}" type="button">+ Credit sale</button><button class="btn" data-act="pay-for" data-id="${id}" type="button">+ Payment</button><button class="btn" data-act="ret-for" data-id="${id}" type="button">+ Return</button><button class="btn" data-act="remind-copy" data-id="${id}" type="button">Copy reminder</button><button class="btn" data-act="record-contact" data-id="${id}" type="button">Record contact / promise</button>${S.canAdmin&&st.balance<0?`<button class="btn" data-act="refund-dealer" data-id="${esc(id)}" type="button">Refund available credit</button>`:""}<button class="btn" data-act="opening-for" data-id="${id}" type="button">+ Opening balance</button>${window.APP&&S.acct&&S.acct.role==="owner"?`<button class="btn" data-act="portal-for" data-id="${id}" type="button">Portal access</button>`:""}<button class="btn" data-act="edit-dealer" data-id="${id}" type="button">Edit dealer</button></div>`:""}
    <section class="panel" style="margin-bottom:16px"><h2>Dealer profile</h2><dl class="kv"><dt>First name</dt><dd>${esc(d.firstName||"Not recorded")}</dd><dt>Middle name</dt><dd>${esc(d.middleName||"—")}</dd><dt>Last name</dt><dd>${esc(d.lastName||"Not recorded")}</dd><dt>Age</dt><dd>${d.age==null?"Not recorded":d.age}</dd><dt>Gender</dt><dd>${esc(d.gender||"Not recorded")}</dd><dt>Nationality</dt><dd>${esc(d.nationality||"Not recorded")}</dd></dl></section>
    ${d.notes?`<p class="small"><b>Notes:</b> ${esc(d.notes)}</p>`:""}
    <section class="panel" style="margin-bottom:16px"><div class="panel-head"><h2>Statement to send</h2><button class="btn sm" data-act="period-statement" data-id="${esc(id)}" type="button">Statement by period / Print</button><button class="btn sm" type="button" id="copyStmt">Copy text</button></div>
      <pre class="stmt" id="stmt">${esc(statementText(id))}</pre><p class="small muted" style="margin:6px 0 0">Paste into Messenger, Viber or SMS to remind the dealer.</p></section>
    ${(()=>{ const O=openDeliveries(id); if(!O.open.length) return ""; return `<section class="panel" style="margin-bottom:16px"><div class="panel-head"><h2>Unpaid deliveries</h2>${S.canWrite?`<button class="btn sm primary" data-act="pay-amt" data-id="${id}" data-amt="${st.balance}" type="button">Collect full ${P(st.balance)}</button>`:""}</div>
      <div class="tbl-wrap"><table><thead><tr><th>Delivery</th><th>Due</th><th class="r">Amount</th><th class="r">Paid</th><th class="r">Left</th>${S.canWrite?"<th></th>":""}</tr></thead><tbody>
      ${O.open.map(o=>`<tr><td><b>${esc(o.t.no||"")}</b><div class="small muted">${fmtDate(o.t.date)}</div></td><td class="small nowrap">${fmtDate(o.t.dueDate)}${o.late?`<div><span class="pill ${o.late>holdDays()?"bad":"warn"}">${o.late} days late</span></div>`:""}</td><td class="r num">${P(o.t.amount)}</td><td class="r num">${o.paid?P(o.paid):"—"}${o.paid?`<div class="meter" style="margin-left:auto;max-width:80px"><i style="width:${o.paid/o.t.amount*100}%;background:var(--good)"></i></div>`:""}</td><td class="r num"><b>${P(o.rem)}</b></td>${S.canWrite?`<td class="r"><button class="btn sm" data-act="pay-amt" data-id="${id}" data-amt="${o.rem}" type="button">Pay</button></td>`:""}</tr>`).join("")}
      </tbody></table></div><p class="small muted" style="margin:8px 0 0">Partial payments are applied to the oldest delivery first.</p></section>`; })()}
    ${creditHistoryPanel(id)}
    <section class="panel"><h2>Ledger</h2>
      ${all.length?`<div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Details</th><th class="r">Amount</th><th class="r">Balance</th></tr></thead><tbody>
      ${all.map(({tid,t,run})=>`<tr class="click ${t.voided?"void":""}" tabindex="0" data-tx="${tid}"><td class="small nowrap">${fmtDate(t.date)}</td><td>${txDetails(t)}</td><td class="r num nowrap amt">${sign(t)}${P(t.amount)}</td><td class="r num">${t.voided?"—":P(run)}</td></tr>`).join("")}
      </tbody></table></div>`:`<div class="empty"><p>No sales or payments yet for this dealer.</p></div>`}
      ${d.createdAt>1e9?`<p class="small muted" style="margin:10px 0 0">Added ${fmtStamp(d.createdAt)} by ${esc(nameOf(d.createdBy))}</p>`:""}
    </section>`,sh=>{
    $("#copyStmt",sh).addEventListener("click",()=>{ const el=$("#stmt",sh), txt=el.textContent;
      const sel=()=>{ const r=document.createRange(); r.selectNodeContents(el); const s=getSelection(); s.removeAllRanges(); s.addRange(r); toast("Text selected. Copy it from your device menu."); };
      try{ navigator.clipboard.writeText(txt).then(()=>toast("Statement copied"),sel); }catch(e){ sel(); } });
  }]; },true);
}

/* ---------- product ---------- */
async function productForm(id){
  await resolveNames([...S.moves.values()].filter(m=>m.productId===id).map(m=>m.createdBy));
  show(()=>{ const p=id?S.products.get(id):{name:"",code:"",category:"",dealerPrice:"",srp:"",stock:0,reorderLevel:5};
  const cats=[...new Set([...S.products.values()].map(x=>x.category).filter(Boolean))].sort();
  const used=id&&([...S.txns.values()].some(t=>(t.items||[]).some(i=>i.productId===id))||[...S.moves.values()].some(m=>m.productId===id)||[...S.orders.values()].some(o=>(o.items||[]).some(i=>i.productId===id)));
  const mv=id?[...S.moves.values()].filter(m=>m.productId===id).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).slice(0,8):[];
  return [head(id?"Edit product":"New product")+`<form id="f" class="form-grid">
    <div class="f span"><span>Photo</span><div class="photo-box">
      <div id="p-prev">${p.imageId?`<img class="big" src="${imgUrl(p.imageId)}" alt="Product photo">`:`<div class="big">No photo yet</div>`}</div>
      ${assets?`<div class="actions" style="flex-direction:column;align-items:flex-start;flex:1;min-width:200px"><input id="p-file" type="file" accept="image/*" aria-label="Choose product photo">${p.imageId?`<button class="btn sm" type="button" id="p-rmimg">Remove photo</button>`:""}<span class="hint">Choose a file, drag one here, or copy a picture from a website and paste it (Ctrl+V). Large photos are resized automatically.</span></div>`:`<span class="hint">Only the ledger owner or editors can add photos.</span>`}
    </div></div>
    <label class="f span">Picture link from the internet<input id="p-link" type="url" inputmode="url" value="${esc(p.imageLink||"")}" placeholder="https://…"><span class="hint">Saved as a “View picture” link that opens in a new tab.</span></label>
    <label class="f span">Product name<input id="p-name" required maxlength="160" value="${esc(p.name)}" placeholder="Name and size, e.g. Dishwashing Liquid 1L"></label>
    <label class="f">Category<input id="p-cat" list="catList" value="${esc(p.category||"")}" placeholder="e.g. Home care"><datalist id="catList">${cats.map(c=>`<option value="${esc(c)}">`).join("")}</datalist></label>
    <label class="f">Code / SKU<input id="p-code" value="${esc(p.code)}"></label>
    <label class="f">SRP / catalog price (₱)<input id="p-srp" type="number" min="0" step="0.01" value="${esc(p.srp??"")}"><span class="hint">Credit sales use this price, less the dealer discount.</span></label>
    <label class="f">Dealer price (₱)<input id="p-dp" type="number" min="0" step="0.01" required value="${esc(p.dealerPrice)}"><span class="hint" id="p-dph">Your cost to the dealer after discount.</span></label>
    ${id?`<div class="f"><span>Stock on hand</span><b class="num" style="font-size:18px;color:var(--fg)">${p.stock}</b><span class="hint">Change it with Stock in / adjust.</span></div>`:`<label class="f">Starting stock<input id="p-stock" type="number" step="1" min="0" value="${esc(p.stock)}"></label>`}
    <label class="f">Purchase cost per unit (₱)<input id="p-cost" type="number" min="0" max="1000000000" step="0.01" value="${esc(p.purchaseCost??"")}" ${S.canAdmin?"":"disabled"}><span class="hint">Latest supplier cost; used as the opening cost when stock has no value yet. Receipts update weighted average inventory cost.</span></label>
    ${id?`<div class="f"><span>Weighted average cost / inventory value</span><b>${p.averageCost==null?"Cost unknown":P(p.averageCost)} / ${p.inventoryValue==null?"Value unknown":P(p.inventoryValue)}</b><span class="hint">Sales save this average cost. Later receipts do not change earlier sales.</span></div>`:""}
    ${id&&p.inventoryValue==null&&p.stock>0&&S.canAdmin?`<label class="chk span"><input id="p-establish" type="checkbox"> Establish the cost of current stock using the purchase cost above</label>`:""}
    <label class="f">Usual supplier<input id="p-supplier" maxlength="160" value="${esc(p.supplier||"")}" ${S.canAdmin?"":"disabled"}></label>
    <label class="f">Reorder when at or below<input id="p-re" type="number" min="0" step="1" value="${esc(p.reorderLevel??"")}"></label>
    <label class="f">Dealer discount for this product (%)<input id="p-pct" type="number" min="0" max="100" step="0.01" value="${esc(p.discountPct??"")}" placeholder="Same as dealer's (${storePct()}%)" ${S.canAdmin?"":"disabled"}><span class="hint">Leave blank unless this item gets a different discount, e.g. 0 for net-priced items.</span></label>
    <div class="span promo-box"><h3 style="font-size:14px;margin:0 0 8px">Promo ${promoOn(p)?`<span class="pill warn">ON NOW</span>`:p.promo&&p.promo.price?`<span class="pill neutral">${p.promo.to&&p.promo.to<today()?"ended":"scheduled"}</span>`:""}</h3><div class="form-grid">
      <label class="f">Promo price (₱)<input id="p-promo" type="number" min="0" step="0.01" value="${esc(p.promo&&p.promo.price||"")}" placeholder="No promo" ${S.canAdmin?"":"disabled"}></label>
      <label class="f">From<input id="p-pfrom" type="date" value="${esc(p.promo&&p.promo.from||"")}" ${S.canAdmin?"":"disabled"}></label>
      <label class="f">Until<input id="p-pto" type="date" value="${esc(p.promo&&p.promo.to||"")}" ${S.canAdmin?"":"disabled"}></label>
      <label class="chk span"><input type="checkbox" id="p-pnod" ${p.promo&&p.promo.noDiscount?"checked":""} ${S.canAdmin?"":"disabled"}> Promo price is final (no dealer discount on top)</label></div></div>
    <div class="actions span"><button class="btn primary" type="submit">${id?"Save changes":"Add product"}</button><button class="btn" type="button" data-back>Cancel</button>
    ${id?`<button class="btn" type="button" data-act="stock-for" data-id="${id}">Stock in / adjust</button>`:""}
    ${id?(used?`<button class="btn" type="button" id="p-arch" style="margin-left:auto">${p.active===false?"Restore product":"Archive product"}</button>`:`<button class="btn danger" type="button" id="p-del" style="margin-left:auto">Delete product</button>`):""}</div></form>
    ${(p.priceHistory||[]).length?`<section class="panel" style="margin-top:16px"><h2>Price history</h2><table><tbody>${p.priceHistory.slice().reverse().map(h=>`<tr><td class="small nowrap">${fmtStamp(h.at)}</td><td class="small">${esc(h.catalog||"")}</td><td class="r num small">${h.from!=null?P(h.from):"—"} → <b>${P(h.to)}</b></td></tr>`).join("")}</tbody></table></section>`:""}
    ${mv.length?`<section class="panel" style="margin-top:16px"><h2>Recent stock changes</h2><div class="tbl-wrap"><table><thead><tr><th>Stock date</th><th>Recorded at</th><th>Added by</th><th>Reason</th><th class="r">Quantity</th></tr></thead><tbody>${mv.map(m=>`<tr><td class="small nowrap">${fmtDate(m.date)}</td><td class="small nowrap">${fmtStamp(m.createdAt)||"—"}</td><td class="small">${esc(nameOf(m.createdBy))}</td><td class="small">${esc(m.reason)}${m.note?" · "+esc(m.note):""}</td><td class="r num">${m.qty>0?"+":""}${m.qty}</td></tr>`).join("")}</tbody></table></div></section>`:""}`,sh=>{
    const srpIn=$("#p-srp",sh), dpIn=$("#p-dp",sh); let dpTouched=!!dpIn.value;
    dpIn.addEventListener("input",()=>{ dpTouched=true; });
    srpIn.addEventListener("input",()=>{ const v=r2(srpIn.value*(1-storePct()/100)); $("#p-dph",sh).textContent=srpIn.value?`SRP less ${storePct()}% = ${P(v)}`:"Your cost to the dealer after discount."; if(!dpTouched&&srpIn.value) dpIn.value=v.toFixed(2); });
    let newFile=null, removeImg=false; const fileIn=$("#p-file",sh);
    const setFile=f=>{ if(!f) return; if(!f.type.startsWith("image/")){ toast("Choose an image file"); if(fileIn) fileIn.value=""; return; } newFile=f; removeImg=false; $("#p-prev",sh).innerHTML=`<img class="big" src="${URL.createObjectURL(f)}" alt="New product photo">`; };
    if(fileIn){ fileIn.addEventListener("change",()=>setFile(fileIn.files[0]));
      sh.addEventListener("paste",e=>{ const it=[...(e.clipboardData?.items||[])].find(i=>i.type.startsWith("image/")); if(it){ e.preventDefault(); setFile(it.getAsFile()); toast("Photo pasted"); } });
      const box=$(".photo-box",sh); box.addEventListener("dragover",e=>e.preventDefault());
      box.addEventListener("drop",e=>{ e.preventDefault(); const f=[...(e.dataTransfer?.files||[])].find(x=>x.type.startsWith("image/")); if(f) setFile(f); else toast("Drop an image file. From a website, copy the image and paste it instead."); }); }
    const rm=$("#p-rmimg",sh); if(rm) rm.addEventListener("click",()=>{ removeImg=true; newFile=null; if(fileIn) fileIn.value=""; $("#p-prev",sh).innerHTML=`<div class="big">Photo will be removed when you save</div>`; });
    $("#f",sh).addEventListener("submit",e=>{ e.preventDefault(); const btn=e.submitter||$("button[type=submit]",sh);
      const name=$("#p-name").value.trim(); if(!name) return; const re=$("#p-re").value.trim(); const link=$("#p-link").value.trim();
      const base=id?{...S.products.get(id)}:{createdAt:Date.now(),createdBy:S.me,active:true,stock:Math.max(0,Math.round(Number($("#p-stock").value)||0))};
      const oldImg=base.imageId||null;
      const data={...base,name,category:$("#p-cat").value.trim(),code:$("#p-code").value.trim(),dealerPrice:r2($("#p-dp").value),srp:$("#p-srp").value?r2($("#p-srp").value):null,reorderLevel:re===""?null:Math.max(0,Number(re)),imageLink:/^https?:\/\//i.test(link)?link:null,updated:stamp()};
      data.purchaseCost=$("#p-cost").value===""?null:r2($("#p-cost").value);data.supplier=$("#p-supplier").value.trim();data.establishCost=!!$("#p-establish")?.checked;
      data.discountPct=$("#p-pct").value===""?null:Math.min(100,Math.max(0,Number($("#p-pct").value)));
      { const pp=r2($("#p-promo").value); data.promo=pp>0?{...(base.promo||{}),price:pp,from:$("#p-pfrom").value||null,to:$("#p-pto").value||null,noDiscount:$("#p-pnod").checked}:null; }
      if(id&&Number(base.srp||0)!==Number(data.srp||0)) data.priceHistory=[...(base.priceHistory||[]),{at:Date.now(),by:S.me,catalog:"Edited",from:base.srp??null,to:data.srp}].slice(-36);
      guarded(btn,async()=>{
        if(newFile){ btn.textContent="Uploading photo…"; try{ const up=await assets.upload(await shrinkImage(newFile)); data.imageId=up.id; }catch(err){ const m={too_large:"That photo is too large. Try a smaller one.",unsupported_type:"That file type isn't supported. Use JPG or PNG."}[err&&err.code]||"Couldn't upload the photo. Try again."; throw Object.assign(new Error(m),{userMsg:m}); } }
        else if(removeImg) data.imageId=null;
        const ref=db.collection("products").doc(id||undefined); await ref.set(data);
        if(oldImg&&assets&&(removeImg||newFile)) assets.delete(oldImg).catch(()=>{});
        toast(id?"Product updated":"Product added"); back(); });
    });
    const del=$("#p-del",sh); if(del) del.addEventListener("click",()=>{ if(armed(del,"Tap again to delete")) guarded(del,async()=>{ const im=S.products.get(id).imageId; await db.doc("products/"+id).delete(); for(const [mid,m] of [...S.moves]) if(m.productId===id) await db.doc("moves/"+mid).delete(); if(im&&assets) assets.delete(im).catch(()=>{}); toast("Product deleted"); closeAll(); }); });
    const ar=$("#p-arch",sh); if(ar) ar.addEventListener("click",()=>guarded(ar,async()=>{ const on=S.products.get(id).active===false; await db.doc("products/"+id).update({active:on,updated:stamp()}); toast(on?"Product restored":"Product archived. It won't appear when recording sales."); back(); }));
  }]; },false,!!id);
}
function stockForm(pid){
  if(!S.products.size){ toast("Add a product first"); productForm(); return; }
  const moveRef=db.collection("moves").doc();
  show(()=>[head("Stock in / adjust","Record deliveries from your supplier or correct a count")+`<form id="f" class="form-grid">
    <label class="f span">Product<select id="m-p" required>${activeProducts().map(([id,p])=>`<option value="${id}" ${id===pid?"selected":""}>${esc(p.name)} (${p.stock} on hand)</option>`).join("")}</select></label>
    <div class="f span"><span>What happened</span><div class="seg" role="group" aria-label="Kind"><button type="button" data-k="in" aria-pressed="true">Received stock</button><button type="button" data-k="count" aria-pressed="false">Set counted stock</button><button type="button" data-k="out" aria-pressed="false">Damaged / lost</button></div></div>
    <label class="f span" id="m-out-batch" hidden>Stock batch<select id="m-batch"><option value="">Use earliest-expiring stock</option></select></label>
    <label class="f span" id="m-loss" hidden>Loss reason<select id="m-loss-reason"><option>Damaged stock</option><option>Expired stock</option><option>Missing stock</option><option>Other stock loss</option></select></label>
    <label class="f" id="m-ql">Quantity received<input id="m-q" type="number" min="0" step="1" required value=""></label>
    <label class="f">Date<input id="m-date" type="date" required value="${today()}"></label>
    <div class="span form-grid" id="m-purchase"><label class="f">Batch code<input id="m-batch-code" maxlength="160" placeholder="Auto-generated if blank"></label><label class="f">Expiry date<input id="m-expiry" type="date"></label><label class="f">Supplier<input id="m-supplier" maxlength="160" value="${esc(S.products.get(pid)?.supplier||"")}"></label><label class="f">Delivery reference<input id="m-ref" maxlength="160" placeholder="Supplier receipt / invoice number"></label><label class="f">Purchase cost per unit (₱)<input id="m-cost" type="number" min="0" max="1000000000" step="0.01" value="${esc(S.products.get(pid)?.purchaseCost??"")}"><span class="hint">Updates the cost for future sales. Leave blank if unknown.</span></label></div>
    <label class="f span">Note<input id="m-note" placeholder="e.g. Delivery receipt no., supplier"></label>
    ${S.acct?.role!=="owner"&&Number(S.settings.approvalStockLimit??10000)>0?`<p class="hint span">Adjustments worth ${P(S.settings.approvalStockLimit??10000)} or more, or with unknown costs, need owner approval.</p>`:""}
    <p class="small span" id="m-info" style="margin:0"></p>
    <div class="actions span"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-back>Cancel</button></div></form>`,sh=>{
    let kind="in"; const lbl={in:"Quantity received",count:"Actual count on hand",out:"Quantity damaged or lost"};
    const info=()=>{ const p=S.products.get($("#m-p").value), q=Math.round(Number($("#m-q").value)||0); if(!p) return; const nw=kind==="in"?p.stock+q:kind==="out"?p.stock-q:q; $("#m-info").innerHTML=`On hand now <b>${p.stock}</b> → after saving <b>${nw}</b>`; };
    $$("[data-k]",sh).forEach(b=>b.addEventListener("click",()=>{ kind=b.dataset.k; $("#m-purchase",sh).hidden=kind!=="in";$("#m-loss",sh).hidden=kind!=="out";$("#m-out-batch",sh).hidden=kind!=="out"; $$("[data-k]",sh).forEach(x=>x.setAttribute("aria-pressed",x===b)); $("#m-ql").firstChild.textContent=lbl[kind]; info(); }));
    const fillSupplier=()=>{const p=S.products.get($("#m-p").value);$("#m-supplier").value=p?.supplier||"";$("#m-cost").value=p?.purchaseCost??"";$("#m-batch",sh).innerHTML=`<option value="">Use earliest-expiring stock</option>`+[...S.batches].filter(([,b])=>b.productId===$("#m-p",sh).value&&b.remainingQty>0).map(([id,b])=>`<option value="${esc(id)}">${esc(b.code)} · ${b.remainingQty} units${b.expiryDate?" · expires "+fmtDate(b.expiryDate):""}</option>`).join("");info();};
    $("#m-p").addEventListener("change",fillSupplier);fillSupplier(); $("#m-q").addEventListener("input",info); info();
    $("#f",sh).addEventListener("submit",e=>{ e.preventDefault(); const btn=e.submitter||$("button[type=submit]",sh);
      const id=$("#m-p").value, p=S.products.get(id), q=Math.round(Number($("#m-q").value)||0); if(!p) return;
      const delta=kind==="in"?q:kind==="out"?-q:q-p.stock; if(!delta){ toast("No change to save"); return; }
      guarded(btn,async()=>{ const saved=await controlledSave(moveRef,{productId:id,qty:delta,batchCode:kind==="in"?$("#m-batch-code",sh).value.trim():"",expiryDate:kind==="in"?$("#m-expiry",sh).value||null:null,requestedBatchId:kind==="out"?$("#m-batch",sh).value||null:null,supplier:kind==="in"?$("#m-supplier").value.trim():"",deliveryRef:kind==="in"?$("#m-ref").value.trim():"",unitCost:kind==="in"&&$("#m-cost").value!==""?r2($("#m-cost").value):null,expectedStock:kind==="count"?p.stock:undefined,reason:kind==="in"?"Received stock":kind==="out"?$("#m-loss-reason").value:"Stock count",date:$("#m-date").value,note:$("#m-note").value.trim()});
         if(saved?.pendingApproval){back();return;}toast("Stock updated"); back(); });
    });
  }],false,true);
}

/* ---------- credit sale & return (item forms) ---------- */
const storePct=()=>{ const v=Number(S.settings.discountPct??25); return Number.isFinite(v)?v:25; };
const dealerPct=d=>d&&d.discountPct!=null&&d.discountPct!==""?Number(d.discountPct):storePct();
const promoOn=(p,date)=>!!(p&&p.promo&&Number(p.promo.price)>0&&(!p.promo.from||(date||today())>=p.promo.from)&&(!p.promo.to||(date||today())<=p.promo.to));
const listPrice=(p,pct,date)=>promoOn(p,date)?Number(p.promo.price):(pct>0?(Number(p.srp)||Number(p.dealerPrice)||0):(Number(p.dealerPrice)||Number(p.srp)||0));
const linePct=(p,dpct,date)=>promoOn(p,date)&&p.promo.noDiscount?0:(p&&p.discountPct!=null&&p.discountPct!==""?Number(p.discountPct):dpct);
const priceTag=(p,pct,date)=>promoOn(p,date)?`<s class="muted small">${P(p.srp)}</s> <b>${P(p.promo.price)}</b> <span class="pill warn">PROMO</span>`:P(listPrice(p,pct,date));
function itemsForm(kind,dealerId,editId,opts){
  if(!activeDealers().length&&!editId){ toast("Add a dealer first"); dealerForm(); return; }
  if(!activeProducts().length&&!editId){ toast("Add a product first"); productForm(); return; }
  const old=editId?S.txns.get(editId):null; const isSale=kind==="sale";
  const recordRef=db.collection("txns").doc(editId||undefined);
  show(()=>{
  const startDealer=old?old.dealerId:dealerId;
  const startPct=old?(old.discountPct??0):opts&&opts.pct!=null?opts.pct:dealerPct(S.dealers.get(startDealer));
  return [head(editId?`Edit ${TYPE_LABEL[kind].toLowerCase()} ${esc(old.no||"")}`:(isSale?"Credit sale":"Dealer return"),isSale?"Products released to a dealer, to be paid later":"Products the dealer gives back. Their balance goes down.")+`<form id="f">
    <div class="form-grid">
      <label class="f span">Dealer<select id="s-dealer" required><option value="">Choose dealer…</option>${dealerOptions(startDealer)}</select></label>
      ${!isSale?`<label class="f span">Original sale<select id="s-original" ${!old?"required":""}><option value="">Choose the original sale…</option></select><span class="hint">Returned quantities are checked against this sale; restocked items use its saved cost.</span></label>`:""}
      <label class="f">${isSale?"Date released":"Date returned"}<input id="s-date" type="date" required value="${old?old.date:today()}"></label>
      ${isSale?`<label class="f">Due date<input id="s-due" type="date" required value="${old?old.dueDate:""}"></label>`:`<label class="chk" style="align-self:end"><input type="checkbox" id="s-restock" ${!old||old.restock?"checked":""}> Put items back in stock</label>`}
    </div>
    <div class="panel-head" style="margin:18px 0 8px"><h3 style="font-size:15px">Items</h3><span class="small muted" id="cart-count">Tap a product to add it. Tap again to add one more.</span></div>
    <div class="picker">
      <input id="pick-q" type="search" autocomplete="off" placeholder="Search a product to add (name, code or category)" aria-label="Search products to add">
      <div class="pick-list" id="pick-list" role="list"></div>
    </div>
    <div class="cart-wrap"><table class="cart-tbl"><thead id="cart-head"></thead><tbody id="cart" aria-live="polite"></tbody><tfoot id="cart-foot"></tfoot></table></div>
    <div class="form-grid" style="margin-top:14px">
      <label class="f">Dealer discount (%)<input id="s-pct" type="number" min="0" max="100" step="0.01" value="${startPct}"><span class="hint">Taken off the whole total. Store default is ${storePct()}%.</span></label>
      ${isSale?`<label class="f">Extra discount (₱)<input id="s-disc" type="number" min="0" step="0.01" value="${old&&old.discount?old.discount:""}" placeholder="0.00"><span class="hint">Optional, e.g. a promo.</span></label>`:""}
      <label class="f span">Note<input id="s-note" value="${esc(old?old.note:opts&&opts.note?opts.note:"")}" placeholder="${isSale?"Optional, e.g. delivered by Ben":"Reason, e.g. expired, wrong item"}"></label>
      ${isSale&&!old?`<label class="chk span"><input type="checkbox" id="s-paid"> Dealer paid in full now <select id="s-method" hidden aria-label="Payment method" style="width:auto">${METHODS.map(m=>`<option>${m}</option>`).join("")}</select></label>`:""}
    </div>
    <div id="s-warn" style="margin-top:10px"></div>
    ${isSale&&!old?`<label class="chk" id="s-ovr-wrap" hidden style="margin-top:4px"><input type="checkbox" id="s-ovr"> Release anyway (owner approval)</label>`:""}
    ${old?correctionField():""}
    ${isSale&&!old?`<label class="f" style="margin-top:10px">Credit approval reason<input id="s-approval-reason" placeholder="Why this release should be approved"></label><label class="f">Owner override reason<input id="s-override-reason" placeholder="Required when releasing over a credit hold"></label><button class="btn" id="s-request" type="submit" hidden>Request owner approval</button>`:""}
    <div class="actions" style="margin-top:12px"><button class="btn primary" type="submit">${editId?"Save changes":isSale?"Record sale":"Record return"}</button><button class="btn" type="button" data-back>Cancel</button></div></form>`,sh=>{
    const cart=old?(old.items||[]).map(i=>({...i,pct:i.pct!=null?i.pct:(old.discountPct??0),mp:true,pf:true})):opts&&opts.items?opts.items.map(i=>({...i,pct:i.pct!=null?i.pct:(opts.pct??0),mp:true,pf:true})):[];
    const sDate=()=>$("#s-date").value||today();
    const refreshLines=()=>cart.forEach(i=>{ const p=S.products.get(i.productId); if(!p) return; if(!i.mp){ i.price=listPrice(p,pct(),sDate()); i.promo=promoOn(p,sDate()); } if(!i.pf) i.pct=linePct(p,pct(),sDate()); });
    let pctTouched=!!old||!!(opts&&opts.pct!=null);
    const prods=()=>{ const l=activeProducts(); cart.forEach(i=>{ if(!l.find(([id])=>id===i.productId)&&S.products.get(i.productId)) l.push([i.productId,S.products.get(i.productId)]); }); return l; };
    const pct=()=>Math.min(100,Math.max(0,Number($("#s-pct").value)||0));
    const uniPct=()=>{ const ps=new Set(cart.map(i=>i.pct)); return ps.size<=1?(cart.length?cart[0].pct:pct()):null; };
    const totals=()=>{ const sub=r2(cart.reduce((a,i)=>a+i.qty*i.price,0)); const pd=r2(cart.reduce((a,i)=>a+i.qty*i.price*(i.pct||0)/100,0)); const extra=isSale?Math.min(r2(sub-pd),Math.max(0,r2($("#s-disc").value))):0; return {sub,pd,extra,total:r2(sub-pd-extra)}; };
    const addProduct=(pid,qty=1)=>{ const p=S.products.get(pid); if(!p) return; const ex=cart.find(i=>i.productId===pid);
      if(ex) ex.qty+=qty; else { cart.push({productId:pid,name:p.name,qty,price:0,pct:0}); refreshLines(); } drawCart(); drawPick(); };
    const drawPick=()=>{ const q=$("#pick-q").value.trim().toLowerCase();
      const list=prods().filter(([,p])=>!q||[p.name,p.code,p.category].join(" ").toLowerCase().includes(q)).slice(0,60);
      $("#pick-list").innerHTML=list.length?`<table><thead><tr><th></th><th>Product</th><th>Code</th><th class="r">Available</th><th class="r">SRP</th><th></th></tr></thead><tbody>${list.map(([id,p])=>{ const inCart=cart.find(i=>i.productId===id);
        return `<tr class="pick" data-pid="${id}" tabindex="0"><td style="width:40px">${thumb(p,1)}</td><td><b>${esc(p.name)}</b>${p.category?`<div class="small muted">${esc(p.category)}</div>`:""}</td><td class="small muted">${esc(p.code||"—")}</td><td class="r num">${(p.availableStock??p.stock)<=0?`<span class="pill bad">0</span>`:(p.availableStock??p.stock)}${p.reserved?`<div class="small muted">${p.reserved} reserved</div>`:""}</td><td class="r num nowrap">${priceTag(p,pct(),sDate())}</td><td class="r"><span class="pick-add">${inCart?`×${inCart.qty} ＋`:"＋ Add"}</span></td></tr>`; }).join("")}</tbody></table>`:`<p class="small muted" style="margin:8px 12px">No product matches “${esc(q)}”.</p>`; };
    const narrowMQ=window.matchMedia("(max-width:600px)");
    const drawCart=()=>{
      const nar=narrowMQ.matches, cols=nar?3:6, lab=nar?2:4;
      $("#cart-head").innerHTML=nar?`<tr><th>Product</th><th class="r">Qty</th><th class="r">Amount</th></tr>`:`<tr><th>#</th><th>Product</th><th class="r">Qty</th><th class="r">SRP each</th><th class="r">Amount</th><th><span style="position:absolute;left:-9999px">Remove</span></th></tr>`;
      $("#cart").innerHTML=cart.length?cart.map((i,k)=>{ const p=S.products.get(i.productId);
        return `<tr class="cart-row" data-k="${k}">${nar?"":`<td class="c-no num">${k+1}</td>`}
          <td><div class="prod-cell">${nar?"":thumb(p,1)}<div><b>${esc(i.name)}</b>${i.promo?` <span class="pill warn">PROMO</span>`:""}${i.pct!==pct()?`<div class="small muted">dealer discount ${i.pct}%</div>`:""}${nar?`<div class="small muted num c-each">${P(i.price)} each</div>`:""}${p&&!p.srp&&pct()>0?`<div class="small" style="color:var(--warn)">No SRP saved. Using dealer price.</div>`:""}</div></div></td>
          <td class="r"><div class="stepper"><button type="button" class="btn sm" data-dec aria-label="${i.qty>1?"One less":"Remove"} ${esc(i.name)}" title="${i.qty>1?"One less":"Remove item"}">${i.qty>1?"−":"✕"}</button><input class="num c-qty" id="cq-${k}" type="number" min="1" step="1" inputmode="numeric" value="${i.qty}" aria-label="Quantity of ${esc(i.name)}"><button type="button" class="btn sm" data-inc aria-label="One more ${esc(i.name)}">+</button></div></td>
          ${nar?"":`<td class="r"><input class="num c-price" id="cp-${k}" type="number" min="0" step="0.01" value="${i.price}" aria-label="Price each for ${esc(i.name)}"></td>`}
          <td class="r num cart-amt nowrap"><b>${P(i.qty*i.price)}</b></td>
          ${nar?"":`<td class="r"><button type="button" class="btn sm" data-rm aria-label="Remove ${esc(i.name)}" title="Remove">✕</button></td>`}</tr>`; }).join(""):`<tr><td colspan="${cols}"><div class="empty" style="padding:14px"><p style="margin:0">No items yet. Tap products above to add them.</p></div></td></tr>`;
      const tail=nar?"":"<td></td>";
      $("#cart-foot").innerHTML=`<tr><td colspan="${lab}" class="r muted" id="s-subl">Total at SRP</td><td class="r num nowrap" id="s-sub"></td>${tail}</tr>
        <tr><td colspan="${lab}" class="r muted" id="s-pdl">Less dealer discount</td><td class="r num nowrap" id="s-pd"></td>${tail}</tr>
        ${isSale?`<tr><td colspan="${lab}" class="r muted">Extra discount</td><td class="r num nowrap" id="s-dsc"></td>${tail}</tr>`:""}
        <tr class="grand"><td colspan="${lab}" class="r">${isSale?"Total on credit":"Total credited to dealer"}</td><td class="r num nowrap" id="s-total"></td>${tail}</tr>`;
      calc(); };
    narrowMQ.addEventListener?.("change",()=>{ if(sh.isConnected) drawCart(); });
    const calc=()=>{
      const T=totals(), units=cart.reduce((a,i)=>a+i.qty,0);
      $("#cart-count").textContent=cart.length?`${cart.length} product${cart.length===1?"":"s"} · ${units} pc${units===1?"":"s"}`:"Tap a product to add it. Tap again to add one more.";
      $("#s-subl").textContent=pct()>0?"Total at SRP":"Subtotal";
      $("#s-sub").textContent=P(T.sub); { const u=uniPct(); $("#s-pdl").textContent=u!=null?`Less ${u}% dealer discount`:"Less dealer discount (varies per item)"; } $("#s-pd").textContent="−"+P(T.pd); if(isSale) $("#s-dsc").textContent="−"+P(T.extra);
      $("#s-total").textContent=P(T.total);
      $$(".cart-row",sh).forEach(r=>{ const i=cart[r.dataset.k]; if(i) $(".cart-amt",r).innerHTML=`<b>${P(i.qty*i.price)}</b>`; });
      const w=[], hard=[]; const did=$("#s-dealer").value, d=S.dealers.get(did);
      if(isSale&&d){ const st=status(did); const prior=old&&old.dealerId===did&&!old.voided?old.amount:0; const nb=st.balance-prior+T.total;
        if(st.maxLate>holdDays()) hard.push(`${esc(d.name)} is on hold: ${P(st.overdue)} overdue, oldest delivery ${st.maxLate} days late. Collect a payment first.`);
        else if(st.overdue>0) w.push(`${esc(d.name)} has ${P(st.overdue)} overdue.`);
        if(d.creditLimit&&nb>d.creditLimit) (blockOverLimit()?hard:w).push(`This brings the balance to ${P(nb)}, over the ${P(d.creditLimit)} credit limit.`);
        if(!d.creditLimit) w.push(`${esc(d.name)} has no credit limit set.`);
        Object.entries(diffEffect(old,{type:"sale",items:cart})).forEach(([pid,dq])=>{ const p=S.products.get(pid); if(p&&p.stock+dq<0) w.push(`Only ${p.stock} of ${esc(p.name)} in stock.`); }); }
      S._hard=isSale&&!old&&hard.length>0;
      const request=$("#s-request",sh);if(request)request.hidden=!S._hard;
      $("#s-warn").innerHTML=(S._hard?`<div class="notice bad"><p><b>Credit hold.</b> ${hard.join("<br>")}${S.canAdmin?"":"<br>Ask the owner to approve this release."}</p></div>`:"")+(w.length?`<div class="notice warn"><p>${w.join("<br>")}</p></div>`:"");
      const ow=$("#s-ovr-wrap"); if(ow) ow.hidden=!(S._hard&&S.acct?.role==="owner");
      return T; };
    const setDue=()=>{ if(!isSale||old) return; const d=S.dealers.get($("#s-dealer").value); $("#s-due").value=addDays($("#s-date").value||today(),d?d.terms??30:(S.settings.defaultTerms??30)); };
    $("#pick-list").addEventListener("click",e=>{ const b=e.target.closest("[data-pid]"); if(b) addProduct(b.dataset.pid); });
    $("#pick-q").addEventListener("input",drawPick);
    $("#pick-q").addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); const b=$("#pick-list [data-pid]"); if(b){ addProduct(b.dataset.pid); $("#pick-q").value=""; drawPick(); } } });
    $("#cart").addEventListener("click",e=>{ const row=e.target.closest(".cart-row"); if(!row) return; const i=cart[row.dataset.k];
      if(e.target.closest("[data-inc]")){ i.qty++; drawCart(); drawPick(); }
      else if(e.target.closest("[data-dec]")){ if(i.qty>1) i.qty--; else cart.splice(row.dataset.k,1); drawCart(); drawPick(); }
      else if(e.target.closest("[data-rm]")){ cart.splice(row.dataset.k,1); drawCart(); drawPick(); } });
    $("#cart").addEventListener("input",e=>{ const row=e.target.closest(".cart-row"); if(!row) return; const i=cart[row.dataset.k];
      if(e.target.classList.contains("c-qty")) i.qty=Math.max(1,Math.round(Number(e.target.value)||1));
      if(e.target.classList.contains("c-price")){ i.price=Math.max(0,r2(e.target.value)); i.mp=true; const ce=$(".c-each",row); if(ce) ce.textContent=P(i.price)+" each"; } calc(); });
    $("#cart").addEventListener("change",e=>{ if(e.target.classList.contains("c-qty")) drawCart(); });
    $("#s-pct").addEventListener("input",()=>{ pctTouched=true; cart.forEach(i=>i.pf=false); refreshLines(); drawCart(); drawPick(); });
    $("#s-dealer").addEventListener("change",()=>{ setDue(); if(!pctTouched){ $("#s-pct").value=dealerPct(S.dealers.get($("#s-dealer").value)); cart.forEach(i=>i.pf=false); refreshLines(); drawCart(); drawPick(); } else calc(); });
    $("#s-date").addEventListener("change",()=>{ setDue(); refreshLines(); drawCart(); drawPick(); });
    if(isSale) $("#s-disc").addEventListener("input",calc);
    const paid=$("#s-paid",sh); if(paid) paid.addEventListener("change",()=>{ $("#s-method").hidden=!paid.checked; });
    if(!isSale){const original=$("#s-original",sh);const choices=()=>{const keep=original.value||old?.originalSaleId;original.innerHTML=`<option value="">Choose the original sale…</option>`+[...S.txns].filter(([,t])=>t.type==="sale"&&!t.voided&&!t.opening&&t.dealerId===$("#s-dealer",sh).value).map(([id,t])=>`<option value="${esc(id)}" ${id===keep?"selected":""}>${esc(t.no)} · ${fmtDate(t.date)}</option>`).join("");};$("#s-dealer",sh).addEventListener("change",choices);choices();}
    refreshLines(); drawPick(); drawCart(); setDue();
    $("#f",sh).addEventListener("submit",e=>{ e.preventDefault(); const btn=e.submitter||$("button[type=submit]",sh);
      const did=$("#s-dealer").value; if(!did){ toast("Choose a dealer"); return; }
      if(!cart.length){ toast("Add at least one product"); $("#pick-q").focus(); return; }
      const T=calc(); if(T.total<=0){ toast("The total must be more than zero"); return; }
      if(isSale&&$("#s-due").value<$("#s-date").value){ toast("The due date can't be before the release date"); return; }
      const approved=S._hard&&S.acct?.role==="owner"&&$("#s-ovr")&&$("#s-ovr").checked;
      if(isSale&&!old&&S._hard&&!approved&&e.submitter?.id!=="s-request"){ toast(S.canAdmin?"This dealer is on credit hold. Tick “Release anyway” to approve.":"This dealer is on credit hold. Ask the owner to approve."); return; }
      const data={...(old||{}),type:kind,dealerId:did,date:$("#s-date").value,items:cart.map(i=>({productId:i.productId,name:i.name,qty:i.qty,price:i.price,pct:i.pct,...(i.promo?{promo:true}:{})})),subtotal:T.sub,discountPct:uniPct(),pctDiscount:T.pd,amount:T.total,note:$("#s-note").value.trim()};
      if(isSale){ data.dueDate=$("#s-due").value; data.discount=T.extra; } else {data.restock=$("#s-restock").checked;data.originalSaleId=$("#s-original").value||null;}
      if(!old){ data.no=nextNo(kind); data.createdAt=Date.now(); data.createdBy=S.me; if(approved) data.override={reason:$("#s-override-reason",sh).value.trim()}; } else data.updated=stamp();
      if(opts?.orderId) data.orderId=opts.orderId;
      if(paid?.checked) data.paidNow={method:$("#s-method").value};
      if(old) data.correctionReason=$("#correction-reason",sh).value.trim();
      else { delete data.createdAt;delete data.createdBy;delete data.no; }
      if(e.submitter?.id==="s-request") { guarded(btn,async()=>{ await window.APP.request("POST","/api/approvals",{sale:data,reason:$("#s-approval-reason",sh).value.trim()}); toast("Approval requested. The owner can review it in Store."); back(); }); return; }
      guarded(btn,async()=>{
        const ref=recordRef; const saved=await ref.set(data,{version:old?._version}); data.no=saved.data.no;
        toast(editId?"Changes saved":isSale?`Credit sale ${data.no} recorded · ${P(data.amount)}`:`Return ${data.no} recorded`);
        if(editId) back(); else { stack.pop(); if(opts&&opts.orderId) stack.pop(); receiptSheet(ref.id); } });
    });
  }]; },false,isSale);
}
// Open deliveries for a dealer, optionally ignoring one payment (when editing it).
function openDeliveries(did,exceptId){
  const result=LedgerAllocations.compute(dealerTxns(did).filter(([id])=>id!==exceptId).map(([id,data])=>({id,data}))),t0=today();
  return {open:result.sales.filter(s=>s.remaining>0.004).map(s=>({id:s.id,t:S.txns.get(s.id),rem:s.remaining,paid:s.paid,late:s.dueDate&&s.dueDate<t0?daysBetween(s.dueDate,t0):0})),credit:r2(Object.values(result.byCredit).reduce((n,c)=>n+c.extra,0))};
}
function allocate(open,amount){ let c=r2(amount); const out=[]; for(const o of open){ if(c<=0.004) break; const ap=Math.min(c,o.rem); c=r2(c-ap); out.push({no:o.t.no||"",id:o.id,amount:r2(ap),left:r2(o.rem-ap),cleared:o.rem-ap<=0.004}); } return {lines:out,extra:c}; }
function paymentForm(dealerId,editId,preset){
  if(!activeDealers().length&&!editId){toast("Add a dealer first");dealerForm();return;}
  const old=editId?S.txns.get(editId):null,ref=db.collection("txns").doc(editId||undefined);
  show(()=>[head(old?`Edit payment ${esc(old.no||"")}`:"Payment received","Apply it to selected invoices or let the ledger use the oldest unpaid deliveries.")+`<form id="f" class="form-grid"><label class="f span">Dealer<select id="y-dealer" required><option value="">Choose dealer…</option>${dealerOptions(old?.dealerId||dealerId)}</select></label><div class="span" id="y-quick"></div><label class="f">Amount received (₱)<input id="y-amt" type="number" min="0.01" step="0.01" required value="${old?.amount||preset?.amount||""}"></label><label class="f">Date<input id="y-date" type="date" required value="${old?.date||today()}"></label><label class="f">Method<select id="y-method">${METHODS.map(m=>`<option ${old?.method===m?"selected":""}>${m}</option>`).join("")}</select></label><label class="f">Reference<input id="y-ref" value="${esc(old?.ref||"")}"></label><label class="f span">Apply payment<select id="y-mode"><option value="fifo" ${old?.allocationMode!=="manual"?"selected":""}>Oldest unpaid invoices automatically</option><option value="manual" ${old?.allocationMode==="manual"?"selected":""}>Choose invoices and amounts</option></select></label><div class="span" id="y-invoices"></div><label class="f span">Note<input id="y-note" value="${esc(old?.note||"")}"></label><div class="span" id="y-alloc" role="status"></div>${old?correctionField():""}<div class="actions span"><button class="btn primary" type="submit" id="y-go">${old?"Save changes":"Record payment"}</button><button class="btn" type="button" data-back>Cancel</button></div></form>`,sh=>{
    let available=[];
    const amount=()=>r2($("#y-amt",sh).value),manual=()=>$("#y-mode",sh).value==="manual";
    const selected=()=>$$("[data-invoice]",sh).filter(i=>Number(i.value)>0).map(i=>({saleId:i.dataset.invoice,amount:r2(i.value)}));
    const preview=()=>{
      const did=$("#y-dealer",sh).value;if(!did){$("#y-alloc",sh).innerHTML="";return;}
      const invoiceAllocations=selected(),date=$("#y-date",sh).value;
      const rows=dealerTxns(did).filter(([id])=>id!==editId).map(([id,data])=>({id,data}));
      const simulated={type:"payment",dealerId:did,date,amount:amount(),createdAt:old?.createdAt||Date.now(),allocationMode:manual()?"manual":"fifo",invoiceAllocations};
      const result=LedgerAllocations.compute([...rows,{id:ref.id,data:simulated}]),allocation=result.byCredit[ref.id]||{lines:[],extra:0};
      const sum=r2(invoiceAllocations.reduce((n,i)=>n+i.amount,0));
      $("#y-alloc",sh).innerHTML=`${manual()?`<p class="small">Allocated ${P(sum)} of ${P(amount())}. ${sum===amount()?"":"Allocate the full payment amount before saving."}</p>`:""}${allocationTable(allocation.lines,allocation.extra)}`;
    };
    const quick=()=>{
      const did=$("#y-dealer",sh).value,date=$("#y-date",sh).value;
      const rows=dealerTxns(did).filter(([id])=>id!==editId).map(([id,data])=>({id,data})),result=LedgerAllocations.compute(rows);
      available=result.sales.filter(s=>s.remaining>0.004&&s.date<=date);
      $("#y-quick",sh).innerHTML=did?`<p>Balance <b>${P(result.balance)}</b></p>${result.balance>0?`<button class="btn sm" type="button" id="y-full">Use full balance</button>`:""}`:"";
      $("#y-invoices",sh).innerHTML=manual()?`<div class="tbl-wrap"><table><thead><tr><th>Invoice</th><th class="r">Unpaid</th><th>Apply amount (₱)</th></tr></thead><tbody>${available.map(s=>`<tr><td>${esc(s.no||s.id)}<div class="small muted">Due ${fmtDate(s.dueDate)}</div></td><td class="r num">${P(s.remaining)}</td><td><input data-invoice="${esc(s.id)}" type="number" min="0" max="${s.remaining}" step="0.01" value="${old?.dealerId===did?old.invoiceAllocations?.find(a=>a.saleId===s.id)?.amount||0:0}" aria-label="Apply payment to ${esc(s.no||s.id)}"></td></tr>`).join("")}</tbody></table></div>`:"";
      preview();
    };
    ["#y-dealer","#y-date","#y-mode"].forEach(id=>$(id,sh).addEventListener("change",quick));$("#y-amt",sh).addEventListener("input",preview);$("#y-invoices",sh).addEventListener("input",preview);
    $("#y-quick",sh).addEventListener("click",e=>{if(e.target.closest("#y-full")){const result=LedgerAllocations.compute(dealerTxns($("#y-dealer",sh).value).filter(([id])=>id!==editId).map(([id,data])=>({id,data})));$("#y-amt",sh).value=Math.max(0,result.balance);preview();}});quick();
    $("#f",sh).addEventListener("submit",e=>{e.preventDefault();const invoiceAllocations=selected();if(manual()&&r2(invoiceAllocations.reduce((n,a)=>n+a.amount,0))!==amount()){toast("Allocate the full payment amount to invoices");return;}
      const data={...(old||{}),type:"payment",dealerId:$("#y-dealer",sh).value,date:$("#y-date",sh).value,amount:amount(),method:$("#y-method",sh).value,ref:$("#y-ref",sh).value.trim(),note:$("#y-note",sh).value.trim(),allocationMode:manual()?"manual":"fifo",invoiceAllocations:manual()?invoiceAllocations:[]};
      if(old)data.correctionReason=$("#correction-reason",sh).value.trim();else{delete data.createdAt;delete data.createdBy;delete data.no;}
      guarded(e.submitter,async()=>{await ref.set(data,{version:old?._version});toast("Payment recorded");if(old)back();else{stack.pop();receiptSheet(ref.id);}});
    });
  }],false,true);
}
function txSheet(id){
  show(()=>{ const t=S.txns.get(id); if(!t) return [head("Transaction not found")+`<p>This record was removed.</p>`];
  const d=S.dealers.get(t.dealerId); resolveNames([t.createdBy,t.updated&&t.updated.by,t.voidedBy,t.override&&t.override.by]);
  const items=t.items||[];
  return [head(`${TYPE_LABEL[t.type]} ${esc(t.no||"")}${t.voided?` <span class="pill bad">Voided</span>`:""}${samplePill(t)}`,esc(d?d.name:"(removed dealer)"))+`
    <dl class="kv">
      <dt>Date</dt><dd>${fmtDate(t.date)}</dd>
      ${t.type==="sale"?`<dt>Due</dt><dd>${fmtDate(t.dueDate)}</dd>`:""}
      ${["payment","refund"].includes(t.type)?`<dt>Method</dt><dd>${esc(t.method)}</dd><dt>Reference</dt><dd>${esc(t.ref||"—")}</dd>`:""}
      ${t.type==="return"?`<dt>Stock</dt><dd>${t.restock?"Items put back in stock":"Not restocked"}</dd>`:""}
      <dt>Amount</dt><dd class="num"><b>${P(t.amount)}</b>${(t.discount||0)+(t.pctDiscount||0)?` <span class="muted">(after ${P((t.discount||0)+(t.pctDiscount||0))} discount)</span>`:""}</dd>
      ${t.note?`<dt>Note</dt><dd>${esc(t.note)}</dd>`:""}
      <dt>Recorded</dt><dd>${t.createdAt>1e9?fmtStamp(t.createdAt)+" by "+esc(nameOf(t.createdBy)):"—"}</dd>
      ${t.override?`<dt>Credit hold</dt><dd>Released anyway, approved by ${esc(nameOf(t.override.by))}</dd>`:""}
      ${t.updated?`<dt>Last edited</dt><dd>${fmtStamp(t.updated.at)} by ${esc(nameOf(t.updated.by))}</dd>`:""}
      ${t.voided?`<dt>Voided</dt><dd>${fmtStamp(t.voidedAt)} by ${esc(nameOf(t.voidedBy))}${t.voidReason?" · "+esc(t.voidReason):""}</dd>`:""}
    </dl>
    ${S.canAdmin?`<button class="btn sm" data-act="transaction-history" data-id="${esc(id)}" type="button">Correction history</button>`:""}
    ${t.type==="payment"?allocationTable(t.applied||[],t.unapplied):""}
    ${items.length?`<section class="panel" style="margin-bottom:16px"><div class="tbl-wrap"><table><thead><tr><th>#</th><th>Item</th><th class="r">Qty</th><th class="r">Price each</th><th class="r">Amount</th></tr></thead><tbody>
      ${items.map((i,k)=>`<tr><td class="muted num">${k+1}</td><td><div class="prod-cell">${thumb(S.products.get(i.productId),1)}<span>${esc(i.name)}</span></div></td><td class="r num">${i.qty}</td><td class="r num">${P(i.price)}</td><td class="r num">${P(i.qty*i.price)}</td></tr>`).join("")}</tbody>
      <tfoot>${t.pctDiscount||t.discount?`<tr><td colspan="4" class="r">${t.pctDiscount?"Total at SRP":"Subtotal"}</td><td class="r num">${P(t.subtotal??items.reduce((a,i)=>a+i.qty*i.price,0))}</td></tr>`:""}${t.pctDiscount?`<tr><td colspan="4" class="r">${discLabel(t)}</td><td class="r num">−${P(t.pctDiscount)}</td></tr>`:""}${t.discount?`<tr><td colspan="4" class="r">Extra discount</td><td class="r num">−${P(t.discount)}</td></tr>`:""}<tr><td colspan="4" class="r">Total</td><td class="r num">${P(t.amount)}</td></tr></tfoot></table></div></section>`:""}
    ${t.type==="refund"?`<div class="actions"><button class="btn" data-act="receipt" data-id="${esc(id)}" type="button">Refund receipt</button>${S.canAdmin&&!t.voided?`<button class="btn danger" data-act="void-customer-refund" data-id="${esc(id)}" type="button">Void refund</button>`:""}</div>`:""}
    ${t.type==="sale"&&!t.opening&&!t.voided&&t.items?.length&&S.canWrite?`<button class="btn" data-act="confirm-delivery" data-id="${esc(id)}" type="button">Confirm delivery / signature</button>`:""}
    ${canEditTx(t)?(t.voided?`<div class="actions"><button class="btn" id="t-unvoid" type="button">Restore this ${TYPE_LABEL[t.type].toLowerCase()}</button></div>`:
      `<div class="actions"><button class="btn primary" data-act="receipt" data-id="${esc(id)}" type="button">Receipt</button><button class="btn" id="t-edit" type="button">Edit</button><button class="btn" data-dealer="${t.dealerId}" type="button">Open dealer</button></div>
      <section class="panel" style="margin-top:16px"><h2>Void this record</h2><p class="small" style="margin-top:0">Voiding keeps the record for your history but removes it from balances and reports${t.type!=="payment"?", and reverses its stock change":""}.</p>
      <div class="actions"><input id="t-reason" placeholder="Reason, e.g. wrong dealer" style="flex:1;min-width:180px"><button class="btn danger" id="t-void" type="button">Void</button></div></section>`):(S.canWrite&&t.type!=="refund"?`<div class="notice info"><p>${t.saleId?"This payment was recorded with a sale. Correct or void the linked sale to update both together.":"Only the owner or an editor can change this record. Staff can edit or void only what they recorded today."}</p><button class="btn sm" data-dealer="${t.dealerId}" type="button">Open dealer</button>${t.saleId?`<button class="btn sm" data-tx="${esc(t.saleId)}" type="button">Open linked sale</button>`:""}</div>`:"")}`,sh=>{
    const ed=$("#t-edit",sh); if(ed) ed.addEventListener("click",()=>t.opening?openingForm(null,id):t.type==="payment"?paymentForm(null,id):itemsForm(t.type,null,id));
    const vd=$("#t-void",sh); if(vd) vd.addEventListener("click",()=>{ if(armed(vd,"Tap again to void")) guarded(vd,async()=>{ const nt={...t,voided:true,voidedAt:Date.now(),voidedBy:S.me,voidReason:$("#t-reason").value.trim()}; await db.doc("txns/"+id).set(nt,{version:t._version}); toast(`${t.no||"Record"} voided`); }); });
    const uv=$("#t-unvoid",sh); if(uv) uv.addEventListener("click",()=>guarded(uv,async()=>{ const why=prompt("Reason for restoring this transaction:");if(!why?.trim())return;const nt={...t,voided:false,updated:stamp(),correctionReason:why.trim()}; delete nt.voidedAt; delete nt.voidedBy; delete nt.voidReason; await db.doc("txns/"+id).set(nt,{version:t._version}); toast("Restored"); }));
    const dl=$("#t-del",sh); if(dl) dl.addEventListener("click",()=>{ if(armed(dl,"Tap again to delete")) guarded(dl,async()=>{ await db.doc("txns/"+id).delete(); toast("Deleted"); back(); }); });
  }]; },true);
}

/* ================= bulk actions ================= */
async function clearSamples(btn){
  guarded(btn,async()=>{
    for(const [id,t] of S.txns) if(t.sample) await db.doc("txns/"+id).set({...t,sample:false,voided:true,voidReason:"Archived example records",correctionReason:"Archived example records"},{version:t._version});
    for(const [id,m] of S.moves) if(m.sample) await db.doc("moves/"+id).set({...m,sample:false,correctionReason:"Archived example records"},{version:m._version});
    for(const c of ["dealers","products"])for(const [id,x] of S[c])if(x.sample)await db.doc(c+"/"+id).update({sample:false,active:false});
    toast("Examples archived; financial history preserved");render();
  });
}
function restoreFlow(file){
  const area=$("#restoreArea");area.textContent="Reading backup…";
  file.text().then(text=>reviewImport("backup",JSON.parse(text))).then(()=>{area.textContent="";}).catch(e=>{area.textContent=e.message||"Couldn't read that backup.";});
}

/* ================= team accounts (Node.js server) ================= */
const ROLE_L={owner:"Owner",editor:"Editor",staff:"Staff",viewer:"Viewer",dealer:"Dealer portal"};
async function loadTeam(){ try{ S.acct=await window.APP.me(); S.team=await window.APP.users(); for(const u of S.team)S.names[u.id]=u.name+(u.id===S.me?" (you)":""); refreshBackup(); $("#acct").textContent=`${S.acct.name} · ${ROLE_L[S.acct.role]}`; render(); }catch(e){} }
function teamPanel(){
  const me=S.acct||{}, owner=me.role==="owner", list=S.team||[];
  return `<section class="panel"><div class="panel-head"><h2>Team accounts</h2>${owner?`<button class="btn sm primary" data-act="new-user" type="button">+ Add person</button>`:""}</div>
    ${list.length?`<table><tbody>${list.map(u=>`<tr><td><b>${esc(u.name)}</b>${u.id===me.id?" (you)":""}<div class="small muted">${esc(u.username||"")}</div></td><td><span class="pill ${u.active?(u.role==="dealer"?"good":"neutral"):"bad"}">${u.active?ROLE_L[u.role]:"Disabled"}</span>${u.role==="dealer"&&u.dealerId?`<div class="small muted">${esc((S.dealers.get(u.dealerId)||{}).name||"")}</div>`:""}</td><td class="r">${owner&&u.id!==me.id?`<button class="btn sm" data-act="edit-user" data-id="${esc(u.id)}" type="button">Edit</button>`:""}</td></tr>`).join("")}</tbody></table>`:`<p class="small muted">Loading…</p>`}
    <dl class="kv" style="margin-top:12px"><dt><span class="pill neutral">Staff</span></dt><dd>Record sales, payments, returns and stock. Can edit or void only what they recorded today. Can't change prices, credit limits or settings, or release goods to dealers on hold.</dd>
    <dt><span class="pill neutral">Editor</span></dt><dd>Everything staff can do, plus store settings, credit rules, prices, approving credit holds and editing any record.</dd>
    <dt><span class="pill neutral">Viewer</span></dt><dd>Can see everything but change nothing. Good for an accountant.</dd>
    <dt><span class="pill neutral">Owner</span></dt><dd>Everything, plus adding and disabling team accounts.</dd>
    <dt><span class="pill good">Dealer portal</span></dt><dd>For a dealer: sees only their own balance, due dates, receipts, payment history and your catalog. Set it up from the dealer's page with “Portal access”.</dd></dl>
  </section>
  <section class="panel"><h2>Your account</h2><p class="small" style="margin-top:0">Signed in as <b>${esc(me.name||"")}</b> (${esc(me.username||"")}) · ${ROLE_L[me.role]||""}</p>
    <div class="actions"><button class="btn sm" data-act="change-pw" type="button">Change password</button><button class="btn sm" data-act="logout" type="button">Sign out</button></div></section>
  ${S.canAdmin?`<section class="panel"><div class="panel-head"><h2>Login and logout history</h2><button class="btn sm" data-act="load-auth-history" type="button">${S.authHistory?"Refresh":"Show history"}</button></div>${S.authHistory?auditTable(S.authHistory):`<p class="small muted" style="margin:0">See who signed in or signed out and when.</p>`}</section>`:""}
  ${S.canAdmin?`<section class="panel"><div class="panel-head"><h2>Activity log</h2><button class="btn sm" data-act="load-audit" type="button">${S.audit?"Refresh":"Show recent activity"}</button></div>${S.audit?auditTable():`<p class="small muted" style="margin:0">Every sign-in, sign-out, change and deletion is recorded with who did it and when.</p>`}</section>`:""}`;
}
function auditTable(rows=S.audit){
  if(!rows.length) return `<p class="small muted">No history recorded yet.</p>`;
  const lbl={create:"Added",update:"Changed",delete:"Deleted",restore:"Restored",stock:"Stock changed",supplier_return:"Goods returned to supplier",supplier_credit:"Supplier credit recorded",supplier_refund:"Supplier refund received",supplier_return_void:"Supplier return voided",supplier_refund_void:"Supplier refund voided",authorization_request:"Owner approval requested",authorization_decision:"Owner approval decided",daily_close:"Business day closed",daily_reopen:"Business day reopened",backup_download:"Complete backup downloaded",purchase_create:"Purchase order added",purchase_receive:"Supplier delivery received",purchase_cancel:"Outstanding purchase cancelled",supplier_payment:"Supplier payment recorded",supplier_payment_void:"Supplier payment voided",expense_create:"Expense recorded",expense_update:"Expense corrected",backup_verify:"Backup recovery checked",backup:"Server backup saved",login:"Signed in",logout:"Signed out",upload:"Photo added",setup:"Created the ledger",password_change:"Changed password",user_create:"Added account",user_update:"Changed account"};
  const what=a=>{ let d={}; try{ d=JSON.parse(a.detail||"{}")||{}; }catch(e){}
    if(a.collection==="txns") return `${esc(d.no||"")} ${esc(TYPE_LABEL[d.type]||"")} ${d.amount?P(d.amount):""}${d.voided?" (voided)":""}`;
    if(a.collection==="dealers"||a.collection==="products") return esc(d.name||"");
    if(a.collection==="users") return esc(d.username||"");
    return ""; };
  return `<div class="tbl-wrap" style="max-height:420px;overflow:auto"><table><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>${rows.map(a=>`<tr><td class="small nowrap">${fmtStamp(a.at)}</td><td class="small">${esc(a.user_name||"—")}</td><td class="small">${esc(lbl[a.action]||a.action)} ${a.collection&&!["txns","users"].includes(a.collection)?`<span class="muted">${esc(a.collection)}</span> `:""}${what(a)}</td></tr>`).join("")}</tbody></table></div>`;
}
function userForm(id,presetDealer){
  const u=id?(S.team||[]).find(x=>x.id===id):null; const pd=presetDealer?S.dealers.get(presetDealer):null;
  show(()=>[head(u?`Edit ${esc(u.name)}`:"Add a person")+`<form id="f" class="form-grid">
    <label class="f span">Full name<input id="u-name" required maxlength="80" value="${esc(u?u.name:pd?pd.name:"")}"></label>
    ${u?`<div class="f"><span>Username</span><b style="color:var(--fg)">${esc(u.username)}</b></div>`:`<label class="f">Username<input id="u-user" required autocapitalize="none" placeholder="e.g. ben" pattern="[A-Za-z0-9._\\-]{3,40}"><span class="hint">3–40 letters or numbers. They type this to sign in.</span></label>`}
    <label class="f">Role<select id="u-role">${["staff","editor","viewer","dealer"].map(r=>`<option value="${r}" ${(u?u.role===r:pd&&r==="dealer")?"selected":""}>${ROLE_L[r]}</option>`).join("")}</select></label>
    <label class="f span" id="u-dwrap">Which dealer<select id="u-dealer"><option value="">Choose dealer…</option>${activeDealers().map(([did,dd])=>`<option value="${did}" ${(u?u.dealerId===did:presetDealer===did)?"selected":""}>${esc(dd.name)}</option>`).join("")}</select><span class="hint">They will only see this dealer's own records.</span></label>
    <label class="f">${u?"New password (leave blank to keep)":"Password"}<input id="u-pw" type="password" autocomplete="new-password" ${u?"":"required"} minlength="8" placeholder="At least 8 characters"></label>
    ${u?`<label class="chk span"><input type="checkbox" id="u-active" ${u.active?"checked":""}> Account active (untick to block sign-in right away)</label>`:""}
    <div class="actions span"><button class="btn primary" type="submit">${u?"Save changes":"Add person"}</button><button class="btn" type="button" data-back>Cancel</button></div></form>`,sh=>{
    const syncRole=()=>{ $("#u-dwrap",sh).hidden=$("#u-role",sh).value!=="dealer"; }; $("#u-role",sh).addEventListener("change",syncRole); syncRole();
    $("#f",sh).addEventListener("submit",e=>{ e.preventDefault(); const btn=e.submitter||$("button[type=submit]",sh);
      const pw=$("#u-pw").value; const body={name:$("#u-name").value.trim(),role:$("#u-role").value};
      if(body.role==="dealer"){ body.dealerId=$("#u-dealer").value; if(!body.dealerId){ toast("Choose which dealer this account is for"); return; } }
      if(pw) body.password=pw; if(u) body.active=$("#u-active").checked; else body.username=$("#u-user").value.trim();
      guarded(btn,async()=>{ if(u) await window.APP.updateUser(u.id,body); else await window.APP.createUser(body); await loadTeam(); toast(u?"Account updated":"Account added. Give them their username and password."); back(); });
    });
  }]);
}
function passwordForm(){
  show(()=>[head("Change your password")+`<form id="f" class="form-grid">
    <label class="f span">Current password<input id="pw-cur" type="password" autocomplete="current-password" required></label>
    <label class="f">New password<input id="pw-new" type="password" autocomplete="new-password" minlength="8" required></label>
    <label class="f">Type it again<input id="pw-new2" type="password" autocomplete="new-password" minlength="8" required></label>
    <div class="actions span"><button class="btn primary" type="submit">Change password</button><button class="btn" type="button" data-back>Cancel</button></div></form>`,sh=>{
    $("#f",sh).addEventListener("submit",e=>{ e.preventDefault(); const btn=e.submitter||$("button[type=submit]",sh);
      if($("#pw-new").value!==$("#pw-new2").value){ toast("The new passwords don't match"); return; }
      guarded(btn,async()=>{ await window.APP.changePassword($("#pw-cur").value,$("#pw-new").value); toast("Password changed. Other devices were signed out."); back(); });
    });
  }]);
}

/* ================= events ================= */
function goView(v){ if((v==="dashboard"||v==="store")&&S.canAdmin)refreshBackup(); S.view=v; S.q=""; S.catFilter=""; S.showArchived=false; closeAll(); try{ history.replaceState(null,"","#"+v); }catch(_){ location.hash=v; } render(); window.scrollTo(0,0); }
function copyText(txt,title){
  const fallback=()=>show(()=>[head(title)+`<pre class="stmt" id="ctxt">${esc(txt)}</pre><p class="small muted">Select the text above and copy it from your device menu.</p>`,sh=>{ const r=document.createRange(); r.selectNodeContents($("#ctxt",sh)); const s=getSelection(); s.removeAllRanges(); s.addRange(r); }]);
  try{ navigator.clipboard.writeText(txt).then(()=>toast("Message copied. Paste it in Messenger, Viber or SMS."),fallback); }catch(e){ fallback(); }
}
document.addEventListener("click",e=>{
  const tab=e.target.closest(".tab"); if(tab){ goView(tab.dataset.view); return; }
  if(e.target.closest("a[target=_blank]")) return;
  const ofb=e.target.closest("[data-of]"); if(ofb){ S.ordFilter=ofb.dataset.of; render(); return; }
  const orw=e.target.closest("[data-order]"); if(orw){ orderSheet(orw.dataset.order); return; }
  const cf=e.target.closest("[data-cf]"); if(cf){ S.collectAll=cf.dataset.cf==="all"; render(); return; }
  const pre=e.target.closest("[data-preset]"); if(pre){ S.range.preset=pre.dataset.preset; if(S.range.preset==="custom"&&!S.range.from){ const [f,t]=[addDays(today(),-30),today()]; S.range.from=f; S.range.to=t; } render(); return; }
  const a=e.target.closest("[data-act]");
  if(a){ const act=a.dataset.act, id=a.dataset.id;
    ({ "new-sale":()=>itemsForm("sale"), "new-pay":()=>paymentForm(), "new-return":()=>itemsForm("return"),
       "sale-for":()=>itemsForm("sale",id), "pay-for":()=>paymentForm(id), "ret-for":()=>itemsForm("return",id),
       "new-dealer":()=>dealerForm(), "edit-dealer":()=>dealerForm(id), "new-product":()=>productForm(),
       "new-supplier":()=>supplierForm(),"edit-supplier":()=>supplierForm(id),"view-supplier":()=>supplierSheet(id),"purchase-supplier":()=>purchaseForm({supplierId:id,supplier:S.suppliers.get(id).name}),
       "initialize-batches":()=>initializeBatchesForm(),"edit-batch":()=>batchForm(id),"record-contact":()=>contactForm(id),"contact-history":()=>contactHistory(id),
       "confirm-delivery":()=>deliveryForm(id),"view-delivery":()=>deliverySheet(id),"void-delivery":()=>voidDelivery(id),
       "new-customer-refund":()=>customerRefundForm(),"refund-dealer":()=>customerRefundForm(id),"void-customer-refund":()=>voidCustomerRefund(id),
       "apply-supplier-credit":()=>applySupplierCreditForm(id),"void-credit-application":()=>voidCreditApplication(id),
       "import-bank":()=>bankImportForm(),"match-bank":()=>bankMatchForm(id,a.dataset.line),
       "export-bank":()=>{const events=bankLedgerEvents();return save(`bank-reconciliation-${today()}.csv`,csv([["Bank","Method","Date","Reference","Description","Signed amount","Status","Ledger matches","Note"],...[...S.bankStatements.values()].flatMap(s=>s.lines.map(l=>[s.bank,s.method,l.date,l.reference,l.description,l.amount,bankLineStatus(l,events),(l.matches||[]).map(m=>m.label).join("; "),l.note||""]))]));},
       "supplier-return":()=>supplierReturnForm(id),"supplier-refund":()=>supplierRefundForm(id),"void-supplier-return":()=>voidSupplierEvent(id,a.dataset.event,"returns"),"void-supplier-refund":()=>voidSupplierEvent(id,a.dataset.event,"refunds"),
       "decide-authorization":()=>authorizationDecision(id),"new-daily-closing":()=>dailyClosingForm(),"view-daily-closing":()=>dailyClosingSheet(id),"reopen-daily-closing":()=>reopenDailyClosing(id),
        "new-shift":()=>shiftOpenForm(),"close-shift":()=>shiftCloseForm(id),
        "close-period":()=>periodCloseForm(a.dataset.month),"reopen-period":()=>periodReopenForm(a.dataset.month),
        "scan-duplicates":()=>loadDuplicates(),"review-duplicate":()=>duplicateReviewForm(id,a.dataset.status),
       "export-daily-closing":()=>{const d=S.dailyClosings.get(id);return save(`daily-close-${d.date}.csv`,csv([["Method","Opening","Collections","Operating expenses","Supplier payments","Supplier refunds","Customer refunds","Expected","Counted","Difference"],...d.channels.map(c=>[c.method,c.opening,c.collections,c.expenses,c.supplierPayments,c.supplierRefunds,c.customerRefunds||0,c.expected,c.counted,c.difference])]));},
       "export-losses":()=>{const R=lossData();return save(`stock-losses-${R.from}-${R.to}.csv`,csv([["Date","Product","Reason","Units","Loss cost","Note"],...R.rows.map(m=>[m.date,S.products.get(m.productId)?.name||m.productId,m.reason,m.units,m.cost??"Unknown",m.note||""])]));},
       "new-purchase":()=>purchaseForm(),"view-purchase":()=>purchaseSheet(id),"receive-purchase":()=>receivePurchase(id),"pay-supplier":()=>supplierPayment(id),"cancel-purchase":()=>cancelPurchase(id),
       "void-supplier-payment":()=>voidSupplierPayment(id,a.dataset.payment),
       "new-expense":()=>expenseForm(),"edit-expense":()=>expenseForm(id),
       "reorder-purchase":()=>{const r=reorderData().find(r=>r.id===id);if(r)purchaseForm({supplier:r.supplier,productId:id,qty:r.suggested});},
       "export-expenses":()=>{const [from,to]=rangeDates();return save(`expenses-${from}-${to}.csv`,csv([["Date","Category","Payee","Amount","Method","Note","Voided"],...[...S.expenses.values()].filter(e=>e.date>=from&&e.date<=to).map(e=>[e.date,e.category,e.payee,e.amount,e.method,e.note,e.voided?"Yes":"No"])]));},
       "export-reorder":()=>save(`reorder-${today()}.csv`,csv([["Product","Supplier","Available","On order","Daily demand","Target","Suggested order","Unit cost"],...reorderData().map(r=>[r.name,r.supplier,r.available,r.onOrder,r.daily,r.target,r.suggested,r.unitCost??""])])),
       "verify-backup":()=>guarded(a,async()=>{const result=await window.APP.request("POST","/api/backup/verify",{});await refreshBackup();toast(result.ok?"Backup recovery check passed":"Backup recovery check failed",result.ok?"ok":"error");}),
       "reset-stock-filter":()=>{S.stockFilter={product:"",person:"",kind:"",from:"",to:""};render();},
       "refresh-backup":()=>guarded(a,refreshBackup),
       "run-backup":()=>guarded(a,async()=>{try{S.backupStatus=await window.APP.request("POST","/api/backup/run",{});S.backupError="";toast("Server backup saved");render();}catch(e){await refreshBackup();throw e;}}),
       "export-stock":()=>save(`stock-history-${today()}.csv`,csv([["Stock date","Recorded at","Product","Added by","Type","Quantity","Voided","Supplier","Delivery reference","Unit cost","Note"],...stockRows().map(m=>[m.date,m.createdAt?new Date(m.createdAt).toISOString():"",S.products.get(m.productId)?.name||m.productId,S.names[m.createdBy]||m.createdBy||"",m.kind,m.qty,m.voided?"Yes":"No",m.supplier||"",m.reference,m.unitCost??"",m.note||""])])),
       "export-profit":()=>{const R=profitData();return save(`gross-profit-${R.from}-${R.to}.csv`,csv([["Gross profit report",R.from,R.to],["Missing cost transactions",R.missing],["Missing item transactions",R.excluded],["Date","Net sales","Product costs","Gross profit","Operating expenses","Stock losses","Supplier return value difference","Profit after costs"],...R.rows.map(r=>[r.date,r.revenue,r.cost,r.profit,r.expenses,r.stockLoss,r.supplierVariance,r.netProfit])]))},
       "stock-in":()=>stockForm(S.view==="stock"?S.stockFilter.product:undefined), "stock-for":()=>stockForm(id), "clear-samples":()=>{ if(armed(a,"Tap again to remove")) clearSamples(a); },
       "backup":async()=>{ if(await save(`ledger-backup-${today()}.json`,JSON.stringify(await window.APP.backup(),null,1))){ lsSet("lastBackup",Date.now()); render(); } },
       "receipt":()=>receiptSheet(id),
       "go-orders":()=>goView("orders"),
       "catalog":()=>catalogSheet(),
       "pay-amt":()=>paymentForm(id,null,{amount:Number(a.dataset.amt).toFixed(2)}),
       "retry-load":()=>location.reload(), "reconcile":()=>reconciliationSheet(), "period-statement":()=>statementSheet(id), "transaction-history":()=>historySheet(id), "approval-decision":()=>approvalDecision(id), "approval-release":()=>releaseApproved(id,a), "new-user":()=>userForm(), "portal-for":()=>{ const ex=(S.team||[]).find(u=>u.role==="dealer"&&u.dealerId===id); userForm(ex?ex.id:null,ex?null:id); }, "edit-user":()=>userForm(id), "change-pw":()=>passwordForm(), "logout":()=>window.APP.logout(),
       "load-auth-history":()=>guarded(a,async()=>{ S.authHistory=await window.APP.audit(150,"auth"); render(); }),
       "load-audit":()=>guarded(a,async()=>{ S.audit=await window.APP.audit(150); render(); }),
       "go-dealers":()=>goView("dealers"), "go-collect":()=>goView("collect"), "count":()=>countSheet(),
       "opening-for":()=>openingForm(id), "new-opening":()=>openingForm(),
       "remind-copy":()=>copyText(reminderText(id),"Reminder message"),
       "remind-mark":()=>guarded(a,async()=>{ const d=S.dealers.get(id); const on=d.lastReminded!==today(); await db.doc("dealers/"+id).update(on?{lastReminded:today(),lastRemindedBy:S.me}:{lastReminded:d.prevReminded||null}); if(on) await db.doc("dealers/"+id).update({prevReminded:d.lastReminded||null}); toast(on?`${d.name} marked as reminded`:"Reminder unmarked"); }),
       "export-tx":()=>save(`transactions-${today()}.csv`,csv([["Date","No.","Type","Status","Dealer","Items","Subtotal","Dealer discount %","Dealer discount","Extra discount","Amount","Due date","Method","Reference","Note"],...[...S.txns.values()].sort((x,y)=>(x.date||"").localeCompare(y.date||"")).map(t=>{ const d=S.dealers.get(t.dealerId); return [t.date,t.no||"",TYPE_LABEL[t.type],t.voided?"Voided":"OK",d?d.name:"",(t.items||[]).map(i=>`${i.name} x${i.qty} @ ${i.price}`).join("; "),t.subtotal??"",t.discountPct??"",t.pctDiscount||"",t.discount||"",["sale","refund"].includes(t.type)?t.amount:-t.amount,t.dueDate||"",t.method||"",t.ref||"",t.note||""]; })])),
       "export-dealers":()=>save(`dealers-${today()}.csv`,csv([["Dealer","First name","Middle name","Last name","Age","Gender","Nationality","Mobile","Area","Credit limit","Terms (days)","Balance","Overdue","Days late","Last payment","Rating","Paid on time %","Avg days to pay","Worst delay (days)","Total credit taken","Total paid","Status"],...[...S.dealers.entries()].map(([id,d])=>{ const st=status(id), h=history(id); return [d.name,d.firstName||"",d.middleName||"",d.lastName||"",d.age??"",d.gender||"",d.nationality||"",d.phone,d.area,d.creditLimit??"",d.terms??"",st.balance,st.overdue,st.maxLate,st.lastPay||"",h.grade.g,h.n?Math.round(h.onTime/h.n*100):"",h.avgDays??"",h.worst,h.taken,h.paid,d.active===false?"Archived":"Active"]; })])),
       "export-products":()=>save(`products-${today()}.csv`,csv([["Product","Category","Code","Dealer price","SRP","Stock","Reorder level","Status"],...[...S.products.values()].map(p=>[p.name,p.category||"",p.code||"",p.dealerPrice,p.srp??"",p.stock,p.reorderLevel??"",p.active===false?"Archived":"Active"])])),
       "export-report":()=>{ const R=reportData(); save(`report-${R.from}-to-${R.to}.csv`,csv([["Report",`${R.from} to ${R.to}`],[],["Credit sales",R.tot.sale],["Discounts",R.tot.discount],["Returns",R.tot.return],["Collections",R.tot.payment],[],["Product","Qty sold","Qty returned","Sales"],...Object.values(R.byP).map(p=>[p.name,p.qty,p.ret,r2(p.amt)]),[],["Dealer","Net sales","Paid","Balance now"],...Object.entries(R.byD).map(([id,d])=>[S.dealers.get(id)?.name||"",r2(d.sale-d.return),r2(d.payment),status(id).balance]),[],["Method","Collected"],...Object.entries(R.byM)])); }
    }[act]||(()=>{}))();
    return; }
  const tx=e.target.closest("[data-tx]"); if(tx&&(!e.target.closest("button")||e.target.closest("button")===tx)){ txSheet(tx.dataset.tx); return; }
  const dl=e.target.closest("[data-dealer]"); if(dl){ e.preventDefault(); dealerSheet(dl.dataset.dealer); return; }
  const pr=e.target.closest("[data-product]"); if(pr){ productForm(pr.dataset.product); }
});
document.addEventListener("keydown",e=>{ if(e.key==="Enter"&&e.target.matches("tr[tabindex]")) e.target.click();
  const typing=e.target.closest&&e.target.closest("input,textarea,select,[contenteditable]");
  if(((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k")||(e.key==="/"&&!typing)){ e.preventDefault(); searchSheet(); } });
document.addEventListener("click",e=>{
  const n=e.target.closest("[data-nav]"); if(n){ if(n.dataset.nav==="more") moreSheet(); else goView(n.dataset.nav); return; }
  if(e.target.closest("#fab")){ actionSheet(); return; }
  if(e.target.closest("#sidebarToggle")){lsSet("sidebarCollapsed",lsGet("sidebarCollapsed")!=="true");render();return;}
  if(e.target.closest("#btnSearch")){ searchSheet(); return; }
});
let scr=false; window.addEventListener("scroll",()=>{ const v=window.scrollY>4; if(v!==scr){ scr=v; document.body.classList.toggle("scrolled",v); } },{passive:true});
let qTimer; document.addEventListener("input",e=>{ if(e.target.id==="q"){ S.q=e.target.value; clearTimeout(qTimer); qTimer=setTimeout(render,120); } });
document.addEventListener("change",e=>{
  const id=e.target.id;
  if(id==="batch-product"){S.batchProduct=e.target.value;render();return;}
  if(id==="batch-filter"){S.batchFilter=e.target.value;render();return;}
  if(id==="reminder-filter"){S.reminderFilter=e.target.value;render();return;}
  if(id==="dupe-days"){S.dupeDays=Math.max(1,Math.min(90,Math.round(Number(e.target.value)||7)));S.duplicates=null;S.duplicatesError="";loadDuplicates();return;}
  if(e.target.dataset.stockFilter){S.stockFilter[e.target.dataset.stockFilter]=e.target.value;render();return;}
  if(id==="reorder-lead"||id==="reorder-cover"){S[id==="reorder-lead"?"reorderLead":"reorderCover"]=Math.max(id==="reorder-lead"?0:1,Math.min(365,Number(e.target.value)||0));render();return;}
  if(id==="profitGroup"){S.profitGroup=e.target.value;render();return;}
  if(id==="txFilter"){ S.txFilter=e.target.value; render(); }
  else if(id==="catFilter"){ S.catFilter=e.target.value; render(); }
  else if(id==="showArch"){ S.showArchived=e.target.checked; render(); }
  else if(id==="rFrom"||id==="rTo"){ S.range[id==="rFrom"?"from":"to"]=e.target.value; render(); }
  else if(id==="restoreFile"&&e.target.files[0]) restoreFlow(e.target.files[0]);
});
document.addEventListener("submit",e=>{
  if(e.target.id==="limits-form"){e.preventDefault();const limits=Object.fromEntries($$("[data-limit]",e.target).map(i=>[i.dataset.limit,Number(i.value)]));guarded(e.submitter,async()=>{await db.doc("settings/store").set({...S.settings,...limits});toast("Approval limits saved");});return;}
  if(e.target.id!=="storeForm") return; e.preventDefault(); const btn=e.submitter||$("button[type=submit]",e.target);
  const data={...S.settings,storeName:$("#st-name").value.trim(),phone:$("#st-phone").value.trim(),address:$("#st-addr").value.trim(),paymentInfo:$("#st-pay").value.trim(),defaultTerms:Math.max(0,Math.round(Number($("#st-terms").value)||0)),footer:$("#st-foot").value.trim(),defaultLimit:$("#st-limit").value===""?null:r2($("#st-limit").value),holdDays:Math.max(1,Math.round(Number($("#st-hold").value)||60)),blockOverLimit:$("#st-block").checked,reminderTemplate:$("#st-msg").value.trim(),discountPct:Math.min(100,Math.max(0,Number($("#st-pct").value)||0)),updated:stamp()};
  guarded(btn,async()=>{ await db.doc("settings/store").set(data); toast("Store details saved"); btn.disabled=false; });
});
const VIEWS=["dashboard","overview","orders","collect","dealers","products","stock","activity","reports","profit","purchases","expenses","reorder","losses","controls","closing","shifts","periods","duplicates","suppliers","batches","reminders","deliveries","refunds","bank","store"];
const fromHash=()=>{ const h=location.hash.slice(1); if(VIEWS.includes(h)) S.view=h; };
window.addEventListener("hashchange",()=>{ fromHash(); render(); }); fromHash(); render();

/* ================= reviewed business workflows ================= */
const correctionField=()=>`<label class="f span">Reason for correction<input id="correction-reason" required placeholder="Explain what was wrong and why it is being changed"></label>`;
function allocationTable(lines,extra=0){
  return `<section class="panel"><h3>Payment allocation</h3>${lines.length?`<table><thead><tr><th>Delivery</th><th class="r">Applied</th><th class="r">Left after allocation</th></tr></thead><tbody>${lines.map(a=>`<tr><td>${esc(a.no||a.id)}</td><td class="r num">${P(a.amount)}</td><td class="r num">${P(a.left)}</td></tr>`).join("")}</tbody></table>`:`<p>No delivery allocation.</p>`}${extra?`<p>Unapplied credit: <b>${P(extra)}</b></p>`:""}<p class="hint">Calculated from the current ledger, oldest delivery first. Corrections and voids may change these allocations.</p></section>`;
}
async function historySheet(id){
  try{const records=await window.APP.request("GET","/api/txns/"+encodeURIComponent(id)+"/history");
    show(()=>[head("Correction history")+(records.length?records.sort((a,b)=>b.data.at-a.data.at).map(({data:r})=>`<section class="panel"><h3>${fmtStamp(r.at)} · ${esc(nameOf(r.by))}</h3><p>${esc(r.reason)}</p><p>Before: ${esc(r.before.no)} · ${P(r.before.amount)} · ${esc(r.before.date)}${r.before.voided?" · Voided":""}</p><details><summary>Original record</summary><pre style="white-space:pre-wrap">${esc(JSON.stringify(r.before,null,2))}</pre></details></section>`).join(""):`<p>No corrections. The original entry is unchanged.</p>`)]);
  }catch(e){toast(e.message,"error");}
}
function statementSheet(id){
  show(()=>[head("Statement by period","Includes the opening balance and every live transaction within the dates selected.")+`<form id="statement-form" class="form-grid"><label class="f">From<input id="statement-from" type="date" required value="${today().slice(0,7)}-01"></label><label class="f">To<input id="statement-to" type="date" required value="${today()}"></label><div class="actions span"><button class="btn primary" type="submit">Generate statement</button></div></form><div id="statement-result"></div>`,sh=>{
    $("#statement-form",sh).addEventListener("submit",e=>{e.preventDefault();guarded(e.submitter,async()=>{
      const out=await window.APP.request("GET",`/api/dealers/${encodeURIComponent(id)}/statement?from=${$("#statement-from",sh).value}&to=${$("#statement-to",sh).value}`);
      const body=`<article class="receipt"><h2>${esc(out.store)}</h2><h3>STATEMENT OF ACCOUNT</h3><p><b>${esc(out.dealer.name)}</b><br>${fmtDate(out.from)} – ${fmtDate(out.to)}</p><p>Opening balance: <b>${P(out.opening)}</b></p><table class="rc-tbl"><thead><tr><th>Date</th><th>Reference</th><th class="r">Charged</th><th class="r">Credited</th><th class="r">Balance</th></tr></thead><tbody>${out.entries.map(t=>`<tr><td>${esc(t.date)}</td><td>${esc(t.no)}<br><small>${esc(TYPE_LABEL[t.type])}</small></td><td class="r">${t.debit?P(t.debit):"—"}</td><td class="r">${t.credit?P(t.credit):"—"}</td><td class="r">${P(t.balance)}</td></tr>`).join("")}</tbody></table><div class="rc-total"><span>Closing balance</span><b>${P(out.closing)}</b></div><h3>Delivery balances as of ${fmtDate(out.to)}</h3><table class="rc-tbl"><thead><tr><th>Delivery</th><th>Due</th><th class="r">Remaining</th></tr></thead><tbody>${out.allocations.sales.map(s=>`<tr><td>${esc(s.no)}</td><td>${esc(s.dueDate||"—")}</td><td class="r">${P(s.remaining)}</td></tr>`).join("")}</tbody></table></article>`;
      show(()=>[head("Statement · "+out.dealer.name)+`<div class="actions no-print"><button class="btn primary" id="statement-print" type="button">Print statement</button><button class="btn" id="statement-csv" type="button">Export CSV</button></div>`+body,modal=>{
        $("#statement-print",modal).addEventListener("click",()=>window.print());
        $("#statement-csv",modal).addEventListener("click",()=>save(`statement-${id}-${out.from}-${out.to}.csv`,csv([[out.store,out.dealer.name],["From",out.from,"To",out.to],["Opening balance",out.opening],["Date","Reference","Type","Debit","Credit","Balance"],...out.entries.map(t=>[t.date,t.no,t.type,t.debit,t.credit,t.balance]),["Closing balance",out.closing]])));
      }]);e.submitter.disabled=false;
    });});
  }]);
}
function approvalPanel(){
  const rows=[...S.approvals].sort((a,b)=>(b[1].createdAt||0)-(a[1].createdAt||0));
  return `<section class="panel"><h2>Credit approvals</h2><p class="small muted">Approved requests are valid for 24 hours and authorize only the sale that was reviewed.</p>${rows.length?rows.map(([id,a])=>`<div style="padding:12px 0;border-bottom:1px solid var(--line)"><b>${esc(S.dealers.get(a.sale?.dealerId)?.name||"Dealer")} · ${P(a.sale?.amount)}</b> <span class="pill neutral">${esc(a.status)}</span><p>${esc(a.reason)}</p><p class="small muted">${fmtStamp(a.createdAt)}${a.decisionReason?" · "+esc(a.decisionReason):""}</p><details><summary>Sale details</summary><p>${esc(a.sale?.date)} · due ${esc(a.sale?.dueDate)}</p><ul>${(a.sale?.items||[]).map(i=>`<li>${esc(i.name)} × ${i.qty} @ ${P(i.price)}</li>`).join("")}</ul></details>${a.status==="pending"&&S.acct?.role==="owner"?`<button class="btn sm" data-act="approval-decision" data-id="${esc(id)}" type="button">Review decision</button>`:""}${a.status==="approved"&&a.requestedBy===S.me?`<button class="btn sm primary" data-act="approval-release" data-id="${esc(id)}" type="button">Record approved sale</button>`:""}</div>`).join(""):`<p>No credit approval requests.</p>`}</section>`;
}
function approvalDecision(id){
  const a=S.approvals.get(id);if(!a)return;
  show(()=>[head("Decide credit request",`${S.dealers.get(a.sale.dealerId)?.name||"Dealer"} · ${P(a.sale.amount)}`)+`<p>${esc(a.reason)}</p><form id="approval-form"><label class="f">Decision<select id="approval-status"><option value="approved">Approve</option><option value="rejected">Reject</option></select></label><label class="f">Reason<textarea id="approval-reason" required></textarea></label><button class="btn primary" type="submit">Save decision</button></form>`,sh=>$("#approval-form",sh).addEventListener("submit",e=>{e.preventDefault();guarded(e.submitter,async()=>{await window.APP.request("POST",`/api/approvals/${encodeURIComponent(id)}/decision`,{status:$("#approval-status",sh).value,reason:$("#approval-reason",sh).value});toast("Decision recorded");back();});})]);
}
function releaseApproved(id,btn){
  const a=S.approvals.get(id);if(!a)return;
  guarded(btn,async()=>{const ref=db.collection("txns").doc("approved_"+id);await ref.set({...a.sale,approvalId:id});toast("Approved sale recorded");receiptSheet(ref.id);});
}
function reconciliationSheet(){
  show(()=>[head("Reconcile collections","Enter the totals actually counted or verified in each payment channel.")+`<form id="recon-form" class="form-grid"><label class="f">From<input id="recon-from" type="date" required value="${today()}"></label><label class="f">To<input id="recon-to" type="date" required value="${today()}"></label>${METHODS.map((m,i)=>`<label class="f">${esc(m)} counted (₱)<input data-count="${i}" type="number" min="0" step="0.01" required value="0"></label>`).join("")}<label class="f span">Discrepancy explanation<textarea id="recon-note" placeholder="Required if counted totals differ"></textarea></label><div class="actions span"><button class="btn primary" type="submit">Preview reconciliation</button></div></form><div id="recon-result"></div><h3>Previous reconciliations</h3>${[...S.reconciliations].sort((a,b)=>b[1].closedAt-a[1].closedAt).map(([id,r])=>`<section class="panel"><b>${esc(r.from)} – ${esc(r.to)}</b> · ${esc(r.status)}<p>${esc(r.note||"")}</p><p>${(r.totals||[]).map(t=>`${esc(t.method)}: expected ${P(t.expected)}, counted ${P(t.actual)}, difference ${P(t.difference)}`).join("<br>")}</p>${r.reopenReason?`<p>Reopened: ${esc(r.reopenReason)}</p>`:""}${r.status==="closed"&&S.acct?.role==="owner"?`<button class="btn sm" data-reopen="${esc(id)}" type="button">Reopen period</button>`:""}</section>`).join("")}`,sh=>{
    $("#recon-form",sh).addEventListener("submit",e=>{e.preventDefault();guarded(e.submitter,async()=>{
      const input={from:$("#recon-from",sh).value,to:$("#recon-to",sh).value,counts:Object.fromEntries(METHODS.map((m,i)=>[m,Number($(`[data-count="${i}"]`,sh).value)])),note:$("#recon-note",sh).value};
      const report=await window.APP.request("POST","/api/reconciliations/preview",input);
      show(()=>[head("Review collection totals",`${report.from} – ${report.to}`)+`<table><thead><tr><th>Method</th><th>Expected</th><th>Counted</th><th>Difference</th></tr></thead><tbody>${report.totals.map(t=>`<tr><td>${esc(t.method)}</td><td>${P(t.expected)}</td><td>${P(t.actual)}</td><td>${P(t.difference)}</td></tr>`).join("")}</tbody></table><p>${esc(input.note)}</p><p>Closing this period prevents payment changes until the owner reopens it.</p><button class="btn primary" id="recon-close" type="button">Confirm and close period</button>`,modal=>$("#recon-close",modal).addEventListener("click",ev=>guarded(ev.currentTarget,async()=>{await window.APP.request("POST","/api/reconciliations",{...input,fingerprint:report.fingerprint});toast("Collection period closed");closeAll();}))]);e.submitter.disabled=false;
    });});
    $$("[data-reopen]",sh).forEach(b=>b.addEventListener("click",()=>{const why=prompt("Why is this collection period being reopened?");if(why?.trim())guarded(b,async()=>{await window.APP.request("POST",`/api/reconciliations/${encodeURIComponent(b.dataset.reopen)}/reopen`,{reason:why});toast("Period reopened");back();});}));
  }]);
}
async function reviewImport(kind,input){
  const preview=await window.APP.previewImport(kind,input);
  show(()=>[head(kind==="backup"?"Review backup restore":"Review catalog import",`${preview.counts.create} new · ${preview.counts.overwrite} overwritten`)+`<p>Records with matching IDs will be overwritten. Other records are kept. All changes are applied together after a safety backup is created.</p>${preview.errors.length?`<div class="notice bad"><p>Fix these errors and preview again. Nothing has been imported.</p><ul>${preview.errors.map(e=>`<li>${esc(e.collection)}/${esc(e.id)}: ${esc(e.message)}</li>`).join("")}</ul></div>`:""}<div class="tbl-wrap" style="max-height:360px;overflow:auto"><table><thead><tr><th>Record</th><th>Action</th><th>Current → incoming</th></tr></thead><tbody>${preview.records.map(r=>`<tr><td>${esc(r.collection)}/${esc(r.id)}</td><td>${esc(r.action)}</td><td>${esc(r.before?.name||r.before?.no||"—")} → ${esc(r.after?.name||r.after?.no||r.id)}<details><summary>Inspect values</summary><pre style="white-space:pre-wrap">${esc(JSON.stringify({current:r.before,incoming:r.after},null,2))}</pre></details></td></tr>`).join("")}</tbody></table></div><p class="small muted">Preview expires ${fmtStamp(preview.expiresAt)}. If the ledger changes, preview again.</p><div id="import-progress" role="status"></div><div class="actions"><button class="btn danger" id="import-confirm" type="button" ${preview.canApply?"":"disabled"}>Confirm ${kind==="backup"?"restore":"import"}</button></div>`,sh=>{
    $("#import-confirm",sh).addEventListener("click",e=>guarded(e.currentTarget,async()=>{
      $("#import-progress",sh).textContent="Creating safety backup and applying all records…";
      try {const result=await window.APP.confirmImport(preview.id);$("#import-progress",sh).textContent=`Completed: ${result.count} succeeded, ${result.failed.length} failed. Safety backup: ${result.safetyBackup}`;e.target.hidden=true;toast("Import completed");}
      catch(err){$("#import-progress",sh).textContent="Import was not completed. "+err.message;throw err;}
    }));
  }]);
}

/* ================= data ================= */
(async()=>{
  const sync=$("#sync"); const use=n=>Promise.resolve(window.claude?.use?.(n)??null).catch(()=>null);
  [db,userNs,downloads,assets]=await Promise.all(["db","user","downloads","assets"].map(use));
  if(!db){ sync.textContent="Not connected"; $("#topActions").hidden=true; $("#main").innerHTML=`<section class="panel"><div class="empty"><h3>The ledger can't be opened here</h3><p>Reload the page. If it keeps happening, check that the server is running.</p></div></section>`; return; }
  if(userNs){ try{ const [c,ad,me]=await Promise.all([userNs.can("data.write"),userNs.canEdit(),userNs.id?userNs.id():null]); S.canWrite=c!==false; S.canAdmin=!!ad; S.me=me||null; }catch(e){} }
  $("#btnSearch .ic").innerHTML=ICON.search; $("#fab").innerHTML=ICON.plus; $("#main").removeAttribute("aria-busy");
  S._ver=0; loadTeam();
  let timer=setTimeout(()=>{ sync.textContent="Can't reach the ledger yet. Check your internet connection."; },10000);
  const failedLoads=new Set();
  const onErr=(e,c)=>{ failedLoads.add(c); clearTimeout(timer); console.error(e); sync.textContent=e&&e.message?e.message:e&&e.code==="invalid_argument"?"You don't have access to this ledger's data.":"Lost connection. Reload the page to retry."; if(!Object.values(S.loaded).every(Boolean)) $("#main").innerHTML=`<section class="panel"><div class="empty"><h3>Couldn't load the ledger</h3><p>${esc(sync.textContent)}</p><button class="btn primary" data-act="retry-load" type="button">Retry</button></div></section>`; };
  const norm={dealers:x=>x,products:x=>({...x,stock:Number(x.stock)||0,dealerPrice:Number(x.dealerPrice)||0}),txns:x=>({...x,amount:Number(x.amount)||0}),moves:x=>({...x,qty:Number(x.qty)||0})};
  let raf=0; const schedule=()=>{ if(raf) return; raf=requestAnimationFrame(()=>{ raf=0; render(); paintSheet(true); }); };
  const done=(meta,c)=>{ failedLoads.delete(c); if(!failedLoads.size&&!meta.fromCache&&Object.values(S.loaded).every(Boolean)){ clearTimeout(timer); sync.textContent=S.canWrite?"Saved · updates live":"View only · updates live"; } };
  COLS.forEach(c=>db.collection(c).onSnapshot(snap=>{ const m=new Map(); snap.docs.forEach(d=>{const raw=d.data(),value=(norm[c]||(x=>x))(raw);if(raw._version!=null&&!Object.hasOwn(value,"_version"))Object.defineProperty(value,"_version",{value:raw._version});m.set(d.id,value);});
    if(c==="orders"&&S.loaded.orders) m.forEach((o,k)=>{ if(!S.orders.has(k)&&o.status==="new"){ const d=S.dealers.get(o.dealerId); toast(`New online order ${o.no||""} from ${d?d.name:"a dealer"}`); } }); S[c]=m; S.loaded[c]=true; S._ver++; done(snap.metadata,c); schedule(); },e=>onErr(e,c)));
  db.doc("settings/store").onSnapshot(snap=>{ S.settings=snap.exists?{...snap.data()}:{}; S.loaded.settings=true; S._ver++; done(snap.metadata,"settings"); schedule(); },e=>onErr(e,"settings"));
})();
})();
