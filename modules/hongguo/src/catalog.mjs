import { ORIGIN, AppError, Cache, id, imageURL, officialPage } from './common.mjs';

export function card(row) {
  const seriesId = id(String(row.series_id || ''));
  return {
    id: seriesId, title: String(row.series_name || row.series_title || row.title || seriesId),
    cover: imageURL(row.series_cover || row.cover), intro: String(row.series_intro || row.video_desc || ''),
    total: Number(row.episode_cnt) || 0,
    tags: (row.tags || row.category_list || []).map(t => typeof t === 'string' ? t : t.name).filter(Boolean).slice(0,8),
    official: `${ORIGIN}/detail?series_id=${seriesId}`,
  };
}
export function normalizeDetail(row, seriesId) {
  if (String(row?.series_id) !== seriesId) throw new AppError('IDENTITY_MISMATCH', '官网返回了另一个剧目');
  const videos = row.vid_list;
  if (!Array.isArray(videos) || !videos.length || videos.length !== Number(row.episode_cnt) || new Set(videos).size !== videos.length) throw new AppError('INCOMPLETE_CATALOG', '官网没有返回完整且唯一的分集目录');
  const item = card(row);
  return { ...item, webCount: Number(row.accessible_episode_cnt) || 0, episodes: videos.map((vid, i) => ({ number: i + 1, id: id(String(vid)) })), fetchedAt: new Date().toISOString() };
}
export class Catalog {
  cache = new Cache();
  detail(seriesId) {
    id(seriesId);
    return this.cache.get('detail:' + seriesId, 300000, async () => {
      const data = await officialPage('/detail?series_id=' + seriesId);
      return normalizeDetail(data.detail_page?.seriesDetail, seriesId);
    });
  }
}
