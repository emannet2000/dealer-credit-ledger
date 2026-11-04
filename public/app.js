(() => {
"use strict";
/* ================= state ================= */
const S = {
  dealers:new Map(), products:new Map(), txns:new Map(), moves:new Map(), orders:new Map(), interactions:new Map(), approvals:new Map(), cashcloses:new Map(), remittances:new Map(), reminders:new Map(), proofs:new Map(), suppliers:new Map(), purchases:new Map(), expenses:new Map(), locations:new Map(), signoffs:new Map(), settings:{},
  loaded:{dealers:false,products:false,txns:false,moves:false,orders:false,interactions:false,approvals:false,cashcloses:false,remittances:false,reminders:false,proofs:false,suppliers:false,purchases:false,expenses:false,locations:false,signoffs:false,settings:false},
  canWrite:true, canAdmin:false, me:null, names:{},
  view:"overview", q:"", txFilter:"all", showArchived:false, catFilter:"", stageF:"all", tagF:"",
  range:{preset:"month",from:"",to:""}
};
let db=null, downloads=null, assets=null, userNs=null;
const COLS=["dealers","products","txns","moves","orders","interactions","approvals","cashcloses","remittances","reminders","proofs","suppliers","purchases","expenses","locations","signoffs"];

/* ================= helpers ================= */
const $=(s,el=document)=>el.querySelector(s);
const $$=(s,el=document)=>[...el.querySelectorAll(s)];
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const peso=new Intl.NumberFormat("en-PH",{style:"currency",currency:"PHP"});
const P=n=>peso.format(Number(n)||0);
const r2=Credit.r2;
const pad=n=>String(n).padStart(2,"0");
const ymd=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const today=()=>ymd(new Date());
const addDays=(s,n)=>{const d=new Date(s+"T00:00:00");d.setDate(d.getDate()+Number(n||0));return ymd(d);};
// Day numbers are cached: parsing dates was a large part of drawing big lists (PR-09).
const DAY_NUM=new Map();
const dayNum=s=>{ let v=DAY_NUM.get(s); if(v===undefined){ const [y,m,d]=String(s).slice(0,10).split("-").map(Number); v=Math.round(Date.UTC(y,m-1,d)/864e5); if(DAY_NUM.size>20000) DAY_NUM.clear(); DAY_NUM.set(s,v); } return v; };
const daysBetween=(a,b)=>dayNum(b)-dayNum(a);
// Formatters are created once and dates cached: building them per call was the
// biggest cost of drawing large lists (PR-09).
const DATE_FMT=new Intl.DateTimeFormat("en-PH",{month:"short",day:"numeric",year:"numeric"}), STAMP_FMT=new Intl.DateTimeFormat("en-PH",{month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"}), MONTH_FMT=new Intl.DateTimeFormat("en-PH",{month:"short",year:"numeric"});
const DATE_CACHE=new Map();
const fmtDate=s=>{ if(!s) return "—"; let v=DATE_CACHE.get(s); if(v===undefined){ v=DATE_FMT.format(new Date(s+"T00:00:00")); if(DATE_CACHE.size>5000) DATE_CACHE.clear(); DATE_CACHE.set(s,v); } return v; };
const fmtStamp=ms=>ms>1e9?STAMP_FMT.format(new Date(ms)):"";
const METHODS=["Cash","GCash","Maya","Bank transfer","Check","Other"];
const TYPE_LABEL={sale:"Credit sale",payment:"Payment",return:"Return",adjustment:"Adjustment",writeoff:"Write-off"};
const PREFIX={sale:"DR",payment:"OR",return:"RT",adjustment:"ADJ",writeoff:"WO"};
const isLive=t=>Credit.counts(t);
// A debit adjustment is a charge. Everything else reduces the balance.
const isCharge=Credit.isCharge;
const txnEffect=Credit.txnEffect;
const allowNegativeStock=()=>S.settings.allowNegativeStock===true;
const storeName=()=>S.settings.storeName||"Dealer Credit Ledger";
const holdDays=()=>Number(S.settings.holdDays??60)||60;
const blockOverLimit=()=>S.settings.blockOverLimit!==false;
const lsGet=k=>{ try{ return localStorage.getItem("dcl:"+k); }catch(e){ return null; } };
const lsSet=(k,v)=>{ try{ localStorage.setItem("dcl:"+k,String(v)); }catch(e){} };
const canEditTx=t=>S.canAdmin||(S.canWrite&&!!S.me&&t.createdBy===S.me&&t.createdAt>1e9&&ymd(new Date(t.createdAt))===today());
const DEFAULT_MSG="Hi {name}, magandang araw po! Paalala lang po mula sa {store}: ang balance ninyo ay {balance}, {status}. {payinfo}Salamat po!";
// Starting text for the privacy notice (FR-078). The owner should adapt it with their adviser.
const DEFAULT_PRIVACY="We collect your name, mobile number, address and the record of your purchases and payments so we can sell to you on credit, collect payments and keep our books. If you choose to give them, we also keep your birthday (to confirm who you are and to greet you) and gender (so we address you correctly). Only our staff can see it. We keep your records for as long as the law requires, then remove your personal details. You can ask us for a copy of your data, or to correct or remove it, by contacting the store. We follow the Data Privacy Act of 2012 (RA 10173).";
const CONSENT_L={"signed form":"Signed form","verbal":"Told us verbally","portal":"Accepted in the dealer portal"};
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
// PR-09: transactions grouped by dealer once per data change, instead of scanning all of them per dealer.
const TX_INDEX={key:null,map:new Map()};
function dealerTxns(id,incVoid){
  if(TX_INDEX.key!==S._ver||TX_INDEX.src!==S.txns){ const m=new Map(); for(const e of S.txns.entries()){ let a=m.get(e[1].dealerId); if(!a) m.set(e[1].dealerId,a=[]); a.push(e); }
    m.forEach(a=>a.sort((a,b)=>(a[1].date||"").localeCompare(b[1].date||"")||(a[1].createdAt||0)-(b[1].createdAt||0))); TX_INDEX.key=S._ver; TX_INDEX.src=S.txns; TX_INDEX.map=m; }
  const a=TX_INDEX.map.get(id)||[]; return incVoid?a.slice():a.filter(([,t])=>isLive(t)); }
// Settles a dealer's live transactions ([[id,t],…] in date order) with the shared rules in /credit.js.
const settle=Credit.settleEntries;
function dealerStatus(id){
  const all=dealerTxns(id), tx=all.map(([,t])=>t), t0=today();
  const open=settle(all).open.map(o=>({...o.t,_id:o.id,remaining:o.rem,late:o.t.dueDate&&o.t.dueDate<t0?daysBetween(o.t.dueDate,t0):0}));
  const balance=r2(tx.reduce((a,t)=>a+txnEffect(t),0));
  return { balance, overdue:r2(open.filter(o=>o.late>0).reduce((a,o)=>a+o.remaining,0)), maxLate:open.reduce((m,o)=>Math.max(m,o.late),0), open,
    nextDue:open.filter(o=>!o.late&&o.dueDate).map(o=>o.dueDate).sort()[0]||null,
    lastPay:tx.filter(t=>t.type==="payment").map(t=>t.date).sort().pop()||null };
}
const MONTHS_CACHE={day:null,list:null};
function lastSixMonths(){ const t0=today(); if(MONTHS_CACHE.day!==t0){ const d0=new Date(), out=[]; for(let i=5;i>=0;i--){ const dt=new Date(d0.getFullYear(),d0.getMonth()-i,1); out.push({ym:ymd(dt).slice(0,7),label:MONTH_FMT.format(dt)}); } MONTHS_CACHE.day=t0; MONTHS_CACHE.list=out; } return MONTHS_CACHE.list; }
// Credit history: when each delivery was fully paid (FIFO), on-time rate and a simple rating.
function creditHistory(id){
  const all=dealerTxns(id), tx=all.map(([,t])=>t), t0=today(); const R=settle(all), queue=R.open, settled=R.settled;
  const rows=[...settled.map(s=>({id:s.id,t:s.t,paid:s.paid,late:s.t.dueDate?Math.max(0,daysBetween(s.t.dueDate,s.paid)):0,days:daysBetween(s.t.date,s.paid)})),
    ...queue.map(q=>({id:q.id,t:q.t,paid:null,rem:q.rem,late:q.t.dueDate&&q.t.dueDate<t0?daysBetween(q.t.dueDate,t0):0}))].sort((a,b)=>(b.t.date||"").localeCompare(a.t.date||""));
  const n=settled.length, done=rows.filter(r=>r.paid), onTime=done.filter(r=>r.late===0).length;
  const avgDays=n?Math.round(done.reduce((a,r)=>a+r.days,0)/n):null, avgLate=n?done.reduce((a,r)=>a+r.late,0)/n:0;
  const worst=rows.reduce((m,r)=>Math.max(m,r.late),0), openLate=rows.filter(r=>!r.paid).reduce((m,r)=>Math.max(m,r.late),0);
  const sum=k=>r2(tx.filter(t=>t.type===k).reduce((a,t)=>a+t.amount,0));
  const sumCharges=r2(tx.filter(isCharge).reduce((a,t)=>a+t.amount,0));
  let score=100; if(n) score-=(1-onTime/n)*40; score-=Math.min(30,avgLate); if(openLate>30) score-=25; if(openLate>holdDays()) score-=40; else if(openLate>0) score-=10;
  const bounced=dealerTxns(id,true).filter(([,t])=>t.check&&t.check.status==="bounced").length; score-=Math.min(40,bounced*15); // FR-072
  const grade=n<2&&!openLate?{g:"New",label:"Not enough history yet",cls:"neutral"}:score>=85?{g:"A",label:"Excellent payer",cls:"good"}:score>=70?{g:"B",label:"Good payer",cls:"good"}:score>=50?{g:"C",label:"Pays late often",cls:"warn"}:{g:"D",label:"High risk",cls:"bad"};
  const months=lastSixMonths().map(m=>({label:m.label,ym:m.ym,taken:0,paid:0,ret:0})), byYm=new Map(months.map(m=>[m.ym,m]));
  for(const t of tx){ const m=byYm.get((t.date||"").slice(0,7)); if(!m) continue; if(isCharge(t)) m.taken=r2(m.taken+t.amount); else if(t.type==="payment") m.paid=r2(m.paid+t.amount); else if(t.type==="return") m.ret=r2(m.ret+t.amount); }
  return {rows,n,onTime,avgDays,worst,grade,bounced,score:Math.round(score),taken:sumCharges,paid:sum("payment"),returned:sum("return"),writeoff:sum("writeoff"),since:tx.length?tx[0].date:null,months};
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
const OPEN_ORDER=["new","preparing","ready"];
function reservedQty(exceptOrderId){
  const out={};
  S.orders.forEach((o,id)=>{ if(id===exceptOrderId||!OPEN_ORDER.includes(o.status)) return;
    (o.items||[]).forEach(i=>out[i.productId]=(out[i.productId]||0)+(Number(i.qty)||0)); });
  return out;
}
function availableStock(productId,exceptOrderId){ const p=S.products.get(productId); return (Number(p&&p.stock)||0)-(reservedQty(exceptOrderId)[productId]||0); }
function diffEffect(oldT,newT){ const a=stockEffect(oldT), b=stockEffect(newT), m={}; new Set([...Object.keys(a),...Object.keys(b)]).forEach(k=>{const d=(b[k]||0)-(a[k]||0); if(d) m[k]=d;}); return m; }
async function applyStock(delta){
  if(db.adjustStock){ const d=Object.fromEntries(Object.entries(delta).filter(([,v])=>v)); if(Object.keys(d).length) await db.adjustStock(d); return; }
  for(const [pid,d] of Object.entries(delta)){ const p=S.products.get(pid); if(!p) continue; await db.doc("products/"+pid).update({stock:(Number(p.stock)||0)+d}); }
}
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
/* ---------- QR codes and deep links ---------- */
function appOrigin(){ try{ return location.origin&&location.origin!=="null"?location.origin:location.protocol+"//"+location.host; }catch(e){ return ""; } }
const deepLink=(kind,id)=>`${appOrigin()}/#${kind}${id?"/"+encodeURIComponent(id):""}`;
const qrUrl=(text,size)=>`/api/qr?data=${encodeURIComponent(String(text))}&size=${Math.max(96,Math.min(600,Math.round(Number(size)||240)))}`;
const qrReady=()=>!!window.APP&&(typeof navigator==="undefined"||navigator.onLine!==false);
function qrBlock(text,title,sub,cls=""){
  if(!qrReady()) return "";
  return `<div class="qr-block${cls?" "+cls:""}"><img class="qr-img" src="${esc(qrUrl(text,190))}" alt="${esc(title)} QR code" width="190" height="190"><div class="qr-text"><b>${esc(title)}</b>${sub?`<div class="small">${esc(sub)}</div>`:""}<div class="qr-link">${esc(String(text).replace(/^https?:\/\//,""))}</div><div class="small muted">Scan with a phone camera to open it in this ledger.</div></div></div>`;
}
function qrSheet({title,sub,text,line,detail}){
  const label=line||title;
  show(()=>[`<div class="no-print">${head(title,sub)}<div class="actions" style="margin-bottom:14px"><button class="btn primary" type="button" id="qr-print">Print label</button>${downloads?`<button class="btn" type="button" id="qr-dl">Download PNG</button>`:""}<button class="btn" type="button" id="qr-copy">Copy link</button></div></div>
    <article class="receipt qr-label">
      ${storeHead("QR CODE",[esc(title)])}
      <div class="qr-big"><img src="${esc(qrUrl(text,420))}" alt="${esc(label)} QR code" width="420" height="420"></div>
      <h2 class="qr-name">${esc(label)}</h2>
      ${detail?`<div class="qr-detail">${detail}</div>`:""}
      <p class="small qr-scan">Scan with a phone camera to open this in the ledger.</p>
      <p class="qr-url small">${esc(text)}</p>
    </article>`,sh=>{
    $("#qr-print",sh).addEventListener("click",()=>window.print());
    $("#qr-copy",sh).addEventListener("click",()=>copyText(text,title));
    const dl=$("#qr-dl",sh); if(dl) dl.addEventListener("click",()=>guarded(dl,async()=>{
      const r=await fetch(qrUrl(text,600),{credentials:"same-origin"});
      if(!r.ok) throw new Error("qr_download_failed");
      await save(`${String(label).replace(/[^\w.-]+/g,"_").slice(0,60)||"qr-code"}-qr.png`,await r.blob());
      dl.disabled=false;
    }));
  }],true);
}
function dealerQr(id){
  const d=S.dealers.get(id); if(!d) return toast("That dealer isn't in this ledger.","error");
  const st=status(id);
  qrSheet({title:"Dealer QR code",sub:d.name,line:d.name,text:deepLink("dealer",id),
    detail:[d.phone?esc(d.phone):"",d.area?esc(d.area):"",`Balance ${P(st.balance)}`].filter(Boolean).join(" · ")});
}
function productQr(id){
  const p=S.products.get(id); if(!p) return toast("That product isn't in this ledger.","error");
  qrSheet({title:"Product QR code",sub:p.name,line:p.name,text:deepLink("product",id),
    detail:[p.code?`Code ${esc(p.code)}`:"",p.category?esc(p.category):"",P(p.dealerPrice)].filter(Boolean).join(" · ")});
}
const activeDealers=()=>[...S.dealers.entries()].filter(([,d])=>d.active!==false&&stageOf(d)!=="lost").sort((a,b)=>a[1].name.localeCompare(b[1].name));
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

/* ================= owner dashboard ================= */
// Monthly targets live in settings.targets: { "2026-11": { sales, collections } } (part of FR-082).
// The target for a period is the sum of its months' targets, prorated by days for partial months.
function periodTarget(kind,from,to){
  const T=S.settings.targets||{}; let sum=0, covered=0, total=0;
  const start=from<"2000-01-01"?null:from, end=to>"2999-12-31"?null:to; if(!start||!end) return null;
  let d=new Date(start.slice(0,7)+"-01T00:00:00");
  while(ymd(d).slice(0,7)<=end.slice(0,7)){
    const ym=ymd(d).slice(0,7), t=T[ym]&&Number(T[ym][kind]);
    const mStart=ymd(d), mEnd=ymd(new Date(d.getFullYear(),d.getMonth()+1,0)), days=daysBetween(mStart,mEnd)+1;
    const a=start>mStart?start:mStart, b=end<mEnd?end:mEnd, part=Math.max(0,daysBetween(a,b)+1);
    if(part>0){ total++; if(t>0){ covered++; sum+=t*part/days; } }
    d=new Date(d.getFullYear(),d.getMonth()+1,1);
  }
  // Compare with a target only when every month in the period has one.
  return covered?{sum:r2(sum),covered,total,full:covered===total}:null;
}
function dashData(){
  const [from,to]=rangeDates(), live=[...S.txns.entries()].filter(([,t])=>isLive(t)&&t.date>=from&&t.date<=to);
  let sales=0, coll=0, ret=0; const byStaff=new Map(), activeD=new Set();
  for(const [,t] of live){
    if(t.type==="sale"&&!t.opening){ sales+=t.amount; activeD.add(t.dealerId); }
    else if(t.type==="return") ret+=t.amount;
    else if(t.type==="payment"){ coll+=t.amount; const k=t.createdBy||"?"; const g=byStaff.get(k)||{amount:0,count:0,dealers:new Set(),offline:0}; g.amount+=t.amount; g.count++; g.dealers.add(t.dealerId); if(t.offline) g.offline++; byStaff.set(k,g); }
  }
  // Buckets for the chart: days for a month or less, weeks up to a quarter, months beyond.
  const span=from<"2000-01-01"?400:daysBetween(from,to)+1, unit=span<=31?"day":span<=92?"week":"month";
  const first=from<"2000-01-01"?(live.map(([,t])=>t.date).sort()[0]||today()):from, last=to>today()?today():to;
  const key=s=>unit==="day"?s:unit==="month"?s.slice(0,7):addDays(first,Math.floor(daysBetween(first,s)/7)*7);
  const buckets=new Map(); let c=first;
  while(c<=last&&buckets.size<400){ const k=key(c); if(!buckets.has(k)) buckets.set(k,{k,sales:0,coll:0}); c=unit==="month"?ymd(new Date(new Date(c+"T00:00:00").getFullYear(),new Date(c+"T00:00:00").getMonth()+1,1)):addDays(c,unit==="week"?7:1); }
  for(const [,t] of live){ const b=buckets.get(key(t.date)); if(!b) continue; if(t.type==="sale"&&!t.opening) b.sales+=t.amount; else if(t.type==="payment") b.coll+=t.amount; }
  const label=k=>unit==="month"?MONTH_FMT.format(new Date(k+"-01T00:00:00")):fmtDate(k).replace(/, \d{4}$/,"");
  const series=[...buckets.values()].map(b=>({...b,sales:r2(b.sales),coll:r2(b.coll),label:label(b.k),long:unit==="week"?`Week of ${fmtDate(b.k)}`:unit==="month"?label(b.k):fmtDate(b.k)}));
  let receivable=0, overdue=0; S.dealers.forEach((d,id)=>{ const st=status(id); if(st.balance>0) receivable+=st.balance; overdue+=st.overdue; });
  const cut=addDays(today(),-60), inactive=[];
  S.dealers.forEach((d,id)=>{ if(d.active===false||stageOf(d)!=="dealer") return; const tx=dealerTxns(id); if(!tx.length) return;
    const lastSale=tx.filter(([,t])=>t.type==="sale"&&!t.opening).map(([,t])=>t.date).pop()||null; if(lastSale&&lastSale<cut) inactive.push({id,d,lastSale,balance:status(id).balance}); });
  inactive.sort((a,b)=>(a.lastSale||"").localeCompare(b.lastSale||""));
  const staff=[...byStaff].map(([id,g])=>({id,name:staffName(id),...g,amount:r2(g.amount),dealers:g.dealers.size})).sort((a,b)=>b.amount-a.amount);
  return {from,to,unit,sales:r2(sales),coll:r2(coll),ret:r2(ret),activeDealers:activeD.size,series,staff,receivable:r2(receivable),overdue:r2(overdue),inactive,
    salesTarget:periodTarget("sales",from,to),collTarget:periodTarget("collections",from,to)};
}
const staffName=id=>{ const u=(S.team||[]).find(x=>x.id===id); return u?u.name:id==="?"?"Unknown":nameOf(id); };
function targetTile(label,actual,target,sub){
  if(target&&!target.full) return `<div class="kpi"><div class="lbl">${label}</div><div class="val num">${P(actual)}</div><div class="sub">Targets set for ${target.covered} of ${target.total} months in this period</div></div>`;
  const pct=target?Math.round(actual/target.sum*100):null;
  return `<div class="kpi"><div class="lbl">${label}</div><div class="val num">${P(actual)}</div>
    ${target?`<div class="meter" role="img" aria-label="${pct}% of target"><i style="width:${Math.min(100,pct)}%;background:var(--accent)"></i></div><div class="sub">${pct}% of ${P(target.sum)} target${pct>=100?" · reached":""}</div>`:`<div class="sub">${sub}</div>`}</div>`;
}
function barsChart(id,series,title){
  const max=niceMax(Math.max(1,...series.map(m=>Math.max(m.sales,m.coll)))), n=Math.max(1,series.length);
  const W=720,H=240,L=52,R=8,T=12,B=28, iw=W-L-R, ih=H-T-B, gw=iw/n, bw=Math.max(2,Math.min(18,(gw-6)/2-1));
  const y=v=>T+ih-(v/max)*ih;
  const bar=(x,v,cls)=>{ if(v<=0) return ""; const h=Math.max(2,(v/max)*ih), r=Math.min(4,h/2,bw/2), yy=T+ih-h;
    return `<path class="${cls}" d="M${x},${T+ih} V${yy+r} Q${x},${yy} ${x+r},${yy} H${x+bw-r} Q${x+bw},${yy} ${x+bw},${yy+r} V${T+ih} Z"/>`; };
  const every=Math.ceil(n/12);
  return `<div class="trend" id="${id}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}" class="trend-svg">
    ${[0,.25,.5,.75,1].map(f=>f*max).map(v=>`<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" class="grid${v===0?" base":""}"/><text x="${L-8}" y="${y(v)+4}" text-anchor="end" class="ax">${compactP(v)}</text>`).join("")}
    ${series.map((m,k)=>{ const x0=L+k*gw+(gw-(2*bw+2))/2; return `<g>${bar(x0,m.sales,"s1")}${bar(x0+bw+2,m.coll,"s2")}${k%every===0?`<text x="${L+k*gw+gw/2}" y="${H-8}" text-anchor="middle" class="ax">${esc(m.label)}</text>`:""}<rect x="${L+k*gw}" y="${T}" width="${gw}" height="${ih}" class="hit" data-m="${k}"/></g>`; }).join("")}
  </svg><div class="tip" hidden></div></div>`;
}
function mountBars(id,series){
  const box=document.getElementById(id); if(!box) return; const tip=$(".tip",box);
  const showTip=el=>{ const m=series[el.dataset.m], br=box.getBoundingClientRect(), r=el.getBoundingClientRect();
    tip.innerHTML=`<b>${esc(m.long)}</b><div><i class="sw s1"></i>Credit sales <span class="num">${P(m.sales)}</span></div><div><i class="sw s2"></i>Collections <span class="num">${P(m.coll)}</span></div>`;
    tip.hidden=false; const x=r.left-br.left+r.width/2; tip.style.left=Math.min(Math.max(8,x-tip.offsetWidth/2),br.width-tip.offsetWidth-8)+"px"; tip.style.top="4px";
    $$(".hit",box).forEach(h=>h.classList.toggle("on",h===el)); };
  $$(".hit",box).forEach(h=>{ h.addEventListener("mouseenter",()=>showTip(h)); h.addEventListener("click",()=>showTip(h)); });
  box.addEventListener("mouseleave",()=>{ tip.hidden=true; $$(".hit",box).forEach(h=>h.classList.remove("on")); });
}
function vDash(){
  if(!S.canAdmin) return `<section class="panel"><div class="empty"><p>The dashboard is for the owner and editors.</p></div></section>`;
  const D=dashData(), pr=[["month","This month"],["last","Last month"],["year","This year"],["custom","Custom"]], maxStaff=Math.max(1,...D.staff.map(s=>s.amount));
  const unitL={day:"day",week:"week",month:"month"}[D.unit];
  return `<section class="panel" style="margin-bottom:20px">
    <div class="panel-head"><h2>Dashboard</h2><div class="actions"><button class="btn sm" data-act="set-targets" type="button">Set targets</button><button class="btn sm primary" data-act="owner-summary" type="button">Print owner summary</button></div></div>
    <div class="toolbar"><div class="seg" role="group" aria-label="Period">${pr.map(([v,l])=>`<button type="button" data-preset="${v}" aria-pressed="${S.range.preset===v}">${l}</button>`).join("")}</div>
    ${S.range.preset==="custom"?`<input type="date" id="rFrom" value="${esc(S.range.from)}" aria-label="From"><span class="muted">to</span><input type="date" id="rTo" value="${esc(S.range.to)}" aria-label="To">`:`<span class="small muted">${fmtDate(D.from)} – ${fmtDate(D.to)}</span>`}</div>
  </section>
  <div class="kpis">
    ${targetTile("Credit sales",D.sales,D.salesTarget,`${D.activeDealers} dealer${D.activeDealers===1?"":"s"} bought · no target set`)}
    ${targetTile("Collections",D.coll,D.collTarget,"No target set")}
    <div class="kpi"><div class="lbl">Receivables now</div><div class="val num">${P(D.receivable)}</div><div class="sub">${D.overdue?`<span style="color:var(--bad)">${P(D.overdue)} overdue</span>`:"Nothing overdue"}</div></div>
    <div class="kpi ${D.inactive.length?"warn":""}"><div class="lbl">Inactive dealers</div><div class="val num">${D.inactive.length}</div><div class="sub">Bought before, but not in 60 days</div></div>
  </div>
  <section class="panel" style="margin-bottom:20px">
    <div class="panel-head"><h2>Credit sales and collections by ${unitL}</h2><div class="legend-row"><span><i class="sw s1"></i>Credit sales <b class="num">${P(D.sales)}</b></span><span><i class="sw s2"></i>Collections <b class="num">${P(D.coll)}</b></span></div></div>
    ${barsChart("dashChart",D.series,`Credit sales and collections by ${unitL}, ${fmtDate(D.from)} to ${fmtDate(D.to)}`)}
    <details class="small" style="margin-top:8px"><summary>Show as table</summary><div class="tbl-wrap"><table><thead><tr><th>${unitL[0].toUpperCase()+unitL.slice(1)}</th><th class="r">Credit sales</th><th class="r">Collections</th></tr></thead><tbody>${D.series.map(m=>`<tr><td>${esc(m.long)}</td><td class="r num">${P(m.sales)}</td><td class="r num">${P(m.coll)}</td></tr>`).join("")}</tbody></table></div></details>
  </section>
  <div class="grid2e">
    <section class="panel"><div class="panel-head"><h2>Collections by staff member</h2><span class="small muted">Who recorded each payment</span></div>
      ${D.staff.length?`<div class="tbl-wrap"><table><thead><tr><th>Staff member</th><th class="r">Payments</th><th class="r">Dealers</th><th>Collected</th></tr></thead><tbody>
      ${D.staff.map(s=>`<tr><td><b>${esc(s.name)}</b>${s.offline?`<div class="small muted">${s.offline} recorded offline</div>`:""}</td><td class="r num">${s.count}</td><td class="r num">${s.dealers}</td>
        <td class="num" style="min-width:160px"><div class="meter" style="max-width:180px"><i style="width:${s.amount/maxStaff*100}%;background:var(--accent)"></i></div>${P(s.amount)} <span class="small muted">· ${D.coll?Math.round(s.amount/D.coll*100):0}%</span></td></tr>`).join("")}
      </tbody></table></div>`:`<p class="small muted" style="margin:0">No payments in this period.</p>`}</section>
    <section class="panel"><div class="panel-head"><h2>Inactive dealers</h2><span class="small muted">Oldest last sale first</span></div>
      ${D.inactive.length?`<div class="tbl-wrap"><table><thead><tr><th>Dealer</th><th>Last credit sale</th><th class="r">Balance</th></tr></thead><tbody>${D.inactive.slice(0,10).map(r=>`<tr class="click" tabindex="0" data-dealer="${r.id}"><td><div class="prod-cell">${avatar(r.d,28)}<b>${esc(r.d.name)}</b></div></td><td class="small nowrap">${r.lastSale?`${fmtDate(r.lastSale)} · ${daysBetween(r.lastSale,today())} days ago`:"Never"}</td><td class="r num">${P(r.balance)}</td></tr>`).join("")}</tbody></table></div>${D.inactive.length>10?`<p class="small muted">And ${D.inactive.length-10} more.</p>`:""}`:`<p class="small muted" style="margin:0">Every dealer has bought on credit in the last 60 days.</p>`}</section>
  </div>`;
}
function targetsSheet(){
  const t0=today(), months=[]; const d0=new Date(); for(let i=-2;i<=3;i++){ const d=new Date(d0.getFullYear(),d0.getMonth()+i,1); months.push({ym:ymd(d).slice(0,7),label:MONTH_FMT.format(d)}); }
  show(()=>{ const T=S.settings.targets||{};
    return [head("Monthly targets","Store-wide targets for credit sales and collections. The dashboard compares each period with them.")+`<form id="f">
      <div class="tbl-wrap"><table><thead><tr><th>Month</th><th>Credit sales target (₱)</th><th>Collections target (₱)</th></tr></thead><tbody>
      ${months.map(m=>`<tr><td class="nowrap"><b>${m.label}</b>${m.ym===t0.slice(0,7)?` <span class="pill neutral">now</span>`:""}</td>
        <td><input type="number" min="0" step="100" data-ym="${m.ym}" data-k="sales" value="${esc(T[m.ym]&&T[m.ym].sales||"")}" placeholder="No target" aria-label="Credit sales target for ${m.label}"></td>
        <td><input type="number" min="0" step="100" data-ym="${m.ym}" data-k="collections" value="${esc(T[m.ym]&&T[m.ym].collections||"")}" placeholder="No target" aria-label="Collections target for ${m.label}"></td></tr>`).join("")}
      </tbody></table></div>
      <div class="actions" style="margin-top:12px"><button class="btn primary" type="submit">Save targets</button><button class="btn" type="button" id="t-copy">Copy last month to the next months</button><button class="btn" type="button" data-back>Cancel</button></div></form>`,sh=>{
      $("#t-copy",sh).addEventListener("click",()=>{ const prev=months[1].ym; ["sales","collections"].forEach(k=>{ const v=$(`[data-ym="${prev}"][data-k="${k}"]`,sh).value; months.slice(2).forEach(m=>{ const el=$(`[data-ym="${m.ym}"][data-k="${k}"]`,sh); if(!el.value) el.value=v; }); }); });
      $("#f",sh).addEventListener("submit",e=>{ e.preventDefault(); const btn=e.submitter||$("button[type=submit]",sh); const T={...(S.settings.targets||{})};
        $$("[data-ym]",sh).forEach(el=>{ const ym=el.dataset.ym, k=el.dataset.k, v=el.value===""?null:Math.max(0,r2(el.value)); T[ym]={...(T[ym]||{}),[k]:v}; if(!T[ym].sales&&!T[ym].collections) delete T[ym]; });
        guarded(btn,async()=>{ await db.doc("settings/store").set({...S.settings,targets:T,updated:stamp()}); toast("Targets saved"); back(); }); });
    }]; });
}
function ownerSummarySheet(){
  const canPrint=!!window.APP;
  show(()=>{ const D=dashData(), A=agingReport(today(),""), top=A.rows.filter(r=>r.total-r.b.current>0.004).sort((a,b)=>(b.total-b.b.current)-(a.total-a.b.current)).slice(0,10), R=reportData();
    const line=(l,v,t)=>`<tr><td>${l}</td><td class="r num">${P(v)}</td><td class="r num">${!t?"—":t.full?`${P(t.sum)} · ${Math.round(v/t.sum*100)}%`:`set for ${t.covered} of ${t.total} months`}</td></tr>`;
    return [`<div class="no-print">${head("Owner summary",`${fmtDate(D.from)} – ${fmtDate(D.to)}`)}<div class="actions" style="margin-bottom:14px">${canPrint?`<button class="btn primary" type="button" id="os-print">Print</button>`:""}</div></div>
      <article class="receipt">
        ${storeHead("OWNER SUMMARY",[`${fmtDate(D.from)} – ${fmtDate(D.to)}`,`Printed ${esc(fmtStamp(Date.now()))}`])}
        <table class="rc-tbl"><thead><tr><th>For the period</th><th class="r">Actual</th><th class="r">Target</th></tr></thead><tbody>
          ${line("Credit sales",D.sales,D.salesTarget)}${line("Collections",D.coll,D.collTarget)}${line("Returns",D.ret)}${line("Gross profit",R.tot.profit)}${line("Write-offs",R.tot.writeoff||0)}</tbody></table>
        <table class="rc-tbl"><thead><tr><th>Right now</th><th class="r"></th></tr></thead><tbody>
          <tr><td>Receivables</td><td class="r num">${P(D.receivable)}</td></tr><tr><td>Overdue</td><td class="r num">${P(D.overdue)}</td></tr>
          ${AGE_B.map(([k,l])=>`<tr><td style="padding-left:20px">${l}</td><td class="r num">${P(A.tot[k])}</td></tr>`).join("")}
          <tr><td>Dealers who bought in the period</td><td class="r num">${D.activeDealers}</td></tr><tr><td>Inactive dealers (no sale in 60 days)</td><td class="r num">${D.inactive.length}</td></tr></tbody></table>
        <table class="rc-tbl"><thead><tr><th>Collections by staff member</th><th class="r">Payments</th><th class="r">Collected</th></tr></thead><tbody>
          ${D.staff.length?D.staff.map(s=>`<tr><td>${esc(s.name)}</td><td class="r num">${s.count}</td><td class="r num">${P(s.amount)}</td></tr>`).join(""):`<tr><td colspan="3" class="muted">No payments in this period.</td></tr>`}</tbody></table>
        <table class="rc-tbl"><thead><tr><th>Largest overdue balances</th><th class="r">Overdue</th><th class="r">Balance</th></tr></thead><tbody>
          ${top.length?top.map(r=>`<tr><td>${esc(r.d.name)}</td><td class="r num">${P(r.total-r.b.current)}</td><td class="r num">${P(r.balance)}</td></tr>`).join(""):`<tr><td colspan="3" class="muted">Nothing overdue.</td></tr>`}</tbody></table>
        ${qrBlock(deepLink("summary"),"Owner summary",`${fmtDate(D.from)} – ${fmtDate(D.to)}`)}
      </article>`,sh=>{ const pr=$("#os-print",sh); if(pr) pr.addEventListener("click",()=>window.print()); }]; });
}
/* ================= main views ================= */
function render(){
  $$(".tab").forEach(b=>b.setAttribute("aria-current",b.dataset.view===S.view?"page":"false"));
  $("#topActions").hidden=!S.canWrite;
  $("#dashTab").hidden=!S.canAdmin;
  $("#storeName").textContent=storeName();
  { const n=activeOrders().filter(([,o])=>o.status==="new").length; const b=$("#ordBadge"); b.hidden=!n; b.textContent=n; $("#ordersTab").hidden=!window.APP; }
  renderBottomNav();
  if(!db||!Object.values(S.loaded).every(Boolean)) return;
  const act=document.activeElement, fid=act&&act.closest&&act.closest("#main")&&act.id, pos=act&&act.selectionStart;
  const mainEl=$("#main"); if(S._lastView!==S.view){ S._lastView=S.view; mainEl.classList.remove("view-in"); void mainEl.offsetWidth; mainEl.classList.add("view-in"); }
  $("#main").innerHTML=({overview:vOverview,orders:vOrders,collect:vCollect,dealers:vDealers,products:vProducts,activity:vActivity,reports:vReports,store:vStore,dash:vDash,...window.LedgerOps.views}[S.view]||vOverview)();
  if(S.view==="dash"&&S.canAdmin){ const D=dashData(); mountBars("dashChart",D.series); }
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
  return sampleBanner()+offlineNotices()+approvalNotices()+healthNotices()+`
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
        ${od.slice(0,15).map(({d,id,st})=>`<tr class="click" tabindex="0" data-dealer="${id}"><td><b>${esc(d.name)}</b>${samplePill(d)}<div class="small muted">${esc(d.phone||"")}${d.area?" · "+esc(d.area):""}</div></td><td class="r num"><b>${P(st.overdue)}</b></td><td class="r num">${P(st.balance)}</td><td>${statusPill(st,d)}</td></tr>`).join("")}
        </tbody></table></div>${od.length>15?`<p class="small muted" style="margin:8px 0 0">And ${od.length-15} more. <button class="btn sm" data-act="go-collect" type="button">Open the collection list</button></p>`:""}`:`<div class="empty"><h3>No overdue accounts</h3><p>Every dealer is paid up or still within terms.</p></div>`}
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Due in the next 7 days</h2></div>
        ${dueSoon.length?`<div class="tbl-wrap"><table><tbody>${dueSoon.slice(0,15).map(({d,id,o})=>`<tr class="click" tabindex="0" data-dealer="${id}"><td><b>${esc(d.name)}</b><div class="small muted">${esc(o.no||"")} · released ${fmtDate(o.date)}</div></td><td class="small nowrap">Due ${fmtDate(o.dueDate)}</td><td class="r num">${P(o.remaining)}</td></tr>`).join("")}</tbody></table></div>`:`<p class="muted small" style="margin:0">Nothing falls due this week.</p>`}
      </section>
    </div>
    <div class="col">
      ${followUpsPanel()}
      <section class="panel">
        <div class="panel-head"><h2>Receivables aging</h2><button class="btn sm" data-act="aging" type="button">Full report</button></div>
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
  const q=S.q.toLowerCase(), sf=S.stageF, tags=allTags();
  const inStage=d=>sf==="all"?stageOf(d)!=="lost":sf==="prospects"?isProspect(d):sf==="dealers"?stageOf(d)==="dealer":stageOf(d)==="lost";
  const rows=[...S.dealers.entries()].filter(([,d])=>S.showArchived||d.active!==false).filter(([,d])=>inStage(d)&&(!S.tagF||(d.tags||[]).includes(S.tagF)))
    .filter(([,d])=>!q||[d.name,d.phone,d.area,d.email,d.address,d.referredBy,d.source,...(d.tags||[])].join(" ").toLowerCase().includes(q))
    .map(([id,d])=>({id,d,st:status(id)})).sort((a,b)=>b.st.balance-a.st.balance||a.d.name.localeCompare(b.d.name));
  const arch=[...S.dealers.values()].filter(d=>d.active===false).length;
  const cnt=f=>[...S.dealers.values()].filter(d=>d.active!==false&&f(d)).length;
  const segs=[["all","All",cnt(d=>stageOf(d)!=="lost")],["dealers","Dealers",cnt(d=>stageOf(d)==="dealer")],["prospects","Prospects",cnt(isProspect)],["lost","Lost",cnt(d=>stageOf(d)==="lost")]];
  return sampleBanner()+`<section class="panel">
    <div class="panel-head"><h2>Dealers <span class="muted small">(${cnt(d=>stageOf(d)==="dealer")} active)</span></h2><div class="actions">${downloads?`<button class="btn sm" data-act="export-dealers" type="button">Export CSV</button>`:""}${S.canWrite?`<button class="btn sm" data-act="new-prospect" type="button">+ Add prospect</button><button class="btn primary sm" data-act="new-dealer" type="button">+ Add dealer</button>`:""}</div></div>
    <div class="toolbar"><div class="seg" role="group" aria-label="Stage">${segs.map(([v,l,n])=>`<button type="button" data-sf="${v}" aria-pressed="${sf===v}">${l} <span class="muted">${n}</span></button>`).join("")}</div>
      <input id="q" type="search" placeholder="Search name, phone, area, tag…" value="${esc(S.q)}" aria-label="Search dealers">
      ${tags.length?`<select id="tagFilter" aria-label="Tag"><option value="">All tags</option>${tags.map(t=>`<option ${t===S.tagF?"selected":""}>${esc(t)}</option>`).join("")}</select>`:""}
      ${arch?`<label class="chk"><input type="checkbox" id="showArch" ${S.showArchived?"checked":""}> Show ${arch} archived</label>`:""}</div>
    ${rows.length?`<div class="tbl-wrap"><table><thead><tr><th>Dealer</th><th>Stage</th><th class="r">Balance</th><th>Credit used</th><th>Next due</th><th>Follow-up</th><th>Rating</th><th>Status</th></tr></thead><tbody>
    ${rows.slice(0,S.allDealers?Infinity:100).map(({id,d,st})=>{ const pct=d.creditLimit?Math.min(100,Math.max(0,st.balance/d.creditLimit*100)):0; const cls=pct>=100?"bad":pct>=80?"warn":""; const pr=isProspect(d)||stageOf(d)==="lost";
      return `<tr class="click" tabindex="0" data-dealer="${id}"><td><div class="prod-cell">${avatar(d,32)}<div><b>${esc(d.name)}</b>${samplePill(d)}${d.active===false?` <span class="pill neutral">Archived</span>`:""}<div class="small muted">${esc(d.phone||"")}${d.area?" · "+esc(d.area):""}</div>${(d.tags||[]).length?`<div>${d.tags.slice(0,3).map(t=>`<span class="pill neutral tag">${esc(t)}</span>`).join(" ")}</div>`:""}</div></div></td>
      <td>${stagePill(d)}</td>
      <td class="r num"><b>${pr&&!st.balance?"—":P(st.balance)}</b></td>
      <td class="small num">${pr?`<span class="muted">—</span>`:d.creditLimit?`${Math.round(pct)}% of ${P(d.creditLimit)}<div class="meter"><i class="${cls}" style="width:${pct}%"></i></div>`:`<span class="muted">No limit</span>`}</td>
      <td class="small nowrap">${st.nextDue?fmtDate(st.nextDue):"—"}</td><td class="small nowrap">${followUpCell(id)}</td><td>${pr?"":gradePill(history(id))}</td><td>${pr?"":statusPill(st,d)}</td></tr>`;}).join("")}
    </tbody></table></div>${rows.length>100&&!S.allDealers?`<p class="small muted">Showing the 100 largest balances of ${rows.length}. Search to find others, or <button class="btn sm" data-act="all-dealers" type="button">show all ${rows.length}</button></p>`:""}`:(S.dealers.size?`<div class="empty"><h3>No match</h3><p>${S.q?`No one matches “${esc(S.q)}”.`:"No one in this list yet."}</p></div>`:emptyStart())}
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
    ${rows.length?`<div class="tbl-wrap"><table><thead><tr><th>Product</th><th>Code</th><th class="r">Dealer price</th><th class="r">SRP</th><th class="r">Cost</th><th class="r">Profit/pc</th><th class="r">Stock</th></tr></thead><tbody>
    ${rows.map(([id,p])=>{ const low=p.reorderLevel!=null&&p.stock<=p.reorderLevel; const profit=p.cost!=null?r2(p.dealerPrice-p.cost):null; const mp=profit!=null&&p.dealerPrice?Math.round(profit/p.dealerPrice*100):null;
      return `<tr class="${S.canWrite?"click":""}" ${S.canWrite?`tabindex="0" data-product="${id}"`:""}><td><div class="prod-cell">${thumb(p)}<div><b>${esc(p.name)}</b>${samplePill(p)}${p.active===false?` <span class="pill neutral">Archived</span>`:""}<div class="small muted">${esc(p.category||"")}${p.imageLink&&!p.imageId?`${p.category?" · ":""}<a href="${esc(p.imageLink)}" target="_blank" rel="noopener noreferrer">View picture ↗</a>`:""}</div></div></div></td>
      <td class="small muted">${esc(p.code||"—")}${qrReady()?` <button class="btn sm" type="button" data-act="product-qr" data-id="${id}" aria-label="QR code for ${esc(p.name)}">QR</button>`:""}</td><td class="r num">${P(p.dealerPrice)}</td><td class="r num nowrap">${p.srp||promoOn(p)?priceTag(p,1):"—"}</td><td class="r num small">${p.cost!=null?P(p.cost):"—"}</td><td class="r num small">${profit!=null?`${P(profit)}${mp!=null?`<div class="muted">${mp}%</div>`:""}`:"—"}</td><td class="r num">${low?`<span class="pill ${p.stock<=0?"bad":"warn"}">${p.stock}</span>`:p.stock}</td></tr>`;}).join("")}
    </tbody></table></div>`:`<div class="empty"><h3>${S.products.size?"No match":"No products yet"}</h3><p>${S.products.size?"Try another search or category.":"Add the items you release to dealers, with dealer price and stock on hand."}</p></div>`}
  </section>`;
}
function txDetails(t){
  const it=(t.items||[]).map(i=>`${esc(i.name)} ×${i.qty}`).join(", ");
  const no=t.no?`<span class="small muted">${esc(t.no)}</span> `:"";
  const vd=(t.check&&t.check.status==="bounced"?` <span class="pill bad">Bounced</span>`:t.voided?` <span class="pill bad">Voided</span>`:t.check&&!isLive(t)?` <span class="pill warn">Check not due yet</span>`:"")+(t.offlineHeld?` <span class="pill bad">Needs review</span>`:t.offlinePending?` <span class="pill warn">Not synced</span>`:"");
  if(t.opening) return `${no}<span class="pill neutral">Opening balance</span>${vd}<div class="small muted">Due ${fmtDate(t.dueDate)}${t.note&&t.note!=="Opening balance"?" · "+esc(t.note):""}</div>`;
  if(t.type==="sale") return `${no}<span class="pill neutral">Credit sale</span>${vd}${t.manualPrice?` <span class="pill warn" title="${esc(t.priceReason||"")}">Manual price</span>`:""} <span class="small">${it}</span><div class="small muted">Due ${fmtDate(t.dueDate)}${t.pctDiscount?(t.discountPct!=null?` · less ${t.discountPct}%`:" · less dealer discount"):""}${t.discount?` · less ${P(t.discount)}`:""}${t.note?" · "+esc(t.note):""}</div>`;
  if(t.type==="return") return `${no}<span class="pill warn">Return</span>${vd} <span class="small">${it}</span><div class="small muted">${t.restock?"Back to stock":"Not restocked"}${t.saleNo?` · from ${esc(t.saleNo)}`:""}${t.note?" · "+esc(t.note):""}</div>`;
  if(t.type==="adjustment") return `${no}<span class="pill ${t.direction==="debit"?"warn":"good"}">${t.direction==="debit"?"Debit adjustment":"Credit adjustment"}</span>${vd} <div class="small muted">${t.reason?esc(t.reason):""}${t.note?" · "+esc(t.note):""}</div>`;
  if(t.type==="writeoff") return `${no}<span class="pill bad">Write-off</span>${vd} <div class="small muted">${esc(t.reason||"Bad debt")}${t.note?" · "+esc(t.note):""}</div>`;
  return `${no}<span class="pill good">${t.payKind==="partial"?"Partial payment":t.payKind==="full"?"Full payment":"Payment"}</span>${vd} <span class="small">${esc(t.method||"")}${t.ref?" · Ref "+esc(t.ref):""}${(t.alloc||[]).length?` · for ${t.alloc.map(a=>esc(a.no||"delivery")).join(", ")}`:""}</span>${t.note?`<div class="small muted">${esc(t.note)}</div>`:""}`;
}
const sign=t=>isCharge(t)?"":"−";
// Newest first, sorted once per data change (PR-09).
const SORTED_TX={key:null,list:[]};
function sortedTxns(){ if(SORTED_TX.key!==S._ver||SORTED_TX.src!==S.txns){ SORTED_TX.list=[...S.txns.entries()].sort((a,b)=>{ const x=a[1].date||"", y=b[1].date||""; return x<y?1:x>y?-1:(b[1].createdAt||0)-(a[1].createdAt||0); }); SORTED_TX.key=S._ver; SORTED_TX.src=S.txns; } return SORTED_TX.list; }
function vActivity(){
  const q=S.q.toLowerCase();
  const rows=sortedTxns().filter(([,t])=>S.txFilter==="all"?true:S.txFilter==="voided"?t.voided:(t.type===S.txFilter&&!t.voided))
    .filter(([,t])=>{ if(!q) return true; const d=S.dealers.get(t.dealerId); return [d&&d.name,t.no,t.note,t.ref,t.method,(t.items||[]).map(i=>i.name).join(" ")].join(" ").toLowerCase().includes(q); })
    ;
  const shown=rows.slice(0,S.txShow||100);
  return sampleBanner()+`<section class="panel">
    <div class="panel-head"><h2>Transactions</h2><div class="actions">${downloads?`<button class="btn sm" data-act="export-tx" type="button">Export CSV</button>`:""}${S.canWrite?`<button class="btn sm" data-act="new-return" type="button">+ Return</button>`:""}</div></div>
    <div class="toolbar"><input id="q" type="search" placeholder="Search dealer, DR/OR no., product, reference" value="${esc(S.q)}" aria-label="Search transactions">
      <select id="txFilter" aria-label="Type">${[["all","All"],["sale","Credit sales"],["payment","Payments"],["return","Returns"],["adjustment","Adjustments"],["writeoff","Write-offs"],["voided","Voided"]].map(([v,l])=>`<option value="${v}" ${S.txFilter===v?"selected":""}>${l}</option>`).join("")}</select></div>
    ${rows.length?`<div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Dealer</th><th>Details</th><th class="r">Amount</th></tr></thead><tbody>
    ${shown.map(([id,t])=>{ const d=S.dealers.get(t.dealerId); return `<tr class="click ${t.voided?"void":""}" tabindex="0" data-tx="${id}"><td class="small nowrap">${fmtDate(t.date)}</td><td><b>${esc(d?d.name:"(removed dealer)")}</b>${samplePill(t)}</td><td>${txDetails(t)}</td><td class="r num nowrap amt">${sign(t)}${P(t.amount)}</td></tr>`; }).join("")}
    </tbody></table></div>${rows.length>shown.length?`<p class="small muted">Showing the latest ${shown.length} of ${rows.length}. <button class="btn sm" data-act="more-tx" type="button">Show ${Math.min(500,rows.length-shown.length)} more</button> Search or export CSV to find older ones.</p>`:""}`:`<div class="empty"><h3>No transactions</h3><p>Credit sales, payments and returns you record will be listed here.</p></div>`}
  </section>`;
}
function rangeDates(){
  const t=new Date(), y=t.getFullYear(), m=t.getMonth(); const R=S.range;
  if(R.preset==="month") return [ymd(new Date(y,m,1)),ymd(new Date(y,m+1,0))];
  if(R.preset==="last") return [ymd(new Date(y,m-1,1)),ymd(new Date(y,m,0))];
  if(R.preset==="year") return [`${y}-01-01`,`${y}-12-31`];
  return [R.from||"0000-01-01",R.to||"9999-12-31"];
}
function lineCost(i){ return i.cost!=null?Number(i.cost):Number((S.products.get(i.productId)||{}).cost)||0; }
function reportData(){
  const [from,to]=rangeDates();
  const tx=[...S.txns.values()].filter(t=>isLive(t)&&t.date>=from&&t.date<=to);
  const tot={sale:0,payment:0,return:0,adjustment:0,adjustmentDebit:0,adjustmentCredit:0,writeoff:0,discount:0,cost:0,profit:0,count:tx.length};
  const byP={}, byD={}, byM={};
  tx.forEach(t=>{ tot[t.type]=(tot[t.type]||0)+t.amount;
    if(t.type==="sale") tot.discount+=(t.discount||0)+(t.pctDiscount||0);
    if(t.type==="adjustment"){ if(t.direction==="debit") tot.adjustmentDebit+=t.amount; else tot.adjustmentCredit+=t.amount; }
    const d=byD[t.dealerId]=byD[t.dealerId]||{sale:0,payment:0,return:0,adjustment:0,writeoff:0}; d[t.type]=(d[t.type]||0)+t.amount;
    if(t.type==="payment") byM[t.method||"Other"]=(byM[t.method||"Other"]||0)+t.amount;
    if(t.items&&(t.type==="sale"||t.type==="return")) (t.items||[]).forEach(i=>{
      const p=byP[i.productId]=byP[i.productId]||{name:i.name,qty:0,amt:0,ret:0,cost:0,profit:0};
      const gross=r2(i.qty*i.price-lineDisc(i,t)), cost=r2(i.qty*lineCost(i));
      if(t.type==="sale"){ p.qty+=i.qty; p.amt=r2(p.amt+gross); p.cost=r2(p.cost+cost); p.profit=r2(p.profit+gross-cost); tot.cost=r2(tot.cost+cost); tot.profit=r2(tot.profit+gross-cost); }
      else { p.ret+=i.qty; p.amt=r2(p.amt-gross); p.cost=r2(p.cost-cost); p.profit=r2(p.profit-(gross-cost)); tot.cost=r2(tot.cost-cost); tot.profit=r2(tot.profit-(gross-cost)); }
    });
  });
  return {from,to,tot,byP,byD,byM};
}
function vReports(){
  const R=reportData(); const {tot}=R;
  const prod=Object.entries(R.byP).sort((a,b)=>b[1].amt-a[1].amt);
  const deal=Object.entries(R.byD).sort((a,b)=>b[1].sale-a[1].sale);
  const meth=Object.entries(R.byM).sort((a,b)=>b[1]-a[1]);
  const net=r2(tot.sale-tot.return);
  const pr=[["month","This month"],["last","Last month"],["year","This year"],["custom","Custom"]];
  const booksLine=S.settings.closedThrough?`<div class="notice info"><p>The books are closed through <b>${fmtDate(S.settings.closedThrough)}</b>. Figures up to that date are final.</p></div>`:"";
  return booksLine+trendChart()+`<section class="panel" style="margin-bottom:20px">
    <div class="panel-head"><h2>Report period</h2><div class="actions"><button class="btn sm" data-act="aging" type="button">Receivables aging</button>${window.APP?`<button class="btn sm" data-act="approvals" type="button">Approvals</button>`:""}${downloads?`<button class="btn sm" data-act="export-report" type="button">Export report CSV</button>`:""}</div></div>
    <div class="toolbar"><div class="seg" role="group" aria-label="Period">${pr.map(([v,l])=>`<button type="button" data-preset="${v}" aria-pressed="${S.range.preset===v}">${l}</button>`).join("")}</div>
    ${S.range.preset==="custom"?`<input type="date" id="rFrom" value="${esc(S.range.from)}" aria-label="From"><span class="muted">to</span><input type="date" id="rTo" value="${esc(S.range.to)}" aria-label="To">`:`<span class="small muted">${fmtDate(R.from)} – ${fmtDate(R.to)}</span>`}</div>
  </section>
  <div class="kpis">
    <div class="kpi"><div class="lbl">Credit sales</div><div class="val num">${P(tot.sale)}</div><div class="sub">${tot.discount?`After ${P(tot.discount)} discounts`:"Released to dealers"}</div></div>
    <div class="kpi"><div class="lbl">Returns</div><div class="val num">${P(tot.return)}</div><div class="sub">Net sales ${P(net)}</div></div>
    <div class="kpi good"><div class="lbl">Collections</div><div class="val num">${P(tot.payment)}</div><div class="sub">${net>0?`${Math.round(tot.payment/net*100)}% of net sales`:"Payments received"}</div></div>
    <div class="kpi"><div class="lbl">Transactions</div><div class="val num">${tot.count}</div><div class="sub">Voided ones not counted</div></div>
    ${S.canAdmin?window.LedgerOps.netProfitKpi(tot.profit,rangeDates()):""}
    <div class="kpi ${tot.profit<0?"bad":"good"}" ${S.acct&&S.acct.role==="staff"?"hidden":""}><div class="lbl">Gross profit</div><div class="val num">${P(tot.profit)}</div><div class="sub">${tot.sale-tot.return>0?`${Math.round(tot.profit/(tot.sale-tot.return)*100)}% margin`:"Cost of goods sold"}</div></div>
    <div class="kpi ${tot.writeoff?"bad":""}"><div class="lbl">Write-offs</div><div class="val num">${P(tot.writeoff)}</div><div class="sub">${tot.adjustmentDebit||tot.adjustmentCredit?`Adjustments: +${P(tot.adjustmentDebit)} / −${P(tot.adjustmentCredit)}`:"Bad debt removed"}</div></div>
  </div>
  <div class="grid2e">
    <section class="panel"><h2>By product</h2>
      ${prod.length?`<div class="tbl-wrap"><table><thead><tr><th>Product</th><th class="r">Sold</th><th class="r">Returned</th><th class="r">Sales</th><th class="r">Cost</th><th class="r">Profit</th></tr></thead><tbody>
      ${prod.map(([pid,p])=>`<tr><td><div class="prod-cell">${thumb(S.products.get(pid),1)}<span>${esc(p.name)}</span></div></td><td class="r num">${p.qty}</td><td class="r num">${p.ret||"—"}</td><td class="r num">${P(p.amt)}</td><td class="r num">${P(p.cost)}</td><td class="r num ${p.profit<0?"":""}">${P(p.profit)}</td></tr>`).join("")}
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
      <label class="f">Approval requests expire after (hours)<input id="st-apph" type="number" min="1" max="336" step="1" value="${esc(s.approvalHours??24)}" ${S.canAdmin?"":"disabled"}><span class="hint">Staff can send blocked credit sales to you for approval.</span></label>
      <label class="chk span"><input type="checkbox" id="st-block" ${s.blockOverLimit!==false?"checked":""} ${S.canAdmin?"":"disabled"}> Block credit sales over the limit unless the owner approves</label>
      <label class="chk span"><input type="checkbox" id="st-neg" ${s.allowNegativeStock?"checked":""} ${S.canAdmin?"":"disabled"}> Allow stock to go below zero (backorders)</label>
      <h3 class="span form-sec">Privacy (Data Privacy Act)</h3>
      <label class="f span">Privacy notice for dealers<textarea id="st-privacy" rows="5" ${S.canAdmin?"":"disabled"}>${esc(s.privacyNotice??DEFAULT_PRIVACY)}</textarea><span class="hint">Shown in the dealer portal for dealers to accept. ${s.privacyVersion?`Current version: ${esc(s.privacyVersion)}. Changing the text creates a new version.`:"Not saved yet."} Adapt it with your adviser.</span></label>
      <label class="f">Keep records for (years)<input id="st-ret" type="number" min="1" max="30" step="1" value="${esc(s.retentionYears??10)}" ${S.canAdmin?"":"disabled"}><span class="hint">Personal data of dealers with transactions in this period can't be removed. Check the period with your accountant.</span></label>
      <h3 class="span form-sec">Messages</h3>
      <label class="f span">Collection reminder message<textarea id="st-msg" rows="4" ${S.canAdmin?"":"disabled"}>${esc(s.reminderTemplate||DEFAULT_MSG)}</textarea><span class="hint">{name}, {balance}, {status}, {store} and {payinfo} are filled in for each dealer.</span></label>
      ${S.canAdmin?`<div class="actions span"><button class="btn primary" type="submit">Save store details</button></div>`:`<p class="small muted span" style="margin:0">Only the ledger owner or editors can change store details.</p>`}
    </form>
  </section>
  <div class="col">
    ${teamPanel()}
    ${S.backup?(()=>{ const b=S.backup, bp=backupProblems(); return `<section class="panel"><div class="panel-head"><h2>Server backups</h2><button class="btn sm" data-act="backup-run" type="button">Back up and verify now</button></div>
      ${bp.length?bp.map(([k,t])=>`<div class="notice ${k}"><p>${esc(t)}</p></div>`).join(""):`<div class="notice info"><p>Backups are running, verified and copied offsite.</p></div>`}
      <dl class="kv"><dt>Last good backup</dt><dd>${b.lastSuccessAt?`${esc(fmtStamp(b.lastSuccessAt))} · ${esc(b.lastFile||"")} · ${(b.lastSize/1048576).toFixed(1)} MB · ${b.lastDocs} records, ${b.lastUsers} accounts · integrity check passed`:"None yet"}</dd>
        <dt>Offsite copy</dt><dd>${!b.offsiteConfigured?"Not set up":b.offsite&&b.offsite.lastSuccessAt?`Last copied ${esc(fmtStamp(b.offsite.lastSuccessAt))}`:"Not copied yet"}</dd>
        <dt>Alerts</dt><dd>${b.alertsConfigured?"On (ALERT_CMD or ALERT_WEBHOOK_URL)":"Off. Set ALERT_WEBHOOK_URL or ALERT_CMD to be told when a backup fails."}</dd>
        <dt>Kept on server</dt><dd>${b.count} daily backup${b.count===1?"":"s"}</dd></dl>
      <p class="small muted" style="margin:0">To restore one, stop the app and run <code>npm run restore -- data/backups/${esc(b.lastFile||"ledger-YYYY-MM-DD.db")}</code>. See README, “Restoring from a backup”.</p></section>`; })():""}
    <section class="panel"><h2>Backup and restore</h2>
      <p class="small" style="margin-top:0">Download a backup regularly and keep it on your phone, computer or Google Drive. Photos are not inside the backup file. The server also saves an automatic backup of everything (photos excluded) every day.</p>
      <div class="actions">${downloads?`<button class="btn primary" data-act="backup" type="button">Download backup</button>`:`<span class="small muted">Downloads aren't available in this view.</span>`}
      ${S.canAdmin?`<button class="btn" data-act="backup-full" type="button">Download full backup (accounts + photos)</button><label class="btn" for="restoreFile" style="cursor:pointer">Restore from backup…</label><input id="restoreFile" type="file" accept=".json,application/json" hidden><label class="btn" for="restoreFullFile" style="cursor:pointer">Restore full backup…</label><input id="restoreFullFile" type="file" accept=".json,application/json" hidden>`:""}</div>
      <div id="restoreArea"></div>
    </section>
    <section class="panel"><h2>Ledger health</h2>
      <dl class="kv"><dt>Records</dt><dd class="num">${docs.toLocaleString()}</dd><dt>Dealers</dt><dd>${S.dealers.size}</dd><dt>Products</dt><dd>${S.products.size}</dd><dt>Transactions</dt><dd>${S.txns.size}</dd><dt>Stock movements</dt><dd>${S.moves.size}</dd><dt>Your access</dt><dd>${S.canAdmin?"Owner / Editor":S.canWrite?"Can record sales and payments":"View only"}</dd></dl>
      
      ${sampleBanner()}
    </section>
  </div></div>`;
}

/* ---------- approval requests for blocked credit sales (FR-084) ---------- */
const APP_L={pending:"Waiting",approved:"Approved",rejected:"Rejected",withdrawn:"Withdrawn",expired:"Expired"};
const APP_C={pending:"warn",approved:"good",rejected:"bad",withdrawn:"neutral",expired:"neutral"};
const apStatus=r=>r.status==="pending"&&r.expiresAt<Date.now()?"expired":r.status;
const apPill=r=>`<span class="pill ${APP_C[apStatus(r)]}">${APP_L[apStatus(r)]||esc(r.status)}</span>`;
function apBlockText(b){ if(!b) return ""; const out=[];
  if(b.hold) out.push(`On credit hold · ${b.maxLate} days late (limit ${b.holdDays})`);
  if(b.over) out.push(`Over the credit limit · balance ${P(b.balance)} of ${P(b.creditLimit)}`);
  if(b.discount) out.push(b.discount);
  if(b.overdue) out.push(`${P(b.overdue)} overdue`); return out.join(" · "); }
const hoursLeft=ms=>{ const h=Math.max(0,(ms-Date.now())/3600e3); return h>=1?`${Math.round(h)} h left`:`${Math.max(1,Math.round(h*60))} min left`; };
function askApproval(data,opts,paidMethod,serverMsg){
  if(!(window.APP&&window.APP.requestApproval)){ toast("This dealer is blocked. Ask the owner to approve the sale."); return; }
  const d=S.dealers.get(data.dealerId)||{name:""}, st=status(data.dealerId), lim=d.creditLimit;
  show(()=>[head("Send for approval",esc(d.name))+`
    <div class="notice warn"><p>${esc(serverMsg||(st.maxLate>holdDays()?`${d.name} is on credit hold (${st.maxLate} days late).`:`This sale would put ${d.name} over the credit limit.`))}</p></div>
    <dl class="kv"><dt>Sale</dt><dd><b class="num">${P(data.amount)}</b> · ${data.items.length} item${data.items.length===1?"":"s"}: ${esc(data.items.slice(0,4).map(i=>`${i.name} ×${i.qty}`).join(", "))}${data.items.length>4?"…":""}</dd>
      <dt>Balance now</dt><dd class="num">${P(st.balance)}${st.overdue?` · <span style="color:var(--bad)">${P(st.overdue)} overdue</span>`:""}</dd>${lim?`<dt>Credit limit</dt><dd class="num">${P(lim)}</dd>`:""}
      ${paidMethod?`<dt>Payment</dt><dd>Paid on release by ${esc(paidMethod)}</dd>`:""}</dl>
    <form id="apf" class="form-grid"><label class="f span">Why should the owner approve it?<textarea id="ap-why" rows="3" required minlength="3" maxlength="500" placeholder="e.g. Dealer paid ₱2,000 by GCash today; reference to follow"></textarea></label>
    <p class="small muted span" style="margin:0">Nothing is recorded and no stock is taken until the owner or an editor approves. The request expires after ${Number(S.settings.approvalHours)||24} hours.</p>
    <div class="actions span"><button class="btn primary" type="submit">Send for approval</button><button class="btn" type="button" data-back>Back to the sale</button></div></form>`,sh=>{
    $("#apf",sh).addEventListener("submit",e=>{ e.preventDefault(); const btn=e.submitter||$("button[type=submit]",sh); const why=$("#ap-why",sh).value.trim(); if(why.length<3){ toast("Give the owner a reason"); return; }
      guarded(btn,async()=>{ await window.APP.requestApproval({sale:data,reason:why,orderId:opts&&opts.orderId||null,paidMethod:paidMethod||null}); toast("Sent to the owner for approval"); closeAll(); }); });
  }]);
}
function approvalNotices(){ if(!S.approvals.size) return ""; const all=[...S.approvals.values()], t3=Date.now()-3*864e5;
  const pend=all.filter(r=>apStatus(r)==="pending");
  if(S.canAdmin) return pend.length?`<div class="notice warn"><p><b>${pend.length} credit sale${pend.length===1?" is":"s are"} waiting for your approval.</b> ${esc(pend.slice(0,3).map(r=>(S.dealers.get(r.dealerId)||{}).name||"").join(", "))}</p><button class="btn sm" data-act="approvals" type="button">Review</button></div>`:"";
  const mine=all.filter(r=>r.requestedBy===S.me), wait=mine.filter(r=>apStatus(r)==="pending").length, recent=mine.filter(r=>r.status!=="pending"&&r.status!=="withdrawn"&&(r.decidedAt||0)>t3);
  if(!wait&&!recent.length) return "";
  return `<div class="notice ${recent.some(r=>r.status==="rejected")?"bad":"info"}"><p>${wait?`<b>Your ${wait===1?"request is":wait+" requests are"} waiting for approval.</b> `:""}${recent.map(r=>`${APP_L[apStatus(r)]}: ${esc((S.dealers.get(r.dealerId)||{}).name||"")} ${P(r.amount)}${r.txnNo?` (${esc(r.txnNo)})`:""}${r.note?` — “${esc(r.note)}”`:""}`).join(" · ")}</p><button class="btn sm" data-act="approvals" type="button">View</button></div>`;
}
function approvalsCsv(rows){ return csv([["Request ID","Requested","Dealer","Amount","Requested by","Reason","Status","Decided","Decided by","Note","Sale no."],
  ...rows.map(([id,r])=>[id,new Date(r.requestedAt).toISOString(),(S.dealers.get(r.dealerId)||{}).name||"",r.amount,nameOf(r.requestedBy),r.reason,APP_L[apStatus(r)],r.decidedAt?new Date(r.decidedAt).toISOString():"",r.decidedBy?nameOf(r.decidedBy):"",r.note||"",r.txnNo||""])]); }
function approvalsSheet(){
  let tab=[...S.approvals.values()].some(r=>apStatus(r)==="pending")?"pending":"history"; const notes={};
  show(()=>{ const all=[...S.approvals.entries()].sort((a,b)=>(b[1].requestedAt||0)-(a[1].requestedAt||0));
    const pend=all.filter(([,r])=>apStatus(r)==="pending"), hist=all.filter(([,r])=>apStatus(r)!=="pending");
    resolveNames(all.flatMap(([,r])=>[r.requestedBy,r.decidedBy]));
    const group=(key)=>{ const m=new Map(); hist.forEach(([,r])=>{ const k=key(r); if(!k) return; const g=m.get(k)||{approved:0,rejected:0,other:0,amt:0}; if(r.status==="approved"){ g.approved++; g.amt=r2(g.amt+r.amount); } else if(r.status==="rejected") g.rejected++; else g.other++; m.set(k,g); }); return [...m].sort((a,b)=>b[1].approved+b[1].rejected-(a[1].approved+a[1].rejected)); };
    const byApprover=group(r=>r.status==="approved"||r.status==="rejected"?nameOf(r.decidedBy):null), byDealer=group(r=>(S.dealers.get(r.dealerId)||{}).name||"(removed)");
    return [head("Approval requests","Credit sales staff couldn't record because of a credit hold or the credit limit.")+`
      <div class="toolbar"><div class="seg" role="group" aria-label="Show"><button type="button" data-aptab="pending" aria-pressed="${tab==="pending"}">Waiting <span class="muted">${pend.length}</span></button><button type="button" data-aptab="history" aria-pressed="${tab==="history"}">History <span class="muted">${hist.length}</span></button></div>
        ${downloads&&hist.length?`<button class="btn sm" type="button" id="ap-csv">Export CSV</button>`:""}</div>
      ${tab==="pending"?(pend.length?`<ul class="crm-log">${pend.map(([id,r])=>{ const d=S.dealers.get(r.dealerId)||{name:"(removed dealer)"}; const st=status(r.dealerId); return `<li>
        <div class="crm-meta"><b>${esc(d.name)}</b> · <b class="num">${P(r.amount)}</b> ${apPill(r)} <span class="small muted">· ${hoursLeft(r.expiresAt)}</span></div>
        <div class="small">${esc((r.sale.items||[]).slice(0,5).map(i=>`${i.name} ×${i.qty}`).join(", "))}${r.paidMethod?` · paid on release by ${esc(r.paidMethod)}`:""}</div>
        <div class="small muted">Asked by ${esc(nameOf(r.requestedBy))} · ${esc(fmtStamp(r.requestedAt))}</div>
        <p style="margin:6px 0"><b>Reason:</b> ${esc(r.reason)}</p>
        <div class="small" style="color:var(--bad)">${esc(apBlockText(r.block))}</div>
        <div class="small muted">Now: balance ${P(st.balance)}${st.overdue?` · ${P(st.overdue)} overdue · ${st.maxLate} days late`:""}${d.creditLimit?` · limit ${P(d.creditLimit)}`:""}</div>
        <div class="actions" style="margin-top:8px">${S.canAdmin?`<input class="ap-note" data-apnote="${id}" value="${esc(notes[id]||"")}" placeholder="Note (required to reject)" maxlength="500" style="flex:1 1 200px;min-width:0"><button class="btn sm primary" data-approve="${id}" type="button">Approve</button><button class="btn sm danger" data-reject="${id}" type="button">Reject</button>`:""}
          ${r.requestedBy===S.me?`<button class="btn sm" data-withdraw="${id}" type="button">Withdraw</button>`:""}<button class="btn sm" data-dealer="${r.dealerId}" type="button">Dealer</button></div></li>`; }).join("")}</ul>`
        :`<div class="empty"><p>No requests waiting.</p></div>`)
      :(hist.length?`<div class="tbl-wrap"><table><thead><tr><th>Requested</th><th>Dealer</th><th class="r">Amount</th><th>Asked by</th><th>Result</th><th>Decided by</th></tr></thead><tbody>
        ${hist.slice(0,200).map(([,r])=>`<tr><td class="small nowrap">${esc(fmtStamp(r.requestedAt))}</td><td>${esc((S.dealers.get(r.dealerId)||{}).name||"(removed)")}<div class="small muted">${esc(r.reason)}</div></td><td class="r num">${P(r.amount)}</td><td class="small">${esc(nameOf(r.requestedBy))}</td>
          <td>${apPill(r)}${r.txnNo?`<div class="small">${esc(r.txnNo)}</div>`:""}${r.note?`<div class="small muted">“${esc(r.note)}”</div>`:""}</td><td class="small">${r.decidedBy&&(r.status==="approved"||r.status==="rejected")?esc(nameOf(r.decidedBy)):"—"}</td></tr>`).join("")}</tbody></table></div>
        <div class="grid2e" style="margin-top:16px">
          <section class="panel"><h2>By approver</h2>${byApprover.length?`<table><thead><tr><th>Approver</th><th class="r">Approved</th><th class="r">Rejected</th><th class="r">Approved amount</th></tr></thead><tbody>${byApprover.map(([k,g])=>`<tr><td>${esc(k)}</td><td class="r num">${g.approved}</td><td class="r num">${g.rejected}</td><td class="r num">${P(g.amt)}</td></tr>`).join("")}</tbody></table>`:`<p class="small muted">No decisions yet.</p>`}</section>
          <section class="panel"><h2>By dealer</h2><table><thead><tr><th>Dealer</th><th class="r">Approved</th><th class="r">Rejected</th><th class="r">Other</th></tr></thead><tbody>${byDealer.map(([k,g])=>`<tr><td>${esc(k)}</td><td class="r num">${g.approved}</td><td class="r num">${g.rejected}</td><td class="r num">${g.other}</td></tr>`).join("")}</tbody></table></section></div>`
        :`<div class="empty"><p>No past requests.</p></div>`)}`,sh=>{
      $$("[data-aptab]",sh).forEach(b=>b.addEventListener("click",()=>{ tab=b.dataset.aptab; paintSheet(true); }));
      const cv=$("#ap-csv",sh); if(cv) cv.addEventListener("click",()=>save(`approvals-${today()}.csv`,approvalsCsv(hist)));
      $$("[data-apnote]",sh).forEach(el=>el.addEventListener("input",()=>{ notes[el.dataset.apnote]=el.value; }));
      const note=id=>(notes[id]||"").trim();
      $$("[data-approve]",sh).forEach(b=>b.addEventListener("click",()=>guarded(b,async()=>{ const r=await window.APP.approve(b.dataset.approve,note(b.dataset.approve)); toast(`Approved · credit sale ${r.data.txnNo} recorded`); })));
      $$("[data-reject]",sh).forEach(b=>b.addEventListener("click",()=>{ const n=note(b.dataset.reject); if(n.length<3){ toast("Write a note telling staff why"); const el=$(`[data-apnote="${b.dataset.reject}"]`,sh); el&&el.focus(); return; }
        guarded(b,async()=>{ await window.APP.reject(b.dataset.reject,n); toast("Request rejected"); }); }));
      $$("[data-withdraw]",sh).forEach(b=>b.addEventListener("click",()=>{ if(armed(b,"Tap again to withdraw")) guarded(b,async()=>{ await window.APP.withdraw(b.dataset.withdraw); toast("Request withdrawn"); }); }));
    }]; },true);
}
/* ---------- offline payments (FR-086) ---------- */
const offState=()=>window.APP&&window.APP.offline?window.APP.offline():null;
function offlineText(){ const o=offState(); if(!o) return "";
  const n=o.pending, h=o.held.length, w=n?` · ${n} payment${n===1?"":"s"} waiting to sync`:"", r=h?` · ${h} need${h===1?"s":""} review`:"";
  if(!o.online) return `Offline · data from ${o.lastSync?fmtStamp(o.lastSync):"this device"}${w}${r}`;
  if(n) return `${o.syncing?"Syncing":"Waiting to sync"} ${n} payment${n===1?"":"s"}…${r}`;
  return h?`Saved · updates live${r}`:""; }
function offlineNotices(){ const o=offState(); if(!o) return ""; const out=[];
  if(!o.online) out.push(`<div class="notice info"><p><b>You're offline.</b> Showing balances saved on this device${o.lastSync?` at ${esc(fmtStamp(o.lastSync))}`:""}. You can still record payments, sales and returns; they sync automatically when you're back online.</p></div>`);
  if(o.held.length) out.push(`<div class="notice bad"><p><b>${o.held.length} offline record${o.held.length===1?"":"s"} need${o.held.length===1?"s":""} review.</b> The server didn't accept ${o.held.length===1?"it":"them"} when syncing.</p><button class="btn sm" data-act="held-review" type="button">Review</button></div>`);
  return out.join(""); }
function heldSheet(){
  show(()=>{ const o=offState(), held=o?o.held:[];
    return [head("Offline records to review","These were recorded without signal, but the server refused them when syncing.")+(held.length?`<ul class="crm-log">${held.map(h=>{ const d=S.dealers.get(h.data.dealerId); return `<li>
        <div class="crm-meta"><b>${esc(d?d.name:"(dealer removed)")}</b> · ${esc(TYPE_LABEL[h.data.type]||"")} · <b class="num">${P(h.data.amount)}</b></div>
        <div class="small muted">${fmtDate(h.data.date)} · ${esc(h.data.method||"")}${h.data.ref?" · Ref "+esc(h.data.ref):""} · recorded ${esc(fmtStamp(h.data.offline&&h.data.offline.recordedAt))}</div>
        <div class="notice bad" style="margin:8px 0"><p class="small">${esc(h.error)}</p></div>
        <div class="actions"><button class="btn sm" data-held-retry="${esc(h.id)}" type="button">Try again</button>${S.canAdmin?`<button class="btn sm primary" data-held-confirm="${esc(h.id)}" type="button">Record anyway</button>`:""}<button class="btn sm danger" data-held-discard="${esc(h.id)}" type="button">Discard</button></div></li>`; }).join("")}</ul><p class="small muted">“Record anyway” is for an owner or editor who has checked the payment, for example when the dealer was archived after it was collected. Discarding removes it from this device for good.</p>`
      :`<div class="empty"><p>Nothing to review. All offline records have synced.</p></div>`),sh=>{
      $$("[data-held-retry]",sh).forEach(b=>b.addEventListener("click",()=>guarded(b,async()=>{ await window.APP.retryHeld(b.dataset.heldRetry,false); toast(offState().held.some(h=>h.id===b.dataset.heldRetry)?"Still refused":"Payment synced"); paintSheet(true); })));
      $$("[data-held-confirm]",sh).forEach(b=>b.addEventListener("click",()=>guarded(b,async()=>{ await window.APP.retryHeld(b.dataset.heldConfirm,true); toast(offState().held.some(h=>h.id===b.dataset.heldConfirm)?"Still refused":"Payment recorded"); paintSheet(true); })));
      $$("[data-held-discard]",sh).forEach(b=>b.addEventListener("click",()=>{ if(armed(b,"Tap again to discard")) guarded(b,async()=>{ await window.APP.discardHeld(b.dataset.heldDiscard); toast("Payment discarded"); paintSheet(true); }); }));
    }]; },true);
}
function healthNotices(){
  const out=[window.LedgerOps.notices()];
  const nNew=[...S.orders.values()].filter(o=>o.status==="new").length, nReady=[...S.orders.values()].filter(o=>o.status==="ready").length;
  if(nNew||nReady) out.push(`<div class="notice info"><p><b>${nNew?`${nNew} new online order${nNew===1?"":"s"}`:""}${nNew&&nReady?" · ":""}${nReady?`${nReady} ready for pickup`:""}.</b> Prepare items before the dealer arrives.</p><button class="btn sm" data-act="go-orders" type="button">Open orders</button></div>`); const real=[...S.dealers.values()].some(d=>!d.sample);
  const hold=[...S.dealers.keys()].filter(id=>status(id).maxLate>holdDays()).length;
  if(hold) out.push(`<div class="notice bad"><p><b>${hold} dealer${hold===1?" is":"s are"} on credit hold</b> (more than ${holdDays()} days late). New credit sales to them are blocked until they pay.</p><button class="btn sm" data-act="go-collect" type="button">Open collection list</button></div>`);
  const nolim=activeDealers().filter(([,d])=>!d.creditLimit&&!isProspect(d)).length;
  if(nolim&&S.canWrite) out.push(`<div class="notice warn"><p><b>${nolim} dealer${nolim===1?" has":"s have"} no credit limit.</b> Set one for every dealer, even a high one, so the app can stop risky releases.</p><button class="btn sm" data-act="go-dealers" type="button">Review dealers</button></div>`);
  if(S.products.size&&S.canWrite){ const last=[...S.moves.values()].filter(m=>m.reason==="Stock count").map(m=>m.date).sort().pop();
    if(!last||daysBetween(last,today())>30) out.push(`<div class="notice warn"><p><b>Monthly stock count ${last?"is due":"not done yet"}.</b> ${last?`Last count was ${fmtDate(last)}.`:"Count your stock once a month to catch missing items."}</p><button class="btn sm" data-act="count" type="button">Start stock count</button></div>`); }
  if(S.acct&&["owner","editor"].includes(S.acct.role)&&!S.acct.twoStep) out.push(`<div class="notice warn"><p><b>Turn on two-step sign-in.</b> Your account can change prices, credit limits and records, so protect it with a code from your phone.</p><button class="btn sm" data-act="2fa-setup" type="button">Set up</button></div>`);
  { const bp=backupProblems(); if(bp.length) out.push(`<div class="notice ${bp.some(p=>p[0]==="bad")?"bad":"warn"}"><p><b>Backups need attention.</b> ${bp.map(p=>esc(p[1])).join(" ")}</p><button class="btn sm" data-act="go-store" type="button">Backup status</button></div>`); }
  if(downloads&&real&&!window.APP){ const lb=Number(lsGet("lastBackup"))||0; const days=lb?Math.floor((Date.now()-lb)/864e5):null;
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
    ${rows.slice(0,S.collectShow||100).map(({id,d,st})=>`<tr><td><a href="#collect" data-dealer="${id}" style="color:inherit"><b>${esc(d.name)}</b></a>${samplePill(d)}<div class="small" style="user-select:all">${esc(d.phone||"No number")}</div></td>
      <td class="r num nowrap"><b>${P(st.overdue||st.balance)}</b><div class="small muted">${st.overdue?"of "+P(st.balance)+" balance":"due "+fmtDate(st.nextDue)}</div></td>
      <td>${statusPill(st,d)}</td><td class="small nowrap">${d.lastReminded?(d.lastReminded===t0?`<span class="pill good">Today</span>`:fmtDate(d.lastReminded)):"Never"}</td>
      <td class="r"><div class="actions" style="justify-content:flex-end;flex-wrap:nowrap"><button class="btn sm" data-act="remind-copy" data-id="${id}" type="button">Copy message</button>${S.canWrite?`<button class="btn sm" data-act="remind-mark" data-id="${id}" type="button">${d.lastReminded===t0?"Reminded ✓":"Mark reminded"}</button>`:""}</div></td></tr>`).join("")}
    </tbody></table></div>${rows.length>(S.collectShow||100)?`<p class="small muted">Showing the ${S.collectShow||100} most urgent of ${rows.length}. <button class="btn sm" data-act="more-collect" type="button">Show all</button></p>`:""}`:`<div class="empty"><h3>Nobody to chase today</h3><p>No dealer is overdue or due in the next 3 days.</p></div>`}
    <p class="small muted" style="margin:12px 0 0">Copy the message, then paste it in Messenger, Viber or SMS. You can change the wording in the Store tab.</p></section>`;
}
function countSheet(){
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
        for(const [pid,d] of diffs){ await db.collection("moves").doc().set({productId:pid,qty:d,reason:"Stock count",date:d0,note:"Monthly count",createdAt:Date.now(),createdBy:S.me}); await applyStock({[pid]:d}); }
        if(!diffs.length) await db.collection("moves").doc().set({productId:ch[0][0],qty:0,reason:"Stock count",date:d0,note:`Counted ${ch.length} products, all matched`,createdAt:Date.now(),createdBy:S.me});
        toast(diffs.length?`Stock corrected for ${diffs.length} product${diffs.length===1?"":"s"}`:"Count saved. Everything matched."); back(); });
    });
  }]);
}
function openingForm(dealerId,editId){
  if(!activeDealers().length&&!editId){ toast("Add a dealer first"); dealerForm(); return; }
  const old=editId?S.txns.get(editId):null;
  show(()=>[head(old?`Edit opening balance ${esc(old.no||"")}`:"Opening balance","What the dealer already owed before you started using this ledger")+`<form id="f" class="form-grid">
    <label class="f span">Dealer<select id="o-dealer" required><option value="">Choose dealer…</option>${dealerOptions(old?old.dealerId:dealerId)}</select></label>
    <label class="f">Amount owed (₱)<input id="o-amt" type="number" min="0.01" step="0.01" required value="${old?old.amount:""}"></label>
    <label class="f">Date they took the goods<input id="o-date" type="date" required value="${old?old.date:today()}"></label>
    <label class="f">Due date<input id="o-due" type="date" required value="${old?old.dueDate:""}"></label>
    <label class="f span">Note<input id="o-note" value="${esc(old?old.note:"Opening balance")}"></label>
    <p class="hint span" style="margin:0">If they took goods on different dates, add one opening balance per date so the overdue days are right. Stock is not changed.</p>
    <div class="actions span"><button class="btn primary" type="submit">${old?"Save changes":"Add opening balance"}</button><button class="btn" type="button" data-back>Cancel</button></div></form>`,sh=>{
    const setDue=()=>{ if(old) return; const d=S.dealers.get($("#o-dealer").value); $("#o-due").value=addDays($("#o-date").value||today(),d?d.terms??30:(S.settings.defaultTerms??30)); };
    setDue(); $("#o-dealer").addEventListener("change",setDue); $("#o-date").addEventListener("change",setDue);
    $("#f",sh).addEventListener("submit",e=>{ e.preventDefault(); const btn=e.submitter||$("button[type=submit]",sh);
      const did=$("#o-dealer").value, amt=r2($("#o-amt").value); if(!did||amt<=0){ toast("Enter the dealer and amount"); return; }
      const f={dealerId:did,date:$("#o-date").value,dueDate:$("#o-due").value,note:$("#o-note").value.trim()};
      const data=old?{...old,...f,amount:amt,subtotal:amt,updated:stamp()}:openingDoc(did,amt,f.date,f.dueDate,f.note);
      guarded(btn,async()=>{ await db.collection("txns").doc(editId||undefined).set(data); toast(old?"Opening balance updated":`Opening balance ${data.no} added`); back(); });
    });
  }]);
}

