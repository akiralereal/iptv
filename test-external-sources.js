import externalSourceManager from "./utils/externalSources.js"
import { extractM3u8FromWeb } from "./utils/webSourceExtractor.js"
import { printBlue, printGreen, printRed } from "./utils/colorOut.js"

/**
 * 外部源测试和使用示例
 */
async function testExternalSources() {
  printBlue("=== 外部源功能测试 ===")
  
  // 1. 测试手动提取 m3u8
  printBlue("\n1. 测试手动提取 m3u8 链接")
  try {
    const testUrl = "https://www.jrkan66.com/wlty.html" // 示例URL
    const m3u8Url = await extractM3u8FromWeb(testUrl, {
      playButtonSelector: ".play-btn", // 根据实际页面调整
      waitTime: 5000,
      headless: true
    })
    
    if (m3u8Url) {
      printGreen(`✅ 成功提取: ${m3u8Url}`)
    } else {
      printRed(`❌ 未能提取到链接`)
    }
  } catch (error) {
    printRed(`❌ 提取失败: ${error.message}`)
  }
  
  // 2. 测试添加外部源
  printBlue("\n2. 测试添加外部源")
  const result = externalSourceManager.addSource({
    name: "测试频道",
    group: "测试",
    webUrl: "https://example.com/test.html",
    playButtonSelector: ".play-btn",
    m3u8Url: "https://example.com/test.m3u8", // 手动指定的链接
    extractOptions: {
      waitTime: 5000
    }
  })
  
  if (result.success) {
    printGreen("✅ 外部源添加成功")
  } else {
    printRed(`❌ 添加失败: ${result.message}`)
  }
  
  // 3. 显示当前配置
  printBlue("\n3. 当前外部源配置")
  const config = externalSourceManager.getConfig()
  printGreen(`- 启用状态: ${config.enabled}`)
  printGreen(`- 总源数量: ${config.sourcesCount}`)
  printGreen(`- 有效源数量: ${config.validSourcesCount}`)
  
  // 4. 获取有效频道列表
  printBlue("\n4. 获取有效频道列表")
  const channels = externalSourceManager.getValidChannels()
  printGreen(`找到 ${channels.length} 个分组`)
  channels.forEach(group => {
    printGreen(`- ${group.name}: ${group.dataList.length} 个频道`)
    group.dataList.forEach(channel => {
      printGreen(`  └─ ${channel.name}: ${channel.url}`)
    })
  })
}

/**
 * 使用示例
 */
function showUsageExample() {
  printBlue("\n=== 使用示例 ===")
  
  console.log(`
// 1. 手动添加外部源（推荐）
externalSourceManager.addSource({
  name: "纬来体育",
  group: "体育",
  webUrl: "https://www.jrkan66.com/wlty.html",
  playButtonSelector: ".play-btn",
  m3u8Url: "https://your-m3u8-url.com/stream.m3u8", // 手动设置
})

// 2. 自动提取 m3u8 链接（需要 Puppeteer）
const m3u8 = await extractM3u8FromWeb("https://example.com", {
  playButtonSelector: ".play-button", // CSS 选择器
  waitTime: 5000,                     // 等待时间
  headless: true                      // 无头模式
})

// 3. 启用外部源功能
externalSourceManager.toggleEnabled(true)

// 4. 更新所有外部源
await externalSourceManager.updateAllSources()

// 5. 在 Web 管理后台添加
// 访问 http://localhost:1905/admin
// 使用新的"外部源管理"功能
`)
}

// 如果直接运行此文件
if (import.meta.url === `file://${process.argv[1]}`) {
  testExternalSources()
  showUsageExample()
}

export { testExternalSources, showUsageExample }