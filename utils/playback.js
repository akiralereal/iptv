import { getDateString, getDateTimeString } from "./time.js"
import { appendFileSync } from "./fileUtil.js"
import { cntvNames } from "./datas.js"
import { fetchUrl } from "./net.js"


async function getPlaybackData(programId, timeout = 6000, githubAnd8) {
  const date = new Date(Date.now() + githubAnd8)
  const today = getDateString(date)
  const resp = await fetchUrl(`https://program-sc.miguvideo.com/live/v2/tv-programs-data/${programId}/${today}`, {}, timeout)
  return resp.body?.program[0]?.content
}

async function updatePlaybackDataByMigu(program, filePath, timeout = 6000, githubAnd8 = 0) {
  // 今日节目数据
  const playbackData = await getPlaybackData(program.pID, timeout, githubAnd8)
  if (!playbackData) {
    return false
  }
  // 写入频道信息
  appendFileSync(filePath,
    `    <channel id="${program.name}">\n` +
    `        <display-name lang="zh">${program.name}</display-name>\n` +
    `    </channel>\n`
  )

  // 写入节目信息
  for (let i = 0; i < playbackData.length; i++) {
    // 特殊字符转义
    const contName = playbackData[i].contName.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&apos;");

    appendFileSync(filePath,
      `    <programme channel="${program.name}" start="${getDateTimeString(new Date(playbackData[i].startTime + githubAnd8))} +0800" stop="${getDateTimeString(new Date(playbackData[i].endTime + githubAnd8))} +0800">\n` +
      `        <title lang="zh">${contName}</title>\n` +
      `    </programme>\n`
    )
  }
  return true
}

async function updatePlaybackDataByCntv(program, filePath, timeout = 6000, githubAnd8 = 0) {
  // 今日节目数据
  const date = new Date(Date.now() + githubAnd8)
  const today = getDateString(date)
  const cntvName = cntvNames[program.name]
  const resp = await fetchUrl(`https://api.cntv.cn/epg/epginfo3?serviceId=shiyi&d=${today}&c=${cntvName}`, {}, timeout)

  const playbackData = resp[cntvName]?.program
  if (!playbackData) {
    return false
  }
  // 写入频道信息
  appendFileSync(filePath,
    `    <channel id="${program.name}">\n` +
    `        <display-name lang="zh">${program.name}</display-name>\n` +
    `    </channel>\n`
  )

  // 写入节目信息
  for (let i = 0; i < playbackData.length; i++) {
    // 特殊字符转义
    const contName = playbackData[i].t.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&apos;");

    appendFileSync(filePath,
      `    <programme channel="${program.name}" start="${getDateTimeString(new Date(playbackData[i].st * 1000 + githubAnd8))} +0800" stop="${getDateTimeString(new Date(playbackData[i].et * 1000 + githubAnd8))} +0800">\n` +
      `        <title lang="zh">${contName}</title>\n` +
      `    </programme>\n`
    )
  }
  return true
}

async function updatePlaybackData(program, filePath, timeout = 6000, githubAnd8 = 0) {
  if (cntvNames[program.name]) {
    return updatePlaybackDataByCntv(program, filePath, timeout, githubAnd8)
  }
  return updatePlaybackDataByMigu(program, filePath, timeout, githubAnd8)

}
export { updatePlaybackData }

