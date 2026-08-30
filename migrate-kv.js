#!/usr/bin/env node
// ============================================================
// migrate-kv.js — 把 Cloudflare KV 中的数据迁移到本地文件存储
// （数据目录格式与 local-server.js 的 FileKV 完全一致）
//
// 用法（在项目根目录、且已安装并登录 wrangler 的前提下）：
//   node migrate-kv.js                # 从 Cloudflare KV 导出并写入本地 data 目录，同时生成 JSON 备份
//   node migrate-kv.js export         # 同上
//   node migrate-kv.js export 备份.json # 指定 JSON 备份文件路径（默认 data/kv-export.json）
//   node migrate-kv.js import         # 从默认 data/kv-export.json 恢复到本地数据目录
//   node migrate-kv.js import 备份.json [数据目录]
//
// 环境变量：DATA_DIR（默认 ./data）
//
// 导出后把 data 目录下的 sources_kv / playlists_kv 两个文件夹
// 复制到路由器 Docker 的挂载目录（容器内 /app/data）即可生效。
// ============================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const BINDINGS = ['SOURCES_KV', 'PLAYLISTS_KV']; // 与 wrangler.toml 中的绑定名一致

// 与 local-server.js 中 FileKV 的文件名编码保持一致
function encodeKey(key) {
    return Buffer.from(String(key)).toString('base64url');
}

function kvDir(binding) {
    return path.join(DATA_DIR, binding.toLowerCase());
}

// 在 PATH 中定位 wrangler 的真实 JS 入口（Windows 的 wrangler.cmd 只是个 shim，
// execFile/spawn 无法直接运行 .cmd，这里解析 shim 拿到 node_modules 里的真实入口，绕过 shell）
function resolveWranglerJs() {
    const pathEnv = (process.env.PATH || '').split(path.delimiter);
    for (const dir of pathEnv) {
        if (!dir) continue;
        const cmdFile = path.join(dir.trim(), 'wrangler.cmd');
        if (!fs.existsSync(cmdFile)) continue;
        try {
            const content = fs.readFileSync(cmdFile, 'utf8');
            const m = content.match(/node_modules[\\/][^"%]+?\.js/);
            if (m) return path.resolve(dir.trim(), m[0]);
        } catch { /* 继续 */ }
        return null; // 找到了 cmd 但解析失败
    }
    return null;
}

// 执行 wrangler 命令（args 数组直接传参，不经 shell，避免特殊字符被解释）
function runWrangler(args) {
    const opts = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
    try {
        if (process.platform === 'win32') {
            // 优先：node + wrangler.js 入口
            const js = resolveWranglerJs();
            if (js) return execFileSync(process.execPath, [js, ...args], opts);
            // 回退：通过 cmd.exe 执行（本项目的 KV 键名均为安全字符，不含空格/引号）
            const quoted = args.map(a => '"' + String(a).replace(/"/g, '""') + '"').join(' ');
            return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `wrangler ${quoted}`], opts);
        }
        return execFileSync('wrangler', args, opts);
    } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'EINVAL') {
            throw new Error('未找到 wrangler 命令，请先执行：npm i -g wrangler && wrangler login（并确认已登录）');
        }
        const detail = (err.stderr || err.stdout || err.message || '').toString().slice(0, 500);
        throw new Error(`wrangler 执行失败：${detail}`);
    }
}

