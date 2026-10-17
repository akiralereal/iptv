import {createHash,createHmac,timingSafeEqual,randomBytes} from 'node:crypto'
import {readFile,writeFile,rename,mkdir,rm} from 'node:fs/promises'
import path from 'node:path'
import {samples,registerHistorySample,registerCatalogSample} from './samples.mjs'
// Private, signed process-restart cache. Never extend the original rights deadline.
export function createWarmCache({directory,fingerprint}){
 let serial=Promise.resolve(),key
 let account=fingerprint(),epoch=0
 const file=path.join(directory,'verified-warm-cache.json')
 async function signingKey(){
  if(key)return key
  await mkdir(directory,{recursive:true,mode:0o700})
  const name=path.join(directory,'verified-warm-cache.key')
  try{key=await readFile(name)}catch(e){if(e.code!=='ENOENT')throw e;key=randomBytes(32);await writeFile(name,key,{mode:0o600,flag:'wx'})}
  return key
 }
 async function load(runtime){
  try{
   const raw=await readFile(file);if(raw.length>16*1024*1024)return []
   const {payload,signature}=JSON.parse(raw),expected=createHmac('sha256',await signingKey()).update(payload).digest(),actual=Buffer.from(signature,'hex')
   if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return []
   const data=JSON.parse(payload)
   if(data.account!==await account||await fingerprint()!==await account||!Array.isArray(data.entries)||!Array.isArray(data.snapshots))return []
   for(const {sample} of data.entries){
    if(sample.id.startsWith('history-'))registerHistorySample({...sample,supported:true,duration:sample.expectedSeconds})
    else if(sample.id.startsWith('catalog-'))registerCatalogSample({...sample,episodeSeconds:sample.expectedSeconds})
   }
   runtime.restore(data.snapshots)
   const ready=new Set(runtime.status().filter(r=>r.state==='ready').map(r=>r.id))
   return data.entries.filter(e=>ready.has(e.sample.id)&&samples.some(s=>s.id===e.sample.id))
  }catch{return []}
 }
 function save(runtime,entries){
  const generation=epoch,snapshots=runtime.snapshot(),ids=new Set(snapshots.map(s=>s.id))
  const published=entries.filter(e=>ids.has(e.sample.id))
  serial=serial.catch(()=>{}).then(async()=>{
   if(generation!==epoch)return
   if(await fingerprint()!==await account){await rm(file,{force:true});return}
   const payload=JSON.stringify({account:await account,entries:published,snapshots})
   const signature=createHmac('sha256',await signingKey()).update(payload).digest('hex')
   await writeFile(file+'.tmp',JSON.stringify({payload,signature}),{mode:0o600});await rename(file+'.tmp',file)
  });return serial
 }
 return {load,save,async reset(){epoch++;await serial.catch(()=>{});await rm(file,{force:true});account=fingerprint();await account},flush:()=>serial}
}
export async function loginFingerprint(directory){
 const hash=createHash('sha256')
 try{
  const marker=await readFile(path.join(directory,'snapshot-path.txt'),'utf8'),profile=path.resolve(marker.trim())
  if(!profile.startsWith(path.resolve(directory)+path.sep))throw Error('Invalid isolated profile')
  hash.update(marker)
  for(const name of ['Local State','Default/Cookies','Default/Cookies-wal','Default/Network/Cookies','Default/Network/Cookies-wal']){
   hash.update(name);try{hash.update(await readFile(path.join(profile,name)))}catch(e){if(e.code!=='ENOENT')throw e}
  }
 }catch(e){if(e.code!=='ENOENT')throw e;hash.update('anonymous')}
 return hash.digest('hex')
}
