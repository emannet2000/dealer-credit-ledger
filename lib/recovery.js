"use strict";
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const Database=require("better-sqlite3");
const digest=file=>crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const safeId=id=>typeof id==="string"&&/^[A-Za-z0-9_-]{1,80}$/.test(id);
function publishSnapshot(temporary,file,uploads){
  const photoDir=path.basename(file)+".photos-"+crypto.randomUUID(),folder=path.join(path.dirname(file),photoDir);
  fs.mkdirSync(folder);let snapshot;
  try{
    snapshot=new Database(temporary,{readonly:true,fileMustExist:true});
    const assets=snapshot.prepare("SELECT id,size,content_type FROM assets").all();
    const photos=assets.map(a=>{
      if(!safeId(a.id))throw new Error("Invalid photo identifier in backup.");
      const source=path.join(uploads,a.id),target=path.join(folder,a.id);
      if(!fs.existsSync(source))throw new Error("A ledger photo is missing. Restore the missing photo before backing up.");
      fs.copyFileSync(source,target);
      if(fs.statSync(target).size!==a.size)throw new Error("A ledger photo has an unexpected size.");
      return {id:a.id,size:a.size,type:a.content_type,sha256:digest(target)};
    });
    const records=snapshot.prepare("SELECT collection,COUNT(*) count FROM docs GROUP BY collection ORDER BY collection").all();
    const manifest={version:1,at:Date.now(),database:{sha256:digest(temporary),size:fs.statSync(temporary).size},photoDir,photos,records};
    snapshot.close();snapshot=null;
    // Publish the manifest last; recovery checks reject mismatched or incomplete sets.
    const manifestTemp=temporary+".manifest.json";fs.writeFileSync(manifestTemp,JSON.stringify(manifest));
    let previous;try{previous=JSON.parse(fs.readFileSync(file+".manifest.json","utf8"));}catch{}
    fs.renameSync(temporary,file);fs.renameSync(manifestTemp,file+".manifest.json");
    if(previous?.photoDir&&path.basename(previous.photoDir)===previous.photoDir&&previous.photoDir.startsWith(path.basename(file)+".photos-"))fs.rmSync(path.join(path.dirname(file),previous.photoDir),{recursive:true,force:true});
    return manifest;
  }catch(e){if(snapshot)snapshot.close();fs.rmSync(folder,{recursive:true,force:true});throw e;}
}
function verifySnapshot(file){
  const checkedAt=Date.now(),errors=[];let temp,restored;
  try{
    const manifest=JSON.parse(fs.readFileSync(file+".manifest.json","utf8"));
    if(manifest.version!==1||!Array.isArray(manifest.photos)||!Array.isArray(manifest.records)||!manifest.photoDir?.startsWith(path.basename(file)+".photos-")||path.basename(manifest.photoDir)!==manifest.photoDir)throw new Error("This backup has no supported photo manifest. Create a new full backup first.");
    if(digest(file)!==manifest.database.sha256)throw new Error("Database backup checksum does not match.");
    temp=fs.mkdtempSync(path.join(os.tmpdir(),"ledger-recovery-check-"));fs.mkdirSync(path.join(temp,"uploads"));
    fs.copyFileSync(file,path.join(temp,"ledger.db"));
    for(const photo of manifest.photos){
      if(!safeId(photo.id))throw new Error("Backup contains an invalid photo identifier.");
      const source=path.join(path.dirname(file),manifest.photoDir,photo.id);
      if(!fs.existsSync(source)||fs.statSync(source).size!==photo.size||digest(source)!==photo.sha256)throw new Error("A backup photo is missing or its checksum does not match.");
      fs.copyFileSync(source,path.join(temp,"uploads",photo.id));
    }
    restored=new Database(path.join(temp,"ledger.db"),{fileMustExist:true});
    if(restored.pragma("integrity_check",{simple:true})!=="ok"||restored.pragma("foreign_key_check").length)throw new Error("Restored database failed its integrity check.");
    const records=restored.prepare("SELECT collection,COUNT(*) count FROM docs GROUP BY collection ORDER BY collection").all();
    if(JSON.stringify(records)!==JSON.stringify(manifest.records))throw new Error("Restored record counts do not match the backup.");
    const assets=restored.prepare("SELECT id,size FROM assets").all(),photoMap=new Map(manifest.photos.map(a=>[a.id,a]));
    if(assets.length!==photoMap.size||assets.some(a=>photoMap.get(a.id)?.size!==a.size))throw new Error("Restored photo records do not match the backup files.");
    for(const row of restored.prepare("SELECT collection,data FROM docs").all()){
      const data=JSON.parse(row.data);
      if(row.collection==="products"&&data.imageId&&!photoMap.has(data.imageId))errors.push("A product references a photo absent from this backup.");
      if(row.collection==="expenses"&&(data.attachments||[]).some(a=>!photoMap.has(a.id)))errors.push("An expense references a document absent from this backup.");
      if(row.collection==="deliveries"&&[data,...(data.history||[])].some(d=>[d.signatureAssetId,d.proofAssetId].filter(Boolean).some(id=>!photoMap.has(id))))errors.push("A delivery references proof absent from this backup.");
      if(row.collection==="revisions"&&(data.before?.attachments||[]).some(a=>!photoMap.has(a.id)))errors.push("Expense correction history references a missing document.");
    }
    return {file:path.basename(file),checkedAt,ok:!errors.length,records:records.reduce((n,r)=>n+r.count,0),photos:assets.length,errors};
  }catch(e){return {file:path.basename(file),checkedAt,ok:false,records:0,photos:0,errors:[e.code==="ENOENT"?"A required backup file or photo manifest is missing. Create a new full backup.":e.message]};}
  finally{if(restored)restored.close();if(temp)fs.rmSync(temp,{recursive:true,force:true});}
}
function removeSnapshot(file){
  let manifest;try{manifest=JSON.parse(fs.readFileSync(file+".manifest.json","utf8"));}catch{}
  fs.rmSync(file,{force:true});fs.rmSync(file+".manifest.json",{force:true});
  if(manifest?.photoDir&&path.basename(manifest.photoDir)===manifest.photoDir&&manifest.photoDir.startsWith(path.basename(file)+".photos-"))fs.rmSync(path.join(path.dirname(file),manifest.photoDir),{recursive:true,force:true});
}
module.exports={publishSnapshot,verifySnapshot,removeSnapshot};
