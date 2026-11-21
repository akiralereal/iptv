import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRouter, mediaURL, episodeNumber, Cache } from '../src/common.mjs';
import { normalizeDetail } from '../src/catalog.mjs';
import { playerMetadata } from '../src/browser.mjs';
import { assessCompleteness } from '../src/playback.mjs';

test('HTML data reader tolerates braces inside strings without executing JavaScript', () => {
  const data = { loaderData: { page: { title: '故事 } \\" { [ ]', ok: true } } };
  assert.deepEqual(parseRouter('<script>window._ROUTER_DATA = ' + JSON.stringify(data) + ';window.malicious=true</script>'), data.loaderData);
  assert.throws(() => parseRouter('window._ROUTER_DATA = {loaderData:doSomething()};'));
});
test('media allowlist rejects deceptive suffixes, credentials and local targets', () => {
  assert.equal(mediaURL('https://v3-hgweb.qznovelvod.com/video?id=1'), 'https://v3-hgweb.qznovelvod.com/video?id=1');
  for (const u of ['https://qznovelvod.com.evil.test/video', 'http://v3.qznovelvod.com/a', 'https://secret@v3.qznovelvod.com/a', 'https://127.0.0.1/a', 'https://v3.qznovelvod.com:444/a']) assert.throws(() => mediaURL(u));
});
test('episode list must belong to the requested series and contain all unique episodes', () => {
  const row = { series_id: '123', series_name: '测试', episode_cnt: 3, vid_list: ['10', '11', '12'] };
  assert.equal(normalizeDetail(row, '123').episodes[2].number, 3);
  assert.throws(() => normalizeDetail(row, '124'));
  assert.throws(() => normalizeDetail({ ...row, vid_list: ['10', '11'] }, '123'));
  assert.throws(() => normalizeDetail({ ...row, vid_list: ['10', '10', '12'] }, '123'));
});
test('a middle-episode request redirected to episode one is never accepted', () => {
  const loader = { page: { series_id: '123', vid: '1', publicVideoSeo: { seriesId: '123', itemId: '1', durationSeconds: 180 } } };
  assert.throws(() => playerMetadata(loader, '123', '38'), { code: 'EPISODE_REDIRECT' });
  assert.equal(playerMetadata(loader, '123', '1').duration, 180);
  loader.page.publicVideoSeo.itemId = '38';
  assert.throws(() => playerMetadata(loader, '123', '1'), { code: 'IDENTITY_MISMATCH' });
});
test('negative, fractional and out-of-range episode numbers are rejected', () => {
  for (const number of [-1, 0, 4.5, 77, 'NaN']) assert.throws(() => episodeNumber(number, 76));
  assert.equal(episodeNumber('76', 76), 76);
});
test('full decoding of a short preview does not prove the episode is complete', () => {
  const evidence = { expectedDuration: 180, duration: 180, decodedSeconds: 180, audio: true, video: true, finished: true, errors: false };
  assert.equal(assessCompleteness(evidence), 'complete');
  assert.equal(assessCompleteness({ ...evidence, duration: 20, decodedSeconds: 20 }), 'duration_mismatch');
  assert.equal(assessCompleteness({ ...evidence, expectedDuration: null }), 'duration_unconfirmed');
  assert.equal(assessCompleteness({ ...evidence, expectedDuration: Infinity }), 'duration_unconfirmed');
  assert.equal(assessCompleteness({ ...evidence, decodedSeconds: 30 }), 'decode_failed');
  assert.equal(assessCompleteness({ ...evidence, audio: false }), 'decode_failed');
  assert.equal(assessCompleteness({ ...evidence, errors: true }), 'decode_failed');
});
test('concurrent requests share work while failed results remain retryable', async () => {
  const cache = new Cache(2); let calls = 0;
  const loader = async () => { calls++; await new Promise(r => setTimeout(r, 5)); return 42; };
  assert.deepEqual(await Promise.all([cache.get('same', 100, loader), cache.get('same', 100, loader)]), [42, 42]);
  assert.equal(calls, 1);
  await assert.rejects(cache.get('fail', 100, () => { throw Error('temporary'); }));
  assert.equal(await cache.get('fail', 100, () => 7), 7);
});
