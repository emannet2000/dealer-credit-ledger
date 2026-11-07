"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),{spawn}=require("node:child_process");
const {createApp}=require("../lib/app");
const chromePath=process.env.CHROME_PATH||(fs.existsSync("/usr/lib/chromium/chromium")?"/usr/lib/chromium/chromium":"/usr/bin/chromium");

test("browser: sales, corrections, statements, reconciliation, approvals and reviewed imports",{skip:!fs.existsSync(chromePath),timeout:180000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"ledger-browser-test-"));
  const ctx=createApp({dataDir:dir});
  const server=ctx.app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const chrome=spawn(chromePath,["--headless","--no-sandbox","--disable-gpu","--disable-dev-shm-usage","--disable-background-networking","--no-zygote","--single-process","--renderer-process-limit=1","--no-first-run","--remote-debugging-pipe",`--user-data-dir=${dir}/chrome`,"about:blank"],{stdio:["ignore","ignore","pipe","pipe","pipe"]});
  let seq=0,buffer="",stderr="";const pending=new Map(),errors=[];
  chrome.stderr.on("data",d=>{stderr=(stderr+d).slice(-4000);});
  chrome.stdio[4].on("data",chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf("\0"))!==-1){const msg=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);if(msg.id){const call=pending.get(msg.id);if(call){pending.delete(msg.id);clearTimeout(call.timer);msg.error?call.reject(new Error(JSON.stringify(msg.error))):call.resolve(msg.result);}}else if(msg.method==="Runtime.exceptionThrown")errors.push(msg.params.exceptionDetails);}});
  chrome.stdio[3].on("error",()=>{});chrome.stdio[4].on("error",()=>{});
  chrome.on("exit",()=>{for(const call of pending.values()){clearTimeout(call.timer);call.reject(new Error("Chromium exited: "+stderr));}pending.clear();});
  t.after(async()=>{
    chrome.kill();await Promise.race([new Promise(r=>chrome.once("exit",r)),new Promise(r=>setTimeout(r,2000))]);
    if(chrome.exitCode===null)chrome.kill("SIGKILL");
    server.closeAllConnections();server.close();ctx.close();
    // Chromium can briefly hold profile files after its parent exits.
    fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  });
  function send(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout: ${method}\n${stderr}`));},60000);pending.set(id,{resolve,reject,timer});chrome.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+"\0");});}
  const {targetId}=await send("Target.createTarget",{url:"about:blank"});const {sessionId}=await send("Target.attachToTarget",{targetId,flatten:true});
  const c=(method,params)=>send(method,params,sessionId);
  await c("Runtime.enable");await c("Page.enable");await c("Network.enable");await c("Network.setBlockedURLs",{urls:["https://fonts.googleapis.com/*","https://fonts.gstatic.com/*"]});
  async function evaluate(expression){const r=await c("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
  async function waitFor(expression){const end=Date.now()+10000;while(Date.now()<end){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,50));}throw new Error("Browser condition failed: "+expression+"\n"+JSON.stringify(await evaluate('({text:document.body.innerText.slice(-2000)})'))+" Runtime: "+JSON.stringify(errors));}
  const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const fill=(selector,value)=>evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const submit=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).requestSubmit()`);
  const data=c=>ctx.db.prepare("SELECT id,data,version FROM docs WHERE collection=?").all(c).map(r=>({...r,data:JSON.parse(r.data)}));
  const close=async()=>{if(await evaluate('!!document.querySelector("[data-close]")'))await click("[data-close]");};
  await c("Page.navigate",{url:base+"/login"});await waitFor('document.querySelector("#go")?.textContent==="Create account"');
  await fill("#name","Owner");await fill("#username","owner");await fill("#password","OwnerPassword123!");await submit("#f");
  await waitFor('document.querySelector("#sync")?.textContent.includes("updates live")');
  await evaluate(`window.APP.request('PUT','/api/c/dealers/d',{data:{name:'Browser Dealer',creditLimit:10000,terms:30}})`);
  await click('[data-view="products"]');await click('[data-act="new-product"]');
  await fill("#p-name","Browser soap");await fill("#p-code","SOAP");await fill("#p-stock","10");await fill("#p-srp","100");await fill("#p-dp","75");await fill("#p-cost","30");await fill("#p-supplier","Original supplier");await submit("#f");
  await waitFor('!document.querySelector("#p-name")');const product=data("products")[0];assert.equal(product.data.stock,10);
  await click('[data-act="new-sale"]');await fill("#s-dealer","d");await click('#pick-list [data-pid]');
  await evaluate('document.querySelector("#s-paid").checked=true;document.querySelector("#s-paid").dispatchEvent(new Event("change"))');await submit("#f");
  await waitFor('!!document.querySelector("#rcpt")');assert.equal(data("txns").length,2);assert.equal(data("products")[0].data.stock,9);
  const sale=data("txns").find(r=>r.data.type==="sale");assert.equal(sale.data.amount,75);
  await close();await click('[data-act="new-pay"]');await fill("#y-dealer","d");await fill("#y-amt","25");await submit("#f");
  await waitFor('!!document.querySelector("#rcpt")');assert.equal(data("txns").length,3);
  await close();await click('[data-view="dealers"]');await click('[data-dealer="d"]');await click('[data-act="period-statement"]');await submit("#statement-form");
  await waitFor('!!document.querySelector("#statement-print")');assert.match(await evaluate('document.querySelector(".receipt").innerText'),/Closing balance/);await close();
  await click('[data-view="activity"]');await click(`[data-tx="${sale.id}"]`);await click("#t-edit");await fill("#s-note","Corrected delivery note");await fill("#correction-reason","Added missing delivery detail");await submit("#f");
  await waitFor('!!document.querySelector("#t-void")');assert.equal(data("revisions").filter(r=>r.data.docId===sale.id).length,1);
  await fill("#t-reason","Wrong delivery, reverse sale and payment");await click("#t-void");await click("#t-void");
  await waitFor('!!document.querySelector("#t-unvoid")');assert.equal(data("products")[0].data.stock,10);await close();
  await click('[data-view="store"]');await click('[data-act="reconcile"]');await fill('[data-count="0"]',"25");await submit("#recon-form");await waitFor('!!document.querySelector("#recon-close")');await click("#recon-close");
  await waitFor('!document.querySelector("#recon-close")');assert.equal(data("reconciliations")[0].data.status,"closed");
  await click('[data-view="products"]');await click('[data-act="catalog"]');await fill("#c-text","Code,Name,SRP\nSOAP,Updated soap,120\nNEW,New soap,50");await waitFor('!!document.querySelector("#c-apply")');await click("#c-apply");
  await waitFor('!!document.querySelector("#import-confirm")');assert.equal(await evaluate('document.querySelector("#import-confirm").disabled'),false,await evaluate('document.querySelector(".sheet").innerText'));await click("#import-confirm");await waitFor('document.querySelector("#import-progress")?.textContent.includes("Completed")');assert.equal(data("products").length,2);await close();
  await click('[data-view="store"]');
  const exportedErrors=await evaluate(`(async()=>{const backup=await window.APP.backup();return (await window.APP.previewImport("backup",backup)).errors;})()`);assert.deepEqual(exportedErrors,[]);
  await evaluate(`(async()=>{const backup=await window.APP.backup();backup.products[${JSON.stringify(product.id)}].name='Restored browser soap';const dt=new DataTransfer();dt.items.add(new File([JSON.stringify(backup)],'backup.json',{type:'application/json'}));const input=document.querySelector('#restoreFile');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor('document.querySelector("#import-confirm")?.textContent.includes("Confirm restore")');assert.equal(await evaluate('document.querySelector("#import-confirm").disabled'),false,await evaluate('document.querySelector(".sheet").innerText'));await click("#import-confirm");await waitFor('document.querySelector("#import-progress")?.textContent.includes("Completed")');assert.equal(data("products").find(r=>r.id===product.id).data.name,"Restored browser soap");await close();
  await evaluate(`(async()=>{await window.APP.request('PATCH','/api/c/dealers/d',{data:{creditLimit:1}});await window.APP.request('POST','/api/approvals',{sale:{type:'sale',dealerId:'d',date:new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Manila'}),dueDate:new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Manila'}),items:[{productId:${JSON.stringify(product.id)},qty:1,price:120}],amount:120},reason:'Approve exceptional release'});})()`);
  await waitFor('!!document.querySelector("[data-act=approval-decision]")');await click('[data-act="approval-decision"]');await fill("#approval-reason","Reviewed and approved");await submit("#approval-form");await waitFor('!!document.querySelector("[data-act=approval-release]")');await click('[data-act="approval-release"]');await waitFor('!!document.querySelector("#rcpt")');
  assert.ok(data("approvals").some(r=>r.data.status==="consumed"));assert.equal(data("products").find(r=>r.id===product.id).data.stock,9);
  await close();
  await click('[data-view="stock"]');await waitFor('document.querySelector("#main").textContent.includes("Stock history")');
  await click('[data-act="stock-in"]');await fill("#m-p",product.id);await fill("#m-q","3");await fill("#m-supplier","Delivery supplier");await fill("#m-ref","INV-BROWSER");await fill("#m-cost","35");await submit("#f");
  await waitFor('!document.querySelector("#m-q")');await waitFor('document.querySelector("#main").textContent.includes("INV-BROWSER")');
  const received=data("moves").find(r=>r.data.deliveryRef==="INV-BROWSER");assert.equal(received.data.unitCost,35);assert.equal(received.data.supplier,"Delivery supplier");
  assert.equal(data("products").find(r=>r.id===product.id).data.purchaseCost,35);
  await fill('[data-stock-filter="product"]',product.id);await fill('[data-stock-filter="kind"]',"Received stock");
  assert.equal(await evaluate('document.querySelectorAll("#main tbody tr").length'),1);
  await click('[data-act="reset-stock-filter"]');
  await click('[data-view="profit"]');await waitFor('document.querySelector("#main").textContent.includes("Gross profit")');assert.ok(await evaluate('!!document.querySelector("#profitGroup")'));
  await fill("#profitGroup","month");assert.ok(await evaluate('document.querySelector("#main").textContent.includes("Monthly results")'));
  await click('[data-view="dashboard"]');await waitFor('document.querySelector("#main").textContent.includes("Needs attention")');
  await click('[data-act="run-backup"]');await waitFor('document.querySelector("#main").textContent.includes("Up to date")');
  await c("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  assert.equal(await evaluate('document.querySelector(".sidebar").getBoundingClientRect().left'),0);
  await click("#sidebarToggle");assert.equal(await evaluate('document.body.classList.contains("nav-collapsed")'),true);assert.equal(await evaluate('document.querySelector(".sidebar").getBoundingClientRect().width'),72);
  await click('[data-view="stock"]');assert.equal(await evaluate('document.querySelector(".page-heading h2").textContent'),"Stock history");
  await click("#sidebarToggle");
  await click('[data-view="purchases"]');await click('[data-act="new-purchase"]');await fill("#po-supplier","Browser supplier");await fill('[data-po-qty="'+product.id+'"]',"4");await fill('[data-po-cost="'+product.id+'"]',"40");await submit("#po-form");
  await waitFor('!document.querySelector("#po-form")');await waitFor('!!document.querySelector("[data-act=view-purchase]")');await click('[data-act="view-purchase"]');await click('[data-act="receive-purchase"]');
  await fill("#receive-ref","PO-PART-1");await fill('[data-receive="'+product.id+'"]',"2");await submit("#receive-form");await waitFor('!document.querySelector("#receive-form")');
  assert.equal(data("purchases")[0].data.status,"partial");assert.equal(data("products").find(r=>r.id===product.id).data.inventoryValue,455);
  await click('[data-act="pay-supplier"]');await fill("#sp-amount","30");await fill("#sp-ref","PAY-BROWSER");await submit("#supplier-pay");await waitFor('!document.querySelector("#supplier-pay")');assert.equal(data("purchases")[0].data.payments[0].amount,30);
  await click('[data-act="void-supplier-payment"]');await fill("#void-sp-reason","Incorrect payment channel");await submit("#void-sp");await waitFor('!document.querySelector("#void-sp")');assert.equal(data("purchases")[0].data.payments[0].voided,true);await close();
  await click('[data-view="expenses"]');await click('[data-act="new-expense"]');await fill("#ex-category","Transport");await fill("#ex-amount","25");await fill("#ex-payee","Browser courier");await submit("#expense-form");await waitFor('!document.querySelector("#expense-form")');await waitFor('document.querySelector("#main").textContent.includes("Browser courier")');
  await click('[data-view="profit"]');assert.ok(await evaluate('document.querySelector("#main").textContent.includes("Profit after expenses and losses")'));assert.ok(await evaluate('document.querySelector("#main").textContent.includes("25.00")'));
  const returnSale=data("txns").filter(r=>r.data.type==="sale"&&!r.data.voided&&!r.data.opening).at(-1);
  await click('[data-view="dealers"]');await click('#main [data-dealer="d"]');await click('[data-act="ret-for"]');await fill("#s-original",returnSale.id);await click('#pick-list [data-pid="'+product.id+'"]');await submit("#f");await waitFor('!!document.querySelector("#rcpt")');
  const linked=data("txns").find(r=>r.data.type==="return"&&r.data.originalSaleId===returnSale.id);assert.ok(linked);assert.equal(linked.data.items[0].unitCost,returnSale.data.items[0].unitCost);await close();
  await click('[data-view="reorder"]');await fill("#reorder-cover","60");assert.ok(await evaluate('document.querySelector("#main").textContent.includes("Low-stock reorder list")'));
  if(process.env.LEDGER_SCREENSHOT_DIR){fs.mkdirSync(process.env.LEDGER_SCREENSHOT_DIR,{recursive:true});const shot=await c("Page.captureScreenshot",{format:"png"});fs.writeFileSync(path.join(process.env.LEDGER_SCREENSHOT_DIR,"reorder-desktop.png"),Buffer.from(shot.data,"base64"));}
  await click('[data-view="dashboard"]');await click('[data-act="run-backup"]');await waitFor('document.querySelector("#main").textContent.includes("Up to date")');await click('[data-act="verify-backup"]');await waitFor('document.querySelector("#main").textContent.includes("Recovery check passed")');
  // Supplier returns issue credits; refunds are separate actual money received.
  await click('[data-view="purchases"]');await click('[data-act="view-purchase"]');await click('[data-act="pay-supplier"]');await fill("#sp-amount","80");await submit("#supplier-pay");await waitFor('!document.querySelector("#supplier-pay")');
  await click('[data-act="supplier-return"]');await fill("#sr-ref","SUPPLIER-CREDIT");await fill("#sr-reason","Defective packaging");await fill('[data-supplier-return="'+product.id+'"]',"1");await submit("#supplier-return");await waitFor('!document.querySelector("#supplier-return")');assert.equal(data("purchases")[0].data.returns[0].creditAmount,40);
  await click('[data-act="supplier-refund"]');await fill("#rf-amount","20");await submit("#supplier-refund");await waitFor('!document.querySelector("#supplier-refund")');assert.equal(data("purchases")[0].data.refunds[0].amount,20);await close();
  await click('[data-view="stock"]');await click('[data-act="stock-in"]');await fill("#m-p",product.id);await click('[data-k="out"]');await fill("#m-loss-reason","Expired stock");await fill("#m-q","1");await fill("#m-note","Expiry check");await submit("#f");await waitFor('!document.querySelector("#m-q")');
  await click('[data-view="losses"]');await waitFor('document.querySelector("#main").textContent.includes("Expired stock")');
  // Structured dealer profiles and centered credit sale dialog.
  await click('[data-view="dealers"]');await click('[data-act="new-dealer"]');await fill("#d-first","Maria");await fill("#d-middle","Reyes");await fill("#d-last","Santos");await fill("#d-age","32");await fill("#d-gender","Female");await fill("#d-nationality","Filipino");await submit("#f");await waitFor('!document.querySelector("#d-first")');
  const profile=data("dealers").find(r=>r.data.firstName==="Maria");assert.equal(profile.data.name,"Maria Reyes Santos");assert.equal(profile.data.age,32);
  await click('#main [data-dealer="'+profile.id+'"]');await waitFor('document.querySelector(".sheet").textContent.includes("Filipino")');await click('[data-act="sale-for"]');await waitFor('document.querySelector("#ov").classList.contains("centered")');
  await waitFor('(()=>{const r=document.querySelector(".sheet").getBoundingClientRect();return Math.abs((r.left+r.width/2)-innerWidth/2)<2;})()');await close();
  // Pick a particular invoice for a dealer payment.
  await evaluate(`(async()=>{const r=await window.APP.request('GET','/api/c/reconciliations');for(const row of r)if(row.data.status==='closed')await window.APP.request('POST','/api/reconciliations/'+row.id+'/reopen',{reason:'Browser allocation checks'});const date=new Date().toLocaleDateString('en-CA');for(const [id,amount] of [['alloc-ui-old',100],['alloc-ui-new',200]])await window.APP.request('PUT','/api/c/txns/'+id,{data:{type:'sale',opening:true,dealerId:${JSON.stringify(profile.id)},date,dueDate:date,items:[],amount}});})()`);
  await click('[data-view="dealers"]');await click('#main [data-dealer="'+profile.id+'"]');await click('[data-act="pay-for"]');await fill("#y-amt","100");await fill("#y-mode","manual");await fill('[data-invoice="alloc-ui-new"]',"100");await submit("#f");await waitFor('!!document.querySelector("#rcpt")');assert.ok(data("txns").some(r=>r.data.allocationMode==="manual"&&r.data.applied[0]?.id==="alloc-ui-new"));await close();
  // A staff expense is requested, reviewed, and posted by owner approval.
  await click('[data-view="controls"]');await fill('[data-limit="approvalExpenseLimit"]',"100");await submit("#limits-form");await waitFor('!document.querySelector("#limits-form button").disabled');
  await evaluate(`window.APP.createUser({name:'Browser staff',username:'browserstaff',password:'BrowserStaffPassword123!',role:'staff'})`);
  await evaluate(`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'browserstaff',password:'BrowserStaffPassword123!'})}).then(r=>r.json())`);await c("Page.navigate",{url:base+"/#expenses"});await waitFor('document.querySelector("#sync")?.textContent.includes("updates live")');
  await click('[data-act="new-expense"]');await fill("#ex-category","Transport");await fill("#ex-amount","150");await fill("#ex-note","Owner review of transport");await submit("#expense-form");await waitFor('!document.querySelector("#expense-form")');assert.ok(data("authorizations").some(r=>r.data.status==="pending"));assert.equal(data("expenses").filter(r=>r.data.amount===150).length,0);
  await evaluate(`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'owner',password:'OwnerPassword123!'})}).then(r=>r.json())`);await c("Page.navigate",{url:base+"/#controls"});await waitFor('document.querySelector("#sync")?.textContent.includes("updates live")');await waitFor('!!document.querySelector("[data-act=decide-authorization]")');await click('[data-act="decide-authorization"]');await fill("#auth-reason","Receipt checked");await submit("#authorization-decision");await waitFor('!document.querySelector("#authorization-decision")');assert.equal(data("authorizations")[0].data.status,"consumed");assert.equal(data("expenses").filter(r=>r.data.amount===150).length,1);
  // Full backup link and daily closing with matching counted balances.
  await click('[data-view="store"]');assert.ok(await evaluate(`!!document.querySelector('a[href="/api/backup/download"]')`));
  await click('[data-view="closing"]');await click('[data-act="new-daily-closing"]');const methods=["Cash","GCash","Maya","Bank transfer","Check","Other"];for(const method of methods)await fill('[data-opening="'+method+'"]',"10000");await click("#daily-preview-button");await waitFor('!document.querySelector("#daily-close-confirm").hidden');
  const closing=await evaluate(`window.APP.request('POST','/api/daily-closing/preview',{date:document.querySelector('#daily-date').value,opening:Object.fromEntries([...document.querySelectorAll('[data-opening]')].map(i=>[i.dataset.opening,Number(i.value)]))})`);for(const channel of closing.channels)await fill('[data-counted="'+channel.method+'"]',String(channel.expected));await click("#daily-close-confirm");await waitFor('!document.querySelector("#daily-close-form")');assert.equal(data("dailyClosings")[0].data.status,"closed");
  await click('[data-act="view-daily-closing"]');await click('[data-act="reopen-daily-closing"]');await fill("#reopen-day-reason","Final browser review");await submit("#reopen-day");await waitFor('!document.querySelector("#reopen-day")');assert.equal(data("dailyClosings")[0].data.status,"reopened");await close();
  // Directory contacts, terms and credit applications across supplier bills.
  await click('[data-view="suppliers"]');await click('[data-act="new-supplier"]');await fill("#su-name","Directory supplier");await fill("#su-contact","Supplier contact");await fill("#su-terms","30");await submit("#supplier-form");await waitFor('!document.querySelector("#su-name")');const directorySupplier=data("suppliers").find(r=>r.data.name==="Directory supplier");
  const directoryOrders=[];
  for(let index=0;index<2;index++){
    await click('[data-view="purchases"]');await click('[data-act="new-purchase"]');await fill("#po-supplier-id",directorySupplier.id);await fill('[data-po-qty="'+product.id+'"]',"2");await fill('[data-po-cost="'+product.id+'"]',"40");await submit("#po-form");await waitFor('!document.querySelector("#po-form")');
    const order=data("purchases").filter(r=>r.data.supplierId===directorySupplier.id&&!directoryOrders.includes(r.id)).sort((a,b)=>b.data.createdAt-a.data.createdAt)[0];directoryOrders.push(order.id);await click('[data-act="view-purchase"][data-id="'+order.id+'"]');await click('[data-act="receive-purchase"]');await fill("#receive-ref","DIRECTORY-"+index);await fill('[data-receive="'+product.id+'"]',"2");await fill('[data-receive-code="'+product.id+'"]',"DIRECT-"+index);await fill('[data-receive-expiry="'+product.id+'"]',new Date(Date.now()+30*864e5).toISOString().slice(0,10));await submit("#receive-form");await waitFor('!document.querySelector("#receive-form")');await close();
  }
  await click('[data-act="view-purchase"][data-id="'+directoryOrders[0]+'"]');await click('[data-act="pay-supplier"]');await fill("#sp-amount","80");await submit("#supplier-pay");await waitFor('!document.querySelector("#supplier-pay")');await click('[data-act="supplier-return"]');await fill("#sr-ref","DIRECT-CREDIT");await fill("#sr-reason","Return one unopened unit");await fill('[data-supplier-return="'+product.id+'"]',"1");await submit("#supplier-return");await waitFor('!document.querySelector("#supplier-return")');
  await click('[data-act="apply-supplier-credit"]');await fill("#ac-target",directoryOrders[1]);await fill("#ac-amount","40");await submit("#apply-credit");await waitFor('!document.querySelector("#apply-credit")');assert.ok(data("supplierApplications").some(r=>r.data.amount===40));await close();
  // Reminders record contacts and promises without sending messages.
  await click('[data-view="reminders"]');await fill("#reminder-filter","all");await click('[data-act="record-contact"][data-id="'+profile.id+'"]');await fill("#ct-outcome","Promise to pay");await fill("#ct-pdate",new Date(Date.now()+2*864e5).toISOString().slice(0,10));await fill("#ct-amount","50");await fill("#ct-note","Will pay after payday");await submit("#contact-form");await waitFor('!document.querySelector("#contact-form")');assert.ok(data("reminders").some(r=>r.data.promiseAmount===50));
  await click('[data-act="contact-history"][data-id="'+profile.id+'"]');assert.ok(await evaluate('document.querySelector(".sheet").textContent.includes("Will pay after payday")'));await close();
  // Draw and save recipient signature using actual pointer events.
  const proofSale=data("txns").filter(r=>r.data.type==="sale"&&!r.data.opening&&!r.data.voided&&r.data.items?.length).sort((a,b)=>b.data.createdAt-a.data.createdAt)[0];
  await click('[data-view="deliveries"]');await click('[data-act="confirm-delivery"][data-id="'+proofSale.id+'"]');await fill("#dv-recipient","Test recipient");
  const canvasPoint=await evaluate('(()=>{const r=document.querySelector("#dv-signature").getBoundingClientRect();return {x:r.left+30,y:r.top+50};})()');await c("Input.dispatchMouseEvent",{type:"mousePressed",...canvasPoint,button:"left",clickCount:1});await c("Input.dispatchMouseEvent",{type:"mouseMoved",x:canvasPoint.x+90,y:canvasPoint.y+25,buttons:1});await c("Input.dispatchMouseEvent",{type:"mouseReleased",x:canvasPoint.x+90,y:canvasPoint.y+25,button:"left",clickCount:1});await submit("#delivery-form");await waitFor('!document.querySelector("#delivery-form")');assert.ok(data("deliveries").some(r=>r.data.recipient==="Test recipient"));
  // A centered payment form creates available credit that can be refunded.
  await click('[data-view="dealers"]');await click('#main [data-dealer="'+profile.id+'"]');await click('[data-act="pay-for"]');await waitFor('document.querySelector("#ov").classList.contains("centered")');await fill("#y-amt","300");await submit("#f");await waitFor('!!document.querySelector("#rcpt")');await close();
  await click('[data-view="refunds"]');await click('[data-act="new-customer-refund"]');await fill("#cu-dealer",profile.id);await fill("#cu-amount","50");await fill("#cu-reason","Return overpayment");await submit("#refund-form");await waitFor('!document.querySelector("#refund-form")');assert.ok(data("txns").some(r=>r.data.type==="refund"&&r.data.amount===50));
  // Expense PDFs are uploaded, linked and included in bank matching.
  await click('[data-view="expenses"]');await click('[data-act="new-expense"]');await fill("#ex-category","Transport");await fill("#ex-amount","13");await fill("#ex-payee","Receipt vendor");await evaluate(String.raw`(()=>{const dt=new DataTransfer();dt.items.add(new File(['%PDF-1.4\nReceipt\n%%EOF'],'Delivery-fare.pdf',{type:'application/pdf'}));document.querySelector('#ex-files').files=dt.files;})()`);await submit("#expense-form");await waitFor('!document.querySelector("#expense-form")');const documentExpense=data("expenses").find(r=>r.data.payee==="Receipt vendor");assert.equal(documentExpense.data.attachments[0].type,"application/pdf");
  await click('[data-view="bank"]');await click('[data-act="import-bank"]');await fill("#bi-bank","Cash ledger statement");await fill("#bi-method","Cash");await fill("#bi-text","Date,Description,Reference,Amount\n"+documentExpense.data.date+",Documented expense,BANK-DOC,-13");await click("#bi-check");await submit("#bank-import");await waitFor('!document.querySelector("#bank-import")');await waitFor('!!document.querySelector("[data-act=match-bank]")');await click('[data-act="match-bank"]');
  await evaluate(`(()=>{const i=document.querySelector('[data-bank-event="expense:${documentExpense.id}"]');i.checked=true;i.dispatchEvent(new Event('change',{bubbles:true}));})()`);await submit("#bank-match");await waitFor('!document.querySelector("#bank-match")');assert.equal(data("bankStatements")[0].data.lines[0].status,"matched");
  await evaluate(`window.APP.request('PATCH','/api/c/expenses/${documentExpense.id}',{data:{amount:14,correctionReason:'Correct receipt amount'}},{'If-Match':String(${documentExpense.version})})`);await waitFor('document.querySelector("#main").textContent.includes("needs review")');
  // Batch metadata and expiry warnings can be reviewed without altering quantity.
  await click('[data-view="batches"]');const directoryBatch=data("batches").find(r=>r.data.code==="DIRECT-1");await click('[data-act="edit-batch"][data-id="'+directoryBatch.id+'"]');await fill("#bt-expiry",new Date(Date.now()-864e5).toISOString().slice(0,10));await submit("#batch-form");await waitFor('!document.querySelector("#batch-form")');await fill("#batch-filter","expired");assert.ok(await evaluate('document.querySelector("#main").textContent.includes("DIRECT-1")'));
  await click('[data-view="dashboard"]');await click('[data-act="run-backup"]');await waitFor('document.querySelector("#main").textContent.includes("Up to date")');await click('[data-act="verify-backup"]');await waitFor('document.querySelector("#main").textContent.includes("Recovery check passed")');
  await c("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".sidebar")).display'),"none");
  assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
  await click('[data-nav="more"]');await click('[data-go="profit"]');assert.equal(await evaluate('document.querySelector(".page-heading h2").textContent'),"Profit reports");
  await waitFor('!document.querySelector("#ov")');
  if(process.env.LEDGER_SCREENSHOT_DIR){const shot=await c("Page.captureScreenshot",{format:"png"});fs.writeFileSync(path.join(process.env.LEDGER_SCREENSHOT_DIR,"profit-mobile.png"),Buffer.from(shot.data,"base64"));}
  await click('[data-nav="more"]');assert.ok(await evaluate('!!document.querySelector(".sheet [data-act=logout]")'));await close();
  await c("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await click("#sidebarToggle");
  assert.ok(await evaluate('(()=>{const b=document.querySelector(".sidebar [data-act=logout]");return b&&getComputedStyle(b).display!=="none"&&b.querySelector("svg");})()'));
  await click('.sidebar [data-act="logout"]');await waitFor('!!document.querySelector("#username")');assert.ok(ctx.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='logout'").get().n>0);
  assert.deepEqual(errors,[],"no uncaught browser JavaScript errors");
});
