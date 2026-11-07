#!/usr/bin/env node
// Exercise the real modules with controlled subprocess/network failures. No personal
// configuration, live upstream requests, or installed Python packages are changed.
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import * as crypto from 'node:crypto'
import * as util from 'node:util'
import * as path from 'node:path'
import * as url from 'node:url'
import { fetchUpstreamResponse } from '../utils/hlsProxy.js'
import { topVariantFirst } from '../utils/hlsTopFirst.js'
import { hasReplaceToken } from '../utils/replaceToken.js'

// SourceTextModule is available on the project's Node 20 baseline behind this flag.
if (!vm.SourceTextModule) {
  try { execFileSync(process.execPath, ['--experimental-vm-modules', url.fileURLToPath(import.meta.url)], { stdio: 'inherit' }) }
  catch (err) { process.exit(err.status || 1) }
  process.exit(0)
}

const root = new URL('../', import.meta.url)
async function load(relative, dependencies) {
  const file = new URL(relative, root)
  const context = vm.createContext({ URL, Response, Buffer, Date, AbortSignal, process: { ...process, env: {} } })
  const module = new vm.SourceTextModule(readFileSync(file, 'utf8'), {
    context, identifier: file.href, initializeImportMeta(meta) { meta.url = file.href },
  })
  await module.link(spec => {
    const exports = dependencies[spec]
    assert.ok(exports, `missing dependency: ${spec}`)
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
    }, { context })
  })
  await module.evaluate()
  return module.namespace
}
function subprocess(run) {
  const execFile = () => { throw new Error('expected promisified execFile') }
  execFile[util.promisify.custom] = run
  return { execFile }
}
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
let passed = 0
async function check(name, fn) { await fn(); passed++; console.log('  ✅ ' + name) }

const video = 'abcdefghijk', channelId = 'UC' + 'a'.repeat(22)
const expiry = Math.floor(Date.now() / 1000) + 3600
const master = sig => `https://manifest.googlevideo.com/api/manifest/hls_variant/expire/${expiry}/sig/${sig}/index.m3u8`
const track = (sig, { itag = '232', language = 'en', id = video, expire = expiry } = {}) =>
  `https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/${expire}/id/${id}.1/itag/${itag}/xtags/${language}/sig/${sig}/index.m3u8`
const segment = (sig, { itag = '232', language = 'en', sq = '42', id = video } = {}) =>
  `https://rr3---sn-test.googlevideo.com/videoplayback/expire/${expiry}/id/${id}.1/itag/${itag}/xtags/${language}/sq/${sq}/sig/${sig}/seg.ts`
const field = (raw, name) => new URL(raw).pathname.split('/' + name + '/')[1]?.split('/')[0]
async function playback() {
  const state = { parses: 0, args: [], requests: [], revoked: false, status: 403, failAt: 'media', newVideo: video, missingSq: false, gate: null }
  const api = await load('extractors/youtube-live/api.js', {
    'node:child_process': subprocess(async (_binary, args) => {
      state.parses++
      state.args.push(args.join(' '))
      assert.equal(args.at(-1), 'https://www.youtube.com/watch?v=' + video, 'renew the original programme')
      return { stdout: JSON.stringify({ id: video, channel_id: channelId, live_status: 'is_live',
        formats: [{ protocol: 'm3u8_native', vcodec: 'avc1', manifest_url: master(state.parses === 1 ? 'A' : 'B') }] }) }
    }),
    'node:crypto': crypto, 'node:util': util,
    './runtime.js': { ytDlpCommand: () => ({ file: '/mock/yt-dlp', args: [] }) },
    '../../utils/replaceToken.js': { hasReplaceToken }, '../../utils/hlsTopFirst.js': { topVariantFirst },
    '../../utils/hlsProxy.js': { fetchUpstreamResponse },
    '../../utils/outboundProxy.js': {
      outboundProxyKey: () => 'direct', outboundProxyUrl: () => '', ytDlpProxyArg: () => '',
      outboundFetch: async (raw, options) => {
        state.requests.push({ raw, options })
        const sig = field(raw, 'sig')
        const isMaster = raw.includes('/hls_variant/')
        if (state.gate && sig === 'A' && isMaster) {
          const gate = state.gate; state.gate = null; gate.entered.resolve(); await gate.release.promise
        }
        if (state.revoked && (sig === 'A' || state.failAt === 'all') &&
            (state.failAt !== 'master' || isMaster)) return new Response('expired', { status: state.status })
        if (isMaster) return new Response('#EXTM3U\n' + [
          `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="${track(sig, { itag:'234' })}"`,
          `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="fr",URI="${track(sig, { itag:'387',language:'fr' })}"`,
          `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="en",URI="${track(sig, { itag:'387' })}"`,
          '#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=1280x720,AUDIO="a",SUBTITLES="s"',
          track(sig, { id:state.newVideo }),
        ].join('\n'))
        if (raw.includes('/hls_playlist/')) return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXT-X-MEDIA-SEQUENCE:42\n#EXTINF:5,\n' +
          segment(sig, { itag:field(raw,'itag'), language:field(raw,'xtags'), sq:state.missingSq ? '43' : '42' }))
        return new Response(`media:${sig}:${field(raw,'itag')}:${field(raw,'xtags')}:${field(raw,'sq')}`, { status:options.headers.range ? 206 : 200 })
      },
    },
  })
  const item = api.record(channelId, video, 'Test live')
  const config = { subscriptions: JSON.stringify([item]) }
  const fetch = (raw, options = {}) => api.fetchProxyMedia(api.refOf(item), config, raw, options)
  await fetch(track('old', { expire:1 })) // cache exact-video session A
  state.requests.length = 0
  return { api, state, fetch, item, config }
}

