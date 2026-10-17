import { randomBytes } from 'node:crypto'
import { samples } from './samples.mjs'
const fail=(message,code='UNAVAILABLE')=>Object.assign(new Error(message),{code})
const stableKeys=['start','end','contentlength','sd']
export function mediaIdentity(value){const u=new URL(value);return u.pathname+'?'+stableKeys.filter(k=>u.searchParams.has(k)).map(k=>k+'='+u.searchParams.get(k)).join('&')}
export function validateMedia(value){
  const u=new URL(value)
  if(u.protocol!=='https:' || !/(^|\.)(71edge\.com|iqiyi\.com|qiyi\.com)$/.test(u.hostname) || u.username || u.password)throw fail('官方媒体地址不受支持')
  return u
}
export function parseManifest(text,expectedSeconds){
  if(!text.startsWith('#EXTM3U') || !/^#EXT-X-ENDLIST\s*$/m.test(text))throw fail('官方未返回完整点播清单')
  if([...text.matchAll(/^#EXT-X-(?:SESSION-)?KEY:METHOD=([^,\r\n]+)/gm)].some(m=>m[1]!=='NONE') || /#EXT-X-MAP:|#EXT-X-STREAM-INF:/.test(text))throw fail('此格式或加密内容需要官方播放器','UNSUPPORTED')
  const lines=[],segments=[];let duration=0,part=NaN,partLine=-1
  for(const raw of text.split('\n')){
    const line=raw.trim()
    if(line.startsWith('#EXTINF:')){part=Number(line.match(/^#EXTINF:([\d.]+)/)?.[1]??NaN);partLine=lines.length}
    if(line && !line.startsWith('#')){
      const u=validateMedia(line)
      // Some official full episodes include zero-duration TS placeholders.
      // They carry no timeline time and must not become playable fragments.
      if(part===0&&u.pathname.endsWith('.ts')){lines.splice(partLine);part=NaN;continue}
      if(!(part>0) || !u.pathname.endsWith('.ts'))throw fail('官方清单分片格式不受支持')
      lines.push({segment:segments.length})
      segments.push({url:u.href,identity:mediaIdentity(u),duration:part,start:duration})
      duration+=part;part=NaN
    }else lines.push({text:raw})
  }
  if(!segments.length || Math.abs(duration-expectedSeconds)>10)throw fail('此内容只获试看或未返回完整片长','NOT_AUTHORIZED')
  return {lines,segments,duration,origins:[...new Set(segments.map(s=>new URL(s.url).origin))],paths:new Set(segments.map(s=>new URL(s.url).pathname))}
}
// Every resolve opens the official player in Chromium (#182-class CPU on NAS boxes), so:
// - ttlMs is a hard ceiling for serving a ticket without re-verification, not a renewal
//   cadence. Official signatures carry only an issue time (qd_tm), no expiry, so the real
//   lifetime is learned: when the CDN first refuses a ticket, later tickets renew a little
//   before that age (never earlier than minLifetimeMs).
// - A verdict (full rights confirmed) lasts verdictTtlMs and is what the exported playlist
//   publishes; a playable ticket is only fetched when someone actually plays.
export function createRuntime({resolve,fetchImpl=fetch,now=Date.now,ttlMs=1800000,refreshAheadMs=90000,minLifetimeMs=120000,verdictTtlMs=21600000,activeMs=600000,onEvent=()=>{},auto=true}={}){
  if(typeof resolve!=='function' || ttlMs<1000 || refreshAheadMs<=0 || refreshAheadMs>=ttlMs)throw new Error('Invalid resolver/cache configuration')
  const entries=new Map(),prefix=randomBytes(4).toString('hex'),controller=new AbortController()
  let serial=Promise.resolve(),counter=0,closed=false,epoch=0,lifetime=ttlMs
  const renewAfter=()=>Math.max(Math.min(minLifetimeMs,ttlMs-refreshAheadMs),lifetime-refreshAheadMs)
  function entry(id){
    if(!samples.some(s=>s.id===id))throw fail('未知影视样本','NOT_FOUND')
    if(!entries.has(id))entries.set(id,{id,generations:new Map(),lastAccess:-Infinity,refreshCount:0})
    return entries.get(id)
  }
  function emit(event){try{Promise.resolve(onEvent({...event,at:now()})).catch(()=>{})}catch{}}
  function refresh(id,{reason='manual',failedVersion,manual=false}={}){
    const e=entry(id)
    if(closed)return Promise.reject(fail('测试服务已停止'))
    if(failedVersion && e.current && e.current.version!==failedVersion && e.current.expiresAt>now() && !e.revoked)return Promise.resolve(e.current)
    if(e.pending)return e.pending
    // skipped: no browser was opened, so callers must not count this as a verification.
    if(!manual && e.retryAt>now())return Promise.reject(Object.assign(fail(e.lastError||'官方解析暂不可用',e.revoked?'NOT_AUTHORIZED':'UNAVAILABLE'),{skipped:true}))
    const startedEpoch=epoch
    const task=serial.catch(()=>{}).then(async()=>{
      if(closed)throw fail('测试服务已停止')
      emit({id,reason,outcome:'started'})
      try{
        const sample=samples.find(s=>s.id===id),result=await resolve(sample,{signal:controller.signal,renewal:e.current&&!e.revoked&&e.current.expectedSeconds===sample.expectedSeconds?{bid:e.current.bid}:null})
        if(closed||startedEpoch!==epoch)throw fail('账号授权已变化，请重新播放','AUTH_REQUIRED')
        const parsed=parseManifest(result.text,sample.expectedSeconds)
        const issued=now(),value={...parsed,id,officialPage:sample.url,expectedSeconds:sample.expectedSeconds,bid:result.bid,version:prefix+'-'+(++counter),createdAt:issued,expiresAt:issued+ttlMs,renewAt:issued+renewAfter(),lastAccess:issued,checks:result.checks||[],danmaku:result.danmaku||null}
        value.byIdentity=new Map(value.segments.map(s=>[s.identity,s]))
        e.current=value;e.generations.set(value.version,value);e.revoked=false;e.retryAt=0;e.lastError='';e.refreshCount++;e.lastReason=reason;e.verifiedAt=issued
        emit({id,reason,outcome:'success',version:value.version,expiresAt:value.expiresAt,segments:value.segments.length})
        return value
      }catch(error){
        e.lastError=error.code==='NOT_AUTHORIZED'?'官方只获试看或登录权益不足；未发布播放清单':'官方解析暂未完成，请稍后重试'
        e.retryAt=now()+30000
        if(error.code==='NOT_AUTHORIZED'){e.revoked=true;e.verifiedAt=0}
        emit({id,reason,outcome:'failed',code:error.code||'UNAVAILABLE'})
        throw fail(e.lastError,error.code||'UNAVAILABLE')
      }
    })
    serial=task.catch(()=>{})
    e.pending=task.finally(()=>{e.pending=null})
    return e.pending
  }
  async function get(id){
    const e=entry(id);e.lastAccess=now()
    if(e.revoked && e.retryAt>now())throw fail(e.lastError,'NOT_AUTHORIZED')
    if(e.current && !e.revoked && e.current.expiresAt>now()){
      if(e.current.renewAt<=now() && !e.pending && !(e.retryAt>now()))refresh(id,{reason:'refresh-ahead'}).catch(()=>{})
      return e.current
    }
    return refresh(id,{reason:e.current?'expired':'cold-start'})
  }
  async function manifest(id){
    const value=await get(id);value.lastAccess=now()
    const text=value.lines.map(line=>line.segment!==undefined?`/media/${id}/${value.version}/${line.segment}.ts`:line.text).join('\n')
    // Full, ENDLIST-verified VOD must be recognizable from a bounded head read.
    // Long films can put ENDLIST beyond a player's 64 KiB probe window.
    return text.replace(/^#EXT-X-PLAYLIST-TYPE:.*\r?\n?/gm,'').replace('#EXTM3U','#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD')
  }
  function targetFor(segment,current){
    const match=current.byIdentity.get(segment.identity)
    if(match)return match.url
    const old=validateMedia(segment.url)
    if(!current.paths.has(old.pathname) || [...old.searchParams.keys()].some(k=>!stableKeys.includes(k)))throw fail('清晰度或分片结构已变化，请重新加载播放清单','SEGMENT_CHANGED')
    // Keep the original generation's file and byte range. Only update its CDN
    // using a newly verified, full authorization for this same fixed sample.
    return new URL(old.pathname+old.search,current.origins[0]).href
  }
  async function media(id,version,index,{method='GET',range,signal}={}){
    const e=entry(id),generation=e.generations.get(version)
    const segment=generation?.segments[index]
    if(!segment)throw fail('播放清单已失效，请重新打开','NOT_FOUND')
    let current=await get(id)
    generation.lastAccess=now()
    async function request(value){
      if(signal?.aborted)throw fail('客户端已断开')
      const response=await fetchImpl(targetFor(segment,value),{method,headers:{Referer:value.officialPage,'User-Agent':'Mozilla/5.0',...(range?{Range:range}:{})},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)})
      return response
    }
    let response
    try{response=await request(current)}catch(error){if(signal?.aborted || error.code==='SEGMENT_CHANGED')throw error}
    const invalid=r=>!r || [401,403,404,405,410].includes(r.status) || (r.ok && /json|html|xml/.test(r.headers.get('content-type')||''))
    if(invalid(response)){
      await response?.body?.cancel().catch(()=>{})
      const refusedAge=[401,403,410].includes(response?.status)?now()-current.createdAt:null
      emit({id,outcome:'media-retry',reason:response?'http-'+response.status:'network',version})
      current=await refresh(id,{reason:'upstream-refused',failedVersion:current.version})
      response=await request(current)
      if(invalid(response)){
        await response?.body?.cancel().catch(()=>{})
        e.retryAt=now()+30000;e.lastError='官方分片续期后仍不可用，请稍后重试'
        throw fail(e.lastError)
      }
      // Only a refusal that a fresh ticket cures says how long official tickets really last
      // (exit-IP refusals unrelated to signatures fail the retry too); renew before that age.
      if(refusedAge!==null&&refusedAge>=minLifetimeMs&&refusedAge<lifetime){lifetime=refusedAge;emit({id,outcome:'lifetime-learned',lifetimeMs:refusedAge})}
    }
    if(e.revoked || current.expiresAt<=now()){
      await response.body?.cancel().catch(()=>{})
      throw fail(e.revoked?'当前没有完整观看权限；已停止供流':'授权缓存已到期，请重新核验',e.revoked?'NOT_AUTHORIZED':'UNAVAILABLE')
    }
    return response
  }
  function status(){return samples.map(sample=>{
    const e=entries.get(sample.id),v=e?.current
    return {id:sample.id,url:sample.url,title:sample.title,seconds:sample.expectedSeconds,state:e?.revoked?'denied':v&&v.expiresAt>now()?'ready':e?.lastError?'failed':v?'expired':'unresolved',verified:!e?.revoked&&e?.verifiedAt>now()-verdictTtlMs,verifiedAt:e?.verifiedAt||null,resolving:!!e?.pending,version:v?.version||null,refreshedAt:v?.createdAt||null,expiresAt:v?.expiresAt||null,nextRefreshAt:v?.renewAt||null,refreshCount:e?.refreshCount||0,lastReason:e?.lastReason||null,lastError:e?.lastError||'',ttlMs,refreshAheadMs}
  })}
  async function tick(){
    const jobs=[]
    for(const [id,e] of entries){
      for(const [version,g] of e.generations)if(g!==e.current && g.lastAccess<now()-1800000)e.generations.delete(version)
      if(e.current && e.lastAccess>now()-activeMs && e.current.renewAt<=now() && !e.pending && !(e.retryAt>now()))jobs.push(refresh(id,{reason:'refresh-ahead'}))
    }
    await Promise.allSettled(jobs)
  }
  const timer=auto?setInterval(()=>{void tick()},5000):null
  timer?.unref()
  function snapshot(){
    return [...entries.values()].filter(e=>!e.revoked&&e.current?.expiresAt>now()).map(e=>{
      const v=e.current
      return {id:e.id,version:v.version,createdAt:v.createdAt,expiresAt:v.expiresAt,renewAt:v.renewAt,lastAccess:e.lastAccess,danmaku:v.danmaku,bid:v.bid,verifiedAt:e.verifiedAt,
        text:v.lines.map(line=>line.segment!==undefined?v.segments[line.segment].url:line.text).join('\n')}
    })
  }
  function restore(rows){
    for(const row of rows){
      try{
        if(!Number.isFinite(row.createdAt)||row.createdAt>now()||!(row.expiresAt>now())||row.expiresAt>row.createdAt+ttlMs||!(/^[a-f0-9]+-\d+$/.test(row.version)))continue
        const sample=samples.find(s=>s.id===row.id);if(!sample)continue
        const parsed=parseManifest(row.text,sample.expectedSeconds),e=entry(row.id)
        const value={...parsed,id:row.id,officialPage:sample.url,expectedSeconds:sample.expectedSeconds,bid:row.bid,version:row.version,createdAt:row.createdAt,expiresAt:row.expiresAt,renewAt:Math.min(row.renewAt||row.createdAt+renewAfter(),row.createdAt+renewAfter()),lastAccess:now(),danmaku:row.danmaku}
        value.byIdentity=new Map(value.segments.map(s=>[s.identity,s]));e.current=value;e.generations.set(value.version,value);e.lastAccess=Number(row.lastAccess)||-Infinity;e.refreshCount=1;e.lastReason='verified-cache-restored';e.verifiedAt=Math.min(Number(row.verifiedAt)||row.createdAt,row.createdAt)
      }catch{}
    }
  }
  async function verify(id){
    const e=entry(id)
    if(e.revoked && e.retryAt>now())throw fail(e.lastError,'NOT_AUTHORIZED')
    if(e.current && !e.revoked && e.current.expiresAt>now())return {cached:true}
    if(!e.revoked && e.verifiedAt>now()-verdictTtlMs)return {cached:true}
    await refresh(id,{reason:'playlist-verification'})
    return {cached:false}
  }
  return {snapshot,restore,reset(){epoch++;entries.clear();lifetime=ttlMs},get,verify,manifest,media,status,tick,refresh:(id)=>{entry(id).lastAccess=now();return refresh(id,{reason:'manual',manual:true})},async close(){closed=true;clearInterval(timer);controller.abort();await serial}}
}
