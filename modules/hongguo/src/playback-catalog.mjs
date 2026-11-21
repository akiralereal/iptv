import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError, id, imageURL } from './common.mjs';

const accessKey = /^[a-f0-9]{64}$/;
const newKey = () => randomBytes(32).toString('hex');
const limit = 200;

function summary(detail) {
  return {
    id: id(detail.id),
    title: String(detail.title).slice(0, 300),
    intro: String(detail.intro || '').slice(0, 3000),
    cover: imageURL(detail.cover),
    total: detail.total,
    tags: (detail.tags || []).slice(0, 8),
  };
}

export class PlaybackCatalog {
  constructor(root, catalog) {
    // Retain the original filename so publications, credentials and progress survive upgrades.
    this.file = path.join(root, '.runtime', 'ceau-catalog.json');
    this.catalog = catalog;
    this.tail = Promise.resolve();
  }

  async read() {
    this.loaded ||= readFile(this.file, 'utf8').then(text => {
      try {
        const value = JSON.parse(text);
        if (value.version === 1 && accessKey.test(value.key) && Array.isArray(value.series)) return value;
      } catch {}
      throw new AppError('PLAYBACK_CATALOG_INVALID', '无法读取 点播目录');
    }, error => {
      if (error.code === 'ENOENT') return { version: 1, key: null, series: [] };
      throw error;
    });
    return this.loaded;
  }

  update(change) {
    const work = this.tail.then(async () => {
      const previous = await this.read();
      const next = await change(previous);
      if (next !== previous) {
        await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const temporary = this.file + '.' + randomBytes(12).toString('hex') + '.tmp';
        try {
          await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
          await rename(temporary, this.file);
          this.loaded = Promise.resolve(next);
        } finally {
          await rm(temporary, { force: true });
        }
      }
      return next;
    });
    this.tail = work.catch(() => {});
    return work;
  }

  ensure() {
    return this.update(state => state.key && state.serverId ? state : {
      ...state, key: state.key || newKey(), serverId: state.serverId || randomBytes(16).toString('hex'),
    });
  }

  rotate() {
    return this.update(state => ({ ...state, key: newKey(), jellyfinSessions: [] }));
  }

  set(seriesId, published) {
    id(seriesId);
    if (typeof published !== 'boolean') throw new AppError('INVALID_PUBLICATION', '请选择添加或移除剧集', 400);
    return this.update(async state => {
      const remaining = state.series.filter(item => item.id !== seriesId);
      if (!published) return remaining.length === state.series.length ? state : { ...state, series: remaining };
      if (remaining.length >= limit) throw new AppError('PLAYBACK_CATALOG_LIMIT', '点播目录最多保留 200 部剧', 409);
      const item = summary(await this.catalog.detail(seriesId));
      return { ...state, key: state.key || newKey(), series: [item, ...remaining] };
    });
  }

}
