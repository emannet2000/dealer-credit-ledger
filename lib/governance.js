"use strict";
const crypto=require("node:crypto");
const {today,r2}=require("./credit");
const {METHODS,validDate,cents}=require("./ledger");
const {inventoryBasis}=require("./inventory");
const DEFAULT_LIMITS={approvalExpenseLimit:5000,approvalPurchaseLimit:20000,approvalStockLimit:10000};
const clean=v=>typeof v==="string"?v.trim().slice(0,1000):"";
function stable(v){if(Array.isArray(v))return v.map(stable);if(v&&typeof v==="object")return Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined&&k!=="authorizationId").map(k=>[k,stable(v[k])]));return v;}
const hash=v=>crypto.createHash("sha256").update(JSON.stringify(stable(v))).digest("hex");
function createGovernance({db,q,getDoc,listDocs,put,audit,fail,once,commit,broadcast}){
  function assertOpen(date){
    if(listDocs("dailyClosings").some(r=>r.data.status==="closed"&&r.data.date===date))fail(409,"This business day is closed. The owner must reopen it before financial records can change.","day_closed");
    if(validDate(date)){const month=String(date).slice(0,7);if(listDocs("periodLocks").some(r=>r.data.status==="closed"&&r.data.month===month))fail(409,"This month is finalized. The owner must reopen the period before financial records can change.","period_locked");}
  }
  function classify(c,id,body,{merge=false}={}){
    const old=getDoc(c,id)?.data,p=merge?{...old,...body}:body,s=getDoc("settings","store")?.data||{};
    let value=0,key;
    if(c==="expenses"){key="approvalExpenseLimit";value=Math.max(Number(p.amount||0),Number(old?.amount||0));}
    if(c==="purchases"){key="approvalPurchaseLimit";value=(p.items||old?.items||[]).reduce((n,i)=>n+Number(i.qty)*Number(i.unitCost),0);}
    if(c==="moves"){
      key="approvalStockLimit";const product=getDoc("products",p.productId)?.data||{},cost=p.reason==="Received stock"?p.unitCost:inventoryBasis(product).average;
      value=Math.max(Math.abs(Number(p.qty||0)-Number(old?.qty||0))*(cost??Number(product.purchaseCost||0)),Math.abs(Number(p.qty||0))*Math.abs(Number(p.unitCost||0)-Number(old?.unitCost||0)));
      // Unknown costs must be reviewed rather than treating a large uncosted adjustment as free.
      if(Number(p.qty)!==0&&cost==null)value=Infinity;
    }
    if(c==="stockBatch"){key="approvalStockLimit";value=(p.records||[]).reduce((n,r)=>{const item=classify("moves",r.id,r.data||{});return n+(item.value==null?Infinity:item.value);},0);}
    const limit=key?Number(s[key]??DEFAULT_LIMITS[key]):0;
    return {key,value:Number.isFinite(value)?r2(value):null,limit,required:!!key&&limit>0&&(value>=limit)};
  }
  function checkAction(user,c,id,body,options={}){
    const info=classify(c,id,body,options);if(!body.authorizationId&&(!info.required||user.role==="owner"))return;
    const a=body.authorizationId&&getDoc("authorizations",body.authorizationId);
    const signature=hash({c,id,body,options:{merge:!!options.merge,version:options.version==null?null:Number(options.version)}});
    if(!a||a.data.status!=="approved"||a.data.requestedBy!==user.id||a.data.signature!==signature||a.data.expiresAt<Date.now())fail(409,"This action needs owner approval before it can be posted.","approval_required");
    put("authorizations",a.id,{...a.data,status:"consumed",consumedAt:Date.now()});
  }
  function closingPreview(date,opening){
    if(!validDate(date)||date>today())fail(400,"Choose today or an earlier business date.");
    if(!opening||METHODS.some(m=>opening[m]===null||opening[m]===""||!Number.isFinite(Number(opening[m]))||Number(opening[m])<0||cents(opening[m])>1e12)||Object.keys(opening).some(m=>!METHODS.includes(m)))fail(400,"Enter a nonnegative opening amount for every payment method.");
    const tx=listDocs("txns").filter(r=>r.data.date===date&&!r.data.voided),expenses=listDocs("expenses").filter(r=>r.data.date===date&&!r.data.voided);
    const payments=[],refunds=[],purchaseEvents=[];
    for(const p of listDocs("purchases")){
      for(const e of p.data.payments||[])if(e.date===date&&!e.voided)payments.push(e);
      for(const e of p.data.refunds||[])if(e.date===date&&!e.voided)refunds.push(e);
      for(const kind of ["payments","refunds","receipts","returns","invoiceAdjustments","applicationsIn","applicationsOut"])for(const e of p.data[kind]||[])if(e.date===date)purchaseEvents.push({purchase:p.id,kind,event:e});
    }
    const moves=listDocs("moves").filter(r=>r.data.date===date&&!r.data.voided);
    const channels=METHODS.map(method=>{const incoming=tx.filter(r=>r.data.type==="payment"&&r.data.method===method).reduce((n,r)=>n+cents(r.data.amount),0)/100,expense=expenses.filter(r=>r.data.method===method).reduce((n,r)=>n+cents(r.data.amount),0)/100,supplier=payments.filter(e=>e.method===method).reduce((n,e)=>n+cents(e.amount),0)/100,refund=refunds.filter(e=>e.method===method).reduce((n,e)=>n+cents(e.amount),0)/100;
      return {method,opening:r2(opening[method]),collections:r2(incoming),expenses:r2(expense),supplierPayments:r2(supplier),supplierRefunds:r2(refund),customerRefunds:r2(tx.filter(r=>r.data.type==="refund"&&r.data.method===method).reduce((n,r)=>n+r.data.amount,0)),expected:r2(Number(opening[method])+incoming+refund-expense-supplier-tx.filter(r=>r.data.type==="refund"&&r.data.method===method).reduce((n,r)=>n+r.data.amount,0))};});
    const knownLoss=moves.filter(r=>r.data.qty<0&&r.data.reason!=="Supplier return"&&r.data.inventoryUnitCost!=null).reduce((n,r)=>n+r2(-r.data.qty*r.data.inventoryUnitCost),0);
    return {date,channels,sales:r2(tx.filter(r=>r.data.type==="sale"&&!r.data.opening).reduce((n,r)=>n+r.data.amount,0)),dealerReturns:r2(tx.filter(r=>r.data.type==="return").reduce((n,r)=>n+r.data.amount,0)),stockLoss:r2(knownLoss),unknownLosses:moves.filter(r=>r.data.qty<0&&r.data.reason!=="Supplier return"&&r.data.inventoryUnitCost==null).length,fingerprint:hash({date,opening,tx,expenses,purchaseEvents,moves})};
  }
  function requestAction(user,b){
if(!["expenses","purchases","moves","stockBatch"].includes(b.collection)||!/^[-A-Za-z0-9_.:~]{1,80}$/.test(String(b.id))||!b.data||typeof b.data!=="object"||!clean(b.reason))fail(400,"Choose an action and enter its approval reason.");
      if(b.collection==="stockBatch"&&(!Array.isArray(b.data.records)||!b.data.records.length||b.data.records.length>500||new Set(b.data.records.map(r=>r.id)).size!==b.data.records.length))fail(400,"Provide unique stock count records for review.");
      const options={merge:!!b.merge,version:b.version==null?null:Number(b.version)},info=classify(b.collection,b.id,b.data,options);
      if(!info.required)fail(400,"This action is below the approval limit.");
        const signature=hash({c:b.collection,id:b.id,body:b.data,options});
        const prior=listDocs("authorizations").find(r=>r.data.signature===signature&&r.data.requestedBy===user.id&&r.data.status==="pending");if(prior)return prior;
        const id=crypto.randomUUID(),data={collection:b.collection,docId:b.id,body:b.data,options,signature,reason:clean(b.reason),requestedBy:user.id,createdAt:Date.now(),status:"pending",value:info.value,limit:info.limit};put("authorizations",id,data);audit(user,"authorization_request","authorizations",id,{collection:b.collection,value:info.value});return getDoc("authorizations",id);
  }
  function register(app,needUser,needAdmin,needOwner){
    app.post("/api/authorizations",needUser,(req,res)=>{
      if(["viewer","dealer"].includes(req.user.role))fail(403,"Only store staff can request approval.");
      const out=once(req.user,req.get("Idempotency-Key"),{route:"authorization",body:req.body},()=>requestAction(req.user,req.body));broadcast("authorizations");res.json(out);
    });
    app.post("/api/authorizations/:id/decision",needUser,needOwner,(req,res)=>{
      const out=once(req.user,req.get("Idempotency-Key"),{route:"authorization_decision",id:req.params.id,body:req.body},()=>{
        const a=getDoc("authorizations",req.params.id);if(!a||a.data.status!=="pending")fail(409,"This request is no longer pending.");
        if(!["approved","rejected"].includes(req.body.status)||!clean(req.body.reason))fail(400,"Choose a decision and give its reason.");
        const data={...a.data,status:req.body.status,decidedBy:req.user.id,decidedAt:Date.now(),decisionReason:clean(req.body.reason),expiresAt:Date.now()+864e5};put("authorizations",a.id,data);
        let posted=null;
        if(req.body.status==="approved"){
          const requester=q.userById.get(a.data.requestedBy);if(!requester?.active)fail(409,"The requesting account is no longer active.");
          if(a.data.collection==="stockBatch"){checkAction(requester,"stockBatch",a.data.docId,{...a.data.body,authorizationId:a.id},a.data.options);posted=a.data.body.records.map(r=>commit(requester,"moves",r.id,r.data,{authorizedBatch:true}));}
          else posted=commit(requester,a.data.collection,a.data.docId,{...a.data.body,authorizationId:a.id},a.data.options);
        }
        audit(req.user,"authorization_decision","authorizations",a.id,{status:req.body.status,reason:data.decisionReason});return {request:getDoc("authorizations",a.id),posted};
      });broadcast("authorizations");if(out.posted){const c=out.request.data.collection;(c==="stockBatch"||c==="moves"?["moves","products","batches"]:[c]).forEach(broadcast);}res.json(out);
    });
    app.post("/api/daily-closing/preview",needUser,needAdmin,(req,res)=>res.json(closingPreview(req.body.date,req.body.opening)));
    app.post("/api/daily-closing/close",needUser,needAdmin,(req,res)=>{
      const result=once(req.user,req.get("Idempotency-Key"),{route:"daily_close",body:req.body},()=>{
        const report=closingPreview(req.body.date,req.body.opening);assertOpen(report.date);
        if(report.fingerprint!==req.body.fingerprint)fail(409,"Records changed after preview. Review the closing totals again.");
        if(!req.body.counted||METHODS.some(m=>req.body.counted[m]===null||req.body.counted[m]===""||!Number.isFinite(Number(req.body.counted[m]))||Number(req.body.counted[m])<0||cents(req.body.counted[m])>1e12))fail(400,"Count every payment method before closing.");
        const channels=report.channels.map(c=>({...c,counted:r2(req.body.counted[c.method]),difference:r2(Number(req.body.counted[c.method])-c.expected)}));
        if(channels.some(c=>c.difference!==0)&&!clean(req.body.note))fail(400,"Explain the differences before closing this day.");
        const id="day-"+report.date,old=getDoc("dailyClosings",id),data={...report,channels,note:clean(req.body.note),status:"closed",closedAt:Date.now(),closedBy:req.user.id,history:[...(old?.data.history||[]),...(old?[{status:old.data.status,at:old.data.reopenedAt||old.data.closedAt,by:old.data.reopenedBy||old.data.closedBy,report:old.data.channels}]:[])]};put("dailyClosings",id,data);audit(req.user,"daily_close","dailyClosings",id,{date:data.date});return getDoc("dailyClosings",id);
      });broadcast("dailyClosings");res.json(result);
    });
    app.post("/api/daily-closing/:id/reopen",needUser,needOwner,(req,res)=>{
      const result=once(req.user,req.get("Idempotency-Key"),{route:"daily_reopen",id:req.params.id,body:req.body},()=>{const d=getDoc("dailyClosings",req.params.id);if(!d||d.data.status!=="closed")fail(409,"This day is not closed.");if(!clean(req.body.reason))fail(400,"Enter the reason for reopening.");put("dailyClosings",d.id,{...d.data,status:"reopened",reopenedAt:Date.now(),reopenedBy:req.user.id,reopenReason:clean(req.body.reason)});audit(req.user,"daily_reopen","dailyClosings",d.id,{reason:clean(req.body.reason)});return getDoc("dailyClosings",d.id);});broadcast("dailyClosings");res.json(result);
    });
  }
  return {checkAction,assertOpen,register,closingPreview,requestAction};
}
module.exports={createGovernance,DEFAULT_LIMITS};
