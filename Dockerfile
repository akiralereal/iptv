FROM node:22-alpine

WORKDIR /migu

# 先复制 package 文件并安装依赖
COPY package*.json ./
RUN npm install --production

# 再复制其他文件
COPY . .

# 设置时区
ENV TZ=Asia/Shanghai
RUN apk add --no-cache tzdata \
  && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
  && echo $TZ > /etc/timezone

CMD [ "node", "app.js" ]

