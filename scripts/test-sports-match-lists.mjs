#!/usr/bin/env node
/**
 * 体育赛事：basic-data 缺 multiPlayList 时不算抓取失败（issue #222 日志）。
 *
 * 还没排好转播、或咪咕没挂播放清单的场次，basic-data 里没有 multiPlayList。原本裸取
 * `.multiPlayList.liveList` 直接抛，日志里出现
 * 「体育赛事有 1 场抓取失败：Cannot read properties of undefined (reading 'liveList')」，
 * 而这场其实只是暂时没东西可放。
 *
 * 运行： node scripts/test-sports-match-lists.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'iptv-sports-lists-'))
process.env.mdataDir = TMP

const { matchLiveList, matchReplayList } = await import('../utils/updateData.js')

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('体育赛事直播 / 回放条目测试')

const live = [{ name: '直播', pID: 'p1', startTimeStr: '2026-11-01 20:00:00' }]
const replay = [{ name: '全场回放', pID: 'r1' }]

try {
  check('直播：basic-data 没有 multiPlayList → 空列表，不抛', () => {
    assert.deepEqual(matchLiveList({ endTime: Date.now() + 3600_000 }), [])
    assert.deepEqual(matchLiveList({ multiPlayList: {} }), [], 'multiPlayList 在但没有 liveList')
    assert.deepEqual(matchLiveList({ multiPlayList: { liveList: null } }), [])
    assert.deepEqual(matchLiveList(undefined), [])
  })

  check('直播：有 liveList 时原样返回', () => {
    assert.equal(matchLiveList({ multiPlayList: { liveList: live } }), live)
  })

  check('回放：优先回放接口；为空时回落 basic-data 的 replayList', () => {
    const other = [{ name: '另一路回放', pID: 'r2' }]
    assert.equal(matchReplayList({ replayList: replay }, { multiPlayList: { replayList: other } }), replay)
    assert.equal(matchReplayList({}, { multiPlayList: { replayList: other } }), other)
    // 回放接口抖动（fetchUrl 返回 undefined）也要走到兜底
    assert.equal(matchReplayList(undefined, { multiPlayList: { replayList: other } }), other)
    // 回放接口明确给了空数组：就是空，不回落（与原逻辑一致，只在 null/undefined 时回落）
    assert.deepEqual(matchReplayList({ replayList: [] }, { multiPlayList: { replayList: other } }), [])
  })

  check('回放：两处都没有、basic-data 缺 multiPlayList → null（按「无回放」处理），不抛', () => {
    assert.equal(matchReplayList(undefined, {}), null)
    assert.equal(matchReplayList({}, { endTime: 0 }), null)
    assert.equal(matchReplayList({ replayList: '坏数据' }, {}), null, '不是数组的不能拿去 for…of')
  })
} finally {
  rmSync(TMP, { recursive: true, force: true })
}

console.log(`\n全部通过：${passed} 项`)
