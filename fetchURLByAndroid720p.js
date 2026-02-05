import { dataList, delay } from "./utils/fetchList.js"
import { getAndroidURL720p } from "./utils/androidURL.js"
import { appendFile, appendFileSync, renameFileSync, writeFile } from "./utils/fileUtil.js"
import { updatePlaybackData } from "./utils/playback.js"
import { printBlue, printGreen, printRed, printYellow } from "./utils/colorOut.js"

async function fetchURLByAndroid720p() {

  const start = Date.now()

  // 获取数据
  const datas = await dataList()

  printGreen("数据获取成功！")
  // 必须绝对路径
  const path = process.cwd() + '/interface.txt.bak'
  // 创建写入空内容
  writeFile(path, "")

  printYellow("正在更新...")
  // 回放
  const playbackFile = process.cwd() + '/playback.xml.bak'
  writeFile(playbackFile,
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<tv generator-info-name="Tak" generator-info-url="https://github.com/develop202/migu_video">\n`)

  // 写入开头
  appendFile(path, `#EXTM3U x-tvg-url="https://gh-proxy.com/https://raw.githubusercontent.com/develop202/migu_video/refs/heads/main/playback.xml,https://hk.gh-proxy.org/raw.githubusercontent.com/develop202/migu_video/refs/heads/main/playback.xml,https://develop202.github.io/migu_video/playback.xml,https://raw.githubusercontents.com/develop202/migu_video/refs/heads/main/playback.xml" catchup="append" catchup-source="&playbackbegin=\${(b)yyyyMMddHHmmss}&playbackend=\${(e)yyyyMMddHHmmss}"\n`)

  // 分类列表
  for (let i = 0; i < datas.length; i++) {

    const data = datas[i].dataList

    printBlue(`开始更新分类###: ${datas[i].name}`)
    // 写入节目
    for (let j = 0; j < data.length; j++) {

      await updatePlaybackData(data[j], playbackFile)

      // 获取链接
      const resObj = await getAndroidURL720p(data[j].pID)

      if (resObj.url != "") {
        let z = 1
        while (z <= 6) {
          if (z >= 2) {
            printYellow(`${data[j].name} 获取失败,正在第${z - 1}次重试`)
          }
          const obj = await fetch(`${resObj.url}`, {
            method: "GET",
            redirect: "manual"
          })

          const location = obj.headers.get("Location")


          if (location == "" || location == undefined || location == null) {
            continue
          }
          if (!location.startsWith("http://bofang")) {
            resObj.url = location
            break
          }
          if (z != 6) {
            await delay(150)
          }
          z++
        }
      }

      if (resObj.url == "") {
        printRed(`${data[j].name} 更新失败`)
        continue
      }
      // 写入节目
      appendFile(path, `#EXTINF:-1 tvg-id="${data[j].name}" tvg-name="${data[j].name}" tvg-logo="${data[j].pics.highResolutionH}" group-title="${datas[i].name}",${data[j].name}\n${resObj.url}\n`)
      printGreen(`${data[j].name} 更新成功！`)
    }
  }

  appendFileSync(playbackFile, `</tv>\n`)

  renameFileSync(playbackFile, playbackFile.replace(".bak", ""))
  renameFileSync(path, path.replace(".bak", ""))
  const end = Date.now()
  printYellow(`本次耗时: ${(end - start) / 1000}秒`)
}

fetchURLByAndroid720p()
