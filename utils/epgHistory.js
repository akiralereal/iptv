// 往日节目单的存盘。
//
// 咪咕回看能往前看 7 天（2026-11-19 实测：从当前起滚动 168 小时，再早清单直接 404），节目单接口
// 给往前 6 天。要让播放器的回看列表翻得到前几天，节目单里得有那几天的节目；可完整更新一天跑
// 四轮左右（默认 8 小时一轮、零点后一轮、重启、手动刷新），每轮都把往前 6 天重取一遍，请求数是
// 现在的 4 倍，取回来的却是同一份——一天过完，那天播了什么就定了。
//
// 所以往日的节目单按「上海日期」一天一个文件存在数据目录里：某台某天取到过就不再取，
// 平时每台每天只多取一次「昨天」。只存已经过完的那几天，今天和明天照旧每轮现取。
//
// 文件：<dir>/<YYYYMMDD>.json = { "<频道键>": [[标题, 开始毫秒, 结束毫秒], …] }
// 可再生的缓存：删掉、写坏、目录只读都不影响节目单，只是下一轮重取。

import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// 日期文件，以及写到一半留下的临时文件
const DAY_FILE = /^(\d{8})\.json(\.tmp)?$/

function validRow(row) {
  return Array.isArray(row) && typeof row[0] === 'string'
    && Number.isFinite(row[1]) && Number.isFinite(row[2])
}

/**
 * @param {string} dir 存放目录；用到时才建
 */
export function createEpgHistory(dir) {
  /** day → { data: { [key]: rows }, dirty } ；一轮更新期间留在内存里，flush 后放掉 */
  let days = new Map()
  let added = 0

  function load(day) {
    let entry = days.get(day)
    if (entry) return entry
    let data = {}
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, `${day}.json`), 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed
    } catch {
      // 没存过，或文件坏了：当没有，重新取
    }
    entry = { data, dirty: false }
    days.set(day, entry)
    return entry
  }

  return {
    /** 存过就返回 [{ title, start, stop }]，没存过返回 undefined。 */
    get(key, day) {
      const rows = load(String(day)).data[key]
      if (!Array.isArray(rows)) return undefined
      const programmes = rows.filter(validRow).map(([title, start, stop]) => ({ title, start, stop }))
      return programmes.length ? programmes : undefined
    },

    /**
     * 记下一台一天的节目。空的不存：分不清「官方那天确实没发」和「接口一时回了空」，
     * 存了就要等这一天滚出窗口才会重取。
     */
    set(key, day, programmes) {
      const rows = (programmes || [])
        .map(item => [String(item.title ?? ''), Number(item.start), Number(item.stop)])
        .filter(validRow)
      if (!rows.length) return
      const entry = load(String(day))
      entry.data[key] = rows
      entry.dirty = true
      added++
    },

    /**
     * 一轮更新收尾：把新取到的写盘，窗口外的文件删掉，内存里的放掉。
     * 写盘失败只抛给调用方打一行日志，本轮节目单已经写出去了，不受影响。
     *
     * @param {string[]} keepDays 还在窗口里的日期
     * @returns {{ added: number }} 本轮新存了多少份「一台一天」
     */
    flush(keepDays) {
      const keep = new Set((keepDays || []).map(String))
      const pending = [...days].filter(([day, entry]) => entry.dirty && keep.has(day))
      const result = { added }
      days = new Map()
      added = 0
      if (pending.length) mkdirSync(dir, { recursive: true })
      for (const [day, entry] of pending) {
        const file = path.join(dir, `${day}.json`)
        // 先写临时文件再改名：写到一半断电，留下的是旧文件而不是半截 JSON
        writeFileSync(`${file}.tmp`, JSON.stringify(entry.data))
        renameSync(`${file}.tmp`, file)
      }
      let names = []
      try { names = readdirSync(dir) } catch { /* 目录还没建 */ }
      for (const name of names) {
        const match = name.match(DAY_FILE)
        if (match && (match[2] || !keep.has(match[1]))) {
          try { unlinkSync(path.join(dir, name)) } catch { /* 删不掉下轮再删 */ }
        }
      }
      return result
    },
  }
}
