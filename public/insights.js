/* Shared calculations for inventory history and gross profit. */
(function(root){
  "use strict";
  const round=n=>Math.round((n+Number.EPSILON)*100)/100;
  function stockHistory(moves,txns){
    const rows=moves.map(([id,m])=>({...m,id,source:"move",reference:m.deliveryRef||"",kind:m.reason||"Adjustment"}));
    for(const [id,t] of txns){
      const sign=t.type==="sale"&&!t.opening?-1:t.type==="return"&&t.restock?1:0;
      if(!sign)continue;
      for(const [index,i] of (t.items||[]).entries()) rows.push({id:id+":"+index,txnId:id,source:"txn",productId:i.productId,qty:sign*Number(i.qty),date:t.date,createdAt:t.createdAt,createdBy:t.createdBy,kind:t.type==="sale"?"Credit sale":"Restocked return",reference:t.no||"",note:t.note,voided:t.voided});
    }
    return rows.sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)||String(b.date).localeCompare(String(a.date)));
  }
  function profitReport(txns,from,to,expenses,moves,purchases){
    const periods=new Map();let revenue=0,cost=0,missing=0,excluded=0;
    for(const t of txns){
      if(t.voided||t.opening||!["sale","return"].includes(t.type)||t.date<from||t.date>to)continue;
      if(!t.items?.length){excluded++;continue;}
      const needsCost=t.type==="sale"||t.restock;
      if(needsCost&&t.items.some(i=>i.unitCost==null||!Number.isFinite(Number(i.unitCost))||Number(i.unitCost)<0)){missing++;continue;}
      const sign=t.type==="sale"?1:-1;
      const amount=sign*Number(t.amount), c=needsCost?sign*t.items.reduce((n,i)=>n+Number(i.qty)*Number(i.unitCost),0):0;
      const day=periods.get(t.date)||{date:t.date,revenue:0,cost:0,count:0};day.revenue+=amount;day.cost+=c;day.count++;periods.set(t.date,day);
      revenue+=amount;cost+=c;
    }
    const rows=[...periods.values()].sort((a,b)=>a.date.localeCompare(b.date)).map(r=>({...r,revenue:round(r.revenue),cost:round(r.cost),profit:round(r.revenue-r.cost)}));
    const result={revenue:round(revenue),cost:round(cost),profit:round(revenue-cost),missing,excluded,rows};
    if(expenses){
      const daily=new Map(rows.map(r=>[r.date,{...r,expenses:0}]));let total=0;
      for(const e of expenses)if(!e.voided&&e.date>=from&&e.date<=to){const day=daily.get(e.date)||{date:e.date,revenue:0,cost:0,profit:0,count:0,expenses:0};day.expenses=round(day.expenses+Number(e.amount));daily.set(e.date,day);total+=Number(e.amount);}
      result.expenses=round(total);result.netProfit=round(result.profit-total);result.rows=[...daily.values()].sort((a,b)=>a.date.localeCompare(b.date)).map(r=>({...r,netProfit:round(r.profit-r.expenses)}));
    }
    if(moves){
      const losses=lossReport(moves,from,to),daily=new Map(result.rows.map(r=>[r.date,{...r,stockLoss:0,supplierVariance:0}]));let variance=0,unknownVariance=0;
      const day=date=>{if(!daily.has(date))daily.set(date,{date,revenue:0,cost:0,profit:0,count:0,expenses:0,netProfit:0,stockLoss:0,supplierVariance:0});return daily.get(date);};
      for(const l of losses.rows)if(l.cost!=null)day(l.date).stockLoss=round(day(l.date).stockLoss+l.cost);
      for(const p of purchases||[])for(const r of p.returns||[])if(!r.voided&&r.date>=from&&r.date<=to){if(r.variance==null)unknownVariance++;else {variance+=r.variance;day(r.date).supplierVariance=round(day(r.date).supplierVariance+r.variance);}}
      result.stockLoss=losses.total;result.unknownLosses=losses.unknown;result.supplierVariance=round(variance);result.unknownSupplierVariance=unknownVariance;result.netProfit=round((result.netProfit??result.profit)-losses.total+variance);
      result.rows=[...daily.values()].sort((a,b)=>a.date.localeCompare(b.date)).map(r=>({...r,netProfit:round((r.netProfit??r.profit)-r.stockLoss+r.supplierVariance)}));
    }
    return result;
  }
  function lossReport(moves,from,to){
    const rows=moves.filter(m=>!m.voided&&m.qty<0&&m.reason!=="Supplier return"&&m.date>=from&&m.date<=to).map(m=>({...m,units:-m.qty,cost:m.inventoryUnitCost==null?null:round(-m.qty*m.inventoryUnitCost)}));
    return {rows,total:round(rows.reduce((n,r)=>n+(r.cost||0),0)),unknown:rows.filter(r=>r.cost==null).length,units:rows.reduce((n,r)=>n+r.units,0)};
  }
  function reorderPlan(products,txns,purchases,date,leadDays=14,coverDays=30){
    const start=new Date(date+"T00:00:00Z");start.setUTCDate(start.getUTCDate()-29);const from=start.toISOString().slice(0,10),sold=new Map(),incoming=new Map();
    for(const t of txns)if(!t.voided&&!t.opening&&t.date>=from&&t.date<=date&&["sale","return"].includes(t.type))for(const i of t.items||[])sold.set(i.productId,(sold.get(i.productId)||0)+(t.type==="sale"?1:-1)*Number(i.qty));
    for(const p of purchases)if(["open","partial"].includes(p.status))for(const i of p.items||[])incoming.set(i.productId,(incoming.get(i.productId)||0)+Number(i.qty)-Number(i.receivedQty||0));
    return products.filter(([,p])=>p.active!==false).map(([id,p])=>{
      const daily=Math.max(0,sold.get(id)||0)/30,available=Number(p.availableStock??p.stock??0),onOrder=incoming.get(id)||0;
      const target=Math.max(Number(p.reorderLevel??0)+1,Math.ceil(daily*(leadDays+coverDays)));
      return {id,name:p.name,supplier:p.supplier||"",available,onOrder,daily,target,suggested:Math.max(0,target-available-onOrder),unitCost:p.purchaseCost??null,low:available<=Number(p.reorderLevel??0)||available+onOrder<Math.ceil(daily*leadDays)};
    }).filter(r=>r.low).sort((a,b)=>b.suggested-a.suggested||a.name.localeCompare(b.name));
  }
  function bankEvents(txns,expenses,purchases){
    const out=[],add=(id,date,amount,method,label,reference)=>out.push({id,date,amount:round(amount),method,label,reference:reference||"",stamp:JSON.stringify([id,date,round(amount),method])});
    for(const [id,t] of txns)if(!t.voided&&["payment","refund"].includes(t.type))add("tx:"+id,t.date,(t.type==="payment"?1:-1)*t.amount,t.method,(t.type==="payment"?"Dealer payment ":"Customer refund ")+(t.no||""),t.ref);
    for(const [id,e] of expenses)if(!e.voided)add("expense:"+id,e.date,-e.amount,e.method,"Expense · "+e.category,e.note);
    for(const [id,p] of purchases){for(const e of p.payments||[])if(!e.voided)add("supplier-payment:"+id+":"+e.id,e.date,-e.amount,e.method,"Supplier payment · "+p.no,e.reference);for(const e of p.refunds||[])if(!e.voided)add("supplier-refund:"+id+":"+e.id,e.date,e.amount,e.method,"Supplier refund · "+p.no,e.reference);}
    return out.sort((a,b)=>b.date.localeCompare(a.date));
  }
  const supplierBill=p=>round((p.items||[]).reduce((n,i)=>n+Number(i.receivedQty||0)*i.unitCost,0)-(p.returns||[]).filter(r=>!r.voided).reduce((n,r)=>n+r.creditAmount,0)+(p.invoiceAdjustments||[]).filter(a=>!a.voided).reduce((n,a)=>n+a.amount,0));
  const supplierPaid=p=>round((p.payments||[]).filter(r=>!r.voided).reduce((n,r)=>n+r.amount,0)-(p.refunds||[]).filter(r=>!r.voided).reduce((n,r)=>n+r.amount,0)+(p.applicationsIn||[]).filter(r=>!r.voided).reduce((n,r)=>n+r.amount,0)-(p.applicationsOut||[]).filter(r=>!r.voided).reduce((n,r)=>n+r.amount,0));
  const api={stockHistory,profitReport,reorderPlan,lossReport,bankEvents,supplierBill,supplierPaid};if(typeof module!=="undefined"&&module.exports)module.exports=api;else root.LedgerInsights=api;
})(typeof window!=="undefined"?window:globalThis);
