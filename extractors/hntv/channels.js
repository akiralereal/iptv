/**
 * 大象新闻正式频道白名单：id 即官网 cid，取流与节目单接口都按它寻址。
 * 固定顺序保持输出稳定，避免接口混入购物频道或将来新增的临时专题流。
 */
export const CHANNELS = [
  { id: '145', rawName: '河南卫视', name: '河南卫视' },
  { id: '149', rawName: '新闻频道', name: '河南新闻' },
  { id: '141', rawName: '都市频道', name: '河南都市' },
  { id: '146', rawName: '民生频道', name: '河南民生' },
  { id: '147', rawName: '法治频道', name: '河南法治' },
  { id: '151', rawName: '公共频道', name: '河南公共' },
  { id: '152', rawName: '河南乡村频道', name: '河南乡村' },
  { id: '148', rawName: '电视剧频道', name: '河南电视剧' },
  { id: '154', rawName: '梨园频道', name: '梨园频道' },
  { id: '155', rawName: '文物宝库', name: '文物宝库' },
  { id: '156', rawName: '武术频道', name: '武术世界' },
  { id: '157', rawName: '睛彩中原', name: '睛彩中原' },
  { id: '194', rawName: '国学频道', name: '国学频道' },
]