// ===== 从 Cloudflare KV 全量导出 =====
function exportFromCloudflare() {
    const data = { exportedAt: new Date().toISOString() };

    for (const binding of BINDINGS) {
        console.log(`>>> 正在导出 ${binding} ...`);
        const entries = {};
        let cursor;
        let page = 0;

        do {
            const args = ['kv', 'key', 'list', '--binding', binding, '--json'];
            if (cursor) args.push('--cursor', cursor);

            let parsed;
            try {
                parsed = JSON.parse(runWrangler(args));
            } catch (err) {
                throw new Error(`导出 ${binding} 失败：${err.message}`);
            }

            // 兼容 wrangler 不同版本的返回格式（数组 或 {keys, list_complete, cursor}）
            const keys = Array.isArray(parsed) ? parsed : (parsed.keys || []);
            const listComplete = Array.isArray(parsed) ? true : !!parsed.list_complete;
            cursor = (!Array.isArray(parsed) && parsed.cursor) || undefined;

            for (const k of keys) {
                const keyName = typeof k === 'string' ? k : k.name;
                try {
                    const value = runWrangler(['kv', 'key', 'get', '--binding', binding, keyName]);
                    entries[keyName] = value;
                } catch (err) {
                    console.error(`  跳过键 "${keyName}"（读取失败：${err.message}）`);
                }
            }

            page++;
            if (!listComplete && cursor) {
                console.log(`  （第 ${page} 页完成，继续下一页...）`);
            }
        } while (cursor);

        data[binding] = entries;
        console.log(`  ${binding} 共导出 ${Object.keys(entries).length} 个键`);
    }

    return data;
}

// ===== 写入本地数据目录（FileKV 格式） =====
function writeLocal(data) {
    for (const binding of BINDINGS) {
        const entries = data[binding];
        if (!entries) continue;
        const dir = kvDir(binding);
        fs.mkdirSync(dir, { recursive: true });
        for (const [key, value] of Object.entries(entries)) {
            fs.writeFileSync(path.join(dir, encodeKey(key)), String(value));
        }
        console.log(`  ${binding} 写入 ${Object.keys(entries).length} 个键 → ${dir}`);
    }
}

// ===== 从 JSON 备份恢复 =====
function importFromJson(file) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    writeLocal(data);
}

// ===== 通过线上 Worker 的管理 API 抓取数据（不依赖 wrangler/KV 命名空间） =====
async function httpGetJson(baseUrl, apiPath, password) {
    const res = await fetch(baseUrl.replace(/\/+$/, '') + apiPath, {
        headers: {
            'X-Admin-Password': password,
            'Accept': 'application/json'
        }
    });
    if (!res.ok) throw new Error(`GET ${apiPath} 失败: HTTP ${res.status}`);
    return res.json();
}

async function exportFromHttp(baseUrl, password) {
    const data = { exportedAt: new Date().toISOString() };
    const SOURCES_KV = {};
    const PLAYLISTS_KV = {};

    // 数据源（每个源的 KV 值 = 源对象本身，含 content 内联 M3U）
    const srcRes = await httpGetJson(baseUrl, '/api/sources', password);
    const sources = srcRes.sources || [];
    for (const s of sources) SOURCES_KV[s.id] = JSON.stringify(s);
    console.log(`  数据源 ${sources.length} 个`);

    // 固定映射（chmap:{id} → {name,url,updatedAt}，以及 chmap:_list）
    const mapRes = await httpGetJson(baseUrl, '/api/channel-mapping', password);
    const mappings = mapRes.mappings || [];
    for (const m of mappings) {
        SOURCES_KV['chmap:' + m.id] = JSON.stringify({ name: m.name, url: m.url, updatedAt: m.updatedAt });
    }
    SOURCES_KV['chmap:_list'] = JSON.stringify(mappings.map(m => m.id));
    console.log(`  固定映射 ${mappings.length} 个`);

    // 上传日志（chmap:_logs）
    try {
        const logRes = await httpGetJson(baseUrl, '/api/channel-mapping/logs', password);
        if (logRes.logs) SOURCES_KV['chmap:_logs'] = JSON.stringify(logRes.logs);
        console.log(`  上传日志 ${(logRes.logs || []).length} 条`);
    } catch (e) {
        console.log('  上传日志获取失败（忽略）:', e.message);
    }

    // 播放列表（每个列表的 KV 值 = {name,urls,channelCount,createdAt,updatedAt}）
    const plRes = await httpGetJson(baseUrl, '/api/playlists', password);
    const plMeta = plRes.playlists || [];
    for (const p of plMeta) {
        try {
            const detail = await httpGetJson(baseUrl, '/api/playlist/' + encodeURIComponent(p.id), password);
            PLAYLISTS_KV[p.id] = JSON.stringify({
                name: detail.name,
                urls: detail.urls || [],
                channelCount: detail.channelCount || (detail.urls || []).length,
                createdAt: detail.createdAt,
                updatedAt: p.updatedAt || detail.createdAt
            });
        } catch (e) {
            console.log(`  播放列表 ${p.id} 详情获取失败（忽略）:`, e.message);
        }
    }
    console.log(`  播放列表 ${Object.keys(PLAYLISTS_KV).length} 个`);

    data.SOURCES_KV = SOURCES_KV;
    data.PLAYLISTS_KV = PLAYLISTS_KV;
    return data;
}

