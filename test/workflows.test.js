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
  await ok(owner("PUT","/api/c/products/p",{data:{name:"Soap",stock:10,srp:100,dealerPrice:75,code:"SOAP"}}));
  await ok(owner("POST","/api/users",{name:"Staff",username:"staff",password:"StaffPassword123!",role:"staff"}));
  await ok(staff("POST","/api/login",{username:"staff",password:"StaffPassword123!"}));
  const sale=(extra={})=>({type:"sale",dealerId:"d",date:today(),dueDate:today(),items:[{productId:"p",name:"Soap",qty:2,price:100}],amount:200,...extra});
  const payment=(extra={})=>({type:"payment",dealerId:"d",date:today(),amount:50,method:"Cash",...extra});
  const records=async(c,who=owner)=>ok(who("GET","/api/c/"+c));
  return {...ctx,dir,owner,staff,portal,client,ok,sale,payment,records};
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
