FROM node:22-alpine

WORKDIR /migu

# 先复制 package 文件并安装依赖
COPY package*.json ./

# 跳过 Puppeteer 自动下载 Chromium，使用系统的（更快更稳定）
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# 使用 npm ci 替代 npm install，速度更快且更可靠
# 如果有 package-lock.json 则使用 ci，否则降级使用 install
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --production; \
    fi

# 再复制其他文件
COPY . .

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

CMD [ "node", "app.js" ]

