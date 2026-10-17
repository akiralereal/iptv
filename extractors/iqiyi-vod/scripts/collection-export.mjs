import {danmakuAttribute} from './unified-danmaku.mjs'
const scopes=['all','recommend','hot','new','history']
const fail=message=>Object.assign(new Error(message),{code:'UNAVAILABLE'})
const clean=value=>String(value).replace(/[\r\n"]/g,' ')
// Each fresh verification opens the official player in Chromium (#182). A round checks at most
// roundLimit titles without a current verdict; player subscriptions start a round themselves at
// most every autoCooldownMs, the browse page's button any time.
export function createCollectionExport({load,runtime,origin,initialEntries=[],now=Date.now,roundLimit=20,autoCooldownMs=7200000}={}){
 let epoch=0,retrySoon=false;let entries=initialEntries,warnings=[],pending=null,closed=false,finished=false,checked=0,denied=0,failed=0,skipped=0,startedAt=null,finishedAt=null,current='',error=''
 const listeners=new Set()
 function notify(){for(const listener of [...listeners])listener()}
 function rows(scope='all'){
  if(!scopes.includes(scope))throw Object.assign(Error('未知清单分类'),{code:'NOT_FOUND'})
  const ready=new Set(runtime.status().filter(row=>row.verified).map(row=>row.id))
  return entries.filter(entry=>(scope==='all'||entry.scope===scope)&&ready.has(entry.sample.id))
 }
 function status(){return {running:!!pending,finished,startedAt,finishedAt,total:new Set(entries.map(e=>e.sample.id)).size,checked,denied,failed,skipped,current,error,warnings,ready:Object.fromEntries(scopes.map(scope=>[scope,rows(scope).length]))}}
 function start({keepReady=false}={}){
  if(closed)throw fail('清单服务已停止')
  if(pending)return pending
  const generation=++epoch
  // Keep serving the previous round's entries until the new directory has been read.
  warnings=[];checked=denied=failed=skipped=0;startedAt=now();finishedAt=null;finished=false;current='正在读取首页与观看历史';error=''
  pending=(async()=>{
   try{
    let queue=Promise.resolve(),fresh=0,received=false,limited=false
    const seen=new Set()
    const batch=items=>{
      if(closed||generation!==epoch)return
      if(!received){if(!keepReady)entries=[];received=true}
      entries=[...new Map([...entries,...items].map(entry=>[entry.scope+'|'+entry.sample.id,entry])).values()]
      const verifiedAt=new Map(runtime.status().map(row=>[row.id,row.verifiedAt||0]))
      const unique=[...new Map(items.map(entry=>[entry.sample.id,entry.sample])).values()].sort((a,b)=>(verifiedAt.get(a.id)||0)-(verifiedAt.get(b.id)||0))
      notify()
      for(const sample of unique){
        if(seen.has(sample.id))continue;seen.add(sample.id)
        queue=queue.then(async()=>{
          if(closed||generation!==epoch)return
          if(fresh>=roundLimit){limited=true;return}
          current=sample.title;notify()
          try{if(!(await runtime.verify(sample.id))?.cached)fresh++}catch(error){if(!error.skipped)fresh++;if(error.code==='NOT_AUTHORIZED')denied++;else failed++}
          if(generation!==epoch)return
          checked++;notify()
        })
      }
    }
    const data=await load(batch);if(generation!==epoch)return;batch(data.entries)
    const currentKeys=new Set(data.entries.map(e=>e.scope+'|'+e.sample.id))
    entries=entries.filter(e=>currentKeys.has(e.scope+'|'+e.sample.id))
    warnings=data.warnings||[];skipped=data.skipped||0
    await queue
    if(limited)warnings=[...warnings,`本轮已核验 ${roundLimit} 条，其余下一轮继续`]
    if(!closed&&generation===epoch)finished=true
   }catch(cause){entries=[];error=cause.message;warnings=[...warnings,'片单读取未完成，请重试'];retrySoon=true}
   // A failed directory read is retried after 5 minutes instead of waiting out the cooldown.
   finally{if(generation!==epoch)return;current='';finishedAt=retrySoon?now()-autoCooldownMs+300000:now();retrySoon=false;pending=null;notify()}
  })()
  return pending
 }
 function text(scope='all',outputOrigin=origin){
  const published=rows(scope)
  if(!published.length)throw fail('该分类暂无当前完整权限核验通过的内容；请查看页面清单生成进度')
  return '#EXTM3U\n'+published.map(({sample,group})=>`#EXTINF:-1 group-title="${clean(group)}"${danmakuAttribute(sample.id,outputOrigin)},${clean(sample.title)}\n${outputOrigin}/play/${sample.id}.m3u8`).join('\n')+'\n'
 }
 async function playlist(scope='all',{waitMs=55000,origin:outputOrigin=origin}={}){
  rows(scope)
  const due=!pending&&(finishedAt===null||now()-finishedAt>=autoCooldownMs)
  if(rows(scope).length){if(due)void start();return text(scope,outputOrigin)}
  if(due)void start()
  if(!pending)return text(scope,outputOrigin)
  await new Promise(resolve=>{
   const listener=()=>{if(closed||rows(scope).length||!pending){clearTimeout(timer);listeners.delete(listener);resolve()}}
   const timer=setTimeout(()=>{listeners.delete(listener);resolve()},waitMs)
   listeners.add(listener);listener()
  })
  return text(scope,outputOrigin)
 }
 return {exportEntries:()=>rows(),invalidate(){epoch++;entries=[];pending=null;finished=false;finishedAt=null;checked=denied=failed=skipped=0;current='';notify()},start,status,text,playlist,async close(){closed=true;notify();await pending}}
}
