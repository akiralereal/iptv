import { getAllChannels, updateExternalSources, externalSourceManager } from "./channelMerger.js"
import { appendFile, appendFileSync, copyFileSync, renameFileSync, writeFile } from "./fileUtil.js"
import { updatePlaybackData } from "./playback.js"
import { /* refreshToken as mrefreshToken, */ host, pass, token, userId } from "../config.js"
import refreshToken from "./refreshToken.js"
import { printGreen, printRed, printYellow, printBlue } from "./colorOut.js"
import { getDateString } from "./time.js"
import { fetchUrl } from "./net.js"
import { loadCustomChannels, applyCustomGroups, filterExcludedChannels } from "./customChannels.js"

/**
 * @param {Number} hours -更新小时数 
 */
async function updateTV(hours) {

  const date = new Date()
  const start = date.getTime()
  let interfacePath = ""
  let interfaceTXTPath = ""
  
  // 更新外部源
  printBlue("开始更新外部源...")
  await updateExternalSources()
  
  // 获取数据（咪咕 + 外部源）
  let datas = await getAllChannels()
  printGreen("TV数据获取成功！")

  // 加载自定义频道配置
  const customConfig = loadCustomChannels()
  if (customConfig) {
    printBlue("检测到自定义频道配置")
    
    // 应用排除规则
    if (customConfig.excludeChannels && customConfig.excludeChannels.length > 0) {
      datas = filterExcludedChannels(datas, customConfig.excludeChannels)
      printBlue(`已过滤排除频道`)
    }
    
    // 应用自定义分组
    if (customConfig.enableCustomGroups) {
      datas = applyCustomGroups(datas, customConfig)
      printGreen("已应用自定义频道分组")
    }
  }

  interfacePath = `${process.cwd()}/interface.txt.bak`
  // txt
  interfaceTXTPath = `${process.cwd()}/interfaceTXT.txt.bak`
  // 创建写入空内容
  writeFile(interfacePath, "")
  // txt
  writeFile(interfaceTXTPath, "")

  if (!(hours % 720)) {
    // 每720小时(一个月)刷新token
    if (userId != "" && token != "") {
      // if (mrefreshToken) {
      await refreshToken(userId, token) ? printGreen("token刷新成功") : printRed("token刷新失败")
      // } else {
      // printGreen(`跳过token刷新`)
      // }
    }
  }
  appendFile(interfacePath, `#EXTM3U x-tvg-url="\${replace}/playback.xml" catchup="append" catchup-source="?playbackbegin=\${(b)yyyyMMddHHmmss}&playbackend=\${(e)yyyyMMddHHmmss}"\n`)
  printYellow("开始更新TV...")
  // 回放
  const playbackFile = `${process.cwd()}/playback.xml.bak`
  writeFile(playbackFile,
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<tv generator-info-name="iFansClub" generator-info-url="https://github.com/akiralereal/iPTV">\n`)

  // 分类列表
  const includeExternalInPlaylists = externalSourceManager.sources?.includeInPlaylists !== false
  for (let i = 0; i < datas.length; i++) {

    const data = datas[i].dataList
    // txt
    appendFile(interfaceTXTPath, `${datas[i].name},#genre#\n`)
    // 写入节目
    for (let j = 0; j < data.length; j++) {
      const channelItem = data[j]
      const isExternal = channelItem.source === 'external' || !!channelItem.url
      const logoUrl = channelItem.pics?.highResolutionH || channelItem.logo || ""
      const playUrl = isExternal ? channelItem.url : `\${replace}/${channelItem.pID}`

      if (isExternal && !includeExternalInPlaylists) {
        continue
      }

      if (!isExternal) {
        await updatePlaybackData(channelItem, playbackFile)
      }

      // 写入节目
      appendFile(interfacePath, `#EXTINF:-1 tvg-id="${channelItem.name}" tvg-name="${channelItem.name}" tvg-logo="${logoUrl}" group-title="${datas[i].name}",${channelItem.name}\n${playUrl}\n`)
      // txt
      appendFile(interfaceTXTPath, `${channelItem.name},${playUrl}\n`)
      // printGreen(`    节目链接更新成功`)
    }
    printGreen(`分类###:${datas[i].name} 更新完成！`)
  }

  appendFileSync(playbackFile, `</tv>\n`)

  // 重命名
  renameFileSync(playbackFile, playbackFile.replace(".bak", ""))
  renameFileSync(interfacePath, interfacePath.replace(".bak", ""))
  // txt
  renameFileSync(interfaceTXTPath, interfaceTXTPath.replace(".bak", ""))
  printGreen("TV更新完成！")
  const end = Date.now()
  printYellow(`TV更新耗时: ${(end - start) / 1000}秒`)
}

/**
 * @param {Number} hours -更新小时数 
 */
