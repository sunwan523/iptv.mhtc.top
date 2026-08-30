# IPTV 直播源管理系统

基于 Cloudflare Workers 构建的 IPTV 直播源聚合与管理平台，支持多源合并、固定映射、URL 替换等功能。

## 项目概述

本项目部署在 Cloudflare Workers 上，为 IPTV 用户提供统一的直播源管理服务。通过固定映射机制，前端播放器始终使用不变的频道地址，后台可灵活更新实际播放源。

## 核心功能

### 1. URL 自动替换
- 自动将源中的 `p.mhtc.top` 替换为 `192.168.100.1`
- 其他 URL 保持不变

### 2. 多源合并
- 支持添加多个直播源（M3U / TXT 格式）
- 按优先级合并去重，同名频道自动聚合
- 支持按分组、关键词筛选

### 3. 固定映射（核心）
- **功能说明**：为每个频道生成固定播放地址（`/{channel_id}`），通过 302 跳转到实际播放地址
- **自动更新**：上传新的 M3U 文件后自动更新映射关系
- **管理界面**：支持编辑频道名称、删除选中映射、保存后自动同步到数据源
- **日志记录**：每次上传/更新都会产生日志，方便追踪
- **缓存清理**：一键清理已不再需要的缓存数据

### 4. M3U 文件生成
- 自动生成标准 M3U 文件：`/iptv2026.m3u`
- 固定映射频道输出为跳转地址，其他频道输出原地址
- 支持 tvg-id、tvg-logo、group-title 等标准字段

### 5. 播放列表管理
- 创建自定义播放列表
- 可视化编辑频道顺序
- 支持导入/导出
- 播放列表 `1` 为固定长期保留项：禁止删除，但内容可正常编辑和刷新

### 6. 后台管理
- 管理后台接口需要请求头 `X-Admin-Password`
- 密码在 `worker.js` 的 `CONFIG.ADMIN_PASSWORD` 中配置

## 本地频道检测器

`local-checker/` 是一个零依赖的本地检测器，运行在 Windows + Node.js 18+ 环境。

- 定时拉取播放列表并逐个探测频道：跟随 302 跳转，校验 M3U8 内容，检查响应状态
- 重点监控自建源：`192.168.100.1:4000`、`192.168.100.1:3000`、`iptv.mhtc.top`
- 检测到故障时弹出 Windows 桌面提醒并播放提示音，写入 `alerts.log`
- 默认只提醒自建源故障；可在页面设置中开启外网频道故障提醒
- 内置网页看板：自建服务状态、频道状态、检测历史、提醒记录、设置

### 使用

1. 按需修改 `local-checker/config.json`（默认已配置 `iptv2026.m3u` 和固定播放列表 `1`）
2. 启动：

```powershell
powershell -ExecutionPolicy Bypass -File local-checker/start.ps1
```

3. 打开 `http://127.0.0.1:8787`
4. 停止：

```powershell
powershell -ExecutionPolicy Bypass -File local-checker/stop.ps1
```

也可执行一次性检测（适合放入 Windows 任务计划程序）：

```powershell
node local-checker/server.js --check-once
```

## iStoreOS 部署（当前使用，2026-08-30）

最终选定在 **iStoreOS 软路由**（`192.168.100.88`）上用 Docker 运行，纯内网访问，不走外网。

### 当前状态

| 项目 | 值 |
|------|-----|
| 访问地址 | `http://192.168.100.88:8787`（管理后台，**无密码**） |
| 播放列表 | `http://192.168.100.88:8787/playlist/1.m3u`、`/playlist/2.m3u`、`/iptv2026.m3u` |
| 容器 | `iptv-local`（开机自启，`--restart always`） |
| 数据 | 路由器 `/root/iptv-data` 挂载到容器 `/app/data`（重启/升级不丢） |
| 定时刷新 | 每天北京时间 05:00 / 17:00 自动更新数据源和播放列表 |

### 1. 镜像获取（上传到路由器）

iStoreOS 自带完整 Docker，**不需要**像爱快那样上传 tar 文件，直接从镜像仓库拉取即可。

- 镜像地址：`ghcr.io/sunwan523/iptv-local:latest`（已设为**公开**，amd64 + arm64 多架构，x86/ARM 都兼容）
- 拉取命令：`docker pull ghcr.io/sunwan523/iptv-local:latest`
- **拉取失败处理**：
  - 报 `unauthorized` → 先登录：`docker login ghcr.io`（Username 填 GitHub 用户名 `sunwan523`，Password 填 GitHub Personal Access Token，不是登录密码）
  - 直连慢/超时 → 用南京大学 ghcr 加速：
    ```bash
    docker pull ghcr.nju.edu.cn/sunwan523/iptv-local:latest
    docker tag ghcr.nju.edu.cn/sunwan523/iptv-local:latest ghcr.io/sunwan523/iptv-local:latest
    ```
