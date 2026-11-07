"use strict";
const test=require("node:test"), assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {createApp}=require("../lib/app");
const {today}=require("../lib/credit");
const {METHODS,allocations}=require("../lib/ledger");
async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"ledger-workflows-"));
  const ctx=createApp({dataDir:dir,logger:{error:console.error}});
  const server=ctx.app.listen(0);await new Promise(r=>server.once("listening",r));
  t.after(()=>{server.closeAllConnections();server.close();ctx.close();fs.rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  function client(){let cookie="";const versions=new Map();return async(method,url,body,headers={})=>{
    const r=await fetch(base+url,{method,headers:{"Content-Type":"application/json",Cookie:cookie,...(versions.has(url)?{"If-Match":String(versions.get(url))}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    if(r.headers.get("set-cookie"))cookie=r.headers.get("set-cookie").split(";")[0];
    const data=await r.json();if(r.ok&&data.version)versions.set(url,data.version);
    if(r.ok&&Array.isArray(data)&&url.startsWith("/api/c/"))for(const row of data)versions.set(url+"/"+row.id,row.version);
    return {status:r.status,data};
  };}
  const owner=client(),staff=client(),portal=client();
  const ok=async(p,status=200)=>{const r=await p;assert.equal(r.status,status,JSON.stringify(r.data));return r.data;};
  await ok(owner("POST","/api/setup",{name:"Owner",username:"owner",password:"OwnerPassword123!"}));
  await ok(owner("PUT","/api/c/dealers/d",{data:{name:"Dealer",creditLimit:100000,terms:30}}));
  await ok(owner("PUT","/api/c/dealers/other",{data:{name:"Other dealer",creditLimit:100000,terms:30}}));
  await ok(owner("PUT","/api/c/products/p",{data:{name:"Soap",stock:10,srp:100,dealerPrice:75,purchaseCost:40,code:"SOAP"}}));
  await ok(owner("POST","/api/users",{name:"Staff",username:"staff",password:"StaffPassword123!",role:"staff"}));
  await ok(staff("POST","/api/login",{username:"staff",password:"StaffPassword123!"}));
  const sale=(extra={})=>({type:"sale",dealerId:"d",date:today(),dueDate:today(),items:[{productId:"p",name:"Soap",qty:2,price:100}],amount:200,...extra});
  const payment=(extra={})=>({type:"payment",dealerId:"d",date:today(),amount:50,method:"Cash",...extra});
  const records=async(c,who=owner)=>ok(who("GET","/api/c/"+c));
  return {...ctx,dir,base,owner,staff,portal,client,ok,sale,payment,records};
}

test("sale, stock, paid-on-release payment and numbering commit or roll back together",async t=>{
  const f=await fixture(t),{owner,ok,sale,records}=f;
  const saved=await ok(owner("PUT","/api/c/txns/s",{data:sale({paidNow:{method:"Cash"}})}));
  assert.equal((await records("products"))[0].data.stock,8);
  const tx=await records("txns");assert.equal(tx.length,2);assert.equal(saved.data.no,"DR-00001");
  assert.equal(tx.find(r=>r.data.type==="payment").data.applied[0].amount,200);
  const tooMuch=sale({items:[{productId:"p",qty:9,price:100}],amount:900});
  await ok(owner("PUT","/api/c/txns/fail",{data:tooMuch}),409);
  await ok(owner("PUT","/api/c/txns/bad-payment",{data:sale({paidNow:{method:"Wrong"}})}),400);
  assert.equal((await records("products"))[0].data.stock,8);
  assert.equal((await records("txns")).length,2);
  const second=await ok(owner("PUT","/api/c/txns/s2",{data:sale()}));assert.equal(second.data.no,"DR-00002");
});

test("concurrent retries replay the same receipt and reject changed data under the same key",async t=>{
  const {owner,ok,payment,records}=await fixture(t);
  const body={data:payment()},headers={"Idempotency-Key":"payment-retry-123"};
  const results=await Promise.all([owner("PUT","/api/c/txns/pay",body,headers),owner("PUT","/api/c/txns/pay",body,headers)]);
  assert.ok(results.every(r=>r.status===200));assert.deepEqual(results[0].data,results[1].data);
  assert.deepEqual((await ok(owner("PUT","/api/c/txns/pay",body,{...headers,"If-Match":"99"}))),results[0].data,"response loss replay ignores a refreshed version header");
  await ok(owner("PUT","/api/c/txns/pay",{data:payment({amount:60})},headers),409);
  assert.equal((await records("txns")).length,1);
});

test("corrections require a reason and the viewed version; originals and atomic voids are preserved",async t=>{
  const {owner,staff,ok,sale,records}=await fixture(t);
  const original=await ok(staff("PUT","/api/c/txns/s",{data:sale()}));
  await ok(staff("PATCH","/api/c/txns/s",{data:{note:"wrong"}}),400);
  await ok(staff("PATCH","/api/c/txns/s",{data:JSON.parse('{"__proto__":{"voided":true},"voidReason":"Injected void","correctionReason":"Unexpected field"}')}),400);
  assert.equal((await records("products"))[0].data.stock,8,"unsupported fields cannot reverse stock without voiding the ledger entry");
  await ok(staff("PATCH","/api/c/txns/s",{data:{note:"fixed",correctionReason:"Corrected address"}},{"If-Match":"99"}),409);
  const changed=await ok(staff("PATCH","/api/c/txns/s",{data:{note:"fixed",correctionReason:"Corrected address"}}));
  assert.equal(changed.data.no,original.data.no);
  await ok(staff("PATCH","/api/c/txns/s",{data:{note:"Another change without a new reason"}}),400);
  await ok(staff("PATCH","/api/c/txns/s",{data:{voided:true,voidReason:""}}),400);
  await ok(staff("PATCH","/api/c/txns/s",{data:{voided:true,voidReason:"Wrong delivery"}}));
  assert.equal((await records("products"))[0].data.stock,10);
  const history=await ok(owner("GET","/api/txns/s/history"));assert.equal(history.length,2);assert.equal(history[0].data.before.amount,200);
  await ok(owner("DELETE","/api/c/txns/s"),403);
  await ok(staff("GET","/api/txns/s/history"),403);
});

test("paid-on-release corrections and reversals update the linked payment in the same transaction",async t=>{
  const {owner,ok,sale,records}=await fixture(t);
  const s=await ok(owner("PUT","/api/c/txns/s",{data:sale({paidNow:{method:"Cash"}})}));
  await ok(owner("PATCH","/api/c/txns/"+s.data.paymentId,{data:{amount:10,correctionReason:"Invalid independent change"}},{"If-Match":"1"}),409);
  await ok(owner("PATCH","/api/c/txns/s",{data:{voided:true,voidReason:"Wrong release"}}));
  const rows=await records("txns");assert.ok(rows.every(r=>r.data.voided));
  assert.equal((await records("products"))[0].data.stock,10);
});

test("payment allocations handle advances, partial payments, returns, and exact cent rounding",()=>{
  const rows=[
    {id:"advance",data:{type:"payment",date:"2026-01-01",amount:20}},
    {id:"sale1",data:{type:"sale",date:"2026-01-02",amount:100.01,no:"DR-1"}},
    {id:"sale2",data:{type:"sale",date:"2026-01-03",amount:50,no:"DR-2"}},
    {id:"pay",data:{type:"payment",date:"2026-01-04",amount:100}},
    {id:"return",data:{type:"return",date:"2026-01-05",amount:10}},
  ];
  const out=allocations(rows,"2026-01-31");assert.equal(out.balance,20.01);
  assert.equal(out.byCredit.pay.lines[0].amount,80.01);assert.equal(out.byCredit.pay.lines[1].amount,19.99);
  assert.equal(out.sales[1].remaining,20.01);
  rows[3].data.voided=true;assert.equal(allocations(rows,"2026-01-31").sales[0].remaining,70.01);
});

test("period statements calculate opening and closing balances and enforce dealer privacy",async t=>{
  const {owner,portal,ok,payment}=await fixture(t);
  await ok(owner("PUT","/api/c/txns/open",{data:{type:"sale",opening:true,dealerId:"d",date:"2026-01-01",dueDate:"2026-01-30",amount:100}}));
  await ok(owner("PUT","/api/c/txns/pay",{data:payment({date:"2026-02-01",amount:30})}));
  const report=await ok(owner("GET","/api/dealers/d/statement?from=2026-02-01&to=2026-02-28"));
  assert.equal(report.opening,100);assert.equal(report.closing,70);assert.equal(report.entries.length,1);
  await ok(owner("GET","/api/dealers/d/statement?from=2026-02-30&to=2026-03-01"),400);
  await ok(owner("POST","/api/users",{name:"Dealer",username:"dealer",role:"dealer",dealerId:"d",password:"DealerPassword123!"}));
  await ok(portal("POST","/api/login",{username:"dealer",password:"DealerPassword123!"}));
  await ok(portal("GET","/api/dealers/d/statement"));await ok(portal("GET","/api/dealers/other/statement"),403);
  await ok(portal("GET","/api/txns/pay/allocations"));
});

test("owner approval is bound to one sale, requester, expiry and one consumption",async t=>{
  const {owner,staff,client,ok,sale,records,db}=await fixture(t);
  await ok(owner("PATCH","/api/c/dealers/d",{data:{creditLimit:10}}));
  const draft=sale();await ok(staff("PUT","/api/c/txns/blocked",{data:draft}),409);
  const request=await ok(staff("POST","/api/approvals",{sale:draft,reason:"Established dealer needs an exception"}));
  await ok(staff("POST",`/api/approvals/${request.id}/decision`,{status:"approved",reason:"No"}),403);
  await ok(owner("POST",`/api/approvals/${request.id}/decision`,{status:"approved",reason:"Approved after checking collection history"}));
  await ok(staff("PUT","/api/c/txns/changed",{data:{...draft,amount:300,items:[{productId:"p",qty:3,price:100}],approvalId:request.id}}),409);
  const saved=await ok(staff("PUT","/api/c/txns/s",{data:{...draft,approvalId:request.id}}));
  assert.equal(saved.data.override.reason,"Approved after checking collection history");
  await ok(staff("PUT","/api/c/txns/again",{data:{...draft,approvalId:request.id}}),409);
  assert.equal((await records("approvals"))[0].data.status,"consumed");
  const expired=await ok(staff("POST","/api/approvals",{sale:draft,reason:"Another request"}));
  await ok(owner("POST",`/api/approvals/${expired.id}/decision`,{status:"approved",reason:"Approved"}));
  db.prepare("UPDATE docs SET data=json_set(data,'$.expiresAt',0) WHERE collection='approvals' AND id=?").run(expired.id);
  await ok(staff("PUT","/api/c/txns/expired",{data:{...draft,approvalId:expired.id}}),409);
});

test("preparing orders reserve stock; cancellation releases it; release consumes it exactly once",async t=>{
  const {owner,ok,sale,records}=await fixture(t);
  const make=id=>owner("PUT","/api/c/orders/"+id,{data:{dealerId:"d",status:"new",items:[{productId:"p",qty:6}]}});
  await ok(make("a"));await ok(make("b"));
  await ok(owner("PATCH","/api/c/orders/a",{data:{status:"ready"}}),409);
  await ok(owner("PATCH","/api/c/orders/a",{data:{status:"preparing"}}));
  assert.equal((await records("products"))[0].data.availableStock,4);
  await ok(owner("PATCH","/api/c/orders/b",{data:{status:"preparing"}}),409);
  await ok(owner("PUT","/api/c/txns/unreserved",{data:sale({items:[{productId:"p",qty:5,price:100}],amount:500})}),409);
  const release=sale({orderId:"a",items:[{productId:"p",qty:6,price:100}],amount:600});
  await ok(owner("PUT","/api/c/txns/release",{data:release}));
  assert.equal((await records("orders")).find(r=>r.id==="a").data.status,"released");
  const p=(await records("products"))[0].data;assert.equal(p.stock,4);assert.equal(p.reserved,0);
  await ok(owner("PUT","/api/c/txns/release2",{data:release}),409);
  await ok(owner("PATCH","/api/c/orders/a",{data:{status:"cancelled"}}),409);
  await ok(owner("PUT","/api/c/orders/c",{data:{dealerId:"d",status:"new",items:[{productId:"p",qty:4}]}}));
  await ok(owner("PATCH","/api/c/orders/c",{data:{status:"preparing"}}));
  await ok(owner("PATCH","/api/c/orders/c",{data:{status:"cancelled",cancelReason:"Dealer changed plans"}}));
  assert.equal((await records("products"))[0].data.availableStock,4);
});

test("reconciliation detects stale totals and discrepancies, locks payments, and supports owner reopening",async t=>{
  const {owner,staff,ok,payment,records}=await fixture(t);
  await ok(owner("PUT","/api/c/txns/pay",{data:payment({amount:50})}));
  const counts=Object.fromEntries(METHODS.map(m=>[m,0]));counts.Cash=45;
  const input={from:today(),to:today(),counts};
  const first=await ok(owner("POST","/api/reconciliations/preview",input));
  assert.equal(first.totals.find(t=>t.method==="Cash").difference,-5);
  await ok(owner("POST","/api/reconciliations",{...input,fingerprint:first.fingerprint}),400);
  await ok(owner("PUT","/api/c/txns/pay2",{data:payment({amount:10})}));
  await ok(owner("POST","/api/reconciliations",{...input,fingerprint:first.fingerprint,note:"Cash shortage"}),409);
  const current=await ok(owner("POST","/api/reconciliations/preview",input));
  const closed=await ok(owner("POST","/api/reconciliations",{...input,fingerprint:current.fingerprint,note:"Cash shortage investigated"}));
  await ok(owner("PUT","/api/c/txns/late",{data:payment()}),409);
  await ok(owner("PATCH","/api/c/txns/pay",{data:{voided:true,voidReason:"Wrong payment"}}),409);
  await ok(staff("POST",`/api/reconciliations/${closed.id}/reopen`,{reason:"Correction needed"}),403);
  await ok(owner("POST",`/api/reconciliations/${closed.id}/reopen`,{reason:"Correction needed"}));
  await ok(owner("PATCH","/api/c/txns/pay",{data:{voided:true,voidReason:"Wrong payment"}}));
});

test("catalog imports validate duplicates, reject stale previews, and apply reviewed records atomically",async t=>{
  const {owner,ok,records,dir}=await fixture(t);
  await ok(owner("PATCH","/api/c/products/p",{data:{promo:{price:80,from:"2026-01-01",to:"2026-12-31",noDiscount:true}}}));
  await ok(owner("PATCH","/api/c/products/p",{data:{promo:{price:85}}}));
  assert.equal((await records("products"))[0].data.promo.noDiscount,true,"partial updates preserve nested catalog fields");
  const input={records:[{id:"p",data:{name:"Updated soap",stock:999,srp:150,dealerPrice:100,code:"SOAP"}},{id:"new",data:{name:"New product",stock:0,srp:50,dealerPrice:40,code:"NEW"}}]};
  const preview=await ok(owner("POST","/api/imports/preview",{kind:"catalog",input}));
  assert.equal(preview.counts.overwrite,1);assert.equal(preview.counts.create,1);assert.equal(preview.canApply,true);
  await ok(owner("PATCH","/api/c/products/p",{data:{name:"Concurrent edit"}}));
  await ok(owner("POST",`/api/imports/${preview.id}/confirm`,{}),409);
  assert.equal((await records("products")).length,1);
  const fresh=await ok(owner("POST","/api/imports/preview",{kind:"catalog",input}));
  const applied=await ok(owner("POST",`/api/imports/${fresh.id}/confirm`,{}));assert.equal(applied.count,2);assert.ok(fs.existsSync(path.join(dir,"backups",applied.safetyBackup)));
  const repeated=await ok(owner("POST",`/api/imports/${fresh.id}/confirm`,{}));assert.deepEqual(repeated,applied);
  assert.equal((await records("products")).find(r=>r.id==="p").data.stock,10,"catalog cannot overwrite stock");
  const duplicate=await ok(owner("POST","/api/imports/preview",{kind:"catalog",input:{records:[input.records[0],input.records[0]]}}));
  assert.equal(duplicate.canApply,false);await ok(owner("POST",`/api/imports/${duplicate.id}/confirm`,{}),400);
});

test("backup restore previews exact overwrites, validates references, preserves history, and saves a safety copy",async t=>{
  const {owner,staff,ok,dir,records,payment}=await fixture(t);
  await ok(owner("PUT","/api/c/txns/pay",{data:payment()}));
  const backup=await ok(owner("GET","/api/backup"));assert.equal(backup.version,3);assert.ok(backup.moves);
  await ok(staff("GET","/api/backup"),403);
  backup.products.p.name="Restored soap";
  const preview=await ok(owner("POST","/api/imports/preview",{kind:"backup",input:backup}));assert.ok(preview.records.some(r=>r.id==="p"&&r.before.name==="Soap"&&r.action==="overwrite"));
  const result=await ok(owner("POST",`/api/imports/${preview.id}/confirm`,{}));
  assert.ok(fs.existsSync(path.join(dir,"backups",result.safetyBackup)));
  assert.equal((await records("products"))[0].data.name,"Restored soap");
  assert.equal((await records("txns")).length,1);
  backup.txns.pay.dealerId="missing";
  const invalid=await ok(owner("POST","/api/imports/preview",{kind:"backup",input:backup}));assert.equal(invalid.canApply,false);
  await ok(owner("POST",`/api/imports/${invalid.id}/confirm`,{}),400);
});

test("stock count batches roll back every movement on stale counts or insufficient available stock",async t=>{
  const {owner,ok,records}=await fixture(t);
  await ok(owner("PUT","/api/c/products/p2",{data:{name:"Second product",stock:5,srp:20,dealerPrice:15}}));
  const body={records:[{id:"count1",data:{productId:"p",qty:2,expectedStock:10,reason:"Count",date:today()}},{id:"count2",data:{productId:"p2",qty:-6,expectedStock:5,reason:"Count",date:today()}}]};
  await ok(owner("POST","/api/moves/batch",body),409);
  assert.equal((await records("products")).find(p=>p.id==="p").data.stock,10);
  assert.ok(!(await records("moves")).some(r=>r.id==="count1"));
  body.records[1].data.qty=-1;
  const result=await ok(owner("POST","/api/moves/batch",body,{"Idempotency-Key":"stock-count-retry"}));assert.equal(result.length,2);
  await ok(owner("POST","/api/moves/batch",body,{"Idempotency-Key":"stock-count-retry"}));
  assert.equal((await records("products")).find(p=>p.id==="p").data.stock,12);
});

test("exported backups remain valid after linked payment corrections, reconciliation, and catalog changes",async t=>{
  const {owner,ok,sale,payment}=await fixture(t);
  await ok(owner("PUT","/api/c/txns/s",{data:sale({items:[{productId:"p",qty:1,price:100,pct:25}],amount:75,discount:0,discountPct:25,paidNow:{method:"Cash"}})}));
  await ok(owner("PATCH","/api/c/txns/s",{data:{note:"Corrected",correctionReason:"Missing delivery note"}}));
  await ok(owner("PATCH","/api/c/txns/s",{data:{voided:true,voidReason:"Wrong delivery"}}));
  await ok(owner("PUT","/api/c/txns/pay",{data:payment({amount:25})}));
  const input={from:today(),to:today(),counts:Object.fromEntries(METHODS.map(m=>[m,m==="Cash"?25:0]))};
  const report=await ok(owner("POST","/api/reconciliations/preview",input));
  await ok(owner("POST","/api/reconciliations",{...input,fingerprint:report.fingerprint}));
  const catalog=await ok(owner("POST","/api/imports/preview",{kind:"catalog",input:{records:[{id:"p",data:{name:"Updated soap",code:"SOAP",srp:120,stock:10,dealerPrice:90}},{data:{name:"New soap",code:"NEW",srp:50,stock:0,dealerPrice:37.5}}]}}));
  await ok(owner("POST",`/api/imports/${catalog.id}/confirm`,{}));
  const backup=await ok(owner("GET","/api/backup"));
  const preview=await ok(owner("POST","/api/imports/preview",{kind:"backup",input:backup}));
  assert.equal(preview.canApply,true,JSON.stringify(preview.errors));
});


test("command-line imports require review and confirmation and create a safety backup",t=>{
  const {spawnSync}=require("node:child_process"),Database=require("better-sqlite3");
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"ledger-cli-import-"));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const backup=path.join(dir,"backup.json");
  fs.writeFileSync(backup,JSON.stringify({app:"dealer-credit-ledger",version:3,products:{p:{name:"Imported soap",stock:10,srp:100,dealerPrice:75}},dealers:{},txns:{},moves:{},orders:{},settings:{}}));
  const options={env:{...process.env,DATA_DIR:dir},encoding:"utf8",timeout:60000};
  const preview=spawnSync(process.execPath,[path.join(__dirname,"../scripts/import-backup.js"),backup],options);
  assert.equal(preview.status,0,preview.error?.message||preview.stderr);assert.match(preview.stdout,/Nothing imported yet/);
  const token=preview.stdout.match(/--confirm ([a-f0-9-]+)/)[1];
  const before=new Database(path.join(dir,"ledger.db"),{readonly:true});assert.equal(before.prepare("SELECT count(*) n FROM docs").get().n,0);before.close();
  const confirmed=spawnSync(process.execPath,[path.join(__dirname,"../scripts/import-backup.js"),"--confirm",token],options);
  assert.equal(confirmed.status,0,confirmed.error?.message||confirmed.stderr);assert.match(confirmed.stdout,/Imported 1 records/);
  assert.ok(fs.readdirSync(path.join(dir,"backups")).some(f=>f.startsWith("before-import-")));
});

test("receipts track suppliers and costs; sales preserve authoritative cost snapshots across price changes",async t=>{
  const {owner,staff,ok,sale,records}=await fixture(t);
  const receipt=await ok(staff("PUT","/api/c/moves/receipt",{data:{productId:"p",qty:5,date:today(),reason:"Received stock",supplier:"Main supplier",deliveryRef:"INV-123",unitCost:42.5}}));
  assert.equal(receipt.data.supplier,"Main supplier");assert.equal(receipt.data.deliveryRef,"INV-123");
  let product=(await records("products"))[0];assert.equal(product.data.stock,15);assert.equal(product.data.purchaseCost,42.5);
  const original=await ok(staff("PUT","/api/c/txns/cost-sale",{data:sale({items:[{productId:"p",qty:2,price:100,unitCost:0}]})}));
  assert.equal(original.data.items[0].unitCost,40.833333,"client cannot fake a profit cost");
  await ok(owner("PATCH","/api/c/products/p",{data:{purchaseCost:60}}));
  const corrected=await ok(staff("PATCH","/api/c/txns/cost-sale",{data:{note:"corrected",correctionReason:"Fixed note"}}));
  assert.equal(corrected.data.items[0].unitCost,40.833333,"later product costs do not change old sales");
  const newer=await ok(staff("PUT","/api/c/txns/cost-sale-2",{data:sale()}));assert.equal(newer.data.items[0].unitCost,40.833333);
  await ok(owner("PUT","/api/c/moves/bad-cost",{data:{productId:"p",qty:5,date:today(),reason:"Received stock",unitCost:-1}}),400);
  product=(await records("products"))[0];assert.equal(product.data.stock,11,"invalid receipt rolls back stock");assert.equal(product.data.purchaseCost,60);
  await ok(staff("PATCH","/api/c/products/p",{data:{purchaseCost:1}}));assert.equal((await records("products"))[0].data.purchaseCost,60,"staff cannot override product cost outside a receipt");
  await ok(owner("PUT","/api/c/products/unknown",{data:{name:"Unknown cost",stock:1,dealerPrice:100}}));
  const unknown=await ok(owner("PUT","/api/c/txns/unknown-sale",{data:sale({items:[{productId:"unknown",qty:1,price:100}],amount:100})}));assert.equal(unknown.data.items[0].unitCost,null);
});

test("server backup status reports real files, overdue state, failures and recovery; staff cannot run backups",async t=>{
  const f=await fixture(t),{owner,staff,ok,dir}=f;
  let state=await ok(owner("GET","/api/backup/status"));assert.equal(state.lastSuccess,null);assert.equal(state.overdue,true);
  await ok(staff("GET","/api/backup/status"),403);await ok(staff("POST","/api/backup/run",{}),403);
  state=await ok(owner("POST","/api/backup/run",{}));assert.equal(state.overdue,false);assert.equal(state.running,false);assert.ok(state.size>0);assert.ok(fs.existsSync(path.join(dir,"backups",state.file)));
  const before=new Date(Date.now()-27*3600e3);fs.utimesSync(path.join(dir,"backups",state.file),before,before);
  assert.equal((await ok(owner("GET","/api/backup/status"))).overdue,true);
  const restarted=createApp({dataDir:dir,logger:{error(){}}});const server=restarted.app.listen(0);await new Promise(r=>server.once("listening",r));
  t.after(()=>{server.closeAllConnections();server.close();restarted.close();});
  const restartBase=`http://127.0.0.1:${server.address().port}`;
  const r=await fetch(restartBase+"/api/backup/status");assert.equal(r.status,401);
  const login=await fetch(restartBase+"/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:"owner",password:"OwnerPassword123!"})});
  const persisted=await (await fetch(restartBase+"/api/backup/status",{headers:{Cookie:login.headers.get("set-cookie").split(";")[0]}})).json();
  assert.equal(persisted.file,state.file);assert.equal(persisted.overdue,true,"backup status survives a restart");
  // A storage failure must be visible and clear on the next successful backup.
  const original=f.db.backup;f.db.backup=async()=>{throw new Error("disk full");};
  await ok(owner("POST","/api/backup/run",{}),500);
  assert.ok((await ok(owner("GET","/api/backup/status"))).lastError);
  f.db.backup=original;await ok(owner("POST","/api/backup/run",{}));
  assert.equal((await ok(owner("GET","/api/backup/status"))).lastError,null);
});

test("purchase orders receive partial deliveries atomically, prevent duplicate receipts, and track supplier bills",async t=>{
  const {owner,staff,ok,records}=await fixture(t);
  const purchase={supplier:"Main supplier",date:today(),expectedDate:today(),items:[{productId:"p",qty:10,unitCost:60}]};
  let po=await ok(owner("PUT","/api/c/purchases/po",{data:purchase}));assert.equal(po.data.no,"PO-00001");assert.equal(po.data.items[0].receivedQty,0);
  await ok(owner("PUT","/api/c/purchases/bad",{data:{...purchase,items:[{productId:"p",qty:2,unitCost:""}]}}),400);
  const receipt={version:po.version,date:today(),deliveryRef:"PART-1",items:[{productId:"p",qty:4}]},headers={"Idempotency-Key":"purchase-receipt-one"};
  po=await ok(staff("POST","/api/purchases/po/receive",receipt,headers));assert.equal(po.data.status,"partial");assert.equal(po.data.items[0].receivedQty,4);
  assert.deepEqual(await ok(staff("POST","/api/purchases/po/receive",receipt,headers)),po,"lost response retry must replay once");
  let product=(await records("products"))[0].data;assert.equal(product.stock,14);assert.equal(product.inventoryValue,640);assert.equal(product.averageCost,45.714286);
  await ok(owner("POST","/api/purchases/po/receive",{...receipt,version:po.version}),409);
  await ok(owner("POST","/api/purchases/po/receive",{...receipt,version:po.version,deliveryRef:"TOO-MUCH",items:[{productId:"p",qty:7}]}),400);
  assert.equal((await records("products"))[0].data.stock,14);
  await ok(staff("POST","/api/purchases/po/payments",{version:po.version,date:today(),amount:100,method:"Cash"}),403);
  await ok(owner("POST","/api/purchases/po/payments",{version:po.version,date:today(),amount:241,method:"Cash"}),400);
  po=await ok(owner("POST","/api/purchases/po/payments",{version:po.version,date:today(),amount:100,method:"Cash",reference:"PAY-1"}));assert.equal(po.data.payments[0].amount,100);
  po=await ok(owner("POST",`/api/purchases/po/payments/${po.data.payments[0].id}/void`,{version:po.version,reason:"Wrong channel"}));assert.equal(po.data.payments[0].voided,true);
  // Refresh the document version cached by this API client before generic cancellation.
  await records("purchases");po=await ok(owner("PATCH","/api/c/purchases/po",{data:{status:"cancelled",correctionReason:"Supplier cannot fulfill balance"}}));
  assert.equal(po.data.items[0].receivedQty,4);assert.equal(po.data.status,"cancelled");
  await ok(owner("POST","/api/purchases/po/receive",{...receipt,version:po.version,deliveryRef:"LATE"}),409);
  await ok(owner("DELETE","/api/c/purchases/po"),403);
  const movement=(await records("moves")).find(r=>r.data.purchaseId==="po");
  await ok(owner("PATCH","/api/c/moves/"+movement.id,{data:{qty:99,correctionReason:"Tamper"}}),409);
});

test("weighted average costs and linked returns preserve original sale cost and cap returned quantities",async t=>{
  const {owner,ok,sale,records}=await fixture(t);
  const first=await ok(owner("PUT","/api/c/txns/sale-cost",{data:sale()}));assert.equal(first.data.items[0].unitCost,40);
  await ok(owner("PUT","/api/c/moves/receipt-cost",{data:{productId:"p",qty:8,unitCost:60,reason:"Received stock",date:today()}}));
  let p=(await records("products"))[0].data;assert.equal(p.stock,16);assert.equal(p.inventoryValue,800);assert.equal(p.averageCost,50);
  const newer=await ok(owner("PUT","/api/c/txns/new-cost",{data:sale()}));assert.equal(newer.data.items[0].unitCost,50);
  const returned={type:"return",dealerId:"d",date:today(),originalSaleId:"sale-cost",restock:true,amount:100,items:[{productId:"p",qty:1,price:100,unitCost:1}]};
  const back=await ok(owner("PUT","/api/c/txns/linked-return",{data:returned}));assert.equal(back.data.items[0].unitCost,40);
  p=(await records("products"))[0].data;assert.equal(p.stock,15);assert.equal(p.inventoryValue,740);assert.equal(p.averageCost,49.333333);
  await ok(owner("PUT","/api/c/txns/excess-return",{data:{...returned,items:[{productId:"p",qty:2,price:100}],amount:200}}),409);
  await ok(owner("PATCH","/api/c/txns/sale-cost",{data:{voided:true,voidReason:"Cannot void linked sale"}}),409);
  await ok(owner("PATCH","/api/c/txns/linked-return",{data:{originalSaleId:null,correctionReason:"Remove link"}}),409);
  await ok(owner("PATCH","/api/c/txns/linked-return",{data:{voided:true,voidReason:"Return reversed"}}));
  assert.equal((await records("products"))[0].data.inventoryValue,700);
});

test("unknown opening inventory costs stay unknown until an owner establishes a cost basis",async t=>{
  const {owner,ok,sale,records}=await fixture(t);
  await ok(owner("PUT","/api/c/products/unknown",{data:{name:"Uncosted",stock:5,dealerPrice:100}}));
  await ok(owner("PUT","/api/c/moves/unknown-receipt",{data:{productId:"unknown",qty:5,unitCost:60,reason:"Received stock",date:today()}}));
  let p=(await records("products")).find(r=>r.id==="unknown").data;assert.equal(p.inventoryValue,null);assert.equal(p.averageCost,null);
  await ok(owner("PATCH","/api/c/products/unknown",{data:{name:"Renamed uncosted",purchaseCost:60}}));
  assert.equal((await records("products")).find(r=>r.id==="unknown").data.inventoryValue,null,"editing a name must not invent the opening stock value");
  const unknown=await ok(owner("PUT","/api/c/txns/unknown",{data:sale({items:[{productId:"unknown",qty:1,price:100}],amount:100})}));assert.equal(unknown.data.items[0].unitCost,null);
  await ok(owner("PATCH","/api/c/products/unknown",{data:{purchaseCost:50}}));
  p=(await records("products")).find(r=>r.id==="unknown").data;assert.equal(p.inventoryValue,450);assert.equal(p.averageCost,50);
  assert.equal((await records("txns")).find(r=>r.id==="unknown").data.items[0].unitCost,null,"establishing inventory costs does not invent historic sale costs");
});

test("expenses have versioned corrections and voids, cannot be deleted, and are included in backup restores",async t=>{
  const {owner,staff,ok,records}=await fixture(t);
  const expense={date:today(),category:"Transport",amount:125,method:"Cash",payee:"Courier",note:"Delivery fare"};
  const saved=await ok(staff("PUT","/api/c/expenses/fare",{data:expense}));assert.equal(saved.data.createdBy,(await ok(staff("GET","/api/me"))).id);
  await ok(staff("PATCH","/api/c/expenses/fare",{data:{amount:100,correctionReason:"Wrong amount"}}),403);
  await records("expenses");await ok(owner("PATCH","/api/c/expenses/fare",{data:{amount:100}}),400);
  await ok(owner("PATCH","/api/c/expenses/fare",{data:{amount:100,correctionReason:"Receipt correction"}}));
  const revised=await records("revisions");assert.ok(revised.some(r=>r.data.collection==="expenses"&&r.data.before.amount===125));
  await ok(owner("DELETE","/api/c/expenses/fare"),403);
  await ok(owner("PATCH","/api/c/expenses/fare",{data:{voided:true,correctionReason:"Duplicate expense"}}));
  const backup=await ok(owner("GET","/api/backup"));assert.ok(backup.expenses.fare.voided);assert.ok(backup.purchases);
  const preview=await ok(owner("POST","/api/imports/preview",{kind:"backup",input:backup}));assert.deepEqual(preview.errors,[]);
});

test("full backup recovery restores database and photos in isolation and detects corrupted photos",async t=>{
  const {owner,staff,ok,db,dir,records}=await fixture(t);
  // Insert a tiny indexed file; recovery validates bytes, hashes, references and database integrity.
  const bytes=Buffer.from("photo-backup-content");fs.writeFileSync(path.join(dir,"uploads","recoveryphoto"),bytes);
  db.prepare("INSERT INTO assets VALUES (?,?,?,?,?)").run("recoveryphoto","image/png",bytes.length,"owner",Date.now());
  await ok(owner("PATCH","/api/c/products/p",{data:{imageId:"recoveryphoto"}}));
  await ok(owner("POST","/api/backup/run",{}));
  const before=db.prepare("SELECT data FROM docs WHERE collection='products' AND id='p'").get().data;
  const check=await ok(owner("POST","/api/backup/verify",{}));assert.equal(check.ok,true);assert.equal(check.photos,1);assert.ok(check.records>0);
  assert.equal(db.prepare("SELECT data FROM docs WHERE collection='products' AND id='p'").get().data,before,"recovery check never overwrites live records");
  await ok(staff("POST","/api/backup/verify",{}),403);
  const status=await ok(owner("GET","/api/backup/status"));assert.equal(status.includesPhotos,true);assert.equal(status.recovery.ok,true);
  const manifest=JSON.parse(fs.readFileSync(path.join(dir,"backups",status.file+".manifest.json"),"utf8"));
  fs.writeFileSync(path.join(dir,"backups",manifest.photoDir,"recoveryphoto"),"damaged");
  const broken=await ok(owner("POST","/api/backup/verify",{}));assert.equal(broken.ok,false);assert.match(broken.errors.join(" "),/photo/);
  assert.equal(fs.readFileSync(path.join(dir,"uploads","recoveryphoto"),"utf8"),bytes.toString());
  await ok(owner("POST","/api/backup/run",{}));assert.equal((await ok(owner("POST","/api/backup/verify",{}))).ok,true);
});

test("supplier returns credit received bills, use inventory carrying cost, and allow actual refunds without double-counting stock",async t=>{
  const {owner,ok,records}=await fixture(t);
  let p=await ok(owner("PUT","/api/c/purchases/credit-po",{data:{supplier:"Supplier",date:today(),expectedDate:today(),items:[{productId:"p",qty:4,unitCost:60}]}}));
  p=await ok(owner("POST","/api/purchases/credit-po/receive",{version:p.version,date:today(),deliveryRef:"DELIVERY",items:[{productId:"p",qty:4}]}));
  p=await ok(owner("POST","/api/purchases/credit-po/payments",{version:p.version,date:today(),amount:240,method:"Cash"}));
  const body={version:p.version,date:today(),reference:"CREDIT-1",reason:"Supplier accepted damaged goods",items:[{productId:"p",qty:2}]},headers={"Idempotency-Key":"supplier-return-retry"};
  p=await ok(owner("POST","/api/purchases/credit-po/returns",body,headers));assert.equal(p.data.returns[0].creditAmount,120);assert.equal(p.data.returns[0].stockCost,91.43);assert.equal(p.data.returns[0].variance,28.57);
  assert.deepEqual(await ok(owner("POST","/api/purchases/credit-po/returns",body,headers)),p);
  assert.equal((await records("products"))[0].data.stock,12);
  await ok(owner("POST","/api/purchases/credit-po/returns",{...body,version:p.version,reference:"TOO-MUCH",items:[{productId:"p",qty:3}]}),400);
  p=await ok(owner("POST","/api/purchases/credit-po/refunds",{version:p.version,date:today(),amount:100,method:"Cash",reference:"REFUND"}));
  await ok(owner("POST","/api/purchases/credit-po/refunds",{version:p.version,date:today(),amount:21,method:"Cash"}),400);
  await ok(owner("POST",`/api/purchases/credit-po/payments/${p.data.payments[0].id}/void`,{version:p.version,reason:"Cannot remove payment while refunded"}),409);
  p=await ok(owner("POST",`/api/purchases/credit-po/refunds/${p.data.refunds[0].id}/void`,{version:p.version,reason:"Wrong refund method"}));
  p=await ok(owner("POST",`/api/purchases/credit-po/returns/${p.data.returns[0].id}/void`,{version:p.version,reason:"Goods retained"}));
  assert.equal(p.data.returns[0].voided,true);assert.equal((await records("products"))[0].data.stock,14);
  const backup=await ok(owner("GET","/api/backup"));assert.deepEqual((await ok(owner("POST","/api/imports/preview",{kind:"backup",input:backup}))).errors,[]);
});

test("manual invoice allocation changes overdue balances and refuses stale, over-allocated or cross-dealer invoices",async t=>{
  const {owner,ok,sale,payment,records}=await fixture(t);
  const oldDate=new Date(Date.now()-5*864e5).toISOString().slice(0,10);
  await ok(owner("PUT","/api/c/txns/old-invoice",{data:sale({date:oldDate,dueDate:oldDate,items:[{productId:"p",qty:1,price:100}],amount:100})}));
  await ok(owner("PUT","/api/c/txns/new-invoice",{data:sale({items:[{productId:"p",qty:1,price:100}],amount:100})}));
  const data=payment({amount:100,allocationMode:"manual",invoiceAllocations:[{saleId:"new-invoice",amount:100}]});
  const paid=await ok(owner("PUT","/api/c/txns/selected-payment",{data}));assert.equal(paid.data.applied[0].id,"new-invoice");
  let statement=await ok(owner("GET",`/api/dealers/d/statement?from=${oldDate}&to=${today()}`));assert.equal(statement.allocations.sales.find(s=>s.id==="old-invoice").remaining,100);
  const status=require("../lib/credit").dealerStatus((await records("txns")).map(r=>({...r.data,_ledgerId:r.id})));assert.equal(status.overdue,100);
  await ok(owner("PUT","/api/c/txns/excess-allocation",{data}),409);
  await ok(owner("PUT","/api/c/txns/cross-allocation",{data:{...data,dealerId:"other"}}),409);
  await ok(owner("PATCH","/api/c/txns/new-invoice",{data:{voided:true,voidReason:"Cannot void allocated invoice"}}),409);
  await ok(owner("PATCH","/api/c/txns/selected-payment",{data:{invoiceAllocations:[{saleId:"old-invoice",amount:100}],correctionReason:"Dealer specified older invoice"}}));
  statement=await ok(owner("GET",`/api/dealers/d/statement?from=${oldDate}&to=${today()}`));assert.equal(statement.allocations.sales.find(s=>s.id==="new-invoice").remaining,100);
});

test("large expenses, purchases, and stock changes require bound owner approvals and post once under the requester",async t=>{
  const {owner,staff,ok,records}=await fixture(t);
  await ok(owner("PUT","/api/c/settings/store",{data:{approvalExpenseLimit:100,approvalPurchaseLimit:100,approvalStockLimit:30}}));
  const expense={date:today(),category:"Transport",amount:150,method:"Cash",note:"Truck fare"};
  const rejected=await ok(staff("PUT","/api/c/expenses/approved-expense",{data:expense}),409);assert.equal(rejected.code,"approval_required");
  assert.equal((await records("expenses")).length,0);
  const request=await ok(staff("POST","/api/authorizations",{collection:"expenses",id:"approved-expense",data:expense,reason:"Truck delivery needed"}));
  await ok(staff("POST",`/api/authorizations/${request.id}/decision`,{status:"approved",reason:"Cannot self approve"}),403);
  const decision={status:"approved",reason:"Reviewed receipt"},headers={"Idempotency-Key":"owner-decision-retry"};
  const approved=await ok(owner("POST",`/api/authorizations/${request.id}/decision`,decision,headers));assert.equal(approved.request.data.status,"consumed");
  assert.equal(approved.posted.data.createdBy,(await ok(staff("GET","/api/me"))).id);
  assert.deepEqual(await ok(owner("POST",`/api/authorizations/${request.id}/decision`,decision,headers)),approved);assert.equal((await records("expenses")).length,1);
  await ok(staff("PUT","/api/c/expenses/another",{data:{...expense,authorizationId:request.id}}),409);
  await ok(staff("PUT","/api/c/purchases/large",{data:{supplier:"Supplier",date:today(),expectedDate:today(),items:[{productId:"p",qty:5,unitCost:40}]}}),409);
  const purchaseData={supplier:"Supplier",date:today(),expectedDate:today(),items:[{productId:"p",qty:5,unitCost:40}]};
  const purchaseRequest=await ok(staff("POST","/api/authorizations",{collection:"purchases",id:"approved-po",data:purchaseData,reason:"Replenishment"}));
  const approvedPurchase=await ok(owner("POST",`/api/authorizations/${purchaseRequest.id}/decision`,{status:"approved",reason:"Budget confirmed"}));assert.equal(approvedPurchase.posted.data.status,"open");
  const stock={productId:"p",qty:-1,expectedStock:10,date:today(),reason:"Stock count"};
  const stockRequest=await ok(staff("POST","/api/authorizations",{collection:"moves",id:"large-stock",data:stock,reason:"Count shortage"}));
  await ok(owner("PUT","/api/c/moves/owner-change",{data:{productId:"p",qty:-1,date:today(),reason:"Damaged stock"}}));
  await ok(owner("POST",`/api/authorizations/${stockRequest.id}/decision`,{status:"approved",reason:"Stock changed meanwhile"}),409);
  assert.equal((await records("authorizations")).find(a=>a.id===stockRequest.id).data.status,"pending");assert.equal((await records("products"))[0].data.stock,9);
});

test("stock count approval evaluates the whole batch and posts it atomically",async t=>{
  const {owner,staff,ok,records}=await fixture(t);
  await ok(owner("PUT","/api/c/products/p2",{data:{name:"Second",stock:10,purchaseCost:40,dealerPrice:100}}));
  await ok(owner("PUT","/api/c/settings/store",{data:{approvalStockLimit:60}}));
  const recordsToPost=[{id:"batch-a",data:{productId:"p",qty:-1,date:today(),expectedStock:10,reason:"Stock count"}},{id:"batch-b",data:{productId:"p2",qty:-1,date:today(),expectedStock:10,reason:"Stock count"}}];
  await ok(staff("POST","/api/moves/batch",{batchId:"reviewed-batch",records:recordsToPost}),409);assert.ok((await records("products")).every(p=>p.data.stock===10));
  const request=await ok(staff("POST","/api/authorizations",{collection:"stockBatch",id:"reviewed-batch",data:{records:recordsToPost},reason:"Monthly count"}));
  await ok(owner("POST",`/api/authorizations/${request.id}/decision`,{status:"approved",reason:"Count verified"}));assert.ok((await records("products")).every(p=>p.data.stock===9));
});

test("daily closing includes supplier cash flows, detects stale previews, and locks financial mutations until owner reopening",async t=>{
  const {owner,staff,ok,sale,records}=await fixture(t),opening=Object.fromEntries(METHODS.map(m=>[m,m==="Cash"?100:0]));
  await ok(owner("PUT","/api/c/txns/day-sale",{data:sale({paidNow:{method:"Cash"}})}));
  await ok(owner("PUT","/api/c/expenses/day-expense",{data:{date:today(),category:"Transport",amount:20,method:"Cash"}}));
  let po=await ok(owner("PUT","/api/c/purchases/day-po",{data:{supplier:"Supplier",date:today(),expectedDate:today(),items:[{productId:"p",qty:1,unitCost:40}]}}));
  po=await ok(owner("POST","/api/purchases/day-po/receive",{version:po.version,date:today(),deliveryRef:"DAY",items:[{productId:"p",qty:1}]}));
  po=await ok(owner("POST","/api/purchases/day-po/payments",{version:po.version,date:today(),amount:40,method:"Cash"}));
  po=await ok(owner("POST","/api/purchases/day-po/returns",{version:po.version,date:today(),reference:"DAY-CREDIT",reason:"Unused item",items:[{productId:"p",qty:1}]}));
  po=await ok(owner("POST","/api/purchases/day-po/refunds",{version:po.version,date:today(),amount:10,method:"Cash"}));
  let preview=await ok(owner("POST","/api/daily-closing/preview",{date:today(),opening}));assert.equal(preview.channels.find(c=>c.method==="Cash").expected,250);
  await ok(owner("PUT","/api/c/expenses/late-expense",{data:{date:today(),category:"Supplies",amount:1,method:"Cash"}}));
  const counted=Object.fromEntries(METHODS.map(m=>[m,m==="Cash"?249:0]));
  await ok(owner("POST","/api/daily-closing/close",{date:today(),opening,counted,fingerprint:preview.fingerprint}),409);
  preview=await ok(owner("POST","/api/daily-closing/preview",{date:today(),opening}));
  const closed=await ok(owner("POST","/api/daily-closing/close",{date:today(),opening,counted,fingerprint:preview.fingerprint}));assert.equal(closed.data.status,"closed");
  await ok(owner("PUT","/api/c/expenses/closed-expense",{data:{date:today(),category:"Rent",amount:5,method:"Cash"}}),409);
  await ok(owner("PATCH","/api/c/txns/day-sale",{data:{note:"Correction",correctionReason:"Closed day"}}),409);
  await ok(owner("POST",`/api/purchases/day-po/refunds/${po.data.refunds[0].id}/void`,{version:po.version,reason:"Closed"}),409);
  const snapshot=await ok(owner("GET","/api/backup"));snapshot.expenses["day-expense"].note="Import may not bypass a closed day";
  const importPreview=await ok(owner("POST","/api/imports/preview",{kind:"backup",input:snapshot}));
  await ok(owner("POST",`/api/imports/${importPreview.id}/confirm`,{}),409);
  await ok(staff("POST",`/api/daily-closing/${closed.id}/reopen`,{reason:"Staff cannot reopen"}),403);
  await ok(owner("POST",`/api/daily-closing/${closed.id}/reopen`,{reason:"Late receipt"}));
  await ok(owner("PUT","/api/c/expenses/reopened",{data:{date:today(),category:"Rent",amount:5,method:"Cash"}}));
});

test("complete backup download contains a recoverable database, manifest, photos, and restore notes",async t=>{
  const {owner,staff,ok,base,db,dir}=await fixture(t);
  const bytes=Buffer.from("archive-photo-bytes");fs.writeFileSync(path.join(dir,"uploads","archivephoto"),bytes);db.prepare("INSERT INTO assets VALUES (?,?,?,?,?)").run("archivephoto","image/png",bytes.length,"owner",Date.now());
  await ok(owner("PATCH","/api/c/products/p",{data:{imageId:"archivephoto"}}));
  await ok(staff("GET","/api/backup/download"),403);
  const login=await fetch(base+"/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:"owner",password:"OwnerPassword123!"})});
  const response=await fetch(base+"/api/backup/download",{headers:{Cookie:login.headers.get("set-cookie").split(";")[0]}});assert.equal(response.status,200);assert.match(response.headers.get("content-disposition"),/tar.gz/);
  const tar=require("node:zlib").gunzipSync(Buffer.from(await response.arrayBuffer())),files=new Map();let offset=0;
  const str=(buffer,start,len)=>buffer.subarray(start,start+len).toString().replace(/\0.*$/s,"");
  while(offset+512<=tar.length&&tar[offset]){const h=tar.subarray(offset,offset+512),baseName=str(h,0,100),prefix=str(h,345,155),name=prefix?prefix+"/"+baseName:baseName,size=parseInt(str(h,124,12),8);offset+=512;files.set(name,tar.subarray(offset,offset+size));offset+=Math.ceil(size/512)*512;}
  assert.ok([...files.keys()].some(name=>name.endsWith(".db")));assert.ok(files.has("RESTORE.txt"));assert.ok([...files].some(([name,data])=>name.endsWith("/archivephoto")&&data.equals(bytes)));
  const manifest=JSON.parse([...files].find(([name])=>name.endsWith(".manifest.json"))[1].toString());assert.equal(manifest.photos.length,1);assert.ok([...files.values()].some(data=>data.subarray(0,15).toString()==="SQLite format 3"));
});

test("dealer profiles validate structured names, age, gender and nationality while retaining legacy names",async t=>{
  const {owner,ok,records}=await fixture(t);
  const profile={firstName:"  Maria ",middleName:"Reyes",lastName:"Santos",age:32,gender:"Female",nationality:"Filipino",creditLimit:5000};
  let saved=await ok(owner("PUT","/api/c/dealers/profile",{data:profile}));assert.equal(saved.data.name,"Maria Reyes Santos");assert.equal(saved.data.firstName,"Maria");assert.equal(saved.data.age,32);
  saved=await ok(owner("PATCH","/api/c/dealers/profile",{data:{middleName:"",age:null}}));assert.equal(saved.data.name,"Maria Santos");assert.equal(saved.data.age,null);
  await ok(owner("PATCH","/api/c/dealers/profile",{data:{age:32.5}}),400);await ok(owner("PATCH","/api/c/dealers/profile",{data:{age:-1}}),400);await ok(owner("PATCH","/api/c/dealers/profile",{data:{lastName:""}}),400);
  await ok(owner("PATCH","/api/c/dealers/d",{data:{age:45,gender:"Male",nationality:"Filipino"}}));assert.equal((await records("dealers")).find(d=>d.id==="d").data.name,"Dealer");
  const backup=await ok(owner("GET","/api/backup"));assert.equal(backup.dealers.profile.firstName,"Maria");assert.deepEqual((await ok(owner("POST","/api/imports/preview",{kind:"backup",input:backup}))).errors,[]);
});


test("editors cannot change owner approval limits or restore backups that bypass them",async t=>{
  const {owner,client,ok}=await fixture(t),editor=client();
  await ok(owner("POST","/api/users",{name:"Editor",username:"editor",password:"EditorPassword123!",role:"editor"}));await ok(editor("POST","/api/login",{username:"editor",password:"EditorPassword123!"}));
  await ok(editor("PUT","/api/c/settings/store",{data:{approvalExpenseLimit:0}}),403);
  const backup=await ok(editor("GET","/api/backup"));await ok(editor("POST","/api/imports/preview",{kind:"backup",input:backup}),403);
});

async function sessionCookie(base,username="owner",password="OwnerPassword123!"){
  const response=await fetch(base+"/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username,password})});assert.equal(response.status,200);return response.headers.get("set-cookie").split(";")[0];
}

test("supplier directory links purchase terms, preserves renamed identities, and archives without deleting history",async t=>{
  const {owner,staff,ok,records}=await fixture(t);
  let supplier=await ok(owner("PUT","/api/c/suppliers/vendor",{data:{name:"Vendor One",contactPerson:"Anna",phone:"09123456789",email:"anna@example.com",paymentTerms:30,address:"Manila"}}));
  await ok(owner("PUT","/api/c/suppliers/duplicate",{data:{name:"vendor one",paymentTerms:0}}),409);
  let po=await ok(owner("PUT","/api/c/purchases/directory-po",{data:{supplier:"Vendor One",supplierId:"vendor",date:today(),expectedDate:today(),items:[{productId:"p",qty:2,unitCost:40}]}}));assert.equal(po.data.supplierId,"vendor");assert.equal(po.data.paymentTerms,30);
  po=await ok(owner("POST","/api/purchases/directory-po/receive",{version:po.version,date:today(),deliveryRef:"DIR",items:[{productId:"p",qty:2,batchCode:"DIR-LOT",expiryDate:"2099-12-31"}]}));assert.ok(po.data.dueDate>today());
  supplier=await ok(owner("PATCH","/api/c/suppliers/vendor",{data:{name:"Vendor Renamed",active:false}}));assert.ok(supplier.data.aliases.includes("Vendor One"));
  await ok(owner("PUT","/api/c/purchases/archived-vendor",{data:{supplier:"Vendor Renamed",supplierId:"vendor",date:today(),expectedDate:today(),items:[{productId:"p",qty:1,unitCost:40}]}}),400);
  await ok(staff("PATCH","/api/c/suppliers/vendor",{data:{phone:"Changed"}}),403);await ok(owner("DELETE","/api/c/suppliers/vendor"),403);
  assert.ok((await records("batches")).some(b=>b.data.code==="DIR-LOT"&&b.data.purchaseId==="directory-po"));
});

test("supplier credit applications transfer only available same-supplier credit and cannot be spent again as cash",async t=>{
  const {owner,ok,records}=await fixture(t);
  await ok(owner("PUT","/api/c/suppliers/vendor",{data:{name:"Vendor",paymentTerms:15}}));
  const order={supplier:"Vendor",supplierId:"vendor",date:today(),expectedDate:today(),items:[{productId:"p",qty:2,unitCost:40}]};
  let source=await ok(owner("PUT","/api/c/purchases/source-credit",{data:order}));source=await ok(owner("POST","/api/purchases/source-credit/receive",{version:source.version,date:today(),deliveryRef:"SOURCE",items:[{productId:"p",qty:2}]}));source=await ok(owner("POST","/api/purchases/source-credit/payments",{version:source.version,date:today(),amount:80,method:"Cash"}));source=await ok(owner("POST","/api/purchases/source-credit/returns",{version:source.version,date:today(),reference:"SRC-CREDIT",reason:"Goods returned",items:[{productId:"p",qty:1}]}));
  let target=await ok(owner("PUT","/api/c/purchases/target-bill",{data:order}));target=await ok(owner("POST","/api/purchases/target-bill/receive",{version:target.version,date:today(),deliveryRef:"TARGET",items:[{productId:"p",qty:2}]}));
  const body={sourceId:source.id,targetId:target.id,sourceVersion:source.version,targetVersion:target.version,date:today(),amount:30},headers={"Idempotency-Key":"apply-vendor-credit-once"};
  const applied=await ok(owner("POST","/api/supplier-applications",body,headers));assert.deepEqual(await ok(owner("POST","/api/supplier-applications",body,headers)),applied);
  const math=require("../lib/extensions");let purchases=await records("purchases");source=purchases.find(p=>p.id==="source-credit");target=purchases.find(p=>p.id==="target-bill");assert.equal(math.supplierPaid(source.data)-math.supplierBill(source.data),10);assert.equal(math.supplierBill(target.data)-math.supplierPaid(target.data),50);
  await ok(owner("POST","/api/purchases/source-credit/refunds",{version:source.version,date:today(),amount:11,method:"Cash"}),400);
  await ok(owner("POST","/api/supplier-applications",{...body,sourceVersion:source.version,targetVersion:target.version,amount:11}),400);
  await ok(owner("POST","/api/supplier-applications/"+applied.id+"/void",{version:applied.version,sourceVersion:source.version,targetVersion:target.version,reason:"Apply against another invoice"}));
  purchases=await records("purchases");source=purchases.find(p=>p.id==="source-credit");assert.equal(math.supplierPaid(source.data)-math.supplierBill(source.data),40);
});

test("batch tracking selects earliest expiry, rejects expired stock sales, and reverses allocations atomically",async t=>{
  const {owner,ok,sale,records}=await fixture(t);
  await ok(owner("PUT","/api/c/products/expiry",{data:{name:"Expiry item",stock:0,dealerPrice:20,purchaseCost:10}}));
  const day=n=>new Date(Date.now()+n*864e5).toISOString().slice(0,10);
  for(const [id,qty,expiry] of [["LATE",3,day(20)],["EARLY",2,day(5)],["EXPIRED",4,day(-1)]])await ok(owner("PUT","/api/c/moves/lot-"+id,{data:{productId:"expiry",qty,unitCost:10,reason:"Received stock",date:today(),batchCode:id,expiryDate:expiry}}));
  let product=(await records("products")).find(p=>p.id==="expiry").data;assert.equal(product.stock,9);assert.equal(product.expiredStock,4);assert.equal(product.availableStock,5);
  const saved=await ok(owner("PUT","/api/c/txns/fefo-sale",{data:sale({items:[{productId:"expiry",qty:4,price:20}],amount:80})}));
  const batches=await records("batches"),byId=new Map(batches.map(b=>[b.id,b.data.code]));assert.deepEqual(saved.data.batchEffects.expiry.map(e=>[byId.get(e.batchId),e.qty]),[["EARLY",-2],["LATE",-2]]);
  await ok(owner("PUT","/api/c/txns/expired-sale",{data:sale({items:[{productId:"expiry",qty:2,price:20}],amount:40})}),409);
  product=(await records("products")).find(p=>p.id==="expiry").data;assert.equal(product.stock,5);assert.equal(product.availableStock,1);
  await ok(owner("PATCH","/api/c/txns/fefo-sale",{data:{voided:true,voidReason:"Delivery cancelled"}}));product=(await records("products")).find(p=>p.id==="expiry").data;assert.equal(product.stock,9);assert.equal(product.availableStock,5);
  const early=(await records("batches")).find(b=>b.data.code==="EARLY");await ok(owner("PATCH","/api/batches/"+early.id,{version:early.version,code:"EARLY-RECHECKED",expiryDate:day(-1)}));assert.equal((await records("products")).find(p=>p.id==="expiry").data.availableStock,3);
});

test("collection contacts retain promise history and reject promises above the dealer balance",async t=>{
  const {owner,staff,ok,sale,records}=await fixture(t);await ok(owner("PUT","/api/c/txns/reminder-sale",{data:sale()}));
  const nextDay=new Date(Date.now()+864e5).toISOString().slice(0,10),body={dealerId:"d",date:today(),channel:"Call",outcome:"Promise to pay",promiseDate:nextDay,promiseAmount:100,note:"Dealer will pay tomorrow"};
  const saved=await ok(staff("POST","/api/reminders",body));assert.equal(saved.data.promiseAmount,100);assert.equal(saved.data.createdBy,(await ok(staff("GET","/api/me"))).id);
  await ok(staff("POST","/api/reminders",{...body,promiseAmount:201}),400);await ok(staff("PUT","/api/c/reminders/forged",{data:body}),403);await ok(owner("DELETE","/api/c/reminders/"+saved.id),403);
  assert.equal((await records("dealers")).find(d=>d.id==="d").data.lastReminded,today());assert.equal((await ok(owner("GET","/api/backup"))).reminders[saved.id].promiseDate,nextDay);
});

test("delivery proof is bound to a live sale, retains signature history, and protects referenced images",async t=>{
  const {owner,ok,sale,records,base}=await fixture(t),cookie=await sessionCookie(base);
  const png=Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b40000000049454e44ae426082","hex");
  const upload=await fetch(base+"/api/assets",{method:"POST",headers:{Cookie:cookie,"Content-Type":"image/png"},body:png});assert.equal(upload.status,200);const asset=await upload.json();
  let saleRow=await ok(owner("PUT","/api/c/txns/delivery-sale",{data:sale()}));
  const body={saleId:saleRow.id,saleVersion:saleRow.version,recipient:"Dealer recipient",date:today(),signatureAssetId:asset.id,note:"Received in good order"};
  const delivery=await ok(owner("POST","/api/deliveries",body));assert.equal((await records("deliveries"))[0].data.status,"confirmed");await ok(owner("DELETE","/api/assets/"+asset.id),409);
  saleRow=await ok(owner("PATCH","/api/c/txns/delivery-sale",{data:{items:[{productId:"p",qty:1,price:100}],amount:100,correctionReason:"One unit cancelled"}}));assert.equal((await records("deliveries"))[0].data.status,"needs review");
  await ok(owner("POST","/api/deliveries",{...body,version:delivery.version,reason:"New delivery"}),409);
  const replacement=await ok(owner("POST","/api/deliveries",{...body,saleVersion:saleRow.version,version:delivery.version,reason:"New delivery"}));assert.equal(replacement.data.history.length,1);
  await ok(owner("POST","/api/deliveries/"+replacement.id+"/void",{version:replacement.version,reason:"Recipient correction"}));assert.equal((await records("deliveries"))[0].data.status,"voided");
});

test("customer refunds consume available credit, appear in cash closing, and block invalid credit reversals",async t=>{
  const {owner,ok,payment,records}=await fixture(t);await ok(owner("PUT","/api/c/txns/overpayment",{data:payment({amount:300})}));
  const body={dealerId:"d",date:today(),amount:100,method:"Cash",reason:"Refund excess payment",reference:"REF-1"},headers={"Idempotency-Key":"customer-refund-once"};
  const refund=await ok(owner("POST","/api/customer-refunds",body,headers));assert.equal(refund.data.type,"refund");assert.deepEqual(await ok(owner("POST","/api/customer-refunds",body,headers)),refund);
  let statement=await ok(owner("GET",`/api/dealers/d/statement?from=${today()}&to=${today()}`));assert.equal(statement.closing,-200);assert.equal(statement.entries.find(e=>e.type==="refund").debit,100);
  await ok(owner("POST","/api/customer-refunds",{...body,amount:201}),400);await ok(owner("PATCH","/api/c/txns/overpayment",{data:{voided:true,voidReason:"Refund must be voided first"}}),409);
  const opening=Object.fromEntries(METHODS.map(m=>[m,0])),closing=await ok(owner("POST","/api/daily-closing/preview",{date:today(),opening}));assert.equal(closing.channels.find(c=>c.method==="Cash").expected,200);assert.equal(closing.channels.find(c=>c.method==="Cash").customerRefunds,100);
  await ok(owner("POST","/api/customer-refunds/"+refund.id+"/void",{version:refund.version,reason:"Incorrect payment channel"}));statement=await ok(owner("GET",`/api/dealers/d/statement?from=${today()}&to=${today()}`));assert.equal(statement.closing,-300);
});

test("bank reconciliation skips duplicate lines, prevents double matches, and detects changed ledger entries",async t=>{
  const {owner,staff,ok,payment,records}=await fixture(t);
  await ok(owner("PUT","/api/c/txns/bank-payment",{data:payment({amount:50,method:"GCash",ref:"DEPOSIT"})}));
  const statement={bank:"GCash business",method:"GCash",lines:[{date:today(),amount:50,reference:"BANK-1",description:"Dealer collection"}]};let imported=await ok(owner("POST","/api/bank/import",statement));assert.equal(imported.imported,1);
  assert.equal((await ok(owner("POST","/api/bank/import",statement))).duplicates,1);let bank=(await records("bankStatements")).find(s=>s.id===imported.id);
  bank=await ok(owner("POST",`/api/bank/${bank.id}/lines/${bank.data.lines[0].id}`,{version:bank.version,action:"match",eventIds:["tx:bank-payment"]}));assert.equal(bank.data.lines[0].status,"matched");
  const second=await ok(owner("POST","/api/bank/import",{...statement,lines:[{date:today(),amount:50,reference:"BANK-2",description:"Second line"}]})),other=(await records("bankStatements")).find(s=>s.id===second.id);
  await ok(owner("POST",`/api/bank/${other.id}/lines/${other.data.lines[0].id}`,{version:other.version,action:"match",eventIds:["tx:bank-payment"]}),409);
  assert.deepEqual(await ok(staff("GET","/api/c/bankStatements")),[]);await ok(staff("POST","/api/bank/import",statement),403);
  await ok(owner("PATCH","/api/c/txns/bank-payment",{data:{amount:49,correctionReason:"Bank corrected amount"}}));
  const events=require("../public/insights").bankEvents((await records("txns")).map(r=>[r.id,r.data]),[],[]);assert.notEqual(events[0].stamp,bank.data.lines[0].matches[0].stamp);
  await ok(owner("POST",`/api/bank/${bank.id}/lines/${bank.data.lines[0].id}`,{version:bank.version,action:"unmatch"}));
});

test("expense PDFs are validated, retained in correction history and backups, and hidden from dealer accounts",async t=>{
  const {owner,staff,ok,base,records}=await fixture(t),cookie=await sessionCookie(base);
  const response=await fetch(base+"/api/documents",{method:"POST",headers:{Cookie:cookie,"Content-Type":"application/pdf"},body:Buffer.from("%PDF-1.4\nTest receipt\n%%EOF")});assert.equal(response.status,200);const document=await response.json();
  const invalid=await fetch(base+"/api/documents",{method:"POST",headers:{Cookie:cookie,"Content-Type":"application/pdf"},body:Buffer.from("not a PDF")});assert.equal(invalid.status,415);
  const expense={date:today(),category:"Transport",amount:25,method:"Cash",attachments:[{id:document.id,name:"Receipt.pdf"}]};
  const saved=await ok(owner("PUT","/api/c/expenses/documented",{data:expense}));assert.equal(saved.data.attachments[0].type,"application/pdf");await ok(staff("PUT","/api/c/expenses/stolen-document",{data:expense}),403);
  await ok(owner("POST","/api/users",{name:"Dealer login",username:"proofdealer",password:"DealerProofPassword123!",role:"dealer",dealerId:"d"}));const dealerCookie=await sessionCookie(base,"proofdealer","DealerProofPassword123!");assert.equal((await fetch(base+"/_blob/"+document.id,{headers:{Cookie:dealerCookie}})).status,403);
  await ok(owner("PATCH","/api/c/expenses/documented",{data:{attachments:[],correctionReason:"Replace supporting document"}}));await ok(owner("DELETE","/api/assets/"+document.id),409);assert.ok((await records("revisions")).some(r=>r.data.before.attachments?.[0]?.id===document.id));
  await ok(owner("POST","/api/backup/run",{}));assert.equal((await ok(owner("POST","/api/backup/verify",{}))).ok,true);
});

test("monthly period locks block financial changes until the owner reopens the month",async t=>{
  const {owner,staff,ok,sale}=await fixture(t),month=today().slice(0,7);
  const preview=await ok(owner("POST","/api/periods/preview",{month}));assert.equal(preview.locked,false);
  await ok(staff("POST",`/api/periods/${month}/close`,{reason:"Staff cannot finalize"}),403);
  const closed=await ok(owner("POST",`/api/periods/${month}/close`,{reason:"Month-end accounts reviewed"}));assert.equal(closed.data.status,"closed");
  await ok(owner("PUT","/api/c/txns/locked-sale",{data:sale()}),409);
  await ok(owner("PUT","/api/c/expenses/locked-expense",{data:{date:today(),category:"Rent",amount:5,method:"Cash"}}),409);
  await ok(owner("PUT","/api/c/moves/locked-move",{data:{productId:"p",qty:-1,date:today(),reason:"Damaged stock"}}),409);
  await ok(owner("PUT","/api/c/dealers/allowed-dealer",{data:{name:"Allowed dealer"}}));
  const backup=await ok(owner("GET","/api/backup"));assert.ok(backup.periodLocks[`period-${month}`]);
  await ok(owner("POST",`/api/periods/${month}/close`,{reason:"Already finalized"}),409);
  await ok(staff("POST",`/api/periods/${month}/reopen`,{reason:"Staff cannot reopen"}),403);
  const reopened=await ok(owner("POST",`/api/periods/${month}/reopen`,{reason:"Late supplier invoice"}));assert.equal(reopened.data.status,"reopened");
  await ok(owner("PUT","/api/c/txns/late-sale",{data:sale()}));
});

test("cashier shifts calculate expected cash and require a note for shortages and overages",async t=>{
  const {owner,staff,ok,payment}=await fixture(t);
  await ok(staff("POST","/api/shifts/open",{date:today()}),400);
  const shift=await ok(staff("POST","/api/shifts/open",{date:today(),register:"Counter 1",openingCash:100}));assert.equal(shift.data.status,"open");
  await ok(staff("POST","/api/shifts/open",{date:today(),openingCash:50}),409);
  await ok(owner("PUT","/api/c/txns/shift-pay",{data:payment({amount:50,method:"Cash"})}));
  await ok(owner("PUT","/api/c/txns/shift-gcash",{data:payment({amount:30,method:"GCash"})}));
  await ok(owner("PUT","/api/c/expenses/shift-expense",{data:{date:today(),category:"Transport",amount:20,method:"Cash"}}));
  await ok(owner("POST",`/api/shifts/${shift.id}/close`,{closingCash:120}),400);
  const closed=await ok(staff("POST",`/api/shifts/${shift.id}/close`,{closingCash:120,note:"Shortage investigated"}));
  assert.equal(closed.data.expectedCash,130);assert.equal(closed.data.variance,-10);assert.equal(closed.data.varianceType,"shortage");
  await ok(owner("POST",`/api/shifts/${shift.id}/close`,{closingCash:130}),409);
  const over=await ok(staff("POST","/api/shifts/open",{date:today(),openingCash:0}));
  const balanced=await ok(staff("POST",`/api/shifts/${over.id}/close`,{closingCash:0}));assert.equal(balanced.data.varianceType,"balanced");
});

test("duplicate detection groups repeated payments, invoices and expenses and records review decisions",async t=>{
  const {owner,staff,ok,sale,payment}=await fixture(t);
  await ok(owner("PUT","/api/c/txns/dup-pay-1",{data:payment({amount:75,date:today()})}));
  await ok(owner("PUT","/api/c/txns/dup-pay-2",{data:payment({amount:75,date:today()})}));
  await ok(owner("PUT","/api/c/txns/dup-sale-1",{data:sale({date:today(),note:"first"})}));
  await ok(owner("PUT","/api/c/txns/dup-sale-2",{data:sale({date:today(),note:"second"})}));
  await ok(owner("PUT","/api/c/expenses/dup-exp-1",{data:{date:today(),category:"Transport",amount:30,method:"Cash",payee:"Courier"}}));
  await ok(owner("PUT","/api/c/expenses/dup-exp-2",{data:{date:today(),category:"Transport",amount:30,method:"Cash",payee:"Courier"}}));
  await ok(staff("GET","/api/duplicates?days=1"),403);
  const found=await ok(owner("GET","/api/duplicates?days=1"));assert.equal(found.days,1);
  for(const kind of ["payment","invoice","expense"])assert.ok(found.groups.some(g=>g.kind===kind&&g.status==="open"),kind);
  const paymentGroup=found.groups.find(g=>g.kind==="payment");
  await ok(owner("POST",`/api/duplicates/${paymentGroup.id}/review`,{status:"reviewed",reason:"Same receipt keyed twice",days:1}));
  const after=await ok(owner("GET","/api/duplicates?days=1"));assert.equal(after.groups.find(g=>g.kind==="payment").status,"reviewed");
  const expenseGroup=after.groups.find(g=>g.kind==="expense");
  await ok(owner("POST",`/api/duplicates/${expenseGroup.id}/review`,{status:"ignored",reason:"",days:1}),400);
  const ignored=await ok(owner("POST",`/api/duplicates/${expenseGroup.id}/review`,{status:"ignored",reason:"Separate trips",days:1}));assert.equal(ignored.status,"ignored");
  const backup=await ok(owner("GET","/api/backup"));assert.ok(backup.duplicateReviews[paymentGroup.id]);assert.ok(backup.cashierShifts);
});

test("expired stock cannot mask consumption of unexpired units reserved for orders",async t=>{
  const {owner,ok,records}=await fixture(t),past=new Date(Date.now()-864e5).toISOString().slice(0,10),future=new Date(Date.now()+10*864e5).toISOString().slice(0,10);
  await ok(owner("PUT","/api/c/products/reserved-lots",{data:{name:"Reserved lots",stock:0,dealerPrice:100,srp:100,purchaseCost:40}}));
  for(const [id,qty,expiry] of [["OLD",5,past],["GOOD",3,future]])await ok(owner("PUT","/api/c/moves/reservation-"+id,{data:{productId:"reserved-lots",qty,unitCost:40,reason:"Received stock",date:today(),batchCode:id,expiryDate:expiry}}));
  let order=await ok(owner("PUT","/api/c/orders/reserved-order",{data:{dealerId:"d",items:[{productId:"reserved-lots",qty:3}],status:"new"}}));order=await ok(owner("PATCH","/api/c/orders/reserved-order",{data:{status:"preparing"}}));
  const good=(await records("batches")).find(b=>b.data.productId==="reserved-lots"&&b.data.code==="GOOD");
  await ok(owner("PUT","/api/c/moves/cannot-take-reserved",{data:{productId:"reserved-lots",qty:-1,reason:"Damaged stock",date:today(),requestedBatchId:good.id}}),409);
  assert.equal((await records("products")).find(p=>p.id==="reserved-lots").data.stock,8);
  assert.equal((await records("batches")).find(b=>b.id===good.id).data.remainingQty,3);
});
