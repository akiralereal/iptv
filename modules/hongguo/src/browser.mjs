import { closeBrowser, launchBrowser } from '../../../utils/browserLauncher.js';
import { ORIGIN, USER_AGENT, AppError, mediaURL, parseRouter } from './common.mjs';

export function playerMetadata(loader, seriesId, videoId) {
  const row = Object.values(loader || {}).find(v => v?.series_id && v?.vid);
  if (!row || String(row.series_id) !== seriesId || String(row.vid) !== videoId) throw new AppError('EPISODE_REDIRECT', '官网未返回所选集数，已阻止误播其他集', 409);
  const seo = row.publicVideoSeo;
  if (seo && (String(seo.itemId) !== videoId || String(seo.seriesId) !== seriesId)) throw new AppError('IDENTITY_MISMATCH', '官网媒体标识与所选集数不一致', 409);
  const duration = Number(seo?.durationSeconds || row.video_player_info?.duration);
  return { duration: duration > 0 ? duration : null, available: seo?.available, protected: row.protectedPlayback === true };
}
export class OfficialBrowser {
  instance = null;
  queue = Promise.resolve();
  closed = false;

  serial(task) {
    const job = this.queue.then(task);
    this.queue = job.catch(() => {});
    return job;
  }

  async withPage(task) {
    if (this.closed) throw new AppError('PLAY_CANCELLED', '播放已取消');
    const browser = await launchBrowser({
      label: '红果短剧',
      waitMs: 5000,
      launchOptions: { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false },
    });
    this.instance = browser;
    try {
      if (this.closed) throw new AppError('PLAY_CANCELLED', '播放已取消');
      const page = await browser.newPage();
      await page.setViewport({ width: 1365, height: 900 });
      page.setDefaultTimeout(25000);
      return await task(page);
    } finally {
      if (this.instance === browser) {
        this.instance = null;
        await closeBrowser(browser, { label: '红果短剧' });
      }
    }
  }

  describe(seriesId, videoId) {
    return this.serial(() => this.withPage(async page => {
      await page.setUserAgent(USER_AGENT);
      let duration = null; const jobs = [];
      page.on('response', response => {
        const url = new URL(response.url());
        if (url.origin !== ORIGIN || url.pathname !== '/api/video/protected/play-info') return;
        let request; try { request = JSON.parse(response.request().postData()); } catch { return; }
        if (String(request.series_id) !== seriesId || String(request.item_id) !== videoId) return;
        jobs.push(response.json().then(data => {
          // Read only the official duration; encrypted URLs and key material are not retained or used.
          if (response.ok() && data.base_resp?.StatusCode === 0 && Number(data.play_info?.duration) > 0) duration = Number(data.play_info.duration);
        }).catch(() => {}));
      });
      await page.goto(`${ORIGIN}/player/${seriesId}/${videoId}`, { waitUntil: 'networkidle2', timeout: 40000 });
      await Promise.allSettled(jobs);
      const meta = playerMetadata(await page.evaluate(() => window._ROUTER_DATA?.loaderData || {}), seriesId, videoId);
      return duration || meta.duration;
    }));
  }
  resolve(seriesId, videoId) {
    return this.serial(() => this.withPage(async page => {
      let candidate = null; let denied = false; const pending = new Set();
      page.on('response', response => {
        const u = new URL(response.url());
        if (u.origin !== ORIGIN || u.pathname !== '/api/video/protected/fallback-play-info') return;
        let request;
        try { request = JSON.parse(response.request().postData()); } catch { return; }
        if (String(request.item_id) !== videoId) return;
        const work = response.json().then(data => {
          if (!response.ok() || data.base_resp?.StatusCode !== 0) { denied = true; return; }
          if (data.main_url) candidate = { url: mediaURL(data.main_url), expiresAt: Number(data.url_expire) * 1000 };
        }).catch(() => {}).finally(() => pending.delete(work));
        pending.add(work);
      });
      const navigation = await page.goto(`${ORIGIN}/player/${seriesId}/${videoId}`, { waitUntil: 'networkidle2', timeout: 40000 });
      if (!navigation?.ok()) throw new AppError('PLAYBACK_UNAVAILABLE', '官网未开放所选集数的网页播放', 403);
      let metadata;
      try { metadata = playerMetadata(parseRouter(await navigation.text()), seriesId, videoId); }
      catch (e) { if (e.code === 'EPISODE_REDIRECT' || e.code === 'IDENTITY_MISMATCH') throw e; }
      for (let i = 0; i < 12 && !candidate && !denied; i++) await new Promise(r => setTimeout(r, 500));
      await Promise.allSettled([...pending]);
      const loader = await page.evaluate(() => window._ROUTER_DATA?.loaderData || {});
      const current = playerMetadata(loader, seriesId, videoId);
      metadata = { ...metadata, ...current, duration: current.duration || metadata?.duration || null };
      if (!candidate || denied) throw new AppError('PLAYBACK_UNAVAILABLE', '官网暂未提供此集可用的网页媒体', 403);
      if (!Number.isFinite(candidate.expiresAt) || candidate.expiresAt <= Date.now() + 30000) throw new AppError('EXPIRED', '官网播放地址已过期，请重试');
      return { ...candidate, expectedDuration: metadata.duration, identityVerified: true, provider: 'official_browser' };
    }));
  }

  async close() {
    this.closed = true;
    const browser = this.instance;
    this.instance = null;
    await Promise.all([closeBrowser(browser, { label: '红果短剧' }), this.queue]);
  }
}
