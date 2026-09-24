/**
 * 广西网络台正式频道白名单：取流（api.js）与节目单（epg.js）共用，纯数据、不 import 任何东西。
 *
 * rawName 是官网频道接口里的 name，取流按它挑行，节目单接口也按它查（见 epg.js）；
 * id 是官网频道 uuid（播放页 channelivePlay_<id>.html），2026-09-25 对照频道接口核实。
 * epg: false 表示官网不出节目单：频道接口 showProgramme=0，节目单接口回空数组。
 */
export const CHANNELS = [
  { ref: 'gxtv-gxws', rawName: '广西卫视', name: '广西卫视', kind: 'core', id: 'e7a7ab7df9fe11e88bcfe41f13b60c62' },
  { ref: 'gxtv-zyly', rawName: '综艺旅游频道', name: '广西综艺旅游', kind: 'core', id: 'f3335975f9fe11e88bcfe41f13b60c62' },
  { ref: 'gxtv-ds', rawName: '都市频道', name: '广西都市', kind: 'core', id: 'fdbaf085f9fe11e88bcfe41f13b60c62' },
  { ref: 'gxtv-ys', rawName: '影视频道', name: '广西影视', kind: 'core', id: '5e923d82058e11e9ba67e41f13b60c62' },
  { ref: 'gxtv-xw', rawName: '新闻频道', name: '广西新闻', kind: 'core', id: '9dfd8600075811e9ba67e41f13b60c62' },
  { ref: 'gxtv-gj', rawName: '国际频道', name: '广西国际', kind: 'core', id: 'bfa17b64157f11e999f0e41f13b60c62' },
  { ref: 'gxtv-yd', rawName: '移动数字电视频道', name: '广西移动', kind: 'core', id: '78dbfd44e6b74ab687204d2d8113cbf5', epg: false },
]
