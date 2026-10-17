import {createWarmCache,loginFingerprint} from './warm-cache.mjs'
import { restoreSamples, saveSamples } from '../sample-store.js'
import { runtimeDir } from '../paths.js'
import { createVODAuth } from '../auth.js'
import {createUnifiedDanmaku} from './unified-danmaku.mjs'
import { authorizedPlaylist } from './playlist.mjs'
import { createCollectionExport } from './collection-export.mjs'
import { readFile, mkdir, appendFile, stat, rename } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createDanmaku } from './danmaku.mjs'
import { createRuntime } from './runtime.mjs'
import { resolveOfficial } from './worker.mjs'
import { samples,registerHistorySample,registerCatalogSample } from './samples.mjs'
import { createHistory,resumePosition } from './history.mjs'
import { createCatalog } from './catalog.mjs'
import { createEpisodes,nextEpisode } from './episodes.mjs'
import { createProgress,progressId } from './progress.mjs'
const root=fileURLToPath(new URL('../',import.meta.url))
export async function createVODService({resolve = resolveOfficial, catalog: suppliedCatalog, history: suppliedHistory, episodes: suppliedEpisodes, danmaku: suppliedDanmaku, auth: suppliedAuth, auto = true, runtimeOptions = {}} = {}) {
await mkdir(runtimeDir,{recursive:true,mode:0o700})
await restoreSamples()
const auth = suppliedAuth || createVODAuth()
// Login problems reach the alert center only once the official account API confirms them:
// a preview also happens to a valid account that lacks this title's rights.
let rejected='',accountCheckedAt=-Infinity,accountCheck
function confirmLoginSoon(){
 if(!auth.checkAccount||accountCheck||Date.now()-accountCheckedAt<600000)return
 accountCheckedAt=Date.now()
 accountCheck=auth.checkAccount().then(()=>{rejected=''},error=>{if(error.credential)rejected=error.message}).finally(()=>{accountCheck=undefined})
}
const trackedResolve=async(sample,options)=>{
 try{return await resolve(sample,options)}
 catch(error){if(error.code==='NOT_AUTHORIZED')confirmLoginSoon();throw error}
}
const warmCache=auto?createWarmCache({directory:runtimeDir,fingerprint:()=>loginFingerprint(runtimeDir)}):null
let collectionExport,prewarmed=false
const eventsFile=path.join(runtimeDir,'renewals.ndjson')
async function logEvent(event){
 // Diagnostics only: keep the newest ~512 KiB plus one rotated file.
 try{if((await stat(eventsFile)).size>524288)await rename(eventsFile,eventsFile+'.1')}catch{}
 await appendFile(eventsFile,JSON.stringify(event)+'\n',{mode:0o600})
}
const runtime=createRuntime({...runtimeOptions,resolve:trackedResolve,auto,
 ...(process.env.IQIYI_VOD_TICKET_MAX_MS?{ttlMs:Number(process.env.IQIYI_VOD_TICKET_MAX_MS)}:{}),
 ...(process.env.IQIYI_VOD_REFRESH_AHEAD_MS?{refreshAheadMs:Number(process.env.IQIYI_VOD_REFRESH_AHEAD_MS)}:{}),
 onEvent:async event=>{await logEvent(event);if(warmCache&&collectionExport&&['success','failed'].includes(event.outcome))await warmCache.save(runtime,collectionExport.exportEntries())}})
const catalog=suppliedCatalog || createCatalog()
const episodes=suppliedEpisodes || createEpisodes()
const danmaku=suppliedDanmaku || createDanmaku()
const unifiedDanmaku=createUnifiedDanmaku({runtime,danmaku,samples})
const history=suppliedHistory || createHistory()
const progress=createProgress({file:path.join(runtimeDir,'history-progress.json')})
const fixedSamples=samples.filter(sample=>['movie','drama'].includes(sample.id))
const restoredEntries=warmCache?await warmCache.load(runtime):[]
collectionExport=createCollectionExport({initialEntries:restoredEntries,runtime,origin:'',load:async onBatch=>{
 const entries=[],warnings=[];let skipped=0
 const sources=[['recommend','首页推荐'],['hot','首页最热'],['new','首页最新'],['history','观看历史']]
 await Promise.all(sources.map(async([scope,label])=>{
  try{
   const data=scope==='history'?await playbackOwner().then(owner=>progress.apply(owner)):await catalog.get(scope),batch=[]
   for(const item of data.items){
    try{
     const sample=scope==='history'&&!item.id.startsWith('video-')?registerHistorySample(item):registerCatalogSample({...item,episodeSeconds:scope==='history'?item.duration:item.episodeSeconds})
     batch.push({scope,group:'爱奇艺 · '+label,sample})
    }catch{skipped++}
   }
   await saveSamples();entries.push(...batch);onBatch(batch)
  }catch{warnings.push(label+'读取失败，未用旧列表代替')}
 }))
 await saveSamples()
 return {entries,warnings,skipped}
}})

const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
function json(res,status,data){res.writeHead(status,{'content-type':'application/json;charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))}
async function playbackOwner(options){try{return await history.get(options)}catch(error){if(error.code==='AUTH_REQUIRED')return {accountKey:'anonymous',items:[]};throw error}}
async function preparePlayback(video,owner,series,episodeId){
 const sample=registerCatalogSample(video);await saveSamples();const value=await runtime.get(sample.id)
 const cloud=owner.items.find(i=>i.url===video.url)
 const entry={...cloud,id:progressId(video),url:video.url,title:video.title,duration:value.duration,resumeSeconds:cloud?.resumeSeconds||0,watchedAt:cloud?.watchedAt||'0',completed:cloud?.completed||false,album:series?.title||cloud?.album||'',episode:video.order?String(video.order):cloud?.episode||''}
 const current=(await progress.apply({accountKey:owner.accountKey,items:[entry]})).items.find(i=>i.url===video.url)
 const continuation=series&&episodeId?{series,episodeId}:undefined,progressToken=progress.authorize(owner,entry,value.duration,continuation,{danmaku:value.danmaku})
 const next=continuation?nextEpisode(await episodes.get(series),episodeId):null
 return {title:video.title,manifest:'/play/'+sample.id+'.m3u8',resumeSeconds:resumePosition(current.resumeSeconds,value.duration,current.completed),duration:value.duration,progressId:progressId(entry),progressToken,danmakuAvailable:!!value.danmaku,verified:true,series:continuation?{albumId:series.albumId,episodeId,order:video.order}:null,next:next?.next?{id:next.next.id,title:next.next.title}:null,endReason:next?.reason||''}
}
async function handle(req,res,{path:requestPath, origin, prefix, admin = true}={}) {
  const controller=new AbortController()
  res.on('close',()=>{if(!res.writableFinished)controller.abort()})
  try{
    const url=new URL(requestPath,'http://127.0.0.1')
    const base=origin+prefix
    const originalJSON=json
    const reply=(status,data)=>originalJSON(res,status,rebase(data,prefix))
    if(!['GET','HEAD','POST'].includes(req.method)){json(res,405,{error:'不支持此方法'});return}
    // Playback uses the owner's membership, so user tokens get nothing here (owner's decision).
    if(!admin){json(res,403,{error:'爱奇艺影视仅管理员可用'});return}
    // Compare hosts only: behind an HTTPS reverse proxy without X-Forwarded-Proto the server
    // sees http:// while the browser sends https:// in Origin.
    if(auto&&admin&&!prewarmed&&['/','/playlist.m3u','/playlist/samples.m3u'].includes(url.pathname)){prewarmed=true;void collectionExport.start({keepReady:true})}
    if(req.method==='POST'&&req.headers.origin&&!sameHost(req.headers.origin,origin)){json(res,403,{error:'不允许跨站操作'});return}
    if(url.pathname==='/api/account'){
      if(req.method==='GET'){reply(200,auth.status());return}
      const input=await readBody(req,65536)
      const actions={check:'check',import:'import',start:'start',close:'close',cancel:'cancel'}
      if(!actions[input.action]){reply(400,{error:'未知账号操作'});return}
      if(input.action==='start'&&!isLocal(req)){reply(403,{error:'仅服务所在电脑可打开官方登录窗口；NAS 请导入 Cookie'});return}
      await auth[actions[input.action]](input.action==='import'?input.cookies:undefined)
      if(['check','import'].includes(input.action)){if(auth.status().authenticated)rejected='';runtime.reset();history.invalidate?.();progress.reset?.();collectionExport.invalidate?.();await warmCache?.reset();prewarmed=false}
      reply(200,auth.status());return
    }
    const bullets=url.pathname.match(/^\/api\/danmaku\/v1\/videos\/(movie|drama|(?:history|catalog)-[a-f0-9]{16})(\/segments)?$/)
    if(req.method==='GET'&&bullets){reply(200,bullets[2]?await unifiedDanmaku.segment(bullets[1],Number(url.searchParams.get('part'))):await unifiedDanmaku.metadata(bullets[1]));return}
    if(req.method==='GET'&&url.pathname==='/api/exports'){reply(200,collectionExport.status());return}
    if(req.method==='POST'&&url.pathname==='/api/exports/start'){void collectionExport.start();reply(202,collectionExport.status());return}
    if(req.method==='GET'&&url.pathname==='/api/history'){const data=await progress.apply(await playbackOwner({refresh:url.searchParams.get('refresh')==='1'}));const {accountKey,...publicData}=data;reply(200,publicData);return}
    if(req.method==='GET'&&url.pathname==='/api/home/episodes'){
      const data=await catalog.get(url.searchParams.get('tab')),item=data.items.find(i=>i.id===url.searchParams.get('id'))
      if(!item)throw Object.assign(new Error('官网片单已更新，请刷新片单'),{code:'NOT_FOUND'})
      const list=await episodes.get(item),owner=await playbackOwner();const applied=await progress.apply({accountKey:owner.accountKey,items:list.items.map(ep=>({...owner.items.find(i=>i.url===ep.url),...ep,duration:0,resumeSeconds:owner.items.find(i=>i.url===ep.url)?.resumeSeconds||0,watchedAt:owner.items.find(i=>i.url===ep.url)?.watchedAt||'0',percent:0,completed:owner.items.find(i=>i.url===ep.url)?.completed||false}))});const byUrl=new Map(applied.items.map(i=>[i.url,i]));reply(200,{...list,items:list.items.map(ep=>({...ep,resumeSeconds:byUrl.get(ep.url)?.resumeSeconds||0,completed:byUrl.get(ep.url)?.completed||false,watchedAt:byUrl.get(ep.url)?.watchedAt||'0'}))});return
    }
    if(req.method==='POST'&&url.pathname==='/api/home/prepare'){
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>2048)throw Object.assign(new Error('请求内容过大'),{code:'BAD_REQUEST'})}
      let input;try{input=JSON.parse(body)}catch{throw Object.assign(new Error('请求格式错误'),{code:'BAD_REQUEST'})}
      if(!input||typeof input.id!=='string'||typeof input.tab!=='string')throw Object.assign(new Error('片单标识无效'),{code:'BAD_REQUEST'})
      const data=await catalog.get(input.tab),item=data.items.find(i=>i.id===input.id)
      if(!item)throw Object.assign(new Error('官网片单已更新，请刷新片单'),{code:'NOT_FOUND'})
      let episodeId=input.episodeId
      if(episodeId===undefined&&Number(item.channelId)===2){const list=await episodes.get(item);episodeId=list.items.find(ep=>ep.url===item.url)?.id}
      const video=episodeId===undefined?item:await episodes.prepare(item,episodeId),owner=await playbackOwner()
      reply(200,await preparePlayback(video,owner,episodeId?item:undefined,episodeId));return
    }
    if(req.method==='POST'&&['/api/playback/next','/api/playback/progress','/api/playback/danmaku'].includes(url.pathname)){
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>2048)throw Object.assign(new Error('请求内容过大'),{code:'BAD_REQUEST'})}
      let input;try{input=JSON.parse(body)}catch{throw Object.assign(new Error('请求格式错误'),{code:'BAD_REQUEST'})}
      if(url.pathname==='/api/playback/progress'){const result=await progress.save(input);reply(200,{saved:!result.ignored,ignored:!!result.ignored});return}
      if(url.pathname==='/api/playback/danmaku'){
        const context=progress.context(input?.token),videoId=context.playback?.danmaku?.videoId
        if(!videoId)throw Object.assign(new Error('当前视频没有可用的影视弹幕入口'),{code:'UNSUPPORTED'})
        if(!Number.isInteger(input.part)||input.part<1||input.part>Math.ceil(context.duration/60))throw Object.assign(new Error('弹幕时间段无效'),{code:'BAD_REQUEST'})
        reply(200,await danmaku.get(videoId,input.part));return
      }
      const context=progress.context(input?.token),owner=await playbackOwner()
      if(owner.accountKey!==context.accountKey)throw Object.assign(new Error('当前账号已改变，请重新打开视频'),{code:'AUTH_REQUIRED'})
      const {series,episodeId}=context.continuation||{};if(!series)throw Object.assign(new Error('当前视频没有连续剧集'),{code:'UNSUPPORTED'})
      const result=nextEpisode(await episodes.get(series),episodeId)
      if(!result.next){reply(200,{finished:true,reason:result.reason});return}
      reply(200,await preparePlayback(await episodes.prepare(series,result.next.id),owner,series,result.next.id));return
    }
    if(req.method==='POST'&&['/api/history/prepare','/api/history/progress'].includes(url.pathname)){
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>2048)throw Object.assign(new Error('请求内容过大'),{code:'BAD_REQUEST'})}
      let input;try{input=JSON.parse(body)}catch{throw Object.assign(new Error('请求格式错误'),{code:'BAD_REQUEST'})}
      if(!input||typeof input.id!=='string'||!/^(history|video)-[a-f0-9]{16}$/.test(input.id))throw Object.assign(new Error('历史标识无效'),{code:'BAD_REQUEST'})
      if(url.pathname==='/api/history/progress'){const result=await progress.save(input);reply(200,{saved:!result.ignored,ignored:!!result.ignored});return}
      const data=await progress.apply(await playbackOwner()),item=data.items.find(i=>i.id===input.id)
      if(!item)throw Object.assign(new Error('历史记录已更新，请刷新列表'),{code:'NOT_FOUND'})
      if(item.series&&item.episodeId){reply(200,await preparePlayback(await episodes.prepare(item.series,item.episodeId),data,item.series,item.episodeId));return}
      const sample=item.id.startsWith('video-')?registerCatalogSample({...item,episodeSeconds:item.duration}):registerHistorySample(item);await saveSamples();const value=await runtime.get(sample.id)
      const progressToken=progress.authorize(data,item,value.duration,undefined,{danmaku:value.danmaku})
      reply(200,{title:item.title,manifest:'/play/'+sample.id+'.m3u8',resumeSeconds:resumePosition(item.resumeSeconds,value.duration,item.completed),duration:value.duration,progressId:progressId(item),progressToken,danmakuAvailable:!!value.danmaku,verified:true});return
    }
    if(['GET','HEAD'].includes(req.method)&&url.pathname==='/api/home'){
      reply(200,await catalog.get(url.searchParams.get('tab')||'recommend',{refresh:url.searchParams.get('refresh')==='1'}));return
    }
    if(req.method==='GET'&&['/home.js','/home.css','/history.js','/danmaku.js','/rights.js','/exports.js','/account.js'].includes(url.pathname)){
      res.setHeader('content-type',url.pathname.endsWith('.js')?'application/javascript':'text/css')
      res.end(rebaseText(await readFile(path.join(root,'web',url.pathname.slice(1)),'utf8'),prefix));return
    }
    if(req.method==='POST'&&url.pathname==='/api/refresh'){
      const id=url.searchParams.get('id')
      await runtime.refresh(id)
      reply(200,{success:true,data:runtime.status()});return
    }
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return}
    const media=url.pathname.match(/^\/media\/(movie|drama|(?:history|catalog)-[a-f0-9]{16})\/([a-f0-9]+-\d+)\/(\d+)\.ts$/)
    if(media){
      const r=await runtime.media(media[1],media[2],Number(media[3]),{method:req.method,range:req.headers.range,signal:controller.signal})
      const headers={'cache-control':'no-store'}
      for(const key of ['content-type','content-length','content-range','accept-ranges'])if(r.headers.has(key))headers[key]=r.headers.get(key)
      res.writeHead(r.status,headers)
      if(r.body&&req.method!=='HEAD'){const stream=Readable.fromWeb(r.body);stream.on('error',()=>res.destroy());stream.pipe(res)}else {await r.body?.cancel();res.end()}
      return
    }
    if(url.pathname==='/hls.min.js'){res.setHeader('content-type','application/javascript');res.end(await readFile(path.join(root,'web/hls.min.js')));return}
    if(url.pathname==='/playlist.m3u'||url.pathname==='/playlist/samples.m3u'){
      const text=url.pathname==='/playlist/samples.m3u'?await authorizedPlaylist(runtime,fixedSamples.filter(s=>!url.searchParams.has('id')||s.id===url.searchParams.get('id')),base):await collectionExport.playlist(url.searchParams.get('scope')||'all',{origin:base})
      res.writeHead(200,{'content-type':'audio/x-mpegurl;charset=utf-8','cache-control':'no-store','content-disposition':'inline; filename="iqiyi-vod.m3u"'})
      res.end(rebaseText(text,prefix));return
    }
    const play=url.pathname.match(/^\/play\/(movie|drama|(?:history|catalog)-[a-f0-9]{16})\.m3u8$/)
    if(play){const text=await runtime.manifest(play[1]);res.writeHead(200,{'content-type':'application/vnd.apple.mpegurl','cache-control':'no-store'});res.end(rebaseText(text,prefix));return}
    if(url.pathname==='/api/results'||url.pathname==='/api/status'){reply(200,runtime.status());return}
    if(url.pathname!=='/'){res.writeHead(404);res.end();return}
    res.setHeader('content-type','text/html;charset=utf-8')
    res.end(rebaseText(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>爱奇艺影视</title><link rel="stylesheet" href="/home.css"><style>body{margin:32px auto;max-width:1080px;padding:0 20px;background:#f4f7f5;color:#193b2e;font:16px system-ui}section{background:white;border:1px solid #dce6e0;border-radius:16px;padding:22px;margin:20px 0}a{color:#147d64}video{width:100%;max-height:65vh;background:#111;margin-top:16px}small,.status{color:#66756e;line-height:1.7}button{border:1px solid #c7dbd0;border-radius:9px;padding:9px 14px;background:#e0f2e8;color:#193b2e;margin:0 8px 8px 0;cursor:pointer}button:disabled{opacity:.55;cursor:wait}</style><h1>爱奇艺影视</h1><p>IPTV 主项目 · 仅输出已确认完整观看授权的内容</p><p>官网首页片单 · 按官网顺序展示推荐、最热、最新</p><section id="account-root" aria-label="爱奇艺账号"></section><script src="/account.js" defer></script><section id="exports-root" aria-label="播放器清单"></section><section id="history-root" aria-label="继续观看"></section><section id="home-root" aria-label="官网正在热播"></section><details id="playback-tests"><summary>已验证的本地动态播放样本（2 条）</summary><p>播放时解析官方完整清单；活跃内容到期前自动续期。</p><p><a href="/playlist/samples.m3u">下载已验证样本 M3U</a></p>${fixedSamples.map(s=>`<section><h2>${escape(s.title)}</h2><p class="status" id="status-${s.id}">尚未解析 · 播放时检查完整观看权限</p><button data-play="${s.id}">解析并播放</button><button data-refresh="${s.id}">重新解析链接</button><a href="/play/${s.id}.m3u8">动态播放清单</a><p id="message-${s.id}" role="status"></p><video hidden controls muted preload="none" data-id="${s.id}"></video></section>`).join('')}</details><small>本地播放器只输出完整、无加密且开头和后段解码通过的清单。会员失效或仅获试看时停止供流；原登录档不会被退出或修改。长期无人播放后停止后台续期，下次播放再解析。</small><script src="/exports.js" defer></script><script src="/rights.js" defer></script><script src="/history.js" defer></script><script src="/home.js" defer></script><script src="/hls.min.js"></script><script>
const players=new Map(),failedPlayers=new Set();
function message(id,text){document.getElementById('message-'+id).textContent=text}
function start(id,position=0){
 const video=document.querySelector('video[data-id="'+id+'"]');video.hidden=false;
 if(players.has(id)){if(!position&&!failedPlayers.has(id)){video.play().catch(()=>{});return}players.get(id)?.destroy();players.delete(id)}
 failedPlayers.delete(id);
 message(id,'正在解析官方播放权限，请稍候…');
 const source='/play/'+id+'.m3u8';
 if(window.Hls&&Hls.isSupported()){
  const hls=new Hls({maxBufferLength:20});players.set(id,hls);
  hls.on(Hls.Events.MANIFEST_PARSED,()=>{if(position)video.currentTime=position;message(id,'完整播放清单已就绪');video.play().catch(()=>message(id,'已就绪，请点击播放器开始播放'))});
  let recovery=0;
  hls.on(Hls.Events.ERROR,(_e,data)=>{if(!data.fatal)return;if(recovery++===0&&video.currentTime>0){const time=video.currentTime;hls.stopLoad();fetch('/play/'+id+'.m3u8').then(r=>{if(!r.ok)throw Error();hls.loadSource(source);hls.startLoad(time)}).catch(()=>{failedPlayers.add(id);message(id,'当前无法完整播放，请检查独立账号权益或稍后重试')})}else{failedPlayers.add(id);message(id,'当前无法完整播放，请检查独立账号权益或稍后重试')}});
  hls.loadSource(source);hls.attachMedia(video)
 }else{video.src=source;video.addEventListener('loadedmetadata',()=>{if(position)video.currentTime=position;video.play().catch(()=>{})},{once:true});video.load()}
}
for(const button of document.querySelectorAll('[data-play]'))button.onclick=()=>start(button.dataset.play);
for(const button of document.querySelectorAll('[data-refresh]'))button.onclick=async()=>{const id=button.dataset.refresh;button.disabled=true;message(id,'正在重新解析，不会操作原登录态…');try{const r=await fetch('/api/refresh?id='+id,{method:'POST'});if(!r.ok)throw Error();message(id,'链接已更新，现有播放器继续使用原播放清单')}catch{message(id,'重新解析未完成，稍后重试')}finally{button.disabled=false;update()}};
async function update(){try{const response=await fetch('/api/status');if(!response.ok)throw Error();const rows=await response.json();window.dispatchEvent(new CustomEvent('playback-rights',{detail:rows}));for(const s of rows){const date=t=>t?new Date(t).toLocaleTimeString('zh-CN',{hour12:false}):'—';const state=s.state==='ready'?'完整清单已核验':s.state==='denied'?'当前没有完整观看权限':s.state==='failed'?'暂时核验失败':s.state==='expired'?'授权已到期 · 待重新核验':'尚未核验';const label=document.getElementById('status-'+s.id);if(!label)continue;label.textContent=state+(s.resolving?' · 正在后台解析':'')+' · 成功解析 '+s.refreshCount+' 次 · 更新 '+date(s.refreshedAt)+' · 下次续期 '+date(s.nextRefreshAt)+(s.lastError?' · '+s.lastError:'')}}catch{}}
update();setInterval(update,3000);
</script></html>`,prefix))
  }catch(error){if(res.headersSent){res.destroy();return}json(res,({BAD_REQUEST:400,AUTH_REQUIRED:401,NOT_AUTHORIZED:403,NOT_FOUND:404,SEGMENT_CHANGED:409,UNSUPPORTED:422})[error.code]||503,{code:error.code||'UNAVAILABLE',error:error.message?.replace(/https?:\/\/\S+/g,'[官方地址]')||'官方解析暂未完成'})}

}
return {handle,runtime,catalog,history,episodes,danmaku,auth,collectionExport,
 credentialRejected:()=>rejected||(auth.status().status==='error'?auth.status().message:''),
 async close(){await Promise.allSettled([runtime.close(),collectionExport.close(),catalog.close(),episodes.close(),danmaku.close(),history.close(),progress.close(),(auth.shutdown||auth.close)()]);if(warmCache){await warmCache.save(runtime,collectionExport.exportEntries()).catch(()=>{});await warmCache.flush().catch(()=>{})}}}
}

function rebase(value,prefix){
 if(Array.isArray(value))return value.map(item=>rebase(item,prefix))
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,['manifest','segmentsURL'].includes(key)&&typeof v==='string'&&v.startsWith('/')?prefix+v:rebase(v,prefix)]))
 return value
}
function rebaseText(text,prefix){
 return text.replace(/(["'`])\/(api\/|play\/|media\/|playlist|home\.|history\.|hls\.|rights\.|exports\.|danmaku\.|account\.)/g,(_m,quote,part)=>quote+prefix+'/'+part)
   .replace(/^\/media\//gm,prefix+'/media/')
}
async function readBody(req,limit){let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>limit)throw Object.assign(Error('请求内容过大'),{code:'BAD_REQUEST'})}try{return JSON.parse(raw)}catch{throw Object.assign(Error('请求格式错误'),{code:'BAD_REQUEST'})}}
function sameHost(a,b){try{return new URL(a).host===new URL(b).host}catch{return false}}
function isLocal(req){return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)&&['127.0.0.1','localhost','[::1]'].includes(new URL('http://'+req.headers.host).hostname)&&!req.headers['x-forwarded-for']}
