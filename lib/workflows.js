"use strict";
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { today, dealerStatus, r2 } = require("./credit");
const { METHODS, validDate, allocations, statement, cents } = require("./ledger");
const ID = /^[A-Za-z0-9_\-.:~]{1,80}$/;
const INTERNAL = new Set(["approvals", "reconciliations", "revisions"]);
const BACKUP_COLS = ["dealers","products","txns","moves","orders","settings",...INTERNAL];
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k] !== undefined).map(k=>[k,canonical(value[k])]));
  return value;
}
const hash = value => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const reason = value => typeof value === "string" ? value.trim().slice(0,1000) : "";
function createWorkflows({ db, q, getDoc, listDocs, audit, applyRules, deepMerge, HttpError, isAdmin, canWrite, nextNo, broadcast, backupNow }) {
  const fail = (status,message,code="invalid_argument") => { throw new HttpError(status,code,message); };
  const put = (c,id,data) => { const json=JSON.stringify(data); if(Buffer.byteLength(json)>256*1024) fail(413,"This record is too large."); q.upsert.run({c,id,data:json,now:Date.now()}); };
  const fingerprint = () => hash(db.prepare("SELECT collection,id,version FROM docs ORDER BY collection,id").all());
  const txns = did => listDocs("txns").filter(r=>r.data.dealerId===did);
  const notify = () => ["txns","products","orders","moves","approvals","reconciliations","dealers","settings"].forEach(broadcast);
  function permitted(user,did) {
    if(user.role==="dealer" && user.dealerId!==did) fail(403,"You can only view your own account.");
    if(!getDoc("dealers",did)) fail(404,"Dealer not found.");
  }
  function validateTxn(t) {
    if(!["sale","payment","return"].includes(t.type)) fail(400,"Unknown transaction type.");
    if(!validDate(t.date)) fail(400,"Choose a valid transaction date.");
    if(!Number.isFinite(Number(t.amount)) || cents(t.amount)<=0 || cents(t.amount)>1e12) fail(400,"Enter a valid positive amount.");
    if(t.type==="sale" && (!validDate(t.dueDate) || t.dueDate<t.date)) fail(400,"Due date must be on or after the sale date.");
    if(t.type==="payment" && !METHODS.includes(t.method)) fail(400,"Choose a payment method.");
    if(t.items!==undefined && (!Array.isArray(t.items) || t.items.length>100)) fail(400,"Check the transaction items.");
    if(t.opening && (t.type!=="sale" || (t.items||[]).length)) fail(400,"Opening balances cannot contain stock items.");
    for(const i of t.items||[]) {
      if(!i || !ID.test(String(i.productId)) || !Number.isSafeInteger(Number(i.qty)) || i.qty<=0 || i.qty>9999 || !Number.isFinite(Number(i.price)) || i.price<0) fail(400,"Check product quantities and prices.");
      if(i.pct!==undefined && (!Number.isFinite(Number(i.pct)) || i.pct<0 || i.pct>100)) fail(400,"Item discount must be between 0 and 100.");
    }
    // Amount-only legacy deliveries are supported; itemized entries must balance.
    if((t.items||[]).length) {
      const subtotal=r2(t.items.reduce((s,i)=>s+Number(i.qty)*Number(i.price),0));
      const discount=r2(t.items.reduce((s,i)=>s+Number(i.qty)*Number(i.price)*Number(i.pct ?? t.discountPct ?? 0)/100,0));
      const extra=Number(t.discount||0);
      if(!Number.isFinite(extra)||extra<0 || cents(subtotal-discount-extra)!==cents(t.amount)) fail(400,"The item total and discounts do not match the amount.");
      t.subtotal=subtotal; t.pctDiscount=discount;
    }
  }
  function effect(c,t) {
    const out={}; if(!t || t.voided) return out;
    if(c==="moves") { out[t.productId]=Number(t.qty); return out; }
    const sign=t.type==="sale"&&!t.opening?-1:t.type==="return"&&t.restock?1:0;
    if(sign) for(const i of t.items||[]) out[i.productId]=(out[i.productId]||0)+sign*Number(i.qty);
    return out;
  }
  function reserved(pid,except) {
    return listDocs("orders").filter(r=>r.id!==except && ["preparing","ready"].includes(r.data.status)).reduce((n,r)=>n+(r.data.items||[]).filter(i=>i.productId===pid).reduce((s,i)=>s+Number(i.qty),0),0);
  }
  function changeStock(c,old,next,exceptOrder) {
    const before=effect(c,old), after=effect(c,next);
    for(const pid of new Set([...Object.keys(before),...Object.keys(after)])) {
      const delta=(after[pid]||0)-(before[pid]||0); if(!delta) continue;
      const p=getDoc("products",pid); if(!p) fail(409,"A stock product no longer exists.");
      const stock=Number(p.data.stock||0)+delta;
      if(!Number.isSafeInteger(stock)) fail(400,"Stock total is outside the supported range.");
      if(stock<reserved(pid,exceptOrder)) fail(409,`Not enough available stock for ${p.data.name}. Stock reserved for other orders cannot be used.`,"insufficient_stock");
      put("products",pid,{...p.data,stock});
    }
  }
  const signature = t => hash(Object.fromEntries(["type","dealerId","date","dueDate","items","amount","discount","discountPct","pctDiscount","orderId","paidNow","opening"].map(k=>[k,t[k]])));
  function checkCredit(user,next,id) {
    if(next.type!=="sale" || next.opening || next.voided) return;
    const dealer=getDoc("dealers",next.dealerId); if(!dealer) return;
    const s=getDoc("settings","store")?.data||{};
    const st=dealerStatus(txns(next.dealerId).filter(r=>r.id!==id).map(r=>r.data));
    const blocked=st.maxLate>Number(s.holdDays??60) || (s.blockOverLimit!==false && Number(dealer.data.creditLimit)>0 && st.balance+Number(next.amount)>Number(dealer.data.creditLimit));
    if(!blocked) { delete next.approvalId; delete next.override; return; }
    if(user.role==="owner" && reason(next.override?.reason)) {
      next.override={reason:reason(next.override.reason),by:user.id,at:Date.now()}; return;
    }
    const a=next.approvalId&&getDoc("approvals",next.approvalId);
    if(a && a.data.status==="consumed" && a.data.saleId===id && a.data.requestedBy===user.id && a.data.signature===signature(next)) { next.override={by:a.data.decidedBy,at:a.data.decidedAt,reason:a.data.decisionReason,approvalId:a.id};return; }
    if(!a || a.data.status!=="approved" || a.data.requestedBy!==user.id || a.data.signature!==signature(next) || a.data.expiresAt<Date.now()) fail(409,"This sale needs owner approval. Submit a credit approval request or enter an owner override reason.","credit_hold");
    next.override={by:a.data.decidedBy,at:a.data.decidedAt,reason:a.data.decisionReason,approvalId:a.id};
  }
  function checkClosed(t) {
    if(!t || t.type!=="payment" || t.voided) return;
    if(listDocs("reconciliations").some(r=>r.data.status==="closed" && t.date>=r.data.from && t.date<=r.data.to)) fail(409,"This collection period is closed. Reopen its reconciliation before changing payments.");
  }
  function commit(user,c,id,body,{merge=false,version,restore=false,paired=false}={}) {
    if(!canWrite(user) && !(c==="orders" && user.role==="dealer")) fail(403,"Your account can only view the ledger.");
    if(INTERNAL.has(c)) fail(403,"Use the approval, reconciliation, or history workflow for this record.");
    if(restore) fail(400,"Use the backup preview and confirm workflow to restore records.");
    const existing=getDoc(c,id);
    if(existing && c==="orders" && user.role==="dealer" && existing.data.dealerId!==user.dealerId) fail(403,"That order is not yours.");
    if(merge&&!existing) fail(404,"That record no longer exists.");
    let next=merge?deepMerge(existing.data,body):{...body};
    delete next._version;
    if(c==="products") { delete next.reserved;delete next.availableStock; }
    if(existing && ["txns","moves","orders"].includes(c) && isDeepStrictEqual(canonical(existing.data),canonical(next))) return existing;
    if(existing && c==="txns" && !isAdmin(user) && !(existing.data.createdBy===user.id && require("./credit").dayOf(existing.data.createdAt)===today())) fail(403,"Staff can only correct their own records today.");
    if(existing && ["txns","moves"].includes(c)) {
      if(Number(version)!==existing.version) fail(409,"This record changed. Reload it before making a correction.","conflict");
      const why=next.voided&&!existing.data.voided?reason(body.voidReason):reason(body.correctionReason);
      if(!why) fail(400,"Enter a reason for this correction.");
      next.correctionReason=why;
      if(c==="txns" && next.type!==existing.data.type) fail(400,"Void the original and create a new transaction to change its type.");
    }
    if(c==="txns" && !existing && next.voided) fail(400,"Record the transaction before voiding it.");
    if(c==="txns" && next.type==="payment" && (existing?.data.saleId || next.saleId) && !paired) fail(409,"Correct the linked paid-on-release sale so its payment changes atomically.");
    if(c==="txns" && !existing && !paired) { delete next.paymentId;delete next.saleId; }
    if(c==="txns") { validateTxn(next);
      for(const item of next.items||[]) if(!getDoc("products",item.productId)) fail(400,"A transaction product no longer exists."); checkClosed(existing?.data); checkClosed(next); }
    if(c==="moves") {
      if(!ID.test(String(next.productId)) || !Number.isSafeInteger(Number(next.qty)) || !validDate(next.date)) fail(400,"Check the stock movement product, quantity, and date.");
      if (next.expectedStock !== undefined && Number(getDoc("products", next.productId)?.data.stock) !== Number(next.expectedStock)) fail(409, "Stock changed since this count. Reload the product and count again.");
      if(!existing && next.reason==="Starting stock") fail(400,"Starting stock is recorded when the product is created.");
    }
    if(c==="orders") {
      if(existing && Number(version)!==existing.version) fail(409,"This order changed. Reload it before updating.","conflict");
      if(existing) {
        const transitions={new:["new","preparing","cancelled"],preparing:["preparing","ready","cancelled"],ready:["ready","cancelled"],released:[],cancelled:[]};
        if(!transitions[existing.data.status]?.includes(next.status)) fail(409,"That order status transition is not allowed. Release it by recording its credit sale.");
        next={...existing.data,status:next.status,cancelReason:next.cancelReason};
      } else if(user.role!=="dealer" && next.status!=="new") fail(400,"New orders must start as new.");
    }
    next=applyRules(user,c,id,existing,next,{});
    if(!existing && ["txns","moves","orders"].includes(c)) { next.createdAt=Date.now();next.createdBy=user.id; }
    if(c==="txns") {
      if(!existing) next.no=nextNo(next.type);
      if(existing && next.voided!==existing.data.voided) {
        if(next.voided) { if(!reason(next.voidReason)) fail(400,"Enter a reason for voiding this transaction."); next.voidedAt=Date.now();next.voidedBy=user.id; }
        else { delete next.voidedAt;delete next.voidedBy;delete next.voidReason; }
      }
      const order=next.orderId&&getDoc("orders",next.orderId);
      if(next.orderId && (!order || next.type!=="sale" || next.opening)) fail(400,"Choose a valid order for this sale.");
      if(order && !existing) {
        if(!["preparing","ready"].includes(order.data.status) || order.data.saleId || order.data.dealerId!==next.dealerId) fail(409,"This order cannot be released again.");
        const quantities=items=>Object.entries((items||[]).reduce((m,i)=>{m[i.productId]=(m[i.productId]||0)+Number(i.qty);return m;},{})).sort();
        if(!isDeepStrictEqual(quantities(order.data.items),quantities(next.items))) fail(400,"Release the reserved order quantities. Cancel and create a new order to change them.");
        put("orders",order.id,{...order.data,status:"released",saleId:id,saleNo:next.no,statusHistory:[...(order.data.statusHistory||[]),{status:"released",at:Date.now(),by:user.id}]});
      }
      if(existing && existing.data.orderId!==next.orderId) fail(400,"An order link cannot be changed after release.");
      changeStock(c,existing?.data,next);
      if(next.approvalId && (!existing || next.approvalId!==existing.data.approvalId)) {
        const a=getDoc("approvals",next.approvalId);put("approvals",a.id,{...a.data,status:"consumed",saleId:id,consumedAt:Date.now()});
      }
      // Server-authoritative allocation, ignoring client estimates.
      delete next.applied;delete next.balanceBefore;delete next.payKind;
      if(next.type==="payment") {
        const before=allocations(txns(next.dealerId).filter(r=>r.id!==id),next.date).balance;
        const current=allocations([...txns(next.dealerId).filter(r=>r.id!==id),{id,data:next}],next.date).byCredit[id];
        next.applied=current?.lines||[];next.balanceBefore=before;next.payKind=before>0?(next.amount>=before?"full":"partial"):"advance";
      }
      if(existing?.data.paymentId) {
        const linked=getDoc("txns",existing.data.paymentId);
        if(!linked) fail(409,"The linked payment is missing.");
        next.paymentId=existing.data.paymentId;next.paidNow=existing.data.paidNow;
        commit(user,"txns",linked.id,{...linked.data,dealerId:next.dealerId,date:next.date,amount:next.amount,voided:!!next.voided,voidReason:next.voidReason,correctionReason:reason(next.correctionReason||next.voidReason)},{version:linked.version,paired:true});
      }
      if(next.paidNow && !existing) {
        if(next.type!=="sale" || !METHODS.includes(next.paidNow.method)) fail(400,"Choose a valid payment method for payment on release.");
        const payment={type:"payment",dealerId:next.dealerId,date:next.date,amount:next.amount,method:next.paidNow.method,note:`Paid on release ${next.no}`,saleId:id};
        const paidId=`paid_${hash(id).slice(0,40)}`;
        // Insert sale first so payment allocation includes this delivery.
        put(c,id,next);commit(user,"txns",paidId,payment,{paired:true});
        next.paymentId=paidId;
      }
    }
    if(c==="moves") changeStock(c,existing?.data,next);
    if(c==="orders" && ["preparing","ready"].includes(next.status)) {
      for(const i of next.items||[]) {
        const p=getDoc("products",i.productId);
        if(!p || Number(p.data.stock||0)-reserved(i.productId,id)<i.qty) fail(409,`Not enough available stock for ${i.name||"an order item"}.`,"insufficient_stock");
      }
    }
    if(c==="products" && (!Number.isSafeInteger(Number(next.stock||0)) || Number(next.stock||0)<0)) fail(400,"Starting stock must be a nonnegative whole number.");
    if(existing && ["txns","moves"].includes(c)) {
      const revision={collection:c,docId:id,before:existing.data,reason:reason(next.correctionReason),by:user.id,at:Date.now(),version:existing.version};
      put("revisions",crypto.randomUUID(),revision);
      next.updated={by:user.id,at:Date.now()};
    }
    put(c,id,next);
    if(c==="products" && !existing && Number(next.stock)>0) put("moves",crypto.randomUUID(),{productId:id,qty:Number(next.stock),reason:"Starting stock",date:today(),createdAt:Date.now(),createdBy:user.id});
    audit(user,existing?"update":"create",c,id,next);
    return getDoc(c,id);
  }
  function once(user,key,payload,fn) {
    return db.transaction(()=>{
      if(!key) return fn();
      if(!/^[\w:.-]{8,160}$/.test(key)) fail(400,"Invalid retry key.");
      const digest=hash(payload), prior=db.prepare("SELECT * FROM request_receipts WHERE user_id=? AND request_key=?").get(user.id,key);
      if(prior) { if(prior.fingerprint!==digest) fail(409,"That retry key was already used for different data.","conflict"); return JSON.parse(prior.response); }
      const out=fn();
      db.prepare("INSERT INTO request_receipts VALUES (?,?,?,?,?)").run(user.id,key,digest,JSON.stringify(out),Date.now());
      return out;
    })();
  }
  function decorateProducts(rows) {
    const totals = new Map();
    for (const {data:o} of listDocs("orders")) if (["preparing","ready"].includes(o.status)) for (const i of o.items || []) totals.set(i.productId,(totals.get(i.productId)||0)+Number(i.qty));
    return rows.map(r => ({...r,data:{...r.data,reserved:totals.get(r.id)||0,availableStock:Number(r.data.stock||0)-(totals.get(r.id)||0)}}));
  }
  function decorateTxns(rows) {
    const groups = new Map();
    for (const r of rows) { if (!groups.has(r.data.dealerId)) groups.set(r.data.dealerId, []); groups.get(r.data.dealerId).push(r); }
    for (const [did, group] of groups) groups.set(did, allocations(group, "9999-12-31"));
    return rows.map(r => r.data.type === "payment" ? { ...r, data: { ...r.data, applied: groups.get(r.data.dealerId).byCredit[r.id]?.lines || [], unapplied: groups.get(r.data.dealerId).byCredit[r.id]?.extra || 0 } } : r);
  }
  function reconciliation(from,to,counts) {
    if(!validDate(from)||!validDate(to)||from>to) fail(400,"Choose a valid collection period.");
    if(!counts || typeof counts!=="object" || Array.isArray(counts) || METHODS.some(m=>!Object.hasOwn(counts,m)) || Object.keys(counts).some(m=>!METHODS.includes(m))) fail(400,"Enter counted totals for every payment method.");
    const rows=listDocs("txns").filter(r=>r.data.type==="payment"&&!r.data.voided&&r.data.date>=from&&r.data.date<=to);
    const totals=METHODS.map(method=>{
      const actual=Number(counts[method]);if(!Number.isFinite(actual)||actual<0||cents(actual)>1e12) fail(400,"Counted amounts must be nonnegative numbers.");
      const expected=rows.filter(r=>(r.data.method||"Other")===method).reduce((s,r)=>s+cents(r.data.amount),0)/100;
      return {method,expected,actual:r2(actual),difference:r2(actual-expected)};
    });
    return {from,to,totals,payments:rows.map(r=>({id:r.id,version:r.version,amount:r.data.amount,method:r.data.method})),fingerprint:hash(rows)};
  }
  function register(app,needUser,needAdmin,needOwner) {
    app.post("/api/moves/batch",needUser,(req,res)=>{
      if(!canWrite(req.user)) fail(403,"Only store staff can record stock counts.");
      if(!Array.isArray(req.body.records)||!req.body.records.length||req.body.records.length>500) fail(400,"Provide between 1 and 500 stock movements.");
      const out=once(req.user,req.get("Idempotency-Key"),{route:"stock_count",body:req.body},()=>{
        const seen=new Set();
        return req.body.records.map(r=>{if(!ID.test(String(r.id))||seen.has(r.id))fail(400,"Stock movement IDs must be unique.");seen.add(r.id);return commit(req.user,"moves",r.id,r.data);});
      });broadcast("moves");broadcast("products");res.json(out);
    });
    app.get("/api/dealers/:id/statement",needUser,(req,res)=>{
      permitted(req.user,req.params.id);
      const from=req.query.from||"1900-01-01",to=req.query.to||today();
      if(!validDate(from)||!validDate(to)||from>to) fail(400,"Choose a valid statement period.");
      const dealer=getDoc("dealers",req.params.id).data;
      res.json({...statement(txns(req.params.id),from,to),dealer:{name:dealer.name,phone:dealer.phone,area:dealer.area},store:getDoc("settings","store")?.data.storeName||"Dealer Credit Ledger"});
    });
    app.get("/api/txns/:id/allocations",needUser,(req,res)=>{
      const t=getDoc("txns",req.params.id);if(!t) fail(404,"Transaction not found.");permitted(req.user,t.data.dealerId);
      res.json(allocations(txns(t.data.dealerId),"9999-12-31").byCredit[t.id]||{lines:[],extra:0});
    });
    app.get("/api/txns/:id/history",needUser,needAdmin,(req,res)=>res.json(listDocs("revisions").filter(r=>r.data.collection==="txns"&&r.data.docId===req.params.id)));
    app.post("/api/approvals",needUser,(req,res)=>{
      if(!canWrite(req.user)) fail(403,"Only store staff can request credit approval.");
      const sale=req.body.sale; if(!sale || sale.type!=="sale" || sale.opening || sale.voided) fail(400,"Choose a credit sale to approve.");
      validateTxn(sale);if(!getDoc("dealers",sale.dealerId)) fail(400,"Choose an existing dealer.");
      if(!reason(req.body.reason)) fail(400,"Explain why this release needs approval.");
      const out=once(req.user,req.get("Idempotency-Key"),{route:"approval",body:req.body},()=>{
        const id=crypto.randomUUID(),data={sale,signature:signature(sale),reason:reason(req.body.reason),requestedBy:req.user.id,createdAt:Date.now(),status:"pending"};put("approvals",id,data);audit(req.user,"approval_request","approvals",id,data);return {id,data};
      });broadcast("approvals");res.json(out);
    });
    app.post("/api/approvals/:id/decision",needUser,needOwner,(req,res)=>{
      const out=db.transaction(()=>{
        const a=getDoc("approvals",req.params.id);if(!a) fail(404,"Approval request not found.");
        if(a.data.status!=="pending") fail(409,"This request has already been decided.");
        if(!["approved","rejected"].includes(req.body.status)||!reason(req.body.reason)) fail(400,"Choose a decision and enter its reason.");
        const data={...a.data,status:req.body.status,decisionReason:reason(req.body.reason),decidedBy:req.user.id,decidedAt:Date.now(),expiresAt:Date.now()+864e5};
        put("approvals",a.id,data);audit(req.user,"approval_decision","approvals",a.id,data);return {id:a.id,data};
      })();broadcast("approvals");res.json(out);
    });
    app.post("/api/reconciliations/preview",needUser,needAdmin,(req,res)=>res.json(reconciliation(req.body.from,req.body.to,req.body.counts)));
    app.post("/api/reconciliations",needUser,needAdmin,(req,res)=>{
      const out=once(req.user,req.get("Idempotency-Key"),{route:"reconciliation",body:req.body},()=>{
        const report=reconciliation(req.body.from,req.body.to,req.body.counts);
        if(report.fingerprint!==req.body.fingerprint) fail(409,"Collections changed. Preview the totals again.");
        if(report.totals.some(t=>t.difference!==0)&&!reason(req.body.note)) fail(400,"Explain the collection discrepancy.");
        if(listDocs("reconciliations").some(r=>r.data.status==="closed" && r.data.from<=report.to && r.data.to>=report.from)) fail(409,"A closed reconciliation overlaps this period.");
        const id=crypto.randomUUID(), data={...report,note:reason(req.body.note),status:"closed",closedBy:req.user.id,closedAt:Date.now()};put("reconciliations",id,data);audit(req.user,"reconciliation_close","reconciliations",id,data);return {id,data};
      });broadcast("reconciliations");res.json(out);
    });
    app.post("/api/reconciliations/:id/reopen",needUser,needOwner,(req,res)=>{
      if(!reason(req.body.reason)) fail(400,"Enter a reason for reopening this period.");
      db.transaction(()=>{const r=getDoc("reconciliations",req.params.id);if(!r||r.data.status!=="closed") fail(409,"This period is not closed.");put("reconciliations",r.id,{...r.data,status:"reopened",reopenReason:reason(req.body.reason),reopenedBy:req.user.id,reopenedAt:Date.now()});audit(req.user,"reconciliation_reopen","reconciliations",r.id,req.body.reason);})();broadcast("reconciliations");res.json({ok:true});
    });
    app.get("/api/backup",needUser,needAdmin,(req,res)=>{
      const out={app:"dealer-credit-ledger",version:3,exportedAt:new Date().toISOString()};
      for(const c of BACKUP_COLS) out[c]=c==="settings"?(getDoc(c,"store")?.data||{}):Object.fromEntries(listDocs(c).map(r=>[r.id,r.data]));
      res.json(out);
    });
    registerImports(app,needUser,needAdmin);
  }
  function prepareImport(user,kind,input) {
    const jobs=[];
    if(kind==="backup") {
      if(!input || input.app!=="dealer-credit-ledger" || ![1,2,3].includes(input.version)) fail(400,"Choose a supported Dealer Credit Ledger backup.");
      for(const c of BACKUP_COLS) {
        const records=input[c];if(records===undefined) continue;
        if(!records || typeof records!=="object" || Array.isArray(records)) fail(400,`Invalid ${c} records in backup.`);
        if(c==="settings") { if(Object.keys(records).length) jobs.push({collection:c,id:"store",data:records}); }
        else for(const [id,data] of Object.entries(records)) jobs.push({collection:c,id,data});
      }
    } else if(kind==="catalog") {
      if(!Array.isArray(input?.records)) fail(400,"Provide catalog records to preview.");
      for(const record of input.records) { if(!record || typeof record!=="object" || Array.isArray(record)) fail(400,"Each catalog row must contain record data.");jobs.push({collection:"products",id:record.id||crypto.randomUUID(),data:record.data}); }
      if(input.settings) jobs.push({collection:"settings",id:"store",data:input.settings});
    } else fail(400,"Unknown import kind.");
    const maximum=kind==="backup"?50000:5000;
    if(!jobs.length || jobs.length>maximum) fail(400,`Import between 1 and ${maximum.toLocaleString()} records at a time.`);
    const seen=new Set(), errors=[],details=[];
    const merged=new Map(BACKUP_COLS.map(c=>[c,new Map(listDocs(c).map(r=>[r.id,r.data]))]));
    for(const job of jobs) {
      const key=job.collection+"/"+job.id;
      const existing=getDoc(job.collection,job.id);
      let error="";
      try {
        if(!ID.test(job.id) || !job.data || typeof job.data!=="object" || Array.isArray(job.data)) fail(400,"Invalid record ID or data.");
        if(seen.has(key)) fail(400,"Duplicate record ID in this import.");seen.add(key);
        if(Buffer.byteLength(JSON.stringify(job.data))>256*1024) fail(400,"Record is too large.");
        if(["dealers","products"].includes(job.collection) && (typeof job.data.name!=="string" || !job.data.name.trim())) fail(400,"A name is required.");
        if(job.collection==="products") {
          delete job.data.reserved;delete job.data.availableStock;delete job.data._version;
          if(!Number.isSafeInteger(Number(job.data.stock||0)) || Number(job.data.stock||0)<0) fail(400,"Stock must be a nonnegative whole number.");
          for(const field of ["srp","dealerPrice"]) if(job.data[field]!==undefined && (!Number.isFinite(Number(job.data[field]))||Number(job.data[field])<0)) fail(400,`Invalid ${field}.`);
          if(kind==="catalog") job.data=applyRules(user,"products",job.id,existing,{...job.data},{});
        }
        if(job.collection==="txns") { if(job.data.type==="payment"&&!job.data.method) job.data.method="Other";validateTxn(job.data); }
        if(job.collection==="moves" && (!ID.test(String(job.data.productId)) || !Number.isSafeInteger(Number(job.data.qty)) || !validDate(job.data.date))) fail(400,"Invalid stock movement.");
        if(job.collection==="orders" && (!ID.test(String(job.data.dealerId)) || !["new","preparing","ready","released","cancelled"].includes(job.data.status) || !Array.isArray(job.data.items) || !job.data.items.length || job.data.items.some(i=>!i||!ID.test(String(i.productId))||!Number.isSafeInteger(Number(i.qty))||i.qty<=0))) fail(400,"Invalid order.");
        // Restored approvals must be reviewed again rather than granting a release.
        if(job.collection==="approvals" && ["pending","approved"].includes(job.data.status)) job.data={...job.data,status:"rejected",decisionReason:"Restored from backup. Submit a new request for owner review."};
        if(job.collection==="reconciliations" && (!validDate(job.data.from)||!validDate(job.data.to)||job.data.from>job.data.to||!["closed","reopened"].includes(job.data.status))) fail(400,"Invalid reconciliation period.");
        if(job.collection==="revisions" && (!["txns","moves"].includes(job.data.collection)||!ID.test(String(job.data.docId))||!job.data.before)) fail(400,"Invalid correction history.");
        merged.get(job.collection).set(job.id,job.data);
      } catch(e) { error=e.message;errors.push({collection:job.collection,id:job.id,message:error}); }
      details.push({collection:job.collection,id:job.id,action:existing?"overwrite":"create",valid:!error,error,before:existing?.data||null,after:job.data});
    }
    for(const job of jobs) {
      if(errors.some(e=>e.collection===job.collection&&e.id===job.id)) continue;
      let error="";
      const t=job.data;
      if(["txns","orders"].includes(job.collection) && !merged.get("dealers").has(t.dealerId)) error="Referenced dealer does not exist.";
      if(["txns","orders"].includes(job.collection) && (t.items||[]).some(i=>!merged.get("products").has(i.productId))) error="Referenced product does not exist.";
      if(job.collection==="moves"&&!merged.get("products").has(t.productId)) error="Stock movement references a missing product.";
      if(job.collection==="txns" && t.no && [...merged.get("txns")].some(([id,x])=>id!==job.id&&x.no===t.no)) error="Duplicate transaction number.";
      if(job.collection==="products" && t.code && [...merged.get("products")].some(([id,x])=>id!==job.id && String(x.code||"").trim().toLowerCase()===String(t.code).trim().toLowerCase())) error="Duplicate product code.";
      if(error) { errors.push({collection:job.collection,id:job.id,message:error});const d=details.find(d=>d.collection===job.collection&&d.id===job.id);d.valid=false;d.error=error; }
    }
    const reservations={};
    for(const o of merged.get("orders").values()) if(["preparing","ready"].includes(o.status)) for(const i of o.items||[]) reservations[i.productId]=(reservations[i.productId]||0)+Number(i.qty);
    for(const [pid,qty] of Object.entries(reservations)) if(qty>Number(merged.get("products").get(pid)?.stock||0)) errors.push({collection:"products",id:pid,message:"Restored order reservations exceed stock on hand."});
    return {jobs,details,errors};
  }
  function previewImport(user,kind,input) {
    if(!isAdmin(user)) fail(403,"Only owners and editors can import records.");
    const preview=prepareImport(user,kind,input);
    const id=crypto.randomUUID(), fp=fingerprint(), expiresAt=Date.now()+15*60e3;
    db.prepare("INSERT INTO import_previews VALUES (?,?,?,?,?,?,NULL)").run(id,user.id,kind,JSON.stringify(preview),fp,expiresAt);
    db.prepare("DELETE FROM import_previews WHERE expires_at < ? AND result IS NULL").run(Date.now());
    return {id,kind,expiresAt,records:preview.details,errors:preview.errors,canApply:!preview.errors.length,counts:{create:preview.details.filter(d=>d.action==="create").length,overwrite:preview.details.filter(d=>d.action==="overwrite").length}};
  }
  async function confirmImport(user,id) {
    if(!isAdmin(user)) fail(403,"Only owners and editors can import records.");
    const preview=db.prepare("SELECT * FROM import_previews WHERE id=? AND user_id=?").get(id,user.id);
    if(!preview) fail(404,"Import preview not found.");
    if(preview.result) return JSON.parse(preview.result);
    if(preview.expires_at<Date.now()) fail(409,"This preview expired. Preview the file again.");
    const payload=JSON.parse(preview.payload);
    if(payload.errors.length) fail(400,"Fix the invalid records and preview the file again.");
    if(preview.fingerprint!==fingerprint()) fail(409,"Ledger records changed after this preview. Preview again before importing.");
    const safetyBackup=await backupNow("before-import");
    const result=db.transaction(()=>{
      const current=db.prepare("SELECT result FROM import_previews WHERE id=?").get(preview.id);
      if(current.result) return JSON.parse(current.result);
      if(preview.fingerprint!==fingerprint()) fail(409,"Ledger records changed. Preview again before importing.");
      for(const job of payload.jobs) {
        if(preview.kind==="catalog") commit(user,job.collection,job.id,job.data);
        else put(job.collection,job.id,job.data);
      }
      const out={ok:true,succeeded:payload.jobs.map(j=>({collection:j.collection,id:j.id})),failed:[],count:payload.jobs.length,safetyBackup:require("node:path").basename(safetyBackup)};
      audit(user,"import",null,null,{kind:preview.kind,count:out.count,safetyBackup:out.safetyBackup});
      db.prepare("UPDATE import_previews SET result=? WHERE id=?").run(JSON.stringify(out),preview.id);
      return out;
    })();notify();return result;
  }
  function registerImports(app,needUser,needAdmin) {
    app.post("/api/imports/preview",needUser,needAdmin,(req,res)=>res.json(previewImport(req.user,req.body.kind,req.body.input)));
    app.post("/api/imports/:id/confirm",needUser,needAdmin,async(req,res,next)=>{
      try {res.json(await confirmImport(req.user,req.params.id));} catch(e){next(e);}
    });
  }
  return {commit,once,register,checkCredit,decorateProducts,decorateTxns,reserved,notify,previewImport,confirmImport,INTERNAL};
}
module.exports = { createWorkflows };
