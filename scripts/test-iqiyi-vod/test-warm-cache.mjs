import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {createRuntime} from '../../extractors/iqiyi-vod/scripts/runtime.mjs'
import {createWarmCache} from '../../extractors/iqiyi-vod/scripts/warm-cache.mjs'
const entries=[{scope:'recommend',group:'推荐',sample:{id:'movie',title:'movie'}}]
async function fixture(run){
 const directory=await mkdtemp(path.join(tmpdir(),'iqiyi-warm-test-'));let time=1000,account='a',deny=false,parses=0
 const make=()=>createRuntime({auto:false,now:()=>time,ttlMs:10000,refreshAheadMs:3000,resolve:async s=>{parses++;if(deny)throw Object.assign(Error('no rights'),{code:'NOT_AUTHORIZED'});return {text:`#EXTM3U\n#EXTINF:${s.expectedSeconds},\nhttps://one.71edge.com/movie.ts\n#EXT-X-ENDLIST`}}})
 const runtimes=[],runtime=()=>{const r=make();runtimes.push(r);return r},cache=()=>createWarmCache({directory,fingerprint:async()=>account})
 try{await run({directory,runtime,cache,time:t=>time=t,account:a=>account=a,deny:()=>deny=true,parses:()=>parses})}
 finally{await Promise.all(runtimes.map(r=>r.close()));await rm(directory,{recursive:true,force:true})}
}
test('restart reuses verified cache immediately without parsing again or extending original expiry',()=>fixture(async s=>{
 const first=s.runtime(),cache=s.cache();await first.verify('movie');await cache.save(first,entries)
 s.time(4000);const second=s.runtime();assert.equal((await s.cache().load(second)).length,1)
 await second.manifest('movie');assert.equal(s.parses(),1);assert.equal(second.status()[0].expiresAt,11000)
 s.time(11000);const third=s.runtime();assert.equal((await s.cache().load(third)).length,0)
}))
test('changed login or tampered cache is never restored',()=>fixture(async s=>{
 const first=s.runtime(),cache=s.cache();await first.verify('movie');await cache.save(first,entries)
 s.account('b');assert.equal((await s.cache().load(s.runtime())).length,0)
 s.account('a');const file=path.join(s.directory,'verified-warm-cache.json'),data=JSON.parse(await readFile(file,'utf8'));data.payload=data.payload.replace('11000','999999');await writeFile(file,JSON.stringify(data))
 assert.equal((await s.cache().load(s.runtime())).length,0)
}))
test('authorization denial removes the previously published cache',()=>fixture(async s=>{
 const first=s.runtime(),cache=s.cache();await first.verify('movie');await cache.save(first,entries)
 s.deny();await assert.rejects(first.refresh('movie'));await cache.save(first,entries)
 assert.equal((await s.cache().load(s.runtime())).length,0)
}))
test('changing login during a process cannot bind earlier rights to the new login',()=>fixture(async s=>{
 const first=s.runtime(),cache=s.cache();await first.verify('movie');await cache.save(first,entries)
 s.account('b');await cache.save(first,entries);assert.equal((await s.cache().load(s.runtime())).length,0)
}))

test('account recheck deletes the old cache before new credentials can publish',()=>fixture(async s=>{
 const runtime=s.runtime(),cache=s.cache();await runtime.verify('movie');await cache.save(runtime,entries)
 await cache.reset();assert.equal((await s.cache().load(s.runtime())).length,0)
}))
