# live-resolver — 央视直播流动态解析服务
# 构建：docker build -t live-resolver:latest .
# 运行：docker run -d --name live-resolver -p 8788:8788 live-resolver:latest

FROM python:3.12-slim

WORKDIR /app

# 安装依赖
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制源码
COPY server.py .
COPY cctv_resolver.py .
COPY channels.json .

# 环境变量（可覆盖）
ENV PORT=8788 \
    CACHE_SECONDS=60 \
    LOG_LEVEL=INFO

EXPOSE 8788

CMD ["python", "server.py"]