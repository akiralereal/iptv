FROM node:22-alpine

WORKDIR /migu

COPY . .

# 设置时区
ENV TZ=Asia/Shanghai
RUN apk add --no-cache tzdata \
  && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
  && echo $TZ > /etc/timezone

CMD [ "node", "app.js" ]

