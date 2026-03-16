import { fetchUrl } from "./net.js"

function delay(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

// 获取分组集合
async function cateList() {
  const resp = await fetchUrl("https://program-sc.miguvideo.com/live/v2/tv-data/1ff892f2b5ab4a79be6e25b69d2f5d05")
  let liveList = resp.body.liveList
  // 热门内容重复
  liveList = liveList.filter(item => {
    return item.name != "热门"
  })

  // 央视作为首个分组
  liveList.sort((a, b) => {
    if (a.name === "央视") return -1;
    if (b.name === "央视") return 1
    return 0
  })

  return liveList
}

// 所有数据
async function dataList() {
  let cates = await cateList()

  for (let cate in cates) {
    try {
      const resp = await fetchUrl("https://program-sc.miguvideo.com/live/v2/tv-data/" + cates[cate].vomsID)
      cates[cate].dataList = resp.body.dataList
    } catch (error) {
      cates[cate].dataList = [];
    }
  }

  // 去除重复节目
  cates = uniqueData(cates)
  // console.dir(cates, { depth: null })
  // console.log(cates)
  return cates
}

// 对data的dataList去重（分类内去重，不同分类允许同一频道同时存在）
function uniqueData(liveList) {
  liveList.forEach(category => {
    const seen = new Set()
    category.dataList = category.dataList.filter(program => {
      if (seen.has(program.name)) return false
      seen.add(program.name)
      return true
    })
  })
  return liveList
}

export { cateList, dataList, delay }
