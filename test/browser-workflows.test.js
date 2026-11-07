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
  async function waitFor(expression){const end=Date.now()+10000;while(Date.now()<end){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,50));}throw new Error("Browser condition failed: "+expression+"\n"+JSON.stringify(await evaluate('({text:document.body.innerText.slice(-2000)})')));}
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
  await fill("#p-name","Browser soap");await fill("#p-code","SOAP");await fill("#p-stock","10");await fill("#p-srp","100");await fill("#p-dp","75");await submit("#f");
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
  assert.deepEqual(errors,[],"no uncaught browser JavaScript errors");
});
