import { dataList } from "./utils/fetchList.js"

console.log("开始测试获取咪咕频道...")
const start = Date.now()

try {
  const data = await dataList()
  const totalChannels = data.reduce((sum, group) => sum + group.dataList.length, 0)
  const elapsed = Date.now() - start
  
  console.log(`\n===== 测试结果 =====`)
  console.log(`总分组数: ${data.length}`)
  console.log(`总频道数: ${totalChannels}`)
  console.log(`耗时: ${elapsed}ms`)
  console.log(`\n===== 各分组详情 =====`)
  
  data.forEach(group => {
    console.log(`${group.name}: ${group.dataList.length} 个频道`)
  })
  
} catch (error) {
  console.error("获取失败:", error)
}
