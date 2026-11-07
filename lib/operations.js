"use strict";
const crypto=require("node:crypto");
const {today,r2}=require("./credit");
const {supplierBill,supplierPaid}=require("./extensions");
const {inventoryBasis}=require("./inventory");
const {validDate,METHODS,cents}=require("./ledger");
const text=v=>typeof v==="string"?v.trim().slice(0,500):"";
const money=v=>v!==null&&v!==""&&Number.isFinite(Number(v))&&Number(v)>=0&&Number(v)<=1e9;
function createOperations({db,getDoc,listDocs,audit,put,fail,isAdmin,canWrite,once,broadcast,changeStock,assertOpen,checkAttachments}){
  const notify=(stock=false)=>(stock?["purchases","moves","products","batches"]:["purchases"]).forEach(broadcast);
  const amount=supplierBill,paid=supplierPaid;
  function validateImport(c,p){
    if(c==="expenses"){
      if(p.attachments!==undefined&&(!Array.isArray(p.attachments)||p.attachments.length>5||p.attachments.some(a=>!a||!/^[-A-Za-z0-9_.:~]{1,80}$/.test(String(a.id)))))fail(400,"An expense may contain up to five valid attachment references.");
      if(!validDate(p.date)||!text(p.category)||!money(p.amount)||cents(p.amount)<=0||!METHODS.includes(p.method))fail(400,"Enter a valid expense date, category, positive amount and payment method.");
      return;
    }
    if(!text(p.supplier)||!validDate(p.date)||!validDate(p.expectedDate)||p.expectedDate<p.date||!Array.isArray(p.items)||!p.items.length||p.items.length>100)fail(400,"Enter a supplier, valid order and expected dates, and purchase items.");
    if(!["open","partial","received","cancelled"].includes(p.status||"open"))fail(400,"Invalid purchase status.");
    const seen=new Set();
    for(const i of p.items){
      if(!i||!/^[-A-Za-z0-9_.:~]{1,80}$/.test(String(i.productId||""))||seen.has(i.productId)||!Number.isSafeInteger(Number(i.qty))||Number(i.qty)<1||Number(i.qty)>9999||!money(i.unitCost)||!Number.isSafeInteger(Number(i.receivedQty||0))||Number(i.receivedQty||0)<0||Number(i.receivedQty||0)>Number(i.qty))fail(400,"Check purchase quantities and costs; each product must appear once.");
      seen.add(i.productId);
    }
    if((p.payments||[]).some(x=>!validDate(x.date)||!money(x.amount)||Number(x.amount)<=0||!METHODS.includes(x.method))||paid(p)<0)fail(400,"Supplier payments must not exceed received goods.");
  }
  function save(user,c,id,body,{merge,version}={}){
    if(!canWrite(user))fail(403,"Your account can only view these records.");
    const old=getDoc(c,id);
    if(merge&&!old)fail(404,"Record not found.");
    if(old&&Number(version)!==old.version)fail(409,"This record changed. Reload before saving.","conflict");
    if(old&&!isAdmin(user))fail(403,"Only owners and editors can correct expenses or purchase orders.");
    const p=merge?{...old.data,...body}:{...body};
    if(c==="purchases"){
      if(old){
        if(p.status!=="cancelled"||old.data.status==="received"||old.data.status==="cancelled"||!text(p.correctionReason))fail(409,"Purchase orders are locked after creation. Cancel the outstanding quantities with a reason or create a new order.");
        const next={...old.data,status:"cancelled",cancelReason:text(p.correctionReason),updated:{at:Date.now(),by:user.id}};
        put(c,id,next);audit(user,"purchase_cancel",c,id,next);return getDoc(c,id);
      }
      validateImport(c,{...p,status:"open"});
      const supplier=p.supplierId?getDoc("suppliers",p.supplierId):listDocs("suppliers").find(s=>s.data.active!==false&&s.data.name.toLowerCase()===text(p.supplier).toLowerCase());
      if(p.supplierId&&(!supplier||supplier.data.active===false))fail(400,"Choose an active supplier.");
      const next={supplier:supplier?.data.name||text(p.supplier),supplierId:supplier?.id||null,paymentTerms:supplier?.data.paymentTerms||0,date:p.date,expectedDate:p.expectedDate,note:text(p.note),status:"open",items:(p.items||[]).map(i=>({productId:i.productId,qty:Number(i.qty),unitCost:r2(Number(i.unitCost)),receivedQty:0})),payments:[],receipts:[],createdAt:Date.now(),createdBy:user.id,no:""};
      validateImport(c,next);
      for(const i of next.items)if(!getDoc("products",i.productId)||getDoc("products",i.productId).data.active===false)fail(400,"Choose active products for this purchase.");
      const sequence=listDocs("purchases").reduce((n,r)=>Math.max(n,Number(String(r.data.no||"").split("-")[1])||0),0)+1;
      next.no="PO-"+String(sequence).padStart(5,"0");
      put(c,id,next);audit(user,"purchase_create",c,id,next);return getDoc(c,id);
    }
    validateImport(c,p);
    if(old&&!text(p.correctionReason))fail(400,"Enter a reason for this expense correction.");
    const next={attachments:checkAttachments(p.attachments||[],user),date:p.date,category:text(p.category),amount:r2(Number(p.amount)),method:p.method,payee:text(p.payee),note:text(p.note),voided:old?!!p.voided:false,createdAt:old?.data.createdAt||Date.now(),createdBy:old?.data.createdBy||user.id};
    if(old){put("revisions",crypto.randomUUID(),{collection:c,docId:id,before:old.data,reason:text(p.correctionReason),by:user.id,at:Date.now(),version:old.version});next.updated={at:Date.now(),by:user.id};next.correctionReason=text(p.correctionReason);}
    put(c,id,next);audit(user,old?"expense_update":"expense_create",c,id,next);return getDoc(c,id);
  }
  function register(app,needUser,needAdmin){
    app.post("/api/purchases/:id/returns",needUser,needAdmin,(req,res)=>{
      const result=once(req.user,req.get("Idempotency-Key"),{route:"supplier_return",id:req.params.id,body:req.body},()=>{
        const order=getDoc("purchases",req.params.id);if(!order)fail(404,"Purchase order not found.");
        const b=req.body,p=order.data;assertOpen(b.date);
        if(Number(b.version)!==order.version)fail(409,"Purchase changed. Reload before returning goods.","conflict");
        if(!validDate(b.date)||b.date<p.date||b.date>today()||!text(b.reference)||!text(b.reason)||!Array.isArray(b.items)||!b.items.length)fail(400,"Enter the return date, credit reference, reason and quantities.");
        if((p.returns||[]).some(r=>!r.voided&&r.reference.toLowerCase()===text(b.reference).toLowerCase()))fail(409,"That credit reference has already been used on this purchase.");
        const returned=new Map();for(const r of p.returns||[])if(!r.voided)for(const i of r.items)returned.set(i.productId,(returned.get(i.productId)||0)+i.qty);
        const id=crypto.randomUUID(),seen=new Set(),items=[],moves=[];let creditAmount=0,stockCost=0,unknownCost=false;
        for(const i of b.items){const line=p.items.find(x=>x.productId===i.productId),qty=Number(i.qty),product=getDoc("products",i.productId);
          const receivedToDate=(p.receipts||[]).filter(r=>r.date<=b.date).reduce((n,r)=>n+(r.items||[]).filter(x=>x.productId===i.productId).reduce((sum,x)=>sum+Number(x.qty),0),0);
          if(!line||!product||seen.has(i.productId)||!Number.isSafeInteger(qty)||qty<=0||qty+(returned.get(i.productId)||0)>Math.min(line.receivedQty,receivedToDate))fail(400,"Return quantities exceed the goods received and not already returned.");
          seen.add(i.productId);const cost=inventoryBasis(product.data).average;
          const move={productId:i.productId,qty:-qty,date:b.date,reason:"Supplier return",supplier:p.supplier,deliveryRef:text(b.reference),unitCost:line.unitCost,inventoryUnitCost:cost,purchaseId:order.id,supplierReturnId:id,note:text(b.reason),createdAt:Date.now(),createdBy:req.user.id};
          changeStock("moves",null,move);const moveId=crypto.randomUUID();put("moves",moveId,move);audit(req.user,"supplier_return","moves",moveId,move);moves.push(moveId);
          creditAmount+=qty*line.unitCost;if(cost==null)unknownCost=true;else stockCost+=qty*cost;
          items.push({productId:i.productId,qty,unitCost:line.unitCost,inventoryUnitCost:cost});
        }
        const entry={id,date:b.date,reference:text(b.reference),reason:text(b.reason),items,moves,creditAmount:r2(creditAmount),stockCost:unknownCost?null:r2(stockCost),variance:unknownCost?null:r2(creditAmount-stockCost),at:Date.now(),by:req.user.id};
        put("purchases",order.id,{...p,returns:[...(p.returns||[]),entry]});audit(req.user,"supplier_credit","purchases",order.id,entry);return getDoc("purchases",order.id);
      });notify(true);res.json(result);
    });
    app.post("/api/purchases/:id/refunds",needUser,needAdmin,(req,res)=>{
      const result=once(req.user,req.get("Idempotency-Key"),{route:"supplier_refund",id:req.params.id,body:req.body},()=>{
        const order=getDoc("purchases",req.params.id);if(!order)fail(404,"Purchase not found.");
        const b=req.body,p=order.data;assertOpen(b.date);
        if(Number(b.version)!==order.version)fail(409,"Purchase changed. Reload before recording the refund.","conflict");
        if(!validDate(b.date)||b.date<p.date||b.date>today()||!money(b.amount)||cents(b.amount)<=0||!METHODS.includes(b.method)||cents(b.amount)>cents(paid(p)-amount(p)))fail(400,"The refund must be positive and no greater than the supplier credit owed to you.");
        const refund={id:crypto.randomUUID(),date:b.date,amount:r2(Number(b.amount)),method:b.method,reference:text(b.reference),at:Date.now(),by:req.user.id};
        put("purchases",order.id,{...p,refunds:[...(p.refunds||[]),refund]});audit(req.user,"supplier_refund","purchases",order.id,refund);return getDoc("purchases",order.id);
      });notify();res.json(result);
    });
    app.post("/api/purchases/:id/refunds/:refundId/void",needUser,needAdmin,(req,res)=>{
      const result=once(req.user,req.get("Idempotency-Key"),{route:"supplier_refund_void",id:req.params.id,refund:req.params.refundId,body:req.body},()=>{
        const order=getDoc("purchases",req.params.id);if(!order)fail(404,"Purchase not found.");const refund=(order.data.refunds||[]).find(r=>r.id===req.params.refundId);
        if(!refund||refund.voided||!text(req.body.reason)||Number(req.body.version)!==order.version)fail(409,"Reload the purchase and enter a reason to void a live refund.");assertOpen(refund.date);
        put("purchases",order.id,{...order.data,refunds:order.data.refunds.map(r=>r.id===refund.id?{...r,voided:true,voidReason:text(req.body.reason),voidedAt:Date.now(),voidedBy:req.user.id}:r)});audit(req.user,"supplier_refund_void","purchases",order.id,{id:refund.id,reason:text(req.body.reason)});return getDoc("purchases",order.id);
      });notify();res.json(result);
    });
    app.post("/api/purchases/:id/returns/:returnId/void",needUser,needAdmin,(req,res)=>{
      const result=once(req.user,req.get("Idempotency-Key"),{route:"supplier_return_void",id:req.params.id,returnId:req.params.returnId,body:req.body},()=>{
        const order=getDoc("purchases",req.params.id);if(!order)fail(404,"Purchase not found.");const p=order.data,r=(p.returns||[]).find(r=>r.id===req.params.returnId);
        if(!r||r.voided||!text(req.body.reason)||Number(req.body.version)!==order.version)fail(409,"Reload the purchase and enter a reason to void a live return.");assertOpen(r.date);
        for(const moveId of r.moves){const move=getDoc("moves",moveId);if(!move||move.data.voided)fail(409,"The return stock movement is unavailable.");changeStock("moves",move.data,{...move.data,voided:true});put("moves",moveId,{...move.data,voided:true,voidReason:text(req.body.reason),voidedAt:Date.now(),voidedBy:req.user.id});}
        put("purchases",order.id,{...p,returns:p.returns.map(x=>x.id===r.id?{...x,voided:true,voidReason:text(req.body.reason),voidedAt:Date.now(),voidedBy:req.user.id}:x)});audit(req.user,"supplier_return_void","purchases",order.id,{id:r.id,reason:text(req.body.reason)});return getDoc("purchases",order.id);
      });notify(true);res.json(result);
    });
    app.post("/api/purchases/:id/payments/:paymentId/void",needUser,needAdmin,(req,res)=>{
      const result=once(req.user,req.get("Idempotency-Key"),{action:"supplier_payment_void",id:req.params.id,paymentId:req.params.paymentId,body:req.body},()=>{
        const order=getDoc("purchases",req.params.id);if(!order)fail(404,"Purchase not found.");
        if(Number(req.body.version)!==order.version)fail(409,"Purchase changed. Reload before correcting payment.","conflict");
        if(!text(req.body.reason))fail(400,"Enter a reason for voiding this payment.");
        const payment=(order.data.payments||[]).find(p=>p.id===req.params.paymentId);if(payment)assertOpen(payment.date);
        if(!payment||payment.voided)fail(409,"Payment is missing or already voided.");
        if(cents(paid(order.data))-cents(payment.amount)<0)fail(409,"Void the related supplier refunds before voiding this payment.");
        const payments=order.data.payments.map(p=>p.id===payment.id?{...p,voided:true,voidReason:text(req.body.reason),voidedBy:req.user.id,voidedAt:Date.now()}:p);
        put("purchases",order.id,{...order.data,payments});audit(req.user,"supplier_payment_void","purchases",order.id,{paymentId:payment.id,reason:text(req.body.reason)});return getDoc("purchases",order.id);
      });notify();res.json(result);
    });
    app.post("/api/purchases/:id/receive",needUser,(req,res)=>{
      if(!canWrite(req.user))fail(403,"Only store staff can receive stock.");
      const result=once(req.user,req.get("Idempotency-Key"),{action:"purchase_receive",id:req.params.id,body:req.body},()=>{
        const order=getDoc("purchases",req.params.id);if(!order)fail(404,"Purchase order not found.");
        const p=order.data,b=req.body;assertOpen(b.date);
        if(Number(b.version)!==order.version)fail(409,"Purchase order changed. Reload before receiving.","conflict");
        if(!["open","partial"].includes(p.status))fail(409,"This order cannot receive more stock.");
        if(!validDate(b.date)||b.date<p.date||b.date>today()||!text(b.deliveryRef)||!Array.isArray(b.items)||!b.items.length)fail(400,"Enter the delivery date, reference and received quantities.");
        if((p.receipts||[]).some(r=>r.deliveryRef.toLowerCase()===text(b.deliveryRef).toLowerCase()))fail(409,"That delivery reference has already been received on this order.");
        const seen=new Set(),receiptId=crypto.randomUUID(),moves=[],received={};
        for(const i of b.items){const line=p.items.find(x=>x.productId===i.productId),qty=Number(i.qty);
          if(!line||seen.has(i.productId)||!Number.isSafeInteger(qty)||qty<=0||qty>line.qty-line.receivedQty)fail(400,"Received quantities exceed the outstanding order or contain duplicate products.");
          seen.add(i.productId);received[i.productId]=qty;
          const move={productId:i.productId,qty,batchCode:text(i.batchCode,160),expiryDate:i.expiryDate||null,date:b.date,reason:"Received stock",supplier:p.supplier,deliveryRef:text(b.deliveryRef),unitCost:line.unitCost,inventoryUnitCost:line.unitCost,purchaseId:order.id,note:text(b.note),createdAt:Date.now(),createdBy:req.user.id};
          changeStock("moves",null,move);
          const product=getDoc("products",i.productId);put("products",product.id,{...product.data,purchaseCost:line.unitCost,supplier:p.supplier});
          const id=crypto.randomUUID();put("moves",id,move);audit(req.user,"create","moves",id,move);moves.push(id);
        }
        const items=p.items.map(i=>({...i,receivedQty:i.receivedQty+(received[i.productId]||0)}));
        const next={...p,dueDate:p.dueDate||new Date(Date.parse(b.date+"T00:00:00Z")+(p.paymentTerms||0)*864e5).toISOString().slice(0,10),items,status:items.every(i=>i.receivedQty===i.qty)?"received":"partial",receipts:[...(p.receipts||[]),{id:receiptId,date:b.date,deliveryRef:text(b.deliveryRef),items:b.items.map(i=>({productId:i.productId,qty:Number(i.qty)})),moves,at:Date.now(),by:req.user.id}],updated:{at:Date.now(),by:req.user.id}};
        put("purchases",order.id,next);audit(req.user,"purchase_receive","purchases",order.id,next);return getDoc("purchases",order.id);
      });notify(true);res.json(result);
    });
    app.post("/api/purchases/:id/payments",needUser,needAdmin,(req,res)=>{
      const result=once(req.user,req.get("Idempotency-Key"),{action:"supplier_payment",id:req.params.id,body:req.body},()=>{
        const order=getDoc("purchases",req.params.id);if(!order)fail(404,"Purchase order not found.");
        const b=req.body,p=order.data;assertOpen(b.date);
        if(Number(b.version)!==order.version)fail(409,"Purchase order changed. Reload before paying.","conflict");
        if(!validDate(b.date)||b.date<p.date||b.date>today()||!money(b.amount)||cents(b.amount)<=0||!METHODS.includes(b.method)||cents(paid(p))+cents(b.amount)>cents(amount(p)))fail(400,"Enter a valid payment no greater than the received supplier bill balance.");
        const payment={id:crypto.randomUUID(),date:b.date,amount:r2(Number(b.amount)),method:b.method,reference:text(b.reference),at:Date.now(),by:req.user.id};
        put("purchases",order.id,{...p,payments:[...(p.payments||[]),payment]});audit(req.user,"supplier_payment","purchases",order.id,payment);return getDoc("purchases",order.id);
      });notify();res.json(result);
    });
  }
  return {save,register,validateImport};
}
module.exports={createOperations};
