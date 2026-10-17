import test from 'node:test'
import assert from 'node:assert/strict'
import {createCollectionExport} from '../../extractors/iqiyi-vod/scripts/collection-export.mjs'
const sample=(id)=>({id,title:id})
const entry=(id,scope)=>({sample:sample(id),scope,group:scope})
const origin='http://127.0.0.1:8807'
function setup(entries,verify=async()=>{}){
 const states=new Map(),calls=[]
 const runtime={status:()=>[...states].map(([id,state])=>({id,state,verified:state==='ready'})),verify:async id=>{calls.push(id);try{await verify(id);states.set(id,'ready')}catch(error){states.set(id,error.code==='NOT_AUTHORIZED'?'denied':'failed');throw error}}}
 return {states,calls,service:createCollectionExport({origin,runtime,load:async()=>({entries})})}
}
test('collection includes all homepage tabs and history, preserves groups, verifies shared videos only once',async()=>{
 const s=setup([entry('a','recommend'),entry('a','hot'),entry('b','new'),entry('c','history'),entry('c','history')])
 await s.service.start();assert.deepEqual(s.calls,['a','b','c']);assert.equal(s.service.status().total,3)
 assert.equal(s.service.status().ready.all,4);assert.match(s.service.text(),/group-title="history"/)
 assert.match(s.service.text('history'),/\/play\/c.m3u8/);assert.doesNotMatch(s.service.text('history'),/\/play\/a.m3u8/)
 await s.service.close()
})
test('preview and uncertain rights are excluded from every exported scope',async()=>{
 const s=setup([entry('ok','recommend'),entry('preview','hot'),entry('network','history')],async id=>{if(id!=='ok')throw Object.assign(Error('failure'),{code:id==='preview'?'NOT_AUTHORIZED':'UNAVAILABLE'})})
 await s.service.start();assert.equal(s.service.status().denied,1);assert.equal(s.service.status().failed,1)
 const text=s.service.text();assert.match(text,/\/play\/ok.m3u8/);assert.doesNotMatch(text,/preview|network/)
 assert.throws(()=>s.service.text('history'));await s.service.close()
})
test('expired and revoked entries disappear from later exports even after a successful scan',async()=>{
 const s=setup([entry('a','recommend'),entry('b','history')]);await s.service.start()
 s.states.set('a','expired');s.states.set('b','denied');assert.equal(s.service.status().ready.all,0);assert.throws(()=>s.service.text());await s.service.close()
})
test('a first subscription waits for verification and concurrent imports share a single background scan',async()=>{
 let finish;const s=setup([entry('a','recommend')],()=>new Promise(resolve=>{finish=resolve}))
 const first=s.service.playlist(),second=s.service.playlist();await new Promise(resolve=>setImmediate(resolve));assert.equal(s.calls.length,1)
 finish();assert.match(await first,/\/play\/a.m3u8/);assert.equal(await second,await first);await s.service.close()
})
test('failed directory refresh does not retain the earlier export and empty subscriptions fail closed',async()=>{
 let broken=false
 const service=createCollectionExport({origin,runtime:{status:()=>[{id:'a',state:'ready',verified:true}],verify:async()=>{}},load:async()=>{if(broken)throw Error('read failed');return {entries:[entry('a','recommend')]}}})
 await service.start();assert.match(service.text(),/\/play\/a.m3u8/);broken=true;await service.start();assert.throws(()=>service.text());assert.equal(service.status().finished,false)
 await assert.rejects(service.playlist('all',{waitMs:5}));await service.close()
})
test('a round verifies at most roundLimit new titles, and subscriptions start rounds only after the cooldown',async()=>{
 let clock=0
 const states=new Map(),calls=[]
 const runtime={status:()=>[...states].map(([id,state])=>({id,state,verified:state==='ready'})),verify:async id=>{calls.push(id);if(states.get(id)==='ready')return {cached:true};states.set(id,'ready');return {cached:false}}}
 const entries=Array.from({length:5},(_,i)=>entry('v'+i,'recommend'))
 const service=createCollectionExport({origin,runtime,now:()=>clock,roundLimit:2,autoCooldownMs:1000,load:async()=>({entries})})
 await service.start();assert.equal(calls.length,2);assert.match(service.status().warnings.join(),/其余下一轮继续/)
 await service.playlist();assert.equal(calls.length,2,'冷却期内拉清单不再开新一轮')
 clock+=1000;await service.playlist();await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r))
 assert.equal(calls.filter(id=>id==='v2'||id==='v3').length,2,'冷却后的新一轮接着核验没核过的')
 await service.close()
})
test('re-checking the login or a failed directory read never leaves the playlist empty for the whole cooldown',async()=>{
 let clock=0,broken=false
 const states=new Map()
 const runtime={status:()=>[...states].map(([id,state])=>({id,state,verified:state==='ready'})),verify:async id=>{states.set(id,'ready');return {cached:false}}}
 const service=createCollectionExport({origin,runtime,now:()=>clock,autoCooldownMs:7200000,load:async()=>{if(broken)throw Error('busy');return {entries:[entry('a','recommend')]}}})
 await service.start();states.clear();service.invalidate()
 assert.match(await service.playlist('all',{waitMs:50}),/\/play\/a.m3u8/,'检查登录后立即重新核验')
 broken=true;service.invalidate();states.clear();await service.start();broken=false
 clock+=300000;assert.match(await service.playlist('all',{waitMs:50}),/\/play\/a.m3u8/,'读片单失败 5 分钟后重试')
 await service.close()
})

test('homepage becomes playable before a slow history reader completes',async()=>{
 let finishHistory;const history=new Promise(resolve=>finishHistory=resolve),states=new Map()
 const service=createCollectionExport({origin,runtime:{status:()=>[...states].map(([id,state])=>({id,state,verified:state==='ready'})),verify:async id=>{states.set(id,'ready')}},load:async batch=>{batch([entry('home','recommend')]);await history;return {entries:[entry('home','recommend')]}}})
 const pending=service.start();await new Promise(resolve=>setImmediate(resolve))
 assert.match(await service.playlist('recommend',{waitMs:5}),/\/play\/home.m3u8/)
 assert.equal(service.status().running,true);finishHistory();await pending;await service.close()
})

test('startup scan keeps only still-authorized restored entries available while loading fresh sources',async()=>{
 let finish;const wait=new Promise(resolve=>finish=resolve);let ready=true
 const service=createCollectionExport({origin,initialEntries:[entry('cached','recommend')],runtime:{status:()=>[{id:'cached',state:ready?'ready':'expired',verified:ready}],verify:async()=>{}},load:async()=>{await wait;return {entries:[]}}})
 const scan=service.start({keepReady:true});assert.match(await service.playlist('recommend',{waitMs:5}),/\/play\/cached.m3u8/)
 ready=false;assert.throws(()=>service.text());finish();await scan;await service.close()
})