// ===== 入口 =====
async function main() {
    const mode = process.argv[2] || 'export';

    if (mode === 'export') {
        const backupFile = path.resolve(process.argv[3] || path.join(DATA_DIR, 'kv-export.json'));

        console.log('>>> 开始从 Cloudflare KV 导出...');
        const data = exportFromCloudflare();

        console.log('>>> 写入本地数据目录...');
        writeLocal(data);

        fs.mkdirSync(path.dirname(backupFile), { recursive: true });
        fs.writeFileSync(backupFile, JSON.stringify(data, null, 2));
        console.log(`>>> JSON 备份已保存：${backupFile}`);
        console.log('');
        console.log('完成！请将以下两个文件夹复制到路由器 Docker 挂载目录（容器内 /app/data）：');
        console.log(`  ${kvDir('SOURCES_KV')}`);
        console.log(`  ${kvDir('PLAYLISTS_KV')}`);
    } else if (mode === 'import') {
        const file = path.resolve(process.argv[3] || path.join(DATA_DIR, 'kv-export.json'));
        if (process.argv[4]) DATA_DIR = path.resolve(process.argv[4]);
        console.log(`>>> 从 ${file} 恢复到本地数据目录 ${DATA_DIR} ...`);
        importFromJson(file);
        console.log('>>> 恢复完成');
    } else if (mode === 'http-dump') {
        const baseUrl = process.argv[3];
        const password = process.argv[4];
        if (!baseUrl || !password) {
            console.error('用法：node migrate-kv.js http-dump <线上地址> <管理密码> [备份.json]');
            process.exit(1);
        }
        const backupFile = path.resolve(process.argv[5] || path.join(DATA_DIR, 'kv-export.json'));
        console.log(`>>> 从 ${baseUrl} 抓取数据（线上管理 API）...`);
        const data = await exportFromHttp(baseUrl, password);
        console.log('>>> 写入本地数据目录...');
        writeLocal(data);
        fs.mkdirSync(path.dirname(backupFile), { recursive: true });
        fs.writeFileSync(backupFile, JSON.stringify(data, null, 2));
        console.log(`>>> JSON 备份已保存：${backupFile}`);
        console.log('完成！请将以下两个文件夹复制到路由器 Docker 挂载目录（容器内 /app/data）：');
        console.log(`  ${kvDir('SOURCES_KV')}`);
        console.log(`  ${kvDir('PLAYLISTS_KV')}`);
    } else {
        console.error('用法：');
        console.error('  node migrate-kv.js                    # 从 Cloudflare KV 导出到本地');
        console.error('  node migrate-kv.js export [备份.json]');
        console.error('  node migrate-kv.js import [备份.json] [数据目录]');
        console.error('  node migrate-kv.js http-dump <线上地址> <管理密码>   # 从线上管理 API 抓取');
        process.exit(1);
    }
}

main().catch(err => {
    console.error('迁移失败：', err.message || err);
    process.exit(1);
});
