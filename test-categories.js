import { fetchUrl } from "./utils/net.js"

console.log("测试获取分类列表...")
try {
  const resp = await fetchUrl("https://program-sc.miguvideo.com/live/v2/tv-data/1ff892f2b5ab4a79be6e25b69d2f5d05")
  let liveList = resp.body.liveList
  
  console.log(`\n原始分类数: ${liveList.length}`)
  liveList.forEach(cat => {
    console.log(`- ${cat.name} (vomsID: ${cat.vomsID})`)
  })
  
  // 过滤热门
  liveList = liveList.filter(item => item.name != "热门")
  console.log(`\n过滤后分类数: ${liveList.length}`)
  
  // 测试每个分类的数据获取
  console.log(`\n开始测试每个分类的数据获取...`)
  for (let cat of liveList) {
    try {
      const dataResp = await fetchUrl(`https://program-sc.miguvideo.com/live/v2/tv-data/${cat.vomsID}`)
      const count = dataResp.body.dataList?.length || 0
      console.log(`✓ ${cat.name}: ${count} 个频道`)
    } catch (error) {
      console.log(`✗ ${cat.name}: 获取失败 - ${error.message}`)
    }
  }
  
} catch (error) {
  console.error("获取分类列表失败:", error)
}
