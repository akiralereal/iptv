import { gzipSync } from 'node:zlib';
import { AppError, id } from '../common.mjs';
import { MobileSession, PROFILE, APP_VERSION, APP_BUILD } from './session.mjs';
import { mediaKey, unwrapMediaAddress } from './wire.mjs';
import { byteVC2Unsupported } from './bytevc2.mjs';

export function appMediaURL(value) {
  let url; try { url = new URL(value); } catch { throw new AppError('APP_MEDIA_INVALID', 'App 没有提供有效媒体地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !['qznovelvod.com', 'fqnovelvod.com', 'douyinvod.com'].some(host => url.hostname.endsWith('.' + host))) throw new AppError('APP_MEDIA_INVALID', 'App 媒体域名未获验证');
  return url.href;
}
export function exactModel(data, videoId) {
  if (Number(data?.code ?? data?.Code ?? -1) !== 0) throw new AppError('APP_PLAY_REJECTED', '官方 App 服务未授权此集播放');
  const entry = data.data?.[videoId];
  let model = entry?.video_model;
  if (typeof model === 'string') { try { model = JSON.parse(model); } catch { model = null; } }
  if (!model || typeof model !== 'object') throw new AppError('APP_EPISODE_MISMATCH', 'App 未返回所选分集的播放模型');
  if (!Number.isFinite(Number(model.video_duration)) || !(Number(model.video_duration) > 0)) throw new AppError('APP_DURATION_MISSING', 'App 未返回可核验的完整时长');
  return model;
}
export class MobileModels {
  constructor(root, { session, now = Date.now, cooldownMs = 30000 } = {}) { this.session = session || new MobileSession(root); this.now = now; this.cooldownMs = cooldownMs; this.blockedUntil = 0; this.queue = Promise.resolve(); }
  async model(videoId) {
    // A single failed probe gates subsequent foreground/preload requests. Do not
    // amplify an empty-response incident with per-episode retry loops.
    const work = this.queue.then(() => this.fetchModel(videoId)); this.queue = work.catch(() => {}); return work;
  }
  async fetchModel(videoId) {
    if (this.blockedUntil > this.now()) { const error = new AppError('APP_PLAYBACK_COOLDOWN', '官方 App 高清接口暂不可用，请稍后重试'); error.retryAfterSeconds = Math.ceil((this.blockedUntil - this.now()) / 1000); throw error; }
    id(videoId); const identity = await this.session.ready();
    const parameters = {
      ac: 'wifi', channel: 'update_64', aid: '8662', app_name: 'novelread', version_code: APP_BUILD, version_name: APP_VERSION,
      device_platform: 'android', os: 'android', ssmix: 'a', device_type: PROFILE.model, device_brand: PROFILE.brand,
      language: 'zh', os_api: PROFILE.api, os_version: PROFILE.os, manifest_version_code: APP_BUILD,
      resolution: PROFILE.resolution.replace('x', '*'), dpi: PROFILE.dpi, update_version_code: APP_BUILD,
      host_abi: 'arm64-v8a', dragon_device_type: 'phone', pv_player: APP_BUILD, compliance_status: 0,
      need_personal_recommend: 1, player_so_load: 1, is_android_pad_screen: 0,
      device_id: identity.deviceId, iid: identity.installationId, cdid: identity.clientId, _rticket: Date.now(),
    };
    const body = gzipSync(Buffer.from(JSON.stringify({ dr_scene: 'player',
      biz_param: { detail_page_version: 0, device_level: 3, disable_digg_stat: false, need_all_video_definition: true, need_mp4_align: false, use_os_player: false, use_server_dns: false, video_platform: 1024 },
      mixed_video_id_map: { '1004': [videoId] },
    })));
    const hosts = ['reading.snssdk.com', 'api5-normal-sinfonlinea.fqnovel.com'];
    if (this.preferredHost) hosts.sort((a, b) => (b === this.preferredHost) - (a === this.preferredHost));
    for (const [index, host] of hosts.entries()) {
      try {
        const model = exactModel(await this.session.signedPost(`https://${host}/novel/player/multi_video_model/player/v1`, parameters, body, { 'content-encoding': 'gzip' }), videoId);
        this.blockedUntil = 0; this.preferredHost = host; return model;
      } catch (error) {
        if (!['APP_NETWORK_FAILED', 'APP_EMPTY_RESPONSE', 'APP_RESPONSE_INVALID'].includes(error.code)) throw error;
        if (index === hosts.length - 1) { this.blockedUntil = this.now() + this.cooldownMs; throw error; }
      }
    }
  }
  async resolve(videoId) {
    const model = await this.model(videoId);
    let info = model;
    if (!model.video_list || !Object.keys(model.video_list).length) {
      let address = model.fallback_api;
      if (typeof address === 'string' && address.startsWith('{')) { try { address = JSON.parse(address).fallback_api; } catch { address = null; } }
      else if (typeof address === 'object') address = address?.fallback_api;
      if (!address) throw new AppError('APP_SOURCE_MISSING', 'App 未返回本集媒体清单');
      const response = await this.session.request(address);
      if (Number(response.code ?? response.Code ?? 0) || Number(response.video_info?.code ?? response.video_info?.Code ?? 0)) throw new AppError('APP_PLAY_REJECTED', '官方 App 服务未授权此集播放');
      info = response.video_info?.data;
    }
    const variants = Object.values(info?.video_list || {}).map(item => ({ item,
      codec: String(item.codec_type || item.video_meta?.codec_type || '').toLowerCase(),
      height: Number(item.height || item.vheight || item.video_meta?.height || item.video_meta?.vheight || 0),
    }));
    const candidates = variants.filter(x => ['h264', 'avc', 'avc1', 'hevc', 'h265', 'hvc1', 'hev1', 'bytevc1', 'bytevc2'].includes(x.codec));
    const rank = codec => ['h264', 'avc', 'avc1'].includes(codec) ? 0 : 1;
    // FFmpeg already converts HEVC to H.264; prefer actual resolution over the
    // input codec so an SD H.264 variant cannot displace an HD HEVC variant.
    candidates.sort((a, b) => Number(a.codec === 'bytevc2') - Number(b.codec === 'bytevc2')
      || b.height - a.height || rank(a.codec) - rank(b.codec));
    for (const { item, codec } of candidates) {
      const wrappedKey = item.spade_a || item.encrypt_info?.spade_a;
      if (!wrappedKey && item.encrypt_info && ![false, 0, '0', 'false'].includes(item.encrypt_info.encrypt)) continue;
      let key; try { key = wrappedKey ? mediaKey(wrappedKey) : null; } catch { continue; }
      const addresses = [item.main_url, item.backup_url, ...(Array.isArray(item.backup_url_list) ? item.backup_url_list : [])];
      for (const address of addresses) {
        if (typeof address !== 'string' || !address) continue;
        try {
          return { url: appMediaURL(info.key_seed ? unwrapMediaAddress(address, info.key_seed) : address), contentKey: key,
            expectedDuration: Number(model.video_duration), videoId, identityVerified: true, codec,
            provider: 'official_app', expiresAt: Date.now() + 10 * 60_000 };
        } catch {}
      }
    }
    if (variants.length && variants.every(({ codec }) => codec === 'bytevc2')) throw byteVC2Unsupported();
    throw new AppError('APP_SOURCE_UNSUPPORTED', 'App 没有返回兼容的完整媒体');
  }
}
