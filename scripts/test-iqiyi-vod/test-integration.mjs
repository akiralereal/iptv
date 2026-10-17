import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { runtimeDir } from '../../extractors/iqiyi-vod/paths.js'
import { createVODService } from '../../extractors/iqiyi-vod/scripts/server.mjs'

const done=async()=>{}
async function fixture(run){
 let denied=false,time=0,parses=0,closed=0
 const app=await createVODService({auto:false,
  resolve:async sample=>{parses++;if(denied)throw Object.assign(Error('preview'),{code:'NOT_AUTHORIZED'});return {text:`#EXTM3U\n#EXTINF:${sample.expectedSeconds},\nhttps://fixture.71edge.com/a.ts\n#EXT-X-ENDLIST`,danmaku:{videoId:'123'}}},
  runtimeOptions:{now:()=>time,fetchImpl:async()=>new Response(new Uint8Array([0x47,0,0,0]),{headers:{'content-type':'video/mp2t'}})},
  catalog:{get:async()=>({items:[]}),close:done},history:{get:async()=>({accountKey:'fixture',items:[{id:'history-0123456789abcdef',url:'https://www.iqiyi.com/v_19rrl9vhkw.html',title:'唐人街探案',duration:8146,resumeSeconds:0,supported:true}]}),invalidate(){},close:done},episodes:{close:done},
  danmaku:{get:async(_id,part)=>({part,start:(part-1)*60,end:part*60,items:[{id:'a',time:(part-1)*60+1,text:'弹幕',color:'#ffffff'}]}),close:done},
  auth:{status:()=>({authenticated:true}),check:async()=>{},close:async()=>{closed++}},
 })
 const server=http.createServer((req,res)=>void app.handle(req,res,{path:req.url,origin:`http://127.0.0.1:${server.address().port}`,prefix:'/secret/iqiyi-vod',admin:req.headers['x-subscriber']!=='yes'}))
 server.listen(0,'127.0.0.1');await once(server,'listening')
 const origin=`http://127.0.0.1:${server.address().port}`
 try{await run({app,origin,deny:()=>{denied=true},time:t=>time=t,parses:()=>parses})}
 finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.close()}
 assert.equal(closed,1)
}
test('mounted page/assets, manifest, M3U and danmaku retain the authenticated prefix',async()=>fixture(async({origin})=>{
 const page=await(await fetch(origin+'/')).text()
 assert.match(page,/IPTV 主项目/);assert.match(page,/src="\/secret\/iqiyi-vod\/home.js"/)
 const js=await(await fetch(origin+'/home.js')).text();assert.match(js,/\/secret\/iqiyi-vod\/api\/home/)
 const m3u=await(await fetch(origin+'/playlist/samples.m3u?id=movie')).text()
 assert.match(m3u,/danmaku-url="http:\/\/127.0.0.1:\d+\/secret\/iqiyi-vod\/api\/danmaku\/v1\/videos\/movie"/)
 assert.match(m3u,/\/secret\/iqiyi-vod\/play\/movie.m3u8/)
 const manifest=await(await fetch(origin+'/play/movie.m3u8')).text();assert.match(manifest,/#EXT-X-PLAYLIST-TYPE:VOD/);assert.match(manifest,/^\/secret\/iqiyi-vod\/media\/movie\//m)
 const metadata=await(await fetch(origin+'/api/danmaku/v1/videos/movie')).json();assert.equal(metadata.segmentsURL,'/secret/iqiyi-vod/api/danmaku/v1/videos/movie/segments')
 const segment=await(await fetch(origin+'/api/danmaku/v1/videos/movie/segments?part=1')).json();assert.equal(segment.items[0].mode,'scroll')
}))
test('expired denied rights revoke the old manifest, direct fragments, playlist and comments',async()=>fixture(async({origin,app,deny,time})=>{
 const manifest=await(await fetch(origin+'/play/movie.m3u8')).text(), media=manifest.split('\n').find(line=>line.startsWith('/secret/')).replace('/secret/iqiyi-vod','')
 deny();time(1800001)   // tickets now last up to 30 minutes unless the CDN refuses them first
 for(const route of ['/play/movie.m3u8',media,'/api/danmaku/v1/videos/movie'])assert.equal((await fetch(origin+route)).status,403)
 assert.equal((await fetch(origin+'/playlist/samples.m3u?id=movie')).status,503)
 assert.equal(app.runtime.status().find(s=>s.id==='movie').state,'denied')
}))
test('subscriber tokens cannot read owner history or change login; cross-origin writes are rejected',async()=>fixture(async({origin})=>{
 for(const route of ['/','/api/history','/api/account','/api/home','/play/movie.m3u8','/api/danmaku/v1/videos/movie','/playlist.m3u'])assert.equal((await fetch(origin+route,{headers:{'x-subscriber':'yes'}})).status,403,route+' 订阅用户不能用站长会员播放')
 const cross=await fetch(origin+'/api/account',{method:'POST',headers:{Origin:'https://foreign.example','Content-Type':'application/json'},body:'{"action":"check"}'})
 assert.equal(cross.status,403)
}))
test('switching account discards in-flight authorization before publication',async()=>{
 const {createRuntime}=await import('../../extractors/iqiyi-vod/scripts/runtime.mjs')
 let finish;const runtime=createRuntime({auto:false,resolve:()=>new Promise(resolve=>finish=resolve)})
 const pending=runtime.manifest('movie');await new Promise(resolve=>setImmediate(resolve));runtime.reset()
 finish({text:'#EXTM3U\n#EXTINF:8146,\nhttps://fixture.71edge.com/a.ts\n#EXT-X-ENDLIST'})
 await assert.rejects(pending,error=>error.code==='AUTH_REQUIRED');assert.notEqual(runtime.status()[0].state,'ready');await runtime.close()
})

test('local playback progress is persisted only in the configured private data directory',async()=>fixture(async({origin})=>{
 const response=await fetch(origin+'/api/history/prepare',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'history-0123456789abcdef'})})
 assert.equal(response.status,200)
 const prepared=await response.json()
 const saved=await fetch(origin+'/api/playback/progress',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:prepared.progressId,token:prepared.progressToken,seconds:37,sequence:1})})
 assert.equal(saved.status,200)
 const state=JSON.parse(await readFile(path.join(runtimeDir,'history-progress.json'),'utf8'))
 assert.equal(state.fixture[prepared.progressId].seconds,37)
}))

