/**
 * 播放地址上的 ?quality= 按频道覆盖模块的画质配置（issue #185）。
 *
 * 只认模块下拉框里列出的档位：认不出的值回落到后台配置，免得一条手写错的地址
 * 把任意值带进各模块按画质分键的解析缓存。
 *
 * @param {object} ctx       resolve 的 ctx：{ config, query }
 * @param {Array}  options   模块画质下拉框的 [{ value, label }]
 * @param {number} fallback  后台没存过画质时的默认值
 */
export function qualityFrom(ctx = {}, options = [], fallback = 0) {
  const raw = ctx.query?.quality
  if (raw != null && String(raw).trim() !== '') {
    const value = Number(raw)
    if (options.some(option => Number(option.value) === value)) return value
  }
  return Number(ctx.config?.quality ?? fallback)
}