- **本机重新构建并推送镜像**（修改 worker.js 后）：
  ```powershell
  docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/sunwan523/iptv-local:latest --push .
  ```

### 2. 部署命令（从零完整流程，iStoreOS SSH 里执行）

```bash
# ① 建数据目录（存播放列表、固定映射、数据源等，重启不丢）
mkdir -p /root/iptv-data

# ② 拉取镜像（失败处理见上节）
docker pull ghcr.io/sunwan523/iptv-local:latest

# ③ 启动容器
docker run -d --name iptv-local --restart always \
  -p 8787:8787 \
  -v /root/iptv-data:/app/data \
  ghcr.io/sunwan523/iptv-local:latest

# ④ 验证
docker ps | grep iptv-local    # STATUS 应为 Up
docker logs iptv-local         # 应显示 "IPTV 本地服务已启动"
```

**参数说明**：

| 参数 | 含义 |
|------|------|
| `-d` | 后台运行 |
| `--name iptv-local` | 容器名（不能与已有容器重名，若重名先 `docker rm -f 重名容器`） |
| `--restart always` | 开机自启 + 崩溃自动重启 |
| `-p 8787:8787` | 端口映射：路由器 8787 → 容器 8787。被占用就改成 `-p 18000:8787`，访问对应端口 |
| `-v /root/iptv-data:/app/data` | 数据持久化挂载（必须保留，否则升级/重启丢数据） |

启动后浏览器访问 `http://192.168.100.88:8787`。

### 3. 接口清单

**对外使用（播放器 / 电视 / 其他项目）：**

| 接口 | 说明 |
|------|------|
| `GET /playlist/{id}.m3u` | 播放列表 M3U，如 `/playlist/1.m3u`、`/playlist/2.m3u` |
| `GET /iptv2026.m3u` | 固定映射标准 M3U |
| `GET /{channel_id}` | 固定映射频道地址，302 跳转到实际播放地址 |

**管理后台 / 管理 API（已无密码验证）：**

| 接口 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 管理后台页面 |
| `/api/status` | GET | 运行状态 |
| `/api/sources` | GET | 数据源列表 |
| `/api/source/{id}` | POST/PUT/DELETE | 添加 / 更新 / 删除数据源 |
| `/api/refresh` | POST | 手动刷新全部数据源 |
| `/api/channels` | GET | 合并后的频道列表 |
| `/api/playlists` | GET | 播放列表列表 |
| `/api/channel-mapping` | GET | 固定映射列表 |
| `/api/channel-mapping/logs` | GET | 上传/推送日志 |

**固定映射推送接口（供其他项目自动更新，重点）：**

另一个项目更新固定映射后，把 M3U 内容 POST 到这个地址（**无需任何鉴权头**）：

```
POST http://192.168.100.88:8787/api/channel-mapping
```

请求体（JSON）：

```json
{
  "content": "#EXTM3U\n#EXTINF:-1 group-title=\"央视\" tvg-id=\"cctv1\",CCTV1\nhttp://192.168.100.1:4000/cctv1/index.m3u8\n#EXTINF:-1 group-title=\"央视\",CCTV2\nhttp://192.168.100.1:4000/cctv2/index.m3u8\n",
  "pruneMissing": false
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `content` | 是 | 完整 M3U 文本（对方项目生成的固定映射） |
| `pruneMissing` | 否 | `true`=全量同步（删除 M3U 中没有的旧映射）；`false`=只增改不删（默认） |

推送后自动：更新固定映射 → 刷新频道 → 记录上传日志。响应示例：

```json
{ "success": true, "newChannels": 1, "updatedChannels": 0, "removedChannels": 0 }
```

curl 示例：

```bash
curl -X POST http://192.168.100.88:8787/api/channel-mapping \
  -H "Content-Type: application/json" \
  -d '{"content":"#EXTM3U\n...","pruneMissing":false}'
