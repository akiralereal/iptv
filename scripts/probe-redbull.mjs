#!/usr/bin/env node
// 对运行中的主项目 /m3u 订阅做真实解码；不调用实验台。报告只记本机入口和媒体事实。
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
const option = key => process.argv.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3)
const base = (option('base') || 'http://127.0.0.1:1958').replace(/\/$/, '')
const seconds = Number(option('seconds') || 15), only = option('only')?.split(',')
const file = option('report') || '/tmp/iptv-redbull-probe.json'
const redact = text => String(text).replace(/https?:\/\/[^\s"'<>]+/g, '[地址]')
async function getText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(90000) })
  if (!response.ok) throw new Error(`本机入口 HTTP ${response.status}`)
  return response.text()
}
async function facts(url) {
  for (let depth = 0; depth < 5; depth++) {
    const text = await getText(url)
    if (!text.startsWith('#EXTM3U')) throw new Error('没有返回 HLS')
    if (/https?:\/\//.test(text)) throw new Error('代理清单泄漏上游直连地址')
    const next = text.match(/^#EXT-X-STREAM-INF:[^\r\n]*\r?\n([^#\r\n]+)/m)?.[1]
    if (next) { url = new URL(next.trim(), url).href; continue }
    return { sequence: Number(text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1]), endlist: text.includes('#EXT-X-ENDLIST'), resources: text.split('\n').filter(x => x && !x.startsWith('#')).length }
  }
  throw new Error('HLS 嵌套过深')
}
function run(command, args, timeout = 90000) {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', timedOut = false
    child.stdout.on('data', data => stdout = (stdout + data).slice(-200000))
    child.stderr.on('data', data => stderr = (stderr + data).slice(-4000))
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeout)
    child.on('error', error => { clearTimeout(timer); resolve({ code: -1, stderr: error.message, stdout }) })
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }) })
  })
}
const playlist = await getText(`${base}/m3u`)
const lines = playlist.split('\n'), channels = []
for (let i=0; i<lines.length; i++) {
  if (!lines[i].startsWith('#EXTINF:')) continue
  let j=i+1; while (j<lines.length && (!lines[j].trim() || lines[j].startsWith('#'))) j++
  const url=lines[j]?.trim(), ref=url?.match(/redbull-(?:channel|event)-[\da-f-]+/)?.[0]
  if (!ref || only && !only.some(x => ref.includes(x) || lines[i].includes(x))) continue
  if (channels.some(c => c.ref === ref)) continue
  channels.push({ name: lines[i].slice(lines[i].lastIndexOf(',')+1), ref, url })
}
if (!channels.length) throw new Error('主项目订阅没有找到红牛频道')
const queue=[...channels], items=[]
await Promise.all(Array.from({ length: Math.min(Number(option('concurrency') || 3), queue.length) }, async () => {
  while (queue.length) {
    const channel=queue.shift(), started=Date.now(), result={name:channel.name,ref:channel.ref,ok:false}
    console.log(`START ${channel.name} (${seconds}s)`)
    try {
      const probe=await run('ffprobe',['-v','error','-rw_timeout','25000000','-show_programs','-show_streams','-of','json',channel.url])
      const info=JSON.parse(probe.stdout || '{}')
      const video=info.streams?.filter(x=>x.codec_type==='video').sort((a,b)=>b.width*b.height-a.width*a.height)[0]
      const program=info.programs?.find(p=>p.streams?.some(x=>x.index===video?.index))
      const audio=program?.streams?.find(x=>x.codec_type==='audio') || info.streams?.find(x=>x.codec_type==='audio')
      if (probe.code || !video || !audio) throw new Error(probe.stderr || '缺少音视频轨')
      result.video={codec:video.codec_name,width:video.width,height:video.height}
      result.audio={codec:audio.codec_name,language:audio.tags?.language}
      result.audioLanguages=[...new Set(info.streams.filter(x=>x.codec_type==='audio').map(x=>x.tags?.language).filter(Boolean))]
      result.before=await facts(channel.url)
      const decoded=await run('ffmpeg',['-hide_banner','-v','error','-rw_timeout','25000000',...(option('pace')==='realtime' ? ['-re'] : []),'-i',channel.url,'-t',String(seconds>=60 ? seconds : seconds+3),'-map',`0:${video.index}`,'-map',`0:${audio.index}`,'-progress','pipe:1','-f','null','-'],seconds*1000+120000)
      result.code=decoded.code; result.timedOut=!!decoded.timedOut
      result.decodedSeconds=Math.max(0,...[...decoded.stdout.matchAll(/out_time_us=(\d+)/g)].map(x=>Number(x[1])/1e6))
      result.frames=Math.max(0,...[...decoded.stdout.matchAll(/frame=(\d+)/g)].map(x=>Number(x[1])))
      result.after=await facts(channel.url)
      result.warnings=[probe.stderr,decoded.stderr].filter(Boolean).map(redact)
      result.ok=decoded.code===0 && result.decodedSeconds>=seconds-.25 && result.frames>0 && !result.before.endlist && !result.after.endlist && (result.after.sequence>result.before.sequence || result.after.sequence===result.before.sequence && result.after.resources>result.before.resources)
    } catch (error) { result.error=redact(error.message) }
    result.elapsedMs=Date.now()-started; items.push(result)
    await writeFile(file,JSON.stringify({checkedAt:new Date().toISOString(),base,seconds,pacing:option('pace')||'live-source',complete:items.length===channels.length,passed:items.filter(x=>x.ok).length,failed:items.filter(x=>!x.ok).length,items},null,2)+'\n')
    console.log(`${result.ok?'PASS':'FAIL'} ${result.name} ${result.video?.height||'?'}p ${result.decodedSeconds||0}s${result.error?' '+result.error:''}`)
  }
}))
if (items.some(x=>!x.ok)) process.exitCode=1
console.log(`报告 ${file}：${items.filter(x=>x.ok).length}/${items.length}`)
