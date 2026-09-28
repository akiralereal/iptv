/**
 * 青海频道表：纯数据，不 import 任何模块。
 *
 * topicId 是青海藏语网络广播电视台「云直播」平台上的频道专题 id，也是官网电视直播页
 * 脚本里的 current_channel；stream 是它在官方 CDN 上的流名（清单 /<stream>/<档位>/live.m3u8、
 * 分片 /<stream>_<档位>/…），用来确认接口给回来的确实是这一路。同站的青海藏语广播
 * （流名 qhzygb）在平台上同样标成「电视」类，只能靠流名分辨。
 *
 * 台标用频道接口（api/topic/detail）下发的 indexpic：藏汉双语的安多卫视方形台标，官网播放器拿它
 * 当封面。/file/ 路径 301 到同主机的 /inner-file/，取到的是 1500×1491 PNG（约 400 KB，透明底黑字）。
 * 官网电视直播页顶部另有一张横版 adtv_logo.png（919×289，透明底白字），方形的更合台标位，用前者。
 */

export const QHTB_TV_PAGE = 'https://www.qhtb.cn/zy/onlin/onlin_tv/'

// 官网直播页写死的站点 app_secret（电视页、广播页、直播栏目页三处一致）。页面取不到或改版时用它兜底，
// 平台缺它回「签名错误1」、给错回「客户信息不存在」
export const SITE_APP_SECRET = '069486993db4acc22c846557c8880d9a'

const channel = (ref, name, topicId, stream, logo) => Object.freeze({ ref, name, topicId, stream, logo })

export const CHANNELS = Object.freeze([
  channel('qinghai-amdo', '安多卫视', '824587377543962624', 'qhzyds',
    'https://filestorage.qhbtv.com.cn/file/storage1-cloudlivemanage/cloudlivemanage/2025/1077/4ab9f3d8036d2c9b.png'),
])
