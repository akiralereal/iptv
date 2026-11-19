import assert from 'node:assert/strict'

import { getModule, resolverFor } from '../extractors/registry.js'
import {
  buildChannels,
  clearCache,
  isOfficialStreamUrl,
  normalizeScene,
  primeSceneCache,
  resolveChannel,
  SCENE_URL,
} from '../extractors/songjiang/api.js'

const now = 1_788_080_000_000
const streamUrl = 'https://xhmm-new-live.media.xinhuamm.net/liveExtendRecord/'
  + '570a50fba2c146ca9efa552ed8300ec4_d2e87654f9424ad98c8de235775e1f6c.m3u8'
  + '?auth_key=2059029816-85270cb9e6cd4395ad44414c90ce145f-0-fa6ce28c85f80478631c129eea0e02bd'
const payload = {
  data: [
    {
      id: 15894,
      liveId: 1964,
      title: '测试',
      displayState: 1,
      streamType: 1,
      resource: { hlsUrl: streamUrl, liveId: 1964, siteId: '570a50fba2c146ca9efa552ed8300ec4', type: 1, useState: 1 },
    },
    {
      id: 2023,
      liveId: 1964,
      title: '松江慢直播',
      displayState: 1,
      streamType: 3,
      coverImg: 'https://media.sjmedia.net/live/default/image/2023/09/21/example.jpg',
      resource: {
        hlsUrl: streamUrl,
        liveId: 1964,
        siteId: '570a50fba2c146ca9efa552ed8300ec4',
        type: 3,
        useState: 1,
      },
    },
  ],
}

assert.equal(new URL(SCENE_URL).hostname, 'media.sjmedia.net')
assert.equal(isOfficialStreamUrl(streamUrl, now), true)
assert.equal(isOfficialStreamUrl(streamUrl.replace('xhmm-new-live.media.xinhuamm.net', 'evil.example'), now), false)
assert.equal(isOfficialStreamUrl(streamUrl.replace('2059029816', '1700000000'), now), false)

const row = normalizeScene(payload, now)
assert.deepEqual(row, {
  id: '2023',
  name: '松江融媒慢直播',
  url: streamUrl,
  logo: 'https://media.sjmedia.net/live/default/image/2023/09/21/example.jpg',
})
assert.deepEqual(buildChannels(row), [{
  name: '松江融媒慢直播',
  deferredRef: 'songjiang-slow-live',
  relayHls: true,
  catchup: 'none',
  logo: row.logo,
  opts: ['network-caching=3000'],
}])
assert.equal(normalizeScene({ data: [payload.data[0]] }, now), null)

clearCache()
primeSceneCache(row, now)
const resolved = await resolveChannel('songjiang-slow-live', { now })
assert.equal(resolved.url, streamUrl)
assert.equal(resolved.relayHls, true)
assert.equal((await resolveChannel('songjiang-test', { now })).url, '')
clearCache()

const module = getModule('songjiang')
assert.ok(module)
assert.equal(module.outputGroupName, '上海景观')
assert.equal(module.capabilities.resolve, true)
assert.equal(resolverFor('songjiang-slow-live')?.id, 'songjiang')
assert.equal(resolverFor('songjiang-slow-live/extra'), null)

console.log('✓ 上海松江慢直播场景筛选、地址边界、解析与注册测试通过')
