import { fetchUrl } from "./utils/net.js"
import { dataList } from "./utils/fetchList.js"

// 获取原始数据（不去重）
console.log("1. 获取原始数据...")
const resp = await fetchUrl("https://program-sc.miguvideo.com/live/v2/tv-data/1ff892f2b5ab4a79be6e25b69d2f5d05")
let liveList = resp.body.liveList.filter(item => item.name != "热门")

const rawChannels = new Map()
for (let cat of liveList) {
  try {
    const dataResp = await fetchUrl(`https://program-sc.miguvideo.com/live/v2/tv-data/${cat.vomsID}`)
    const channels = dataResp.body.dataList || []
    channels.forEach(ch => {
      const key = ch.name
      if (!rawChannels.has(key)) {
        rawChannels.set(key, [])
      }
      rawChannels.get(key).push({ category: cat.name, channel: ch })
    })
  } catch (error) {
    // ignore
  }
}

console.log(`原始总频道名数: ${rawChannels.size}`)

// 找出重复的频道名
const duplicates = []
rawChannels.forEach((instances, name) => {
  if (instances.length > 1) {
    duplicates.push({ name, count: instances.length, categories: instances.map(i => i.category) })
  }
})

console.log(`\n重复的频道名共 ${duplicates.length} 个:`)
duplicates.forEach(dup => {
  console.log(`- ${dup.name} 出现在 ${dup.count} 个分类: ${dup.categories.join(', ')}`)
})

// 获取去重后的数据
console.log(`\n2. 获取去重后数据...`)
const uniqueData = await dataList()
const uniqueCount = uniqueData.reduce((sum, g) => sum + g.dataList.length, 0)
console.log(`去重后总频道数: ${uniqueCount}`)

// 计算差异
const totalRaw = Array.from(rawChannels.values()).reduce((sum, instances) => sum + instances.length, 0)
console.log(`\n===== 对比 =====`)
console.log(`原始频道总数: ${totalRaw}`)
console.log(`去重后频道数: ${uniqueCount}`)
console.log(`丢失频道数: ${totalRaw - uniqueCount}`)
