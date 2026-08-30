# ============================================================
# build-image.ps1 — 在 Windows 上构建 iptv-local 镜像并导出 tar
# 供爱快软路由 Docker「镜像管理 → 引用镜像」上传使用
#
# 前置条件：本机已安装 Docker（Docker Desktop 即可）
# 用法：powershell -ExecutionPolicy Bypass -File build-image.ps1
# ============================================================

$ErrorActionPreference = 'Stop'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "未检测到 docker 命令，请先安装 Docker Desktop: https://www.docker.com/products/docker-desktop/" -ForegroundColor Red
    exit 1
}

Write-Host ">>> 构建镜像 iptv-local:latest ..."
docker build -t iptv-local:latest .

Write-Host ">>> 导出镜像 iptv-local.tar ..."
docker save -o iptv-local.tar iptv-local:latest

Write-Host ""
Write-Host "完成！已生成 iptv-local.tar" -ForegroundColor Green
Write-Host "下一步："
Write-Host "  1. 登录爱快 → 磁盘管理 → 文件管理，上传 iptv-local.tar"
Write-Host "  2. 系统设置 → Docker → 镜像管理 → 添加 → 引用镜像，填入上传的 tar 路径"
Write-Host "  3. 容器列表 → 添加容器（详见 README）"
