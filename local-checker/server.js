'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = process.env.IPTV_CHECKER_CONFIG ? path.resolve(process.env.IPTV_CHECKER_CONFIG) : path.join(ROOT, 'config.json');
const STATE_PATH = process.env.IPTV_CHECKER_STATE ? path.resolve(process.env.IPTV_CHECKER_STATE) : path.join(ROOT, 'state.json');
const ALERT_LOG_PATH = path.join(ROOT, 'alerts.log');
const NO_NOTIFY = process.env.IPTV_CHECKER_NO_NOTIFY === '1';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function defaultConfig() {
    return {
        port: 8787,
        checkIntervalSeconds: 300,
        timeoutMs: 15000,
        concurrency: 6,
        openBrowserOnStart: true,
        enableNotifications: true,
        alertOnAllFailures: false,
        reAlertMinutes: 30,
        playlistUrls: [],
        selfBuiltHosts: [],
        baseEndpoints: []
    };
}

function loadJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

function clampInt(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, Math.round(n)));
}

function loadConfig() {
    const cfg = Object.assign(defaultConfig(), loadJson(CONFIG_PATH, {}));
    cfg.port = clampInt(cfg.port, 1024, 65535);
    cfg.checkIntervalSeconds = clampInt(cfg.checkIntervalSeconds, 30, 86400);
    cfg.timeoutMs = clampInt(cfg.timeoutMs, 3000, 60000);
    cfg.concurrency = clampInt(cfg.concurrency, 1, 50);
    cfg.reAlertMinutes = clampInt(cfg.reAlertMinutes, 1, 1440);
    cfg.enableNotifications = cfg.enableNotifications !== false;
    cfg.playlistUrls = Array.isArray(cfg.playlistUrls) ? cfg.playlistUrls.filter(Boolean) : [];
    cfg.selfBuiltHosts = Array.isArray(cfg.selfBuiltHosts) ? cfg.selfBuiltHosts.map(h => String(h).toLowerCase()).filter(Boolean) : [];
    cfg.baseEndpoints = Array.isArray(cfg.baseEndpoints) ? cfg.baseEndpoints.filter(Boolean) : [];
    return cfg;
}

let config = loadConfig();

function initialState() {
    return {
        startedAt: new Date().toISOString(),
        autoCheck: true,
        running: false,
        lastCheck: null,
        nextCheckAt: null,
        lastAlertAt: null,
        baseEndpoints: {},
        channels: [],
        playlistErrors: [],
        history: [],
        alerts: []
    };
}

function loadState() {
    const saved = loadJson(STATE_PATH, null);
    if (!saved || typeof saved !== 'object') return initialState();
    return Object.assign(initialState(), saved, {
        channels: Array.isArray(saved.channels) ? saved.channels : [],
        history: Array.isArray(saved.history) ? saved.history.slice(0, 100) : [],
        alerts: Array.isArray(saved.alerts) ? saved.alerts.slice(0, 50) : []
    });
}

let state = loadState();
let timer = null;
let httpServer = null;

function saveState() {
    try {
        fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {
        console.error('保存状态失败:', err.message || err);
    }
}

function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
    } catch (err) {
        console.error('保存配置失败:', err.message || err);
    }
}

function appendAlertLog(entry) {
    try {
        fs.appendFileSync(ALERT_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
        console.error('写入提醒日志失败:', err.message || err);
    }
}

function hostOf(url) {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return '';
    }
}

function isSelfBuiltUrl(url) {
    const host = hostOf(url);
    if (!host) return false;
    return config.selfBuiltHosts.some(h => host === h || host.endsWith('.' + h));
}

