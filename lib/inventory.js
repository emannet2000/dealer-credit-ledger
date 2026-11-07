"use strict";
const precise=n=>Math.round((n+Number.EPSILON)*1e6)/1e6;
function inventoryBasis(p){
  const stock=Number(p.stock||0);
  const value=Object.hasOwn(p,"inventoryValue")?p.inventoryValue:p.purchaseCost==null?null:precise(stock*Number(p.purchaseCost));
  return {value:stock===0?0:value,average:stock>0&&value!=null?precise(value/stock):stock===0?(p.purchaseCost??null):null};
}
function stockEffect(c,t){
  const out={};if(!t||t.voided)return out;
  if(c==="moves"){out[t.productId]=Number(t.qty);return out;}
  const sign=t.type==="sale"&&!t.opening?-1:t.type==="return"&&t.restock?1:0;
  if(sign)for(const i of t.items||[])out[i.productId]=(out[i.productId]||0)+sign*Number(i.qty);
  return out;
}
function valueEffect(c,t){
  const out={};if(!t||t.voided)return out;
  if(c==="moves"){out[t.productId]=t.inventoryUnitCost==null&&t.unitCost==null?null:precise(Number(t.qty)*Number(t.inventoryUnitCost??t.unitCost));return out;}
  const sign=t.type==="sale"&&!t.opening?-1:t.type==="return"&&t.restock?1:0;
  if(sign)for(const i of t.items||[]){if(i.unitCost==null||out[i.productId]===null)out[i.productId]=null;else out[i.productId]=precise((out[i.productId]||0)+sign*Number(i.qty)*Number(i.unitCost));}
  return out;
}
module.exports={inventoryBasis,stockEffect,valueEffect,precise};
