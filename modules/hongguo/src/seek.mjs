import { AppError } from './common.mjs';

export function seekPosition(value, duration) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > duration || !Number.isFinite(duration) || duration <= 0) throw new AppError('INVALID_POSITION', '播放位置不在本集范围内', 400);
  const position = Math.min(value, Math.max(0, duration - 0.08));
  // Keep enough audio/video at the end for a valid initialization fragment.
  const offset = Math.floor(Math.min(position, Math.max(0, duration - 2)) * 1000) / 1000;
  return { position, offset };
}
export const validClient = client => typeof client === 'string' && /^[a-f0-9-]{36}$/i.test(client);
export const superseded = () => new AppError('SEEK_SUPERSEDED', '已采用更新的播放位置', 409);
