import { appendFileSync } from "./fileUtil.js"
import { cntvNames } from "./datas.js"
import { fetchUrl } from "./net.js"
import { channelXml, shanghaiDays } from "./epgXmltv.js"

// 取今天与明天两天。全量更新默认 8 小时一轮、从服务启动时起算，不对齐零点：只取当天的话，
// 零点一过到下一轮更新前，咪咕写的频道一条节目都没有，播放器显示「没有节目单」。
// 两家接口明天的节目都已排好（2026-09-26 实测 243 个咪咕频道全部有明天的）。
const DAYS = 2

async function getMiguDay(programId, day, timeout, fetchJson) {
  const resp = await fetchJson(`https://program-sc.miguvideo.com/live/v2/tv-programs-data/${programId}/${day}`, {}, timeout)
  // fetchUrl 失败时返回 undefined 而不抛（utils/net.js），而 `resp.body?.` 里的 `?.`
  // 只保护 .body 之后、保护不了 resp 自己——原写法在这里直接 TypeError。
  //
  // 但也不能简单地 `resp?.` 一路可选下去：那会把「接口挂了」和「今天这个频道确实
  // 没节目」混成同一个空值，一百多个频道的节目单全没抓到而日志里一个字都没有。
  // 前者抛出去让调用方计数并在收尾报一次，后者返回空即可。
  if (!resp) throw new Error(`节目单接口无响应 (pid ${programId})`)
  return (resp.body?.program?.[0]?.content || [])
    .map(item => ({ title: item.contName, start: item.startTime, stop: item.endTime }))
}

async function getCntvDay(cntvName, day, timeout, fetchJson) {
  const resp = await fetchJson(`https://api.cntv.cn/epg/epginfo3?serviceId=shiyi&d=${day}&c=${cntvName}`, {}, timeout)
  // 同上：接口无响应要抛出去被计数，而不是与「没节目」混为一谈
  if (!resp) throw new Error(`CNTV 节目单接口无响应 (${cntvName})`)
  return (resp[cntvName]?.program || [])
    .map(item => ({ title: item.t, start: item.st * 1000, stop: item.et * 1000 }))
}

/**
 * 写一个咪咕频道的节目单（CCTV 各台取央视网的）。
 * 今天决定这个频道算不算已覆盖：今天取不到照旧抛出计数、今天没节目照旧返回 false 让给
 * 模块与外部源；明天只是补在后面，取不到或没发不影响今天。
 */
async function updatePlaybackData(program, filePath, timeout = 6000, {
  now = Date.now(),
  // 与 fetchUrl 同契约：返回解析后的 JSON，失败返回 undefined；测试注入假的用
  fetchJson = fetchUrl,
} = {}) {
  const cntvName = cntvNames[program.name]
  const getDay = cntvName
    ? day => getCntvDay(cntvName, day, timeout, fetchJson)
    : day => getMiguDay(program.pID, day, timeout, fetchJson)
  const [today, ...later] = await Promise.allSettled(shanghaiDays(now, DAYS).map(getDay))
  if (today.status === "rejected") throw today.reason
  if (!today.value.length) {
    return false
  }
  // 跨零点的那条节目两天的数据里都有，开始时间一样，只留一条
  const seen = new Set()
  const programmes = [today, ...later]
    .flatMap(result => (result.status === "fulfilled" ? result.value : []))
    .filter(item => (seen.has(item.start) ? false : seen.add(item.start)))
    .sort((a, b) => a.start - b.start)
  appendFileSync(filePath, channelXml(program.name, programmes))
  return true
}

export { updatePlaybackData }
