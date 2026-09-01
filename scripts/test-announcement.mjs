#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  ANNOUNCEMENT, ANNOUNCEMENT_CHANNEL_KEY, announcementM3uEntry, announcementTxtEntry,
  protectAnnouncementConfig, readAnnouncementAsset,
} from '../utils/announcement.js'
import { applyConfig } from '../utils/playlistConfig.js'

console.log('公告频道测试')

const m3u = announcementM3uEntry()
assert.match(m3u, /group-title="公告",欢迎使用 iPTV/)
assert.ok(m3u.includes('${replace}/assets/announcement.mp4'))
assert.ok(m3u.includes('${replace}/assets/announcement-logo.png'))

const txt = announcementTxtEntry()
assert.equal(txt, `公告,#genre#\n欢迎使用 iPTV,\${replace}/assets/announcement.mp4\n`)

const video = readAnnouncementAsset(ANNOUNCEMENT.videoPath)
const logo = readAnnouncementAsset(ANNOUNCEMENT.logoPath)
assert.equal(video?.contentType, 'video/mp4')
assert.equal(video?.content.subarray(4, 8).toString('ascii'), 'ftyp')
assert.equal(logo?.contentType, 'image/png')
assert.deepEqual([...logo.content.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])

const protectedConfig = protectAnnouncementConfig({
  hiddenChannels: [ANNOUNCEMENT_CHANNEL_KEY, '央视::c1'],
  deletedGroups: ['公告', '公*', '影视'],
  groupOrder: ['体育', '公告', '央视'],
  channelGroupMap: { [ANNOUNCEMENT_CHANNEL_KEY]: '影视', '央视::c1': '收藏' },
  channelRenameMap: { [ANNOUNCEMENT_CHANNEL_KEY]: '别删我' },
  channelOrder: { 公告: [ANNOUNCEMENT_CHANNEL_KEY], 央视: ['央视::c1'] },
  groupRenameMap: { 公告: '别的名字', 央视: '中央台' },
  groupSortMode: { 公告: 'name', 央视: 'name' },
})
assert.deepEqual(protectedConfig.hiddenChannels, ['央视::c1'])
assert.deepEqual(protectedConfig.deletedGroups, ['公*', '影视'])
assert.deepEqual(protectedConfig.groupOrder, ['公告', '体育', '央视'])
assert.equal(protectedConfig.channelGroupMap[ANNOUNCEMENT_CHANNEL_KEY], undefined)
assert.equal(protectedConfig.channelRenameMap[ANNOUNCEMENT_CHANNEL_KEY], undefined)
assert.equal(protectedConfig.channelOrder.公告, undefined)
assert.equal(protectedConfig.groupRenameMap.公告, undefined)
assert.equal(protectedConfig.groupSortMode.公告, undefined)
assert.equal(protectedConfig.channelGroupMap['央视::c1'], '收藏')

const forced = applyConfig([
  { name: '央视', channels: [{ id: 'c1', name: 'CCTV1', tvgId: 'CCTV1', tvgName: 'CCTV1', originalGroup: '央视' }] },
  { name: '公告', channels: [{ id: ANNOUNCEMENT.tvgId, name: ANNOUNCEMENT.name, tvgId: ANNOUNCEMENT.tvgId, tvgName: ANNOUNCEMENT.name, originalGroup: '公告', url: `\${replace}${ANNOUNCEMENT.videoPath}` }] },
], {
  hiddenChannels: [ANNOUNCEMENT_CHANNEL_KEY],
  deletedGroups: ['公*'],
  groupOrder: ['央视', '公告'],
  channelGroupMap: { [ANNOUNCEMENT_CHANNEL_KEY]: '央视' },
  channelRenameMap: { [ANNOUNCEMENT_CHANNEL_KEY]: '伪公告' },
  channelOrder: {}, groupRenameMap: { 公告: '其它' }, groupSortMode: {}, customGroups: [],
})
assert.equal(forced[0].name, ANNOUNCEMENT.group)
assert.equal(forced[0].channels.length, 1)
assert.equal(forced[0].channels[0].name, ANNOUNCEMENT.name)

console.log('全部通过：公告条目、视频与台标资源有效 ✅')
