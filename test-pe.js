import { fetchUrl } from "./utils/net.js"
import { getDateString } from "./utils/time.js"

console.log("测试获取体育赛事数据...")

try {
  const datas = await fetchUrl("http://v0-sc.miguvideo.com/vms-match/v6/staticcache/basic/match-list/normal-match-list/0/all/default/1/miguvideo")
  
  console.log("\n===== API响应状态 =====")
  console.log(`状态: ${datas.code}`)
  console.log(`消息: ${datas.message || 'OK'}`)
  
  if (!datas.body?.days || !datas.body?.matchList) {
    console.log("❌ API返回数据格式异常")
    console.log("返回数据:", JSON.stringify(datas, null, 2))
    process.exit(1)
  }
  
  console.log("\n===== 日期列表 =====")
  console.log(`总共 ${datas.body.days.length} 天:`, datas.body.days.join(', '))
  
  console.log("\n===== 各日期赛事数量 =====")
  for (let i = 1; i < 4; i++) {
    const date = datas.body.days[i]
    const matchCount = datas.body.matchList[date]?.length || 0
    
    let relativeDate = "昨天"
    const dateString = getDateString(new Date())
    if (date == dateString) {
      relativeDate = "今天"
    } else if (parseInt(date) > parseInt(dateString)) {
      relativeDate = "明天"
    }
    
    console.log(`${date} (${relativeDate}): ${matchCount} 场赛事`)
    
    if (matchCount > 0) {
      console.log(`  前3场赛事:`)
      const matches = datas.body.matchList[date].slice(0, 3)
      matches.forEach((match, idx) => {
        const pkInfo = match.confrontTeams 
          ? `${match.confrontTeams[0].name} VS ${match.confrontTeams[1].name}`
          : match.pkInfoTitle
        console.log(`    ${idx+1}. ${match.competitionName} - ${pkInfo} (ID: ${match.mgdbId})`)
      })
    }
  }
  
} catch (error) {
  console.error("❌ 获取失败:", error.message)
  console.error(error)
}
