#!/usr/bin/env node
/** 看看新闻当前节目取流、版权状态与节目交接时的缓存回归。 */
import assert from 'node:assert/strict'
import { constants, generateKeyPairSync, privateEncrypt } from 'node:crypto'
import {
  CHANNEL_DETAIL_URL, PROGRAM_LIST_URL, PROGRAM_DETAIL_URL,
  clearCache, resolveChannel,
} from '../extractors/kankanews/api.js'

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
// UTC 尚未换日，上海已是次日，避免部署服务器时区影响节目选择。
const now = Date.parse('2026-09-03T16:00:00Z')
const start = now / 1000
const stream = suffix => {
  const token = Buffer.from(JSON.stringify({ exp: start + 3600 })).toString('base64url')
  return `https://volc-stream.kksmg.com/live/${suffix}/index.m3u8?token=x.${token}.x`
}
function encrypt(plain) {
  const bytes = Buffer.from(plain)
  const blocks = []
  for (let offset = 0; offset < bytes.length; offset += 117) {
    blocks.push(privateEncrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, bytes.subarray(offset, offset + 117)))
  }
  return Buffer.concat(blocks).toString('base64')
}
function fixture() {
  clearCache()
  const state = {
    channel: { id: 1, is_exist_program: 1, live_address: '', limit_time: 180 },
    programs: [
      { id: 101, name: '上一节目', start_time: start - 600, end_time: start, is_shield: 0 },
      { id: 102, name: '当前节目', start_time: start, end_time: start + 600, is_shield: 0 },
      { id: 103, name: '下一节目', start_time: start + 600, end_time: start + 1200, is_shield: 0 },
    ],
    detail: { channel_id: 1, is_shield: 0, channel_info: { id: 1, live_address: encrypt(stream('current')) } },
    calls: [],
    fail: false,
  }
  state.resolve = (time = now) => resolveChannel('kankanews-1', {
    now: time, publicKey,
    fetchImpl: async (target, options) => {
      const url = new URL(target)
      const endpoint = url.origin + url.pathname
      state.calls.push(endpoint)
      assert.match(options.headers.sign, /^[a-f0-9]{32}$/)
      if (state.fail) throw new Error('模拟网络超时')
      let result
      if (endpoint === CHANNEL_DETAIL_URL) result = state.channel
      else if (endpoint === PROGRAM_LIST_URL) {
        assert.equal(url.searchParams.get('channel_id'), '1')
        assert.equal(url.searchParams.get('date'), '2026-09-04')
        result = { programs: state.programs }
      } else {
        assert.equal(endpoint, PROGRAM_DETAIL_URL)
        assert.equal(url.searchParams.get('channel_program_id'), time < now + 600000 ? '102' : '103')
        result = state.detail
      }
      return { ok: true, json: async () => ({ code: '1000', result }) }
    },
  })
  return state
}

{
  const f = fixture()
  assert.equal((await f.resolve()).url, stream('current'), '空频道地址应改从当前节目取流')
  assert.deepEqual(f.calls, [CHANNEL_DETAIL_URL, PROGRAM_LIST_URL, PROGRAM_DETAIL_URL])
  assert.equal((await f.resolve(now + 1000)).url, stream('current'))
  assert.equal(f.calls.length, 3, '轮询播放清单应复用解析缓存')
  f.detail.channel_info.live_address = encrypt(stream('refreshed'))
  assert.equal((await f.resolve(now + 150000)).url, stream('refreshed'))
  assert.equal(f.calls.length, 6, '150 秒后重新验签取流')
  f.detail.channel_info.live_address = encrypt(stream('next'))
  assert.equal((await f.resolve(now + 600000)).url, stream('next'), '节目交接后选择新节目并换流')
}
{
  const f = fixture()
  f.programs[1].end_time = start + 60
  f.programs[2].start_time = start + 60
  assert.equal((await f.resolve()).url, stream('current'))
  f.programs[2].is_shield = 1
  const blocked = await f.resolve(now + 60000)
  assert.equal(blocked.url, '', '节目结束后，即使旧 token 未过期也不能继续复用')
  assert.match(blocked.desc, /下一节目.*版权限制/)
}
{
  const f = fixture()
  await f.resolve()
  f.programs[1].is_shield = 1
  const blocked = await f.resolve(now + 150000)
  assert.equal(blocked.url, '', '官网明确屏蔽时不能使用旧缓存兜底')
  assert.match(blocked.desc, /当前节目.*版权限制/)
  f.programs[1].is_shield = 0
  f.fail = true
  assert.equal((await f.resolve(now + 151000)).url, '', '明确停供后清掉旧缓存')
}
{
  const f = fixture()
  await f.resolve()
  f.fail = true
  assert.equal((await f.resolve(now + 150000)).url, stream('current'), '临时网络失败仍可复用有效旧流')
  const calls = f.calls.length
  await f.resolve(now + 151000)
  assert.equal(f.calls.length, calls, '失败退避期间不重复请求')
  assert.equal((await f.resolve(now + 600000)).url, '', '网络失败不能让缓存跨越节目结束')
}
for (const [mutate, message] of [
  [f => { f.programs = [] }, /没有当前正在播出/],
  [f => { f.programs = null }, /没有返回节目列表/],
  [f => { f.detail.is_shield = 1 }, /版权限制/],
  [f => { f.detail.channel_info.live_address = '' }, /官网当前未提供直播地址/],
  [f => { f.detail.channel_info.id = 2 }, /频道与请求不一致/],
  [f => { f.detail.channel_info.live_address = 'broken!' }, /密文格式/],
]) {
  const f = fixture()
  mutate(f)
  const result = await f.resolve()
  assert.equal(result.url, '')
  assert.match(result.desc, message)
}
{
  const f = fixture()
  f.channel = { id: 1, is_exist_program: 0, live_address: encrypt(stream('no-program')), limit_time: 180 }
  assert.equal((await f.resolve()).url, stream('no-program'))
  assert.deepEqual(f.calls, [CHANNEL_DETAIL_URL], '无节目单频道保留原取流方式')
}
clearCache()
console.log('✓ 看看新闻当前节目取流、版权状态、上海日期与缓存交接测试通过')