function parsePlaylist(content) {
    const channels = [];
    const lines = String(content || '').split(/\r?\n/);
    let current = null;
    let m3uMode = false;

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (/^#EXTM3U/i.test(line)) {
            m3uMode = true;
            continue;
        }
        if (/^#EXTINF:/i.test(line)) {
            current = { name: '', group: '未分类' };
            const groupMatch = line.match(/group-title=(?:"([^"]+)"|'([^']+)'|([^,\s]+))/i);
            if (groupMatch) current.group = groupMatch[1] || groupMatch[2] || groupMatch[3] || '未分类';
            const nameMatch = line.match(/,\s*([^,]+?)\s*$/);
            if (nameMatch) current.name = nameMatch[1].trim();
            continue;
        }
        if (/^https?:\/\//i.test(line)) {
            channels.push({
                name: (current && current.name) || line,
                url: line,
                group: (current && current.group) || '未分类'
            });
            current = null;
            continue;
        }
        if (!m3uMode && line.includes(',')) {
            const idx = line.indexOf(',');
            const name = line.slice(0, idx).trim();
            const url = line.slice(idx + 1).trim();
            if (name && /^https?:\/\//i.test(url)) {
                channels.push({ name, url, group: '未分类' });
            }
        }
    }
    return channels;
}

function timeoutSignal(ms) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), ms);
    if (typeof t.unref === 'function') t.unref();
    return controller.signal;
}

async function fetchText(url, timeoutMs) {
    const res = await fetch(url, {
        signal: timeoutSignal(timeoutMs),
        redirect: 'follow',
        headers: { 'User-Agent': UA, 'Accept': '*/*' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
}

async function probeUrl(url, timeoutMs) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            redirect: 'follow',
            headers: { 'User-Agent': UA, 'Accept': '*/*', 'Connection': 'close' }
        });
        const status = res.status;
        const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
        const finalUrl = res.url || url;
        let sample = '';
        if (res.body) {
            try {
                const reader = res.body.getReader();
                const chunk = await reader.read();
                if (chunk && !chunk.done && chunk.value) {
                    sample = Buffer.from(chunk.value).toString('utf8').slice(0, 2000);
                }
                try { await reader.cancel(); } catch { /* ignore */ }
            } catch { /* body read failed, status still matters */ }
        }

        let pathname = '';
        try { pathname = new URL(finalUrl).pathname.toLowerCase(); } catch { /* ignore */ }
        const isM3u8 = /\.m3u8(\?|$)/i.test(pathname)
            || /mpegurl|m3u8/i.test(contentType)
            || /^#EXTM3U/i.test(sample.trimStart());

        let ok = status >= 200 && status < 400;
        let error = null;
        if (ok) {
            if (isM3u8) {
                ok = /#EXTM3U|#EXTINF/i.test(sample);
                if (!ok) error = '不是有效的 M3U8 播放列表';
            } else if (!sample && Number(res.headers.get('content-length') || 0) === 0) {
                ok = false;
                error = '响应内容为空';
            }
        } else {
            error = 'HTTP ' + status;
        }

        return {
            ok,
            status,
            contentType,
            finalUrl,
            sample: sample.slice(0, 120),
            durationMs: Date.now() - started,
            error
        };
    } catch (err) {
        return {
            ok: false,
            status: null,
            contentType: '',
            finalUrl: url,
            sample: '',
            durationMs: Date.now() - started,
            error: err && err.name === 'AbortError' ? '请求超时' : (err && err.cause && err.cause.message) || (err && err.message) || '连接失败'
        };
    } finally {
        clearTimeout(timer);
    }
}

async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index], index);
        }
    }
    const workers = [];
    const size = Math.max(1, Math.min(limit || 6, items.length));
    for (let i = 0; i < size; i++) workers.push(worker());
    await Promise.all(workers);
    return results;
}

