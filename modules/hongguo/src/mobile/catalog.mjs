import { randomBytes } from 'node:crypto';
import { AppError, Cache, ORIGIN, imageURL } from '../common.mjs';

const API = 'https://reading.snssdk.com';
const LIVE_ACTION_TYPE = 1;
const MAX_FILTERED_PAGES = 3;
const religious = /宗教|佛教|基督|天主|伊斯兰|传教/;
const parse = value => { try { return JSON.parse(value); } catch { return []; } };
export function seriesCard(row) {
  const id = String(row?.series_id || '');
  if (!/^\d{1,24}$/.test(id) || !row.title || !(Number(row.episode_cnt) > 0)) return null;
  const schema = Array.isArray(row.category_schema) ? row.category_schema : parse(row.category_schema);
  const tags = (Array.isArray(schema) ? schema : []).map(x => x?.name).filter(Boolean);
  if (tags.some(x => religious.test(x))) return null;
  return { id, title: String(row.title), cover: imageURL(row.cover), intro: String(row.video_desc || ''),
    total: Number(row.episode_cnt), tags, official: `${ORIGIN}/detail?series_id=${id}`, score: String(row.score || ''),
    subtitle: String(row.rec_text || row.sub_title || '') };
}
export function selectorRows(selector) {
  return (selector?.rows || []).map(row => ({ id: String(row.type), title: row.row_name,
    multiple: row.selection_type === 1, options: (row.items || []).filter(x => !religious.test(x.show_name || '')).map(x => ({
      id: x.selector_item_id, title: x.show_name, selected: !!x.is_default_selected,
    })) })).filter(row => row.options.length);
}
function success(data) {
  if (data?.code !== 0) throw new AppError('APP_CATALOG_REJECTED', '官方片库暂时不可用，请稍后重试');
  return data;
}
function unique(rows) { return [...new Map(rows.filter(Boolean).map(x => [x.id, x])).values()]; }
function assertAdvancingOffset(state, previous) {
  if (!Number.isSafeInteger(state.offset) || state.offset <= previous.offset) throw new AppError('APP_PAGE_STALLED', '官方分页没有前进，请稍后重试');
}
export class MobileCatalog {
  cache = new Cache(); cursors = new Map(); knownFilters = new Map();
  constructor(session) { this.session = session; }
  async categories() {
    return this.cache.get('categories', 600000, async () => {
      const data = success(await this.session.signedGet(API + '/reading/bookapi/new_category/front/v', { new_category_tab: 8, need_hot: true })).data;
      if (!Array.isArray(data?.category_tab_data?.cell_data)) throw new AppError('APP_CATEGORIES_CHANGED', '官方分类结构已变化');
      const groups = data.category_tab_data.cell_data.map(cell => ({ title: cell.cell_name,
        items: (cell.atom_data || []).map(x => x.category_data).filter(x => x && !religious.test(x.name)).map(x => ({ id: String(x.category_id), title: x.name })) })).filter(x => x.items.length);
      return { provider: 'official_app', groups };
    });
  }
  cursor(token, key) {
    if (!token) return { offset: 0 };
    const value = this.cursors.get(token);
    if (!value || value.key !== key || value.expires < Date.now()) throw new AppError('PAGE_EXPIRED', '这一页已过期，请刷新列表后继续', 409);
    return value.state;
  }
  next(key, state, previous, hasMore) {
    if (!hasMore) return null;
    assertAdvancingOffset(state, previous);
    for (const [token, value] of this.cursors) if (value.expires < Date.now()) this.cursors.delete(token);
    while (this.cursors.size >= 500) this.cursors.delete(this.cursors.keys().next().value);
    const token = randomBytes(18).toString('hex');
    this.cursors.set(token, { key, state, expires: Date.now() + 30 * 60000 }); return token;
  }
  selections(input, key) {
    if (typeof input !== 'string' || input.length > 1200 || !/^[\w,-]*$/.test(input)) throw new AppError('INVALID_FILTER', '筛选条件无效', 400);
    const values = [...new Set(input.split(',').filter(Boolean))].sort();
    if (values.length > 12 || values.some(x => !this.knownFilters.get(key)?.has(x))) throw new AppError('INVALID_FILTER', '请使用当前页面提供的筛选条件', 400);
    return values.join(',');
  }
  rememberFilters(key, rows) { this.knownFilters.set(key, new Set(rows.flatMap(x => x.options.map(y => y.id)))); }
  async page({ category = '0', filters = '', cursor = '', contentType = '' } = {}) {
    if (contentType !== '' && contentType !== 'real-drama') throw new AppError('INVALID_CONTENT_TYPE', '请选择已有的内容类型', 400);
    if (category !== '0' && !(await this.categories()).groups.some(g => g.items.some(x => x.id === category))) throw new AppError('INVALID_CATEGORY', '请选择已有分类', 400);
    const filterKey = 'catalog:' + category;
    if (filters && !this.knownFilters.has(filterKey)) await this.page({ category });
    filters = this.selections(filters, filterKey);
    const key = JSON.stringify(['catalog', category, filters, contentType]), state = this.cursor(cursor, key);
    return this.cache.get(key + ':' + (cursor || ''), 60000, async () => {
      let current = state;
      for (let pagesLeft = contentType ? MAX_FILTERED_PAGES : 1; ; pagesLeft--) {
        const data = success(await this.session.signedGet(API + '/reading/bookapi/new_category/landing/v', {
          category_id: category, genre_type: 130, offset: current.offset, limit: 18, selected_items: filters, session_id: current.session || '',
        })).data;
        if (!data || !('video_info' in data) || (data.video_info !== null && !Array.isArray(data.video_info))) throw new AppError('APP_CATALOG_CHANGED', '官方片库结构已变化');
        const videos = data.video_info || [];
        // 官方片库混合返回多种内容，按每条记录的类型筛选。
        const matches = contentType ? videos.filter(video => video?.content_type === LIVE_ACTION_TYPE) : videos;
        const items = unique(matches.map(seriesCard));
        const nextState = { offset: Number(data.offset), session: data.session_id };
        if (items.length || !data.has_more || pagesLeft === 1) {
          const rows = selectorRows(data.selector); this.rememberFilters(filterKey, rows);
          return { provider: 'official_app', items, filters: rows,
            cursor: this.next(key, nextState, current, data.has_more),
            hasMore: !!data.has_more, category, fetchedAt: new Date().toISOString() };
        }
        assertAdvancingOffset(nextState, current);
        current = nextState;
      }
    });
  }
  async search({ query, filters = '', cursor = '' } = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 80) throw new AppError('INVALID_QUERY', '请输入 1–80 字的剧名或演员名', 400);
    query = query.trim(); const filterKey = 'search';
    if (filters && !this.knownFilters.has(filterKey)) await this.search({ query });
    filters = this.selections(filters, filterKey);
    const key = JSON.stringify(['search', query, filters]), state = this.cursor(cursor, key);
    return this.cache.get(key + ':' + (cursor || ''), 60000, async () => {
      const data = success(await this.session.signedGet(API + '/reading/bookapi/search/tab/v', {
        query, offset: state.offset, tab_type: 29, count: 15, search_source: 2,
        selected_items: filters, search_id: state.searchId || '', passback: state.passback || '', user_is_login: 0,
      }));
      const tab = data.search_tabs?.find(x => x.tab_type === 29);
      if (!tab || (tab.data !== null && !Array.isArray(tab.data))) throw new AppError('APP_SEARCH_CHANGED', '官方搜索结构已变化');
      const rows = selectorRows(tab.selector).filter(x => x.id !== 'search_range'); this.rememberFilters(filterKey, rows);
      return { provider: 'official_app', query, items: unique((tab.data || []).flatMap(x => x.video_data || []).map(seriesCard)), filters: rows,
        cursor: this.next(key, { offset: Number(tab.next_offset), searchId: tab.search_id, passback: tab.passback }, state, tab.has_more),
        hasMore: !!tab.has_more, fetchedAt: new Date().toISOString() };
    });
  }
}