async function updatePE(hours) {

  const date = new Date()
  const start = date.getTime()
  // 获取PE数据
  const datas = await fetchUrl("http://v0-sc.miguvideo.com/vms-match/v6/staticcache/basic/match-list/normal-match-list/0/all/default/1/miguvideo")
  printGreen("PE数据获取成功！")
  // console.dir(datas, { depth: null })

  copyFileSync(`${process.cwd()}/interface.txt`, `${process.cwd()}/interface.txt.bak`, 0)
  copyFileSync(`${process.cwd()}/interfaceTXT.txt`, `${process.cwd()}/interfaceTXT.txt.bak`, 0)

  const interfacePath = `${process.cwd()}/interface.txt.bak`
  const interfaceTXTPath = `${process.cwd()}/interfaceTXT.txt.bak`

  printYellow("开始更新PE...")

  for (let i = 1; i < 4; i++) {
    // 日期
    const date = datas.body?.days[i]
    let relativeDate = "昨天"
    const dateString = getDateString(new Date())
    if (date == dateString) {
      relativeDate = "今天"
    } else if (parseInt(date) > parseInt(dateString)) {
      relativeDate = "明天"
    }

    appendFile(interfaceTXTPath, `体育-${relativeDate},#genre#\n`)
    for (const data of datas.body?.matchList[date]) {

      let pkInfoTitle = data.pkInfoTitle
      if (data.confrontTeams) {
        pkInfoTitle = `${data.confrontTeams[0].name}VS${data.confrontTeams[1].name}`
      }
      // const peResult = await fetch(`http://app-sc.miguvideo.com/vms-match/v5/staticcache/basic/all-view-list/${data.mgdbId}/2/miguvideo`).then(r => r.json())
      const peResult = await fetchUrl(`https://vms-sc.miguvideo.com/vms-match/v6/staticcache/basic/basic-data/${data.mgdbId}/miguvideo`)
      try {
        // 比赛已结束
        if (peResult.body.endTime < Date.now()) {
          const replayResult = await fetchUrl(`http://app-sc.miguvideo.com/vms-match/v5/staticcache/basic/all-view-list/${data.mgdbId}/2/miguvideo`)
          let replayList = replayResult.body?.replayList
          if (replayList == null || replayList == undefined) {
            replayList = peResult.body.multiPlayList.replayList
          }
          if (replayList == null || replayList == undefined) {
            printYellow(`${data.mgdbId} ${pkInfoTitle} 无回放`)
            continue
          }
          for (const replay of replayList) {
            if (replay.name.match(/.*集锦|训练.*/) != null) {
              continue
            }
            if (replay.name.match(/.*回放|赛.*/) != null) {
              let timeStr = peResult.body.keyword.substring(7)
              const peResultStartTimeStr = peResult.body.multiPlayList.preList[peResult.body.multiPlayList.preList.length - 1].startTimeStr
              if (peResultStartTimeStr != undefined) {
                timeStr = peResultStartTimeStr.substring(11, 16)
              }
              const competitionDesc = `${data.competitionName} ${pkInfoTitle} ${replay.name} ${timeStr}`
              // 写入赛事
              appendFileSync(interfacePath, `#EXTINF:-1 tvg-id="${pkInfoTitle}" tvg-name="${competitionDesc}" tvg-logo="${data.competitionLogo}" group-title="体育-${relativeDate}",${competitionDesc}\n\${replace}/${replay.pID}\n`)
              appendFileSync(interfaceTXTPath, `${competitionDesc},\${replace}/${replay.pID}\n`)
            }
          }
          continue
        }
        // 比赛未结束
        const liveList = peResult.body.multiPlayList.liveList
        for (const live of liveList) {
          if (live.name.match(/.*集锦.*/) != null || live.startTimeStr == undefined) {
            continue
          }
          const competitionDesc = `${data.competitionName} ${pkInfoTitle} ${live.name} ${live.startTimeStr.substring(11, 16)}`
          // 写入赛事
          appendFileSync(interfacePath, `#EXTINF:-1 tvg-id="${pkInfoTitle}" tvg-name="${competitionDesc}" tvg-logo="${data.competitionLogo}" group-title="体育-${relativeDate}",${competitionDesc}\n\${replace}/${live.pID}\n`)
          appendFileSync(interfaceTXTPath, `${competitionDesc},\${replace}/${live.pID}\n`)
        }
      } catch (error) {
        printYellow(`${data.mgdbId} ${pkInfoTitle} 更新失败 此警告不影响正常使用 可忽略`)
        // printYellow(error)
      }
    }
    printGreen(`日期 ${date} 更新完成！`)
  }

  // 重命名
  renameFileSync(interfacePath, interfacePath.replace(".bak", ""))
  renameFileSync(interfaceTXTPath, interfaceTXTPath.replace(".bak", ""))
  printGreen("PE更新完成！")
  const end = Date.now()
  printYellow(`PE更新耗时: ${(end - start) / 1000}秒`)
}

/**
 * @param {Number} hours - 更新小时数
 */
async function update(hours) {
  await updateTV(hours)
  await updatePE(hours)
}

export default update
