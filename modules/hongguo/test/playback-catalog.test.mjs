import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PlaybackCatalog } from '../src/playback-catalog.mjs';

test('the playback catalog preserves publications and rotates existing Emby sessions', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hongguo-ceau-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = {
    async detail(id) {
      return { id, title: `Series ${id}`, cover: '', intro: '', total: 3, tags: [], privateField: 'ignored' };
    },
  };
  const publisher = new PlaybackCatalog(root, catalog);
  const { key } = await publisher.ensure();
  assert.match(key, /^[a-f0-9]{64}$/);
  await Promise.all([publisher.set('1', true), publisher.set('2', true)]);
  await publisher.set('1', true);

  const restored = new PlaybackCatalog(root, catalog);
  const { series: list } = await restored.read();
  assert.deepEqual(list.map(item => item.id), ['1', '2']);
  assert.equal(list[0].total, 3);
  assert.equal(list[0].privateField, undefined);
  assert.equal((await stat(restored.file)).mode & 0o777, 0o600);
  await restored.set('1', false);
  await restored.update(state => ({ ...state, jellyfinSessions: [{ id: 'existing-session' }] }));
  const rotated = await restored.rotate();
  assert.notEqual(rotated.key, key);
  assert.equal(rotated.serverId, (await publisher.read()).serverId);
  assert.deepEqual(rotated.jellyfinSessions, []);
  assert.deepEqual(rotated.series.map(item => item.id), ['2']);
});
