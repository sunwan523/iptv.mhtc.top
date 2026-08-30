# iptv.mhtc.top 本地运行镜像（用于爱快软路由 Docker 等环境）
# 构建：docker build -t iptv-local:latest .
FROM node:20-alpine

WORKDIR /app

# 只复制运行所需的两个文件（零依赖）
COPY local-server.js /app/local-server.js
COPY worker.js /app/worker.js

# 数据目录（建议在爱快 Docker 挂载到路由磁盘，实现持久化）
RUN mkdir -p /app/data

ENV PORT=8787 \
    DATA_DIR=/app/data \
    REFRESH_TIMES=05:00,17:00

EXPOSE 8787

CMD ["node", "local-server.js"]
