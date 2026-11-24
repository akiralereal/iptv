// 已下线功能留在数据目录里的文件：启动时删一次，之后目录不在了就什么都不做。
//
// 红果短剧点播（hongguo-vod/）：红果登录 Cookie、App 设备会话、Emby 播放凭据、观看记录和转码缓存。
// 模块下线后没人再读，登录凭据也不该一直留着；崩溃残留的转码缓存原本靠模块自己 24 小时后清，现在也没人清。

import { lstatSync, rmSync } from 'node:fs'
import { printGreen, printRed } from './colorOut.js'
import { dataPath } from './paths.js'

export const RETIRED_DATA = [
  { name: 'hongguo-vod', label: '红果短剧' },
]

/** 删掉数据目录里已下线功能的目录，返回删掉的名字。 */
export function removeRetiredData({ entries = RETIRED_DATA, resolve = dataPath } = {}) {
  const removed = []
  for (const { name, label } of entries) {
    const target = resolve(name)
    try {
      lstatSync(target)
    } catch {
      continue
    }
    try {
      // 是符号链接时只删链接本身，不跟进去
      rmSync(target, { recursive: true, force: true })
      removed.push(name)
      printGreen(`已删除${label}（已下线）留在数据目录的文件：${target}`)
    } catch (error) {
      printRed(`删除${label}（已下线）残留文件失败 ${target}: ${error.message}`)
    }
  }
  return removed
}
