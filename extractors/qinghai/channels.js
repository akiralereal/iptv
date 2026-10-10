/**
 * 青海频道表：纯数据，不 import 任何模块。
 *
 * 四路都在青海广电的「云直播」平台（cloudlive-manage）上，按租户分两家：
 * - qhtb：青海藏语网络广播电视台（custom_appid 1077）。官网电视直播页脚本里写着频道专题 id（current_channel）
 *   和站点 app_secret，接口凭 app_secret 认租户；用它只看得到藏语台自己的专题。
 * - qhbtv：长云网（青海广播电视台官网，company_id 1075）。长云网 H5 直播页凭 company_id 加一个按时间算的签名
 *   认租户，不用密钥；专题列表里 is_continuous=1 的电视专题就是青海卫视、经视、都市三台（另三条是广播）。
 *
 * topicId 是专题 id；stream 是这一路在官方 CDN 上的流名（清单 /<stream>/<档位>/live.m3u8、
 * 分片 /<stream>_<档位>/…），用来确认接口给回来的确实是这一路。同站的青海藏语广播
 * （流名 qhzygb）在平台上同样标成「电视」类，只能靠流名分辨。
 *
 * 台标：安多卫视用频道接口（api/topic/detail）下发的 indexpic：藏汉双语的安多卫视方形台标，官网播放器拿它
 * 当封面。/file/ 路径 301 到同主机的 /inner-file/，取到的是 1500×1491 PNG（约 400 KB，透明底黑字）。
 * 官网电视直播页顶部另有一张横版 adtv_logo.png（919×289，透明底白字），方形的更合台标位，用前者。
 * 长云网三台的 indexpic 是同一张青海台台标（绿色气泡，350×350，分不出频道），不用；模块留空，由内置台标库
 * 补：青海卫视取自央视频，经济生活、都市收的是公开台标库的分频道台标（出处见 logo-pack/index.json）。
 */

export const QHTB_TV_PAGE = 'https://www.qhtb.cn/zy/onlin/onlin_tv/'
export const QHBTV_H5_PAGE = 'https://h5.qhbtv.com.cn/front-cloudlive-manage-h5/index.html'

// 官网直播页写死的站点 app_secret（电视页、广播页、直播栏目页三处一致）。页面取不到或改版时用它兜底，
// 平台缺它回「签名错误1」、给错回「客户信息不存在」
export const SITE_APP_SECRET = '069486993db4acc22c846557c8880d9a'
// 长云网在云直播平台上的租户号（官网活动直播链接里的 company_id）
export const QHBTV_COMPANY_ID = '1075'

const channel = (ref, name, tenant, topicId, stream, logo = '') => Object.freeze({ ref, name, tenant, topicId, stream, logo })

// 平台上经济生活频道的专题名是旧称「青海经视」，台名用官方现名
export const CHANNELS = Object.freeze([
  channel('qinghai-qhws', '青海卫视', 'qhbtv', '786181204964564992', 'qhws'),
  channel('qinghai-amdo', '安多卫视', 'qhtb', '824587377543962624', 'qhzyds',
    'https://filestorage.qhbtv.com.cn/file/storage1-cloudlivemanage/cloudlivemanage/2025/1077/4ab9f3d8036d2c9b.png'),
  channel('qinghai-qhsh', '青海经济生活', 'qhbtv', '786227316454875136', 'qhsh'),
  channel('qinghai-qhds', '青海都市', 'qhbtv', '786227009616371712', 'qhds'),
])
