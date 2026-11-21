import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('Hongguo requires admin access across pages, account operations and media', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hongguo-routing-'));
  process.env.mdataDir = root;
  const { handleHongguo, isHongguoPath, shutdownHongguo } = await import('../index.js');
  let access = { adminPath: 'control', accessPrefix: '', passAuthed: false, userAuthed: false, passConfigured: true };
  const server = createServer((req, res) => handleHongguo(req, res, req.url.split('?')[0].slice(access.accessPrefix.length), access));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await shutdownHongguo();
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, options = {}) => fetch(base + path, { redirect: 'manual', ...options });

  assert.equal(isHongguoPath('/hongguo'), true);
  assert.equal(isHongguoPath('/hongguo/api/account'), true);
  assert.equal(isHongguoPath('/hongguo-other/'), false);
  for (const path of ['/hongguo/', '/hongguo/app.js', '/hongguo/api/account', `/hongguo/hls/${'a'.repeat(48)}/index.m3u8`]) {
    const response = await get(path);
    assert.equal(response.status, 403, path);
    await response.body.cancel();
  }

  access = { ...access, passAuthed: true, userAuthed: true, passConfigured: false };
  assert.equal((await get('/hongguo/', { method: 'HEAD' })).status, 403);
  access = { ...access, userAuthed: false };
  assert.equal((await get('/hongguo/', { method: 'HEAD', headers: { 'X-Forwarded-For': '192.0.2.8' } })).status, 403);
  assert.equal((await get('/hongguo/', { method: 'HEAD' })).status, 200);

  access = { ...access, passConfigured: true };
  const redirect = await get('/hongguo');
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), './hongguo/');
  const page = await get('/hongguo/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /href="\.\.\/control#vod-sources">返回点播源<\/a>/);

  for (const accessPrefix of ['', '/admin-password']) {
    access = { ...access, accessPrefix };
    const directory = await get(accessPrefix + '/hongguo/api/playback-catalog');
    assert.equal(directory.status, 200);
    const { emby } = await directory.json();
    assert.equal(new URL(emby.server, base + accessPrefix + '/hongguo/').href, base + '/hongguo');
  }
  access = { ...access, accessPrefix: '' };
  const old = await get('/hongguo/emby/System/Info/Public');
  assert.equal(old.status, 404);
  await old.body.cancel();

  access = { ...access, passAuthed: false };
  const publicInfo = await get('/hongguo/System/Info/Public');
  assert.equal(publicInfo.status, 200);
  assert.equal((await publicInfo.json()).ProductName, 'Emby Server');
  const noSession = await get('/hongguo/Items');
  assert.equal(noSession.status, 401);
  await noSession.body.cancel();
  access = { ...access, passAuthed: true };

  const post = (headers, body = '{}') => get('/hongguo/api/account/poll', { method: 'POST', headers, body });
  const crossSite = await post({ 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(crossSite.status, 403);
  await crossSite.body.cancel();
  const foreignOrigin = await post({ 'Content-Type': 'application/json', Origin: 'https://example.test' });
  assert.equal(foreignOrigin.status, 403);
  await foreignOrigin.body.cancel();
  const plainText = await post({ 'Content-Type': 'text/plain', Origin: base });
  assert.equal(plainText.status, 415);
  await plainText.body.cancel();
  const oversized = await post({ 'Content-Type': 'application/json', Origin: base }, JSON.stringify({ id: 'x'.repeat(4096) }));
  assert.equal(oversized.status, 413);
  await oversized.body.cancel();
});
