# 基础镜像锁到具体版本（当前 Node 22.23.4 / Alpine 3.24.4）。基础镜像一换，下面每一层都要重建，
# 用户升级就得重下整个镜像（约 400 MB）；锁住后只在主动换的那一版整包下载。
# 有新版时 bump-version.js 发版会提醒；换用 node bump-version.js update-base，并在更新日志写明这一版要整包下载。
FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202

WORKDIR /iptv

# 层的顺序按「多久变一次」从少到多排：系统包在前、npm 依赖其次、代码最后。
# 每次发版 package.json 的版本号都会变，它之后的层必然重建；系统包放在它前面，
# 配合构建流程里的层缓存（push_docker.yaml），Chromium、Python 这些大层发版时原样复用，用户升级不用重下。

# 安装 tini 作为 init 进程（PID 1）。
# Node 作为 PID 1 时不会回收被 Chromium 退出后重新挂到它名下的子进程，
# 会累积成僵尸(defunct)进程；tini 负责转发信号并回收这些孤儿进程。
RUN apk add --no-cache tini

# 安装系统 Chromium 用于网页抓取功能（可选）
# 注意：某些架构（如 s390x）可能没有 chromium 包，失败时跳过
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    || echo "Chromium not available on this architecture, web scraping will be disabled"

# 设置时区
ENV TZ=Asia/Shanghai
RUN apk add --no-cache tzdata \
  && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
  && echo $TZ > /etc/timezone

# YouTube 只用公开 HLS。两个纯 Python 包配合镜像中的 Node 处理播放器 JS。
# 不装 py3-pip：venv 的 pip 来自 python3 自带的 ensurepip，后台「检查更新」也只用 venv 里那份，系统再装一份白占约 4 MB。
# 放在 Chromium 之后：升级 yt-dlp（改 requirements.txt）只重建这一层及之后，不牵动 Chromium。
COPY extractors/youtube-live/requirements.txt /tmp/youtube-requirements.txt
RUN apk add --no-cache python3 \
  && python3 -m venv /opt/youtube \
  && /opt/youtube/bin/pip install --no-cache-dir -r /tmp/youtube-requirements.txt \
  && ln -s /opt/youtube/bin/yt-dlp /usr/local/bin/yt-dlp

# 跳过 Puppeteer 自动下载 Chromium，使用系统的（更快更稳定）
# 注意变量名是 PUPPETEER_SKIP_DOWNLOAD，不是 ..._SKIP_CHROMIUM_DOWNLOAD（后者 puppeteer 不认，是空操作）
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# 再复制 package 文件并安装依赖
COPY package*.json ./

# 使用 npm ci 替代 npm install，速度更快且更可靠
# 如果有 package-lock.json 则使用 ci，否则降级使用 install
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --production; \
    fi

# 再复制其他文件
COPY . .

# 默认把运行时配置/数据写到 /iptv/data，并声明为数据卷。
# 这样即使用户不在 compose 里挂卷，常规 `docker compose pull && up -d` 升级也会
# 自动复用同一个卷、不丢配置（系统配置/账号/订阅源/我的频道等）。
# 仍推荐在 compose 里用 `-v ./data:/iptv/data` 绑定到宿主机，便于备份与跨 down/up 持久化。
#
# 兼容旧路径 /migu/data（≤ v4.1.0 镜像的数据目录，早年项目只有咪咕时起的名）：
# - /migu/data 仍保留在 VOLUME 声明里，老部署（不挂卷、数据在旧路径匿名卷）升级后
#   compose 会继续把旧匿名卷挂回原位；
# - 老 compose 挂 ./data:/migu/data 的照常生效；
# - 两种情况都由 utils/paths.js 检测「新默认路径无数据、旧路径有数据」自动沿用旧路径，零操作不丢配置。
ENV mdataDir=/iptv/data
VOLUME ["/iptv/data", "/migu/data"]

# 通过 tini 启动，确保僵尸进程被回收、信号被正确转发
ENTRYPOINT ["/sbin/tini", "--"]
# 关掉 core dump：宿主机 core_pattern 是相对路径时，Chromium 每崩一次都往 /iptv 写几十 MB，
# 落在容器层、重启不消失。exec 后 node 仍是 tini 的直接子进程，浏览器子进程继承这个限制
CMD [ "sh", "-c", "ulimit -c 0; exec node app.js" ]

