#!/usr/bin/env node
// 只用各模块自带的官方节目单（extractors/<id>/epg.js）单独产出一份 XMLTV，
// 不经过播放列表、咪咕与外部源。频道 id 用提供者自己的频道名。
//
// 用途：核对模块节目单；将来把节目单拆出去独立维护，这就是那边的入口——
// 把 listModules() 换成直接 import 各个 epg.js 即可，其余只依赖零依赖的 utils/epgXmltv.js。
//
// 用法:
//   node scripts/build-epg.mjs                     # 全部模块，写到标准输出
//   node scripts/build-epg.mjs yangshipin -o epg.xml
import { writeFileSync } from 'node:fs'
import { listModules } from '../extractors/registry.js'
import { channelXml, mapSettled, providerProgrammes } from '../utils/epgXmltv.js'

const args = process.argv.slice(2)
const outIndex = args.findIndex(arg => arg === '-o' || arg === '--out')
const outFile = outIndex >= 0 ? args[outIndex + 1] : ''
const only = new Set(outIndex >= 0 ? args.filter((arg, index) => index !== outIndex && index !== outIndex + 1) : args)

const providers = listModules()
  .filter(module => module.epg && (!only.size || only.has(module.id)))
  .map(module => ({ id: module.id, provider: module.epg }))
if (!providers.length) {
  console.error(only.size ? `没有带节目单的模块：${[...only].join(', ')}` : '没有带节目单的模块')
  process.exit(1)
}

const now = Date.now()
const seen = new Set()
const jobs = []
for (const { id, provider } of providers) {
  for (const channel of provider.channels()) {
    if (seen.has(channel.name)) continue
    seen.add(channel.name)
    jobs.push({ id, provider, channel })
  }
}

const results = await mapSettled(jobs, 4, job => providerProgrammes(job.provider, job.channel.key, { now }))
let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="iptv module epg">\n'
let written = 0
let empty = 0
const failures = []
results.forEach((result, index) => {
  const { id, channel } = jobs[index]
  if (result.status === 'rejected') {
    failures.push(`${id}/${channel.name}: ${result.reason?.message || result.reason}`)
  } else if (result.value.length) {
    xml += channelXml(channel.name, result.value)
    written++
  } else {
    empty++
  }
})
xml += '</tv>\n'

if (outFile) writeFileSync(outFile, xml)
else process.stdout.write(xml)
console.error(`模块节目单：${written} 个频道有节目，${empty} 个官方当天没发，${failures.length} 个失败`)
for (const failure of failures) console.error(`  失败 ${failure}`)