async function maybeAlert(report, prevStatusByUrl, prevBase) {
    const candidates = [];
    for (const ep of config.baseEndpoints || []) {
        const r = state.baseEndpoints[ep];
        if (r && !r.ok) {
            candidates.push({ type: 'base', title: ep, detail: r.error || '无法连接', url: ep });
        }
    }
    for (const ch of state.channels) {
        if (ch.status !== 'ok' && (config.alertOnAllFailures || ch.selfBuilt)) {
            candidates.push({ type: 'channel', title: ch.name || ch.url, detail: ch.error || '无法播放', url: ch.url, selfBuilt: !!ch.selfBuilt });
        }
    }
    if (candidates.length === 0) return;
    if (!config.enableNotifications) return;

    const now = Date.now();
    const lastAlertMs = state.lastAlertAt ? new Date(state.lastAlertAt).getTime() : 0;
    const reAlertMs = (config.reAlertMinutes || 30) * 60 * 1000;
    const isNew = candidates.some(c => {
        if (c.type === 'channel') {
            const prevStatus = prevStatusByUrl.get(c.url);
            return !prevStatus || prevStatus !== 'fail';
        }
        const prevOk = prevBase[c.url];
        return !prevOk || prevOk.ok !== false;
    });
    if (!isNew && now - lastAlertMs < reAlertMs) return;

    const lines = candidates.slice(0, 5).map(c => c.title + ' - ' + c.detail);
    if (candidates.length > 5) lines.push('另有 ' + (candidates.length - 5) + ' 个故障，详见本地检测页面');
    const message = lines.join('\n');
    notify('IPTV 播放源故障提醒', message);
    state.lastAlertAt = new Date().toISOString();
    const entry = {
        at: state.lastAlertAt,
        count: candidates.length,
        message,
        selfBuiltCount: candidates.filter(c => c.type === 'base' || c.selfBuilt).length
    };
    state.alerts.unshift(entry);
    state.alerts = state.alerts.slice(0, 50);
    appendAlertLog(entry);
}

function notify(title, message) {
    if (NO_NOTIFY || process.platform !== 'win32') {
        console.error('[' + title + ']\n' + message);
        return;
    }
    const script = path.join(ROOT, 'notify.ps1');
    try {
        const child = spawn('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-STA',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            script,
            '-Title',
            title,
            '-Message',
            message
        ], { windowsHide: true, stdio: 'ignore' });
        child.on('error', err => console.error('桌面提醒失败:', err.message || err));
        child.unref();
    } catch (err) {
        console.error('桌面提醒失败:', err.message || err);
    }
}

async function runCheck() {
    if (state.running) return { skipped: true };
    state.running = true;
    const startedMs = Date.now();
    const prevStatusByUrl = new Map(state.channels.map(c => [c.url, c.status]));
    const prevBase = Object.assign({}, state.baseEndpoints);
    saveState();

    try {
        const channelMap = new Map();
        const playlistErrors = [];
        for (const playlistUrl of config.playlistUrls || []) {
            try {
                const text = await fetchText(playlistUrl, config.timeoutMs);
                for (const ch of parsePlaylist(text)) {
                    if (!channelMap.has(ch.url)) {
                        channelMap.set(ch.url, {
                            name: ch.name,
                            url: ch.url,
                            group: ch.group,
                            source: playlistUrl,
                            selfBuilt: isSelfBuiltUrl(ch.url)
                        });
                    }
                }
            } catch (err) {
                playlistErrors.push(playlistUrl + ' - ' + ((err && err.message) || '获取播放列表失败'));
            }
        }

        const baseResults = {};
        await mapLimit(config.baseEndpoints || [], config.concurrency, async ep => {
            const r = await probeUrl(ep, config.timeoutMs);
            baseResults[ep] = {
                url: ep,
                ok: r.ok,
                status: r.status,
                error: r.error,
                finalUrl: r.finalUrl,
                durationMs: r.durationMs,
                checkedAt: new Date().toISOString()
            };
        });

        const now = new Date().toISOString();
        const targets = Array.from(channelMap.values());
        const prevChMap = new Map(state.channels.map(c => [c.url, c]));
        const results = await mapLimit(targets, config.concurrency, async ch => {
            const r = await probeUrl(ch.url, config.timeoutMs);
            const prevCh = prevChMap.get(ch.url) || {};
            const prevStreak = Number(prevCh.failureStreak) || 0;
            return Object.assign({}, ch, {
                status: r.ok ? 'ok' : 'fail',
                error: r.error,
                statusCode: r.status,
                finalUrl: r.finalUrl,
                contentType: r.contentType,
                durationMs: r.durationMs,
                lastCheckedAt: now,
                lastOkAt: r.ok ? now : (prevCh.lastOkAt || null),
                failureStreak: r.ok ? 0 : prevStreak + 1
            });
        });
        results.sort((a, b) => {
            const aFail = a.status === 'ok' ? 0 : 1;
            const bFail = b.status === 'ok' ? 0 : 1;
            if (aFail !== bFail) return bFail - aFail;
            if (a.selfBuilt !== b.selfBuilt) return a.selfBuilt ? -1 : 1;
            return String(a.name).localeCompare(String(b.name), 'zh-CN');
        });

        const failChannels = results.filter(c => c.status !== 'ok');
        const selfFailChannels = failChannels.filter(c => c.selfBuilt);
        const baseFailures = (config.baseEndpoints || []).filter(ep => baseResults[ep] && !baseResults[ep].ok);

        const report = {
            at: now,
            durationMs: Date.now() - startedMs,
            totalChannels: results.length,
            selfBuiltChannels: results.filter(c => c.selfBuilt).length,
            okCount: results.length - failChannels.length,
            failureCount: failChannels.length,
            selfBuiltFailureCount: selfFailChannels.length,
            baseFailureCount: baseFailures.length,
            playlistErrorCount: playlistErrors.length,
            baseFailures,
            selfBuiltFailures: selfFailChannels.map(c => ({ name: c.name, url: c.url, error: c.error })),
            failures: failChannels.slice(0, 30).map(c => ({ name: c.name, url: c.url, error: c.error })),
            playlistErrors
        };

        state.baseEndpoints = baseResults;
        state.channels = results;
        state.playlistErrors = playlistErrors;
        state.lastCheck = report;
        state.history.unshift(report);
        state.history = state.history.slice(0, 100);
        await maybeAlert(report, prevStatusByUrl, prevBase);
        saveState();
        return { skipped: false, report };
    } catch (err) {
        state.lastCheck = {
            at: new Date().toISOString(),
            error: err && err.message ? err.message : String(err)
        };
        saveState();
        return { skipped: false, error: err && err.message ? err.message : String(err) };
    } finally {
        state.running = false;
        saveState();
    }
}

