FROM node:22-alpine

WORKDIR /migu

# 先复制 package 文件并安装依赖
COPY package*.json ./

# 跳过 Puppeteer 自动下载 Chromium，使用系统的（更快更稳定）
# 注意变量名是 PUPPETEER_SKIP_DOWNLOAD，不是 ..._SKIP_CHROMIUM_DOWNLOAD（后者 puppeteer 不认，是空操作）
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# 使用 npm ci 替代 npm install，速度更快且更可靠
# 如果有 package-lock.json 则使用 ci，否则降级使用 install
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --production; \
    fi

# 再复制其他文件
COPY . .

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

# 默认把运行时配置/数据写到 /migu/data，并声明为数据卷。
# 这样即使用户不在 compose 里挂卷，常规 `docker compose pull && up -d` 升级也会
# 自动复用同一个卷、不丢配置（系统配置/账号/订阅源/我的频道等）。
# 仍推荐在 compose 里用 `-v ./data:/migu/data` 绑定到宿主机，便于备份与跨 down/up 持久化。
ENV mdataDir=/migu/data
VOLUME ["/migu/data"]

# 通过 tini 启动，确保僵尸进程被回收、信号被正确转发
ENTRYPOINT ["/sbin/tini", "--"]
CMD [ "node", "app.js" ]