test('main VOD service restores full tickets on restart without parsing or extending expiry',async()=>{
 let parses=0
 const options={auto:true,resolve:async sample=>{parses++;return {text:`#EXTM3U\n#EXTINF:${sample.expectedSeconds},\nhttps://fixture.71edge.com/restart.ts\n#EXT-X-ENDLIST`}},
  catalog:{get:async()=>({items:[{id:'fixture',title:'fixture',url:'https://www.iqiyi.com/v_19rrl9vhkw.html',episodeSeconds:8146}]}),close:done},
  history:{get:async()=>({accountKey:'fixture',items:[]}),close:done},episodes:{close:done},danmaku:{close:done},auth:{status:()=>({authenticated:true}),close:done}}
 const first=await createVODService(options)
 let expiresAt
 try{await first.collectionExport.start();assert.ok(first.collectionExport.status().ready.all);expiresAt=first.runtime.status().find(s=>s.id==='movie').expiresAt}
 finally{await first.close()}
 const second=await createVODService(options)
 try{
  assert.ok(second.collectionExport.status().ready.all)
  assert.match(await second.runtime.manifest('movie'),/#EXT-X-ENDLIST/)
  assert.equal(parses,1)
  assert.equal(second.runtime.status().find(s=>s.id==='movie').expiresAt,expiresAt)
 }finally{await second.close()}
})
