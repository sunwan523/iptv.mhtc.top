#!/usr/bin/env node
// ============================================================
// local-server.js — 在爱快软路由（或任何 Node 18+ 环境）上本地运行 iptv.mhtc.top
//
// 原理：worker.js 是 Cloudflare Worker 脚本，只依赖少量 Cloudflare API。
// 本文件在 Node 里用"文件存储"模拟 KV、用"内存"模拟 Cache API，
// 然后把 worker.js 原封不动加载进来（逻辑 100% 复用，无需改动 worker.js）。
//
// 环境变量：
//   PORT          监听端口（默认 8787）
//   DATA_DIR      数据持久化目录（默认 ./data）
//   REFRESH_TIMES 定时刷新时间，北京时间 HH:MM，逗号分隔（默认 05:00,17:00，与 wrangler.toml 一致）
//
// 直接运行：node local-server.js
// 在爱快 Docker 中：见 README「在爱快软路由上本地运行」章节
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PORT = parseInt(process.env.PORT || '8787', 10);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const REFRESH_TIMES = (process.env.REFRESH_TIMES || '05:00,17:00')
    .split(',').map(s => s.trim()).filter(Boolean);

fs.mkdirSync(DATA_DIR, { recursive: true });

// ===================== KV 模拟（文件存储） =====================
// 实现 Cloudflare KV 的 get/put/delete/list 三个接口，数据落到磁盘 JSON 文件。
class FileKV {
    constructor(dir) {
        this.dir = dir;
        fs.mkdirSync(this.dir, { recursive: true });
    }

    _file(key) {
        // base64url 编码，避免特殊字符（含 "/"）导致路径问题
        return path.join(this.dir, Buffer.from(String(key)).toString('base64url'));
    }

    async get(key) {
        try {
            return fs.readFileSync(this._file(key), 'utf8');
        } catch {
            return null;
        }
    }

    async put(key, value) {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(this._file(key), String(value));
    }

    async delete(key) {
        try {
            fs.unlinkSync(this._file(key));
        } catch { /* 不存在则忽略 */ }
    }

    async list() {
        const keys = fs.readdirSync(this.dir)
            .map(f => ({ name: Buffer.from(f, 'base64url').toString('utf8') }));
        return { keys };
    }
}

// ===================== Cache API 模拟（内存） =====================
// worker.js 用 caches.default 缓存播放列表 M3U，本地用内存 Map 代替。
const cacheMap = new Map();

function cacheUrl(req) {
    return typeof req === 'string' ? req : req.url;
}

const caches = {
    default: {
        async match(req) {
            const entry = cacheMap.get(cacheUrl(req));
            if (!entry) return undefined;
            return new Response(entry.body, { status: entry.status, headers: entry.headers });
        },
        async put(req, response) {
            const body = await response.text();
            const headers = {};
            response.headers.forEach((v, k) => { headers[k] = v; });
            cacheMap.set(cacheUrl(req), { body, status: response.status, headers });
        },
        async delete(req) {
            return cacheMap.delete(cacheUrl(req));
        }
    }
};

// 挂到全局，worker.js 里直接引用这些名字
globalThis.SOURCES_KV = new FileKV(path.join(DATA_DIR, 'sources_kv'));
globalThis.PLAYLISTS_KV = new FileKV(path.join(DATA_DIR, 'playlists_kv'));
globalThis.caches = caches;

// ===================== 加载 worker.js =====================
// 拦截 addEventListener，捕获 fetch / scheduled 两个事件处理函数
const handlers = {};
globalThis.addEventListener = (type, fn) => { handlers[type] = fn; };

const workerSrc = fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8');
vm.runInThisContext(workerSrc, { filename: 'worker.js' });

const fetchHandler = handlers['fetch'];
const scheduledHandler = handlers['scheduled'];

if (!fetchHandler) {
    console.error('错误：worker.js 中未找到 fetch 事件处理函数');
    process.exit(1);
}

// ===================== HTTP 服务 =====================
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

const server = http.createServer(async (req, res) => {
    try {
        const url = 'http://' + (req.headers.host || '127.0.0.1') + req.url;

        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) {
            if (v !== undefined) headers[k] = v;
        }

        let body;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            body = (await readBody(req)).toString('utf8');
        }

        const request = new Request(url, { method: req.method, headers, body, redirect: 'manual' });

        const event = {
            request,
            respondWith(p) { this._response = p; },
            waitUntil() { /* 本地无需保持后台任务存活 */ }
        };

        fetchHandler(event);
        const response = await event._response;

        const respHeaders = {};
        response.headers.forEach((v, k) => { respHeaders[k] = v; });
        res.writeHead(response.status, respHeaders);

        if (req.method === 'HEAD') {
            res.end();
        } else {
            res.end(Buffer.from(await response.arrayBuffer()));
        }
    } catch (err) {
        console.error('请求处理出错:', err);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        res.end('Internal Server Error: ' + (err.message || err));
    }
});

// ===================== 定时刷新（北京时间） =====================
const lastRun = new Map(); // "HH:MM" -> 上次执行的日期（YYYY-MM-DD）

function beijingNow() {
    const d = new Date();
    return {
        date: d.toISOString().slice(0, 10),
        hour: (d.getUTCHours() + 8) % 24,
        minute: d.getUTCMinutes()
    };
}

function runScheduledIfDue() {
    const now = beijingNow();
    for (const t of REFRESH_TIMES) {
        const [h, m] = t.split(':').map(Number);
        if (now.hour === h && now.minute === m && lastRun.get(t) !== now.date) {
            lastRun.set(t, now.date);
            console.log(`[${new Date().toISOString()}] 触发定时刷新 ${t}（北京时间）`);
            if (scheduledHandler) {
                const ev = {
                    type: 'scheduled',
                    waitUntil(p) {
                        if (p && p.catch) p.catch(err => console.error('定时刷新失败:', err));
                    }
                };
                try {
                    scheduledHandler(ev);
                } catch (err) {
                    console.error('定时刷新异常:', err);
                }
            }
        }
    }
}

server.listen(PORT, '0.0.0.0', () => {
    console.log('==============================================');
    console.log('IPTV 本地服务已启动');
    console.log(`  访问地址 : http://<路由器IP>:${PORT}`);
    console.log(`  数据目录 : ${DATA_DIR}`);
    console.log(`  定时刷新 : ${REFRESH_TIMES.join(', ')}（北京时间）`);
    console.log('==============================================');
});

setInterval(runScheduledIfDue, 30000);

// 优雅退出
process.on('SIGINT', () => { console.log('正在退出...'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { console.log('正在退出...'); server.close(() => process.exit(0)); });