function scheduleNext() {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
    if (!state.autoCheck) {
        state.nextCheckAt = null;
        saveState();
        return;
    }
    const delayMs = Math.max(1000, (config.checkIntervalSeconds || 300) * 1000);
    state.nextCheckAt = new Date(Date.now() + delayMs).toISOString();
    saveState();
    timer = setTimeout(() => {
        timer = null;
        runCheck()
            .catch(err => console.error('定时检测失败:', err && err.message || err))
            .finally(scheduleNext);
    }, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
}

function publicState() {
    const activeBase = {};
    for (const ep of config.baseEndpoints || []) {
        if (state.baseEndpoints[ep]) activeBase[ep] = state.baseEndpoints[ep];
    }
    return {
        startedAt: state.startedAt,
        autoCheck: state.autoCheck,
        running: state.running,
        lastCheck: state.lastCheck,
        nextCheckAt: state.nextCheckAt,
        lastAlertAt: state.lastAlertAt,
        baseEndpoints: activeBase,
        channels: state.channels,
        playlistErrors: state.playlistErrors,
        history: state.history.slice(0, 20),
        alerts: state.alerts.slice(0, 20)
    };
}

function publicConfig() {
    return {
        checkIntervalSeconds: config.checkIntervalSeconds,
        timeoutMs: config.timeoutMs,
        concurrency: config.concurrency,
        openBrowserOnStart: config.openBrowserOnStart,
        enableNotifications: config.enableNotifications,
        alertOnAllFailures: config.alertOnAllFailures,
        reAlertMinutes: config.reAlertMinutes,
        playlistUrls: config.playlistUrls,
        selfBuiltHosts: config.selfBuiltHosts,
        baseEndpoints: config.baseEndpoints
    };
}

function sendJson(res, status, obj) {
    const body = JSON.stringify(obj, null, 2);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => {
            data += chunk;
            if (data.length > 1024 * 1024) {
                req.destroy();
                reject(new Error('请求体过大'));
            }
        });
        req.on('end', () => {
            try {
                resolve(data ? JSON.parse(data) : {});
            } catch (err) {
                reject(err);
            }
        });
        req.on('error', reject);
    });
}

function serveStatic(req, res, url) {
    const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (filePath !== path.join(PUBLIC_DIR, 'index.html') && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
        sendJson(res, 403, { success: false, error: '禁止访问' });
        return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon'
    }[ext] || 'application/octet-stream';
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not Found');
            return;
        }
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
        res.end(data);
    });
}

