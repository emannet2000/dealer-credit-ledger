"use strict";
function normalizeDealerProfile(input){
  const p={...input},parts=["firstName","middleName","lastName"];
  const hasParts=parts.some(k=>Object.hasOwn(p,k));
  for(const key of [...parts,"gender","nationality"]){
    if(p[key]==null)continue;
    if(typeof p[key]!=="string"||p[key].trim().length>80)throw new Error("Dealer name parts, gender and nationality must be text of at most 80 characters.");
    p[key]=p[key].trim();
  }
  if(hasParts){
    if(!p.firstName||!p.lastName)throw new Error("Enter both the dealer's first name and last name.");
    p.middleName=p.middleName||"";p.name=[p.firstName,p.middleName,p.lastName].filter(Boolean).join(" ");
  }
  if(p.age===""||p.age==null){if(Object.hasOwn(p,"age"))p.age=null;}
  else {if(!["number","string"].includes(typeof p.age)||!Number.isInteger(Number(p.age))||Number(p.age)<0||Number(p.age)>120)throw new Error("Dealer age must be a whole number from 0 to 120, or left blank.");p.age=Number(p.age);}
  if(typeof p.name!=="string"||!p.name.trim())throw new Error("A dealer needs a name.");p.name=p.name.trim();
  return p;
}
module.exports={normalizeDealerProfile};
