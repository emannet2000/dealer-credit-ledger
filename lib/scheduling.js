"use strict";
const crypto=require("node:crypto");
const {today,r2}=require("./credit");
const {METHODS,validDate}=require("./ledger");
const text=v=>typeof v==="string"?v.trim().slice(0,500):"";
function occurrenceDate(start,frequency,index){const date=new Date(start+"T00:00:00Z");if(frequency==="weekly")date.setUTCDate(date.getUTCDate()+7*index);else{const y=date.getUTCFullYear(),m=date.getUTCMonth()+index,day=date.getUTCDate(),last=new Date(Date.UTC(y,m+1,0)).getUTCDate();date.setUTCDate(1);date.setUTCFullYear(y,m,Math.min(day,last));}return date.toISOString().slice(0,10);}
function createScheduling({getDoc,listDocs,put,audit,fail,once,commit,requestAuthorization,broadcast,assertOpen}){
  function validate(p){if(!text(p.name)||!text(p.category)||!Number.isFinite(Number(p.amount))||Number(p.amount)<0.01||Number(p.amount)>1e9||!METHODS.includes(p.method)||!["weekly","monthly"].includes(p.frequency)||!validDate(p.startDate)||p.endDate&&(!validDate(p.endDate)||p.endDate<p.startDate))fail(400,"Enter a template name, valid expense amount/method, weekly or monthly schedule and valid dates.");}
  function register(app,needUser,needAdmin){
    app.post("/api/recurring-expenses",needUser,needAdmin,(req,res)=>{const out=once(req.user,req.get("Idempotency-Key"),{route:"recurring_create",body:req.body},()=>{const b=req.body;validate(b);const id=crypto.randomUUID(),data={name:text(b.name),category:text(b.category),amount:r2(b.amount),method:b.method,payee:text(b.payee),note:text(b.note),frequency:b.frequency,startDate:b.startDate,endDate:b.endDate||null,nextIndex:0,nextDate:b.startDate,active:true,occurrences:[],createdAt:Date.now(),createdBy:req.user.id};put("recurringExpenses",id,data);audit(req.user,"recurring_create","recurringExpenses",id,data);return getDoc("recurringExpenses",id);});broadcast("recurringExpenses");res.json(out);});
    app.patch("/api/recurring-expenses/:id",needUser,needAdmin,(req,res)=>{const out=once(req.user,req.get("Idempotency-Key"),{route:"recurring_edit",id:req.params.id,body:req.body},()=>{const old=getDoc("recurringExpenses",req.params.id);if(!old)fail(404,"Recurring template not found.");if(Number(req.body.version)!==old.version)fail(409,"The template changed. Reload it first.","conflict");const p={...old.data,...req.body};validate(p);if(old.data.occurrences.length&&(p.frequency!==old.data.frequency||p.startDate!==old.data.startDate))fail(409,"Create a new template to change a schedule that already has occurrences.");const data={...old.data,name:text(p.name),category:text(p.category),amount:r2(p.amount),method:p.method,payee:text(p.payee),note:text(p.note),endDate:p.endDate||null,active:p.active!==false,updated:{at:Date.now(),by:req.user.id}};put("recurringExpenses",old.id,data);audit(req.user,"recurring_update","recurringExpenses",old.id,data);return getDoc("recurringExpenses",old.id);});broadcast("recurringExpenses");res.json(out);});
    app.post("/api/recurring-expenses/:id/generate",needUser,needAdmin,(req,res)=>{
      const out=once(req.user,req.get("Idempotency-Key"),{route:"recurring_generate",id:req.params.id,body:req.body},()=>{
        const template=getDoc("recurringExpenses",req.params.id);if(!template)fail(404,"Recurring template not found.");const p=template.data,b=req.body;if(Number(b.version)!==template.version)fail(409,"Template changed. Reload before generating.","conflict");if(!p.active)fail(409,"Reactivate this template before generating expenses.");if(!validDate(b.throughDate)||b.throughDate>today())fail(400,"Generate through today or an earlier date.");
        const dates=[];let index=p.nextIndex;
        if(b.retryDate){const prior=p.occurrences.find(o=>o.date===b.retryDate);if(!prior||getDoc("expenses",prior.expenseId)||!prior.authorizationId||getDoc("authorizations",prior.authorizationId)?.data.status!=="rejected")fail(409,"Only a rejected, unposted occurrence can be retried.");dates.push(b.retryDate);}
        else while(dates.length<12){const date=occurrenceDate(p.startDate,p.frequency,index);if(date>b.throughDate||p.endDate&&date>p.endDate)break;dates.push(date);index++;}
        const occurrences=[...p.occurrences],generated=[],pending=[];
        for(const date of dates){assertOpen(date);const expenseId="rec_"+template.id+"_"+date,existing=getDoc("expenses",expenseId);if(existing)continue;const data={date,category:p.category,amount:p.amount,method:p.method,payee:p.payee,note:`Recurring ${p.name}${p.note?" · "+p.note:""}`};let authorizationId=null;
          try{commit(req.user,"expenses",expenseId,data);generated.push(expenseId);}catch(e){if(e.code!=="approval_required")throw e;const request=requestAuthorization(req.user,{collection:"expenses",id:expenseId,data,reason:"Recurring expense · "+p.name});authorizationId=request.id;pending.push(request.id);}
          const entry={date,expenseId,authorizationId,generatedAt:Date.now(),by:req.user.id};const position=occurrences.findIndex(o=>o.date===date);if(position>=0)occurrences[position]=entry;else occurrences.push(entry);
        }
        const data={...p,occurrences,nextIndex:b.retryDate?p.nextIndex:index,nextDate:b.retryDate?p.nextDate:occurrenceDate(p.startDate,p.frequency,index)};put("recurringExpenses",template.id,data);audit(req.user,"recurring_generate","recurringExpenses",template.id,{generated,pending,dates});return {template:getDoc("recurringExpenses",template.id),generated,pending};
      });["recurringExpenses","expenses","authorizations"].forEach(broadcast);res.json(out);
    });
  }
  return {register,validate};
}
module.exports={createScheduling,occurrenceDate};
