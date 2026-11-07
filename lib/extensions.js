"use strict";
const crypto=require("node:crypto");
const {today,r2}=require("./credit");
const {validDate,METHODS,cents,allocations}=require("./ledger");
const {bankEvents}=require("../public/insights");
const ID=/^[A-Za-z0-9_\-.:~]{1,80}$/;
const text=(v,max=500)=>typeof v==="string"?v.trim().slice(0,max):"";
const money=v=>v!==null&&v!==""&&Number.isFinite(Number(v))&&cents(v)>0&&cents(v)<=1e12;
const digest=v=>crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
const supplierBill=p=>r2((p.items||[]).reduce((n,i)=>n+Number(i.receivedQty||0)*i.unitCost,0)-(p.returns||[]).filter(r=>!r.voided).reduce((n,r)=>n+r.creditAmount,0)+(p.invoiceAdjustments||[]).filter(a=>!a.voided).reduce((n,a)=>n+a.amount,0));
const supplierPaid=p=>r2((p.payments||[]).filter(r=>!r.voided).reduce((n,r)=>n+r.amount,0)-(p.refunds||[]).filter(r=>!r.voided).reduce((n,r)=>n+r.amount,0)+(p.applicationsIn||[]).filter(r=>!r.voided).reduce((n,r)=>n+r.amount,0)-(p.applicationsOut||[]).filter(r=>!r.voided).reduce((n,r)=>n+r.amount,0));
function createExtensions({db,q,getDoc,listDocs,put,fail,audit,once,canWrite,isAdmin,broadcast,assertOpen}){
  const notify=(...collections)=>collections.forEach(broadcast);
  const version=(r,v)=>{if(!r)fail(404,"Record not found.");if(Number(v)!==r.version)fail(409,"This record changed. Reload before saving.","conflict");};
  function validateSupplier(p){if(p.aliases!==undefined&&(!Array.isArray(p.aliases)||p.aliases.some(n=>typeof n!=="string"||n.length>160)))fail(400,"Invalid supplier name history.");if(!text(p.name,160)||!Number.isInteger(Number(p.paymentTerms??0))||Number(p.paymentTerms??0)<0||Number(p.paymentTerms??0)>365)fail(400,"Enter a supplier name and payment terms between 0 and 365 days.");if(p.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email))fail(400,"Enter a valid supplier email address.");}
  function saveSupplier(user,id,body,{merge,version:v}={}){
    if(!canWrite(user))fail(403,"Your account can only view suppliers.");const old=getDoc("suppliers",id);if(old){if(!isAdmin(user))fail(403,"Only owners and editors can edit supplier profiles.");version(old,v);}
    const p=merge?{...old?.data,...body}:body;validateSupplier(p);
    const aliases=[...new Set([...(old?.data.aliases||[]),...(old&&old.data.name!==text(p.name,160)?[old.data.name]:[])])];
    if(listDocs("suppliers").some(s=>s.id!==id&&[s.data.name,...(s.data.aliases||[])].some(n=>n.toLowerCase()===text(p.name,160).toLowerCase())))fail(409,"A supplier with that name already exists.");
    const data={name:text(p.name,160),contactPerson:text(p.contactPerson,160),phone:text(p.phone,80),email:text(p.email,160),address:text(p.address),paymentTerms:Number(p.paymentTerms??0),notes:text(p.notes,1000),active:p.active!==false,aliases,createdAt:old?.data.createdAt||Date.now(),createdBy:old?.data.createdBy||user.id,updated:{at:Date.now(),by:user.id}};
    put("suppliers",id,data);audit(user,old?"supplier_update":"supplier_create","suppliers",id,data);return getDoc("suppliers",id);
  }
  function supplierIdentity(p){if(p.supplierId)return p.supplierId;const name=String(p.supplier||"").trim().toLowerCase(),entry=listDocs("suppliers").find(s=>[s.data.name,...(s.data.aliases||[])].some(n=>n.toLowerCase()===name));return entry?.id||"name:"+name;}
  function checkAttachments(ids,user){
    if(!Array.isArray(ids)||ids.length>5||new Set(ids.map(a=>a.id)).size!==ids.length)fail(400,"Attach up to five distinct receipts or documents.");
    return ids.map(a=>{const asset=ID.test(String(a.id))&&db.prepare("SELECT * FROM assets WHERE id=?").get(a.id);if(!asset||!["image/jpeg","image/png","image/webp","image/gif","application/pdf"].includes(asset.content_type))fail(400,"An expense attachment is missing or unsupported.");if(!isAdmin(user)&&asset.created_by!==user.id)fail(403,"Attach only documents you uploaded.");return {id:asset.id,name:text(a.name,160)||"Receipt",type:asset.content_type,size:asset.size};});
  }
  const saleStamp=s=>digest({dealerId:s.dealerId,date:s.date,items:s.items,amount:s.amount,voided:!!s.voided});
  function decorateDeliveries(rows){return rows.map(r=>{const sale=getDoc("txns",r.data.saleId);return {...r,data:{...r.data,status:r.data.voided?"voided":!sale||sale.data.voided||saleStamp(sale.data)!==r.data.saleStamp?"needs review":"confirmed"}};});}
  function validateImport(c,p){
    if(c==="suppliers")validateSupplier(p);
    if(c==="bankStatements"&&(!text(p.bank)||!METHODS.includes(p.method)||!Array.isArray(p.lines)||p.lines.some(l=>!ID.test(String(l.id))||!validDate(l.date)||!Number.isFinite(Number(l.amount))||!cents(l.amount)||!["unmatched","matched","ignored"].includes(l.status)||l.matches&&!Array.isArray(l.matches))))fail(400,"Invalid bank statement records.");
    if(c==="reminders"&&(!ID.test(String(p.dealerId))||!validDate(p.date)||!text(p.channel)||!text(p.outcome)||p.promiseDate&&!validDate(p.promiseDate)))fail(400,"Invalid collection contact record.");
    if(c==="deliveries"&&(!ID.test(String(p.saleId))||!ID.test(String(p.dealerId))||!validDate(p.date)||!text(p.recipient)||!ID.test(String(p.signatureAssetId))||p.history&&!Array.isArray(p.history)))fail(400,"Invalid delivery confirmation.");
    if(c==="supplierApplications"&&(!ID.test(String(p.sourceId))||!ID.test(String(p.targetId))||p.sourceId===p.targetId||!validDate(p.date)||!money(p.amount)))fail(400,"Invalid supplier credit application.");
  }
  function register(app,needUser,needAdmin){
    app.post("/api/supplier-applications",needUser,needAdmin,(req,res)=>{
      const out=once(req.user,req.get("Idempotency-Key"),{route:"apply_supplier_credit",body:req.body},()=>{
        const b=req.body,source=getDoc("purchases",b.sourceId),target=getDoc("purchases",b.targetId);version(source,b.sourceVersion);version(target,b.targetVersion);assertOpen(b.date);
        if(source.id===target.id||supplierIdentity(source.data)!==supplierIdentity(target.data))fail(400,"Apply credit between different orders belonging to the same supplier.");
        if(!validDate(b.date)||b.date>today()||b.date<source.data.date||b.date<target.data.date||!money(b.amount)||cents(b.amount)>cents(supplierPaid(source.data)-supplierBill(source.data))||cents(b.amount)>cents(supplierBill(target.data)-supplierPaid(target.data)))fail(400,"Apply no more than the available source credit and target unpaid bill.");
        const id=crypto.randomUUID(),entry={id,sourceId:source.id,targetId:target.id,date:b.date,amount:r2(b.amount),note:text(b.note),createdAt:Date.now(),createdBy:req.user.id};
        put("supplierApplications",id,entry);put("purchases",source.id,{...source.data,applicationsOut:[...(source.data.applicationsOut||[]),entry]});put("purchases",target.id,{...target.data,applicationsIn:[...(target.data.applicationsIn||[]),entry]});audit(req.user,"supplier_credit_apply","supplierApplications",id,entry);return getDoc("supplierApplications",id);
      });notify("supplierApplications","purchases");res.json(out);
    });
    app.post("/api/supplier-applications/:id/void",needUser,needAdmin,(req,res)=>{
      const out=once(req.user,req.get("Idempotency-Key"),{route:"void_supplier_application",id:req.params.id,body:req.body},()=>{
        const entry=getDoc("supplierApplications",req.params.id);version(entry,req.body.version);if(entry.data.voided||!text(req.body.reason))fail(400,"Enter a reason for voiding a live credit application.");assertOpen(entry.data.date);
        const source=getDoc("purchases",entry.data.sourceId),target=getDoc("purchases",entry.data.targetId);version(source,req.body.sourceVersion);version(target,req.body.targetVersion);
        if(cents(supplierPaid(target.data))-cents(entry.data.amount)<0)fail(409,"Reverse related refunds or onward credit applications first.");
        const data={...entry.data,voided:true,voidReason:text(req.body.reason),voidedAt:Date.now(),voidedBy:req.user.id};put("supplierApplications",entry.id,data);
        put("purchases",source.id,{...source.data,applicationsOut:(source.data.applicationsOut||[]).map(e=>e.id===entry.id?data:e)});put("purchases",target.id,{...target.data,applicationsIn:(target.data.applicationsIn||[]).map(e=>e.id===entry.id?data:e)});audit(req.user,"supplier_credit_apply_void","supplierApplications",entry.id,data);return getDoc("supplierApplications",entry.id);
      });notify("supplierApplications","purchases");res.json(out);
    });
    app.post("/api/customer-refunds",needUser,needAdmin,(req,res)=>{
      const out=once(req.user,req.get("Idempotency-Key"),{route:"customer_refund",body:req.body},()=>{
        const b=req.body,dealer=getDoc("dealers",b.dealerId);if(!dealer)fail(400,"Choose a dealer.");assertOpen(b.date);
        const rows=listDocs("txns").filter(r=>r.data.dealerId===b.dealerId),balance=Math.max(allocations(rows,"9999-12-31").balance,allocations(rows,b.date).balance);
        if(!validDate(b.date)||b.date>today()||!money(b.amount)||!METHODS.includes(b.method)||!text(b.reason)||cents(b.amount)>cents(-balance))fail(400,"Refund no more than the dealer's available credit, using a valid date and method.");
        if(b.sourceReturnId){const original=getDoc("txns",b.sourceReturnId);if(!original||original.data.type!=="return"||original.data.voided||original.data.dealerId!==b.dealerId||b.date<original.data.date)fail(400,"Choose a live return for this dealer on or before the refund date.");const refunded=rows.filter(r=>!r.data.voided&&r.data.type==="refund"&&r.data.sourceReturnId===b.sourceReturnId).reduce((n,r)=>n+cents(r.data.amount),0);if(refunded+cents(b.amount)>cents(original.data.amount))fail(409,"Refunds already exhaust this return's credit.");}
        const id=crypto.randomUUID(),number=listDocs("txns").reduce((n,r)=>r.data.type==="refund"?Math.max(n,Number(String(r.data.no||"").split("-")[1])||0):n,0)+1;
        const data={type:"refund",no:"RF-"+String(number).padStart(5,"0"),dealerId:b.dealerId,date:b.date,amount:r2(b.amount),method:b.method,ref:text(b.reference),note:text(b.reason),sourceReturnId:b.sourceReturnId||null,createdAt:Date.now(),createdBy:req.user.id};put("txns",id,data);if(allocations([...rows,{id,data}],"9999-12-31").violations.length)fail(409,"Available credit has changed. Review invoice allocations before refunding.");audit(req.user,"customer_refund","txns",id,data);return getDoc("txns",id);
      });notify("txns");res.json(out);
    });
    app.post("/api/customer-refunds/:id/void",needUser,needAdmin,(req,res)=>{
      const out=once(req.user,req.get("Idempotency-Key"),{route:"void_customer_refund",id:req.params.id,body:req.body},()=>{const r=getDoc("txns",req.params.id);version(r,req.body.version);if(r.data.type!=="refund"||r.data.voided||!text(req.body.reason))fail(400,"Choose a live customer refund and give a correction reason.");assertOpen(r.data.date);const data={...r.data,voided:true,voidReason:text(req.body.reason),voidedAt:Date.now(),voidedBy:req.user.id};put("txns",r.id,data);audit(req.user,"customer_refund_void","txns",r.id,data);return getDoc("txns",r.id);});notify("txns");res.json(out);
    });
    app.post("/api/reminders",needUser,(req,res)=>{
      if(!canWrite(req.user))fail(403,"Only store staff can record collection contacts.");
      const out=once(req.user,req.get("Idempotency-Key"),{route:"collection_contact",body:req.body},()=>{
        const b=req.body,dealer=getDoc("dealers",b.dealerId);if(!dealer)fail(400,"Choose a dealer.");
        if(!validDate(b.date)||b.date>today()||!["Call","SMS","Messenger","Email","In person","Other"].includes(b.channel)||!["Reminder recorded","No answer","Promise to pay","Follow up"].includes(b.outcome)||!text(b.note))fail(400,"Enter the contact date, channel, outcome and note.");
        const balance=allocations(listDocs("txns").filter(r=>r.data.dealerId===b.dealerId),"9999-12-31").balance;
        if(b.outcome==="Promise to pay"&&(!validDate(b.promiseDate)||b.promiseDate<b.date||!money(b.promiseAmount)||cents(b.promiseAmount)>cents(balance)))fail(400,"Enter a promised payment date and amount no greater than the outstanding balance.");
        const id=crypto.randomUUID(),data={dealerId:b.dealerId,date:b.date,channel:b.channel,outcome:b.outcome,note:text(b.note,1000),promiseDate:b.outcome==="Promise to pay"?b.promiseDate:null,promiseAmount:b.outcome==="Promise to pay"?r2(b.promiseAmount):null,createdAt:Date.now(),createdBy:req.user.id};put("reminders",id,data);put("dealers",dealer.id,{...dealer.data,lastReminded:b.date,lastRemindedBy:req.user.id});audit(req.user,"collection_contact","reminders",id,data);return getDoc("reminders",id);
      });notify("reminders","dealers");res.json(out);
    });
    app.post("/api/deliveries",needUser,(req,res)=>{
      if(!canWrite(req.user))fail(403,"Only store staff can confirm deliveries.");
      const out=once(req.user,req.get("Idempotency-Key"),{route:"delivery_confirmation",body:req.body},()=>{
        const b=req.body,sale=getDoc("txns",b.saleId);if(!sale||sale.data.type!=="sale"||sale.data.opening||sale.data.voided)fail(400,"Choose a live itemized sale for delivery confirmation.");
        if(Number(b.saleVersion)!==sale.version)fail(409,"This sale changed. Reload it before confirming delivery.","conflict");
        const id="delivery_"+digest(b.saleId).slice(0,40),old=getDoc("deliveries",id);if(old){version(old,b.version);if(!isAdmin(req.user)&&old.data.createdBy!==req.user.id)fail(403,"Only the recorder or an administrator can correct this confirmation.");if(!text(b.reason))fail(400,"Give a reason for replacing the delivery confirmation.");}
        if(!text(b.recipient,160)||!validDate(b.date)||b.date<sale.data.date||b.date>today()||!b.signatureAssetId)fail(400,"Enter the recipient, delivery date and recipient signature.");
        for(const id of [b.signatureAssetId,b.proofAssetId].filter(Boolean)){const a=ID.test(String(id))&&db.prepare("SELECT * FROM assets WHERE id=?").get(id);if(!a||!a.content_type.startsWith("image/")||!isAdmin(req.user)&&a.created_by!==req.user.id)fail(400,"Upload valid signature and proof images for this delivery.");}
        const data={saleId:b.saleId,dealerId:sale.data.dealerId,recipient:text(b.recipient,160),date:b.date,signatureAssetId:b.signatureAssetId,proofAssetId:b.proofAssetId||null,note:text(b.note),saleStamp:saleStamp(sale.data),createdAt:Date.now(),createdBy:req.user.id,history:[...(old?.data.history||[]),...(old?[{...old.data,history:undefined,reason:text(b.reason)}]:[])]};put("deliveries",id,data);audit(req.user,"delivery_confirm","deliveries",id,{saleId:b.saleId,recipient:data.recipient,date:data.date});return getDoc("deliveries",id);
      });notify("deliveries");res.json(out);
    });
    app.post("/api/deliveries/:id/void",needUser,(req,res)=>{
      const out=once(req.user,req.get("Idempotency-Key"),{route:"void_delivery",id:req.params.id,body:req.body},()=>{const d=getDoc("deliveries",req.params.id);version(d,req.body.version);if(!canWrite(req.user)||!isAdmin(req.user)&&d.data.createdBy!==req.user.id)fail(403,"Only the recorder or an administrator can void this confirmation.");if(d.data.voided||!text(req.body.reason))fail(400,"Choose a live confirmation and give a reason.");put("deliveries",d.id,{...d.data,voided:true,voidReason:text(req.body.reason),voidedAt:Date.now(),voidedBy:req.user.id});audit(req.user,"delivery_void","deliveries",d.id,{reason:text(req.body.reason)});return getDoc("deliveries",d.id);});notify("deliveries");res.json(out);
    });
    app.post("/api/bank/import",needUser,needAdmin,(req,res)=>{
      const out=once(req.user,req.get("Idempotency-Key"),{route:"bank_import",body:req.body},()=>{
        const b=req.body;if(!text(b.bank,160)||!METHODS.includes(b.method)||!Array.isArray(b.lines)||!b.lines.length||b.lines.length>2000)fail(400,"Choose a bank/account, payment method and up to 2,000 statement lines.");
        const known=new Set(listDocs("bankStatements").flatMap(r=>r.data.lines.map(l=>l.key))),lines=[];let duplicates=0;
        for(const l of b.lines){if(!validDate(l.date)||!Number.isFinite(Number(l.amount))||!cents(l.amount)||Math.abs(cents(l.amount))>1e12)fail(400,"Every bank line needs an ISO date and a nonzero signed amount.");const data={date:l.date,amount:r2(l.amount),description:text(l.description),reference:text(l.reference,160),externalId:text(l.externalId,160)},key=digest([text(b.bank,160).toLowerCase(),b.method,data.date,data.amount,data.externalId||data.reference,data.description]);if(known.has(key)){duplicates++;continue;}known.add(key);lines.push({...data,id:crypto.randomUUID(),key,status:"unmatched"});}
        if(!lines.length)return {imported:0,duplicates};const ids=[];
        for(let offset=0;offset<lines.length;offset+=100){const id=crypto.randomUUID(),data={bank:text(b.bank,160),method:b.method,lines:lines.slice(offset,offset+100),createdAt:Date.now(),createdBy:req.user.id};put("bankStatements",id,data);audit(req.user,"bank_import","bankStatements",id,{count:data.lines.length,duplicates});ids.push(id);}
        return {id:ids[0],ids,imported:lines.length,duplicates};
      });notify("bankStatements");res.json(out);
    });
    app.post("/api/bank/:id/lines/:lineId",needUser,needAdmin,(req,res)=>{
      const out=once(req.user,req.get("Idempotency-Key"),{route:"bank_match",id:req.params.id,line:req.params.lineId,body:req.body},()=>{
        const statement=getDoc("bankStatements",req.params.id);version(statement,req.body.version);const line=statement.data.lines.find(l=>l.id===req.params.lineId);if(!line)fail(404,"Bank line not found.");const b=req.body;if(!["match","unmatch","ignore"].includes(b.action))fail(400,"Choose match, unmatch or ignore.");
        let changed={...line,status:"unmatched",matches:[],note:text(b.note)};
        if(b.action==="ignore"){if(!text(b.note))fail(400,"Explain why this bank line is ignored.");changed.status="ignored";}
        if(b.action==="match"){
          const events=bankEvents(listDocs("txns").map(r=>[r.id,r.data]),listDocs("expenses").map(r=>[r.id,r.data]),listDocs("purchases").map(r=>[r.id,r.data]));
          if(!Array.isArray(b.eventIds)||!b.eventIds.length||b.eventIds.length>100||new Set(b.eventIds).size!==b.eventIds.length)fail(400,"Choose distinct ledger entries to match.");
          const used=new Set(listDocs("bankStatements").flatMap(s=>s.data.lines.filter(l=>!(s.id===statement.id&&l.id===line.id)&&l.status==="matched").flatMap(l=>(l.matches||[]).map(m=>m.id))));
          const matches=b.eventIds.map(id=>{const e=events.find(e=>e.id===id);if(!e||e.method!==statement.data.method||used.has(id))fail(409,"A selected entry is missing, uses another method, or is already matched.");return {id:e.id,stamp:e.stamp,amount:e.amount,label:e.label};});
          if(matches.reduce((n,m)=>n+cents(m.amount),0)!==cents(line.amount))fail(400,"Selected ledger amounts must equal the signed bank amount exactly.");changed={...changed,status:"matched",matches};
        }
        changed.updated={at:Date.now(),by:req.user.id};put("bankStatements",statement.id,{...statement.data,lines:statement.data.lines.map(l=>l.id===line.id?changed:l)});audit(req.user,"bank_"+b.action,"bankStatements",statement.id,{lineId:line.id,eventIds:b.eventIds||[],note:text(b.note)});return getDoc("bankStatements",statement.id);
      });notify("bankStatements");res.json(out);
    });
  }
  return {saveSupplier,validateSupplier,validateImport,checkAttachments,decorateDeliveries,register};
}
module.exports={createExtensions,supplierBill,supplierPaid};
