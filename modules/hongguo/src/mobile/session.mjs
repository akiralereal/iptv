import path from 'node:path';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { CookieJar } from 'tough-cookie';
import { AppError, boundedText, parseJSON } from '../common.mjs';
import { digest, registrationEnvelope } from './wire.mjs';
import { PlaybackSigner } from './signature.mjs';

const REGISTRATION = 'https://log5-applog-lf.fqnovel.com/service/2/device_register/?tt_data=a&cronet_version=8d40f833_2026-03-03&ttnet_version=4.2.243.31-douyin&use_store_region_cookie=1';
const HOSTS = new Set(['log5-applog-lf.fqnovel.com', 'reading.snssdk.com', 'api5-normal-sinfonlinea.fqnovel.com', 'api3-normal-sinfonlinea.fqnovel.com']);
export const PROFILE = Object.freeze({ model: 'Pixel 7', brand: 'Google', os: '13', api: 33, resolution: '1080x2400', dpi: 420 });
export const APP_VERSION = '7.4.3.32';
export const APP_BUILD = '74332';
export const APP_UA = `com.phoenix.read/${APP_BUILD} (Linux; U; Android ${PROFILE.os}; zh_CN; ${PROFILE.model}; Build/TQ3A.230805.001; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)`;

export class MobileSession {
  constructor(root, { fetcher = fetch, readOnly = false, onResponse } = {}) { this.file = path.join(root, '.runtime', 'app-session.json'); this.jar = new CookieJar(); this.fetcher = fetcher; this.readOnly = readOnly; this.onResponse = onResponse; this.signer = new PlaybackSigner({ profile: PROFILE, version: APP_VERSION }); }
  async ready() {
    if (this.identity) return this.identity;
    if (this.pending) return this.pending;
    this.pending = this.loadOrRegister().finally(() => { this.pending = null; });
    return this.pending;
  }
  save() {
    if (this.readOnly) return Promise.resolve();
    const job = (this.saving || Promise.resolve()).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = this.file + '.' + randomUUID() + '.tmp';
      await writeFile(temporary, JSON.stringify({ version: 1, identity: this.identity, cookies: await this.jar.serialize() }), { mode: 0o600 });
      await rename(temporary, this.file);
    });
    this.saving = job.catch(() => {}); return job;
  }
  async loadOrRegister() {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (saved.version !== 1 || !/^\d{1,24}$/.test(saved.identity?.deviceId) || !/^\d{1,24}$/.test(saved.identity?.installationId)) throw new Error('Invalid session');
      this.jar = await CookieJar.deserialize(saved.cookies); this.identity = saved.identity;
      return this.identity;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new AppError('APP_SESSION_INVALID', '本地 App 会话文件无效，请检查后再试');
    }
    if (this.readOnly) throw new AppError('APP_SESSION_MISSING', '没有可诊断的既有 App 会话');
    const clientId = randomUUID(), now = Date.now();
    const header = {
      display_name: '红果免费短剧', update_version_code: +APP_BUILD, manifest_version_code: +APP_BUILD,
      app_version_minor: APP_VERSION, aid: 8662, channel: 'update_64', package: 'com.phoenix.read', app_version: APP_VERSION, version_code: +APP_BUILD,
      sdk_version: '3.7.0-rc.34-fanqie-xiaoshuo', sdk_target_version: 29, git_hash: '3a88f4e',
      os: 'Android', os_version: PROFILE.os, os_api: PROFILE.api, device_model: PROFILE.model,
      device_brand: PROFILE.brand, device_manufacturer: PROFILE.brand, cpu_abi: 'arm64-v8a', release_build: 'b5e187f',
      density_dpi: PROFILE.dpi, display_density: 'mdpi', resolution: PROFILE.resolution, language: 'zh', timezone: 8,
      access: 'wifi', not_request_sender: 0, carrier: 'CHINA MOBILE', mcc_mnc: '46000', rom: 'TQ3A.230805.001', rom_version: 'TQ3A.230805.001 release-keys',
      cdid: clientId, sig_hash: '56a962410c494bbaf0b58dba20cae56f', openudid: randomBytes(8).toString('hex'), clientudid: randomUUID(),
      ipv6_list: [], region: 'CN', tz_name: 'Asia/Shanghai', tz_offset: 28800, sim_region: 'cn', sim_serial_number: [],
      oaid_may_support: false, req_id: randomUUID(), device_platform: 'android',
      custom: { account_region_src: 'fallback', account_region: 'cn', host_bit: 64, dragon_device_type: 'phone' },
      pre_installed_channel: '', apk_first_install_time: now, is_system_app: 0, sdk_flavor: 'china', guest_mode: 0,
    };
    const body = registrationEnvelope({ magic_tag: 'ss_app_log', header, _gen_time: now });
    const data = await this.request(REGISTRATION, { method: 'POST', body, headers: {
      'content-type': 'application/octet-stream;tt-data=a', 'log-encode-type': 'gzip',
      'x-ss-dp': '8662', 'x-ss-req-ticket': String(now), 'x-vc-bdturing-sdk-version': '4.0.3.cn',
      lc: '101', 'sdk-version': '2', 'passport-sdk-version': '5051452', 'x-neptune': '-8|50:51:59:30:40:47:49:39',
      'x-ss-stub': digest('md5', body).toString('hex').toUpperCase(),
    } });
    const deviceId = data.device_id_str, installationId = data.install_id_str;
    if (![deviceId, installationId].every(value => typeof value === 'string' && /^\d{1,24}$/.test(value) && /[1-9]/.test(value))) throw new AppError('APP_REGISTRATION_REJECTED', '官方设备注册未返回有效会话');
    this.identity = { deviceId, installationId, clientId, createdAt: new Date().toISOString() };
    for (const host of ['reading.snssdk.com', 'api5-normal-sinfonlinea.fqnovel.com', 'api3-normal-sinfonlinea.fqnovel.com']) {
      for (const pair of [`install_id=${installationId}`, 'store-region=cn-bj', 'store-region-src=did']) await this.jar.setCookie(`${pair}; Path=/; Secure; HttpOnly`, `https://${host}`);
    }
    await this.save(); return this.identity;
  }
  async request(address, { method = 'GET', body, headers = {} } = {}) {
    const url = new URL(address);
    if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) throw new AppError('APP_HOST_REJECTED', 'App 请求域名未获验证');
    let response; const started = performance.now();
    try {
      response = await this.fetcher(url, { method, body, headers: { accept: 'application/json', 'user-agent': APP_UA, cookie: await this.jar.getCookieString(url.href), ...headers }, redirect: 'error', signal: AbortSignal.timeout(25000) });
    } catch { throw new AppError('APP_NETWORK_FAILED', '官方 App 服务连接失败'); }
    for (const cookie of response.headers.getSetCookie()) await this.jar.setCookie(cookie, url.href, { ignoreError: true });
    if (this.identity) await this.save();
    if (!response.ok) { await response.body?.cancel(); throw new AppError('APP_HTTP_REJECTED', `官方 App 服务返回 ${response.status}`); }
    const raw = await boundedText(response, 2_000_000);
    const diagnostic = { host: url.hostname, path: url.pathname, status: response.status, bodyBytes: Buffer.byteLength(raw), contentType: response.headers.get('content-type'), elapsedMs: Math.round(performance.now() - started), checkedAt: new Date().toISOString() };
    this.onResponse?.(diagnostic);
    if (!raw.trim()) { const error = new AppError('APP_EMPTY_RESPONSE', '官方 App 高清接口返回空响应，尚未取得可用播放模型'); error.diagnostic = diagnostic; throw error; }
    try { return parseJSON(raw); } catch { throw new AppError('APP_RESPONSE_INVALID', `官方 App 服务未返回 JSON（${raw.length} 字节）`); }
  }
  async signedPost(endpoint, parameters, body, additional = {}) {
    await this.ready();
    const encode = value => encodeURIComponent(String(value)).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
    const query = Object.entries(parameters).map(([k, v]) => `${encode(k)}=${encode(v)}`).join('&');
    const signed = this.signer.sign(endpoint + '?' + query, body);
    return this.request(signed.url, { method: 'POST', body, headers: {
      'content-type': 'application/json; charset=UTF-8', 'sdk-version': '2', 'passport-sdk-version': '5051452',
      'x-xs-from-web': '0', 'x-ss-dp': String(parameters.aid), ...additional, ...signed.headers,
    } });
  }
  async parameters(extra = {}) {
    const identity = await this.ready();
    return { ac: 'wifi', channel: 'update_64', aid: '8662', app_name: 'novelread',
      version_code: APP_BUILD, version_name: APP_VERSION, device_platform: 'android', os: 'android', ssmix: 'a',
      device_type: PROFILE.model, device_brand: PROFILE.brand, language: 'zh', os_api: PROFILE.api,
      os_version: PROFILE.os, manifest_version_code: APP_BUILD, resolution: PROFILE.resolution.replace('x', '*'),
      dpi: PROFILE.dpi, update_version_code: APP_BUILD, host_abi: 'arm64-v8a', dragon_device_type: 'phone',
      ...extra, device_id: identity.deviceId, iid: identity.installationId, cdid: identity.clientId };
  }
  async signedGet(endpoint, extra = {}) {
    const parameters = await this.parameters(extra);
    const signed = this.signer.sign(endpoint + '?' + new URLSearchParams(parameters), Buffer.alloc(0));
    return this.request(signed.url, { headers: {
      'sdk-version': '2', 'passport-sdk-version': '5051452', 'x-ss-dp': '8662', ...signed.headers,
    } });
  }
}
