"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {profitReport,stockHistory}=require("../public/insights");
const from="2026-01-01",to="2026-01-31";
test("gross profit uses discounted transaction amounts, nets returns, and excludes unknown costs and voids",()=>{
  const base={type:"sale",date:"2026-01-03",amount:135,items:[{qty:2,price:100,unitCost:40}]};
  const result=profitReport([base,{...base,type:"return",restock:true,amount:50,items:[{qty:1,unitCost:40}]},{...base,voided:true},{...base,opening:true},{...base,date:"2025-12-31"},{...base,items:[{qty:1,unitCost:null}]},{...base,items:[]},{...base,type:"payment"}],from,to);
  assert.deepEqual(result,{revenue:85,cost:40,profit:45,missing:1,excluded:1,rows:[{date:"2026-01-03",revenue:85,cost:40,count:2,profit:45}]});
  assert.equal(profitReport([{...base,type:"return",restock:false,amount:50,items:[{qty:1,unitCost:null}]}],from,to).profit,-50,"unrestocked returns reduce revenue without reversing cost");
  assert.equal(profitReport([{...base,items:[{qty:2,unitCost:0}]}],from,to).profit,135,"zero is a known purchase cost");
});
test("stock history includes actual stock effects and preserves voided records without inventing movements",()=>{
  const rows=stockHistory([["receipt",{productId:"p",qty:10,date:from,createdAt:1,deliveryRef:"INV-1",supplier:"Supplier",unitCost:20}]],[["sale",{type:"sale",date:from,createdAt:2,items:[{productId:"p",qty:2}]}],["return",{type:"return",date:from,restock:true,createdAt:3,items:[{productId:"p",qty:1}]}],["no-stock",{type:"return",restock:false,items:[{productId:"p",qty:1}]}],["opening",{type:"sale",opening:true,items:[]}],["void",{type:"sale",date:from,voided:true,createdAt:4,items:[{productId:"p",qty:3}]}]]);
  assert.equal(rows.length,4);assert.deepEqual(rows.map(r=>r.qty),[-3,1,-2,10]);assert.equal(rows[0].voided,true);assert.equal(rows[3].reference,"INV-1");assert.equal(rows[3].supplier,"Supplier");
});

test("operating expenses reduce net profit once and exclude voided or out-of-period expenses",()=>{
  const result=profitReport([{type:"sale",date:"2026-01-03",amount:100,items:[{qty:1,unitCost:40}]}],from,to,[{date:"2026-01-03",amount:10},{date:"2026-01-04",amount:20},{date:"2026-01-03",amount:99,voided:true},{date:"2025-12-31",amount:99}]);
  assert.equal(result.profit,60);assert.equal(result.expenses,30);assert.equal(result.netProfit,30);assert.equal(result.rows[1].netProfit,-20);
});
test("reorder suggestions account for reservations, demand, outstanding purchases, and cancelled orders",()=>{
  const rows=require("../public/insights").reorderPlan([["p",{name:"Soap",stock:10,availableStock:2,reorderLevel:5,purchaseCost:40}],["archived",{name:"Old",active:false,stock:0}]], [{type:"sale",date:"2026-01-15",items:[{productId:"p",qty:30}]}],[{status:"partial",items:[{productId:"p",qty:10,receivedQty:4}]},{status:"cancelled",items:[{productId:"p",qty:100}]}],"2026-01-30",7,14);
  assert.equal(rows.length,1);assert.equal(rows[0].daily,1);assert.equal(rows[0].onOrder,6);assert.equal(rows[0].target,21);assert.equal(rows[0].suggested,13);
});

test("stock losses and supplier return variances affect profit once and flag unknown costs",()=>{
  const result=profitReport([{type:"sale",date:"2026-01-03",amount:100,items:[{qty:1,unitCost:40}]}],from,to,[{date:"2026-01-03",amount:10}],[{date:"2026-01-03",qty:-2,reason:"Expired stock",inventoryUnitCost:5},{date:"2026-01-03",qty:-1,reason:"Missing stock",inventoryUnitCost:null},{date:"2026-01-03",qty:-1,reason:"Supplier return",inventoryUnitCost:5},{date:"2026-01-03",qty:-10,reason:"Damaged stock",inventoryUnitCost:5,voided:true}],[{returns:[{date:"2026-01-03",variance:3},{date:"2026-01-03",variance:99,voided:true}]}]);
  assert.equal(result.stockLoss,10);assert.equal(result.unknownLosses,1);assert.equal(result.supplierVariance,3);assert.equal(result.netProfit,43);assert.equal(result.rows[0].netProfit,43);
});
