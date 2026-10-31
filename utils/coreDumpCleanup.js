// 崩溃转储（core dump）清理：宿主机 core_pattern 是相对路径时，崩溃的进程会把内存快照写进自己的工作目录，
// 单个几十 MB，日积月累能把容器层撑到十几 GB。镜像已用 ulimit -c 0 关掉生成，这里兜住裸跑部署和升级前留下的。
//
// 文件名和内容都对上才删：名字以 core 开头，且 ELF 头标明是 core 文件，别的同名文件（core.js 等）一律不碰。

import { closeSync, openSync, readdirSync, readSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { printGreen, printRed } from './colorOut.js'
import { DATA_DIR } from './paths.js'

const CORE_NAME_RE = /^core(\.|$)/
const ELF_HEADER_BYTES = 18
const ET_CORE = 4

export function isCoreDump(path) {
  const header = Buffer.alloc(ELF_HEADER_BYTES)
  let fd
  try {
    fd = openSync(path, 'r')
    if (readSync(fd, header, 0, ELF_HEADER_BYTES, 0) < ELF_HEADER_BYTES) return false
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  if (header.readUInt32BE(0) !== 0x7f454c46) return false
  // 第 6 字节是字节序：1 小端，2 大端
  const type = header[5] === 2 ? header.readUInt16BE(16) : header.readUInt16LE(16)
  return type === ET_CORE
}

/** 清掉工作目录和数据目录里的 core 文件，返回删除个数与释放字节数。 */
export function cleanCoreDumps({ dirs = [process.cwd(), DATA_DIR] } = {}) {
  let count = 0
  let bytes = 0
  for (const dir of new Set(dirs)) {
    let names
    try {
      names = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of names) {
      if (!entry.isFile() || !CORE_NAME_RE.test(entry.name)) continue
      const path = join(dir, entry.name)
      if (!isCoreDump(path)) continue
      try {
        const { size } = statSync(path)
        unlinkSync(path)
        count += 1
        bytes += size
      } catch (error) {
        printRed(`清理崩溃转储失败 ${path}: ${error.message}`)
      }
    }
  }
  if (count) printGreen(`已清理 ${count} 个崩溃转储，释放 ${(bytes / 1024 / 1024).toFixed(1)} MB`)
  return { count, bytes }
}
