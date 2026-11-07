(() => {
"use strict";
/* ================= state ================= */
const S = {
  dealers:new Map(), products:new Map(), txns:new Map(), moves:new Map(), orders:new Map(), approvals:new Map(), reconciliations:new Map(), settings:{},
  loaded:{dealers:false,products:false,txns:false,moves:false,orders:false,approvals:false,reconciliations:false,settings:false},
  canWrite:true, canAdmin:false, me:null, names:{},
  view:"overview", q:"", txFilter:"all", showArchived:false, catFilter:"",
  range:{preset:"month",from:"",to:""}
};
let db=null, downloads=null, assets=null, userNs=null;
const COLS=["dealers","products","txns","moves","orders","approvals","reconciliations"];

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
const TYPE_LABEL={sale:"Credit sale",payment:"Payment",return:"Return"};
const PREFIX={sale:"DR",payment:"OR",return:"RT"};
const isLive=t=>!t.voided;
const storeName=()=>S.settings.storeName||"Dealer Credit Ledger";
const holdDays=()=>Number(S.settings.holdDays??60)||60;
const blockOverLimit=()=>S.settings.blockOverLimit!==false;
const lsGet=k=>{ try{ return localStorage.getItem("dcl:"+k); }catch(e){ return null; } };
const lsSet=(k,v)=>{ try{ localStorage.setItem("dcl:"+k,String(v)); }catch(e){} };
const canEditTx=t=>!t.saleId&&(S.canAdmin||(S.canWrite&&!!S.me&&t.createdBy===S.me&&t.createdAt>1e9&&ymd(new Date(t.createdAt))===today()));
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
  const tx=dealerTxns(id).map(([,t])=>t); let credit=0, charged=0;
  tx.forEach(t=>{ if(t.type==="sale") charged+=t.amount; else credit+=t.amount; });
  let pool=credit; const t0=today(); const open=[];
  tx.filter(t=>t.type==="sale").forEach(s=>{ const ap=Math.min(pool,s.amount); pool-=ap; const rem=r2(s.amount-ap); if(rem>0.004) open.push({...s,remaining:rem,late:s.dueDate&&s.dueDate<t0?daysBetween(s.dueDate,t0):0}); });
  const balance=r2(charged-credit);
  return { balance, overdue:r2(open.filter(o=>o.late>0).reduce((a,o)=>a+o.remaining,0)), maxLate:open.reduce((m,o)=>Math.max(m,o.late),0), open,
    nextDue:open.filter(o=>!o.late).map(o=>o.dueDate).sort()[0]||null,
    lastPay:tx.filter(t=>t.type==="payment").map(t=>t.date).sort().pop()||null };
}
// Credit history: when each delivery was fully paid (FIFO), on-time rate and a simple rating.
function creditHistory(id){
  const tx=dealerTxns(id).map(([,t])=>t), t0=today(); const queue=[], settled=[]; let pool=0;
  tx.forEach(t=>{
    if(t.type==="sale"){ let rem=t.amount; if(pool>0.004){ const ap=Math.min(pool,rem); pool=r2(pool-ap); rem=r2(rem-ap); } if(rem<=0.004) settled.push({t,paid:t.date}); else queue.push({t,rem}); }
    else { let c=t.amount; while(c>0.004&&queue.length){ const q=queue[0]; const ap=Math.min(c,q.rem); q.rem=r2(q.rem-ap); c=r2(c-ap); if(q.rem<=0.004){ queue.shift(); settled.push({t:q.t,paid:t.date}); } } pool=r2(pool+c); }
  });
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
  try{ const ps=await userNs.profiles(need); let ch=false; need.forEach(id=>{ const n=ps&&ps[id]&&ps[id].name; if(n){ S.names[id]=(id===S.me?n+" (you)":n); ch=true; } }); if(ch) paintSheet(true); }catch(e){}
}

/* ================= main views ================= */
function render(){
  $$(".tab").forEach(b=>b.setAttribute("aria-current",b.dataset.view===S.view?"page":"false"));
  $("#topActions").hidden=!S.canWrite;
  $("#storeName").textContent=storeName();
  { const n=activeOrders().filter(([,o])=>o.status==="new").length; const b=$("#ordBadge"); b.hidden=!n; b.textContent=n; $("#ordersTab").hidden=!window.APP; }
  renderBottomNav();
  if(!db||!Object.values(S.loaded).every(Boolean)) return;
  const act=document.activeElement, fid=act&&act.closest&&act.closest("#main")&&act.id, pos=act&&act.selectionStart;
  const mainEl=$("#main"); if(S._lastView!==S.view){ S._lastView=S.view; mainEl.classList.remove("view-in"); void mainEl.offsetWidth; mainEl.classList.add("view-in"); }
  $("#main").innerHTML=({overview:vOverview,orders:vOrders,collect:vCollect,dealers:vDealers,products:vProducts,activity:vActivity,reports:vReports,store:vStore}[S.view]||vOverview)();
  if(S.view==="reports") mountTrend();
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
  if(t.type==="return") return `${no}<span class="pill warn">Return</span>${vd} <span class="small">${it}</span><div class="small muted">${t.restock?"Back to stock":"Not restocked"}${t.note?" · "+esc(t.note):""}</div>`;
  return `${no}<span class="pill good">${t.payKind==="partial"?"Partial payment":t.payKind==="full"?"Full payment":"Payment"}</span>${vd} <span class="small">${esc(t.method||"")}${t.ref?" · Ref "+esc(t.ref):""}</span>${t.note?`<div class="small muted">${esc(t.note)}</div>`:""}`;
}
const sign=t=>t.type==="sale"?"":"−";
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
  const tot={sale:0,payment:0,return:0,discount:0,count:tx.length}; const byP={}, byD={}, byM={};
  tx.forEach(t=>{ tot[t.type]+=t.amount; if(t.type==="sale") tot.discount+=(t.discount||0)+(t.pctDiscount||0);
    const d=byD[t.dealerId]=byD[t.dealerId]||{sale:0,payment:0,return:0}; d[t.type]+=t.amount;
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
  return trendChart()+`<section class="panel" style="margin-bottom:20px">
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
    <section class="panel"><h2>Backup and restore</h2>
      <p class="small" style="margin-top:0">Download a backup regularly and keep it on your phone, computer or Google Drive. Photos are not inside the backup file. The server also saves an automatic backup of everything (photos excluded) every day.</p>
      <div class="actions">${downloads&&S.canAdmin?`<button class="btn primary" data-act="backup" type="button">Download backup</button>`:`<span class="small muted">Downloads aren't available in this view.</span>`}
      ${S.canAdmin?`<label class="btn" for="restoreFile" style="cursor:pointer">Restore from backup…</label><input id="restoreFile" type="file" accept=".json,application/json" hidden>`:""}</div>
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
  const nNew=[...S.orders.values()].filter(o=>o.status==="new").length, nReady=[...S.orders.values()].filter(o=>o.status==="ready").length;
  if(nNew||nReady) out.push(`<div class="notice info"><p><b>${nNew?`${nNew} new online order${nNew===1?"":"s"}`:""}${nNew&&nReady?" · ":""}${nReady?`${nReady} ready for pickup`:""}.</b> Prepare items before the dealer arrives.</p><button class="btn sm" data-act="go-orders" type="button">Open orders</button></div>`); const real=[...S.dealers.values()].some(d=>!d.sample);
  const hold=[...S.dealers.keys()].filter(id=>status(id).maxLate>holdDays()).length;
  if(hold) out.push(`<div class="notice bad"><p><b>${hold} dealer${hold===1?" is":"s are"} on credit hold</b> (more than ${holdDays()} days late). New credit sales to them are blocked until they pay.</p><button class="btn sm" data-act="go-collect" type="button">Open collection list</button></div>`);
  const nolim=activeDealers().filter(([,d])=>!d.creditLimit).length;
  if(nolim&&S.canWrite) out.push(`<div class="notice warn"><p><b>${nolim} dealer${nolim===1?" has":"s have"} no credit limit.</b> Set one for every dealer, even a high one, so the app can stop risky releases.</p><button class="btn sm" data-act="go-dealers" type="button">Review dealers</button></div>`);
  if(S.products.size&&S.canWrite){ const last=[...S.moves.values()].filter(m=>m.reason==="Stock count").map(m=>m.date).sort().pop();
    if(!last||daysBetween(last,today())>30) out.push(`<div class="notice warn"><p><b>Monthly stock count ${last?"is due":"not done yet"}.</b> ${last?`Last count was ${fmtDate(last)}.`:"Count your stock once a month to catch missing items."}</p><button class="btn sm" data-act="count" type="button">Start stock count</button></div>`); }
  if(downloads&&real){ const lb=Number(lsGet("lastBackup"))||0; const days=lb?Math.floor((Date.now()-lb)/864e5):null;
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
        await window.APP.request("POST","/api/moves/batch",{records});
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

/* ---------- icons, quick search, phone navigation ---------- */
const IC=(d,extra="")=>`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
const ICON={
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
const VIEW_L={overview:"Overview",orders:"Orders",collect:"Collections",dealers:"Dealers",products:"Products",activity:"Transactions",reports:"Reports",store:"Store"};
function renderBottomNav(){
  const nav=$("#bnav"); if(!nav) return;
  const main=window.APP?["overview","orders","collect","dealers"]:["overview","collect","dealers","products"];
  const nNew=[...S.orders.values()].filter(o=>o.status==="new").length;
  const inMore=!main.includes(S.view);
  nav.innerHTML=main.map(v=>`<button type="button" data-nav="${v}" aria-current="${S.view===v?"page":"false"}">${ICON[v]}<span>${VIEW_L[v]}</span>${v==="orders"&&nNew?`<b class="nbadge">${nNew}</b>`:""}</button>`).join("")+`<button type="button" data-nav="more" aria-current="${inMore?"page":"false"}">${ICON.more}<span>${inMore?VIEW_L[S.view]:"More"}</span></button>`;
  $("#fab").hidden=!S.canWrite;
}
function moreSheet(){
  const views=["overview",...(window.APP?["orders"]:[]),"collect","dealers","products","activity","reports","store"];
  show(()=>[head("Go to")+`<div class="go-grid">${views.map(v=>`<button type="button" class="go" data-go="${v}" aria-current="${S.view===v?"page":"false"}">${ICON[v]}<span>${VIEW_L[v]}</span></button>`).join("")}</div>`,sh=>{
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
function show(fn,live){ stack.push({fn,live:!!live}); paintSheet(); }
function back(){ stack.pop(); paintSheet(); }
function closeAll(){ stack.length=0; paintSheet(); }
const REDUCE=window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function paintSheet(refresh){
  const root=$("#sheetRoot"); const top=stack[stack.length-1]; let ov=$("#ov",root);
  if(!top){ if(ov&&!ov.classList.contains("closing")){ ov.classList.add("closing"); document.body.classList.remove("sheet-open"); setTimeout(()=>{ if(!stack.length) root.innerHTML=""; },REDUCE?0:180); } return; }
  if(refresh&&!top.live) return;
  const prev=ov&&$(".sheet",ov); const sc=refresh&&prev?prev.scrollTop:0;
  const [html,mount]=top.fn();
  if(!ov||ov.classList.contains("closing")){
    root.innerHTML=`<div class="overlay" id="ov"><div class="sheet" role="dialog" aria-modal="true"><div class="sheet-in">${html}</div></div></div>`;
    ov=$("#ov",root); ov.addEventListener("mousedown",e=>{ if(e.target.id==="ov") closeAll(); });
    document.body.classList.add("sheet-open");
  } else $(".sheet",ov).innerHTML=`<div class="sheet-in${refresh?"":" swap"}">${html}</div>`;
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
    <label class="f span">Full name<input id="d-name" required maxlength="120" value="${esc(d.name)}" placeholder="e.g. Juana Dela Cruz"></label>
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
      const name=$("#d-name").value.trim(); if(!name) return;
      const dup=[...S.dealers.entries()].find(([k,x])=>k!==id&&x.name.trim().toLowerCase()===name.toLowerCase());
      if(dup&&!btn.dataset.ok){ $("#d-err").textContent=`A dealer named “${dup[1].name}” already exists. Press the button again to save anyway.`; btn.dataset.ok="1"; return; }
      const lim=$("#d-limit").value.trim();
      const base=id?{...S.dealers.get(id)}:{createdAt:Date.now(),createdBy:S.me,active:true};
      const data={...base,name,phone:$("#d-phone").value.trim(),area:$("#d-area").value.trim(),creditLimit:lim===""?null:r2(lim),terms:Math.max(0,Math.round(Number($("#d-terms").value)||0)),discountPct:$("#d-pct").value===""?null:Math.min(100,Math.max(0,Number($("#d-pct").value))),notes:$("#d-notes").value.trim(),updated:stamp()};
      const prevLim=id?(S.dealers.get(id).creditLimit??null):undefined;
      if(prevLim!==data.creditLimit&&(data.creditLimit!=null||id)) data.limitHistory=[...(base.limitHistory||[]),{at:Date.now(),by:S.me,from:prevLim??null,to:data.creditLimit}].slice(-50);
      const ob=id?0:r2($("#d-ob").value), obDate=id?"":($("#d-obdate").value||today());
      guarded(btn,async()=>{ const ref=db.collection("dealers").doc(id||undefined); await ref.set(data);
        if(ob>0) await db.collection("txns").doc().set(openingDoc(ref.id,ob,obDate,addDays(obDate,data.terms),""));
        toast(id?"Dealer updated":ob>0?`Dealer added with ${P(ob)} opening balance`:"Dealer added"); back(); });
    });
    const del=$("#d-del",sh); if(del) del.addEventListener("click",()=>{ if(armed(del,"Tap again to delete")) guarded(del,async()=>{ await db.doc("dealers/"+id).delete(); toast("Dealer deleted"); closeAll(); }); });
    const ar=$("#d-arch",sh); if(ar) ar.addEventListener("click",()=>guarded(ar,async()=>{ const on=S.dealers.get(id).active===false; await db.doc("dealers/"+id).update({active:on,updated:stamp()}); toast(on?"Dealer restored":"Dealer archived. Their history is kept."); back(); }));
  }]; });
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
  const all=dealerTxns(id,true).map(([tid,t])=>{ if(isLive(t)) run=r2(run+(t.type==="sale"?t.amount:-t.amount)); return {tid,t,run}; }).reverse();
  resolveNames([d.createdBy]);
  return [head(esc(d.name)+samplePill(d)+(d.active===false?` <span class="pill neutral">Archived</span>`:""),[d.phone,d.area,d.terms!=null?`${d.terms}-day terms`:""].filter(Boolean).map(esc).join(" · "))+`
    <div class="stat-row">
      <div class="kpi"><div class="lbl">Balance</div><div class="val num">${P(st.balance)}</div></div>
      <div class="kpi ${st.overdue?"bad":""}"><div class="lbl">Overdue</div><div class="val num">${P(st.overdue)}</div></div>
      <div class="kpi"><div class="lbl">Credit limit</div><div class="val num">${d.creditLimit?P(d.creditLimit):"None"}</div>${d.creditLimit?`<div class="sub">${P(Math.max(0,d.creditLimit-st.balance))} available</div>`:""}</div>
    </div>
    ${st.maxLate>holdDays()?`<div class="notice bad"><p><b>On credit hold.</b> The oldest unpaid delivery is ${st.maxLate} days late. New credit sales are blocked until they pay${S.canAdmin?", unless you approve one":""}.</p></div>`:""}
    ${!d.creditLimit&&S.canWrite?`<div class="notice warn"><p>No credit limit set for this dealer. Set one so the app can warn you before risky releases.</p></div>`:""}
    ${S.canWrite?`<div class="actions" style="margin-bottom:16px"><button class="btn primary" data-act="sale-for" data-id="${id}" type="button">+ Credit sale</button><button class="btn" data-act="pay-for" data-id="${id}" type="button">+ Payment</button><button class="btn" data-act="ret-for" data-id="${id}" type="button">+ Return</button><button class="btn" data-act="remind-copy" data-id="${id}" type="button">Copy reminder</button><button class="btn" data-act="opening-for" data-id="${id}" type="button">+ Opening balance</button>${window.APP&&S.acct&&S.acct.role==="owner"?`<button class="btn" data-act="portal-for" data-id="${id}" type="button">Portal access</button>`:""}<button class="btn" data-act="edit-dealer" data-id="${id}" type="button">Edit dealer</button></div>`:""}
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
function productForm(id){
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
    ${mv.length?`<section class="panel" style="margin-top:16px"><h2>Recent stock changes</h2><table><tbody>${mv.map(m=>`<tr><td class="small nowrap">${fmtDate(m.date)}</td><td class="small">${esc(m.reason)}${m.note?" · "+esc(m.note):""}</td><td class="r num">${m.qty>0?"+":""}${m.qty}</td></tr>`).join("")}</tbody></table></section>`:""}`,sh=>{
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
  }]; });
}
function stockForm(pid){
  if(!S.products.size){ toast("Add a product first"); productForm(); return; }
  const moveRef=db.collection("moves").doc();
  show(()=>[head("Stock in / adjust","Record deliveries from your supplier or correct a count")+`<form id="f" class="form-grid">
    <label class="f span">Product<select id="m-p" required>${activeProducts().map(([id,p])=>`<option value="${id}" ${id===pid?"selected":""}>${esc(p.name)} (${p.stock} on hand)</option>`).join("")}</select></label>
    <div class="f span"><span>What happened</span><div class="seg" role="group" aria-label="Kind"><button type="button" data-k="in" aria-pressed="true">Received stock</button><button type="button" data-k="count" aria-pressed="false">Set counted stock</button><button type="button" data-k="out" aria-pressed="false">Damaged / lost</button></div></div>
    <label class="f" id="m-ql">Quantity received<input id="m-q" type="number" min="0" step="1" required value=""></label>
    <label class="f">Date<input id="m-date" type="date" required value="${today()}"></label>
    <label class="f span">Note<input id="m-note" placeholder="e.g. Delivery receipt no., supplier"></label>
    <p class="small span" id="m-info" style="margin:0"></p>
    <div class="actions span"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-back>Cancel</button></div></form>`,sh=>{
    let kind="in"; const lbl={in:"Quantity received",count:"Actual count on hand",out:"Quantity damaged or lost"};
    const info=()=>{ const p=S.products.get($("#m-p").value), q=Math.round(Number($("#m-q").value)||0); if(!p) return; const nw=kind==="in"?p.stock+q:kind==="out"?p.stock-q:q; $("#m-info").innerHTML=`On hand now <b>${p.stock}</b> → after saving <b>${nw}</b>`; };
    $$("[data-k]",sh).forEach(b=>b.addEventListener("click",()=>{ kind=b.dataset.k; $$("[data-k]",sh).forEach(x=>x.setAttribute("aria-pressed",x===b)); $("#m-ql").firstChild.textContent=lbl[kind]; info(); }));
    $("#m-p").addEventListener("change",info); $("#m-q").addEventListener("input",info); info();
    $("#f",sh).addEventListener("submit",e=>{ e.preventDefault(); const btn=e.submitter||$("button[type=submit]",sh);
      const id=$("#m-p").value, p=S.products.get(id), q=Math.round(Number($("#m-q").value)||0); if(!p) return;
      const delta=kind==="in"?q:kind==="out"?-q:q-p.stock; if(!delta){ toast("No change to save"); return; }
      guarded(btn,async()=>{ await moveRef.set({productId:id,qty:delta,expectedStock:kind==="count"?p.stock:undefined,reason:kind==="in"?"Received stock":kind==="out"?"Damaged / lost":"Stock count",date:$("#m-date").value,note:$("#m-note").value.trim()});
         toast("Stock updated"); back(); });
    });
  }]);
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
    refreshLines(); drawPick(); drawCart(); setDue();
    $("#f",sh).addEventListener("submit",e=>{ e.preventDefault(); const btn=e.submitter||$("button[type=submit]",sh);
      const did=$("#s-dealer").value; if(!did){ toast("Choose a dealer"); return; }
      if(!cart.length){ toast("Add at least one product"); $("#pick-q").focus(); return; }
      const T=calc(); if(T.total<=0){ toast("The total must be more than zero"); return; }
      if(isSale&&$("#s-due").value<$("#s-date").value){ toast("The due date can't be before the release date"); return; }
      const approved=S._hard&&S.acct?.role==="owner"&&$("#s-ovr")&&$("#s-ovr").checked;
      if(isSale&&!old&&S._hard&&!approved&&e.submitter?.id!=="s-request"){ toast(S.canAdmin?"This dealer is on credit hold. Tick “Release anyway” to approve.":"This dealer is on credit hold. Ask the owner to approve."); return; }
      const data={...(old||{}),type:kind,dealerId:did,date:$("#s-date").value,items:cart.map(i=>({productId:i.productId,name:i.name,qty:i.qty,price:i.price,pct:i.pct,...(i.promo?{promo:true}:{})})),subtotal:T.sub,discountPct:uniPct(),pctDiscount:T.pd,amount:T.total,note:$("#s-note").value.trim()};
      if(isSale){ data.dueDate=$("#s-due").value; data.discount=T.extra; } else data.restock=$("#s-restock").checked;
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
  }]; });
}
// Open deliveries for a dealer, optionally ignoring one payment (when editing it).
function openDeliveries(did,exceptId){
  const tx=dealerTxns(did).filter(([k])=>k!==exceptId).map(([k,t])=>[k,t]); let pool=0; const q=[]; const t0=today();
  tx.forEach(([k,t])=>{ if(t.type==="sale"){ let rem=t.amount; if(pool>0.004){ const ap=Math.min(pool,rem); pool=r2(pool-ap); rem=r2(rem-ap); } if(rem>0.004) q.push({id:k,t,rem}); }
    else { let c=t.amount; while(c>0.004&&q.length){ const o=q[0]; const ap=Math.min(c,o.rem); o.rem=r2(o.rem-ap); c=r2(c-ap); if(o.rem<=0.004) q.shift(); } pool=r2(pool+c); } });
  return {open:q.map(o=>({...o,paid:r2(o.t.amount-o.rem),late:o.t.dueDate&&o.t.dueDate<t0?daysBetween(o.t.dueDate,t0):0})),credit:pool};
}
function allocate(open,amount){ let c=r2(amount); const out=[]; for(const o of open){ if(c<=0.004) break; const ap=Math.min(c,o.rem); c=r2(c-ap); out.push({no:o.t.no||"",id:o.id,amount:r2(ap),left:r2(o.rem-ap),cleared:o.rem-ap<=0.004}); } return {lines:out,extra:c}; }
function paymentForm(dealerId,editId,preset){
  if(!activeDealers().length&&!editId){ toast("Add a dealer first"); dealerForm(); return; }
  const old=editId?S.txns.get(editId):null;
  const recordRef=db.collection("txns").doc(editId||undefined);
  show(()=>[head(editId?`Edit payment ${esc(old.no||"")}`:"Payment received","Full or partial. It's applied to the oldest unpaid delivery first.")+`<form id="f" class="form-grid">
    <label class="f span">Dealer<select id="y-dealer" required><option value="">Choose dealer…</option>${dealerOptions(old?old.dealerId:dealerId)}</select></label>
    <div class="span" id="y-quick"></div>
    <label class="f">Amount received (₱)<input id="y-amt" type="number" min="0.01" step="0.01" required inputmode="decimal" value="${old?old.amount:preset&&preset.amount?preset.amount:""}"></label>
    <label class="f">Date<input id="y-date" type="date" required value="${old?old.date:today()}"></label>
    <label class="f">Method<select id="y-method">${METHODS.map(m=>`<option ${old&&old.method===m?"selected":""}>${m}</option>`).join("")}</select></label>
    <label class="f">Reference no.<input id="y-ref" value="${esc(old?old.ref:"")}" placeholder="GCash / bank ref, check no."></label>
    <label class="f span">Note<input id="y-note" value="${esc(old?old.note:"")}"></label>
    <div class="span" id="y-alloc"></div>
    ${old?correctionField():""}<div class="actions span"><button class="btn primary" type="submit" id="y-go">${editId?"Save changes":"Record payment"}</button><button class="btn" type="button" data-back>Cancel</button></div></form>`,sh=>{
    let O={open:[],credit:0};
    const amt=()=>r2($("#y-amt").value);
    const quick=()=>{ const did=$("#y-dealer").value; if(!did){ $("#y-quick").innerHTML=""; $("#y-alloc").innerHTML=""; return; }
      O=openDeliveries(did,editId); const bal=r2(O.open.reduce((a,o)=>a+o.rem,0)-O.credit), over=r2(O.open.filter(o=>o.late).reduce((a,o)=>a+o.rem,0));
      const chips=[]; if(bal>0) chips.push(["Full balance",bal]); if(over>0&&over<bal) chips.push(["Overdue only",over]); if(O.open[0]&&O.open.length>1) chips.push([`Oldest ${O.open[0].t.no||"delivery"}`,O.open[0].rem]);
      $("#y-quick").innerHTML=`<div class="f"><span>${bal>0?`Owes <b class="num" style="color:var(--fg)">${P(bal)}</b>${over?` · <span style="color:var(--bad)">${P(over)} overdue</span>`:""}`:bal<0?`Has <b>${P(-bal)}</b> credit`:"Nothing owed right now"}</span>
        ${chips.length?`<div class="chips">${chips.map(([l,v])=>`<button type="button" class="chip" data-amt="${v}" aria-pressed="${amt()===v}">${l}<b class="num">${P(v)}</b></button>`).join("")}<span class="small muted" style="align-self:center">or type any partial amount below</span></div>`:""}</div>`;
      alloc(); };
    const alloc=()=>{ const a=amt(); $$(".chip",sh).forEach(c=>c.setAttribute("aria-pressed",String(Number(c.dataset.amt)===a)));
      if(!$("#y-dealer").value||!(a>0)){ $("#y-alloc").innerHTML=O.open.length?`<div class="alloc"><div class="alloc-h">Unpaid deliveries</div>${O.open.map(o=>`<div class="alloc-r"><span><b>${esc(o.t.no||"")}</b> <span class="muted small">due ${fmtDate(o.t.dueDate)}</span>${o.paid?` <span class="small muted">· ${P(o.paid)} paid</span>`:""}</span><span class="num">${P(o.rem)}</span></div>`).join("")}</div>`:""; return; }
      const R=allocate(O.open,a), bal=r2(O.open.reduce((x,o)=>x+o.rem,0)-O.credit), full=a>=bal-0.004&&bal>0;
      $("#y-alloc").innerHTML=`<div class="alloc"><div class="alloc-h">${full?`<span class="pill good">Full payment</span> Clears the whole balance`:bal>0?`<span class="pill warn">Partial payment</span> ${P(r2(bal-a))} will still be owed`:`<span class="pill neutral">Advance payment</span> Kept as credit for the next delivery`}</div>
        ${R.lines.map(l=>{ const o=O.open.find(x=>x.id===l.id); return `<div class="alloc-r"><span><b>${esc(l.no)}</b> <span class="muted small">due ${fmtDate(o.t.dueDate)}</span><br><span class="small ${l.cleared?"":"muted"}">${l.cleared?"✓ Fully paid":`${P(l.amount)} of ${P(o.rem)} · ${P(l.left)} left`}</span></span><span class="num">−${P(l.amount)}</span></div>`; }).join("")}
        ${R.extra>0.004?`<div class="alloc-r"><span>Extra kept as credit</span><span class="num">${P(R.extra)}</span></div>`:""}</div>`;
      $("#y-go").textContent=editId?"Save changes":`Record ${full?"full":bal>0?"partial":""} payment ${P(a)}`.replace("  "," "); };
    $("#y-dealer").addEventListener("change",quick); $("#y-amt").addEventListener("input",alloc);
    $("#y-quick").addEventListener("click",e=>{ const c=e.target.closest("[data-amt]"); if(c){ $("#y-amt").value=Number(c.dataset.amt).toFixed(2); alloc(); } });
    quick();
    $("#f",sh).addEventListener("submit",e=>{ e.preventDefault(); const btn=e.submitter||$("button[type=submit]",sh);
      const did=$("#y-dealer").value, amount=amt(); if(!did||amount<=0){ toast("Enter the dealer and amount"); return; }
      const O2=openDeliveries(did,editId), R=allocate(O2.open,amount), bal=r2(O2.open.reduce((x,o)=>x+o.rem,0)-O2.credit);
      const data={...(old||{}),type:"payment",dealerId:did,date:$("#y-date").value,amount,method:$("#y-method").value,ref:$("#y-ref").value.trim(),note:$("#y-note").value.trim(),
        payKind:amount>=bal-0.004&&bal>0?"full":bal>0?"partial":"advance",applied:R.lines.map(l=>({no:l.no,amount:l.amount,left:l.left})),balanceBefore:bal};
      if(!old){ data.no=nextNo("payment"); data.createdAt=Date.now(); data.createdBy=S.me; } else data.updated=stamp();
      if(old)data.correctionReason=$("#correction-reason",sh).value.trim();else{delete data.createdAt;delete data.createdBy;delete data.no;}
      guarded(btn,async()=>{ const ref=recordRef; const saved=await ref.set(data,{version:old?._version}); data.no=saved.data.no; toast(editId?"Payment updated":`${data.payKind==="full"?"Full":data.payKind==="partial"?"Partial":"Advance"} payment ${data.no} recorded`); if(editId) back(); else { stack.pop(); receiptSheet(ref.id); } });
    });
  }]);
}
function txSheet(id){
  show(()=>{ const t=S.txns.get(id); if(!t) return [head("Transaction not found")+`<p>This record was removed.</p>`];
  const d=S.dealers.get(t.dealerId); resolveNames([t.createdBy,t.updated&&t.updated.by,t.voidedBy,t.override&&t.override.by]);
  const items=t.items||[];
  return [head(`${TYPE_LABEL[t.type]} ${esc(t.no||"")}${t.voided?` <span class="pill bad">Voided</span>`:""}${samplePill(t)}`,esc(d?d.name:"(removed dealer)"))+`
    <dl class="kv">
      <dt>Date</dt><dd>${fmtDate(t.date)}</dd>
      ${t.type==="sale"?`<dt>Due</dt><dd>${fmtDate(t.dueDate)}</dd>`:""}
      ${t.type==="payment"?`<dt>Method</dt><dd>${esc(t.method)}</dd><dt>Reference</dt><dd>${esc(t.ref||"—")}</dd>`:""}
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
    ${canEditTx(t)?(t.voided?`<div class="actions"><button class="btn" id="t-unvoid" type="button">Restore this ${TYPE_LABEL[t.type].toLowerCase()}</button></div>`:
      `<div class="actions"><button class="btn primary" data-act="receipt" data-id="${esc(id)}" type="button">Receipt</button><button class="btn" id="t-edit" type="button">Edit</button><button class="btn" data-dealer="${t.dealerId}" type="button">Open dealer</button></div>
      <section class="panel" style="margin-top:16px"><h2>Void this record</h2><p class="small" style="margin-top:0">Voiding keeps the record for your history but removes it from balances and reports${t.type!=="payment"?", and reverses its stock change":""}.</p>
      <div class="actions"><input id="t-reason" placeholder="Reason, e.g. wrong dealer" style="flex:1;min-width:180px"><button class="btn danger" id="t-void" type="button">Void</button></div></section>`):(S.canWrite?`<div class="notice info"><p>${t.saleId?"This payment was recorded with a sale. Correct or void the linked sale to update both together.":"Only the owner or an editor can change this record. Staff can edit or void only what they recorded today."}</p><button class="btn sm" data-dealer="${t.dealerId}" type="button">Open dealer</button>${t.saleId?`<button class="btn sm" data-tx="${esc(t.saleId)}" type="button">Open linked sale</button>`:""}</div>`:"")}`,sh=>{
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
async function loadTeam(){ try{ S.acct=await window.APP.me(); S.team=await window.APP.users(); $("#acct").textContent=`${S.acct.name} · ${ROLE_L[S.acct.role]}`; render(); }catch(e){} }
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
  ${S.canAdmin?`<section class="panel"><div class="panel-head"><h2>Activity log</h2><button class="btn sm" data-act="load-audit" type="button">${S.audit?"Refresh":"Show recent activity"}</button></div>${S.audit?auditTable():`<p class="small muted" style="margin:0">Every sign-in, change and deletion is recorded with who did it and when.</p>`}</section>`:""}`;
}
function auditTable(){
  const lbl={create:"Added",update:"Changed",delete:"Deleted",restore:"Restored",stock:"Stock changed",login:"Signed in",upload:"Photo added",setup:"Created the ledger",password_change:"Changed password",user_create:"Added account",user_update:"Changed account"};
  const what=a=>{ let d={}; try{ d=JSON.parse(a.detail||"{}")||{}; }catch(e){}
    if(a.collection==="txns") return `${esc(d.no||"")} ${esc(TYPE_LABEL[d.type]||"")} ${d.amount?P(d.amount):""}${d.voided?" (voided)":""}`;
    if(a.collection==="dealers"||a.collection==="products") return esc(d.name||"");
    if(a.collection==="users") return esc(d.username||"");
    return ""; };
  return `<div class="tbl-wrap" style="max-height:420px;overflow:auto"><table><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>${S.audit.map(a=>`<tr><td class="small nowrap">${fmtStamp(a.at)}</td><td class="small">${esc(a.user_name||"—")}</td><td class="small">${esc(lbl[a.action]||a.action)} ${a.collection&&!["txns","users"].includes(a.collection)?`<span class="muted">${esc(a.collection)}</span> `:""}${what(a)}</td></tr>`).join("")}</tbody></table></div>`;
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
function goView(v){ S.view=v; S.q=""; S.catFilter=""; S.showArchived=false; closeAll(); try{ history.replaceState(null,"","#"+v); }catch(_){ location.hash=v; } render(); window.scrollTo(0,0); }
function copyText(txt,title){
  const fallback=()=>show(()=>[head(title)+`<pre class="stmt" id="ctxt">${esc(txt)}</pre><p class="small muted">Select the text above and copy it from your device menu.</p>`,sh=>{ const r=document.createRange(); r.selectNodeContents($("#ctxt",sh)); const s=getSelection(); s.removeAllRanges(); s.addRange(r); }]);
  try{ navigator.clipboard.writeText(txt).then(()=>toast("Message copied. Paste it in Messenger, Viber or SMS."),fallback); }catch(e){ fallback(); }
}
document.addEventListener("click",e=>{
  const tab=e.target.closest(".tab"); if(tab){ S.view=tab.dataset.view; S.q=""; S.catFilter=""; S.showArchived=false; try{ history.replaceState(null,"","#"+S.view); }catch(_){ location.hash=S.view; } render(); return; }
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
       "stock-in":()=>stockForm(), "stock-for":()=>stockForm(id), "clear-samples":()=>{ if(armed(a,"Tap again to remove")) clearSamples(a); },
       "backup":async()=>{ if(await save(`ledger-backup-${today()}.json`,JSON.stringify(await window.APP.backup(),null,1))){ lsSet("lastBackup",Date.now()); render(); } },
       "receipt":()=>receiptSheet(id),
       "go-orders":()=>goView("orders"),
       "catalog":()=>catalogSheet(),
       "pay-amt":()=>paymentForm(id,null,{amount:Number(a.dataset.amt).toFixed(2)}),
       "retry-load":()=>location.reload(), "reconcile":()=>reconciliationSheet(), "period-statement":()=>statementSheet(id), "transaction-history":()=>historySheet(id), "approval-decision":()=>approvalDecision(id), "approval-release":()=>releaseApproved(id,a), "new-user":()=>userForm(), "portal-for":()=>{ const ex=(S.team||[]).find(u=>u.role==="dealer"&&u.dealerId===id); userForm(ex?ex.id:null,ex?null:id); }, "edit-user":()=>userForm(id), "change-pw":()=>passwordForm(), "logout":()=>window.APP.logout(),
       "load-audit":()=>guarded(a,async()=>{ S.audit=await window.APP.audit(150); render(); }),
       "go-dealers":()=>goView("dealers"), "go-collect":()=>goView("collect"), "count":()=>countSheet(),
       "opening-for":()=>openingForm(id), "new-opening":()=>openingForm(),
       "remind-copy":()=>copyText(reminderText(id),"Reminder message"),
       "remind-mark":()=>guarded(a,async()=>{ const d=S.dealers.get(id); const on=d.lastReminded!==today(); await db.doc("dealers/"+id).update(on?{lastReminded:today(),lastRemindedBy:S.me}:{lastReminded:d.prevReminded||null}); if(on) await db.doc("dealers/"+id).update({prevReminded:d.lastReminded||null}); toast(on?`${d.name} marked as reminded`:"Reminder unmarked"); }),
       "export-tx":()=>save(`transactions-${today()}.csv`,csv([["Date","No.","Type","Status","Dealer","Items","Subtotal","Dealer discount %","Dealer discount","Extra discount","Amount","Due date","Method","Reference","Note"],...[...S.txns.values()].sort((x,y)=>(x.date||"").localeCompare(y.date||"")).map(t=>{ const d=S.dealers.get(t.dealerId); return [t.date,t.no||"",TYPE_LABEL[t.type],t.voided?"Voided":"OK",d?d.name:"",(t.items||[]).map(i=>`${i.name} x${i.qty} @ ${i.price}`).join("; "),t.subtotal??"",t.discountPct??"",t.pctDiscount||"",t.discount||"",t.type==="sale"?t.amount:-t.amount,t.dueDate||"",t.method||"",t.ref||"",t.note||""]; })])),
       "export-dealers":()=>save(`dealers-${today()}.csv`,csv([["Dealer","Mobile","Area","Credit limit","Terms (days)","Balance","Overdue","Days late","Last payment","Rating","Paid on time %","Avg days to pay","Worst delay (days)","Total credit taken","Total paid","Status"],...[...S.dealers.entries()].map(([id,d])=>{ const st=status(id), h=history(id); return [d.name,d.phone,d.area,d.creditLimit??"",d.terms??"",st.balance,st.overdue,st.maxLate,st.lastPay||"",h.grade.g,h.n?Math.round(h.onTime/h.n*100):"",h.avgDays??"",h.worst,h.taken,h.paid,d.active===false?"Archived":"Active"]; })])),
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
  if(e.target.closest("#btnSearch")){ searchSheet(); return; }
});
let scr=false; window.addEventListener("scroll",()=>{ const v=window.scrollY>4; if(v!==scr){ scr=v; document.body.classList.toggle("scrolled",v); } },{passive:true});
let qTimer; document.addEventListener("input",e=>{ if(e.target.id==="q"){ S.q=e.target.value; clearTimeout(qTimer); qTimer=setTimeout(render,120); } });
document.addEventListener("change",e=>{
  const id=e.target.id;
  if(id==="txFilter"){ S.txFilter=e.target.value; render(); }
  else if(id==="catFilter"){ S.catFilter=e.target.value; render(); }
  else if(id==="showArch"){ S.showArchived=e.target.checked; render(); }
  else if(id==="rFrom"||id==="rTo"){ S.range[id==="rFrom"?"from":"to"]=e.target.value; render(); }
  else if(id==="restoreFile"&&e.target.files[0]) restoreFlow(e.target.files[0]);
});
document.addEventListener("submit",e=>{
  if(e.target.id!=="storeForm") return; e.preventDefault(); const btn=e.submitter||$("button[type=submit]",e.target);
  const data={storeName:$("#st-name").value.trim(),phone:$("#st-phone").value.trim(),address:$("#st-addr").value.trim(),paymentInfo:$("#st-pay").value.trim(),defaultTerms:Math.max(0,Math.round(Number($("#st-terms").value)||0)),footer:$("#st-foot").value.trim(),defaultLimit:$("#st-limit").value===""?null:r2($("#st-limit").value),holdDays:Math.max(1,Math.round(Number($("#st-hold").value)||60)),blockOverLimit:$("#st-block").checked,reminderTemplate:$("#st-msg").value.trim(),discountPct:Math.min(100,Math.max(0,Number($("#st-pct").value)||0)),updated:stamp()};
  guarded(btn,async()=>{ await db.doc("settings/store").set(data); toast("Store details saved"); btn.disabled=false; });
});
const VIEWS=["overview","orders","collect","dealers","products","activity","reports","store"];
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
  COLS.forEach(c=>db.collection(c).onSnapshot(snap=>{ const m=new Map(); snap.docs.forEach(d=>m.set(d.id,(norm[c]||(x=>x))(d.data())));
    if(c==="orders"&&S.loaded.orders) m.forEach((o,k)=>{ if(!S.orders.has(k)&&o.status==="new"){ const d=S.dealers.get(o.dealerId); toast(`New online order ${o.no||""} from ${d?d.name:"a dealer"}`); } }); S[c]=m; S.loaded[c]=true; S._ver++; done(snap.metadata,c); schedule(); },e=>onErr(e,c)));
  db.doc("settings/store").onSnapshot(snap=>{ S.settings=snap.exists?{...snap.data()}:{}; S.loaded.settings=true; S._ver++; done(snap.metadata,"settings"); schedule(); },e=>onErr(e,"settings"));
})();
})();
