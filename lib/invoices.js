"use strict";
const crypto=require("node:crypto");
const {today,r2}=require("./credit");
const {validDate,cents}=require("./ledger");
const {inventoryBasis,precise}=require("./inventory");
const text=v=>typeof v==="string"?v.trim().slice(0,500):"";
function createInvoiceMatching({getDoc,listDocs,put,audit,fail,once,broadcast,assertOpen}){
  const notify=()=>["purchaseInvoices","purchases","products"].forEach(broadcast);
  function validate(b){if(!text(b.invoiceNo)||!validDate(b.date)||!Array.isArray(b.items)||!b.items.length||b.items.length>100||new Set(b.items.map(i=>i.productId)).size!==b.items.length||b.items.some(i=>!i||!Number.isSafeInteger(Number(i.qty))||i.qty<=0||i.qty>9999||i.unitCost==null||i.unitCost===""||!Number.isFinite(Number(i.unitCost))||i.unitCost<0||i.unitCost>1e9)||!Number.isFinite(Number(b.freight||0))||Number(b.freight||0)<0||Number(b.freight||0)>1e9)fail(400,"Enter the supplier invoice number, date, distinct product quantities, unit prices and nonnegative freight.");}
  function compare(p,invoice,id){
    const invoiced=new Map();for(const inv of listDocs("purchaseInvoices"))if(inv.id!==id&&inv.data.purchaseId===invoice.purchaseId&&inv.data.status==="matched")for(const i of inv.data.items)invoiced.set(i.productId,(invoiced.get(i.productId)||0)+i.qty);
    const issues=[],lines=invoice.items.map(i=>{const ordered=p.items.find(o=>o.productId===i.productId);if(!ordered)fail(400,"Invoice products must belong to the selected purchase order.");const remaining=Math.max(0,ordered.receivedQty-(invoiced.get(i.productId)||0)),variance=r2(i.qty*(i.unitCost-ordered.unitCost));if(i.qty>remaining)issues.push("Billed quantity exceeds unbilled received stock for "+(getDoc("products",i.productId)?.data.name||i.productId));if(variance)issues.push("Unit price differs for "+(getDoc("products",i.productId)?.data.name||i.productId));return {...i,orderedQty:ordered.qty,receivedQty:ordered.receivedQty,alreadyInvoiced:invoiced.get(i.productId)||0,agreedUnitCost:ordered.unitCost,variance};});
    if(invoice.freight)issues.push("Freight is additional to the purchase order");
    return {lines,issues,baseline:r2(lines.reduce((n,i)=>n+i.qty*i.agreedUnitCost,0)),total:r2(lines.reduce((n,i)=>n+i.qty*i.unitCost,0)+invoice.freight),variance:r2(lines.reduce((n,i)=>n+i.variance,0)+invoice.freight),quantityReady:lines.every(i=>i.qty<=i.receivedQty-i.alreadyInvoiced)};
  }
  function accept(user,invoiceId,data,input={}){
    const order=getDoc("purchases",data.purchaseId);if(!order)fail(404,"Purchase order not found.");assertOpen(data.date);
    if(Number(input.purchaseVersion)!==order.version)fail(409,"The purchase changed. Review the invoice again.","conflict");
    const report=compare(order.data,data,invoiceId);if(!report.quantityReady)fail(409,"Receive the outstanding quantities or reject the over-billed invoice before matching it.");
    const invoiceSubtotal=data.items.reduce((n,i)=>n+i.qty*i.unitCost,0),quantityTotal=data.items.reduce((n,i)=>n+i.qty,0),stockAdjustments=[];let expenseVariance=0;
    for(const line of report.lines){const product=getDoc("products",line.productId),freightShare=data.freight*(invoiceSubtotal?line.qty*line.unitCost/invoiceSubtotal:line.qty/quantityTotal),difference=line.variance+freightShare;if(!difference)continue;
      if(input.review&&Number(input.productVersions?.[line.productId])!==product.version)fail(409,"Inventory changed. Review the invoice valuation again.","conflict");
      const received=line.receivedQty,remaining=listDocs("batches").filter(b=>b.data.productId===line.productId&&b.data.purchaseId===data.purchaseId).reduce((n,b)=>n+b.data.remainingQty,0),share=received?Math.min(1,remaining/received):0,valueDelta=precise(difference*share),basis=inventoryBasis(product.data);
      if(valueDelta&&basis.value==null)fail(409,"Establish a known inventory cost before accepting this price variance.");
      if(valueDelta&&basis.value+valueDelta<0)fail(409,"This adjustment would make inventory value negative. Review the invoice and downstream stock usage.");
      if(valueDelta){put("products",product.id,{...product.data,inventoryValue:precise(basis.value+valueDelta)});stockAdjustments.push({productId:product.id,valueDelta,stockAtPost:product.data.stock,valueAfter:precise(basis.value+valueDelta),versionAfter:getDoc("products",product.id).version});}
      expenseVariance+=difference-valueDelta;
    }
    const next={...data,...report,status:"matched",stockAdjustments,expenseVariance:r2(expenseVariance),matchedAt:Date.now(),matchedBy:user.id};put("purchaseInvoices",invoiceId,next);
    put("purchases",order.id,{...order.data,invoiceAdjustments:[...(order.data.invoiceAdjustments||[]),{id:invoiceId,date:data.date,amount:report.variance,invoiceNo:data.invoiceNo}]});audit(user,"invoice_match","purchaseInvoices",invoiceId,{purchaseId:order.id,variance:report.variance,expenseVariance:next.expenseVariance});return getDoc("purchaseInvoices",invoiceId);
  }
  function register(app,needUser,needAdmin){
    app.post("/api/purchase-invoices",needUser,needAdmin,(req,res)=>{
      const out=once(req.user,req.get("Idempotency-Key"),{route:"invoice_record",body:req.body},()=>{
        const b=req.body;validate(b);const order=getDoc("purchases",b.purchaseId);if(!order)fail(404,"Purchase order not found.");if(Number(b.purchaseVersion)!==order.version)fail(409,"Purchase changed. Reload before entering an invoice.","conflict");if(b.date<order.data.date||b.date>today())fail(400,"Use an invoice date from the purchase date through today.");
        if(listDocs("purchaseInvoices").some(i=>["pending","matched"].includes(i.data.status)&&i.data.supplierKey===(order.data.supplierId||order.data.supplier.toLowerCase())&&i.data.invoiceNo.toLowerCase()===text(b.invoiceNo).toLowerCase()))fail(409,"This supplier invoice number is already recorded.");
        const id=crypto.randomUUID(),data={purchaseId:order.id,supplierKey:order.data.supplierId||order.data.supplier.toLowerCase(),invoiceNo:text(b.invoiceNo),date:b.date,items:b.items.map(i=>({productId:i.productId,qty:Number(i.qty),unitCost:r2(i.unitCost)})),freight:r2(b.freight||0),note:text(b.note),status:"pending",createdAt:Date.now(),createdBy:req.user.id};
        const report=compare(order.data,data,id);put("purchaseInvoices",id,{...data,...report});audit(req.user,"invoice_record","purchaseInvoices",id,{purchaseId:order.id,invoiceNo:data.invoiceNo,issues:report.issues});
        return report.issues.length?getDoc("purchaseInvoices",id):accept(req.user,id,data,{purchaseVersion:order.version});
      });notify();res.json(out);
    });
    app.post("/api/purchase-invoices/:id/decision",needUser,needAdmin,(req,res)=>{
      if(req.user.role!=="owner")fail(403,"Only the owner can accept supplier invoice discrepancies.");
      const out=once(req.user,req.get("Idempotency-Key"),{route:"invoice_decision",id:req.params.id,body:req.body},()=>{const invoice=getDoc("purchaseInvoices",req.params.id);if(!invoice||invoice.data.status!=="pending")fail(409,"This invoice is no longer pending.");if(Number(req.body.version)!==invoice.version)fail(409,"Invoice changed. Reload before deciding.","conflict");if(!["accept","reject"].includes(req.body.action)||!text(req.body.reason))fail(400,"Choose accept or reject and enter the reason.");const data={...invoice.data,decisionReason:text(req.body.reason)};if(req.body.action==="reject"){put("purchaseInvoices",invoice.id,{...data,status:"rejected",decidedBy:req.user.id,decidedAt:Date.now()});audit(req.user,"invoice_reject","purchaseInvoices",invoice.id,{reason:data.decisionReason});return getDoc("purchaseInvoices",invoice.id);}return accept(req.user,invoice.id,data,{purchaseVersion:req.body.purchaseVersion,productVersions:req.body.productVersions,review:true});});notify();res.json(out);
    });
    app.post("/api/purchase-invoices/:id/void",needUser,needAdmin,(req,res)=>{
      const out=once(req.user,req.get("Idempotency-Key"),{route:"invoice_void",id:req.params.id,body:req.body},()=>{const invoice=getDoc("purchaseInvoices",req.params.id);if(!invoice||invoice.data.status!=="matched"||!text(req.body.reason))fail(400,"Choose a matched invoice and give a void reason.");if(Number(req.body.version)!==invoice.version)fail(409,"Invoice changed. Reload it first.","conflict");assertOpen(invoice.data.date);
        for(const adjustment of invoice.data.stockAdjustments||[]){const product=getDoc("products",adjustment.productId);if(!product||product.data.stock!==adjustment.stockAtPost||precise(inventoryBasis(product.data).value)!==adjustment.valueAfter)fail(409,"Stock has changed since this price adjustment. Reverse dependent stock changes before voiding the invoice.");const basis=inventoryBasis(product.data);if(basis.value==null||basis.value-adjustment.valueDelta<0)fail(409,"The inventory value adjustment cannot be reversed.");put("products",product.id,{...product.data,inventoryValue:precise(basis.value-adjustment.valueDelta)});}
        const order=getDoc("purchases",invoice.data.purchaseId);put("purchases",order.id,{...order.data,invoiceAdjustments:(order.data.invoiceAdjustments||[]).map(a=>a.id===invoice.id?{...a,voided:true,voidReason:text(req.body.reason)}:a)});put("purchaseInvoices",invoice.id,{...invoice.data,status:"voided",voidReason:text(req.body.reason),voidedBy:req.user.id,voidedAt:Date.now()});audit(req.user,"invoice_void","purchaseInvoices",invoice.id,{reason:text(req.body.reason)});return getDoc("purchaseInvoices",invoice.id);});notify();res.json(out);
    });
  }
  return {register,validate};
}
module.exports={createInvoiceMatching};
