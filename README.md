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
├── local-checker/ # 本地播放源检测器（Web 看板 + 桌面提醒）
└── README.md      # 本项目说明文件
```

## 版本历史

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