async function handleRequest(req, res) {
    let url;
    try {
        url = new URL(req.url, 'http://127.0.0.1');
    } catch {
        sendJson(res, 400, { success: false, error: '无效请求' });
        return;
    }
    const method = req.method;
    try {
        if (url.pathname === '/api/state' && method === 'GET') {
            sendJson(res, 200, { config: publicConfig(), state: publicState() });
            return;
        }
        if (url.pathname === '/api/check' && method === 'POST') {
            runCheck().catch(err => console.error('手动检测失败:', err && err.message || err));
            sendJson(res, 202, { success: true, message: '检测已开始' });
            return;
        }
        if (url.pathname === '/api/toggle' && method === 'POST') {
            const body = await readBody(req);
            state.autoCheck = body.autoCheck !== undefined ? Boolean(body.autoCheck) : !state.autoCheck;
            saveState();
            scheduleNext();
            sendJson(res, 200, { success: true, autoCheck: state.autoCheck });
            return;
        }
        if (url.pathname === '/api/config' && method === 'POST') {
            const body = await readBody(req);
            if (body.checkIntervalSeconds !== undefined) config.checkIntervalSeconds = clampInt(body.checkIntervalSeconds, 30, 86400);
            if (body.reAlertMinutes !== undefined) config.reAlertMinutes = clampInt(body.reAlertMinutes, 1, 1440);
            if (body.alertOnAllFailures !== undefined) config.alertOnAllFailures = Boolean(body.alertOnAllFailures);
            if (body.enableNotifications !== undefined) config.enableNotifications = Boolean(body.enableNotifications);
            saveConfig();
            saveState();
            scheduleNext();
            sendJson(res, 200, { success: true, config: publicConfig() });
            return;
        }
        if (url.pathname === '/api/shutdown' && method === 'POST') {
            sendJson(res, 200, { success: true, message: '检测器已退出' });
            state.autoCheck = false;
            state.running = false;
            saveState();
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            try {
                fs.unlinkSync(path.join(ROOT, 'server.pid'));
            } catch { /* ignore */ }
            setTimeout(() => {
                try { if (httpServer) httpServer.closeAllConnections(); } catch { /* ignore */ }
                try { if (httpServer) httpServer.close(); } catch { /* ignore */ }
                process.exitCode = 0;
                setTimeout(() => process.exit(0), 600);
            }, 200);
            return;
        }
        serveStatic(req, res, url);
    } catch (err) {
        sendJson(res, 500, { success: false, error: err && err.message ? err.message : String(err) });
    }
}

function openBrowser(url) {
    if (process.platform !== 'win32') return;
    try {
        const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
    } catch (err) {
        console.error('打开浏览器失败:', err && err.message || err);
    }
}

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.includes('--no-open')) config.openBrowserOnStart = false;
    if (args.includes('--check-once')) {
        runCheck().then(result => {
            console.log(JSON.stringify(result.skipped ? { skipped: true } : result.report || { error: result.error }, null, 2));
            process.exitCode = result.report || result.skipped ? 0 : 1;
        });
    } else {
        httpServer = http.createServer(handleRequest);
        httpServer.on('error', err => {
            console.error('检测器启动失败:', err && err.message || err);
            process.exitCode = 1;
        });
        httpServer.listen(config.port, '127.0.0.1', () => {
            const pageUrl = 'http://127.0.0.1:' + config.port;
            try {
                fs.writeFileSync(path.join(ROOT, 'server.pid'), String(process.pid), 'utf8');
            } catch (err) {
                console.error('写入 PID 文件失败:', err && err.message || err);
            }
            console.log('IPTV 播放源检测器已启动: ' + pageUrl);
            if (config.openBrowserOnStart) openBrowser(pageUrl);
            runCheck()
                .catch(err => console.error('首次检测失败:', err && err.message || err))
                .finally(scheduleNext);
        });
    }
}

module.exports = {
    parsePlaylist,
    probeUrl,
    isSelfBuiltUrl,
    runCheck,
    loadConfig
};
