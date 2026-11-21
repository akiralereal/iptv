import { AppError, Cache, episodeNumber, id, officialPage } from './common.mjs';
import { playerMetadata } from './browser.mjs';

const ORIGIN = 'https://api5-normal-sinfonlinea.fqnovel.com';
const SEGMENT_SECONDS = 60;
const MAX_DURATION = 86400;
const MAX_WINDOWS_PER_SEGMENT = 4;

export class HongguoDanmaku {
  cache = new Cache(160);

  constructor({ catalog, playback, session }) {
    this.catalog = catalog;
    this.playback = playback;
    this.session = session;
  }

  episode(ref) {
    return this.cache.get(`episode:${ref.id}`, 300000, async () => {
      const seriesId = id(ref.show.id);
      const detail = await this.catalog.detail(seriesId);
      const number = episodeNumber(ref.number, detail.total);
      const videoId = id(detail.episodes[number - 1]?.id);
      let duration = this.playback.episodeDuration(seriesId, number);
      if (!duration) {
        const page = await officialPage(`/player/${seriesId}/${videoId}`);
        duration = playerMetadata(page, seriesId, videoId).duration;
      }
      if (!Number.isFinite(duration) || duration < 1 || duration > MAX_DURATION) {
        throw new AppError('DANMAKU_DURATION_MISSING', '暂时无法确定这一集的弹幕时间轴');
      }
      return { seriesId, videoId, duration, videoID: `hongguo:${videoId}` };
    });
  }

  async metadata(ref, token) {
    const { videoID, duration } = await this.episode(ref);
    const query = new URLSearchParams({ api_key: token });
    return { schemaVersion: 1, videoID, duration, available: true,
      segmentSeconds: SEGMENT_SECONDS, segmentsURL: `Danmaku/Segments?${query}` };
  }

  async segment(ref, rawPart) {
    if (!/^[1-9]\d{0,3}$/.test(rawPart || '') || Number(rawPart) > MAX_DURATION / SEGMENT_SECONDS) {
      throw new AppError('INVALID_DANMAKU_PART', '弹幕分段无效', 400);
    }
    const part = Number(rawPart);
    const { seriesId, videoId, videoID, duration } = await this.episode(ref);
    const start = (part - 1) * SEGMENT_SECONDS, end = start + SEGMENT_SECONDS;
    return this.cache.get(`segment:${videoId}:${part}`, 180000, async () => {
      const items = await this.items({ seriesId, videoId, duration, start, end });
      return { schemaVersion: 1, videoID, part, start, end, items };
    });
  }

  async items({ seriesId, videoId, duration, start, end }) {
    const endpoint = `${ORIGIN}/novel/commentapi/comment/list/${videoId}/v1/`;
    const durationMs = Math.round(duration * 1000);
    const upper = Math.min(end * 1000, durationMs);
    let position = start * 1000, cursor = '';
    const items = new Map();
    for (let window = 0; window < MAX_WINDOWS_PER_SEGMENT && position < upper; window++) {
      const body = Buffer.from(JSON.stringify({
        aid: 8662, comment_source: 601, server_channel: 1000, comment_type: 20, compliance_status: 0,
        count: 90, cursor, group_id: videoId, group_type: 30, sort: 1,
        business_param: { book_id: seriesId, start_offset_time: position, playlet_item_duration: durationMs, need_danmaku_guide_type: [1, 3, 4, 2] },
      }));
      const result = await this.session.signedPost(endpoint, await this.session.parameters({ _rticket: Date.now() }), body);
      const data = result?.data;
      if (Number(result?.code ?? -1) !== 0 || !data || (data.data_list != null && !Array.isArray(data.data_list))) {
        throw new AppError('DANMAKU_UPSTREAM', '红果官方弹幕暂不可用', 502);
      }
      for (const row of data.data_list || []) {
        const comment = row?.comment;
        const commentId = String(comment?.comment_id ?? '');
        const time = Number(comment?.expand?.offset_time ?? NaN) / 1000;
        const text = comment?.common?.content?.text;
        if (!/^\d{1,24}$/.test(commentId) || !(time >= start && time < upper / 1000)
          || typeof text !== 'string' || !text.trim() || text.length > 300) continue;
        items.set(commentId, { id: commentId, time, text: text.trim(), color: '#FFFFFF', mode: 'scroll' });
      }
      const next = Number(data.extra?.next_query_danmaku_list_time);
      const nextCursor = data.common_list_info?.cursor;
      if (!data.common_list_info?.has_more || !Number.isSafeInteger(next) || next <= position || typeof nextCursor !== 'string') break;
      position = next;
      cursor = nextCursor;
    }
    return [...items.values()].sort((a, b) => a.time - b.time);
  }
}
