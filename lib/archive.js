"use strict";
const fs=require("node:fs"),path=require("node:path"),{Readable}=require("node:stream"),{createGzip}=require("node:zlib");
function header(name,size,mtime){
  const h=Buffer.alloc(512),write=(s,start,length)=>h.write(String(s),start,length,"ascii"),oct=(n,start,length)=>write(Math.floor(n).toString(8).padStart(length-1,"0")+"\0",start,length);
  const split=name.lastIndexOf("/");if(Buffer.byteLength(name)>100){const prefix=name.slice(0,split),base=name.slice(split+1);if(Buffer.byteLength(prefix)>155||Buffer.byteLength(base)>100)throw new Error("Backup archive name is too long.");write(base,0,100);write(prefix,345,155);}else write(name,0,100);
  oct(0o600,100,8);oct(0,108,8);oct(0,116,8);oct(size,124,12);oct(mtime,136,12);h.fill(32,148,156);write("0",156,1);write("ustar\0",257,6);write("00",263,2);oct(h.reduce((n,b)=>n+b,0),148,7);h[155]=32;return h;
}
function snapshotArchive(file){
  const root=path.dirname(file),manifest=JSON.parse(fs.readFileSync(file+".manifest.json","utf8"));
  if(path.basename(manifest.photoDir)!==manifest.photoDir||!manifest.photoDir.startsWith(path.basename(file)+".photos-"))throw new Error("Invalid backup photo directory.");
  const names=[path.basename(file),path.basename(file)+".manifest.json",...manifest.photos.map(p=>{if(!/^[A-Za-z0-9_-]{1,80}$/.test(p.id))throw new Error("Invalid backup photo identifier.");return manifest.photoDir+"/"+p.id;})];
  async function* blocks(){
    for(const name of names){const filename=path.join(root,name),stat=fs.statSync(filename);yield header(name,stat.size,stat.mtimeMs/1000);for await(const block of fs.createReadStream(filename))yield block;const padding=(512-stat.size%512)%512;if(padding)yield Buffer.alloc(padding);}
    const instructions=Buffer.from("FULL LEDGER BACKUP\n\nKeep the database, manifest and photo directory together. Stop the ledger server before restoring. Move aside the current ledger.db, ledger.db-wal and ledger.db-shm files and keep them as a safety copy. Copy the .db file to DATA_DIR/ledger.db and photo files to DATA_DIR/uploads using their existing names, then restart. Full backups contain account credentials; store them privately. JSON import restores records only, not these photos or accounts. Use the application's backup recovery check before relying on a backup.\n");
    yield header("RESTORE.txt",instructions.length,Date.now()/1000);yield instructions;yield Buffer.alloc((512-instructions.length%512)%512);yield Buffer.alloc(1024);
  }
  const source=Readable.from(blocks()),gzip=createGzip();source.on("error",e=>gzip.destroy(e));source.pipe(gzip);return gzip;
}
module.exports={snapshotArchive};