```

### 4. 数据迁移

电脑本地 `data/` 目录（含 `sources_kv/`、`playlists_kv/`，从线上迁移的真实数据）通过 scp 传到路由器：

```powershell
scp -r d:\codex\iptv.mhtc.top\data\sources_kv d:\codex\iptv.mhtc.top\data\playlists_kv root@192.168.100.88:/root/iptv-data/
```

传完 `docker restart iptv-local`。不用迁移的话，直接在管理后台手动添加数据源即可。

### 5. 密码验证已去除

- 后端：移除 `ADMIN_PATH_PATTERNS` 鉴权检查和 `X-Admin-Password` 校验
- 前端：移除管理密码弹窗（`adminFetch` 直接转发）
- ⚠️ 因此**管理接口完全开放**，只建议在内网使用；如要暴露公网请先恢复鉴权

### 6. 升级

1. 电脑上修改 `worker.js` → 重新构建推送镜像（命令见第 1 节）
2. iStoreOS SSH：
   ```bash
   docker pull ghcr.io/sunwan523/iptv-local:latest
   docker rm -f iptv-local
   docker run -d --name iptv-local --restart always -p 8787:8787 -v /root/iptv-data:/app/data ghcr.io/sunwan523/iptv-local:latest
   ```
数据在挂载目录，不会丢。

## 在爱快软路由上本地运行（备选，未采用）

如果希望整个管理系统直接跑在爱快软路由上、不依赖 Cloudflare 外网，可以使用本仓库自带的本地运行方案：`local-server.js` + Docker 镜像。

**原理**：`local-server.js` 在 Node.js 环境里用「磁盘文件」模拟 Cloudflare KV、「内存」模拟 Cache API，然后原封不动加载 `worker.js`（逻辑 100% 复用，无需改动 worker.js）。数据保存在路由器磁盘上，重启不丢失。定时刷新默认每天北京时间 05:00 / 17:00（与云端一致）。

### 1. 本机直接运行（可选，先验证）

需要 Node.js 18+：

```powershell
$env:PORT=8787; $env:DATA_DIR="d:\codex\iptv.mhtc.top\data"; node local-server.js
```

浏览器访问 `http://127.0.0.1:8787` 即可。

### 2. 构建 Docker 镜像（已完成）

本机（需安装 Docker Desktop）运行：

```powershell
powershell -ExecutionPolicy Bypass -File build-image.ps1
```

生成 `iptv-local.tar`（约 46MB，镜像内已包含 worker.js + local-server.js，已验证可运行）。

### 3. 爱快 Docker 部署

1. 确认爱快已开启 Docker：系统设置 → Docker（需绑定爱快云安装 Docker 插件，磁盘管理中将一块磁盘分区为「普通存储」）
2. 登录爱快 → **磁盘管理 → 文件管理**，上传 `iptv-local.tar`
3. 在文件管理里**先新建一个数据文件夹**（例如 `iptv-data`），用于持久化存储
4. **系统设置 → Docker → 镜像管理 → 添加**，上传方式选「引用镜像」，填入 `iptv-local.tar` 的路径，等待加载完成（镜像名应为 `iptv-local`）
5. **Docker → 接口管理**，添加一个与内网不冲突的网段（如 `172.18.0.0/24`）
6. **Docker → 容器列表 → 添加容器**：
   - 镜像：选择 `iptv-local`
   - 内存占用：256MB 即可（最小 128MB）
   - 网络接口：选择上一步创建的接口
   - 开机自启：勾选
   - 高级设置 → 挂载目录：源路径 = 第 3 步建的文件夹（如 `/iptv-data`），目标路径 = `/app/data`（**数据持久化，升级/重启容器不丢数据**）
   - 高级设置 → 环境变量（可选）：`PORT=8787`、`REFRESH_TIMES=05:00,17:00`
7. 启动容器，在容器列表查看容器 IP 和运行状态

### 4. 访问

- 管理后台：`http://<容器IP>:8787`（局域网一般可直接访问；如不可达，可在爱快 Docker 高级设置里做端口映射，或用路由器 IP 访问）
- 播放列表：`http://<容器IP>:8787/iptv2026.m3u`
- 固定映射：`http://<容器IP>:8787/{channel_id}`（302 跳转到实际播放地址）

若想让固定映射地址始终使用路由器 IP（如 `http://192.168.100.1:8787`），请通过端口映射后使用该地址访问并重新生成播放列表。

### 5. 常见问题排查

- **容器一直重启**：查看容器日志确认报错；多为内存不足或挂载路径错误。内存给 256MB，挂载目标路径必须是 `/app/data`
- **局域网访问不了**：确认容器所在网段与内网可达；或使用端口映射方式访问
- **升级代码**：修改 worker.js 后重新 `build-image.ps1` → 上传新 tar → 重新引用镜像 → 用相同挂载重建容器，数据不丢失
- **查看日志**：爱快 Docker 容器列表 → 容器详情 → 日志；或 docker logs 命令

### 6. 数据说明

- 数据源刷新仍走外网抓取（与原版行为一致）；服务本身运行在路由器内网
- `worker.js` 的 `URL_REPLACEMENTS` 已配置 `p.mhtc.top → 192.168.100.1`，本地版同样生效

### 7. 迁移云端数据（可选）

两种方式把线上数据搬到本地（任选其一）：

**方式一：从线上管理 API 抓取（推荐，无需 wrangler）**

```powershell
node migrate-kv.js http-dump https://iptv.mhtc.top 你的管理密码
```

自动抓取数据源、固定映射、上传日志和播放列表，写入本地 `data` 目录并生成 `data/kv-export.json` 备份。

