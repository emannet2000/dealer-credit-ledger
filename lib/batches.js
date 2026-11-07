"use strict";
const crypto=require("node:crypto");
const {today}=require("./credit");
const {validDate}=require("./ledger");
const text=v=>typeof v==="string"?v.trim().slice(0,160):"";
function createBatchTracking({getDoc,listDocs,put,fail,audit,broadcast,once}){
  const rows=pid=>listDocs("batches").filter(r=>r.data.productId===pid);
  function seed(pid,product){
    if(product.batchTracked)return;
    if(rows(pid).length)fail(409,"Existing batch quantities need to be reconciled before stock changes.");
    const qty=Number(product.stock||0);if(qty)put("batches",crypto.randomUUID(),{productId:pid,code:"Opening / legacy stock",expiryDate:null,receivedDate:today(),receivedQty:qty,remainingQty:qty,source:"legacy",createdAt:Date.now()});
  }
  function expired(pid,date=today()){return rows(pid).filter(r=>r.data.expiryDate&&r.data.expiryDate<date).reduce((n,r)=>n+r.data.remainingQty,0);}
  function available(pid,product,date=today()){return Math.max(0,Number(product.stock||0)-expired(pid,date));}
  function apply(c,old,next,pid,before,after,product){
    seed(pid,product);
    next.batchEffects={...(next.batchEffects||{})};next.batchBaseline={...(next.batchBaseline||{})};
    if(before===after){next.batchEffects[pid]=old?.batchEffects?.[pid]||[];return;}
    const oldEffects=old?.batchEffects?.[pid]||[],baseline=old?.batchBaseline?.[pid]??(old&&!old.batchEffects?.[pid]?before:0);
    next.batchBaseline[pid]=baseline;
    for(const effect of oldEffects){const batch=getDoc("batches",effect.batchId);if(!batch)fail(409,"The original stock batch is missing.");const qty=batch.data.remainingQty-effect.qty;if(qty<0)fail(409,"This receipt batch has already been used. Reverse its stock usage before changing the receipt quantity.");put("batches",batch.id,{...batch.data,remainingQty:qty});}
    const wanted=after-baseline,effects=[];
    if(wanted>0){
      const expiry=next.expiryDate||null;if(expiry&&!validDate(expiry))fail(400,"Choose a valid expiry date.");
      let inherited=null;
      if(c==="txns"&&next.type==="return"&&next.originalSaleId){const sale=getDoc("txns",next.originalSaleId);inherited=(sale?.data.batchEffects?.[pid]||[]).map(e=>getDoc("batches",e.batchId)?.data.expiryDate).filter(Boolean).sort()[0]||null;}
      const reusable=oldEffects.find(e=>e.qty>0),id=reusable?.batchId||crypto.randomUUID(),prior=getDoc("batches",id)?.data;
      const data={productId:pid,code:text(next.batchCode)||prior?.code||(c==="txns"?"Returned stock":"LOT-"+id.slice(0,8)),expiryDate:expiry||inherited,receivedDate:next.date||today(),receivedQty:(prior?.receivedQty||0)-(reusable?.qty||0)+wanted,remainingQty:(prior?.remainingQty||0)+wanted,source:c==="txns"?"return":next.reason==="Received stock"?"receipt":"adjustment",purchaseId:next.purchaseId||null,reference:next.deliveryRef||next.no||next.reason||"",createdAt:prior?.createdAt||Date.now()};
      put("batches",id,data);effects.push({batchId:id,qty:wanted});
    }else if(wanted<0){
      let left=-wanted;
      const sale=c==="txns"&&next.type==="sale";
      const candidates=rows(pid).filter(r=>r.data.remainingQty>0&&(!sale||!r.data.expiryDate||r.data.expiryDate>=next.date)&&(!next.requestedBatchId||r.id===next.requestedBatchId)&&(!next.supplierReturnId||r.data.purchaseId===next.purchaseId||r.data.source==="legacy")).sort((a,b)=>(a.data.expiryDate||"9999").localeCompare(b.data.expiryDate||"9999")||a.data.receivedDate.localeCompare(b.data.receivedDate)||a.id.localeCompare(b.id));
      for(const batch of candidates){if(!left)break;const qty=Math.min(left,batch.data.remainingQty);put("batches",batch.id,{...batch.data,remainingQty:batch.data.remainingQty-qty});effects.push({batchId:batch.id,qty:-qty});left-=qty;}
      if(left)fail(409,sale?"Not enough unexpired stock in the available batches.":"The selected batch does not have enough stock for this change.","insufficient_stock");
    }
    next.batchEffects[pid]=effects;
    const total=rows(pid).reduce((n,r)=>n+r.data.remainingQty,0);
    if(total!==Number(product.stock||0)+after-before)fail(409,"Batch quantities no longer match physical stock. Reload before changing stock.");
  }
  function register(app,needUser,needAdmin){
    app.post("/api/batches/initialize",needUser,needAdmin,(req,res)=>{
      const out=once(req.user,req.get("Idempotency-Key"),{route:"batch_initialize",body:req.body},()=>{const p=getDoc("products",req.body.productId);if(!p)fail(404,"Product not found.");if(Number(req.body.version)!==p.version)fail(409,"Product changed. Reload before classifying stock.","conflict");if(p.data.batchTracked)fail(409,"This product already has tracked batches.");if(req.body.expiryDate&&!validDate(req.body.expiryDate))fail(400,"Choose a valid expiry date.");seed(p.id,p.data);for(const b of rows(p.id))put("batches",b.id,{...b.data,code:text(req.body.code)||b.data.code,expiryDate:req.body.expiryDate||null});put("products",p.id,{...p.data,batchTracked:true});audit(req.user,"batch_initialize","products",p.id,{stock:p.data.stock});return getDoc("products",p.id);});broadcast("batches");broadcast("products");res.json(out);
    });
    app.patch("/api/batches/:id",needUser,needAdmin,(req,res)=>{
      const result=once(req.user,req.get("Idempotency-Key"),{route:"batch_edit",id:req.params.id,body:req.body},()=>{const b=getDoc("batches",req.params.id),input=req.body;if(!b)fail(404,"Stock batch not found.");if(Number(input.version)!==b.version)fail(409,"Batch details changed. Reload before editing.","conflict");if(!text(input.code)||input.expiryDate&&!validDate(input.expiryDate))fail(400,"Enter a batch code and a valid expiry date, or leave expiry blank.");
        const data={...b.data,code:text(input.code),expiryDate:input.expiryDate||null,updated:{at:Date.now(),by:req.user.id}};put("batches",b.id,data);audit(req.user,"batch_update","batches",b.id,{before:b.data,after:data});return getDoc("batches",b.id);});broadcast("batches");broadcast("products");res.json(result);
    });
  }
  return {apply,available,expired,seed,register};
}
module.exports={createBatchTracking};
