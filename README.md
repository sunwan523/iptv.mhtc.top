# IPTV 直播源管理系统

基于 Cloudflare Workers + KV 构建的 IPTV 直播源聚合与管理平台，支持多源合并、固定映射、URL 自动替换、定时刷新等功能。可同时部署在 Cloudflare Workers（公网）和 iStoreOS / 爱快软路由（内网 Docker）。

## 快速导航

| 内容 | 位置 |
|------|------|
| 核心功能 | [核心功能](#核心功能) |
| 定时刷新机制（重点） | [定时刷新](#定时刷新) |
| Cloudflare Workers 部署 | [Cloudflare Workers 部署](#cloudflare-workers-部署) |
| iStoreOS 软路由部署 | [istoreos-软路由部署推荐](#istoreos-软路由部署推荐) |
| 爱快 Compose 部署 | [爱快软路由部署](#爱快软路由部署compose实测通过) |
| API 接口清单 | [api-接口清单](#api-接口清单) |
| 固定映射推送 | [固定映射推送接口](#固定映射推送接口) |
| 管理后台使用 | [管理后台操作指南](#管理后台操作指南) |
| 本地频道检测器 | [本地频道检测器](#本地频道检测器) |
| 架构与目录结构 | [技术架构与目录结构](#技术架构与目录结构) |
| 开发与升级 | [升级指南](#升级指南) |
| 故障排查 | [常见问题排查](#常见问题排查) |
| 版本历史 | [版本历史](#版本历史) |

## 核心功能

### 1. URL 自动替换
- 自动把源中的 `p.mhtc.top` 替换为 `192.168.100.1`（内网自建源）
- 配置位置：`worker.js` 的 `CONFIG.URL_REPLACEMENTS`
- 其他 URL 原样保留

### 2. 多源合并
- 支持添加多个直播源（M3U / TXT 格式）
- 每个源可独立设置 **优先级**：数字越小越优先，同名频道自动合并去重
- 支持按分组、关键词在管理后台筛选
- 每个源可独立设置 **刷新时间**（每天自动拉取）

### 3. 固定映射（核心设计）
- 为每个频道生成**永久不变**的固定地址（`/{channel_id}`）
- 播放器始终访问固定地址，后台通过 302 跳转到实际播放 URL
- 上游源挂了 → 只需后台更新映射，播放器地址不变
- 自动从 M3U URL 中提取 channel ID（匹配 `/xxx/index.m3u8` 模式）
- 支持"只增改"和"全量同步"两种更新模式
- 每次上传生成日志，追踪变更量

### 4. M3U 文件生成
- 标准 M3U 输出：`/iptv2026.m3u`（固定映射版）、`/playlist/{id}.m3u`（自定义列表版）
- 固定映射频道输出为跳转地址，其他输出原地址
- 完整支持 `tvg-id`、`tvg-logo`、`group-title`、`tvg-name` 等字段
- 自动为没有台标的频道生成 EPG logo URL

### 5. 播放列表管理
- 创建自定义播放列表，按关键词或分组从合并后的频道中筛选
- 可视化编辑（左右栏拖拽式）：从可用频道选到选中频道
- 支持导入 / 导出
- 播放列表 `1` 为**固定长期保留项**：禁止删除，但内容可正常编辑和刷新
- 每个播放列表可独立设置刷新时间

### 6. 管理后台
- 纯前端内嵌在 Worker 中（原生 HTML/CSS/JS，零依赖）
- 四个标签页：数据源管理、频道管理、播放列表、固定映射
- 内置运行状态、总频道数、分类数等统计
- 当前版本：**无密码验证**（仅内网部署时安全）

## 定时刷新

### 设计思路

不是定时调用"刷新全部"，而是**每 30 秒（本地）/ 每 5 分钟（Cloudflare）调度一次，由 scheduled handler 逐项检查**每个源和播放列表的独立刷新时间。这样每个源和列表可以完全解耦，各自按自己的节奏刷新。

### 默认刷新时间

| 对象 | 默认时间（北京时间） | 可配置 |
|------|---------------------|--------|
| 数据源 | 每天 **05:00、17:00** 两次 | 是（支持多个时间点） |
| 播放列表 | 每天 **05:05、17:05** 两次 | 是（支持多个时间点） |

> 播放列表比源晚 5 分钟，是为了让源先拉完数据、列表再去匹配。

### 配置方式

管理后台 → **数据源管理** → 添加 / 编辑时填写"刷新时间"输入框。格式是多个 `HH:MM`（北京时间）用英文逗号分隔，例如：`05:00,12:00,17:00`。

### 工作机制

以本地运行器为例（Cloudflare Workers 每 5 分钟 cron，机制相同）：

```
每 30 秒（local-server.js setInterval）
    ↓
调用 worker.js 的 scheduled handler
    ↓
计算当前北京时间（处理跨天日期）
    ↓
遍历所有数据源 → 比较 refreshTimes 是否命中
    ├─ 命中 → 标记 needRefreshSources=true
    └─ 用 KV 中记录的 _lastRef_ 键防止同一天同一分钟重复刷新
    ↓
如果 needRefreshSources=true → refreshAllSources() 拉取所有启用源
    ↓
遍历所有播放列表 → 比较 refreshTimes 是否命中
    ├─ 命中 → 如果源还没刷新，先刷源；再 rematchPlaylist() 重新匹配
    └─ 清理缓存（尝试多个 origin）
```

### 本地运行 vs Cloudflare Workers

| 环境 | 调度频率 | 配置位置 |
|------|---------|---------|
| iStoreOS / 爱快（本地） | 每 30 秒 | `local-server.js` 的 `setInterval` |
| Cloudflare Workers | 每 5 分钟 | `wrangler.toml` 的 `crons = ["*/5 * * * *"]` |

两边都由同一个 `worker.js` 的 scheduled handler 执行"逐项检查"逻辑，只是外层调度频率不同。

### 已废弃的旧机制

之前用过的全局 `REFRESH_TIMES` 环境变量和 wrangler.toml 里固定 `05:00/17:00` cron 均已废弃，统一迁移到每个源 / 播放列表的独立 `refreshTimes` 字段。

## 技术架构与目录结构

### 架构图（文字版）

```
 ┌───────────────────────────────────────────────┐
 │            用户 / 电视 / 播放器                │
 └──────────────┬────────────────────────────────┘
                │ HTTP
                ▼
   ┌──────────────────────────────┐
   │     worker.js（核心逻辑）     │
   │  ┌────────────────────────┐  │
   │  │  fetch handler         │  │ ← 管理后台 / API / M3U / 302 跳转
   │  └────────────────────────┘  │
   │  ┌────────────────────────┐  │
   │  │ scheduled handler      │  │ ← 每 30 秒/5 分钟调度，检查各源和列表独立刷新时间
   │  └────────────────────────┘  │
   └──────┬─────────────┬─────────┘
          │             │
   ┌──────┴───┐    ┌────┴────┐
   │SOURCES_KV│    │PLAYLISTS│
   │          │    │  _KV    │
   └────┬─────┘    └────┬────┘
        │               │
        ▼               ▼
  Cloudflare KV     Cloudflare KV
  或（本地）文件    或（本地）文件
  （sources_kv/）   （playlists_kv/）
```

### 目录结构

```
iptv.mhtc.top/
├── worker.js          # 核心：所有业务逻辑 + 管理后台 HTML（单文件）
├── local-server.js    # 本地运行器：模拟 Cloudflare KV/Cache，加载 worker.js
├── wrangler.toml      # Cloudflare Workers 部署配置（KV 绑定 + cron）
├── Dockerfile         # iStoreOS / 爱快本地运行用的 Docker 镜像
├── build-image.ps1    # Windows 下构建并导出 tar 镜像的脚本（爱快用）
├── migrate-kv.js      # 数据迁移脚本：KV ↔ 本地 data 目录 ↔ 线上 API
├── .gitignore
├── README.md          # 本文件
│
├── local-checker/     # 本地频道检测器（独立子项目）
│   ├── server.js      # Node.js 零依赖检测器（定时探测 + 桌面提醒 + Web 看板）
│   ├── config.json    # 检测器配置（播放列表 URL、自建源列表、探测间隔等）
│   ├── start.ps1 / stop.ps1   # Windows 服务启停
│   └── public/        # Web 看板前端
│
└── data/              # 运行时数据（不纳入版本控制）
    ├── sources_kv/    #   数据源、固定映射、上传日志等（每个 key 一个文件）
    └── playlists_kv/  #   播放列表数据（每个 key 一个文件）
```

### 数据存储（KV Schema）

Cloudflare KV 和本地文件目录使用相同的键名约定：

| 键 | 内容 | 所有者 |
|----|------|--------|
| `{source_id}` | 数据源 JSON（name/url/priority/enabled/refreshTimes 等） | SOURCES_KV |
| `chmap:{channel_id}` | 固定映射 JSON（name/url/updatedAt） | SOURCES_KV |
| `chmap:_list` | 所有固定映射的 channel_id 列表 | SOURCES_KV |
| `chmap:_logs` | 上传 / 推送日志（最多保留 30 条） | SOURCES_KV |
| `_lastRef_src_{source_id}_{time}` | 源在某个时间点上次刷新日期（防重复） | SOURCES_KV |
| `_lastRef_pl_{playlist_id}_{time}` | 列表在某个时间点上次刷新日期（防重复） | SOURCES_KV |
| `{playlist_id}` | 播放列表 JSON（name/urls/refreshTimes/updatedAt 等） | PLAYLISTS_KV |

## Cloudflare Workers 部署

### 前置条件

- Cloudflare 账号
- 已创建两个 KV Namespace：`SOURCES_KV` 和 `PLAYLISTS_KV`（ID 写在 wrangler.toml 里，一般创建一次就好）
- Node.js 18+（装 wrangler CLI：`npm i -g wrangler`）

### 部署步骤

```powershell
# 1. 登录 Cloudflare
wrangler login

# 2. 在项目目录部署
wrangler deploy
```

第一次部署会创建 Worker 并触发 cron 注册。后续修改代码直接 `wrangler deploy` 即可。

### 配置文件（wrangler.toml）

```toml
name = "iptv"
main = "worker.js"
compatibility_date = "2026-04-08"

[[kv_namespaces]]
binding = "SOURCES_KV"
id = "a38a02d5da494652981f3ac86d9f3ead"

[[kv_namespaces]]
binding = "PLAYLISTS_KV"
id = "1e411bc68d4b48449c9290d8fd61c642"

[triggers]
# 每 5 分钟调度一次，由 scheduled handler 逐项检查各源和播放列表的独立刷新时间
crons = ["*/5 * * * *"]
```

### 本地开发（可选）

```powershell
wrangler dev          # 模拟 Cloudflare Workers 环境
```

## iStoreOS 软路由部署（推荐）

当前生产方式。软路由内网 `192.168.100.88` 用 Docker 本地运行，纯内网访问。

### 当前状态

| 项目 | 值 |
|------|-----|
| 访问地址 | `http://192.168.100.88:8787`（管理后台，无密码） |
| 播放列表 | `http://192.168.100.88:8787/playlist/1.m3u`、`/iptv2026.m3u` |
| 容器 | `iptv-local`（`--restart always`，开机自启） |
| 数据目录 | 路由器 `/root/iptv-data` → 容器 `/app/data`（挂载持久化，重启不丢） |
| 镜像 | `ghcr.io/sunwan523/iptv-local:latest`（amd64 + arm64 多架构） |
| 调度频率 | 每 30 秒检查（local-server.js） |
| 源默认刷新 | 每天 05:00、17:00（北京时间） |
| 列表默认刷新 | 每天 05:05、17:05（北京时间） |

### 从零完整部署流程（iStoreOS SSH 里执行）

```bash
# ① 建数据目录
mkdir -p /root/iptv-data

# ② 拉取镜像（直连 GitHub Container Registry）
docker pull ghcr.io/sunwan523/iptv-local:latest

#   如果报 unauthorized，先登录：
#   docker login ghcr.io
#   Username: 你的 GitHub 用户名
#   Password: GitHub Personal Access Token（不是登录密码）

#   如果直连慢，用南京大学加速：
#   docker pull ghcr.nju.edu.cn/sunwan523/iptv-local:latest
#   docker tag ghcr.nju.edu.cn/sunwan523/iptv-local:latest ghcr.io/sunwan523/iptv-local:latest

# ③ 启动容器
docker run -d --name iptv-local --restart always \
  -p 8787:8787 \
  -v /root/iptv-data:/app/data \
  ghcr.io/sunwan523/iptv-local:latest

# ④ 验证
docker ps | grep iptv-local       # STATUS 应为 Up
docker logs iptv-local            # 启动成功会打印 "IPTV 本地服务已启动"
docker logs -f iptv-local         # 持续跟踪日志（Ctrl+C 退出）
```

启动后浏览器打开 `http://192.168.100.88:8787`。

### docker run 参数说明

| 参数 | 含义 |
|------|------|
| `-d` | 后台运行 |
| `--name iptv-local` | 容器名（重名先 `docker rm -f 旧名`） |
| `--restart always` | 开机自启 + 崩溃自动重启 |
| `-p 8787:8787` | 端口映射：路由器 8787 → 容器 8787。被占用就改 `-p 18000:8787` |
| `-v /root/iptv-data:/app/data` | 数据持久化。**必须保留**，否则升级容器会丢数据 |

### Docker 镜像构建（本机）

修改代码后，本机构建并推送：

```powershell
# 需要 Docker Desktop + buildx
docker buildx build --platform linux/amd64,linux/arm64 `
  -t ghcr.io/sunwan523/iptv-local:latest --push .
```

构建成功后 iStoreOS 上 `docker pull` + 重启容器即可。

## 爱快软路由部署（Compose，实测通过）

爱快支持 Docker Compose（爱快 Docker 管理界面 → 编排），但有两个**限制**必须注意：

1. **镜像源 ghcr.io 拉不动**：爱快直连 GitHub Container Registry 超时，必须用南京大学镜像加速 `ghcr.nju.edu.cn`
2. **挂载路径不能写绝对路径**：爱快要求 volumes 写**相对路径**（Compose 文件所在目录下），不能写命名卷，也不能写 `/root/xxx` 这种绝对路径

### Compose 文件（直接粘贴）

爱快 Docker → 编排 → 新建，粘贴：

```yaml
services:
  iptv-local:
    image: ghcr.nju.edu.cn/sunwan523/iptv-local:latest
    container_name: iptv-local
    restart: always
    ports:
      - "8787:8787"
    volumes:
      - ./data:/app/data
    environment:
      - PORT=8787
      - DATA_DIR=/app/data
```

### 部署步骤

1. **保存 Compose**，爱快会自动在 `/docker/Compose/doc_iptv-local/` 下落盘
2. **爱快文件管理** → 找到这个目录，**手动建 `data` 文件夹**（爱快不会自动建）
3. （可选）如果数据目录还要手动建子目录，进 `data/` 后再建 `sources_kv` 和 `playlists_kv`（容器启动时也会自动建，不急）
4. **爱快 Docker → 编排 → 点开启**，镜像从 ghcr.nju.edu.cn 拉取，几分钟后完成
5. **访问** `http://<爱快IP>:8787`

### 数据迁移（从 iStoreOS / Cloudflare）

全新容器是空的，需要把旧数据搬过来：

**第一步：从旧设备导出**（旧 iStoreOS 能 SSH 的话）：
```powershell
# Windows 本机执行
scp -r root@192.168.100.88:/root/iptv-data/sources_kv d:\codex\iptv.mhtc.top\data\
scp -r root@192.168.100.88:/root/iptv-data/playlists_kv d:\codex\iptv.mhtc.top\data\
```

**第二步：导入到爱快**：
- 爱快文件管理进入 `/docker/Compose/doc_iptv-local/data/sources_kv/`，把 Windows 上 `d:\codex\iptv.mhtc.top\data\sources_kv\` 里的所有文件上传
- 同理进入 `playlists_kv/`，上传对应文件
- 爱快 Docker → 容器管理 → **重启 `iptv-local`**

### 镜像更新（以后升级）

```yaml
# Compose 里 image 保持 ghcr.nju.edu.cn/sunwan523/iptv-local:latest
# 爱快 Docker → 镜像管理 → 先手动拉取新版本
# 或直接在 Compose 编排里改 image 后重新点开启（爱快会自动拉）
```

### 爱快限制总结

| 爱快限制 | 本项目的应对 |
|---------|------------|
| 禁止命名卷 (`iptv-data:`) | 用相对路径 `./data` |
| 禁止绝对路径挂载 (`/root/xxx`) | 用相对路径 `./data` |
| ghcr.io 超时 | 改用 `ghcr.nju.edu.cn` 加速 |
| 不能本地上传镜像 tar | 直接用远程镜像 |
| 不能 SSH | 全靠 Web 界面 + 文件管理 |
| Compose 点"开启"无反应/超时 | 镜像在后台拉取，等 3-5 分钟刷新容器列表 |

## API 接口清单

### 对外使用（播放器 / 电视 / 其他项目）

| 接口 | 方法 | 说明 |
|------|------|------|
| `/iptv2026.m3u` | GET | 固定映射标准 M3U |
| `/playlist/{id}.m3u` | GET | 自定义播放列表，如 `/playlist/1.m3u` |
| `/{channel_id}` | GET | 固定频道地址，**302 跳转**到实际播放 URL |

### 管理后台 / 管理 API

| 接口 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 管理后台页面 |
| `/api/status` | GET | 运行状态（最后更新时间、源数量等） |
| `/api/channels` | GET | 合并后的完整频道列表 |
| `/api/merged-channels` | GET | 同上，别名 |
| `/api/categories` | GET | 分类列表 |
| `/api/sources` | GET | 所有数据源 |
| `/api/source` | POST | 添加数据源 |
| `/api/source/{id}` | GET / PUT / DELETE | 查询 / 更新 / 删除单个数据源 |
| `/api/source/{id}/refresh` | POST | 手动刷新单个源 |
| `/api/refresh` | POST | 手动刷新所有数据源 |
| `/api/playlists` | GET | 所有播放列表 |
| `/api/playlist` | POST | 创建播放列表 |
| `/api/playlist/{id}` | GET / PUT / DELETE | 查询 / 更新 / 删除单个播放列表 |
| `/api/playlist/{id}/refresh` | POST | 手动刷新单个播放列表 |
| `/api/channel-mapping` | GET / POST | 查询 / 更新固定映射 |
| `/api/channel-mapping/batch-update` | POST | 批量更新固定映射 |
| `/api/channel-mapping/logs` | GET | 上传 / 推送日志 |
| `/api/clear-cache` | POST | 清理 Cache API 缓存 |

### API 鉴权

当前版本**已移除管理密码**，管理 API 完全开放。

如需恢复鉴权，在 `worker.js` 中恢复 `ADMIN_PATH_PATTERNS` + `X-Admin-Password` 头校验即可（原始逻辑保留在版本历史里）。

## 固定映射推送接口

供其他项目自动同步固定映射用（**无需鉴权头**）。

```
POST http://192.168.100.88:8787/api/channel-mapping
Content-Type: application/json
```

请求体：

```json
{
  "content": "#EXTM3U\n#EXTINF:-1 group-title=\"央视\" tvg-id=\"cctv1\",CCTV1\nhttp://192.168.100.1:4000/cctv1/index.m3u8\n",
  "pruneMissing": false
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `content` | 是 | 完整 M3U 文本 |
| `pruneMissing` | 否 | `true` = 全量同步（删除 M3U 中没有的旧映射）；`false` = 只增改不删（默认） |

响应：

```json
{ "success": true, "newChannels": 1, "updatedChannels": 0, "removedChannels": 0 }
```

curl 示例：

```bash
curl -X POST http://192.168.100.88:8787/api/channel-mapping \
  -H "Content-Type: application/json" \
  -d '{"content":"#EXTM3U\n...","pruneMissing":false}'
```

## 管理后台操作指南

### 数据源管理

- **添加源**：填名称 + URL + 优先级 + 刷新时间 → 添加
- **刷新时间**：格式 `HH:MM` 北京时间，多个用逗号分隔；默认 `05:00,17:00`
- **手动刷新**：某源挂了 / 想立即抓一次，点"更新"按钮
- **自动刷新时间**：每次后台更新数据后会写入 KV 防止重复；一天内同一分钟只会执行一次

### 频道管理

- 展示所有源合并后的频道列表
- 支持按分组过滤、关键词搜索
- 可全选 / 选中当前页后"从选中创建播放列表"

### 播放列表

- 顶部表格列出所有自定义列表及其刷新时间
- **播放列表 1** 是固定项，禁止删除，内容可编辑
- 编辑按钮打开左右栏可视化编辑器：从可用频道加到选中频道

### 固定映射

- **上传 M3U**：上传 `/iptv2026.m3u`，自动提取频道 ID 并更新映射
- **pruneMissing** 选项：勾选则全量同步（删除 M3U 里没有的旧频道）
- 映射列表支持修改频道名、删除选中、手动保存
- 上传日志显示最近 30 次变更记录

### 顶部工具

- **刷新数据**：手动触发 `refreshAllSources()`
- **清理缓存**：清空 Cloudflare Cache API（本地部署里是内存 Map）

## 数据迁移

### 方式一：从 Cloudflare KV 导出到本地

```powershell
# 项目根目录，需已安装 wrangler 并登录
node migrate-kv.js
```

自动从线上 KV 导出所有数据，写入本地 `data/sources_kv/` 和 `data/playlists_kv/`，同时生成 `data/kv-export.json` 备份。

### 方式二：从线上管理 API 抓取

```powershell
# 不走 wrangler，直接 HTTP
node migrate-kv.js http-dump https://iptv.sunwan523.workers.dev
```

### 方式三：从 JSON 备份恢复

```powershell
node migrate-kv.js import                  # 从默认 data/kv-export.json 恢复
node migrate-kv.js import 备份.json        # 指定备份文件
```

### 部署到 iStoreOS 时迁移数据

Windows 上本地已有数据的话，直接 scp 到路由器：

```powershell
scp -r d:\codex\iptv.mhtc.top\data\sources_kv root@192.168.100.88:/root/iptv-data/
scp -r d:\codex\iptv.mhtc.top\data\playlists_kv root@192.168.100.88:/root/iptv-data/
```

## 升级指南

### Cloudflare Workers

```powershell
git pull
wrangler deploy
```

### iStoreOS / 爱快（Docker 容器）

```bash
docker pull ghcr.io/sunwan523/iptv-local:latest
docker rm -f iptv-local
docker run -d --name iptv-local --restart always -p 8787:8787 \
  -v /root/iptv-data:/app/data ghcr.io/sunwan523/iptv-local:latest
```

数据在挂载目录 `/root/iptv-data`，升级不丢。

### 本机构建推送完整流程（代码修改后）

```powershell
# 1. 改代码，测试
node local-server.js

# 2. 推 git
git add -A ; git commit -m "..." ; git push

# 3. 部署 Cloudflare（可选）
npx wrangler deploy

# 4. 构建 Docker 多架构镜像并推送
docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/sunwan523/iptv-local:latest --push .

# 5. iStoreOS SSH 里：docker pull + rm + run
```

## 常见问题排查

| 现象 | 可能原因 | 解决方法 |
|------|---------|---------|
| 定时刷新不执行 | 容器没在跑 / 调度日志报错 | `docker ps` 看状态；`docker logs -f iptv-local` 看 `[定时检查]` 开头日志 |
| 管理界面"更新时间"不变 | 旧版本没写 updatedAt；新版本已修复 | 点手动刷新确认更新时间变化；旧数据升级后第一次自动刷新会写入 |
| 跨天后刷新不触发 | 用了 UTC 日期判断 | 已修复为北京时间；升级到最新代码 |
| 播放列表缓存不更新 | 硬编码 localhost 清理失败 | 已修复为尝试多个 origin；升级到最新代码 |
| 容器一直在重启 | 内存不足 / 挂载路径错 | 给 256MB 内存；挂载目标路径必须是 `/app/data` |
| docker pull 报 unauthorized | ghcr.io 鉴权 | `docker login ghcr.io`（用户名 + PAT）；或用南大镜像加速 |
| 局域网访问不了 | 容器网段与内网不可达 | 爱快：用端口映射；iStoreOS：检查防火墙 |
| URL 抓取超时 | 源站挂了 / 网络问题 | 管理后台手动刷新看报错；FETCH_TIMEOUT_MS 已设 15 秒 |
| 固定映射没自动更新 | M3U 里频道 URL 不符合 `/xxx/index.m3u8` 模式 | 手动上传或用推送接口 |
| 定时频率感觉太频繁 | 每 30 秒（本地）/ 每 5 分钟（CF）调度一次 | 这是"检查"而非"刷新"；真正刷新只有到了配置的时间点才执行 |

## 本地频道检测器

`local-checker/` 是一个零依赖 Node.js 工具，运行在 Windows 上，独立于主服务之外。

- 定时拉取播放列表 → 逐个探测频道（跟随 302 → 校验 M3U8 内容）
- 重点监控自建源：`192.168.100.1:4000`、`192.168.100.1:3000`
- 自建源故障时弹 Windows 桌面提醒 + 播提示音 + 写 `alerts.log`
- 可选开启外网频道故障提醒
- 内置 Web 看板（自建服务状态 / 频道状态 / 检测历史 / 提醒记录 / 设置）

### 使用

```powershell
# 启动（后台常驻 + 自动打开浏览器）
powershell -ExecutionPolicy Bypass -File local-checker/start.ps1

# 访问 http://127.0.0.1:8787（注意端口和主服务冲突的话改 config.json）

# 停止
powershell -ExecutionPolicy Bypass -File local-checker/stop.ps1

# 一次性检测（可放入 Windows 任务计划）
node local-checker/server.js --check-once
```

### 配置

`local-checker/config.json`：

| 字段 | 说明 |
|------|------|
| `checkIntervalSeconds` | 检测间隔，默认 300 秒 |
| `timeoutMs` | 单个频道超时，默认 15 秒 |
| `playlistUrls` | 要探测的播放列表 URL 列表 |
| `selfBuiltHosts` | 自建源主机名（故障时桌面提醒） |
| `alertOnAllFailures` | 是否外网故障也提醒 |

## 版本历史

- **2026-09-13 刷新机制重构**：每个源 / 播放列表独立配置刷新时间（默认源 05:00/17:00、列表 05:05/17:05）；修复 updatedAt 不写入、北京时间跨天判断错误、缓存清理硬编码 localhost 等 bug；scheduled handler 每 30 秒/5 分钟调度一次，逐项检查；Cloudflare wrangler.toml cron 改为 `*/5 * * * *`；Dockerfile 移除废弃 REFRESH_TIMES 环境变量
- **2026-08-30 iStoreOS 正式部署**：选定软路由 + Docker 方案，纯内网运行；去除管理密码验证；新增固定映射推送接口；ghcr.io 多架构镜像发布
- **2026-08-30 本地运行方案**：`local-server.js` 加载 worker.js、FileKV 模拟 KV、内存 Cache 模拟 Cloudflare Cache API；Dockerfile + build-image.ps1 + migrate-kv.js
- **2026-08-16 本地检测器**：新增 local-checker/ 子项目；播放列表 `1` 设为固定长期保留项
- **2026-08-07 v9**：后台鉴权、前端 HTML 注入修复、源 URL 安全校验、抓取超时重试、固定映射 pruneMissing、定时刷新、KV 容错
- **2026-07-06 v8**：固定映射编辑 / 删除、上传日志、缓存清理、固定映射源自动生成

## 许可证

本项目仅供学习和个人使用。
