/* Shared invoice allocation rules for the server and ledger screens. */
(function(root){
  "use strict";
  const cents=n=>Math.round(Number(n)*100);
  function compute(rows,asOf="9999-12-31"){
    const live=rows.filter(r=>!r.data.voided&&r.data.date<=asOf).sort((a,b)=>a.data.date.localeCompare(b.data.date)||(a.data.createdAt||0)-(b.data.createdAt||0)||a.id.localeCompare(b.id));
    const sales=live.filter(r=>r.data.type==="sale").map(({id,data:t})=>({id,no:t.no,date:t.date,dueDate:t.dueDate,amount:Number(t.amount),left:cents(t.amount)})),byCredit={},violations=[];
    let paid=0;const refunds=live.filter(r=>r.data.type==="refund"),refundTotal=refunds.reduce((n,r)=>n+cents(r.data.amount),0);
    for(const {id,data:t} of live.filter(r=>!["sale","refund"].includes(r.data.type))){
      let left=cents(t.amount);paid+=left;const lines=[];
      const take=(sale,wanted)=>{const amount=Math.min(left,sale.left,wanted);if(amount>0){left-=amount;sale.left-=amount;lines.push({id:sale.id,no:sale.no,amount:amount/100,left:sale.left/100});}return amount;};
      if(t.type==="payment"&&t.allocationMode==="manual"){
        for(const request of t.invoiceAllocations||[]){const sale=sales.find(s=>s.id===request.saleId);const wanted=cents(request.amount);if(!sale||sale.date>t.date||take(sale,wanted)!==wanted)violations.push(id);}
        if(left)violations.push(id);
      }else{
        // Returns linked to a delivery reduce that delivery before FIFO credits.
        const linked=t.originalSaleId&&sales.find(s=>s.id===t.originalSaleId);if(linked)take(linked,left);
        for(const sale of sales){if(!left)break;take(sale,left);}
      }
      byCredit[id]={lines,extra:left/100};
    }
    let refunded=refundTotal;for(const c of Object.values(byCredit)){const amount=Math.min(refunded,cents(c.extra));c.extra=(cents(c.extra)-amount)/100;refunded-=amount;}if(refunded)violations.push(...refunds.map(r=>r.id));
    return {balance:(sales.reduce((n,s)=>n+cents(s.amount),0)+refundTotal-paid)/100,sales:sales.map(({left,...s})=>({...s,remaining:left/100,paid:Math.round((s.amount-left/100)*100)/100})),byCredit,violations:[...new Set(violations)]};
  }
  if(typeof module!=="undefined"&&module.exports)module.exports={compute};else root.LedgerAllocations={compute};
})(typeof window!=="undefined"?window:globalThis);
