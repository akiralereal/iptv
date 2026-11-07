/**
 * Dockerfile 基础镜像（第一行 FROM）的锁定与检查，给 bump-version.js 用：
 *   - 发版时查 node:22-alpine 有没有新版，有就提醒（不自动换）；
 *   - `node bump-version.js update-base` 换成最新版并改掉注释里的版本说明；
 *   - `release-notes` 发现这一版和上一版的 FROM 不同，就在发版说明里写明要整包下载。
 *
 * 为什么锁：基础镜像一换，后面每一层都要重建，用户升级就得重下整个镜像（amd64/arm64 约 400 MB）。
 * 锁住后平时发版只重建 npm 依赖和代码两层，整包下载只发生在作者主动换基础镜像的那一版。
 */

export const BASE_REPO = 'library/node'
export const BASE_TAG = '22-alpine'
const FROM_RE = /^FROM node:22-alpine(?:@(sha256:[0-9a-f]{64}))?[ \t]*$/m
const NOTE_RE = /（当前 Node [\d.]+ \/ Alpine [\d.]+）/

/** Dockerfile 里锁定的基础镜像 digest；没锁（只写了标签）或 FROM 不是 node:22-alpine 返回 ''。 */
export function pinnedBase(dockerfile) {
  return String(dockerfile || '').match(FROM_RE)?.[1] || ''
}

/** 第一条 FROM 行原文，用来比较两个版本的基础镜像是否相同。 */
export function fromLine(dockerfile) {
  return String(dockerfile || '').match(/^FROM .*$/m)?.[0].trim() || ''
}

/** 把 FROM 换成指定 digest，顺带更新注释里的「（当前 Node x / Alpine y）」。 */
export function rewriteBase(dockerfile, digest, { node, alpine } = {}) {
  if (!FROM_RE.test(dockerfile)) throw new Error('Dockerfile 第一条 FROM 不是 node:22-alpine，没法自动换')
  let out = dockerfile.replace(FROM_RE, `FROM node:${BASE_TAG}@${digest}`)
  if (node && alpine) out = out.replace(NOTE_RE, `（当前 Node ${node} / Alpine ${alpine}）`)
  return out
}

/** 两个版本的 Dockerfile 基础镜像不同（含从「没锁」到「锁定」），这一版用户升级就要整包下载。 */
export function baseChanged(previousDockerfile, currentDockerfile) {
  const a = fromLine(previousDockerfile), b = fromLine(currentDockerfile)
  return Boolean(a && b && a !== b)
}

const REGISTRY = 'https://registry-1.docker.io/v2'
const INDEX = 'application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json'
const MANIFEST = 'application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'

/**
 * 查 Docker Hub 上 node 镜像某个标签或 digest 的信息：多架构清单的 digest（就是 FROM 里锁的那个），
 * 以及 amd64 那份的 Node 版本和 Alpine 版本（给人看的）。查不到抛错，调用方自己决定跳过。
 */
export async function baseImageInfo(ref = BASE_TAG, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const get = (url, headers) => fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  const tokenRes = await get(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${BASE_REPO}:pull`)
  const { token } = await tokenRes.json()
  const auth = accept => ({ Authorization: `Bearer ${token}`, Accept: accept })
  const indexRes = await get(`${REGISTRY}/${BASE_REPO}/manifests/${ref}`, auth(INDEX))
  if (!indexRes.ok) throw new Error(`Docker Hub 返回 HTTP ${indexRes.status}`)
  const digest = indexRes.headers.get('docker-content-digest') || ''
  const index = await indexRes.json()
  const amd64 = index.manifests?.find(m => m.platform?.architecture === 'amd64' && !m.platform.variant)
  let node = '', alpine = ''
  if (amd64) {
    const manifest = await (await get(`${REGISTRY}/${BASE_REPO}/manifests/${amd64.digest}`, auth(MANIFEST))).json()
    const config = await (await get(`${REGISTRY}/${BASE_REPO}/blobs/${manifest.config.digest}`, auth('*/*'))).json()
    node = (config.config?.Env || []).find(e => e.startsWith('NODE_VERSION='))?.slice('NODE_VERSION='.length) || ''
    alpine = (config.history || []).map(h => h.created_by || '').join('\n').match(/alpine-minirootfs-([\d.]+)-/)?.[1] || ''
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('Docker Hub 没给出清单 digest')
  return { digest, node, alpine }
}
