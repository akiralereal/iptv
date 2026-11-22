import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('Hongguo requires admin access across pages, account operations and media', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hongguo-routing-'));
  process.env.mdataDir = root;
  const { createHongguoEmbyPort, handleHongguo, isHongguoPath, shutdownHongguo } = await import('../index.js');
  let access = { adminPath: 'control', accessPrefix: '', passAuthed: false, userAuthed: false };
  const server = createServer((req, res) => handleHongguo(req, res, req.url.split('?')[0].slice(access.accessPrefix.length), access));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const portProbe = createServer();
  let portSettings;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (portProbe.listening) await new Promise(resolve => portProbe.close(resolve));
    await portSettings?.close();
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

  access = { ...access, passAuthed: true, userAuthed: true };
  assert.equal((await get('/hongguo/', { method: 'HEAD' })).status, 403);
  access = { ...access, userAuthed: false };
  // 与 IPTV 后台同一规矩：能进后台（没设密码，或带了密码路径）就能进，不再区分本机与局域网
  assert.equal((await get('/hongguo/', { method: 'HEAD', headers: { 'X-Forwarded-For': '192.0.2.8' } })).status, 200);
  assert.equal((await get('/hongguo/', { method: 'HEAD' })).status, 200);

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
    assert.equal(emby.directPort, undefined);
  }
  access = { ...access, accessPrefix: '' };

  const postPort = (port, options = {}) => get('/hongguo/api/playback-catalog', {
    method: 'POST', headers: { 'content-type': 'application/json', ...options }, body: JSON.stringify({ directPort: port }),
  });
  const mainPort = server.address().port;
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const startingPort = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  portSettings = createHongguoEmbyPort(mainPort, { host: '127.0.0.1', initialPort: String(startingPort) });
  assert.equal(portSettings.status().port, 1906);
  await portSettings.start();
  access = { ...access, embyPort: portSettings };
  const directBase = `http://127.0.0.1:${startingPort}`;
  const directory = await get('/hongguo/api/playback-catalog').then(response => response.json());
  assert.equal(directory.emby.directPort, startingPort);
  for (const path of ['/System/Info/Public', '/emby/System/Info/Public']) {
    const info = await fetch(directBase + path);
    assert.equal(info.status, 200);
    const publicInfo = await info.json();
    assert.equal(publicInfo.IPTVBridge, 'hongguo');
    assert.deepEqual(publicInfo, await get('/hongguo/System/Info/Public').then(response => response.json()));
  }
  const anonymous = await fetch(directBase + '/Items');
  assert.equal(anonymous.status, 401);
  await anonymous.body.cancel();
  const signIn = await fetch(directBase + '/emby/Users/AuthenticateByName', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Username: directory.emby.username, Pw: directory.emby.password }),
  });
  assert.equal(signIn.status, 200);
  const { User, AccessToken } = await signIn.json();
  const auth = { headers: { 'x-emby-token': AccessToken } };
  const mediaPath = `/Users/${User.Id}/Views`;
  const views = await fetch(directBase + mediaPath, auth);
  assert.equal(views.status, 200);
  assert.deepEqual(await views.json(), await get('/hongguo' + mediaPath, auth).then(response => response.json()));
  for (const path of ['/control', '/hongguo/', '/api/playback-catalog', '/emby/api/account']) {
    const response = await fetch(directBase + path, auth);
    assert.equal(response.status, 404, path);
    await response.body.cancel();
  }

  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const newPort = portProbe.address().port;
  const inUse = await postPort(newPort);
  assert.equal(inUse.status, 409);
  assert.equal((await inUse.json()).code, 'EMBY_PORT_IN_USE');
  assert.equal(portSettings.status().listeningPort, startingPort);
  const invalid = await postPort(mainPort);
  assert.equal(invalid.status, 400);
  await invalid.body.cancel();
  const foreignPort = await postPort(newPort, { 'sec-fetch-site': 'cross-site' });
  assert.equal(foreignPort.status, 403);
  await foreignPort.body.cancel();
  await new Promise(resolve => portProbe.close(resolve));
  const saved = await postPort(newPort);
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).emby.directPort, newPort);
  await assert.rejects(fetch(directBase + '/System/Info/Public'));
  await portSettings.close();
  portSettings = createHongguoEmbyPort(mainPort, { host: '127.0.0.1', initialPort: String(startingPort) });
  await portSettings.start();
  access = { ...access, embyPort: portSettings };
  assert.equal(portSettings.status().listeningPort, newPort);
  const resumed = await fetch(`http://127.0.0.1:${newPort}` + mediaPath, auth);
  assert.equal(resumed.status, 200);
  await resumed.body.cancel();

  access = { ...access, passAuthed: false };
  // Emby 官方 App 等会在服务器地址后自动加 /emby，两种写法都要能用
  for (const prefix of ['/hongguo', '/hongguo/emby', '/hongguo/Emby']) {
    const publicInfo = await get(prefix + '/System/Info/Public');
    assert.equal(publicInfo.status, 200, prefix);
    assert.equal((await publicInfo.json()).ProductName, 'Emby Server');
    const noSession = await get(prefix + '/Items');
    assert.equal(noSession.status, 401, prefix);
    await noSession.body.cancel();
  }
  // /emby 前缀只对 Emby 接口生效，管理页和管理接口照样要 IPTV 访问密码
  for (const path of ['/hongguo/emby/', '/hongguo/emby/api/account', '/hongguo/emby/app.js']) {
    const response = await get(path);
    assert.equal(response.status, 403, path);
    await response.body.cancel();
  }
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
