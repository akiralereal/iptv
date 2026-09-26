// 用户访问令牌 后台 API（一人一源，issue: 用户管理）
// 仅站长密码 pass 可调用（路由挂在 /api/ 下，已由 passAuthed 把关）。

import { pass } from "../config.js"
import { userManager } from "./userManager.js"

export function getUsersAPI() {
  try {
    // passSet：没设访问密码时裸地址对所有人开放，令牌挡不住任何人——后台据此在用户管理顶部提醒（issue #141）
    return { success: true, data: userManager.getConfig(), passSet: pass !== "" }
  } catch (e) {
    return { success: false, message: e.message }
  }
}

export function addUserAPI(payload = {}) {
  return userManager.addUser(payload)
}

export function updateUserAPI(id, fields = {}) {
  if (!id) return { success: false, message: '缺少用户 id' }
  return userManager.updateUser(id, fields)
}

export function removeUserAPI(id) {
  if (!id) return { success: false, message: '缺少用户 id' }
  return userManager.removeUser(id)
}

export function regenUserTokenAPI(id) {
  if (!id) return { success: false, message: '缺少用户 id' }
  return userManager.regenToken(id)
}