**方式二：从 Cloudflare KV 导出（需在项目根目录、已安装并登录 wrangler）**

```powershell
node migrate-kv.js            # 从 Cloudflare KV 导出并写入本地 data 目录，同时生成 data/kv-export.json 备份
```

导出完成后，把 `data/sources_kv/` 和 `data/playlists_kv/` 两个文件夹复制到路由器 Docker 挂载目录（容器内 `/app/data`），重启容器即可生效。

从 JSON 备份恢复（例如把备份文件拷到其他机器再导入）：

```powershell
node migrate-kv.js import                  # 从默认 data/kv-export.json 恢复
node migrate-kv.js import 备份.json [数据目录]
```

## API 接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 管理后台首页 |
| `/iptv2026.m3u` | GET | 固定映射 M3U 文件 |
| `/{channel_id}` | GET | 频道固定地址（302 跳转） |
| `/api/channels` | GET | 获取所有频道列表 |
| `/api/sources` | GET/POST | 数据源管理 |
| `/api/source/{id}` | GET/PUT/DELETE | 单个数据源操作 |
| `/api/channel-mapping` | GET/POST | 频道映射管理 |
| `/api/channel-mapping/logs` | GET | 上传日志查询 |
| `/api/channel-mapping/batch-update` | POST | 批量更新映射 |
| `/api/clear-cache` | POST | 清理缓存 |
| `/api/playlist` | GET/POST | 播放列表管理 |

## 部署说明

### 前置条件
- Cloudflare 账号
- 已创建 KV 存储（绑定变量名：`SOURCES_KV`）
- Wrangler CLI（可选，用于本地开发）

### 部署步骤
1. 在项目目录执行 `wrangler deploy`
2. `wrangler.toml` 已配置 Worker 名称 `iptv` 和 KV 绑定
3. 在 Workers 设置中配置自定义域名（可选）
4. 访问 Worker URL 或绑定的域名即可使用

定时任务已配置：每天北京时间 05:00 和 17:00 自动刷新数据源和所有播放列表。

### 本地开发
```bash
# 使用 Wrangler 本地开发
wrangler dev
```

## 使用流程

1. **首次使用**：访问管理后台，在数据源管理中添加上游数据源
2. **创建映射**：在固定映射页面上传 M3U 文件，自动生成频道映射
3. **获取 M3U**：访问 `/iptv2026.m3u` 获取标准播放列表
4. **日常更新**：抓取新的直播源后，上传 M3U 文件即可自动更新映射
5. **播放**：将 `/iptv2026.m3u` 地址配置到电视/播放器中即可

## 技术架构

- **运行时**：Cloudflare Workers（V8 Isolate）
- **存储**：Cloudflare KV（持久化频道映射、数据源、播放列表）
- **前端**：原生 HTML/CSS/JS（单页面内嵌在 Worker 中）
- **缓存**：Worker 内存缓存 + KV 持久化

## 目录结构

```
iptv.mhtc.top/
├── worker.js      # 主 Worker 脚本（包含所有逻辑和前端页面）
├── local-server.js# 本地运行启动器（爱快软路由/任意 Node 18+，模拟 KV 与 Cache，复用 worker.js）
├── migrate-kv.js  # Cloudflare KV → 本地数据目录迁移脚本（可选）
├── Dockerfile     # 本地运行 Docker 镜像
├── build-image.ps1# Windows 构建镜像并导出 tar 的脚本
├── local-checker/ # 本地播放源检测器（Web 看板 + 桌面提醒）
└── README.md      # 本项目说明文件
```

## 版本历史

- **20260830-deploy**：正式部署到 iStoreOS 软路由（192.168.100.88，Docker 容器 iptv-local，纯内网运行）；去除管理密码验证（后端 + 前端弹窗）；新增固定映射推送接口说明；ghcr.io 多架构镜像发布
- **20260830-local**：新增爱快软路由本地运行方案（local-server.js + Dockerfile + build-image.ps1）；本地 Docker 镜像构建与数据持久化已验证；migrate-kv.js 支持 KV 导出 / JSON 恢复 / 线上 API 抓取（http-dump）
- **20260816-local**：新增本地频道检测器；播放列表 `1` 设为固定项，禁止删除和修改
- **20260807-v9**：当前版本
  - 后台接口增加管理密码鉴权
  - 修复前端 HTML 注入风险
  - 源 URL 增加安全校验，抓取增加超时重试
  - 固定映射支持同步清理缺失频道
  - 增加定时刷新、KV 容错和单元测试
- **20260706-v8**：当前版本
  - 支持固定映射编辑与删除
  - 添加上传日志展示
  - 添加缓存清理功能
  - 修复数据源刷新 HTTP 522 错误
  - 固定映射源自动生成（`_fixed_mapping`）

## 许可证

本项目仅供学习和个人使用。
