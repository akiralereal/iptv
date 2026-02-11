import { fetchUrl } from "./utils/net.js"
import { getDateString } from "./utils/time.js"

console.log("测试完整的PE更新流程...")

try {
  const datas = await fetchUrl("http://v0-sc.miguvideo.com/vms-match/v6/staticcache/basic/match-list/normal-match-list/0/all/default/1/miguvideo")
  
  let totalValidMatches = 0
  let totalSkipped = 0
  let totalErrors = 0
  
  for (let i = 1; i < 4; i++) {
    const date = datas.body.days[i]
    let relativeDate = "昨天"
    const dateString = getDateString(new Date())
    if (date == dateString) {
      relativeDate = "今天"
    } else if (parseInt(date) > parseInt(dateString)) {
      relativeDate = "明天"
    }
    
    const matches = datas.body.matchList[date] || []
    console.log(`\n===== ${date} (${relativeDate}) - 共 ${matches.length} 场赛事 =====`)
    
    let validCount = 0
    let skipCount = 0
    let errorCount = 0
    
    for (const data of matches) {
      let pkInfoTitle = data.pkInfoTitle
      if (data.confrontTeams) {
        pkInfoTitle = `${data.confrontTeams[0].name}VS${data.confrontTeams[1].name}`
      }
      
      try {
        const peResult = await fetchUrl(`https://vms-sc.miguvideo.com/vms-match/v6/staticcache/basic/basic-data/${data.mgdbId}/miguvideo`)
        
        // 比赛已结束
        if (peResult.body.endTime < Date.now()) {
          const replayResult = await fetchUrl(`http://app-sc.miguvideo.com/vms-match/v5/staticcache/basic/all-view-list/${data.mgdbId}/2/miguvideo`)
          let replayList = replayResult.body?.replayList
          if (replayList == null || replayList == undefined) {
            replayList = peResult.body.multiPlayList.replayList
          }
          if (replayList == null || replayList == undefined) {
            skipCount++
            continue
          }
          
          let hasValidReplay = false
          for (const replay of replayList) {
            if (replay.name.match(/.*集锦|训练.*/) != null) {
              continue
            }
            if (replay.name.match(/.*回放|赛.*/) != null) {
              validCount++
              hasValidReplay = true
            }
          }
          if (!hasValidReplay) {
            skipCount++
          }
        } else {
          // 比赛未结束
          const liveList = peResult.body.multiPlayList.liveList
          let hasValidLive = false
          for (const live of liveList) {
            if (live.name.match(/.*集锦.*/) != null || live.startTimeStr == undefined) {
              continue
            }
            validCount++
            hasValidLive = true
          }
          if (!hasValidLive) {
            skipCount++
          }
        }
        
      } catch (error) {
        errorCount++
      }
    }
    
    console.log(`  有效赛事: ${validCount}`)
    console.log(`  跳过: ${skipCount}`)
    console.log(`  错误: ${errorCount}`)
    
    totalValidMatches += validCount
    totalSkipped += skipCount
    totalErrors += errorCount
  }
  
  console.log(`\n===== 总计 =====`)
  console.log(`有效赛事: ${totalValidMatches}`)
  console.log(`跳过赛事: ${totalSkipped}`)
  console.log(`错误: ${totalErrors}`)
  
} catch (error) {
  console.error("❌ 获取失败:", error.message)
  console.error(error)
}
