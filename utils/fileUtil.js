import fs from "node:fs"
function createFile(filePath) {
  if (!fs.existsSync(filePath)) {
    writeFile(filePath, "")
  }
}

function writeFile(filePath, content) {
  fs.writeFile(filePath, content, error => {
    if (error) {
      throw new Error(`${filePath}:写入${content}失败`)
    }
  })
}

function appendFile(filePath, content) {
  fs.appendFile(filePath, content, error => {
    if (error) {
      throw new Error(`${filePath}:追加${content}失败`)
    }
  })
}

function appendFileSync(filePath, content) {
  fs.appendFileSync(filePath, content, error => {
    if (error) {
      throw new Error(`${filePath}:同步追加${content}失败`)
    }
  })
}

function readFileSync(filePath) {
  return fs.readFileSync(filePath)
}

function renameFileSync(oldFilePath, newFilePath) {
  fs.renameSync(oldFilePath, newFilePath, err => {
    if (err) {
      throw new Error(`文件重命名失败${oldFilePath} -> ${newFilePath}`)
    }
  })
}
function copyFileSync(filePath, newFilePath, mode) {
  fs.copyFileSync(filePath, newFilePath, mode, err => {
    if (err) {
      throw new Error(`文件复制失败${filePath} -> ${newFilePath}`)
    }
  })
}

export { createFile, writeFile, appendFile, appendFileSync, readFileSync, renameFileSync, copyFileSync }