for (const status of [401, 403, 410]) await check(`${status} on a cached rendition renews its session and returns media`, async () => {
  const h = await playback(); h.state.revoked = true; h.state.status = status
  const res = await h.fetch(track('A'))
  assert.equal(res.status, 200)
  assert.match(await res.text(), /\/sig\/B\//)
  assert.equal(h.state.parses, 2)
})
await check('expired URL renews without requesting the expired address', async () => {
  const h = await playback(); const expired = track('old', {expire:1})
  assert.equal((await h.fetch(expired)).status, 200)
  assert.ok(!h.state.requests.some(r => r.raw === expired))
  assert.equal(h.state.parses, 1, 'a valid renewed session is reusable')
})
await check('a rejected renewal master is also replaced', async () => {
  const h = await playback(); h.state.revoked = true; h.state.failAt = 'master'
  assert.equal((await h.fetch(track('old', {expire:1}))).status, 200)
  assert.equal(h.state.parses, 2)
})
await check('video, audio and subtitle retries preserve track, language, sequence and Range', async () => {
  for (const [itag, language] of [['232','en'],['234','en'],['387','fr']]) {
    const h = await playback(); h.state.revoked = true
    const res = await h.fetch(segment('A', {itag,language}), {headers:{range:'bytes=0-10'}})
    assert.equal(res.status, 206)
    assert.equal(await res.text(), `media:B:${itag}:${language}:42`)
    assert.equal(h.state.parses, 2)
  }
})
await check('concurrent and late 403 responses share the replacement instead of evicting it', async () => {
  const h = await playback()
  const gate = { entered:deferred(), release:deferred() }; h.state.gate = gate
  const late = h.fetch(track('old', {expire:1})); await gate.entered.promise
  h.state.revoked = true
  const others = await Promise.all(Array.from({length:8}, () => h.fetch(track('A'))))
  assert.ok(others.every(r => r.status === 200))
  gate.release.resolve()
  assert.equal((await late).status, 200)
  assert.equal(h.state.parses, 2, 'one initial extraction and one shared refresh')
})
await check('permanent rejection stops after one refresh', async () => {
  const h = await playback(); h.state.revoked = true; h.state.failAt = 'all'
  await assert.rejects(h.fetch(track('A')), /HTTP 403/)
  assert.equal(h.state.parses, 2)
})
await check('a changed broadcast or missing segment never switches programme or sequence', async () => {
  for (const changed of ['newVideo','missingSq']) {
    const h = await playback()
    if (changed === 'newVideo') h.state.newVideo = 'ZYXWVUTSRQP'; else h.state.missingSq = true
    await assert.rejects(h.fetch(changed === 'newVideo' ? track('old',{expire:1}) : segment('old').replace('/expire/' + expiry + '/', '/expire/1/')), /退出窗口/)
    assert.equal(h.state.parses, 1)
  }
})

await check('the muxed-audio setting reaches yt-dlp on open and on renewal; default stays on the default clients', async () => {
  const h = await playback()
  assert.ok(!h.state.args.some(a => a.includes('player_client')), 'default: no mweb')
  const muxedConfig = { ...h.config, muxedAudio: true }
  const ref = h.api.refOf(h.item)
  const opened = await h.api.resolve(ref, { config: muxedConfig })
  assert.ok(opened.url, opened.desc)
  assert.match(h.state.args.at(-1), /player_client=mweb/)
  const parses = h.state.parses
  h.state.revoked = true
  const res = await h.api.fetchProxyMedia(ref, muxedConfig, track('A'), {})
  assert.equal(res.status, 200)
  assert.ok(h.state.parses > parses)
  assert.match(h.state.args.at(-1), /player_client=mweb/, 'renewal keeps the muxed client')
})

const harnesses = []
async function runtime(state = {}) {
  harnesses.push(state)
  Object.assign(state, { version: state.version || '2026.10.21', ejs: state.ejs ?? '0.8.0', installs: [], installArgs: [], fail: state.fail || '', updated:0 })
  const required = () => state.version === '2026.10.21' ? '0.8.0' : '0.9.0'
  const api = await load('extractors/youtube-live/runtime.js', {
    'node:child_process': subprocess(async (binary, args) => {
      if (args.includes('--version')) {
        // 本项目的虚拟环境不走 bin/yt-dlp 启动脚本（挪过目录就失效），用其中的 python -m yt_dlp
        // 状态读取会吞掉这里的异常（当成读不到版本），断言失败记下来，由各用例结尾统一检查
        if (!/\/\.runtime\/youtube\/bin\/python$/.test(binary) || args.slice(0, 2).join(' ') !== '-m yt_dlp') state.wrongCommand = `${binary} ${args.join(' ')}`
        if (state.slow) throw Object.assign(new Error('killed'), {killed:true, signal:'SIGTERM'})
        if (state.broken) throw Object.assign(new Error('exit 1'), {code:1, stderr:'No module named yt_dlp'})
        return {stdout:state.version}
      }
      if (args.includes('-c')) return {stdout:JSON.stringify({requirement:'yt-dlp-ejs==' + required(), version:state.ejs, healthy:state.ejs === required()})}
      assert.ok(args.includes('install'))
      const name = args.at(-1); state.installs.push(name); state.installArgs.push(args)
      if (name.startsWith('yt-dlp==') && !state.fail) state.broken = false
      if (state.gate) { const gate=state.gate; state.gate=null; gate.entered.resolve(); await gate.release.promise }
      if (state.fail === 'core' || (state.fail === 'ejs' && name.startsWith('yt-dlp-ejs'))) {
        throw Object.assign(new Error('install failed'), {stderr:'ConnectionError: timed out'})
      }
      if (name.startsWith('yt-dlp==')) state.version = name.split('==')[1]
      else if (!state.badInstall) state.ejs = name.split('==')[1]
      return {stdout:''}
    }),
    'node:fs': {existsSync:()=>true,realpathSync:p=>p,readFileSync:()=> 'version = 3.12.8\n'},
    'node:path':path, 'node:url':url, 'node:util':util,
    '../../utils/outboundProxy.js': {outboundProxyUrl:()=>'',outboundFetch:async()=>new Response(JSON.stringify({
      info:{version:'2026.10.26'},releases:{'2026.10.26':[{requires_python:'>=3.11',yanked:false}]},
    }))},
  })
  return {api,state,update:()=>api.updateRuntime({onUpdated:()=>state.updated++})}
}
await check('EJS failure after a successful core upgrade remains repairable at the same version', async () => {
  const h = await runtime({fail:'ejs'})
  await assert.rejects(h.update(), /更新没完成/)
  const status = await h.api.runtimeStatus({checkLatest:true})
  assert.equal(status.version, '2026.10.26'); assert.equal(status.outdated, false)
  assert.equal(status.repairNeeded, true); assert.equal(status.updating, false)
  assert.equal(h.state.updated, 0)
  h.state.fail = ''
  const result = await h.update()
  assert.equal(result.updated, false); assert.equal(result.repaired, true)
  assert.equal((await h.api.runtimeStatus()).repairNeeded, false)
  assert.equal(h.state.updated, 1)
  assert.deepEqual(h.state.installs, ['yt-dlp==2026.10.26','yt-dlp-ejs==0.9.0','yt-dlp-ejs==0.9.0'])
})
await check('missing dependencies are detected after process restart and repaired without downgrade', async () => {
  const h = await runtime({version:'2026.10.27',ejs:''})
  assert.equal((await h.api.runtimeStatus()).repairNeeded, true)
  const result = await h.update()
  assert.equal(result.version, '2026.10.27'); assert.equal(result.repaired, true)
  assert.deepEqual(h.state.installs, ['yt-dlp-ejs==0.9.0'])
})
await check('failed core install can be retried; concurrent retries run only one installer', async () => {
  const h = await runtime({fail:'core'})
  await assert.rejects(h.update(), /更新没完成/)
  h.state.fail = ''
  const gate = {entered:deferred(),release:deferred()}; h.state.gate = gate
  const first = h.update(); await gate.entered.promise
  const second = h.update(); assert.equal(first, second)
  gate.release.resolve()
  const result = await first
  assert.equal(result.updated, true)
  assert.equal(h.state.updated, 1)
})
await check('successful installer exit alone is insufficient; verify dependencies before clearing caches', async () => {
  const h = await runtime({version:'2026.10.26',ejs:'',badInstall:true})
  await assert.rejects(h.update(), /校验失败/)
  assert.equal(h.state.updated, 0)
  assert.equal((await h.api.runtimeStatus()).repairNeeded, true)
  h.state.badInstall = false
  assert.equal((await h.update()).repaired, true)
  const count = h.state.installs.length
  assert.equal((await h.update()).updated, false)
  assert.equal(h.state.installs.length, count, 'healthy current versions need no installation')
})
await check('unrunnable yt-dlp in our own environment is offered as a repair and force-reinstalled', async () => {
  const h = await runtime({version:'2026.10.26',ejs:'0.9.0',broken:true})
  const status = await h.api.runtimeStatus({checkLatest:true})
  assert.equal(status.version, ''); assert.equal(status.managed, true)
  assert.equal(status.repairNeeded, true); assert.equal(status.outdated, false)
  const result = await h.update()
  assert.equal(result.version, '2026.10.26'); assert.equal(result.repaired, true); assert.equal(result.updated, false)
  assert.deepEqual(h.state.installs, ['yt-dlp==2026.10.26'])
  assert.ok(h.state.installArgs[0].includes('--force-reinstall'), 'same version: plain --upgrade would be a no-op')
  assert.equal((await h.api.runtimeStatus()).repairNeeded, false)
  assert.equal(h.state.updated, 1)
})
await check('a version read that times out is reported, not offered as a reinstall', async () => {
  const h = await runtime({version:'2026.10.26',ejs:'0.9.0',slow:true})
  await assert.rejects(h.api.runtimeStatus(), /超时/)
  h.state.slow = false
  assert.equal((await h.api.runtimeStatus()).version, '2026.10.26')
})
await check('our own environment always runs yt-dlp as python -m yt_dlp, never the launcher script', async () => {
  assert.ok(harnesses.length >= 5)
  for (const state of harnesses) assert.equal(state.wrongCommand, undefined)
})
async function adminRuntime(extractorPost) {
  const admin = readFileSync(new URL('web/admin.html', root), 'utf8')
  const source = admin.match(/^ {8}function initYouTubeSubscriptions\([^]*?^ {8}\}/m)[0]
  const elements = Object.fromEntries(['youtubeInput','youtubeEvents','youtubeInspect','youtubeAdd',
    'youtubeRuntimeText','youtubeRuntimeCheck','youtubeRuntimeUpdate'].map(id => [id, {isConnected:true,hidden:true}]))
  const context = vm.createContext({ document: {getElementById:id=>elements[id],querySelectorAll:()=>[]}, extractorPost })
  vm.runInContext(source + '\ninitYouTubeSubscriptions()', context)
  await new Promise(setImmediate)
  return elements
}
await check('admin never calls an unreadable yt-dlp up to date', async () => {
  const broken = await adminRuntime(async () => ({success:true,version:'',managed:true,repairNeeded:true,latest:'2026.10.26',outdated:false}))
  await broken.youtubeRuntimeCheck.onclick()
  assert.equal(broken.youtubeRuntimeText.textContent, '解析组件 yt-dlp 无法运行，请点「修复」重新安装')
  assert.equal(broken.youtubeRuntimeUpdate.hidden, false); assert.equal(broken.youtubeRuntimeUpdate.textContent, '修复')
  const missing = await adminRuntime(async () => ({success:true,version:'',managed:false,reason:'没装 yt-dlp',latest:'2026.10.26',outdated:false}))
  await missing.youtubeRuntimeCheck.onclick()
  assert.equal(missing.youtubeRuntimeText.textContent, '解析组件 yt-dlp：未安装。没装 yt-dlp')
  assert.equal(missing.youtubeRuntimeUpdate.hidden, true)
})
await check('admin offers repair after reopening and keeps retry available after failure', async () => {
  let fail = true
  const elements = await adminRuntime(async ({op}) => op === 'update'
    ? fail ? {success:false,message:'下载超时'} : {success:true,version:'2026.10.26',updated:false,repaired:true}
    : {success:true,version:'2026.10.26',managed:true,repairNeeded:true,latest:'2026.10.26',outdated:false})
  const button = elements.youtubeRuntimeUpdate
  assert.equal(button.hidden, false); assert.equal(button.textContent, '修复依赖')
  await elements.youtubeRuntimeCheck.onclick()
  assert.equal(button.hidden, false, 'checking the same version must not hide repair')
  assert.doesNotMatch(elements.youtubeRuntimeText.textContent, /已是最新版/)
  await button.onclick()
  assert.equal(button.hidden, false); assert.equal(button.disabled, false)
  assert.match(button.textContent, /重试/)
  fail = false
  await button.onclick()
  assert.equal(button.hidden, true)
  assert.match(elements.youtubeRuntimeText.textContent, /已修复/)
})
console.log(`YouTube recovery: ${passed} checks passed`)