/* ---------- receipts ---------- */
function balanceAfter(t){ let run=0; for(const [,x] of dealerTxns(t.dealerId)){ run=r2(run+txnEffect(x)); if(x===t) return run; } return status(t.dealerId).balance; }
const RC_TITLE={sale:"DELIVERY RECEIPT",payment:"ACKNOWLEDGEMENT RECEIPT",return:"RETURN SLIP",adjustment:"ADJUSTMENT NOTE",writeoff:"WRITE-OFF NOTE"};
function receiptText(id){
  const t=S.txns.get(id), d=S.dealers.get(t.dealerId)||{name:"(removed dealer)"}, s=S.settings; const L=[];
  L.push(s.storeName||"Dealer Credit Ledger"); if(s.address||s.phone) L.push([s.address,s.phone].filter(Boolean).join(" · "));
  L.push("",`${t.opening?"OPENING BALANCE":RC_TITLE[t.type]}  ${t.no||""}`,`Date: ${fmtDate(t.date)}`,`Dealer: ${d.name}${d.phone?" ("+d.phone+")":""}`);
  if(t.voided) L.push("*** VOIDED ***");
  if(t.items&&t.items.length){ L.push(""); t.items.forEach((i,k)=>L.push(`${k+1}. ${i.name}\n   ${i.qty} × ${P(i.price)} = ${P(i.qty*i.price)}`)); L.push("");
    if(t.pctDiscount||t.discount) L.push(`${t.pctDiscount?"Total at SRP":"Subtotal"}: ${P(t.subtotal)}`);
    if(t.pctDiscount) L.push(`${discLabel(t)}: −${P(t.pctDiscount)}`);
    if(t.discount) L.push(`Extra discount: −${P(t.discount)}`); }
  L.push(t.type==="sale"?`TOTAL ON CREDIT: ${P(t.amount)}`:t.type==="payment"?`AMOUNT RECEIVED: ${P(t.amount)}`:t.type==="adjustment"?`${t.direction==="debit"?"AMOUNT ADDED":"AMOUNT CREDITED"}: ${P(t.amount)}`:t.type==="writeoff"?`AMOUNT WRITTEN OFF: ${P(t.amount)}`:`TOTAL CREDITED: ${P(t.amount)}`);
  if(t.type==="sale") L.push(`Due date: ${fmtDate(t.dueDate)}`);
  if(t.type==="adjustment"){ if(t.reason) L.push(`Reason: ${t.reason}`); if(t.direction==="debit"&&t.dueDate) L.push(`Due date: ${fmtDate(t.dueDate)}`); }
  if(t.type==="writeoff"&&t.reason) L.push(`Reason: ${t.reason}`);
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
      ${t.offlinePending?`<p class="rc-void no-print-bg" style="color:#8a5a00">${t.offlineHeld?"NEEDS REVIEW · "+esc(t.offlineHeld):"SAVED ON THIS DEVICE · NOT YET SYNCED"}</p><p class="small">Recorded without signal. It syncs automatically when the phone is back online, and the receipt number may change.</p>`:""}
      <dl class="kv rc-kv"><dt>Dealer</dt><dd><b>${esc(d.name)}</b></dd>${d.phone?`<dt>Mobile</dt><dd>${esc(d.phone)}</dd>`:""}${d.area?`<dt>Address</dt><dd>${esc(d.area)}</dd>`:""}
        ${t.type==="sale"?`<dt>Due date</dt><dd><b>${fmtDate(t.dueDate)}</b>${d.terms!=null?` (${d.terms}-day terms)`:""}</dd>`:""}
        ${t.type==="adjustment"?`<dt>Direction</dt><dd><b>${t.direction==="debit"?"Debit — added to balance":"Credit — deducted from balance"}</b></dd>${t.reason?`<dt>Reason</dt><dd>${esc(t.reason)}</dd>`:""}${t.direction==="debit"&&t.dueDate?`<dt>Due date</dt><dd>${fmtDate(t.dueDate)}</dd>`:""}`:""}
        ${t.type==="writeoff"?`<dt>Reason</dt><dd><b>${esc(t.reason||"Bad debt")}</b></dd>`:""}
        ${t.type==="payment"?`<dt>Paid by</dt><dd>${esc(t.method)}${t.ref?" · Ref "+esc(t.ref):""}</dd>${t.payKind?`<dt>Payment</dt><dd><b>${{full:"Full payment",partial:"Partial payment",advance:"Advance payment"}[t.payKind]}</b></dd>`:""}`:""}</dl>
      ${t.type==="payment"&&(t.applied||[]).length?`<table class="rc-tbl"><thead><tr><th>Applied to</th><th class="r">Paid now</th><th class="r">Still owed</th></tr></thead><tbody>${t.applied.map(a=>`<tr><td>${esc(a.no)}${a.chosen?" <small>(chosen)</small>":""}</td><td class="r num">${P(a.amount)}</td><td class="r num">${a.left>0.004?P(a.left):"Fully paid"}</td></tr>`).join("")}</tbody></table>`:""}
      ${items.length?`<table class="rc-tbl"><thead><tr><th>#</th><th>Item</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Amount</th></tr></thead><tbody>
        ${items.map((i,k)=>`<tr><td class="num">${k+1}</td><td>${esc(i.name)}${i.promo?" <small>(promo)</small>":""}${t.discountPct==null&&i.pct!=null?` <small>(less ${i.pct}%)</small>`:""}</td><td class="r num">${i.qty}</td><td class="r num">${P(i.price)}</td><td class="r num">${P(i.qty*i.price)}</td></tr>`).join("")}</tbody>
        <tfoot>${t.pctDiscount||t.discount?`<tr><td colspan="4" class="r">${t.pctDiscount?"Total at SRP":"Subtotal"}</td><td class="r num">${P(t.subtotal)}</td></tr>`:""}${t.pctDiscount?`<tr><td colspan="4" class="r">${discLabel(t)}</td><td class="r num">−${P(t.pctDiscount)}</td></tr>`:""}${t.discount?`<tr><td colspan="4" class="r">Extra discount</td><td class="r num">−${P(t.discount)}</td></tr>`:""}</tfoot></table>`:""}
      <div class="rc-total"><span>${t.type==="sale"?"Total on credit":t.type==="payment"?"Amount received":t.type==="adjustment"?(t.direction==="debit"?"Amount added":"Amount credited"):t.type==="writeoff"?"Amount written off":"Total credited"}</span><b class="num">${P(t.amount)}</b></div>
      ${t.voided?"":`<p class="rc-bal">Balance after this: <b class="num">${P(balanceAfter(t))}</b></p>`}
      ${t.note&&t.note!=="Opening balance"?`<p class="small">Note: ${esc(t.note)}</p>`:""}
      ${t.manualPrice&&S.canWrite?`<p class="small no-print">Manual price${t.priceReason?`: ${esc(t.priceReason)}`:" set by the owner or an editor"}.</p>`:""}
      ${t.type==="sale"&&s.paymentInfo?`<p class="small"><b>How to pay:</b> ${esc(s.paymentInfo)}</p>`:""}
      ${qrBlock(deepLink("receipt",id),"Scan this receipt",`${t.no?t.no+" · ":""}${d.name}`)}
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
  const short=items.filter(i=>availableStock(i.productId,id)<i.qty);
  const backorder=o.backorder||(o.shortItems||[]).length>0;
  const open=["new","preparing","ready"].includes(o.status);
  return [head(`Order ${esc(o.no||"")} ${ordPill(o)}`,`${esc(d?d.name:"(removed dealer)")} · placed ${fmtStamp(o.createdAt)}${o.source==="portal"?" from the dealer portal":""}`)+`
    <dl class="kv"><dt>Pickup</dt><dd><b>${o.pickupDate?fmtDate(o.pickupDate):"Anytime"}</b></dd>${o.note?`<dt>Dealer's note</dt><dd>${esc(o.note)}</dd>`:""}
      ${d?`<dt>Dealer balance</dt><dd class="num">${P(st.balance)}${st.overdue?` · <span style="color:var(--bad)">${P(st.overdue)} overdue</span>`:""}</dd>`:""}${o.saleNo?`<dt>Credit sale</dt><dd><b>${esc(o.saleNo)}</b></dd>`:""}${o.cancelReason?`<dt>Cancelled</dt><dd>${esc(o.cancelReason)}</dd>`:""}</dl>
    ${open&&(o.creditHold||(st&&st.maxLate>holdDays()))?`<div class="notice bad"><p><b>Credit hold</b>${st?` — this dealer is ${st.maxLate} days late`:""}. Collect payment before releasing${S.canAdmin?", or approve the release":""}.</p></div>`:""}
    ${o.overLimit?`<div class="notice warn"><p><b>Over the credit limit.</b> Releasing this order will take the dealer past their limit${S.canAdmin?", unless you approve it":""}.</p></div>`:""}
    ${open&&short.length?`<div class="notice warn"><p><b>${backorder?"Backorder":"Not enough stock"}</b> for ${short.map(i=>esc(i.name)).join(", ")}. Available now: ${short.map(i=>`${esc(i.name)} ${Math.max(0,availableStock(i.productId,id))}/${i.qty}`).join(", ")}.</p></div>`:""}
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
  dash:IC('<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>'),
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
const VIEW_L={dash:"Dashboard",overview:"Overview",orders:"Orders",collect:"Collections",cash:"Cash",dealers:"Dealers",products:"Products",buying:"Buying",activity:"Transactions",reports:"Reports",store:"Store"};
function renderBottomNav(){
  const nav=$("#bnav"); if(!nav) return;
  const main=window.APP?["overview","orders","collect","dealers"]:["overview","collect","dealers","products"];
  const nNew=[...S.orders.values()].filter(o=>o.status==="new").length;
  const inMore=!main.includes(S.view);
  nav.innerHTML=main.map(v=>`<button type="button" data-nav="${v}" aria-current="${S.view===v?"page":"false"}">${ICON[v]}<span>${VIEW_L[v]}</span>${v==="orders"&&nNew?`<b class="nbadge">${nNew}</b>`:""}</button>`).join("")+`<button type="button" data-nav="more" aria-current="${inMore?"page":"false"}">${ICON.more}<span>${inMore?VIEW_L[S.view]:"More"}</span></button>`;
  $("#fab").hidden=!S.canWrite;
}
function moreSheet(){
  const views=["overview",...(S.canAdmin?["dash"]:[]),...(window.APP?["orders"]:[]),"collect","cash","dealers","products","buying","activity","reports","store"];
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
        [...S.dealers.entries()].filter(([,d])=>hit(d.name,d.phone,d.area,d.email,...(d.tags||[]))).slice(0,6).forEach(([id,d])=>{ const st=status(id); items.push({g:"Dealers",ic:"dealers",l:d.name,s:[isProspect(d)||stageOf(d)==="lost"?STAGE_L[stageOf(d)]:"",d.phone,d.area].filter(Boolean).join(" · ")||"Dealer",a:P(st.balance),go:()=>dealerSheet(id)}); });
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
  const isImg=h=>/image|photo|picture|\bimg\b|pic url/.test(h);
  const find=re=>H.findIndex(h=>re.test(h)&&!isImg(h));
  const hasHead=H.some(h=>/name|product|srp|price|code|sku|desc/.test(h));
  const cols=hasHead?{code:find(/code|sku|item ?(no|#)/),name:find(/name|product|desc/),srp:find(/srp|retail|catalog|^price|regular/),promo:find(/promo|sale price|special/),cat:find(/categ|line|group|type/),pct:find(/disc/),from:find(/from|start/),to:find(/until|^to$|end/),img:H.findIndex(isImg)}:{code:0,name:1,srp:2,cat:3,promo:4,pct:-1,from:-1,to:-1,img:-1};
  if(cols.srp===cols.promo) cols.promo=-1;
  const get=(r,k)=>cols[k]>=0?(r[cols[k]]??""):"";
  const items=(hasHead?rows.slice(1):rows).map(r=>({code:get(r,"code"),name:get(r,"name"),srp:money(get(r,"srp")),promo:money(get(r,"promo")),cat:get(r,"cat"),pct:get(r,"pct")===""?null:money(get(r,"pct")),from:get(r,"from"),to:get(r,"to"),img:/^https?:\/\/\S+$/i.test(get(r,"img").trim())?get(r,"img").trim():""})).filter(x=>x.name||x.code);
  return {items,cols,hasHead};
}
function catalogSheet(){
  const t=new Date(); const m0=ymd(new Date(t.getFullYear(),t.getMonth(),1)), m1=ymd(new Date(t.getFullYear(),t.getMonth()+1,0));
  const defName=t.toLocaleDateString("en-PH",{month:"long",year:"numeric"})+" catalog";
  show(()=>[head("Update catalog","Paste the new Personal Collection price list, check the changes, then apply them all at once.")+`
    <div class="form-grid">
      <label class="f span">Price list<textarea id="c-text" rows="7" placeholder="Copy rows from Excel or Google Sheets and paste here.&#10;Columns: Code, Product name, SRP, Category, Promo price&#10;&#10;PC-1001	Dishwashing Liquid 1L	145	Home care	&#10;PC-2003	Fabric Conditioner 1L	185	Laundry	159"></textarea><span class="hint">A header row is optional. Columns are recognised by name (code, name, SRP, promo, category, discount, image); without headers the order above is used. Add an “Image” column with picture links to download product photos too. You can also open a CSV file.</span></label>
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
    const match=it=>{ const hits=findProductMatches(S.products,{name:it.name,code:it.code}).filter(m=>m.strong); return (hits.find(m=>m.why.some(y=>y.what==="code"))||hits[0]||{}).id||null; };
    const preview=()=>{ const {items,cols,hasHead}=catalogRows($("#c-text",sh).value); const box=$("#c-prev",sh);
      if(!items.length){ plan=null; box.innerHTML=""; return; }
      const seen=new Set(); const rows=items.map(it=>{ const id=match(it); if(id) seen.add(id); const p=id?S.products.get(id):null;
        const st=!p?"new":(it.srp!=null&&Number(p.srp)!==it.srp)?"change":(it.promo?"promo":"same"); return {it,id,p,st}; });
      const bad=rows.filter(r=>r.st==="new"&&!(r.it.srp>0)&&!(r.it.promo>0));
      const missing=[...S.products.entries()].filter(([id,p])=>p.active!==false&&!seen.has(id));
      const c=k=>rows.filter(r=>r.st===k).length, nPromo=rows.filter(r=>r.it.promo).length;
      const imgRows=rows.filter(r=>r.it.img&&(r.p||r.it.srp>0||r.it.promo>0)&&(!r.p||!r.p.imageId||r.p.imageLink!==r.it.img));
      plan={rows,missing,imgRows};
      const lab={new:`<span class="pill good">New</span>`,change:`<span class="pill warn">Price change</span>`,promo:`<span class="pill sample">Promo</span>`,same:`<span class="pill neutral">No change</span>`};
      box.innerHTML=`<div class="stat-row"><div class="kpi"><div class="lbl">New products</div><div class="val num">${c("new")}</div></div><div class="kpi"><div class="lbl">Price changes</div><div class="val num">${c("change")}</div></div><div class="kpi"><div class="lbl">Promos</div><div class="val num">${nPromo}</div></div><div class="kpi"><div class="lbl">Not in catalog</div><div class="val num">${missing.length}</div></div></div>
        ${!hasHead?`<p class="small muted">No header row found, so columns were read as Code, Name, SRP, Category, Promo price.</p>`:cols.name<0&&cols.code<0?`<div class="notice bad"><p>Couldn't find a product name or code column. Add a header row like “Code, Name, SRP”.</p></div>`:""}
        ${bad.length?`<div class="notice warn"><p>${bad.length} new product${bad.length===1?" has":"s have"} no SRP and will be skipped.</p></div>`:""}
        ${imgRows.length&&assets&&assets.fromUrl?`<label class="chk"><input type="checkbox" id="c-img" checked> Download ${imgRows.length} product picture${imgRows.length===1?"":"s"} from the Image column (only for products with no photo or a different link)</label>`:""}
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
        d.updated=stamp(); jobs.push([id,d,it.img&&plan.imgRows.some(r=>r.it===it)?it.img:""]);
      }
      for(const [id,p] of plan.missing){ if(arch) jobs.push([id,{...p,active:false,updated:stamp()}]); else if(clr&&p.promo) jobs.push([id,{...p,promo:null,updated:stamp()}]); }
      const pr=$("#c-prog",sh); pr.hidden=false; let k=0; const wantImg=!!($("#c-img",sh)&&$("#c-img",sh).checked); const pics=[];
      const total=jobs.length+(wantImg?jobs.filter(j=>j[2]).length:0);
      const skipped=[];
      for(const [id,d,img] of jobs){ const ref=db.collection("products").doc(id||undefined); try{ await ref.set(d); if(wantImg&&img) pics.push([ref.id,img,d.imageId||null]); }catch(err){ if(err&&err.code==="duplicate") skipped.push(d.name); else throw err; } k++; $("i",pr).style.width=(k/total*100)+"%"; }
      let got=0; const failed=[];
      for(const [pid,img,old] of pics){ btn.textContent=`Downloading pictures ${got+failed.length+1} of ${pics.length}…`;
        try{ const up=await assets.fromUrl(img); await db.doc("products/"+pid).update({imageId:up.id,imageLink:up.source||img,updated:stamp()}); if(old) assets.delete(old).catch(()=>{}); got++; }
        catch(e){ failed.push((S.products.get(pid)||{}).name||img); }
        k++; $("i",pr).style.width=(k/total*100)+"%"; }
      if(S.canAdmin) await db.doc("settings/store").set({...S.settings,catalogName:name,catalogAt:now});
      toast(`${name} applied · ${jobs.length-skipped.length} product${jobs.length-skipped.length===1?"":"s"} updated${skipped.length?` · ${skipped.length} skipped as duplicates (${skipped.slice(0,3).join(", ")}${skipped.length>3?"…":""})`:""}${got?` · ${got} picture${got===1?"":"s"}`:""}${failed.length?` · ${failed.length} picture${failed.length===1?"":"s"} couldn't be downloaded (${failed.slice(0,3).join(", ")}${failed.length>3?"…":""})`:""}`,failed.length?"error":undefined); back();
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
/* ---------- dealer CRM: stages, contact log, follow-ups ---------- */
const STAGES=["lead","contacted","interested","dealer","lost"];
const STAGE_L={lead:"New lead",contacted:"Contacted",interested:"Interested",dealer:"Dealer",lost:"Lost"};
const STAGE_C={lead:"neutral",contacted:"neutral",interested:"warn",dealer:"good",lost:"bad"};
const SOURCES=["Referral","Walk-in","Facebook","Event","Recruited by a dealer","Other"];
const KINDS=["call","visit","message","meeting","note"];
const KIND_L={call:"Call",visit:"Visit",message:"Message",meeting:"Meeting",note:"Note"};
const stageOf=d=>(d&&d.stage)||"dealer";
const isProspect=d=>["lead","contacted","interested"].includes(stageOf(d));
const stagePill=d=>`<span class="pill ${STAGE_C[stageOf(d)]}">${STAGE_L[stageOf(d)]}</span>`;
// Personal details: names are kept as parts and joined into the display name.
const GENDERS=[["","Not specified"],["male","Male"],["female","Female"]];
const GENDER_L=Object.fromEntries(GENDERS);
const ageHint=b=>{ const a=Credit.ageOn(b,today()); return a==null?"Optional. Age is worked out from this.":`Age ${a}`; };
function nameParts(d){
  if(d&&(d.firstName||d.middleName||d.lastName)) return {first:String(d.firstName||"").trim(),middle:String(d.middleName||"").trim(),last:String(d.lastName||"").trim()};
  const p=Credit.splitName(d&&d.name); return {first:p.firstName,middle:p.middleName,last:p.lastName};
}
const fullName=(first,middle,last)=>[first,middle,last].map(x=>String(x||"").trim().replace(/\s+/g," ")).filter(Boolean).join(" ");
// Duplicate checks for the dealer and product forms. Text ignores case, accents and punctuation.
const normText=Credit.normText;
// The last 10 digits, so 0917 123 4567 and +63 917 123 4567 are the same number.
const phoneKey=Credit.phoneKey;
function sameWords(a,b){ return [...new Set(a)].sort().join(" ")===[...new Set(b)].sort().join(" "); }
// True when two texts differ by one typo: a changed, added, missing or swapped character.
function oneEditApart(a,b){
  if(a===b) return true;
  if(Math.abs(a.length-b.length)>1) return false;
  let i=0; while(i<a.length&&a[i]===b[i]) i++;
  if(a.length===b.length) return a.slice(i+1)===b.slice(i+1)||(a[i]===b[i+1]&&a[i+1]===b[i]&&a.slice(i+2)===b.slice(i+2));
  const [short,long]=a.length<b.length?[a,b]:[b,a];
  return short.slice(i)===long.slice(i+1);
}
// Numbers must agree, so “Liquid 1L” and “Liquid 2L” are different products, not a typo.
function nearText(a,b){ return a.length>=8&&b.length>=8&&a.replace(/\D/g,"")===b.replace(/\D/g,"")&&oneEditApart(a,b); }
function rankMatches(out){ return out.sort((a,b)=>b.strong-a.strong||(a.item.active===false)-(b.item.active===false)||String(a.item.name).localeCompare(String(b.item.name))); }
// Records that look like the one being entered. “Strong” means the same mobile, email, code or name.
function findDealerMatches(dealers,form,exceptId){
  const n=normText(form.name), words=n?n.split(" "):[], ph=phoneKey(form.phone), em=String(form.email||"").trim().toLowerCase(), out=[];
  for(const [id,d] of dealers){
    if(id===exceptId||d.anonymised) continue;
    const m=normText(d.name), w=m?m.split(" "):[], why=[];
    if(ph&&phoneKey(d.phone)===ph) why.push({slot:"contact",strong:true,what:"mobile number"});
    if(em&&String(d.email||"").trim().toLowerCase()===em) why.push({slot:"contact",strong:true,what:"email"});
    if(n&&m){
      if(sameWords(words,w)) why.push({slot:"name",strong:true,what:"name"});
      else if(words.length>1&&w.length>1&&((words[0]===w[0]&&words.at(-1)===w.at(-1))||nearText(n,m))) why.push({slot:"name",strong:false,what:"name"});
    }
    if(why.length) out.push({id,item:d,why,strong:why.some(x=>x.strong)});
  }
  return rankMatches(out);
}
// “1 L” and “1L” count as the same size.
const productWords=Credit.productWords;
function findProductMatches(products,form,exceptId){
  const words=productWords(form.name), n=words.join(" "), code=normText(form.code).replace(/ /g,""), barcode=normText(form.barcode).replace(/ /g,""), out=[];
  for(const [id,p] of products){
    if(id===exceptId) continue;
    const w=productWords(p.name), m=w.join(" "), why=[];
    if(code&&normText(p.code).replace(/ /g,"")===code) why.push({slot:"product",strong:true,what:"code"});
    if(barcode&&normText(p.barcode).replace(/ /g,"")===barcode) why.push({slot:"product",strong:true,what:"barcode"});
    if(n&&m){
      const [short,long]=words.length<=w.length?[words,w]:[w,words];
      if(sameWords(words,w)) why.push({slot:"product",strong:true,what:"name"});
      else if((short.length>=2&&short.every(x=>long.includes(x)))||nearText(n,m)) why.push({slot:"product",strong:false,what:"name"});
    }
    if(why.length) out.push({id,item:p,why,strong:why.some(x=>x.strong)});
  }
  return rankMatches(out);
}
// The “already in your list” box. detail(match) gives the line that helps tell records apart.
function dupPanel(matches,slot,detail){
  const rows=matches.filter(m=>m.why.some(y=>y.slot===slot));
  if(!rows.length) return "";
  const strong=rows.some(m=>m.why.some(y=>y.slot===slot&&y.strong));
  return `<div class="notice ${strong?"bad":"warn"} dup-box"><p class="small"><b>${strong?"Already in your list":"Is this the same as…"}</b></p>
    ${rows.slice(0,3).map(m=>{ const why=m.why.filter(y=>y.slot===slot).map(y=>`${y.strong?"Same":"Similar"} ${y.what}`).join(", ");
      return `<div class="dup-row"><div><b>${esc(m.item.name)}</b>${m.item.active===false?` <span class="pill neutral">Archived</span>`:""}<div class="small muted">${esc(why)}${detail(m)?" · "+esc(detail(m)):""}</div></div><button class="btn sm" type="button" data-dup-open="${esc(m.id)}">Open</button></div>`; }).join("")}
    ${rows.length>3?`<p class="small muted">and ${rows.length-3} more</p>`:""}</div>`;
}
const CRM_CACHE={key:null,map:new Map()};
function crmInfo(id){
  if(CRM_CACHE.key!==S._ver){ CRM_CACHE.key=S._ver; CRM_CACHE.map=new Map();
    S.interactions.forEach((x,k)=>{ const m=CRM_CACHE.map.get(x.dealerId)||{log:[],open:[]}; m.log.push([k,x]); if(x.followUp&&!x.followUpDone) m.open.push([k,x]); CRM_CACHE.map.set(x.dealerId,m); });
    CRM_CACHE.map.forEach(m=>{ m.log.sort((a,b)=>(b[1].date||"").localeCompare(a[1].date||"")||(b[1].createdAt||0)-(a[1].createdAt||0)); m.open.sort((a,b)=>a[1].followUp.localeCompare(b[1].followUp)); m.last=m.log[0]?m.log[0][1].date:null; m.next=m.open[0]||null; }); }
  return CRM_CACHE.map.get(id)||{log:[],open:[],last:null,next:null};
}
function followUpCell(id){
  const c=crmInfo(id), t0=today();
  if(c.next){ const f=c.next[1].followUp; return `<span class="pill ${f<t0?"bad":f===t0?"warn":"neutral"}">${f<t0?"Overdue":f===t0?"Today":fmtDate(f)}</span>`; }
  return c.last?`<span class="muted">Last ${fmtDate(c.last)}</span>`:`<span class="muted">—</span>`;
}
const telHref=p=>"tel:"+String(p||"").replace(/[^\d+]/g,"");
function contactLinks(d){
  const L=[]; if(d.phone){ L.push(`<a class="btn sm" href="${telHref(d.phone)}">Call</a>`,`<a class="btn sm" href="sms:${esc(String(d.phone).replace(/[^\d+]/g,""))}">Text</a>`); }
  if(d.email) L.push(`<a class="btn sm" href="mailto:${esc(d.email)}">Email</a>`);
  if(d.messenger&&/^https?:\/\//i.test(d.messenger)) L.push(`<a class="btn sm" href="${esc(d.messenger)}" target="_blank" rel="noopener">Messenger</a>`);
  return L.join("");
}
function crmPanel(id){
  const d=S.dealers.get(id), c=crmInfo(id), t0=today();
  resolveNames(c.log.map(([,x])=>x.createdBy));
  return `<section class="panel" style="margin-bottom:16px">
    <div class="panel-head"><h2>Contact log</h2><div class="actions">${contactLinks(d)}${S.canWrite?`<button class="btn sm primary" data-act="log-contact" data-id="${id}" type="button">+ Log contact</button>`:""}</div></div>
    <dl class="kv">
      <dt>Stage</dt><dd>${S.canWrite?`<select id="crm-stage" data-id="${id}" aria-label="Change stage" style="width:auto;min-width:10em">${STAGES.map(s=>`<option value="${s}" ${s===stageOf(d)?"selected":""}>${STAGE_L[s]}</option>`).join("")}</select>`:stagePill(d)}</dd>
      ${d.email?`<dt>Email</dt><dd>${esc(d.email)}</dd>`:""}${d.address?`<dt>Address</dt><dd>${esc(d.address)}</dd>`:""}${Credit.ageOn(d.birthday,today())!=null?`<dt>Age</dt><dd>${Credit.ageOn(d.birthday,today())}</dd>`:""}${d.gender?`<dt>Gender</dt><dd>${esc(GENDER_L[String(d.gender).toLowerCase()]||d.gender)}</dd>`:""}${d.birthday?`<dt>Birthday</dt><dd>${fmtDate(d.birthday)}</dd>`:""}
      ${d.source||d.referredBy?`<dt>Source</dt><dd>${esc([d.source,d.referredBy&&"referred by "+d.referredBy].filter(Boolean).join(" · "))}</dd>`:""}
      ${(d.tags||[]).length?`<dt>Tags</dt><dd>${d.tags.map(t=>`<span class="pill neutral">${esc(t)}</span>`).join(" ")}</dd>`:""}
      <dt>Last contact</dt><dd>${c.last?fmtDate(c.last):"Never"}</dd>
      <dt>Privacy consent</dt><dd>${d.consent?`${esc(CONSENT_L[d.consent.method]||d.consent.method)} · ${fmtStamp(d.consent.at)}${d.consent.noticeVersion&&S.settings.privacyVersion&&d.consent.noticeVersion!==S.settings.privacyVersion?` <span class="pill warn">older notice</span>`:""}`:`<span class="pill warn">Not recorded</span>`}</dd>
    </dl>
    ${window.APP&&S.acct&&S.acct.role==="owner"?`<div class="actions" style="margin-top:8px"><button class="btn sm" data-act="pd-export" data-id="${id}" type="button">Export personal data</button><button class="btn sm danger" data-act="pd-remove" data-id="${id}" type="button">Remove personal data…</button></div>`:""}
    ${c.log.length?`<ul class="crm-log">${c.log.slice(0,30).map(([k,x])=>{ const fu=x.followUp; const due=fu&&!x.followUpDone; return `<li>
      <div class="crm-meta"><span class="pill neutral">${KIND_L[x.kind]||esc(x.kind)}</span> <b>${fmtDate(x.date)}</b> <span class="small muted">· ${esc(nameOf(x.createdBy))}</span></div>
      ${x.outcome?`<div><b>${esc(x.outcome)}</b></div>`:""}${x.note?`<div class="small" style="white-space:pre-wrap">${esc(x.note)}</div>`:""}
      ${fu?`<div class="small crm-fu">${due?`<span class="pill ${fu<t0?"bad":fu===t0?"warn":"neutral"}">Follow up ${fu===t0?"today":fmtDate(fu)}</span>${S.canWrite?` <button class="btn sm" data-act="fu-done" data-id="${k}" type="button">Mark done</button>`:""}`:`<span class="pill good">Followed up</span>`}</div>`:""}
      ${S.canWrite&&(S.canAdmin||x.createdBy===S.me)?`<div class="crm-edit"><button class="btn sm" data-act="edit-contact" data-id="${k}" type="button">Edit</button></div>`:""}
    </li>`; }).join("")}</ul>${c.log.length>30?`<p class="small muted">Showing the latest 30 of ${c.log.length}.</p>`:""}`
    :`<p class="small muted" style="margin:0">No calls, visits or messages logged yet.</p>`}
  </section>`;
}
function contactForm(dealerId,editId){
  show(()=>{ const x=editId?S.interactions.get(editId):{dealerId,kind:"call",date:today(),outcome:"",note:"",followUp:""}; if(!x) return [head("Contact not found")];
    const did=x.dealerId, d=S.dealers.get(did)||{name:""};
    return [head(editId?"Edit contact":"Log contact",esc(d.name))+`<form id="f" class="form-grid">
      <label class="f">Type<select id="c-kind">${KINDS.map(k=>`<option value="${k}" ${k===x.kind?"selected":""}>${KIND_L[k]}</option>`).join("")}</select></label>
      <label class="f">Date<input id="c-date" type="date" required value="${esc(x.date)}" max="${today()}"></label>
      <label class="f span">Outcome<input id="c-out" maxlength="200" value="${esc(x.outcome)}" placeholder="e.g. Promised to pay Friday · Interested in the starter kit"></label>
      <label class="f span">Notes<textarea id="c-note" maxlength="2000" rows="4" placeholder="What was discussed">${esc(x.note)}</textarea></label>
      <label class="f">Follow up on<input id="c-fu" type="date" value="${esc(x.followUp||"")}" min="${editId?"":today()}"><span class="hint">Leave blank if no follow-up is needed.</span></label>
      ${!editId&&isProspect(d)?`<label class="f">Move to stage<select id="c-stage">${STAGES.map(s=>`<option value="${s}" ${s===stageOf(d)?"selected":""}>${STAGE_L[s]}</option>`).join("")}</select></label>`:""}
      <div class="actions span"><button class="btn primary" type="submit">${editId?"Save changes":"Save contact"}</button><button class="btn" type="button" data-back>Cancel</button>
      ${editId&&S.canAdmin?`<button class="btn danger" type="button" id="c-del" style="margin-left:auto">Delete</button>`:""}</div></form>`,sh=>{
      $("#f",sh).addEventListener("submit",e=>{ e.preventDefault(); const btn=e.submitter||$("button[type=submit]",sh);
        const fu=$("#c-fu",sh).value||null;
        const data={...x,dealerId:did,kind:$("#c-kind",sh).value,date:$("#c-date",sh).value||today(),outcome:$("#c-out",sh).value.trim(),note:$("#c-note",sh).value.trim(),followUp:fu,followUpDone:fu&&fu===x.followUp?!!x.followUpDone:false,updated:stamp()};
        if(!editId){ data.createdAt=Date.now(); data.createdBy=S.me; }
        const st=$("#c-stage",sh)&&$("#c-stage",sh).value;
        guarded(btn,async()=>{ await db.collection("interactions").doc(editId||undefined).set(data);
          if(st&&st!==stageOf(d)) await db.doc("dealers/"+did).update({stage:st,updated:stamp()});
          toast(editId?"Contact updated":fu?`Saved. Follow-up set for ${fmtDate(fu)}`:"Contact saved"); back(); });
      });
      const del=$("#c-del",sh); if(del) del.addEventListener("click",()=>{ if(armed(del,"Tap again to delete")) guarded(del,async()=>{ await db.doc("interactions/"+editId).delete(); toast("Contact deleted"); back(); }); });
    }]; });
}
async function markFollowUpDone(id,btn){
  await guarded(btn,async()=>{ await db.doc("interactions/"+id).update({followUpDone:true,followUpDoneAt:Date.now(),followUpDoneBy:S.me}); toast("Follow-up done"); });
}
function followUpsPanel(){
  const t0=today(), t7=addDays(t0,7), rows=[];
  S.dealers.forEach((d,id)=>{ if(d.active===false) return; crmInfo(id).open.forEach(([k,x])=>{ if(x.followUp<=t7) rows.push({id,d,k,x}); }); });
  rows.sort((a,b)=>a.x.followUp.localeCompare(b.x.followUp));
  const prospects=[...S.dealers.values()].filter(d=>d.active!==false&&isProspect(d)).length;
  return `<section class="panel">
    <div class="panel-head"><h2>Follow-ups</h2><span class="small muted">${prospects} prospect${prospects===1?"":"s"} in the pipeline</span></div>
    ${rows.length?`<div class="tbl-wrap"><table><tbody>${rows.slice(0,12).map(({id,d,k,x})=>`<tr class="click" tabindex="0" data-dealer="${id}"><td><b>${esc(d.name)}</b> ${isProspect(d)?stagePill(d):""}<div class="small muted">${KIND_L[x.kind]} ${fmtDate(x.date)}${x.outcome?" · "+esc(x.outcome):""}</div></td>
      <td class="small nowrap"><span class="pill ${x.followUp<t0?"bad":x.followUp===t0?"warn":"neutral"}">${x.followUp<t0?`${daysBetween(x.followUp,t0)}d overdue`:x.followUp===t0?"Today":fmtDate(x.followUp)}</span></td>
      ${S.canWrite?`<td class="r"><button class="btn sm" data-act="fu-done" data-id="${k}" type="button">Done</button></td>`:""}</tr>`).join("")}</tbody></table></div>${rows.length>12?`<p class="small muted">And ${rows.length-12} more.</p>`:""}`
    :`<p class="muted small" style="margin:0">No follow-ups due in the next 7 days.</p>`}
  </section>`;
}
/* ---------- dealer photo with crop ---------- */
// Shows `src` inside `box` with a square selection the user can drag and resize
// (mouse, touch or arrow keys). Resolves with a 480×480 JPEG of the chosen part,
// or null if cancelled.
function cropPicture(box,src){
  return new Promise(resolve=>{
    box.hidden=false;
    box.innerHTML=`<div class="crop-head"><b>Choose the part to keep</b><span class="small muted">Drag the square to move it. Drag its corner to make it bigger or smaller.</span></div>
      <div class="crop-stage"><img class="crop-img" alt="Picture to crop"><div class="crop-box" tabindex="0" role="slider" aria-label="Crop area. Use arrow keys to move, Shift and arrow keys to resize."><span class="crop-h" aria-hidden="true"></span></div></div>
      <div class="actions" style="margin-top:10px"><button class="btn primary" type="button" data-crop="ok">Use this part</button><button class="btn" type="button" data-crop="cancel">Cancel</button></div>`;
    const img=$(".crop-img",box), sel=$(".crop-box",box), stage=$(".crop-stage",box);
    let r={x:0,y:0,s:0}, W=0, H=0;
    const draw=()=>{ sel.style.left=r.x+"px"; sel.style.top=r.y+"px"; sel.style.width=sel.style.height=r.s+"px"; };
    const clamp=()=>{ r.s=Math.max(40,Math.min(r.s,W,H)); r.x=Math.max(0,Math.min(r.x,W-r.s)); r.y=Math.max(0,Math.min(r.y,H-r.s)); draw(); };
    img.onload=()=>{ W=img.clientWidth; H=img.clientHeight; r.s=Math.round(Math.min(W,H)*0.8); r.x=Math.round((W-r.s)/2); r.y=Math.round((H-r.s)/2); clamp(); sel.focus({preventScroll:true}); };
    img.onerror=()=>{ toast("That picture couldn't be opened"); done(null); };
    img.src=src;
    let drag=null;
    stage.addEventListener("pointerdown",e=>{ if(!W) return; const resize=e.target.classList.contains("crop-h"), inBox=e.target===sel||resize; if(!inBox) return;
      e.preventDefault(); stage.setPointerCapture(e.pointerId); drag={resize,px:e.clientX,py:e.clientY,start:{...r}}; });
    stage.addEventListener("pointermove",e=>{ if(!drag) return; const dx=e.clientX-drag.px, dy=e.clientY-drag.py;
      if(drag.resize){ r.s=drag.start.s+Math.max(dx,dy); r.x=drag.start.x; r.y=drag.start.y; } else { r.x=drag.start.x+dx; r.y=drag.start.y+dy; r.s=drag.start.s; } clamp(); });
    const end=()=>{ drag=null; }; stage.addEventListener("pointerup",end); stage.addEventListener("pointercancel",end);
    sel.addEventListener("keydown",e=>{ const k={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key]; if(!k) return; e.preventDefault(); const step=e.altKey?1:10;
      if(e.shiftKey) r.s+=(k[0]||-k[1])*step; else { r.x+=k[0]*step; r.y+=k[1]*step; } clamp(); });
    const done=v=>{ box.hidden=true; box.innerHTML=""; resolve(v); };
    box.addEventListener("click",e=>{ const b=e.target.closest("[data-crop]"); if(!b) return;
      if(b.dataset.crop==="cancel") return done(null);
      const k=img.naturalWidth/W, c=document.createElement("canvas"); c.width=c.height=480;
      c.getContext("2d").drawImage(img,Math.round(r.x*k),Math.round(r.y*k),Math.round(r.s*k),Math.round(r.s*k),0,0,480,480);
      c.toBlob(b2=>done(b2),"image/jpeg",0.88); });
  });
}
const avatar=(d,size)=>d&&d.photoId?`<img class="avatar" src="${imgUrl(d.photoId)}" alt="" width="${size||40}" height="${size||40}" loading="lazy">`:`<span class="avatar ph" style="width:${size||40}px;height:${size||40}px;font-size:${Math.round((size||40)*0.4)}px" aria-hidden="true">${esc(((d&&d.name)||"?").trim().split(/\s+/).slice(0,2).map(w=>w[0]).join("").toUpperCase())}</span>`;
function dealerForm(id,preStage){
  show(()=>{ const d=id?S.dealers.get(id):{name:"",firstName:"",middleName:"",lastName:"",gender:"",phone:"",area:"",address:"",creditLimit:S.settings.defaultLimit??"",terms:S.settings.defaultTerms??30,notes:"",stage:preStage||"dealer"}; const hasTx=id&&dealerTxns(id,true).length;
  const stg=stageOf(d), prospect=isProspect(d), nm=nameParts(d);
  return [head(id?"Edit "+(prospect?"prospect":"dealer"):(prospect?"New prospect":"New dealer"),id?"":"Contact details, where they came from and their credit terms.")+`<form id="f" class="form-grid">
    <h3 class="span form-sec">Personal details</h3>
    ${assets?`<div class="f span"><span>Photo</span><div class="photo-row"><div id="d-prev">${avatar({...d,name:fullName(nm.first,nm.middle,nm.last)},88)}</div>
      <div class="actions"><label class="btn sm" for="d-file" style="cursor:pointer">${d.photoId?"Change photo":"Add photo"}</label><input id="d-file" type="file" accept="image/*" hidden>
        <label class="btn sm" for="d-cam" style="cursor:pointer">Take photo</label><input id="d-cam" type="file" accept="image/*" capture="user" hidden>
        <button class="btn sm" type="button" id="d-recrop" ${d.photoId?"":"hidden"}>Adjust crop</button><button class="btn sm" type="button" id="d-rmphoto" ${d.photoId?"":"hidden"}>Remove</button></div></div>
      <span class="hint">You can also paste a picture (Ctrl+V). You choose which part to keep.</span><div id="d-cropper" class="cropper" hidden></div></div>`:""}
    <div class="span name-block">
      <div class="name-fields">
        <label class="f"><span>First name<span class="req" aria-hidden="true">*</span></span><input id="d-first" required maxlength="60" autocomplete="given-name" autocapitalize="words" value="${esc(nm.first)}" placeholder="e.g. Juana"></label>
        <label class="f">Middle name<input id="d-middle" maxlength="60" autocomplete="additional-name" autocapitalize="words" value="${esc(nm.middle)}" placeholder="e.g. Santos"></label>
        <label class="f"><span>Last name<span class="req" aria-hidden="true">*</span></span><input id="d-last" required maxlength="60" autocomplete="family-name" autocapitalize="words" value="${esc(nm.last)}" placeholder="e.g. Dela Cruz"></label>
      </div>
      <span class="hint">Saved as <b class="name-preview" id="d-name-prev">${esc(fullName(nm.first,nm.middle,nm.last)||"—")}</b></span>
      <div class="dup-slot" id="d-dup-name" role="status" aria-live="polite"></div>
    </div>
    <label class="f">Gender<select id="d-gender">${GENDERS.map(([v,l])=>`<option value="${v}" ${String(d.gender||"").toLowerCase()===v?"selected":""}>${l}</option>`).join("")}</select></label>
    <label class="f">Birthday<input id="d-bday" type="date" value="${esc(d.birthday||"")}" max="${today()}" autocomplete="bday"><span class="hint" id="d-age-hint">${ageHint(d.birthday)}</span></label>
    <label class="f span">Full address<textarea id="d-addr" rows="2" maxlength="300" autocomplete="street-address" placeholder="House no., street, barangay, city">${esc(d.address||"")}</textarea></label>
    <h3 class="span form-sec">Contact</h3>
    <label class="f">Mobile number<input id="d-phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="40" value="${esc(d.phone)}" placeholder="0917 123 4567"></label>
    <label class="f">Email<input id="d-email" type="email" autocomplete="email" maxlength="120" value="${esc(d.email||"")}" placeholder="name@example.com"></label>
    <div class="span dup-slot" id="d-dup-contact" role="status" aria-live="polite"></div>
    <label class="f">Messenger / Facebook link<input id="d-msgr" type="url" value="${esc(d.messenger||"")}" placeholder="https://m.me/username"></label>
    <label class="f">Area / barangay<input id="d-area" autocomplete="address-level3" maxlength="120" value="${esc(d.area)}" placeholder="e.g. Brgy. San Isidro, QC"></label>
    <h3 class="span form-sec">Relationship</h3>
    <label class="f">Stage<select id="d-stage">${STAGES.map(s=>`<option value="${s}" ${s===stg?"selected":""}>${STAGE_L[s]}</option>`).join("")}</select><span class="hint">Prospects become dealers automatically on their first credit sale.</span></label>
    <label class="f">Source<select id="d-src"><option value="">—</option>${SOURCES.map(s=>`<option ${s===d.source?"selected":""}>${s}</option>`).join("")}</select></label>
    <label class="f">Referred by<input id="d-ref" value="${esc(d.referredBy||"")}" placeholder="Name of the person who referred them"></label>
    <label class="f">Tags<input id="d-tags" value="${esc((d.tags||[]).join(", "))}" placeholder="e.g. VIP, Weekend seller" list="d-taglist"><datalist id="d-taglist">${allTags().map(t=>`<option value="${esc(t)}">`).join("")}</datalist><span class="hint">Separate tags with commas.</span></label>
    <h3 class="span form-sec">Privacy consent</h3>
    <label class="f">Consent to use their personal data<select id="d-consent"><option value="">Not recorded</option>${["signed form","verbal"].map(m=>`<option value="${m}" ${d.consent&&d.consent.method===m?"selected":""}>${CONSENT_L[m]}</option>`).join("")}${d.consent&&d.consent.method==="portal"?`<option value="portal" selected>${CONSENT_L.portal}</option>`:""}</select>
      <span class="hint">${d.consent?`Recorded ${fmtStamp(d.consent.at)}${d.consent.noticeVersion?` for notice ${esc(d.consent.noticeVersion)}`:""}.`:"Record how the dealer agreed to the privacy notice in Store → Privacy."}</span></label>
    <h3 class="span form-sec">Credit terms</h3>
    <label class="f">Credit limit (₱)<input id="d-limit" type="number" min="0" step="0.01" value="${esc(d.creditLimit??"")}" placeholder="Blank = no limit" ${S.canAdmin?"":"disabled"}><span class="hint">${S.canAdmin?"Recommended. Sales over the limit need owner approval.":"Only the owner or an editor can set credit limits."}</span></label>
    <label class="f">Payment terms (days)<input id="d-terms" type="number" min="0" step="1" value="${esc(d.terms??30)}" ${S.canAdmin?"":"disabled"}></label>
    <label class="f">Dealer discount (%)<input id="d-pct" type="number" min="0" max="100" step="0.01" value="${esc(d.discountPct??"")}" placeholder="Store default ${storePct()}%" ${S.canAdmin?"":"disabled"}><span class="hint">Leave blank to use the store default.</span></label>
    ${id||prospect?"":`<div class="span notice info" style="margin:0"><p class="small"><b>Already owes you money?</b> Enter what they owe now so balances and overdue days are right from day one.</p></div>
    <label class="f">Current balance owed (₱)<input id="d-ob" type="number" min="0" step="0.01" placeholder="0.00"></label>
    <label class="f">Date they took those goods<input id="d-obdate" type="date" value="${today()}"></label>`}
    ${id?"":`<label class="f">First follow-up<input id="d-fu" type="date" min="${today()}" value="${prospect?addDays(today(),3):""}"><span class="hint">Adds a reminder to the Follow-ups list.</span></label>`}
    ${S.canAdmin&&(S.team||[]).some(u=>u.collector)?`<label class="f">Collector<select id="d-coll"><option value="">Nobody yet</option>${(S.team||[]).filter(u=>u.collector&&u.active).map(u=>`<option value="${esc(u.id)}" ${d.collectorId===u.id?"selected":""}>${esc(u.name)}</option>`).join("")}</select></label>
    <label class="f">Route order<input id="d-route" type="number" min="1" step="1" value="${esc(d.routeOrder??"")}" placeholder="1 = first stop"></label>`:""}
    <label class="chk span"><input type="checkbox" id="d-nomsg" ${d.noReminders?"checked":""}> Don't send this dealer automatic reminders</label>
    <label class="f span">Notes<textarea id="d-notes" placeholder="Collection day, ID on file…">${esc(d.notes)}</textarea></label>
    <p class="err span" id="d-err" role="alert" aria-live="polite" style="color:var(--bad);margin:0"></p>
    <div class="actions span"><button class="btn primary" type="submit">${id?"Save changes":prospect?"Add prospect":"Add dealer"}</button><button class="btn" type="button" data-back>Cancel</button>
    ${id?(hasTx?`<button class="btn" type="button" id="d-arch" style="margin-left:auto">${d.active===false?"Restore dealer":"Archive dealer"}</button>`:`<button class="btn danger" type="button" id="d-del" style="margin-left:auto">Delete ${prospect?"prospect":"dealer"}</button>`):""}</div></form>`,sh=>{
    // Dealer photo: pick, take or paste a picture, then crop it in place.
    let photoBlob=null, photoRemoved=false;
    const cur=id?S.dealers.get(id):null;
    const liveName=()=>fullName($("#d-first",sh)?.value,$("#d-middle",sh)?.value,$("#d-last",sh)?.value);
    const showPrev=()=>{ const el=$("#d-prev",sh); if(!el) return;
      const preview={...(cur||{}),name:liveName()||(cur&&cur.name)||""}; if(photoRemoved) delete preview.photoId;
      el.innerHTML=photoBlob?`<img class="avatar" src="${URL.createObjectURL(photoBlob)}" alt="New photo" width="88" height="88">`:avatar(preview,88);
      const has=photoBlob||(!photoRemoved&&cur&&cur.photoId), rc=$("#d-recrop",sh), rm=$("#d-rmphoto",sh);
      if(rc) rc.hidden=!has; if(rm) rm.hidden=!has; };
    const crop=async src=>{ const b=await cropPicture($("#d-cropper",sh),src); if(b){ photoBlob=b; photoRemoved=false; showPrev(); } };
    const pick=f=>{ if(!f) return; if(!f.type.startsWith("image/")){ toast("Choose a picture file"); return; } crop(URL.createObjectURL(f)); };
    if($("#d-file",sh)){
      ["d-file","d-cam"].forEach(k=>$("#"+k,sh).addEventListener("change",e=>{ pick(e.target.files[0]); e.target.value=""; }));
      $("#d-recrop",sh).addEventListener("click",()=>crop(photoBlob?URL.createObjectURL(photoBlob):imgUrl(cur.photoId)));
      $("#d-rmphoto",sh).addEventListener("click",()=>{ photoBlob=null; photoRemoved=true; showPrev(); });
      sh.addEventListener("paste",e=>{ const it=[...(e.clipboardData?.items||[])].find(i=>i.type.startsWith("image/")); if(it){ e.preventDefault(); pick(it.getAsFile()); } });
    }
    const updName=()=>{ const n=liveName(), p=$("#d-name-prev",sh); if(p) p.textContent=n||"—"; showPrev(); };
    ["d-first","d-middle","d-last"].forEach(k=>{ const el=$("#"+k,sh); if(el) el.addEventListener("input",updName); });
    // Look for this dealer as the form is filled in. An edit only checks what changed.
    const fresh=(v,old)=>cur&&normText(v)===normText(old)?"":v;
    const dealerDups=()=>findDealerMatches(S.dealers,{name:fresh(liveName(),cur&&cur.name),phone:fresh($("#d-phone",sh).value,cur&&cur.phone),email:fresh($("#d-email",sh).value,cur&&cur.email)},id);
    const dealerLine=m=>[m.item.phone,m.item.area,isProspect(m.item)?STAGE_L[stageOf(m.item)]:`Balance ${P(status(m.id).balance)}`].filter(Boolean).join(" · ");
    $("#d-bday",sh).addEventListener("input",e=>{ $("#d-age-hint",sh).textContent=ageHint(e.target.value); });
    const showDups=()=>{ const found=dealerDups(); ["name","contact"].forEach(k=>{ $("#d-dup-"+k,sh).innerHTML=dupPanel(found,k,dealerLine); }); };
    $("#f",sh).addEventListener("input",showDups);
    $("#f",sh).addEventListener("click",e=>{ const o=e.target.closest("[data-dup-open]"); if(o){ back(); dealerSheet(o.dataset.dupOpen); } });
    // Clear an old error message and the “save anyway” confirmation as soon as the form changes.
    $("#f",sh).addEventListener("input",()=>{ const err=$("#d-err",sh); if(err) err.textContent=""; const b=$("button[type=submit]",sh); if(b) delete b.dataset.ok; });
    $("#f",sh).addEventListener("submit",e=>{ e.preventDefault(); const btn=e.submitter||$("button[type=submit]",sh);
      if($("#d-cropper",sh)&&!$("#d-cropper",sh).hidden){ toast("Finish cropping the photo first"); return; }
      const clean=v=>String(v||"").trim().replace(/\s+/g," ");
      const firstName=clean($("#d-first").value), middleName=clean($("#d-middle").value), lastName=clean($("#d-last").value);
      const name=fullName(firstName,middleName,lastName);
      if(!firstName||!lastName){ $("#d-err").textContent="Enter the dealer's first and last name."; (!firstName?$("#d-first"):$("#d-last")).focus(); return; }
      const phone=$("#d-phone").value.trim();
      const dup=dealerDups().find(m=>m.strong);
      if(dup){ $("#d-err").textContent=`“${dup.item.name}”${dup.item.active===false?" (archived)":""} already has this ${dup.why.find(y=>y.strong).what}. Open that record instead of adding it again.`; return; }
      const email=$("#d-email").value.trim(); if(email&&!$("#d-email").checkValidity()){ $("#d-err").textContent="That email address doesn't look right."; return; }
      const lim=$("#d-limit").value.trim();
      const base=id?{...S.dealers.get(id)}:{createdAt:Date.now(),createdBy:S.me,active:true};
      const data={...base,name,firstName,middleName,lastName,noReminders:$("#d-nomsg").checked,...($("#d-coll")?{collectorId:$("#d-coll").value||null,routeOrder:$("#d-route").value?Number($("#d-route").value):null}:{}),gender:$("#d-gender").value||null,phone,email,messenger:$("#d-msgr").value.trim(),birthday:$("#d-bday").value||null,area:$("#d-area").value.trim(),address:$("#d-addr").value.trim(),
        consent:(()=>{ const m=$("#d-consent").value; return !m?null:base.consent&&base.consent.method===m?base.consent:{method:m}; })(),
        stage:$("#d-stage").value,source:$("#d-src").value,referredBy:$("#d-ref").value.trim(),tags:$("#d-tags").value.split(",").map(t=>t.trim()).filter(Boolean),
        creditLimit:lim===""?null:r2(lim),terms:Math.max(0,Math.round(Number($("#d-terms").value)||0)),discountPct:$("#d-pct").value===""?null:Math.min(100,Math.max(0,Number($("#d-pct").value))),notes:$("#d-notes").value.trim(),updated:stamp()};
      const prevLim=id?(S.dealers.get(id).creditLimit??null):undefined;
      if(prevLim!==data.creditLimit&&(data.creditLimit!=null||id)) data.limitHistory=[...(base.limitHistory||[]),{at:Date.now(),by:S.me,from:prevLim??null,to:data.creditLimit}].slice(-50);
      const obEl=$("#d-ob"), ob=obEl?r2(obEl.value):0, obDate=obEl?($("#d-obdate").value||today()):"";
      const fu=$("#d-fu")&&$("#d-fu").value;
      guarded(btn,async()=>{
        const oldPhoto=base.photoId||null;
        if(photoBlob){ btn.textContent="Uploading photo…"; const up=await assets.upload(photoBlob); data.photoId=up.id; } else if(photoRemoved) data.photoId=null;
        const ref=db.collection("dealers").doc(id||undefined); await ref.set(data);
        if(oldPhoto&&data.photoId!==oldPhoto) assets.delete(oldPhoto).catch(()=>{});
        if(ob>0) await db.collection("txns").doc().set(openingDoc(ref.id,ob,obDate,addDays(obDate,data.terms),""));
        if(fu) await db.collection("interactions").doc().set({dealerId:ref.id,kind:"note",date:today(),outcome:isProspect(data)?"Added as a prospect":"Added as a dealer",note:"",followUp:fu,followUpDone:false,createdAt:Date.now(),createdBy:S.me});
        toast(id?"Saved":ob>0?`Dealer added with ${P(ob)} opening balance`:isProspect(data)?"Prospect added":"Dealer added"); back(); });
    });
    const del=$("#d-del",sh); if(del) del.addEventListener("click",()=>{ if(armed(del,"Tap again to delete")) guarded(del,async()=>{ for(const [k] of crmInfo(id).log) await db.doc("interactions/"+k).delete(); await db.doc("dealers/"+id).delete(); toast("Deleted"); closeAll(); }); });
    const ar=$("#d-arch",sh); if(ar) ar.addEventListener("click",()=>guarded(ar,async()=>{ const on=S.dealers.get(id).active===false; await db.doc("dealers/"+id).update({active:on,updated:stamp()}); toast(on?"Dealer restored":"Dealer archived. Their history is kept."); back(); }));
  }]; });
}
function allTags(){ const s=new Set(); S.dealers.forEach(d=>(d.tags||[]).forEach(t=>s.add(t))); return [...s].sort((a,b)=>a.localeCompare(b)); }
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
/* ---------- receivables aging (FR-008, FR-051) ---------- */
const AGE_B=[["current","Not yet due"],["d30","1–30 days"],["d60","31–60 days"],["d90","61–90 days"],["d90p","Over 90 days"]];
const ageKey=late=>!late?"current":late<=30?"d30":late<=60?"d60":late<=90?"d90":"d90p";
// Same settlement rules as dealerStatus, using only transactions dated on or before asOf.
// Reconciles as: sum of buckets − unapplied credit = balance.
function agingFor(id,asOf){
  const tx=dealerTxns(id).filter(([,t])=>(t.date||"")<=asOf), R=settle(tx), pool=R.credit;
  const open=[], b={current:0,d30:0,d60:0,d90:0,d90p:0};
  R.open.forEach(({id:tid,t,rem})=>{ const late=t.dueDate&&t.dueDate<asOf?daysBetween(t.dueDate,asOf):0, k=ageKey(late); b[k]=r2(b[k]+rem); open.push({tid,t,rem,late,k}); });
  const balance=r2(tx.reduce((a,[,t])=>a+txnEffect(t),0)), total=r2(Object.values(b).reduce((a,v)=>a+v,0));
  return {balance,open,b,total,credit:pool};
}
function agingReport(asOf,dealerId){
  const rows=[...S.dealers.entries()].filter(([id])=>!dealerId||id===dealerId).map(([id,d])=>({id,d,...agingFor(id,asOf)}))
    .filter(r=>dealerId||Math.abs(r.balance)>0.004||r.open.length).sort((a,b)=>b.total-a.total||a.d.name.localeCompare(b.d.name));
  const tot={current:0,d30:0,d60:0,d90:0,d90p:0,total:0,credit:0,balance:0};
  rows.forEach(r=>{ AGE_B.forEach(([k])=>tot[k]=r2(tot[k]+r.b[k])); tot.total=r2(tot.total+r.total); tot.credit=r2(tot.credit+r.credit); tot.balance=r2(tot.balance+r.balance); });
  return {asOf,rows,tot,ok:rows.every(r=>Math.abs(r2(r.total-r.credit)-r.balance)<0.01)};
}
function agingCsv(R){
  const AL=AGE_B.map(([,l])=>l);
  return csv([["Accounts receivable aging"],["As of",R.asOf],[],
    ["Dealer ID","Dealer",...AL,"Unapplied credit","Balance"],
    ...R.rows.map(r=>[r.id,r.d.name,...AGE_B.map(([k])=>r.b[k]),r.credit,r.balance]),
    ["","Total",...AGE_B.map(([k])=>R.tot[k]),R.tot.credit,R.tot.balance],[],
    ["Dealer ID","Dealer","Transaction ID","No.","Date","Due date","Days late","Bucket","Original amount","Unpaid"],
    ...R.rows.flatMap(r=>r.open.map(o=>[r.id,r.d.name,o.tid,o.t.no||"",o.t.date||"",o.t.dueDate||"",o.late,AGE_B.find(([k])=>k===o.k)[1],r2(o.t.amount),o.rem]))]);
}
function storeHead(title,lines){ const s=S.settings;
  return `<div class="rc-head"><div><h2>${esc(storeName())}</h2><div class="small">${esc([s.address,s.phone].filter(Boolean).join(" · "))}</div></div>
    <div class="rc-title"><b>${title}</b>${lines.map(l=>`<div>${l}</div>`).join("")}</div></div>`; }
function agingSheet(preDealer){
  let asOf=today(), dealer=preDealer||"", detail=!!preDealer;
  const canPrint=!!window.APP;
  show(()=>{ const R=agingReport(asOf,dealer), AL=AGE_B.map(([,l])=>l);
    const opts=[...S.dealers.entries()].sort((a,b)=>a[1].name.localeCompare(b[1].name)).map(([id,d])=>`<option value="${id}" ${id===dealer?"selected":""}>${esc(d.name)}</option>`).join("");
    return [`<div class="no-print">${head("Receivables aging","Unpaid balances grouped by how many days they are past due.")}
      <div class="toolbar" style="margin-bottom:12px"><label class="small">As of <input type="date" id="ag-asof" value="${esc(asOf)}" max="${today()}"></label>
        <select id="ag-dealer" aria-label="Dealer"><option value="">All dealers</option>${opts}</select>
        <label class="small"><input type="checkbox" id="ag-detail" ${detail?"checked":""}> Show each delivery</label></div>
      <div class="actions" style="margin-bottom:14px">${canPrint?`<button class="btn primary" type="button" id="ag-print">Print</button>`:""}${downloads?`<button class="btn" type="button" id="ag-csv">Export CSV</button>`:""}</div></div>
      <article class="receipt">
        ${storeHead("RECEIVABLES AGING",[`As of <b>${fmtDate(asOf)}</b>`,dealer?esc(S.dealers.get(dealer)?.name||""):"All dealers"])}
        ${R.rows.length?`<div class="tbl-wrap"><table class="rc-tbl"><thead><tr><th>Dealer</th>${AL.map(l=>`<th class="r">${l}</th>`).join("")}<th class="r">Credit</th><th class="r">Balance</th></tr></thead><tbody>
          ${R.rows.map(r=>`<tr><td><b>${esc(r.d.name)}</b>${r.d.active===false?` <small>(archived)</small>`:""}</td>${AGE_B.map(([k])=>`<td class="r num">${r.b[k]?P(r.b[k]):"—"}</td>`).join("")}<td class="r num">${r.credit?"−"+P(r.credit):"—"}</td><td class="r num"><b>${P(r.balance)}</b></td></tr>
            ${detail?r.open.map(o=>`<tr class="small"><td style="padding-left:20px">${esc(o.t.no||"")} · ${fmtDate(o.t.date)}<div class="muted">Due ${fmtDate(o.t.dueDate)}${o.late?` · ${o.late} days late`:""}</div></td>${AGE_B.map(([k])=>`<td class="r num">${k===o.k?P(o.rem):""}</td>`).join("")}<td></td><td></td></tr>`).join(""):""}`).join("")}
          </tbody><tfoot><tr><td>Total</td>${AGE_B.map(([k])=>`<td class="r num">${P(R.tot[k])}</td>`).join("")}<td class="r num">${R.tot.credit?"−"+P(R.tot.credit):"—"}</td><td class="r num"><b>${P(R.tot.balance)}</b></td></tr>
          <tr><td>Share of unpaid</td>${AGE_B.map(([k])=>`<td class="r num">${R.tot.total?Math.round(R.tot[k]/R.tot.total*100)+"%":"—"}</td>`).join("")}<td></td><td></td></tr></tfoot></table></div>
          <p class="small muted">Each unpaid delivery or debit adjustment sits in one column, based on its due date. Payments, returns and credits settle the oldest deliveries first. Credit is money the dealer paid in advance that isn't applied yet. Each dealer's balance = the aging columns − credit.${R.ok?"":" <b>Warning: some balances did not reconcile.</b>"}</p>`
          :`<div class="empty"><p>No balances as of ${fmtDate(asOf)}.</p></div>`}
        ${qrBlock(deepLink("aging",dealer||undefined),"Aging report",`As of ${fmtDate(asOf)}${dealer?" · "+(S.dealers.get(dealer)?.name||""):" · All dealers"}`)}
      </article>`,sh=>{
      $("#ag-asof",sh).addEventListener("change",e=>{ asOf=e.target.value||today(); paintSheet(true); });
      $("#ag-dealer",sh).addEventListener("change",e=>{ dealer=e.target.value; if(dealer) detail=true; paintSheet(true); });
      $("#ag-detail",sh).addEventListener("change",e=>{ detail=e.target.checked; paintSheet(true); });
      const pr=$("#ag-print",sh); if(pr) pr.addEventListener("click",()=>window.print());
      const cv=$("#ag-csv",sh); if(cv) cv.addEventListener("click",()=>save(`aging-${asOf}${dealer?"-"+(S.dealers.get(dealer)?.name||dealer).replace(/[^\w-]+/g,"_"):""}.csv`,agingCsv(R)));
    }]; },true);
}

/* ---------- statement of account for a period (FR-009) ---------- */
function stmtLabel(t){
  if(t.opening) return "Opening balance entry";
  if(t.type==="payment") return `Payment${t.method?" · "+t.method:""}${t.ref?" · Ref "+t.ref:""}`;
  if(t.type==="adjustment") return `${t.direction==="debit"?"Debit":"Credit"} adjustment${t.reason?" · "+t.reason:""}`;
  if(t.type==="writeoff") return `Write-off · ${t.reason||"Bad debt"}`;
  if(t.type==="return") return `Return${t.saleNo?" from "+t.saleNo:""}`;
  return TYPE_LABEL[t.type]||t.type;
}
function periodStatement(id,from,to){
  const tx=dealerTxns(id); let run=0, opening=0, charges=0, credits=0; const rows=[];
  tx.forEach(([tid,t])=>{ const e=txnEffect(t), dt=t.date||"";
    if(dt<from){ opening=r2(opening+e); run=opening; return; } if(dt>to) return;
    run=r2(run+e); if(e>0) charges=r2(charges+e); else credits=r2(credits-e); rows.push({tid,t,e,run}); });
  const ag=agingFor(id,to), unpaid=new Map(ag.open.map(o=>[o.tid,o]));
  return {from,to,opening,charges,credits,closing:r2(opening+charges-credits),rows,ag,unpaid,
    overdue:r2(ag.open.filter(o=>o.late>0).reduce((a,o)=>a+o.rem,0))};
}
function periodStatementText(id,from,to){
  const d=S.dealers.get(id), s=S.settings, R=periodStatement(id,from,to), L=[storeName()];
  if(s.address||s.phone) L.push([s.address,s.phone].filter(Boolean).join(" · "));
  L.push("","STATEMENT OF ACCOUNT",`Dealer: ${d.name}`,`Period: ${fmtDate(from)} – ${fmtDate(to)}`,"",`Balance brought forward: ${P(R.opening)}`);
  R.rows.forEach(r=>{ const u=R.unpaid.get(r.tid); L.push(`${fmtDate(r.t.date)}  ${r.t.no||""} ${stmtLabel(r.t)}  ${r.e>=0?"+":"−"}${P(Math.abs(r.e))}  = ${P(r.run)}${u?`  (due ${fmtDate(r.t.dueDate)}, unpaid ${P(u.rem)})`:""}`); });
  L.push("",`Charges: ${P(R.charges)}`,`Payments and credits: ${P(R.credits)}`,R.closing<0?`Credit in your favor: ${P(-R.closing)}`:`Closing balance: ${P(R.closing)}`);
  if(R.overdue) L.push(`Past due as of ${fmtDate(to)}: ${P(R.overdue)}`);
  if(R.ag.open.length){ L.push("","Unpaid deliveries:"); R.ag.open.forEach(o=>L.push(`• ${o.t.no?o.t.no+" · ":""}${fmtDate(o.t.date)} — ${P(o.rem)} (due ${fmtDate(o.t.dueDate)}${o.late?`, ${o.late} days late`:""})`)); }
  if(s.paymentInfo) L.push("","How to pay:",s.paymentInfo);
  L.push("",s.footer??"Salamat po!"); return L.join("\n");
}
function statementSheet(id){
  const t0=today(); let to=t0, from=t0.slice(0,8)+"01";
  const canPrint=!!window.APP;
  show(()=>{ const d=S.dealers.get(id); if(!d) return [head("Dealer not found")];
    const R=periodStatement(id,from,to), s=S.settings, first=(dealerTxns(id)[0]||[,{}])[1].date;
    return [`<div class="no-print">${head("Statement of account",esc(d.name))}
      <div class="toolbar" style="margin-bottom:12px"><label class="small">From <input type="date" id="sa-from" value="${esc(from)}" max="${esc(to)}"></label><label class="small">To <input type="date" id="sa-to" value="${esc(to)}" min="${esc(from)}" max="${t0}"></label>
        <button class="btn sm" type="button" id="sa-all">All time</button></div>
      <div class="actions" style="margin-bottom:14px">${canPrint?`<button class="btn primary" type="button" id="sa-print">Print</button>`:""}<button class="btn ${canPrint?"":"primary"}" type="button" id="sa-copy">Copy as text</button></div></div>
      <article class="receipt">
        ${storeHead("STATEMENT OF ACCOUNT",[`${fmtDate(from)} – ${fmtDate(to)}`])}
        <dl class="kv rc-kv"><dt>Dealer</dt><dd><b>${esc(d.name)}</b></dd>${d.phone?`<dt>Mobile</dt><dd>${esc(d.phone)}</dd>`:""}${d.area?`<dt>Address</dt><dd>${esc(d.area)}</dd>`:""}${d.terms!=null?`<dt>Terms</dt><dd>${d.terms} days</dd>`:""}${d.creditLimit?`<dt>Credit limit</dt><dd>${P(d.creditLimit)}</dd>`:""}</dl>
        <div class="tbl-wrap"><table class="rc-tbl"><thead><tr><th>Date</th><th>Details</th><th>Due</th><th class="r">Charges</th><th class="r">Credits</th><th class="r">Balance</th></tr></thead><tbody>
          <tr><td class="nowrap">${fmtDate(from)}</td><td><i>Balance brought forward</i></td><td></td><td></td><td></td><td class="r num"><b>${P(R.opening)}</b></td></tr>
          ${R.rows.map(r=>{ const u=R.unpaid.get(r.tid); return `<tr><td class="nowrap">${fmtDate(r.t.date)}</td><td>${esc(r.t.no||"")} ${esc(stmtLabel(r.t))}</td><td class="nowrap small">${isCharge(r.t)&&r.t.dueDate?fmtDate(r.t.dueDate)+(u?`<div><b>${P(u.rem)} unpaid</b>${u.late?` · ${u.late}d late`:""}</div>`:`<div class="muted">Paid</div>`):""}</td><td class="r num">${r.e>0?P(r.e):""}</td><td class="r num">${r.e<0?P(-r.e):""}</td><td class="r num">${P(r.run)}</td></tr>`; }).join("")}
          ${R.rows.length?"":`<tr><td colspan="6" class="muted small">No transactions in this period.</td></tr>`}
        </tbody><tfoot><tr><td colspan="3" class="r">Totals for the period</td><td class="r num">${P(R.charges)}</td><td class="r num">${P(R.credits)}</td><td></td></tr></tfoot></table></div>
        <div class="rc-total"><span>${R.closing<0?"Credit in your favor":"Closing balance"} as of ${fmtDate(to)}</span><b class="num">${P(Math.abs(R.closing))}</b></div>
        ${R.overdue?`<p class="rc-bal">Past due: <b class="num">${P(R.overdue)}</b></p>`:""}
        ${R.ag.open.length?`<table class="rc-tbl"><thead><tr><th>Unpaid as of ${fmtDate(to)}</th><th>Due</th><th class="r">Days late</th><th class="r">Unpaid</th></tr></thead><tbody>${R.ag.open.map(o=>`<tr><td>${esc(o.t.no||"")} · ${fmtDate(o.t.date)}</td><td class="nowrap">${fmtDate(o.t.dueDate)}</td><td class="r num">${o.late||"—"}</td><td class="r num">${P(o.rem)}</td></tr>`).join("")}</tbody></table>`:""}
        ${s.paymentInfo?`<p class="small"><b>How to pay:</b> ${esc(s.paymentInfo)}</p>`:""}
        ${qrBlock(deepLink("statement",id),"Scan this statement",`${d.name} · ${fmtDate(from)} – ${fmtDate(to)}`)}
        <p class="rc-foot">This is not an official receipt. ${esc(s.footer??"Salamat po!")}</p>
      </article>`,sh=>{
      $("#sa-from",sh).addEventListener("change",e=>{ from=e.target.value||from; if(from>to) to=from; paintSheet(true); });
      $("#sa-to",sh).addEventListener("change",e=>{ to=e.target.value||to; if(to<from) from=to; paintSheet(true); });
      $("#sa-all",sh).addEventListener("click",()=>{ from=first&&first<to?first:to; to=t0; paintSheet(true); });
      const pr=$("#sa-print",sh); if(pr) pr.addEventListener("click",()=>window.print());
      $("#sa-copy",sh).addEventListener("click",()=>copyText(periodStatementText(id,from,to),"Statement of account"));
    }]; },true);
}
function creditHistoryPanel(id){
  const h=history(id), d=S.dealers.get(id); const lim=(d.limitHistory||[]).slice().reverse();
  resolveNames(lim.map(x=>x.by));
  const maxM=Math.max(1,...h.months.map(m=>Math.max(m.taken,m.paid)));
  const res=r=>r.paid?(r.late?`<span class="pill warn">Paid ${r.late} day${r.late===1?"":"s"} late</span>`:`<span class="pill good">Paid on time</span>`):(r.late?`<span class="pill bad">Unpaid · ${r.late} days late</span>`:`<span class="pill neutral">Unpaid · not yet due</span>`);
  return `<section class="panel" style="margin-bottom:16px">
    <div class="panel-head"><h2>Credit history</h2><div class="actions">${gradePill(h)}<span class="small muted">${esc(h.grade.label)}${h.grade.g!=="New"?` · score ${h.score}/100`:""}${h.bounced?` · ${h.bounced} bounced check${h.bounced===1?"":"s"}`:""}</span></div></div>
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
      ${h.rows.slice(0,24).map(r=>`<tr class="click" tabindex="0" data-tx="${esc(r.id||"")}"><td class="small"><b>${esc(r.t.no||"")}</b> ${fmtDate(r.t.date)}<div class="muted num">${P(r.t.amount)}${r.rem?` · ${P(r.rem)} left`:""}</div></td><td class="small nowrap">${fmtDate(r.t.dueDate)}</td><td class="small nowrap">${r.paid?fmtDate(r.paid)+`<div class="muted">${r.days} days</div>`:"—"}</td><td>${res(r)}</td></tr>`).join("")}
    </tbody></table></div>${h.rows.length>24?`<p class="small muted">Showing the latest 24 of ${h.rows.length} deliveries.</p>`:""}`:""}
    <h3 style="font-size:14px;margin:16px 0 8px">Credit limit changes</h3>
    ${lim.length?`<table><tbody>${lim.map(x=>`<tr><td class="small nowrap">${fmtStamp(x.at)}</td><td class="small num">${x.from==null?"No limit":P(x.from)} → <b>${x.to==null?"No limit":P(x.to)}</b></td><td class="small muted">${esc(nameOf(x.by))}</td></tr>`).join("")}</tbody></table>`:`<p class="small muted" style="margin:0">No changes recorded. Current limit: ${d.creditLimit?P(d.creditLimit):"none"}.</p>`}
  </section>`;
}
function dealerSheet(id){
  if(window.APP&&window.APP.viewedDealer) window.APP.viewedDealer(id);
  show(()=>{ const d=S.dealers.get(id); if(!d) return [head("Dealer not found")+`<p>This dealer was removed.</p>`];
  const st=status(id); let run=0; const fresh=isProspect(d)&&!dealerTxns(id,true).length;
  const all=dealerTxns(id,true).map(([tid,t])=>{ if(isLive(t)) run=r2(run+txnEffect(t)); return {tid,t,run}; }).reverse();
  resolveNames([d.createdBy]);
  return [head(avatar(d,44)+" "+esc(d.name)+" "+stagePill(d)+samplePill(d)+(d.active===false?` <span class="pill neutral">Archived</span>`:""),[d.phone,d.area,d.terms!=null?`${d.terms}-day terms`:""].filter(Boolean).map(esc).join(" · "))+`
    ${fresh?`<div class="notice info"><p>This prospect hasn't bought on credit yet. Recording their first credit sale makes them a dealer.</p></div>`:`<div class="stat-row">
      <div class="kpi"><div class="lbl">Balance</div><div class="val num">${P(st.balance)}</div></div>
      <div class="kpi ${st.overdue?"bad":""}"><div class="lbl">Overdue</div><div class="val num">${P(st.overdue)}</div></div>
      <div class="kpi"><div class="lbl">Credit limit</div><div class="val num">${d.creditLimit?P(d.creditLimit):"None"}</div>${d.creditLimit?`<div class="sub">${P(Math.max(0,d.creditLimit-st.balance))} available</div>`:""}</div>
    </div>`}
    ${st.maxLate>holdDays()?`<div class="notice bad"><p><b>On credit hold.</b> The oldest unpaid delivery is ${st.maxLate} days late. New credit sales are blocked until they pay${S.canAdmin?", unless you approve one":""}.</p></div>`:""}
    ${!d.creditLimit&&!fresh&&S.canWrite?`<div class="notice warn"><p>No credit limit set for this dealer. Set one so the app can warn you before risky releases.</p></div>`:""}
    ${S.canWrite?`<div class="actions" style="margin-bottom:16px"><button class="btn primary" data-act="sale-for" data-id="${id}" type="button">+ Credit sale</button>${fresh?"":`<button class="btn" data-act="pay-for" data-id="${id}" type="button">+ Payment</button><button class="btn" data-act="ret-for" data-id="${id}" type="button">+ Return</button>${S.canAdmin?`<button class="btn" data-act="adjust-for" data-id="${id}" type="button">+ Adjustment</button><button class="btn danger" data-act="writeoff-for" data-id="${id}" type="button">+ Write-off</button>`:""}<button class="btn" data-act="remind-copy" data-id="${id}" type="button">Copy reminder</button>`}<button class="btn" data-act="opening-for" data-id="${id}" type="button">+ Opening balance</button>${qrReady()?`<button class="btn" data-act="dealer-qr" data-id="${id}" type="button">QR code</button>`:""}${window.APP&&S.acct&&S.acct.role==="owner"?`<button class="btn" data-act="portal-for" data-id="${id}" type="button">Portal access</button>`:""}<button class="btn" data-act="edit-dealer" data-id="${id}" type="button">Edit dealer</button>${S.canAdmin?`<button class="btn" data-act="ops-merge" data-kind="dealers" data-id="${id}" type="button">Merge a duplicate</button>`:""}</div>`:""}
    ${d.notes?`<p class="small"><b>Notes:</b> ${esc(d.notes)}</p>`:""}
    ${isProspect(d)?crmPanel(id):""}
    ${fresh?"":`    <section class="panel" style="margin-bottom:16px"><div class="panel-head"><h2>Statement to send</h2><div class="actions"><button class="btn sm" type="button" data-act="statement" data-id="${id}">Full statement</button><button class="btn sm" type="button" data-act="aging-for" data-id="${id}">Aging</button><button class="btn sm" type="button" id="copyStmt">Copy text</button></div></div>
      <pre class="stmt" id="stmt">${esc(statementText(id))}</pre><p class="small muted" style="margin:6px 0 0">Paste into Messenger, Viber or SMS to remind the dealer.</p></section>`}
    ${(()=>{ const O=openDeliveries(id); if(!O.open.length) return ""; return `<section class="panel" style="margin-bottom:16px"><div class="panel-head"><h2>Unpaid deliveries</h2>${S.canWrite?`<button class="btn sm primary" data-act="pay-amt" data-id="${id}" data-amt="${st.balance}" type="button">Collect full ${P(st.balance)}</button>`:""}</div>
      <div class="tbl-wrap"><table><thead><tr><th>Delivery</th><th>Due</th><th class="r">Amount</th><th class="r">Paid</th><th class="r">Left</th>${S.canWrite?"<th></th>":""}</tr></thead><tbody>
      ${O.open.map(o=>`<tr><td><b>${esc(o.t.no||"")}</b><div class="small muted">${fmtDate(o.t.date)}</div></td><td class="small nowrap">${fmtDate(o.t.dueDate)}${o.late?`<div><span class="pill ${o.late>holdDays()?"bad":"warn"}">${o.late} days late</span></div>`:""}</td><td class="r num">${P(o.t.amount)}</td><td class="r num">${o.paid?P(o.paid):"—"}${o.paid?`<div class="meter" style="margin-left:auto;max-width:80px"><i style="width:${o.paid/o.t.amount*100}%;background:var(--good)"></i></div>`:""}</td><td class="r num"><b>${P(o.rem)}</b></td>${S.canWrite?`<td class="r"><button class="btn sm" data-act="pay-amt" data-id="${id}" data-amt="${o.rem}" data-did="${o.id}" type="button">Pay</button></td>`:""}</tr>`).join("")}
      </tbody></table></div><p class="small muted" style="margin:8px 0 0">Partial payments are applied to the oldest delivery first.</p></section>`; })()}
    ${isProspect(d)?"":crmPanel(id)}
    ${fresh?"":creditHistoryPanel(id)}
    <section class="panel"><h2>Ledger</h2>
      ${all.length?`<div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Details</th><th class="r">Amount</th><th class="r">Balance</th></tr></thead><tbody>
      ${all.map(({tid,t,run})=>`<tr class="click ${t.voided?"void":""}" tabindex="0" data-tx="${tid}"><td class="small nowrap">${fmtDate(t.date)}</td><td>${txDetails(t)}</td><td class="r num nowrap amt">${sign(t)}${P(t.amount)}</td><td class="r num">${t.voided?"—":P(run)}</td></tr>`).join("")}
      </tbody></table></div>`:`<div class="empty"><p>No sales or payments yet for this dealer.</p></div>`}
      ${d.createdAt>1e9?`<p class="small muted" style="margin:10px 0 0">Added ${fmtStamp(d.createdAt)} by ${esc(nameOf(d.createdBy))}</p>`:""}
    </section>`,sh=>{
    const cs=$("#copyStmt",sh); if(cs) cs.addEventListener("click",()=>{ const el=$("#stmt",sh), txt=el.textContent;
      const sel=()=>{ const r=document.createRange(); r.selectNodeContents(el); const s=getSelection(); s.removeAllRanges(); s.addRange(r); toast("Text selected. Copy it from your device menu."); };
      try{ navigator.clipboard.writeText(txt).then(()=>toast("Statement copied"),sel); }catch(e){ sel(); } });
  }]; },true);
}

/* ---------- product ---------- */
function productForm(id){
  show(()=>{ const p=id?S.products.get(id):{name:"",code:"",category:"",dealerPrice:"",srp:"",cost:"",stock:0,reorderLevel:5};
  const cats=[...new Set([...S.products.values()].map(x=>x.category).filter(Boolean))].sort();
  const used=id&&[...S.txns.values()].some(t=>(t.items||[]).some(i=>i.productId===id));
  const mv=id?[...S.moves.values()].filter(m=>m.productId===id).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).slice(0,8):[];
  return [head(id?"Edit product":"New product")+`<form id="f" class="form-grid">
    <div class="f span"><span>Photo</span><div class="photo-box">
      <div id="p-prev">${p.imageId?`<img class="big" src="${imgUrl(p.imageId)}" alt="Product photo">`:`<div class="big">No photo yet</div>`}</div>
      ${assets?`<div class="actions" style="flex-direction:column;align-items:flex-start;flex:1;min-width:200px"><input id="p-file" type="file" accept="image/*" aria-label="Choose product photo">${p.imageId?`<button class="btn sm" type="button" id="p-rmimg">Remove photo</button>`:""}<span class="hint">Choose a file, drag one here, or copy a picture from a website and paste it (Ctrl+V). Large photos are resized automatically.</span></div>`:`<span class="hint">Only the ledger owner or editors can add photos.</span>`}
    </div></div>
    ${assets&&assets.fromUrl?`<div class="f span"><label for="p-link">Picture from the internet</label><div class="link-row"><input id="p-link" type="url" inputmode="url" value="${esc(p.imageLink||"")}" placeholder="Paste a picture or product page link, https://…"><button class="btn" type="button" id="p-getimg">Get picture</button><button class="btn" type="button" id="p-find">Find online</button></div><span class="hint" id="p-linkh">“Find online” searches pictures of this product. Right-click a picture, copy its address, paste it here, then press Get picture. A product page link also works. Use pictures you have the right to use, such as the supplier's own.</span></div>`
    :`<label class="f span">Picture link from the internet<input id="p-link" type="url" inputmode="url" value="${esc(p.imageLink||"")}" placeholder="https://…"><span class="hint">Saved as a “View picture” link that opens in a new tab.</span></label>`}
    <label class="f span">Product name<input id="p-name" required maxlength="160" value="${esc(p.name)}" placeholder="Name and size, e.g. Dishwashing Liquid 1L"></label>
    <label class="f">Category<input id="p-cat" list="catList" value="${esc(p.category||"")}" placeholder="e.g. Home care"><datalist id="catList">${cats.map(c=>`<option value="${esc(c)}">`).join("")}</datalist></label>
    <label class="f">Code / SKU<input id="p-code" value="${esc(p.code)}"></label>
    <div class="f"><label for="p-barcode">Barcode</label><div class="link-row"><input id="p-barcode" inputmode="numeric" maxlength="40" value="${esc(p.barcode||"")}"><button class="btn" type="button" data-scan="#p-barcode">Scan</button></div></div>
    <div class="span dup-slot" id="p-dup" role="status" aria-live="polite"></div>
    <label class="f">SRP / catalog price (₱)<input id="p-srp" type="number" min="0" step="0.01" value="${esc(p.srp??"")}"><span class="hint">Credit sales use this price, less the dealer discount.</span></label>
    <label class="f">Dealer price (₱)<input id="p-dp" type="number" min="0" step="0.01" required value="${esc(p.dealerPrice)}"><span class="hint" id="p-dph">Price the dealer pays after discount.</span></label>
    <label class="f">Your cost (₱)<input id="p-cost" type="number" min="0" step="0.01" value="${esc(p.cost??"")}" placeholder="What you paid" ${S.canAdmin?"":"disabled"}><span class="hint">Used for gross profit. Only the owner or an editor can change it.</span></label>
    ${id?`<div class="f"><span>Stock on hand</span><b class="num" style="font-size:18px;color:var(--fg)">${p.stock}</b><span class="hint">Change it with Stock in / adjust.</span></div>`:`<label class="f">Starting stock<input id="p-stock" type="number" step="1" min="0" value="${esc(p.stock)}"></label>`}
    <label class="f">Reorder when at or below<input id="p-re" type="number" min="0" step="1" value="${esc(p.reorderLevel??"")}"></label>
    <label class="f">Dealer discount for this product (%)<input id="p-pct" type="number" min="0" max="100" step="0.01" value="${esc(p.discountPct??"")}" placeholder="Same as dealer's (${storePct()}%)" ${S.canAdmin?"":"disabled"}><span class="hint">Leave blank unless this item gets a different discount, e.g. 0 for net-priced items.</span></label>
    <div class="span promo-box"><h3 style="font-size:14px;margin:0 0 8px">Promo ${promoOn(p)?`<span class="pill warn">ON NOW</span>`:p.promo&&p.promo.price?`<span class="pill neutral">${p.promo.to&&p.promo.to<today()?"ended":"scheduled"}</span>`:""}</h3><div class="form-grid">
      <label class="f">Promo price (₱)<input id="p-promo" type="number" min="0" step="0.01" value="${esc(p.promo&&p.promo.price||"")}" placeholder="No promo" ${S.canAdmin?"":"disabled"}></label>
      <label class="f">From<input id="p-pfrom" type="date" value="${esc(p.promo&&p.promo.from||"")}" ${S.canAdmin?"":"disabled"}></label>
      <label class="f">Until<input id="p-pto" type="date" value="${esc(p.promo&&p.promo.to||"")}" ${S.canAdmin?"":"disabled"}></label>
      <label class="chk span"><input type="checkbox" id="p-pnod" ${p.promo&&p.promo.noDiscount?"checked":""} ${S.canAdmin?"":"disabled"}> Promo price is final (no dealer discount on top)</label></div></div>
    <p class="err span" id="p-err" role="alert" aria-live="polite" style="color:var(--bad);margin:0"></p>
    <div class="actions span"><button class="btn primary" type="submit">${id?"Save changes":"Add product"}</button><button class="btn" type="button" data-back>Cancel</button>
    ${id?`<button class="btn" type="button" data-act="stock-for" data-id="${id}">Stock in / adjust</button>${S.canAdmin?`<button class="btn" type="button" data-act="ops-merge" data-kind="products" data-id="${id}">Merge a duplicate</button>`:""}${qrReady()?`<button class="btn" type="button" data-act="product-qr" data-id="${id}">QR label</button>`:""}`:""}
    ${id?(used?`<button class="btn" type="button" id="p-arch" style="margin-left:auto">${p.active===false?"Restore product":"Archive product"}</button>`:`<button class="btn danger" type="button" id="p-del" style="margin-left:auto">Delete product</button>`):""}</div></form>
    ${(p.priceHistory||[]).length?`<section class="panel" style="margin-top:16px"><h2>Price history</h2><table><tbody>${p.priceHistory.slice().reverse().map(h=>`<tr><td class="small nowrap">${fmtStamp(h.at)}</td><td class="small">${esc(h.catalog||"")}</td><td class="r num small">${h.from!=null?P(h.from):"—"} → <b>${P(h.to)}</b></td></tr>`).join("")}</tbody></table></section>`:""}
    ${mv.length?`<section class="panel" style="margin-top:16px"><h2>Recent stock changes</h2><table><tbody>${mv.map(m=>`<tr><td class="small nowrap">${fmtDate(m.date)}</td><td class="small">${esc(m.reason)}${m.note?" · "+esc(m.note):""}</td><td class="r num">${m.qty>0?"+":""}${m.qty}</td></tr>`).join("")}</tbody></table></section>`:""}`,sh=>{
    // Look for this product as the form is filled in. An edit only checks what changed.
    const fresh=(v,old)=>id&&normText(v)===normText(old)?"":v;
    const productDups=()=>findProductMatches(S.products,{name:fresh($("#p-name",sh).value,p.name),code:fresh($("#p-code",sh).value,p.code),barcode:fresh($("#p-barcode",sh).value,p.barcode)},id);
    const productLine=m=>[m.item.code,`${m.item.stock||0} on hand`,P(m.item.dealerPrice)].filter(Boolean).join(" · ");
    $("#f",sh).addEventListener("input",e=>{ $("#p-err",sh).textContent=""; delete $("button[type=submit]",sh).dataset.ok; if(e.target.matches("#p-name,#p-code,#p-barcode")) $("#p-dup",sh).innerHTML=dupPanel(productDups(),"product",productLine); });
    $("#f",sh).addEventListener("click",e=>{ const o=e.target.closest("[data-dup-open]"); if(o){ back(); productForm(o.dataset.dupOpen); } });
    const srpIn=$("#p-srp",sh), dpIn=$("#p-dp",sh); let dpTouched=!!dpIn.value;
    dpIn.addEventListener("input",()=>{ dpTouched=true; });
    srpIn.addEventListener("input",()=>{ const v=r2(srpIn.value*(1-storePct()/100)); $("#p-dph",sh).textContent=srpIn.value?`SRP less ${storePct()}% = ${P(v)}`:"Your cost to the dealer after discount."; if(!dpTouched&&srpIn.value) dpIn.value=v.toFixed(2); });
    let newFile=null, removeImg=false, fetched=null; const fileIn=$("#p-file",sh);
    const dropFetched=()=>{ if(fetched){ assets.delete(fetched.id).catch(()=>{}); fetched=null; } };
    const setFile=f=>{ if(!f) return; if(!f.type.startsWith("image/")){ toast("Choose an image file"); if(fileIn) fileIn.value=""; return; } dropFetched(); newFile=f; removeImg=false; $("#p-prev",sh).innerHTML=`<img class="big" src="${URL.createObjectURL(f)}" alt="New product photo">`; };
    if(fileIn){ fileIn.addEventListener("change",()=>setFile(fileIn.files[0]));
      sh.addEventListener("paste",e=>{ const it=[...(e.clipboardData?.items||[])].find(i=>i.type.startsWith("image/")); if(it){ e.preventDefault(); setFile(it.getAsFile()); toast("Photo pasted"); return; }
        const txt=(e.clipboardData?.getData("text")||"").trim(); const li=$("#p-link",sh), gb=$("#p-getimg",sh);
        if(gb&&/^https?:\/\/\S+$/i.test(txt)&&!(e.target.matches&&e.target.matches("input:not(#p-link),textarea"))){ e.preventDefault(); li.value=txt; getImg(); } });
      const box=$(".photo-box",sh); box.addEventListener("dragover",e=>e.preventDefault());
      box.addEventListener("drop",e=>{ e.preventDefault(); const f=[...(e.dataTransfer?.files||[])].find(x=>x.type.startsWith("image/")); if(f) setFile(f); else toast("Drop an image file. From a website, copy the image and paste it instead."); }); }
    const getBtn=$("#p-getimg",sh);
    const getImg=()=>{ const li=$("#p-link",sh), url=li.value.trim(), hint=$("#p-linkh",sh);
      if(!/^https?:\/\//i.test(url)){ toast("Paste a link that starts with https://"); li.focus(); return; }
      guarded(getBtn,async()=>{ getBtn.textContent="Getting picture…"; $("#p-prev",sh).innerHTML=`<div class="big">Downloading…</div>`;
        try{ const up=await assets.fromUrl(url); dropFetched(); fetched=up; newFile=null; removeImg=false; if(fileIn) fileIn.value="";
          if(up.source) li.value=up.source; $("#p-prev",sh).innerHTML=`<img class="big" src="${imgUrl(up.id)}" alt="Downloaded product photo">`;
          hint.textContent=`Got the picture (${Math.max(1,Math.round(up.sizeBytes/1024))} KB). Press ${id?"Save changes":"Add product"} to keep it.`; toast("Picture downloaded"); }
        catch(err){ const cur=fetched||(!removeImg&&!newFile&&p.imageId?{id:p.imageId}:null); $("#p-prev",sh).innerHTML=cur?`<img class="big" src="${imgUrl(cur.id)}" alt="Product photo">`:`<div class="big">No photo yet</div>`;
          const m=err&&(err.userMsg||err.message)||"Couldn't get that picture."; hint.textContent=m; throw Object.assign(new Error(m),{userMsg:m}); }
        finally{ getBtn.textContent="Get picture"; getBtn.disabled=false; } }); };
    if(getBtn){ getBtn.addEventListener("click",getImg);
      $("#p-link",sh).addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); getImg(); } });
      $("#p-find",sh).addEventListener("click",()=>{ const q=[$("#p-name",sh).value.trim(),$("#p-code",sh).value.trim()].filter(Boolean).join(" ");
        if(!q){ toast("Type the product name first"); $("#p-name",sh).focus(); return; }
        window.open("https://www.google.com/search?tbm=isch&q="+encodeURIComponent(q),"_blank","noopener"); }); }
    const rm=$("#p-rmimg",sh); if(rm) rm.addEventListener("click",()=>{ dropFetched(); removeImg=true; newFile=null; if(fileIn) fileIn.value=""; $("#p-prev",sh).innerHTML=`<div class="big">Photo will be removed when you save</div>`; });
    $("#f",sh).addEventListener("submit",e=>{ e.preventDefault(); const btn=e.submitter||$("button[type=submit]",sh);
      const name=$("#p-name").value.trim(); if(!name) return; const re=$("#p-re").value.trim(); const link=$("#p-link").value.trim();
      const dup=productDups().find(m=>m.strong);
      if(dup){ $("#p-err").textContent=`“${dup.item.name}”${dup.item.active===false?" (archived)":""} already has this ${dup.why.find(y=>y.strong).what}. Open that record instead of adding it again.`; return; }
      const base=id?{...S.products.get(id)}:{createdAt:Date.now(),createdBy:S.me,active:true,stock:Math.max(0,Math.round(Number($("#p-stock").value)||0))};
      const oldImg=base.imageId||null;
      const data={...base,name,category:$("#p-cat").value.trim(),code:$("#p-code").value.trim(),barcode:$("#p-barcode").value.trim(),dealerPrice:r2($("#p-dp").value),cost:$("#p-cost").value===""?null:r2($("#p-cost").value),srp:$("#p-srp").value?r2($("#p-srp").value):null,reorderLevel:re===""?null:Math.max(0,Number(re)),imageLink:/^https?:\/\//i.test(link)?link:null,updated:stamp()};
      data.discountPct=$("#p-pct").value===""?null:Math.min(100,Math.max(0,Number($("#p-pct").value)));
      { const pp=r2($("#p-promo").value); data.promo=pp>0?{...(base.promo||{}),price:pp,from:$("#p-pfrom").value||null,to:$("#p-pto").value||null,noDiscount:$("#p-pnod").checked}:null; }
      if(id&&Number(base.srp||0)!==Number(data.srp||0)) data.priceHistory=[...(base.priceHistory||[]),{at:Date.now(),by:S.me,catalog:"Edited",from:base.srp??null,to:data.srp}].slice(-36);
      guarded(btn,async()=>{
        if(newFile){ btn.textContent="Uploading photo…"; try{ const up=await assets.upload(await shrinkImage(newFile)); data.imageId=up.id; }catch(err){ const m={too_large:"That photo is too large. Try a smaller one.",unsupported_type:"That file type isn't supported. Use JPG or PNG."}[err&&err.code]||"Couldn't upload the photo. Try again."; throw Object.assign(new Error(m),{userMsg:m}); } }
        else if(fetched) data.imageId=fetched.id;
        else if(removeImg) data.imageId=null;
        const ref=db.collection("products").doc(id||undefined); await ref.set(data); fetched=null;
        if(!id&&data.stock>0) await db.collection("moves").doc().set({productId:ref.id,qty:data.stock,reason:"Starting stock",date:today(),note:"",createdAt:Date.now(),createdBy:S.me});
        if(oldImg&&assets&&data.imageId!==oldImg) assets.delete(oldImg).catch(()=>{});
        toast(id?"Product updated":"Product added"); back(); });
    });
    const del=$("#p-del",sh); if(del) del.addEventListener("click",()=>{ if(armed(del,"Tap again to delete")) guarded(del,async()=>{ const im=S.products.get(id).imageId; await db.doc("products/"+id).delete(); for(const [mid,m] of [...S.moves]) if(m.productId===id) await db.doc("moves/"+mid).delete(); if(im&&assets) assets.delete(im).catch(()=>{}); toast("Product deleted"); closeAll(); }); });
    const ar=$("#p-arch",sh); if(ar) ar.addEventListener("click",()=>guarded(ar,async()=>{ const on=S.products.get(id).active===false; await db.doc("products/"+id).update({active:on,updated:stamp()}); toast(on?"Product restored":"Product archived. It won't appear when recording sales."); back(); }));
  }]; });
}
function stockForm(pid){
  if(!S.products.size){ toast("Add a product first"); productForm(); return; }
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
      guarded(btn,async()=>{ await db.collection("moves").doc().set({productId:id,qty:delta,reason:kind==="in"?"Received stock":kind==="out"?"Damaged / lost":"Stock count",date:$("#m-date").value,note:$("#m-note").value.trim(),createdAt:Date.now(),createdBy:S.me});
        await applyStock({[id]:delta}); toast("Stock updated"); back(); });
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
function returnedQtyFor(saleId,productId,exceptId){
  let n=0;
  for(const [id,t] of S.txns){ if(id===exceptId||t.type!=="return"||t.saleId!==saleId||t.voided) continue;
    (t.items||[]).forEach(i=>{ if(i.productId===productId) n+=Number(i.qty)||0; }); }
  return n;
}
function saleOptions(did,sel){
  const list=did?dealerTxns(did).filter(([,t])=>t.type==="sale"&&!t.voided).reverse():[];
  return `<option value="">Not linked — any returned items</option>${list.map(([id,t])=>`<option value="${id}" ${id===sel?"selected":""}>${esc(t.no||"DR")} · ${fmtDate(t.date)} · ${P(t.amount)}</option>`).join("")}`;
}
function itemsForm(kind,dealerId,editId,opts){
  if(!activeDealers().length&&!editId){ toast("Add a dealer first"); dealerForm(); return; }
  if(!activeProducts().length&&!editId){ toast("Add a product first"); productForm(); return; }
  const old=editId?S.txns.get(editId):null; const isSale=kind==="sale"; const orderId=opts&&opts.orderId||null;
  show(()=>{
  const startDealer=old?old.dealerId:dealerId;
  const startPct=old?(old.discountPct??0):opts&&opts.pct!=null?opts.pct:dealerPct(S.dealers.get(startDealer));
  return [head(editId?`Edit ${TYPE_LABEL[kind].toLowerCase()} ${esc(old.no||"")}`:(isSale?"Credit sale":"Dealer return"),isSale?"Products released to a dealer, to be paid later":"Products the dealer gives back. Their balance goes down.")+`<form id="f">
    <div class="form-grid">
      <label class="f span">Dealer<select id="s-dealer" required><option value="">Choose dealer…</option>${dealerOptions(startDealer)}</select></label>
      <label class="f">${isSale?"Date released":"Date returned"}<input id="s-date" type="date" required value="${old?old.date:today()}"></label>
      ${isSale&&!old&&[...S.locations.values()].some(l=>l.active!==false)?`<label class="f">Release from<select id="s-loc"><option value="">Main store</option>${[...S.locations.entries()].filter(([,l])=>l.active!==false).map(([k,l])=>`<option value="${esc(k)}">${esc(l.name)}</option>`).join("")}</select></label>`:""}
      ${isSale?`<label class="f">Due date<input id="s-due" type="date" required value="${old?old.dueDate:""}"></label>`:`<label class="chk" style="align-self:end"><input type="checkbox" id="s-restock" ${!old||old.restock?"checked":""}> Put items back in stock</label>`}
    </div>
    ${!isSale?`<label class="f span">Original delivery (optional)<select id="s-sale">${saleOptions(startDealer,old?old.saleId:"")}</select><span class="hint">Link the return to a DR. Quantities are capped at what was delivered and not yet returned.</span></label>`:""}
    <div class="panel-head" style="margin:18px 0 8px"><h3 style="font-size:15px">Items</h3><span class="small muted" id="cart-count">Tap a product to add it. Tap again to add one more.</span></div>
    <div class="picker">
      <div class="link-row"><input id="pick-q" type="search" autocomplete="off" placeholder="Search or scan a product to add" aria-label="Search products to add"><button class="btn" type="button" data-scan="#pick-q">Scan</button></div>
      <div class="pick-list" id="pick-list" role="list"></div>
    </div>
    <div class="cart-wrap"><table class="cart-tbl"><thead id="cart-head"></thead><tbody id="cart" aria-live="polite"></tbody><tfoot id="cart-foot"></tfoot></table></div>
    <div class="form-grid" style="margin-top:14px">
      <label class="f">Dealer discount (%)<input id="s-pct" type="number" min="0" max="100" step="0.01" value="${startPct}"><span class="hint">Taken off the whole total. Store default is ${storePct()}%.</span></label>
      ${isSale?`<label class="f">Extra discount (₱)<input id="s-disc" type="number" min="0" step="0.01" value="${old&&old.discount?old.discount:""}" placeholder="0.00"><span class="hint">Optional, e.g. a promo.</span></label>`:""}
      <label class="f span">Note<input id="s-note" value="${esc(old?old.note:opts&&opts.note?opts.note:"")}" placeholder="${isSale?"Optional, e.g. delivered by Ben":"Reason, e.g. expired, wrong item"}"></label>
      <label class="f span" id="s-whywrap" ${old&&old.priceReason?"":"hidden"}>Reason for the changed price or discount<input id="s-why" maxlength="300" value="${esc(old&&old.priceReason||"")}" placeholder="e.g. Damaged box, agreed with the owner"><span class="hint">Some prices or discounts differ from the price list. The owner sees this reason.</span></label>
      ${isSale&&!old?`<label class="chk span"><input type="checkbox" id="s-paid"> Dealer paid in full now <select id="s-method" hidden aria-label="Payment method" style="width:auto">${METHODS.map(m=>`<option>${m}</option>`).join("")}</select></label>`:""}
    </div>
    <div id="s-warn" style="margin-top:10px"></div>
    ${isSale&&!old?`<label class="chk" id="s-ovr-wrap" hidden style="margin-top:4px"><input type="checkbox" id="s-ovr"> Release anyway (owner approval)</label>`:""}
    <div class="actions" style="margin-top:12px"><button class="btn primary" type="submit">${editId?"Save changes":isSale?"Record sale":"Record return"}</button><button class="btn" type="button" data-back>Cancel</button></div></form>`,sh=>{
    let saleId=old?(old.saleId||""):"";
    const maxByProduct={};
    const seedMax=()=>{ Object.keys(maxByProduct).forEach(k=>delete maxByProduct[k]); const sale=S.txns.get(saleId); if(!sale) return;
      (sale.items||[]).forEach(i=>{ maxByProduct[i.productId]=Math.max(0,(Number(i.qty)||0)-returnedQtyFor(saleId,i.productId,old?editId:null)); }); };
    const cart=old?(old.items||[]).map(i=>({...i,pct:i.pct!=null?i.pct:(old.discountPct??0),mp:true,pf:true})):opts&&opts.items?opts.items.map(i=>({...i,cost:i.cost??((S.products.get(i.productId)||{}).cost),pct:i.pct!=null?i.pct:(opts.pct??0),mp:true,pf:true})):[];
    if(saleId) seedMax();
    const sDate=()=>$("#s-date").value||today();
    const refreshLines=()=>cart.forEach(i=>{ const p=S.products.get(i.productId); if(!p) return; if(!i.mp){ i.price=listPrice(p,pct(),sDate()); i.promo=promoOn(p,sDate()); } if(!i.pf) i.pct=linePct(p,pct(),sDate()); if(i.cost==null&&p.cost!=null) i.cost=Number(p.cost)||0; });
    let pctTouched=!!old||!!(opts&&opts.pct!=null);
    const prods=()=>{ const l=activeProducts(); cart.forEach(i=>{ if(!l.find(([id])=>id===i.productId)&&S.products.get(i.productId)) l.push([i.productId,S.products.get(i.productId)]); }); return l; };
    const pct=()=>Math.min(100,Math.max(0,Number($("#s-pct").value)||0));
    const uniPct=()=>{ const ps=new Set(cart.map(i=>i.pct)); return ps.size<=1?(cart.length?cart[0].pct:pct()):null; };
    const totals=()=>{ const sub=r2(cart.reduce((a,i)=>a+i.qty*i.price,0)); const pd=r2(cart.reduce((a,i)=>a+i.qty*i.price*(i.pct||0)/100,0)); const extra=isSale?Math.min(r2(sub-pd),Math.max(0,r2($("#s-disc").value))):0; return {sub,pd,extra,total:r2(sub-pd-extra)}; };
    const addProduct=(pid,qty=1)=>{ const p=S.products.get(pid); if(!p) return; const ex=cart.find(i=>i.productId===pid);
      const max=maxByProduct[pid]; if(max!=null&&(ex?ex.qty:0)>=max){ toast(max?`Only ${max} of ${p.name} can still be returned`:`${p.name} was already fully returned`); return; }
      if(ex) ex.qty+=qty; else { cart.push({productId:pid,name:p.name,qty,price:0,pct:0,cost:Number(p.cost)||0}); refreshLines(); } drawCart(); drawPick(); };
    const drawPick=()=>{ const q=$("#pick-q").value.trim().toLowerCase();
      const list=prods().filter(([,p])=>!q||[p.name,p.code,p.barcode,p.category].join(" ").toLowerCase().includes(q)).slice(0,60);
      $("#pick-list").innerHTML=list.length?`<table><thead><tr><th></th><th>Product</th><th>Code</th><th class="r">Stock</th><th class="r">SRP</th><th></th></tr></thead><tbody>${list.map(([id,p])=>{ const inCart=cart.find(i=>i.productId===id);
        return `<tr class="pick" data-pid="${id}" tabindex="0"><td style="width:40px">${thumb(p,1)}</td><td><b>${esc(p.name)}</b>${p.category?`<div class="small muted">${esc(p.category)}</div>`:""}</td><td class="small muted">${esc(p.code||"—")}</td><td class="r num">${p.stock<=0?`<span class="pill bad">0</span>`:p.stock}</td><td class="r num nowrap">${priceTag(p,pct(),sDate())}</td><td class="r"><span class="pick-add">${inCart?`×${inCart.qty} ＋`:"＋ Add"}</span></td></tr>`; }).join("")}</tbody></table>`:`<p class="small muted" style="margin:8px 12px">No product matches “${esc(q)}”.</p>`; };
    const narrowMQ=window.matchMedia("(max-width:600px)");
    const drawCart=()=>{
      const nar=narrowMQ.matches, cols=nar?3:6, lab=nar?2:4;
      $("#cart-head").innerHTML=nar?`<tr><th>Product</th><th class="r">Qty</th><th class="r">Amount</th></tr>`:`<tr><th>#</th><th>Product</th><th class="r">Qty</th><th class="r">SRP each</th><th class="r">Amount</th><th><span style="position:absolute;left:-9999px">Remove</span></th></tr>`;
      $("#cart").innerHTML=cart.length?cart.map((i,k)=>{ const p=S.products.get(i.productId);
        return `<tr class="cart-row" data-k="${k}">${nar?"":`<td class="c-no num">${k+1}</td>`}
          <td><div class="prod-cell">${nar?"":thumb(p,1)}<div><b>${esc(i.name)}</b>${i.promo?` <span class="pill warn">PROMO</span>`:""}${i.pct!==pct()?`<div class="small muted">dealer discount ${i.pct}%</div>`:""}${maxByProduct[i.productId]!=null?`<div class="small muted">max ${maxByProduct[i.productId]}</div>`:""}${nar?`<div class="small muted num c-each">${P(i.price)} each</div>`:""}${p&&!p.srp&&pct()>0?`<div class="small" style="color:var(--warn)">No SRP saved. Using dealer price.</div>`:""}</div></div></td>
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
        Object.entries(diffEffect(old,{type:"sale",items:cart})).forEach(([pid,dq])=>{ const p=S.products.get(pid); if(p){ const avail=availableStock(pid,orderId); if(avail+dq<0) w.push(`Only ${Math.max(0,avail)} of ${esc(p.name)} available${reservedQty(orderId)[pid]?` (${reservedQty(orderId)[pid]} held for orders)`:""}.`); } }); }
      S._hard=isSale&&!old&&hard.length>0;
      $("#s-warn").innerHTML=(S._hard?`<div class="notice bad"><p><b>Credit hold.</b> ${hard.join("<br>")}${S.canAdmin?"":"<br>Press Record to send this sale to the owner for approval."}</p></div>`:"")+(w.length?`<div class="notice warn"><p>${w.join("<br>")}</p></div>`:"");
      const ow=$("#s-ovr-wrap"); if(ow) ow.hidden=!(S._hard&&S.canAdmin);
      return T; };
    const setDue=()=>{ if(!isSale||old) return; const d=S.dealers.get($("#s-dealer").value); $("#s-due").value=addDays($("#s-date").value||today(),d?d.terms??30:(S.settings.defaultTerms??30)); };
    $("#pick-list").addEventListener("click",e=>{ const b=e.target.closest("[data-pid]"); if(b) addProduct(b.dataset.pid); });
    $("#pick-q").addEventListener("input",drawPick);
    $("#pick-q").addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); const v=$("#pick-q").value.trim(), exact=v&&prods().find(([,p])=>p.barcode===v||p.code===v), b=exact?{dataset:{pid:exact[0]}}:$("#pick-list [data-pid]"); if(b){ addProduct(b.dataset.pid); $("#pick-q").value=""; drawPick(); } } });
    $("#cart").addEventListener("click",e=>{ const row=e.target.closest(".cart-row"); if(!row) return; const i=cart[row.dataset.k];
      if(e.target.closest("[data-inc]")){ const max=maxByProduct[i.productId]; if(max!=null&&i.qty>=max){ toast(`Only ${max} can be returned`); return; } i.qty++; drawCart(); drawPick(); }
      else if(e.target.closest("[data-dec]")){ if(i.qty>1) i.qty--; else cart.splice(row.dataset.k,1); drawCart(); drawPick(); }
      else if(e.target.closest("[data-rm]")){ cart.splice(row.dataset.k,1); drawCart(); drawPick(); } });
    $("#cart").addEventListener("input",e=>{ const row=e.target.closest(".cart-row"); if(!row) return; const i=cart[row.dataset.k];
      if(e.target.classList.contains("c-qty")){ const max=maxByProduct[i.productId]; i.qty=Math.max(1,Math.min(max!=null?max:Infinity,Math.round(Number(e.target.value)||1))); }
      if(e.target.classList.contains("c-price")){ i.price=Math.max(0,r2(e.target.value)); i.mp=true; const ce=$(".c-each",row); if(ce) ce.textContent=P(i.price)+" each"; } calc(); });
    $("#cart").addEventListener("change",e=>{ if(e.target.classList.contains("c-qty")) drawCart(); });
    $("#s-pct").addEventListener("input",()=>{ pctTouched=true; cart.forEach(i=>i.pf=false); refreshLines(); drawCart(); drawPick(); });
    $("#s-dealer").addEventListener("change",()=>{ setDue(); if(!pctTouched){ $("#s-pct").value=dealerPct(S.dealers.get($("#s-dealer").value)); cart.forEach(i=>i.pf=false); refreshLines(); drawCart(); drawPick(); } else calc();
      const sSel=$("#s-sale",sh); if(sSel){ const did=$("#s-dealer").value; sSel.innerHTML=saleOptions(did,saleId); const sale=S.txns.get(saleId); if(saleId&&(!sale||sale.dealerId!==did)){ saleId=""; sSel.value=""; seedMax(); } } });
    $("#s-date").addEventListener("change",()=>{ setDue(); refreshLines(); drawCart(); drawPick(); });
    if(isSale) $("#s-disc").addEventListener("input",calc);
    const paid=$("#s-paid",sh); if(paid) paid.addEventListener("change",()=>{ $("#s-method").hidden=!paid.checked; });
    const sSel=$("#s-sale",sh);
    if(sSel) sSel.addEventListener("change",()=>{ saleId=sSel.value; seedMax();
      if(saleId){ const sale=S.txns.get(saleId); cart.length=0; (sale.items||[]).forEach(i=>{ const max=maxByProduct[i.productId]||0; if(max>0) cart.push({...i,qty:max,pct:i.pct!=null?i.pct:(sale.discountPct??0),mp:true,pf:true,cost:i.cost??((S.products.get(i.productId)||{}).cost)}); }); }
      drawCart(); drawPick(); });
    refreshLines(); drawPick(); drawCart(); setDue();
    $("#f",sh).addEventListener("submit",e=>{ e.preventDefault(); const btn=e.submitter||$("button[type=submit]",sh);
      const did=$("#s-dealer").value; if(!did){ toast("Choose a dealer"); return; }
      if(!cart.length){ toast("Add at least one product"); $("#pick-q").focus(); return; }
      const T=calc(); if(T.total<=0){ toast("The total must be more than zero"); return; }
      if(isSale&&$("#s-due").value<$("#s-date").value){ toast("The due date can't be before the release date"); return; }
      const approved=S._hard&&S.canAdmin&&$("#s-ovr")&&$("#s-ovr").checked;
      if(isSale&&!old&&S._hard&&!approved&&S.canAdmin){ toast("This dealer is on credit hold. Tick “Release anyway” to approve."); return; }
      const needApproval=isSale&&!old&&S._hard&&!S.canAdmin;
      if(!isSale&&saleId){ for(const i of cart){ const max=maxByProduct[i.productId]; if(max==null||i.qty>max){ toast(max==null?`${i.name} is not on ${S.txns.get(saleId).no||"that delivery"}`:`Only ${max} of ${i.name} can be returned`); return; } } }
      const data={...(old||{}),type:kind,dealerId:did,date:$("#s-date").value,items:cart.map(i=>({productId:i.productId,name:i.name,qty:i.qty,price:i.price,pct:i.pct,...(i.cost!=null?{cost:r2(i.cost)}:{}),...(i.promo?{promo:true}:{})})),subtotal:T.sub,discountPct:uniPct(),pctDiscount:T.pd,amount:T.total,note:$("#s-note").value.trim()};
      if(isSale){ data.dueDate=$("#s-due").value; data.discount=T.extra; if($("#s-loc",sh)&&$("#s-loc",sh).value) data.locationId=$("#s-loc",sh).value; delete data.saleId; delete data.saleNo; if(opts&&opts.orderId) data.orderId=opts.orderId; }
      else { data.restock=$("#s-restock").checked; data.saleId=saleId||null; data.saleNo=saleId?((S.txns.get(saleId)||{}).no||null):null; }
      { const why=$("#s-why",sh).value.trim(); if(why) data.priceReason=why; else delete data.priceReason; }
      if(isSale&&!allowNegativeStock()){ const pids=Object.entries(diffEffect(old,data)).filter(([pid,dq])=>{ const p=S.products.get(pid); return p&&availableStock(pid,orderId)+dq<0; }); if(pids.length){ const [pid,dq]=pids[0], p=S.products.get(pid); toast(`Only ${Math.max(0,availableStock(pid,orderId))} of ${p.name} available. Add stock or turn on backorders in Store.`); return; } }
      if(!old){ data.no=nextNo(kind); data.createdAt=Date.now(); data.createdBy=S.me; if(approved) data.override={by:S.me,at:Date.now()}; } else data.updated=stamp();
      const paidM=paid&&paid.checked?$("#s-method").value:null;
      if(needApproval){ askApproval(data,opts,paidM); return; }
      guarded(btn,async()=>{
        const ref=db.collection("txns").doc(editId||undefined);
        try{ await ref.set(data); }catch(err){ if(err&&(err.code==="credit_hold"||err.code==="needs_approval")&&isSale&&!old&&!S.canAdmin){ btn.disabled=false; askApproval(data,opts,paidM,err.userMsg); return; }
          if(err&&err.code==="price_reason"){ btn.disabled=false; $("#s-whywrap",sh).hidden=false; $("#s-why",sh).focus(); toast(err.userMsg,"error"); return; } throw err; }
        // The server changes stock in the same step as the sale (PR-03).
        if(paid&&paid.checked) await db.collection("txns").doc().set({type:"payment",dealerId:did,date:data.date,amount:data.amount,method:$("#s-method").value,ref:"",note:`Paid on release ${data.no}`,no:nextNo("payment"),createdAt:Date.now()+1,createdBy:S.me});
        if(opts&&opts.orderId&&S.orders.get(opts.orderId)) await db.doc("orders/"+opts.orderId).set({...S.orders.get(opts.orderId),status:"released",saleId:ref.id,saleNo:data.no});
        toast(editId?"Changes saved":isSale?`Credit sale ${data.no} recorded · ${P(data.amount)}`:`Return ${data.no} recorded`);
        if(editId) back(); else { stack.pop(); if(opts&&opts.orderId) stack.pop(); receiptSheet(ref.id); } });
    });
  }]; });
}
// Open deliveries for a dealer, optionally ignoring one payment (when editing it).
function openDeliveries(did,exceptId){
  const t0=today(), R=settle(dealerTxns(did).filter(([k])=>k!==exceptId));
  return {open:R.open.map(o=>({...o,paid:r2(o.t.amount-o.rem),late:o.t.dueDate&&o.t.dueDate<t0?daysBetween(o.t.dueDate,t0):0})),credit:R.credit};
}
// Chosen deliveries (picks: Map id→amount) are paid first, then the oldest unpaid ones.
function allocate(open,amount,picks){ let c=r2(amount); const rem=new Map(open.map(o=>[o.id,o.rem])), by=new Map();
  const take=(o,want)=>{ const ap=r2(Math.min(want,rem.get(o.id),c)); if(ap<=0) return; rem.set(o.id,r2(rem.get(o.id)-ap)); c=r2(c-ap); by.set(o.id,r2((by.get(o.id)||0)+ap)); };
  if(picks) for(const [id,want] of picks){ const o=open.find(x=>x.id===id); if(o) take(o,Number(want)||0); }
  for(const o of open){ if(c<=0.004) break; take(o,c); }
  return {lines:open.filter(o=>by.has(o.id)).map(o=>({no:o.t.no||"",id:o.id,amount:by.get(o.id),left:rem.get(o.id),cleared:rem.get(o.id)<=0.004,chosen:!!(picks&&picks.has(o.id))})),extra:c}; }
function paymentForm(dealerId,editId,preset){
  if(!activeDealers().length&&!editId){ toast("Add a dealer first"); dealerForm(); return; }
  const old=editId?S.txns.get(editId):null;
  show(()=>[head(editId?`Edit payment ${esc(old.no||"")}`:"Payment received","Full or partial. It pays the oldest unpaid delivery first, or the deliveries you choose.")+`<form id="f" class="form-grid">
    <label class="f span">Dealer<select id="y-dealer" required><option value="">Choose dealer…</option>${dealerOptions(old?old.dealerId:dealerId)}</select></label>
    <div class="span" id="y-quick"></div>
    <label class="f">Amount received (₱)<input id="y-amt" type="number" min="0.01" step="0.01" required inputmode="decimal" value="${old?old.amount:preset&&preset.amount?preset.amount:""}"></label>
    <label class="f">Date<input id="y-date" type="date" required value="${old?old.date:today()}"></label>
    <label class="f">Method<select id="y-method">${METHODS.map(m=>`<option ${old&&old.method===m?"selected":""}>${m}</option>`).join("")}</select></label>
    <label class="f">Reference no.<input id="y-ref" value="${esc(old?old.ref:"")}" placeholder="GCash / bank ref"></label>
    <div class="form-grid span" id="y-check" ${old&&old.method==="Check"?"":"hidden"}>
      <label class="f">Bank<input id="y-bank" maxlength="80" value="${esc(old&&old.check?old.check.bank:"")}"></label>
      <label class="f">Check no.<input id="y-chkno" maxlength="40" value="${esc(old&&old.check?old.check.number:"")}"></label>
      <label class="f">Check date<input id="y-chkdate" type="date" value="${esc(old&&old.check?old.check.date:today())}"><span class="hint">A later date is held until then: it doesn't reduce the balance yet.</span></label>
    </div>
    <label class="f span">Note<input id="y-note" value="${esc(old?old.note:"")}"></label>
    <div class="span" id="y-pick"></div>
    <div class="span" id="y-alloc"></div>
    <div class="actions span"><button class="btn primary" type="submit" id="y-go">${editId?"Save changes":"Record payment"}</button><button class="btn" type="button" data-back>Cancel</button></div></form>`,sh=>{
    let O={open:[],credit:0};
    const amt=()=>r2($("#y-amt").value);
    // FR-085: pay chosen deliveries instead of oldest-first.
    let pickOn=!!((old&&old.alloc&&old.alloc.length)||(preset&&preset.deliveryId)), pickDealer=old?old.dealerId:dealerId;
    const picks=new Map(old&&old.alloc?old.alloc.map(a=>[a.id,a.amount]):preset&&preset.deliveryId?[[preset.deliveryId,r2(preset.amount)]]:[]);
    const pickSum=()=>r2([...picks.values()].reduce((a,v)=>a+(Number(v)||0),0));
    const pickBox=()=>{ const box=$("#y-pick",sh); if(!$("#y-dealer").value||!O.open.length){ box.innerHTML=""; return; }
      for(const k of [...picks.keys()]) if(!O.open.some(o=>o.id===k)) picks.delete(k);
      box.innerHTML=`<label class="chk"><input type="checkbox" id="y-pickon" ${pickOn?"checked":""}> Choose which deliveries this payment is for</label>
        ${pickOn?`<div class="alloc" style="margin-top:8px">${O.open.map(o=>`<div class="alloc-r"><label class="chk" style="flex:1;min-width:0"><input type="checkbox" data-pick="${o.id}" ${picks.has(o.id)?"checked":""}> <span><b>${esc(o.t.no||"")}</b> <span class="muted small">due ${fmtDate(o.t.dueDate)} · ${P(o.rem)} unpaid</span></span></label>
          <input type="number" class="pick-amt" data-pamt="${o.id}" min="0.01" step="0.01" max="${o.rem}" inputmode="decimal" value="${picks.has(o.id)?picks.get(o.id):""}" ${picks.has(o.id)?"":"disabled"} aria-label="Amount for ${esc(o.t.no||"this delivery")}"></div>`).join("")}
          <p class="small muted" style="margin:6px 0 0">Any amount not assigned here pays the oldest unpaid delivery.</p></div>`:""}`; };
    $("#y-pick",sh).addEventListener("change",e=>{ const t=e.target;
      if(t.id==="y-pickon"){ pickOn=t.checked; if(!pickOn) picks.clear(); pickBox(); alloc(); return; }
      if(t.dataset.pick){ const o=O.open.find(x=>x.id===t.dataset.pick); if(t.checked){ const free=r2(amt()-pickSum()); picks.set(o.id,free>0?Math.min(free,o.rem):o.rem); } else picks.delete(o.id);
        if(!(amt()>0)||amt()<pickSum()) $("#y-amt").value=pickSum().toFixed(2);
        pickBox(); alloc(); } });
    $("#y-pick",sh).addEventListener("input",e=>{ const id=e.target.dataset.pamt; if(id){ picks.set(id,r2(e.target.value)); alloc(); } });
    const quick=()=>{ const did=$("#y-dealer").value; if(!did){ $("#y-quick").innerHTML=""; $("#y-alloc").innerHTML=""; return; }
      O=openDeliveries(did,editId); if(did!==pickDealer){ picks.clear(); pickDealer=did; } const bal=r2(O.open.reduce((a,o)=>a+o.rem,0)-O.credit), over=r2(O.open.filter(o=>o.late).reduce((a,o)=>a+o.rem,0));
      const chips=[]; if(bal>0) chips.push(["Full balance",bal]); if(over>0&&over<bal) chips.push(["Overdue only",over]); if(O.open[0]&&O.open.length>1) chips.push([`Oldest ${O.open[0].t.no||"delivery"}`,O.open[0].rem]);
      $("#y-quick").innerHTML=`<div class="f"><span>${bal>0?`Owes <b class="num" style="color:var(--fg)">${P(bal)}</b>${over?` · <span style="color:var(--bad)">${P(over)} overdue</span>`:""}`:bal<0?`Has <b>${P(-bal)}</b> credit`:"Nothing owed right now"}</span>
        ${chips.length?`<div class="chips">${chips.map(([l,v])=>`<button type="button" class="chip" data-amt="${v}" aria-pressed="${amt()===v}">${l}<b class="num">${P(v)}</b></button>`).join("")}<span class="small muted" style="align-self:center">or type any partial amount below</span></div>`:""}</div>`;
      pickBox(); alloc(); };
    const alloc=()=>{ const a=amt(); $$(".chip",sh).forEach(c=>c.setAttribute("aria-pressed",String(Number(c.dataset.amt)===a)));
      if(!$("#y-dealer").value||!(a>0)){ $("#y-alloc").innerHTML=O.open.length&&!pickOn?`<div class="alloc"><div class="alloc-h">Unpaid deliveries</div>${O.open.map(o=>`<div class="alloc-r"><span><b>${esc(o.t.no||"")}</b> <span class="muted small">due ${fmtDate(o.t.dueDate)}</span>${o.paid?` <span class="small muted">· ${P(o.paid)} paid</span>`:""}</span><span class="num">${P(o.rem)}</span></div>`).join("")}</div>`:""; return; }
      const R=allocate(O.open,a,pickOn?picks:null), bal=r2(O.open.reduce((x,o)=>x+o.rem,0)-O.credit), full=a>=bal-0.004&&bal>0, over=pickOn&&pickSum()>a+0.004;
      $("#y-alloc").innerHTML=`<div class="alloc"><div class="alloc-h">${full?`<span class="pill good">Full payment</span> Clears the whole balance`:bal>0?`<span class="pill warn">Partial payment</span> ${P(r2(bal-a))} will still be owed`:`<span class="pill neutral">Advance payment</span> Kept as credit for the next delivery`}</div>
        ${R.lines.map(l=>{ const o=O.open.find(x=>x.id===l.id); return `<div class="alloc-r"><span><b>${esc(l.no)}</b> <span class="muted small">due ${fmtDate(o.t.dueDate)}</span>${l.chosen?` <span class="pill neutral">chosen</span>`:""}<br><span class="small ${l.cleared?"":"muted"}">${l.cleared?"✓ Fully paid":`${P(l.amount)} of ${P(o.rem)} · ${P(l.left)} left`}</span></span><span class="num">−${P(l.amount)}</span></div>`; }).join("")}
        ${over?`<div class="notice bad" style="margin:8px 0 0"><p class="small">The chosen deliveries add up to ${P(pickSum())}, more than the ${P(a)} received.</p></div>`:""}
        ${R.extra>0.004?`<div class="alloc-r"><span>Extra kept as credit</span><span class="num">${P(R.extra)}</span></div>`:""}</div>`;
      $("#y-go").textContent=editId?"Save changes":`Record ${full?"full":bal>0?"partial":""} payment ${P(a)}`.replace("  "," "); };
    $("#y-dealer").addEventListener("change",quick); $("#y-amt").addEventListener("input",alloc);
    $("#y-quick").addEventListener("click",e=>{ const c=e.target.closest("[data-amt]"); if(c){ $("#y-amt").value=Number(c.dataset.amt).toFixed(2); alloc(); } });
    quick();
    $("#f",sh).addEventListener("submit",e=>{ e.preventDefault(); const btn=e.submitter||$("button[type=submit]",sh);
      const did=$("#y-dealer").value, amount=amt(); if(!did||amount<=0){ toast("Enter the dealer and amount"); return; }
      const O2=openDeliveries(did,editId), usePicks=pickOn&&picks.size>0, R=allocate(O2.open,amount,usePicks?picks:null), bal=r2(O2.open.reduce((x,o)=>x+o.rem,0)-O2.credit);
      if(usePicks&&pickSum()>amount+0.004){ toast("The chosen deliveries add up to more than the amount received","error"); return; }
      for(const [k,v] of picks){ const o=O2.open.find(x=>x.id===k); if(usePicks&&o&&v>o.rem+0.004){ toast(`Only ${P(o.rem)} is unpaid on ${o.t.no||"that delivery"}`,"error"); return; } }
      const isCheck=$("#y-method").value==="Check";
      if(isCheck&&(!$("#y-bank").value.trim()||!$("#y-chkno").value.trim()||!$("#y-chkdate").value)){ toast("Enter the bank, check number and check date","error"); return; }
      const data={...(old||{}),type:"payment",dealerId:did,date:$("#y-date").value,amount,method:$("#y-method").value,...(isCheck?{check:{...(old&&old.check||{}),bank:$("#y-bank").value.trim(),number:$("#y-chkno").value.trim(),date:$("#y-chkdate").value}}:{}),ref:$("#y-ref").value.trim(),note:$("#y-note").value.trim(),
        payKind:amount>=bal-0.004&&bal>0?"full":bal>0?"partial":"advance",applied:R.lines.map(l=>({no:l.no,amount:l.amount,left:l.left,...(l.chosen?{chosen:true}:{})})),balanceBefore:bal};
      if(!isCheck) delete data.check;
      if(usePicks) data.alloc=[...picks].filter(([,v])=>v>0).map(([id,v])=>({id,amount:r2(v)})); else delete data.alloc;
      if(!old){ data.no=nextNo("payment"); data.createdAt=Date.now(); data.createdBy=S.me; } else data.updated=stamp();
      guarded(btn,async()=>{ const ref=db.collection("txns").doc(editId||undefined); await ref.set(data); toast(editId?"Payment updated":`${data.payKind==="full"?"Full":data.payKind==="partial"?"Partial":"Advance"} payment ${data.no} recorded`); if(editId) back(); else { stack.pop(); receiptSheet(ref.id); } });
    });
  }]);
}
function adjustmentForm(dealerId,editId){
  if(!activeDealers().length&&!editId){ toast("Add a dealer first"); dealerForm(); return; }
  const old=editId?S.txns.get(editId):null;
  show(()=>[head(editId?`Edit adjustment ${esc(old.no||"")}`:"Adjustment","Add a debit or credit that is not a sale, payment or return.")+`<form id="f" class="form-grid">
    <label class="f span">Dealer<select id="a-dealer" required><option value="">Choose dealer…</option>${dealerOptions(old?old.dealerId:dealerId)}</select></label>
    <label class="f">Direction<select id="a-dir"><option value="debit" ${old&&old.direction==="debit"?"selected":""}>Debit — increases what the dealer owes</option><option value="credit" ${old&&old.direction==="credit"?"selected":""}>Credit — reduces what the dealer owes</option></select></label>
    <label class="f">Amount (₱)<input id="a-amt" type="number" min="0.01" step="0.01" required value="${old?old.amount:""}"></label>
    <label class="f">Date<input id="a-date" type="date" required value="${old?old.date:today()}"></label>
    <label class="f" id="a-duewrap">Due date<input id="a-due" type="date" value="${old?(old.dueDate||""):""}"><span class="hint">Optional. A debit with a due date counts as overdue like a delivery.</span></label>
    <label class="f span">Reason<input id="a-reason" maxlength="160" value="${esc(old?old.reason:"")}" placeholder="e.g. freight, correction, goodwill credit"></label>
    <label class="f span">Note<input id="a-note" value="${esc(old?old.note:"")}"></label>
    <div class="actions span"><button class="btn primary" type="submit">${old?"Save changes":"Record adjustment"}</button><button class="btn" type="button" data-back>Cancel</button></div></form>`,sh=>{
    const sync=()=>{ $("#a-duewrap",sh).hidden=$("#a-dir",sh).value!=="debit"; }; $("#a-dir",sh).addEventListener("change",sync); sync();
    $("#f",sh).addEventListener("submit",e=>{ e.preventDefault(); const btn=e.submitter||$("button[type=submit]",sh);
      const did=$("#a-dealer").value, amount=r2($("#a-amt").value), direction=$("#a-dir").value;
      if(!did||amount<=0){ toast("Choose the dealer and enter an amount"); return; }
      const data={...(old||{}),type:"adjustment",dealerId:did,direction,amount,date:$("#a-date").value,dueDate:direction==="debit"?($("#a-due").value||null):null,reason:$("#a-reason").value.trim(),note:$("#a-note").value.trim()};
      if(!old){ data.no=nextNo("adjustment"); data.createdAt=Date.now(); data.createdBy=S.me; } else data.updated=stamp();
      guarded(btn,async()=>{ await db.collection("txns").doc(editId||undefined).set(data); toast(old?"Adjustment updated":"Adjustment recorded"); back(); });
    });
  }]);
}
function writeoffForm(dealerId,editId){
  if(!activeDealers().length&&!editId){ toast("Add a dealer first"); dealerForm(); return; }
  const old=editId?S.txns.get(editId):null;
  show(()=>{ const did=old?old.dealerId:dealerId, bal=did?status(did).balance:0;
  return [head(editId?`Edit write-off ${esc(old.no||"")}`:"Write off bad debt","Remove an amount from the dealer's balance when it will not be collected.")+`<form id="f" class="form-grid">
    <label class="f span">Dealer<select id="w-dealer" required><option value="">Choose dealer…</option>${dealerOptions(did)}</select></label>
    <div class="span notice warn"><p><b>Current balance: <span id="w-bal">${P(bal)}</span></b><span id="w-hint">${bal>0?"":" · This dealer has no balance to write off."}</span></p></div>
    <label class="f">Amount to write off (₱)<input id="w-amt" type="number" min="0.01" step="0.01" required value="${old?old.amount:""}"></label>
    <label class="f">Date<input id="w-date" type="date" required value="${old?old.date:today()}"></label>
    <label class="f span">Reason<input id="w-reason" required maxlength="160" value="${esc(old?old.reason:"")}" placeholder="e.g. unreachable, closed business"></label>
    <label class="f span">Note<input id="w-note" value="${esc(old?old.note:"")}"></label>
    <div class="actions span"><button class="btn danger" type="submit">${old?"Save changes":"Write off"}</button><button class="btn" type="button" data-back>Cancel</button></div></form>`,sh=>{
    const refresh=()=>{ const b=status($("#w-dealer",sh).value).balance; $("#w-bal",sh).textContent=P(b); $("#w-hint",sh).textContent=b>0?"":" · This dealer has no balance to write off."; };
    $("#w-dealer",sh).addEventListener("change",refresh); refresh();
    $("#f",sh).addEventListener("submit",e=>{ e.preventDefault(); const btn=e.submitter||$("button[type=submit]",sh);
      const wid=$("#w-dealer").value, amount=r2($("#w-amt").value), reason=$("#w-reason").value.trim();
      if(!wid||amount<=0||!reason){ toast("Choose the dealer, amount and reason"); return; }
      const data={...(old||{}),type:"writeoff",dealerId:wid,amount,date:$("#w-date").value,reason,note:$("#w-note").value.trim()};
      if(!old){ data.no=nextNo("writeoff"); data.createdAt=Date.now(); data.createdBy=S.me; } else data.updated=stamp();
      guarded(btn,async()=>{ await db.collection("txns").doc(editId||undefined).set(data); toast(old?"Write-off updated":`${P(amount)} written off`); back(); });
    });
  }]; });
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
    ${items.length?`<section class="panel" style="margin-bottom:16px"><div class="tbl-wrap"><table><thead><tr><th>#</th><th>Item</th><th class="r">Qty</th><th class="r">Price each</th><th class="r">Amount</th></tr></thead><tbody>
      ${items.map((i,k)=>`<tr><td class="muted num">${k+1}</td><td><div class="prod-cell">${thumb(S.products.get(i.productId),1)}<span>${esc(i.name)}</span></div></td><td class="r num">${i.qty}</td><td class="r num">${P(i.price)}</td><td class="r num">${P(i.qty*i.price)}</td></tr>`).join("")}</tbody>
      <tfoot>${t.pctDiscount||t.discount?`<tr><td colspan="4" class="r">${t.pctDiscount?"Total at SRP":"Subtotal"}</td><td class="r num">${P(t.subtotal??items.reduce((a,i)=>a+i.qty*i.price,0))}</td></tr>`:""}${t.pctDiscount?`<tr><td colspan="4" class="r">${discLabel(t)}</td><td class="r num">−${P(t.pctDiscount)}</td></tr>`:""}${t.discount?`<tr><td colspan="4" class="r">Extra discount</td><td class="r num">−${P(t.discount)}</td></tr>`:""}<tr><td colspan="4" class="r">Total</td><td class="r num">${P(t.amount)}</td></tr></tfoot></table></div></section>`:""}
    ${canEditTx(t)?(t.voided?`<div class="actions"><button class="btn" id="t-unvoid" type="button">Restore this ${TYPE_LABEL[t.type].toLowerCase()}</button>${t.sample?`<button class="btn danger" id="t-del" type="button">Delete permanently</button>`:""}</div>`:
      `<div class="actions"><button class="btn primary" data-act="receipt" data-id="${esc(id)}" type="button">Receipt</button><button class="btn" id="t-edit" type="button">Edit</button><button class="btn" data-dealer="${t.dealerId}" type="button">Open dealer</button></div>
      <section class="panel" style="margin-top:16px"><h2>Void this record</h2><p class="small" style="margin-top:0">Voiding keeps the record for your history but removes it from balances and reports${t.type!=="payment"?", and reverses its stock change":""}.</p>
      <div class="actions"><input id="t-reason" placeholder="Reason, e.g. wrong dealer" style="flex:1;min-width:180px"><button class="btn danger" id="t-void" type="button">Void</button></div></section>`):(S.canWrite?`<div class="notice info"><p>Only the owner or an editor can change this record. Staff can edit or void only what they recorded today.</p><button class="btn sm" data-dealer="${t.dealerId}" type="button">Open dealer</button></div>`:"")}`,sh=>{
    const ed=$("#t-edit",sh); if(ed) ed.addEventListener("click",()=>t.opening?openingForm(null,id):t.type==="payment"?paymentForm(null,id):t.type==="adjustment"?adjustmentForm(null,id):t.type==="writeoff"?writeoffForm(null,id):itemsForm(t.type,null,id));
    const vd=$("#t-void",sh); if(vd) vd.addEventListener("click",()=>{ if(armed(vd,"Tap again to void")) guarded(vd,async()=>{ const why=$("#t-reason").value.trim(), nt={...t,voided:true,voidedAt:Date.now(),voidedBy:S.me,voidReason:why};
      try{ await db.doc("txns/"+id).set(nt); toast(`${t.no||"Record"} voided`); }
      catch(err){ if(err&&err.code!=="needs_approval") throw err; if(why.length<3){ toast("Enter a reason, then void again. It goes to the owner for approval.","error"); return; } await window.APP.call("POST","/api/signoffs",{txnId:id,reason:why}); toast("Sent to the owner for approval"); back(); } }); });
    const uv=$("#t-unvoid",sh); if(uv) uv.addEventListener("click",()=>guarded(uv,async()=>{ const nt={...t,voided:false,updated:stamp()}; delete nt.voidedAt; delete nt.voidedBy; delete nt.voidReason; await db.doc("txns/"+id).set(nt); toast("Restored"); }));
    const dl=$("#t-del",sh); if(dl) dl.addEventListener("click",()=>{ if(armed(dl,"Tap again to delete")) guarded(dl,async()=>{ await db.doc("txns/"+id).delete(); toast("Deleted"); back(); }); });
  }]; },true);
}

/* ================= bulk actions ================= */
async function clearSamples(btn){
  await guarded(btn,async()=>{ btn.textContent="Removing…";
    for(const c of ["txns","moves","dealers","products"]) for(const [id,x] of [...S[c]]) if(x.sample){ await db.doc(c+"/"+id).delete(); if(c==="products"&&x.imageId&&assets) assets.delete(x.imageId).catch(()=>{}); }
    toast("Examples removed"); });
}
function restoreFullFlow(file){
  const area=$("#restoreArea"); const rd=new FileReader();
  rd.onload=()=>{ let data; try{ data=JSON.parse(rd.result); if(data.app!=="dealer-credit-ledger"||!data.collections) throw 0; }catch(e){ area.innerHTML=`<div class="notice bad" style="margin-top:12px"><p>That file isn't a full ledger backup. Choose one made with “Download full backup”.</p></div>`; return; }
    const counts=Object.entries(data.collections||{}).map(([c,rows])=>`${rows.length} ${c}`).join(", ");
    area.innerHTML=`<div class="notice warn" style="margin-top:12px"><p>Full backup from <b>${esc(fmtStamp(Date.parse(data.exportedAt)))}</b>: ${esc(counts)}${data.users?`, ${data.users.length} accounts`:""}${data.assets?`, ${data.assets.length} photos`:""}. Restoring overwrites matching records, accounts and photos, and keeps anything added since.</p><button class="btn danger sm" id="doFullRestore" type="button">Restore full backup now</button></div>`;
    const b=$("#doFullRestore"); b.addEventListener("click",()=>{ if(!armed(b,"Tap again to restore")) return; guarded(b,async()=>{ const r=await window.APP.backupRestore(data,true); area.innerHTML=`<div class="notice info" style="margin-top:12px"><p>Restored ${r.docs||0} records, ${r.users||0} accounts and ${r.assets||0} photos.</p></div>`; toast("Full backup restored"); }); });
  };
  rd.readAsText(file);
}
function backupJson(){
  const out={app:"dealer-credit-ledger",version:2,exportedAt:new Date().toISOString(),settings:S.settings};
  COLS.forEach(c=>out[c]=Object.fromEntries(S[c])); return JSON.stringify(out,null,1);
}
function restoreFlow(file){
  const area=$("#restoreArea"); const rd=new FileReader();
  rd.onload=()=>{ let data; try{ data=JSON.parse(rd.result); if(data.app!=="dealer-credit-ledger") throw 0; }catch(e){ area.innerHTML=`<div class="notice bad" style="margin-top:12px"><p>That file isn't a ledger backup. Choose a file made with “Download backup”.</p></div>`; return; }
    const counts=COLS.map(c=>`${Object.keys(data[c]||{}).length} ${c==="txns"?"transactions":c==="moves"?"stock changes":c}`).join(", ");
    area.innerHTML=`<div class="notice warn" style="margin-top:12px"><p>Backup from <b>${esc(fmtStamp(Date.parse(data.exportedAt)))}</b>: ${esc(counts)}. Restoring overwrites records with the same ID and keeps anything added since.</p><button class="btn danger sm" id="doRestore" type="button">Restore now</button></div><div class="progress" hidden id="rp"><i></i></div>`;
    const b=$("#doRestore"); b.addEventListener("click",()=>{ if(!armed(b,"Tap again to restore")) return; guarded(b,async()=>{
      const jobs=[]; COLS.forEach(c=>Object.entries(data[c]||{}).forEach(([id,doc])=>jobs.push([c,id,doc])));
      const rp=$("#rp"); rp.hidden=false; let i=0;
      if(data.settings&&Object.keys(data.settings).length&&S.canAdmin) await db.doc("settings/store").set(data.settings,{restore:true});
      for(const [c,id,doc] of jobs){ await db.doc(`${c}/${id}`).set(doc,{restore:true}); i++; if(i%5===0||i===jobs.length) $("i",rp).style.width=(i/jobs.length*100)+"%"; }
      area.innerHTML=`<div class="notice info" style="margin-top:12px"><p>Restored ${jobs.length} records.</p></div>`; toast("Backup restored"); }); });
  };
  rd.readAsText(file);
}

/* ================= team accounts (Node.js server) ================= */
const ROLE_L={owner:"Owner",editor:"Editor",staff:"Staff",viewer:"Viewer",dealer:"Dealer portal"};
async function loadTeam(){ try{ S.acct=await window.APP.me(); S.team=await window.APP.users(); $("#acct").innerHTML=`Signed in as <b>${esc(S.acct.name)}</b> (${esc(ROLE_L[S.acct.role]||S.acct.role)}) · <button class="linkbtn" data-act="logout" type="button">Sign out</button>`; render(); loadBackupStatus(); }catch(e){} }
// Server backup health for owners and editors (FR-067, PR-08).
async function loadBackupStatus(){ if(!window.APP||!window.APP.backupStatus||!S.acct||!["owner","editor"].includes(S.acct.role)) return; try{ S.backup=await window.APP.backupStatus(); render(); }catch(e){} }
setInterval(loadBackupStatus,3600e3);
function backupProblems(){ const b=S.backup; if(!b) return []; const out=[], now=Date.now();
  if(!b.lastSuccessAt) out.push(["bad","No server backup has been made yet."]);
  else if(now-b.lastSuccessAt>7*864e5) out.push(["bad",`The last good server backup was ${Math.floor((now-b.lastSuccessAt)/864e5)} days ago.`]);
  if(b.lastErrorAt&&(!b.lastSuccessAt||b.lastErrorAt>b.lastSuccessAt)) out.push(["bad",`The last backup failed: ${b.lastError}`]);
  if(!b.offsiteConfigured) out.push(["warn","Backups are kept only on this server. Set BACKUP_SYNC_CMD so a copy goes offsite."]);
  else if(b.offsite&&b.offsite.lastErrorAt&&(!b.offsite.lastSuccessAt||b.offsite.lastErrorAt>b.offsite.lastSuccessAt)) out.push(["bad",`The offsite backup copy failed: ${b.offsite.lastError}`]);
  return out; }
function portalPanel(){
  const me=S.acct||{}, owner=me.role==="owner", list=(S.team||[]).filter(u=>u.role==="dealer"), link=location.origin+"/login";
  return `<section class="panel"><div class="panel-head"><h2>Dealer portal</h2>${owner?`<button class="btn sm primary" data-act="new-portal" type="button">+ Give a dealer portal access</button>`:""}</div>
    <p class="small" style="margin-top:0">Dealers sign in at the same address as your team. They see only their own balance, unpaid deliveries, receipts and payment history, can order online, and accept your privacy notice.</p>
    <div class="link-row" style="margin-bottom:12px"><input readonly value="${esc(link)}" aria-label="Sign-in link for dealers" id="portal-link"><button class="btn sm" type="button" data-act="copy-portal-link">Copy link</button><a class="btn sm" href="/login" target="_blank" rel="noopener">Open sign-in page</a></div>
    ${list.length?`<table><thead><tr><th>Dealer</th><th>Username</th><th>Status</th></tr></thead><tbody>${list.map(u=>{ const d=S.dealers.get(u.dealerId); return `<tr ${owner?`class="click" tabindex="0" data-act="edit-user" data-id="${u.id}"`:""}><td>${d?`<div class="prod-cell">${avatar(d,28)}<b>${esc(d.name)}</b></div>`:"(dealer removed)"}</td><td class="small">${esc(u.username||"")}</td><td><span class="pill ${u.active?"good":"bad"}">${u.active?"Can sign in":"Disabled"}</span></td></tr>`; }).join("")}</tbody></table>`
      :`<p class="small muted" style="margin:0">No dealer has portal access yet. ${owner?"Tap “Give a dealer portal access”, choose the dealer and a username and password, then send them the link above.":"Ask the owner to set it up."}</p>`}
  </section>`;
}
function teamPanel(){
  const me=S.acct||{}, owner=me.role==="owner", list=S.team||[];
  return window.LedgerOps.storePanels()+window.LedgerOps.passwordPanel(owner)+portalPanel()+`<section class="panel"><div class="panel-head"><h2>Team accounts</h2>${owner?`<button class="btn sm primary" data-act="new-user" type="button">+ Add person</button>`:""}</div>
    ${list.length?`<table><tbody>${list.map(u=>`<tr><td><b>${esc(u.name)}</b>${u.id===me.id?" (you)":""}<div class="small muted">${esc(u.username||"")}</div></td><td><span class="pill ${u.active?(u.role==="dealer"?"good":"neutral"):"bad"}">${u.active?ROLE_L[u.role]:"Disabled"}</span>${u.twoStep?` <span class="pill good">2-step</span>`:""}${u.role==="dealer"&&u.dealerId?`<div class="small muted">${esc((S.dealers.get(u.dealerId)||{}).name||"")}</div>`:""}</td><td class="r">${owner&&u.id!==me.id?`<button class="btn sm" data-act="edit-user" data-id="${esc(u.id)}" type="button">Edit</button>`:""}</td></tr>`).join("")}</tbody></table>`:`<p class="small muted">Loading…</p>`}
    <dl class="kv" style="margin-top:12px"><dt><span class="pill neutral">Staff</span></dt><dd>Record sales, payments, returns and stock. Can edit or void only what they recorded today. Can't change prices, credit limits or settings, or release goods to dealers on hold.</dd>
    <dt><span class="pill neutral">Editor</span></dt><dd>Everything staff can do, plus store settings, credit rules, prices, approving credit holds and editing any record.</dd>
    <dt><span class="pill neutral">Viewer</span></dt><dd>Can see everything but change nothing. Good for an accountant.</dd>
    <dt><span class="pill neutral">Owner</span></dt><dd>Everything, plus adding and disabling team accounts.</dd>
    <dt><span class="pill good">Dealer portal</span></dt><dd>For a dealer: sees only their own balance, due dates, receipts, payment history and your catalog. Set it up from the dealer's page with “Portal access”.</dd></dl>
  </section>
  <section class="panel"><h2>Your account</h2><p class="small" style="margin-top:0">Signed in as <b>${esc(me.name||"")}</b> (${esc(me.username||"")}) · ${ROLE_L[me.role]||""}</p>
    <p class="small">${me.twoStep?`<span class="pill good">Two-step sign-in is on</span> A code from your authenticator app is needed each time you sign in.`:`<span class="pill ${["owner","editor"].includes(me.role)?"warn":"neutral"}">Two-step sign-in is off</span> ${["owner","editor"].includes(me.role)?"Turn it on: your account can change prices, credit limits and records.":"Turn it on for extra protection if your phone is lost."}`}</p>
    <div class="actions"><button class="btn sm" data-act="change-pw" type="button">Change password</button>${me.twoStep?`<button class="btn sm" data-act="2fa-off" type="button">Turn off two-step sign-in</button>`:`<button class="btn sm primary" data-act="2fa-setup" type="button">Set up two-step sign-in</button>`}<button class="btn sm" data-act="signout-others" type="button">Sign out my other devices</button><button class="btn sm" data-act="logout" type="button">Sign out</button></div></section>
  ${S.canAdmin?`<section class="panel"><div class="panel-head"><h2>Activity log</h2><button class="btn sm" data-act="load-audit" type="button">${S.audit?"Refresh":"Show recent activity"}</button></div>${S.audit?auditTable():`<p class="small muted" style="margin:0">Every sign-in, change and deletion is recorded with who did it and when.</p>`}</section>`:""}`;
}
function auditTable(){
  const lbl={merge:"Merged duplicates",supplier_payment:"Paid a supplier",stock_transfer:"Moved stock",void_request:"Asked to void",void_approve:"Approved a void",void_reject:"Refused a void",password_forgot:"Forgot password",password_recover:"Reset password with a recovery code",cash_close:"Closed the day",cash_reopen:"Reopened a day",period_close:"Closed the books",period_reopen:"Reopened the books",check_cleared:"Check cleared",check_bounced:"Check bounced",remittance:"Handed in remittance",remittance_approve:"Approved remittance",proof_submit:"Dealer sent proof of payment",proof_approve:"Approved proof of payment",proof_reject:"Rejected proof of payment",goods_received:"Received goods",reminders_run:"Sent reminders",create:"Added",update:"Changed",delete:"Deleted",restore:"Restored",stock:"Stock changed",login:"Signed in",upload:"Photo added",setup:"Created the ledger",password_change:"Changed password",user_create:"Added account",user_update:"Changed account","2fa_enabled":"Turned on two-step sign-in","2fa_disabled":"Turned off two-step sign-in","2fa_recovery_used":"Used a recovery code",signout_others:"Signed out other devices",signout_everywhere:"Signed someone out everywhere",backup_run:"Ran a backup",asset_cleanup:"Removed unused pictures",approval_request:"Asked for approval",approval_approve:"Approved a sale",approval_reject:"Rejected a request",approval_withdraw:"Withdrew a request",view_profile:"Opened a dealer profile",personal_data_export:"Exported personal data",personal_data_anonymise:"Removed personal data",consent_given:"Accepted the privacy notice"};
  const what=a=>{ let d={}; try{ d=JSON.parse(a.detail||"{}")||{}; }catch(e){}
    if(a.collection==="txns") return `${esc(d.no||"")} ${esc(TYPE_LABEL[d.type]||"")} ${d.amount?P(d.amount):""}${d.voided?" (voided)":""}`;
    if(a.collection==="dealers"||a.collection==="products") return esc(d.name||"");
    if(a.collection==="users") return esc(d.username||"");
    return ""; };
  return `<div class="tbl-wrap" style="max-height:420px;overflow:auto"><table><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>${S.audit.map(a=>`<tr><td class="small nowrap">${fmtStamp(a.at)}</td><td class="small">${esc(a.user_name||"—")}</td><td class="small">${esc(lbl[a.action]||a.action)} ${a.collection&&!["txns","users"].includes(a.collection)?`<span class="muted">${esc(a.collection)}</span> `:""}${what(a)}</td></tr>`).join("")}</tbody></table></div>`;
}
function userForm(id,presetDealer,presetRole){
  const u=id?(S.team||[]).find(x=>x.id===id):null; const pd=presetDealer?S.dealers.get(presetDealer):null;
  show(()=>[head(u?`Edit ${esc(u.name)}`:"Add a person")+`<form id="f" class="form-grid">
    <label class="f span">Full name<input id="u-name" required maxlength="80" value="${esc(u?u.name:pd?pd.name:"")}"></label>
    ${u?`<div class="f"><span>Username</span><b style="color:var(--fg)">${esc(u.username)}</b></div>`:`<label class="f">Username<input id="u-user" required autocapitalize="none" placeholder="e.g. ben" pattern="[A-Za-z0-9._\\-]{3,40}"><span class="hint">3–40 letters or numbers. They type this to sign in.</span></label>`}
    <label class="f">Role<select id="u-role">${["staff","editor","viewer","dealer"].map(r=>`<option value="${r}" ${(u?u.role===r:(pd||presetRole==="dealer")&&r==="dealer")?"selected":""}>${ROLE_L[r]}</option>`).join("")}</select></label>
    <label class="f span" id="u-dwrap">Which dealer<select id="u-dealer"><option value="">Choose dealer…</option>${activeDealers().map(([did,dd])=>`<option value="${did}" ${(u?u.dealerId===did:presetDealer===did)?"selected":""}>${esc(dd.name)}</option>`).join("")}</select><span class="hint">They will only see this dealer's own records.</span></label>
    <label class="f">${u?"New password (leave blank to keep)":"Password"}<input id="u-pw" type="password" autocomplete="new-password" ${u?"":"required"} minlength="8" placeholder="At least 8 characters"></label>
    <label class="chk span" id="u-cwrap"><input type="checkbox" id="u-coll" ${u&&u.collector?"checked":""}> Collector: has a route and hands in a daily remittance</label>
    ${u?`<label class="chk span"><input type="checkbox" id="u-active" ${u.active?"checked":""}> Account active (untick to block sign-in right away)</label>`:""}
    <div class="actions span"><button class="btn primary" type="submit">${u?"Save changes":"Add person"}</button><button class="btn" type="button" data-back>Cancel</button></div></form>
    ${u?`<section class="panel" style="margin-top:16px"><h2>Lost phone or left the business?</h2><p class="small" style="margin-top:0">“Sign out everywhere” ends all of ${esc(u.name)}'s sessions. Phones that saved ledger data for offline use delete it the next time they connect.</p>
      <div class="actions"><button class="btn danger" type="button" id="u-signout">Sign out everywhere</button>${u.twoStep?`<button class="btn" type="button" id="u-reset2">Reset two-step sign-in</button>`:""}</div></section>`:""}`,sh=>{
    const so=$("#u-signout",sh); if(so) so.addEventListener("click",()=>{ if(armed(so,"Tap again to sign out")) guarded(so,async()=>{ await window.APP.signoutUser(u.id); toast(`${u.name} was signed out everywhere`); so.disabled=false; so.textContent="Sign out everywhere"; }); });
    const r2b=$("#u-reset2",sh); if(r2b) r2b.addEventListener("click",()=>{ if(armed(r2b,"Tap again to reset")) guarded(r2b,async()=>{ await window.APP.updateUser(u.id,{resetTwoStep:true}); await loadTeam(); toast(`Two-step sign-in reset for ${u.name}. They can set it up again.`); back(); }); });
    const syncRole=()=>{ const v=$("#u-role",sh).value; $("#u-dwrap",sh).hidden=v!=="dealer"; $("#u-cwrap",sh).hidden=!["staff","editor"].includes(v); }; $("#u-role",sh).addEventListener("change",syncRole); syncRole();
    $("#u-dealer",sh).addEventListener("change",e=>{ const d=S.dealers.get(e.target.value), n=$("#u-name",sh); if(d&&!n.value.trim()) n.value=d.name; });
    $("#f",sh).addEventListener("submit",e=>{ e.preventDefault(); const btn=e.submitter||$("button[type=submit]",sh);
      const pw=$("#u-pw").value; const body={name:$("#u-name").value.trim(),role:$("#u-role").value};
      if(body.role==="dealer"){ body.dealerId=$("#u-dealer").value; if(!body.dealerId){ toast("Choose which dealer this account is for"); return; } }
      if(pw) body.password=pw; if(u) body.active=$("#u-active").checked; else body.username=$("#u-user").value.trim();
      guarded(btn,async()=>{ const collector=["staff","editor"].includes(body.role)&&$("#u-coll").checked; if(u) await window.APP.updateUser(u.id,{...body,collector}); else { const made=await window.APP.createUser(body); if(collector) await window.APP.updateUser(made.id,{collector}); } await loadTeam(); toast(u?"Account updated":"Account added. Give them their username and password."); back(); });
    });
  }]);
}
function twoStepSheet(){
  let step="loading", setup=null, codes=null;
  show(()=>{
    if(step==="loading") return [head("Set up two-step sign-in")+`<div class="empty"><p>Preparing…</p></div>`];
    if(step==="codes") return [head("Save your recovery codes")+`<div class="notice warn"><p><b>Write these down or save them somewhere safe.</b> Each one works once, if you lose your phone. They won't be shown again.</p></div>
      <pre class="stmt" id="rc-list">${esc(codes.join("\n"))}</pre><div class="actions" style="margin-top:12px"><button class="btn" type="button" id="rc-copy">Copy</button><button class="btn primary" type="button" data-close>I saved them</button></div>`,sh=>{ $("#rc-copy",sh).addEventListener("click",()=>copyText(codes.join("\n"),"Recovery codes")); }];
    return [head("Set up two-step sign-in","After this, signing in needs your password and a 6-digit code from an app on your phone.")+`
      <ol class="small" style="padding-left:18px"><li>Install an authenticator app on your phone, such as Google Authenticator, Microsoft Authenticator or Authy.</li>
      <li>In the app, add an account and scan this code. On this phone, tap “Open in authenticator app” instead.</li>
      <li>Type the 6 digits the app shows.</li></ol>
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center"><img src="${esc(setup.qr)}" alt="QR code for your authenticator app" width="180" height="180" style="border:1px solid var(--line);border-radius:8px;background:#fff">
        <div><div class="small muted">Or type this key:</div><code style="font-size:15px;user-select:all">${esc(setup.secret)}</code><div style="margin-top:8px"><a class="btn sm" href="${esc(setup.otpauth)}">Open in authenticator app</a></div></div></div>
      <form id="tf" class="form-grid" style="margin-top:14px"><label class="f">Code from the app<input id="t-code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required placeholder="123456"></label>
        <div class="actions span"><button class="btn primary" type="submit">Turn on</button><button class="btn" type="button" data-back>Cancel</button></div></form>`,sh=>{
      $("#tf",sh).addEventListener("submit",e=>{ e.preventDefault(); const btn=e.submitter||$("button[type=submit]",sh);
        guarded(btn,async()=>{ const r=await window.APP.twoStepEnable($("#t-code",sh).value.trim()); codes=r.recoveryCodes; step="codes"; await loadTeam(); paintSheet(true); toast("Two-step sign-in is on. Your other devices were signed out."); }); }); }];
  },true);
  window.APP.twoStepSetup().then(r=>{ setup=r; step="scan"; paintSheet(true); },e=>{ toast(errMsg(e),"error"); back(); });
}
function twoStepOffSheet(){
  show(()=>[head("Turn off two-step sign-in")+`<form id="f" class="form-grid"><p class="small span" style="margin:0">Signing in will need only your password again.</p>
    <label class="f">Your password<input id="t-pw" type="password" autocomplete="current-password" required></label>
    <div class="actions span"><button class="btn danger" type="submit">Turn off</button><button class="btn" type="button" data-back>Cancel</button></div></form>`,sh=>{
    $("#f",sh).addEventListener("submit",e=>{ e.preventDefault(); const btn=e.submitter||$("button[type=submit]",sh);
      guarded(btn,async()=>{ await window.APP.twoStepDisable($("#t-pw",sh).value); await loadTeam(); toast("Two-step sign-in is off"); back(); }); });
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
  const sfb=e.target.closest("[data-sf]"); if(sfb){ S.stageF=sfb.dataset.sf; render(); return; }
  const cf=e.target.closest("[data-cf]"); if(cf){ S.collectAll=cf.dataset.cf==="all"; render(); return; }
  const pre=e.target.closest("[data-preset]"); if(pre){ S.range.preset=pre.dataset.preset; if(S.range.preset==="custom"&&!S.range.from){ const [f,t]=[addDays(today(),-30),today()]; S.range.from=f; S.range.to=t; } render(); return; }
  const a=e.target.closest("[data-act]");
  if(a){ const act=a.dataset.act, id=a.dataset.id;
    const opsAct=window.LedgerOps.actions(a,id); if(opsAct){ opsAct(); return; }
    ({ "new-sale":()=>itemsForm("sale"), "new-pay":()=>paymentForm(), "new-return":()=>itemsForm("return"),
       "sale-for":()=>itemsForm("sale",id), "pay-for":()=>paymentForm(id), "ret-for":()=>itemsForm("return",id),
       "adjust-for":()=>adjustmentForm(id), "writeoff-for":()=>writeoffForm(id),
       "new-dealer":()=>dealerForm(), "new-prospect":()=>dealerForm(null,"lead"), "log-contact":()=>contactForm(id), "edit-contact":()=>contactForm(null,id), "fu-done":()=>markFollowUpDone(id,a), "edit-dealer":()=>dealerForm(id), "new-product":()=>productForm(),
       "stock-in":()=>stockForm(), "stock-for":()=>stockForm(id), "clear-samples":()=>{ if(armed(a,"Tap again to remove")) clearSamples(a); },
       "backup":async()=>{ if(await save(`ledger-backup-${today()}.json`,backupJson())){ lsSet("lastBackup",Date.now()); render(); } },
       "receipt":()=>receiptSheet(id), "aging":()=>agingSheet(), "aging-for":()=>agingSheet(id), "statement":()=>statementSheet(id),
       "dealer-qr":()=>dealerQr(id), "product-qr":()=>productQr(id),
       "go-orders":()=>goView("orders"),
       "catalog":()=>catalogSheet(),
       "pay-amt":()=>paymentForm(id,null,{amount:Number(a.dataset.amt).toFixed(2),deliveryId:a.dataset.did||null}),
       "new-user":()=>userForm(), "portal-for":()=>{ const ex=(S.team||[]).find(u=>u.role==="dealer"&&u.dealerId===id); userForm(ex?ex.id:null,ex?null:id); }, "edit-user":()=>userForm(id), "change-pw":()=>passwordForm(), "2fa-setup":()=>twoStepSheet(), "2fa-off":()=>twoStepOffSheet(), "signout-others":()=>guarded(a,async()=>{ await window.APP.signoutOthers(); toast("Your other devices were signed out"); a.disabled=false; }), "logout":()=>guarded(a,async()=>{ try{ await window.APP.logout(!!a.dataset.armed); }catch(e){ if(e&&e.code==="unsent"){ a.disabled=false; armed(a,"Tap again to discard and sign out"); toast(e.userMsg,"error"); return; } throw e; } }), "held-review":()=>heldSheet(),
       "pd-export":()=>guarded(a,async()=>{ const data=await window.APP.exportDealer(id); await save(`personal-data-${(S.dealers.get(id)||{}).name||id}.json`.replace(/[^\w.-]+/g,"_"),JSON.stringify(data,null,1)); a.disabled=false; }),
       "pd-remove":()=>{ if(!armed(a,"Tap again: remove name, phone, address and notes")) return; guarded(a,async()=>{ await window.APP.anonymiseDealer(id); toast("Personal data removed. Financial records were kept."); closeAll(); }); }, "approvals":()=>approvalsSheet(),
       "load-audit":()=>guarded(a,async()=>{ S.audit=await window.APP.audit(150); render(); }),
       "go-store":()=>goView("store"), "new-portal":()=>userForm(null,null,"dealer"), "copy-portal-link":()=>copyText(location.origin+"/login","Sign-in link"), "all-dealers":()=>{ S.allDealers=true; render(); }, "set-targets":()=>targetsSheet(), "owner-summary":()=>ownerSummarySheet(), "more-tx":()=>{ S.txShow=(S.txShow||100)+500; render(); }, "more-collect":()=>{ S.collectShow=Infinity; render(); }, "backup-run":()=>guarded(a,async()=>{ a.textContent="Backing up…"; try{ S.backup=await window.APP.backupRun(); toast("Backup made and verified"); }catch(e){ if(e&&e.status===500) await loadBackupStatus(); throw e; } render(); }),
       "go-dealers":()=>goView("dealers"), "go-collect":()=>goView("collect"), "count":()=>countSheet(),
       "opening-for":()=>openingForm(id), "new-opening":()=>openingForm(),
       "remind-copy":()=>copyText(reminderText(id),"Reminder message"),
       "remind-mark":()=>guarded(a,async()=>{ const d=S.dealers.get(id); const on=d.lastReminded!==today(); await db.doc("dealers/"+id).update(on?{lastReminded:today(),lastRemindedBy:S.me}:{lastReminded:d.prevReminded||null}); if(on){ await db.doc("dealers/"+id).update({prevReminded:d.lastReminded||null}); await db.collection("interactions").doc().set({dealerId:id,kind:"message",date:today(),outcome:"Payment reminder sent",note:"",followUp:null,followUpDone:false,createdAt:Date.now(),createdBy:S.me}); } toast(on?`${d.name} marked as reminded`:"Reminder unmarked"); }),
        "export-tx":()=>save(`transactions-${today()}.csv`,csv([["Date","No.","Type","Status","Dealer","Items","Subtotal","Dealer discount %","Dealer discount","Extra discount","Amount","Direction","Due date","Method","Reference","Cost","Gross profit","Note"],...[...S.txns.values()].sort((x,y)=>(x.date||"").localeCompare(y.date||"")).map(t=>{ const d=S.dealers.get(t.dealerId), cost=r2((t.items||[]).reduce((a,i)=>a+i.qty*(i.cost!=null?Number(i.cost):Number((S.products.get(i.productId)||{}).cost)||0),0)); const effect=t.voided?0:txnEffect(t); return [t.date,t.no||"",TYPE_LABEL[t.type],t.voided?"Voided":"OK",d?d.name:"",(t.items||[]).map(i=>`${i.name} x${i.qty} @ ${i.price}`).join("; "),t.subtotal??"",t.discountPct??"",t.pctDiscount||"",t.discount||"",t.amount,t.direction||"",t.dueDate||"",t.method||"",t.ref||"",cost||"",t.type==="sale"?r2(t.amount-cost):t.type==="return"?r2(cost-t.amount):"",`${t.note||""}${t.reason?` · ${t.reason}`:""}${t.voided?` · balance effect ${P(effect)}`:""}`]; })])),
        "export-dealers":()=>save(`dealers-${today()}.csv`,csv([["Dealer ID","Stage","Email","Address","Source","Referred by","Tags","Last contact","Next follow-up","Dealer","First name","Middle name","Last name","Age","Gender","Mobile","Area","Credit limit","Terms (days)","Balance","Overdue","Days late","Last payment","Rating","Paid on time %","Avg days to pay","Worst delay (days)","Total credit taken","Total paid","Write-offs","Status"],...[...S.dealers.entries()].map(([id,d])=>{ const st=status(id), h=history(id), c=crmInfo(id); return [id,STAGE_L[stageOf(d)],d.email||"",d.address||"",d.source||"",d.referredBy||"",(d.tags||[]).join("; "),c.last||"",c.next?c.next[1].followUp:"",d.name,d.firstName||"",d.middleName||"",d.lastName||"",Credit.ageOn(d.birthday,today())??"",d.gender||"",d.phone,d.area,d.creditLimit??"",d.terms??"",st.balance,st.overdue,st.maxLate,h.lastPay||"",h.grade.g,h.n?Math.round(h.onTime/h.n*100):"",h.avgDays??"",h.worst,h.taken,h.paid,h.writeoff||0,d.active===false?"Archived":"Active"]; })])),
        "export-products":()=>save(`products-${today()}.csv`,csv([["Product","Category","Code","Dealer price","SRP","Cost","Profit per piece","Margin %","Stock","Reorder level","Status"],...[...S.products.values()].map(p=>{ const profit=p.cost!=null?r2(p.dealerPrice-p.cost):""; return [p.name,p.category||"",p.code||"",p.dealerPrice,p.srp??"",p.cost??"",profit,profit!==""&&p.dealerPrice?Math.round(profit/p.dealerPrice*100):"",p.stock,p.reorderLevel??"",p.active===false?"Archived":"Active"]; })])),
        "export-report":()=>{ const R=reportData(); save(`report-${R.from}-to-${R.to}.csv`,csv([["Report",`${R.from} to ${R.to}`],[],["Credit sales",R.tot.sale],["Discounts",R.tot.discount],["Returns",R.tot.return],["Debit adjustments",R.tot.adjustmentDebit],["Credit adjustments",R.tot.adjustmentCredit],["Write-offs",R.tot.writeoff],["Collections",R.tot.payment],["Cost of goods sold",R.tot.cost],["Gross profit",R.tot.profit],[],["Product","Qty sold","Qty returned","Sales","Cost","Profit"],...Object.values(R.byP).map(p=>[p.name,p.qty,p.ret,r2(p.amt),r2(p.cost),r2(p.profit)]),[],["Dealer","Net sales","Paid","Balance now","Write-offs"],...Object.entries(R.byD).map(([id,d])=>[S.dealers.get(id)?.name||"",r2(d.sale-d.return),r2(d.payment),status(id).balance,r2(d.writeoff)]),[],["Method","Collected"],...Object.entries(R.byM)])); },
        "backup-full":async()=>{ if(!window.APP) return toast("Full backups need the server connection"); await guarded(a,async()=>{ const data=await window.APP.backupFull(); if(await save(`ledger-full-${today()}.json`,JSON.stringify(data,null,1))){ lsSet("lastBackup",Date.now()); toast("Full backup downloaded"); render(); } }); },
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
  else if(id==="tagFilter"){ S.tagF=e.target.value; render(); }
  else if(id==="crm-stage"){ const did=e.target.dataset.id, v=e.target.value; db.doc("dealers/"+did).update({stage:v,updated:stamp()}).then(()=>toast(`Moved to ${STAGE_L[v]}`),err=>toast(errMsg(err))); }
  else if(id==="catFilter"){ S.catFilter=e.target.value; render(); }
  else if(id==="showArch"){ S.showArchived=e.target.checked; render(); }
  else if(id==="rFrom"||id==="rTo"){ S.range[id==="rFrom"?"from":"to"]=e.target.value; render(); }
  else if(id==="restoreFile"&&e.target.files[0]) restoreFlow(e.target.files[0]);
  else if(id==="restoreFullFile"&&e.target.files[0]) restoreFullFlow(e.target.files[0]);
});
document.addEventListener("submit",e=>{
  if(e.target.id!=="storeForm") return; e.preventDefault(); const btn=e.submitter||$("button[type=submit]",e.target);
  const data={storeName:$("#st-name").value.trim(),phone:$("#st-phone").value.trim(),address:$("#st-addr").value.trim(),paymentInfo:$("#st-pay").value.trim(),defaultTerms:Math.max(0,Math.round(Number($("#st-terms").value)||0)),footer:$("#st-foot").value.trim(),defaultLimit:$("#st-limit").value===""?null:r2($("#st-limit").value),holdDays:Math.max(1,Math.round(Number($("#st-hold").value)||60)),approvalHours:Math.min(336,Math.max(1,Math.round(Number($("#st-apph").value)||24))),blockOverLimit:$("#st-block").checked,allowNegativeStock:$("#st-neg").checked,reminderTemplate:$("#st-msg").value.trim(),privacyNotice:$("#st-privacy").value.trim(),retentionYears:Math.min(30,Math.max(1,Math.round(Number($("#st-ret").value)||10))),discountPct:Math.min(100,Math.max(0,Number($("#st-pct").value)||0)),updated:stamp()};
  guarded(btn,async()=>{ await db.doc("settings/store").set(data); toast("Store details saved"); btn.disabled=false; });
});
window.LedgerUI={lsGet,lsSet,S,$,$$,esc,P,fmtDate,fmtStamp,today,addDays,status,head,show,back,toast,errMsg,guarded,armed,render,activeDealers,r2,goView,closeAll,METHODS,saveStore:patch=>db.doc("settings/store").set({...S.settings,...patch})};
const VIEWS=["overview","orders","collect","cash","dealers","products","buying","activity","reports","store"];
// QR codes carry app deep links: #dealer/<id>, #product/<id>, #receipt/<id>,
// #statement/<id>, #order/<id>, #aging[ /<dealerId>] and #summary.
const DEEP_KINDS={dealer:1,product:1,tx:1,receipt:1,statement:1,order:1,aging:1};
function hashTarget(hash){
  const h=String(hash||"").replace(/^#/,""); if(!h) return null;
  let x=h; try{ x=decodeURIComponent(h); }catch(e){}
  if(VIEWS.includes(x)) return {view:x};
  if(x==="summary"||x==="dashboard") return {kind:"summary"};
  if(x==="aging") return {kind:"aging"};
  const slash=x.indexOf("/"); if(slash<1) return null;
  const kind=x.slice(0,slash), id=x.slice(slash+1);
  if(!id||!DEEP_KINDS[kind]) return null;
  return {kind,id};
}
let deepOpened=false;
function fromHash(){ S._deep=null; const t=hashTarget(location.hash); if(!t) return; if(t.view) S.view=t.view; else S._deep=t; }
function openDeepLink(){
  if(deepOpened) return;
  if(!S._deep){ deepOpened=true; return; }
  if(!Object.values(S.loaded).every(Boolean)) return;
  const {kind,id}=S._deep; S._deep=null; deepOpened=true;
  const missing=what=>toast(`That ${what} isn't in this ledger.`,"error");
  if(kind==="summary"){ closeAll(); ownerSummarySheet(); return; }
  if(kind==="aging"){ if(id&&!S.dealers.has(id)) return missing("dealer"); closeAll(); agingSheet(id||undefined); return; }
  if(kind==="dealer"){ if(!S.dealers.has(id)) return missing("dealer"); closeAll(); dealerSheet(id); return; }
  if(kind==="product"){ if(!S.products.has(id)) return missing("product"); closeAll(); productForm(id); return; }
  if(kind==="statement"){ if(!S.dealers.has(id)) return missing("dealer"); closeAll(); statementSheet(id); return; }
  if(kind==="order"){ if(!S.orders.has(id)) return missing("order"); closeAll(); orderSheet(id); return; }
  if(kind==="receipt"||kind==="tx"){ if(!S.txns.has(id)) return missing("receipt"); closeAll(); if(kind==="receipt") receiptSheet(id); else txSheet(id); return; }
}
window.addEventListener("hashchange",()=>{ deepOpened=false; fromHash(); if(S._deep){ render(); openDeepLink(); } else { closeAll(); render(); } });
fromHash(); render();

/* ================= data ================= */
(async()=>{
  const sync=$("#sync"); const use=n=>Promise.resolve(window.claude?.use?.(n)??null).catch(()=>null);
  [db,userNs,downloads,assets]=await Promise.all(["db","user","downloads","assets"].map(use));
  if(!db){ sync.textContent="Not connected"; $("#topActions").hidden=true; $("#main").innerHTML=`<section class="panel"><div class="empty"><h3>The ledger can't be opened here</h3><p>Reload the page. If it keeps happening, check that the server is running.</p></div></section>`; return; }
  if(userNs){ try{ const [c,ad,me]=await Promise.all([userNs.can("data.write"),userNs.canEdit(),userNs.id?userNs.id():null]); S.canWrite=c!==false; S.canAdmin=!!ad; S.me=me||null; }catch(e){} }
  $("#btnSearch .ic").innerHTML=ICON.search; $("#fab").innerHTML=ICON.plus; $("#main").removeAttribute("aria-busy");
  S._ver=0; loadTeam();
  let timer=setTimeout(()=>{ sync.textContent="Can't reach the ledger yet. Check your internet connection."; },10000);
  const onErr=e=>{ clearTimeout(timer); console.error(e); sync.textContent=e&&e.code==="invalid_argument"?"You don't have access to this ledger's data.":"Lost connection. Reload the page to retry."; if(!Object.values(S.loaded).every(Boolean)) $("#main").innerHTML=`<section class="panel"><div class="empty"><h3>Couldn't load the ledger</h3><p>${esc(sync.textContent)}</p></div></section>`; };
  const norm={dealers:x=>x,products:x=>({...x,stock:Number(x.stock)||0,dealerPrice:Number(x.dealerPrice)||0}),txns:x=>({...x,amount:Number(x.amount)||0}),moves:x=>({...x,qty:Number(x.qty)||0})};
  let raf=0; const schedule=()=>{ if(raf) return; raf=requestAnimationFrame(()=>{ raf=0; render(); paintSheet(true); openDeepLink(); }); };
  const done=meta=>{ if(!meta.fromCache&&Object.values(S.loaded).every(Boolean)){ clearTimeout(timer); sync.textContent=offlineText()||(S.canWrite?"Saved · updates live":"View only · updates live"); } };
  window.addEventListener("dcl-offline",()=>{ if(Object.values(S.loaded).every(Boolean)){ clearTimeout(timer); sync.textContent=offlineText()||(S.canWrite?"Saved · updates live":"View only · updates live"); } S._ver++; schedule(); });
  COLS.forEach(c=>db.collection(c).onSnapshot(snap=>{ const m=new Map(); snap.docs.forEach(d=>{ const x=d.data(); if(!x.mergedInto) m.set(d.id,(norm[c]||(y=>y))(x)); }); // merged records live on only in history
    if(c==="approvals"&&S.loaded.approvals&&S.canAdmin) m.forEach((r,k)=>{ if(!S.approvals.has(k)&&r.status==="pending"){ const d=S.dealers.get(r.dealerId); toast(`Approval needed: ${d?d.name:"a dealer"} · ${P(r.amount)}`); } });
    if(c==="orders"&&S.loaded.orders) m.forEach((o,k)=>{ if(!S.orders.has(k)&&o.status==="new"){ const d=S.dealers.get(o.dealerId); toast(`New online order ${o.no||""} from ${d?d.name:"a dealer"}`); } }); S[c]=m; S.loaded[c]=true; S._ver++; done(snap.metadata); schedule(); },onErr));
  db.doc("settings/store").onSnapshot(snap=>{ S.settings=snap.exists?{...snap.data()}:{}; S.loaded.settings=true; S._ver++; done(snap.metadata); schedule(); },onErr);
})();
})();
