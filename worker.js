// 配置
const CONFIG = {
    VERSION: '20260807-v9',
    GROUP_NAME: '梦回唐朝',
    PROTECTED_PLAYLISTS: ['1'],
    FETCH_TIMEOUT_MS: 15000,
    MAX_SOURCE_BYTES: 2 * 1024 * 1024,
    URL_REPLACEMENTS: [
        { from: 'p.mhtc.top', to: '192.168.100.1' }
    ],
    DEFAULT_SOURCES: []
};

// 内存缓存（初始化时包含示例数据）
let cacheData = {
    channels: [],
    categories: [],
    lastUpdated: null
};

// URL 替换函数
function replaceUrl(url) {
    CONFIG.URL_REPLACEMENTS.forEach(replace => {
        url = url.replaceAll(replace.from, replace.to);
    });
    return url;
}

// 从 URL 中提取频道 ID（匹配 /{channel_id}/index.m3u8 模式）
function extractChannelId(url) {
    const m = url.match(/\/([^\/?#]+)\/index\.m3u8/i);
    return m ? m[1] : null;
}

// ===== 频道固定映射管理（映射ID → 实际播放地址） =====
const CHMAP_PREFIX = 'chmap:';

async function getChannelMapping(channelId) {
    try {
        if (!SOURCES_KV) return null;
        const data = await SOURCES_KV.get(CHMAP_PREFIX + channelId);
        return data ? JSON.parse(data) : null;
    } catch { return null; }
}

async function saveChannelMapping(channelId, channelName, url) {
    await SOURCES_KV.put(CHMAP_PREFIX + channelId, JSON.stringify({
        name: channelName,
        url: url,
        updatedAt: new Date().toISOString()
    }));
}

async function getAllChannelIds() {
    try {
        if (!SOURCES_KV) return [];
        const data = await SOURCES_KV.get(CHMAP_PREFIX + '_list');
        return data ? JSON.parse(data) : [];
    } catch { return []; }
}

async function saveAllChannelIds(ids) {
    await SOURCES_KV.put(CHMAP_PREFIX + '_list', JSON.stringify(ids));
}

// ===== 上传日志 =====
const MAX_LOGS = 30;

async function getUploadLogs() {
    try {
        if (!SOURCES_KV) return [];
        const data = await SOURCES_KV.get(CHMAP_PREFIX + '_logs');
        return data ? JSON.parse(data) : [];
    } catch { return []; }
}

async function addUploadLog(entry) {
    const logs = await getUploadLogs();
    logs.unshift({
        time: new Date().toISOString(),
        total: entry.total || 0,
        new: entry.new || 0,
        updated: entry.updated || 0,
        removed: entry.removed || 0,
        success: entry.success !== false,
        error: entry.error || null
    });
    // 只保留最近的 MAX_LOGS 条
    if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
    await SOURCES_KV.put(CHMAP_PREFIX + '_logs', JSON.stringify(logs));
}

// M3U 解析
function parseM3U(content, sourcePriority = 1) {
    const channels = [];
    const lines = content.split('\n');
    let cur = null;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === '#EXTM3U') continue;
        
        if (trimmed.startsWith('#EXTINF:')) {
            cur = { name: '', group: '未分类', tvgId: '', tvgLogo: '', tvgName: '', priority: sourcePriority };
            let m;
            // 增强版 group-title 匹配：支持双引号、单引号、无引号
            m = trimmed.match(/group-title=(?:"([^"]+)"|'([^']+)'|([^,\s]+))/);
            if (m) cur.group = (m[1] || m[2] || m[3]) || '未分类';
            m = trimmed.match(/tvg-id="([^"]*)"/);
            if (m) cur.tvgId = m[1];
            // 增强版 tvg-logo 匹配：支持双引号、单引号、无引号
            m = trimmed.match(/tvg-logo=(?:"([^"]+)"|'([^']+)'|([^,\s]+))/);
            if (m) cur.tvgLogo = m[1] || m[2] || m[3] || '';
            m = trimmed.match(/tvg-name="([^"]*)"/);
            if (m) cur.tvgName = m[1];
            m = trimmed.match(/,([^,]+)$/);
            if (m) cur.name = m[1].trim();
            // 自动补全台标
            if (!cur.tvgLogo && cur.name) {
                cur.tvgLogo = `https://epg.112114.xyz/logo/${encodeURIComponent(cur.name)}.png`;
            }
        } else if ((trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('rtmp://')) && cur) {
            cur.url = replaceUrl(trimmed);
            channels.push(cur);
            cur = null;
        }
    }
    return channels;
}

// TXT 格式解析（支持 #genre# 分类标记）
// 格式：频道名,#genre# 或 频道名,url
function parseTXT(content, sourcePriority = 1) {
    const channels = [];
    const lines = content.split('\n');
    let currentGroup = '未分类';
    
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        // 处理分类标记：频道名,#genre#
        if (trimmed.includes(',#genre#')) {
            currentGroup = trimmed.split(',')[0].trim();
            continue;
        }
        
        // 处理频道行：频道名,url
        if (trimmed.includes(',')) {
            const idx = trimmed.indexOf(',');
            const name = trimmed.substring(0, idx).trim();
            const url = trimmed.substring(idx + 1).trim();
            
            if (name && !name.includes('=') && (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('rtmp://'))) {
                channels.push({
                    name: name,
                    url: replaceUrl(url),
                    group: currentGroup,
                    priority: sourcePriority,
                    tvgId: '',
                    tvgLogo: '',
                    tvgName: ''
                });
            }
        }
    }
    
    return channels;
}

// 自动检测内容格式并解析
function parseSourceContent(content, sourcePriority = 1) {
    // 检测是否为 M3U 格式
    const isM3u = content.includes('#EXTM3U') || content.includes('#EXTINF:');
    if (isM3u) {
        return parseM3U(content, sourcePriority);
    }
    // TXT 格式
    return parseTXT(content, sourcePriority);
}

// 获取分类
function getCategories(channels) {
    const cats = new Set();
    channels.forEach(ch => cats.add(ch.group));
    return Array.from(cats).sort();
}

// 频道名称标准化（智能匹配主频道，区分子频道）
function getChannelKey(name) {
    if (!name) return '';
    var lower = name.toLowerCase();

    // 提取基础标识（字母数字+加号，如 cctv5、cctv5+）
    var baseMatch = lower.match(/[a-z]+[0-9]+\+?/);
    var base = baseMatch ? baseMatch[0] : '';

    // 没有字母数字前缀时，用全名去标点+去后缀比较
    if (!base) {
        var cleaned = lower.replace(/[\s\-_\.:：,，、()（）【】\[\]{}「」"「」\+]+/g, '');
        cleaned = cleaned.replace(/(hd|高清|标清|超清|4k|8k|版)$/i, '');
        return cleaned;
    }

    // 提取中文描述部分
    var desc = lower.replace(/[a-z0-9\+\s\-_\.:：,，、()（）【】\[\]{}「」"「」]+/g, '');

    // 子频道关键词（包含这些词的是独立子频道，不与主频道合并）
    var subChannelKeywords = [
        '欧洲', '美洲', '非洲', '亚太', '东南亚', '南亚', '中东',
        '阿拉伯', '西班牙', '法国', '俄国', '俄罗斯',
        '英语', '外语'
    ];
    var isSubChannel = subChannelKeywords.some(function (kw) {
        return desc.indexOf(kw) !== -1;
    });

    if (isSubChannel) {
        return base + '_' + desc;
    } else {
        return base;
    }
}

// 合并去重（支持优先级）
function mergeChannels(results) {
    const seenUrl = new Map(); // url -> channel
    const urlOrder = []; // maintain insertion order
    
    for (const result of results) {
        for (const ch of result) {
            if (seenUrl.has(ch.url)) continue;
            seenUrl.set(ch.url, ch);
            urlOrder.push(ch);
        }
    }
    return urlOrder;
}

function escapeM3UAttr(value) {
    return String(value == null ? '' : value).replace(/[\r\n"]/g, '');
}

function escapeM3UName(value) {
    return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').replace(/,/g, '，');
}

// 生成 M3U（同名频道合并多个源，按优先级排序）
// baseUrl 可选，指定后会将有固定映射的频道地址转为跳转链接
async function genM3U(channels, baseUrl) {
    // 预加载所有固定映射 ID，用于将实地址转为跳转地址
    const mappingIdSet = new Set(baseUrl ? await getAllChannelIds() : []);
    
    function toOutputUrl(url) {
        if (!baseUrl) return url;
        const cid = extractChannelId(url);
        if (cid && mappingIdSet.has(cid)) {
            return `${baseUrl}/${cid}`;
        }
        return url;
    }
    
    let m3u = '#EXTM3U\n';
    const grouped = new Map(); // key -> { info, urls: [] }
    for (const ch of channels) {
        const key = getChannelKey(ch.name);
        if (!grouped.has(key)) {
            grouped.set(key, {
                name: ch.name,
                group: ch.group,
                tvgId: ch.tvgId || '',
                tvgLogo: ch.tvgLogo || '',
                tvgName: ch.tvgName || '',
                urls: []
            });
        }
        grouped.get(key).urls.push(toOutputUrl(ch.url));
    }
    for (const ch of grouped.values()) {
        m3u += '#EXTINF:-1';
        if (ch.tvgId) m3u += ` tvg-id="${escapeM3UAttr(ch.tvgId)}"`;
        if (ch.tvgLogo) m3u += ` tvg-logo="${escapeM3UAttr(ch.tvgLogo)}"`;
        if (ch.tvgName) m3u += ` tvg-name="${escapeM3UAttr(ch.tvgName)}"`;
        m3u += ` group-title="${escapeM3UAttr(CONFIG.GROUP_NAME)}"`;
        m3u += ',' + escapeM3UName(ch.name) + '\n';
        for (const url of ch.urls) {
            m3u += url + '\n';
        }
    }
    return m3u;
}

// 过滤频道
function filterChannels(channels, query) {
    let result = [...channels];
    if (query.group) {
        const groups = Array.isArray(query.group) ? query.group : query.group.split(',');
        result = result.filter(ch => groups.includes(ch.group));
    }
    if (query.search) {
        const kw = query.search.toLowerCase();
        result = result.filter(ch => ch.name.toLowerCase().includes(kw));
    }
    return result;
}

// 构建合并后的频道组列表（前端展示用）
function buildMergedChannels() {
    const grouped = new Map();
    for (const ch of cacheData.channels) {
        const key = getChannelKey(ch.name);
        if (!grouped.has(key)) {
            grouped.set(key, {
                key: key,
                name: ch.name,
                group: ch.group,
                tvgId: ch.tvgId || '',
                tvgLogo: ch.tvgLogo || '',
                tvgName: ch.tvgName || '',
                urlCount: 0,
                urls: []
            });
        }
        const g = grouped.get(key);
        g.urls.push(ch.url);
        g.urlCount++;
    }
    return Array.from(grouped.values());
}

// ===== 数据源管理 =====
async function getSources() {
    try {
        if (!SOURCES_KV) {
            console.warn('SOURCES_KV not available, using default sources');
            return CONFIG.DEFAULT_SOURCES.sort((a, b) => (a.priority || 99) - (b.priority || 99));
        }
        const list = await SOURCES_KV.list();
        const sources = [];
        for (const key of list.keys) {
            // 跳过频道映射的内部数据（以 chmap: 为前缀）
            if (key.name.startsWith(CHMAP_PREFIX)) continue;
            try {
                const data = await SOURCES_KV.get(key.name);
                if (data) {
                    const source = JSON.parse(data);
                    if (source.id === '_fixed_mapping' && source.priority !== 3) {
                        source.priority = 3;
                        await SOURCES_KV.put(key.name, JSON.stringify(source));
                    }
                    sources.push(source);
                }
            } catch (err) {
                console.error('跳过无效的数据源:', key.name, err.message || err);
            }
        }
        if (sources.length === 0) {
            for (const src of CONFIG.DEFAULT_SOURCES) {
                await SOURCES_KV.put(src.id, JSON.stringify(src));
                sources.push(src);
            }
        }
        return sources.sort((a, b) => (a.priority || 99) - (b.priority || 99));
    } catch (err) {
        console.error('getSources error:', err.message || err);
        return CONFIG.DEFAULT_SOURCES.sort((a, b) => (a.priority || 99) - (b.priority || 99));
    }
}

async function getSource(id) {
    try {
        const data = await SOURCES_KV.get(id);
        return data ? JSON.parse(data) : null;
    } catch {
        return null;
    }
}

async function saveSource(id, data) {
    await SOURCES_KV.put(id, JSON.stringify(data));
}

async function deleteSource(id) {
    await SOURCES_KV.delete(id);
}

function generateSourceId(name) {
    const base = (name || '').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase() || 'source';
    return base + '_' + Date.now();
}

// ===== 播放列表管理 =====
async function getPlaylists() {
    try {
        if (!PLAYLISTS_KV) {
            console.warn('PLAYLISTS_KV not available');
            return {};
        }
        const list = await PLAYLISTS_KV.list();
        const playlists = {};
        for (const key of list.keys) {
            try {
                const data = await PLAYLISTS_KV.get(key.name);
                if (data) {
                    playlists[key.name] = JSON.parse(data);
                }
            } catch (err) {
                console.error('跳过无效的播放列表:', key.name, err.message || err);
            }
        }
        return playlists;
    } catch (err) {
        console.error('getPlaylists error:', err.message || err);
        return {};
    }
}

async function getPlaylist(id) {
    try {
        if (!PLAYLISTS_KV) {
            return null;
        }
        const data = await PLAYLISTS_KV.get(id);
        return data ? JSON.parse(data) : null;
    } catch (err) {
        console.error('getPlaylist error:', err.message || err);
        return null;
    }
}

async function savePlaylist(id, data) {
    try {
        if (!PLAYLISTS_KV) {
            console.error('PLAYLISTS_KV not available, cannot save playlist');
            throw new Error('播放列表存储不可用');
        }
        await PLAYLISTS_KV.put(id, JSON.stringify(data));
    } catch (err) {
        console.error('savePlaylist error:', err.message || err);
        throw err;
    }
}

async function deletePlaylist(id) {
    try {
        if (!PLAYLISTS_KV) {
            console.error('PLAYLISTS_KV not available, cannot delete playlist');
            throw new Error('播放列表存储不可用');
        }
        await PLAYLISTS_KV.delete(id);
    } catch (err) {
        console.error('deletePlaylist error:', err.message || err);
        throw err;
    }
}

// 固定播放列表：长期保留，不允许删除或修改
function isProtectedPlaylist(id, pl) {
    const protectedIds = Array.isArray(CONFIG.PROTECTED_PLAYLISTS) ? CONFIG.PROTECTED_PLAYLISTS : [];
    if (protectedIds.includes(id)) return true;
    const name = pl && pl.name;
    return name ? protectedIds.includes(name) : false;
}

function playlistProtectedError() {
    return new Response(JSON.stringify({ success: false, error: '固定播放列表不允许删除' }, null, 2), {
        status: 403,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
}

// 使指定播放列表的 M3U 缓存失效（与 /playlist/{id}.m3u 的 Cache API 配套使用）
// origin 用当前请求的 origin，保证与缓存时使用的 Cache Key（scheme + hostname + pathname）一致
async function invalidatePlaylistCache(origin, plId) {
    try {
        await caches.default.delete(new Request(origin + '/playlist/' + plId + '.m3u'));
    } catch (err) {
        console.warn('invalidate playlist cache failed:', err.message || err);
    }
}

async function generatePlaylistId(name) {
    const base = (name || '').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_') || 'playlist';
    const cleanBase = base.replace(/_+/g, '_').replace(/^_|_$/g, '');
    const pl = await getPlaylist(cleanBase);
    if (!pl) return cleanBase;
    let counter = 1;
    while (await getPlaylist(cleanBase + '_' + counter)) counter++;
    return cleanBase + '_' + counter;
}

// 重新匹配播放列表频道（数据源刷新后调用）
async function rematchPlaylist(plId, pl) {
    const oldUrls = new Set(pl.urls || []);
    const channelKeys = new Set();
    for (const url of oldUrls) {
        const ch = cacheData.channels.find(c => c.url === url);
        if (ch) {
            channelKeys.add(getChannelKey(ch.name));
        }
    }
    if (channelKeys.size === 0 && oldUrls.size > 0) {
        for (const url of oldUrls) {
            channelKeys.add(url);
        }
    }
    const newUrls = new Set();
    for (const ch of cacheData.channels) {
        if (channelKeys.has(getChannelKey(ch.name)) || channelKeys.has(ch.url)) {
            newUrls.add(ch.url);
        }
    }
    pl.urls = Array.from(newUrls);
    pl.channelCount = pl.urls.length;
    pl.updatedAt = new Date().toISOString();
    await savePlaylist(plId, pl);
    return {
        oldCount: oldUrls.size,
        newCount: pl.channelCount,
        addedCount: pl.channelCount - oldUrls.size
    };
}

// 刷新所有播放列表
async function refreshAllPlaylists() {
    const playlists = await getPlaylists();
    const results = [];
    for (const [id, pl] of Object.entries(playlists)) {
        try {
            const r = await rematchPlaylist(id, pl);
            results.push({ id, name: pl.name, protected: isProtectedPlaylist(id, pl), oldCount: r.oldCount, newCount: r.newCount, addedCount: r.addedCount });
        } catch (err) {
            results.push({ id, name: pl.name, protected: isProtectedPlaylist(id, pl), error: err.message || String(err) });
        }
    }
    return results;
}

// ===== 数据源抓取 =====
function ipv4ToInt(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    return ((parts[0] * 16777216) + (parts[1] * 65536) + (parts[2] * 256) + parts[3]) >>> 0;
}

function inCidr(ipInt, base, mask) {
    return ((ipInt & mask) >>> 0) === (base >>> 0);
}

function isUnsafeHostname(hostname) {
    const host = hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host === 'metadata.google.internal' || host.endsWith('.internal')) return true;

    const ipv6 = host.replace(/^\[|\]$/g, '');
    if (ipv6.includes(':')) {
        if (ipv6 === '::' || ipv6 === '::1') return true;
        if (/^f[cd][0-9a-f]{2}:/i.test(ipv6)) return true;
        if (/^fe[89ab][0-9a-f]:/i.test(ipv6)) return true;
        return false;
    }

    const n = ipv4ToInt(host);
    if (n === null) return false;
    if (n === 0 || n === 0xffffffff) return true;
    if (inCidr(n, 0x0a000000, 0xff000000)) return true; // 10.0.0.0/8
    if (inCidr(n, 0x64400000, 0xffc00000)) return true; // 100.64.0.0/10
    if (inCidr(n, 0x7f000000, 0xff000000)) return true; // 127.0.0.0/8
    if (inCidr(n, 0xa9fe0000, 0xffff0000)) return true; // 169.254.0.0/16
    if (inCidr(n, 0xac100000, 0xfff00000)) return true; // 172.16.0.0/12
    if (inCidr(n, 0xc0000000, 0xffffff00)) return true; // 192.0.0.0/24
    if (inCidr(n, 0xc0000200, 0xffffff00)) return true; // 192.0.2.0/24
    if (inCidr(n, 0xc0586300, 0xffffff00)) return true; // 192.88.99.0/24
    if (inCidr(n, 0xc0a80000, 0xffff0000)) return true; // 192.168.0.0/16
    if (inCidr(n, 0xc6120000, 0xfffe0000)) return true; // 198.18.0.0/15
    if (inCidr(n, 0xc6336400, 0xffffff00)) return true; // 198.51.100.0/24
    if (inCidr(n, 0xcb007100, 0xffffff00)) return true; // 203.0.113.0/24
    if ((n >>> 28) === 0xe) return true; // 224.0.0.0/4
    if ((n >>> 28) === 0xf) return true; // 240.0.0.0/4
    return false;
}

function isSafeSourceUrl(urlStr) {
    try {
        const u = new URL(urlStr);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        return !isUnsafeHostname(u.hostname);
    } catch {
        return false;
    }
}

async function fetchSourceContent(url) {
    if (!isSafeSourceUrl(url)) throw new Error('不安全的源地址');
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT_MS);
        try {
            const resp = await fetch(url, {
                redirect: 'follow',
                cf: { cacheTtl: 0, cacheEverything: false },
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                    'Accept': '*/*'
                },
                signal: controller.signal
            });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const contentLength = Number(resp.headers.get('content-length') || 0);
            if (contentLength > CONFIG.MAX_SOURCE_BYTES) throw new Error('源内容超过大小限制');
            return resp;
        } catch (err) {
            lastError = err;
            if (attempt === 1) await new Promise(resolve => setTimeout(resolve, 500));
        } finally {
            clearTimeout(timer);
        }
    }
    throw lastError;
}

// ===== 数据刷新 =====
async function refreshAllSources() {
    try {
        const sources = await getSources();
        const enabledSources = sources.filter(s => s.enabled);
        const sourceDetails = [];
        const nowIso = new Date().toISOString();
        
        const results = await Promise.all(
            enabledSources.map(async src => {
                try {
                    let content;
                    if (src.content) {
                        // 使用保存的内容（兼容旧数据）
                        content = src.content;
                    } else if (src.id === '_fixed_mapping') {
                        // 固定映射源，内部生成 M3U 内容（避免自请求）
                        const baseUrl = src.url ? new URL(src.url).origin : 'https://iptv.mhtc.top';
                        content = await genFixedM3U(baseUrl);
                    } else {
                        // URL 源，远程获取
                        const resp = await fetchSourceContent(src.url);
                        if (!resp.ok) {
                            sourceDetails.push({ name: src.name, url: src.url, error: `HTTP ${resp.status}`, count: 0 });
                            return [];
                        }
                        content = await resp.text();
                    }
                    const channels = parseSourceContent(content, src.priority || 99);
                    sourceDetails.push({ name: src.name, url: src.url || '-', count: channels.length });
                    // 更新每个源的 updatedAt 时间戳
                    src.updatedAt = nowIso;
                    await saveSource(src.id, src);
                    return channels;
                } catch (err) {
                    sourceDetails.push({ name: src.name, url: src.url || '-', error: err.message || String(err), count: 0 });
                    return [];
                }
            })
        );
        
        const merged = mergeChannels(results);
        
        if (merged.length > 0) {
            cacheData = {
                channels: merged,
                categories: getCategories(merged),
                lastUpdated: new Date().toISOString(),
                sourceDetails: sourceDetails
            };
        } else {
            console.log('数据源加载失败，保留缓存数据');
        }
        
        return { total: merged.length, sources: sourceDetails };
    } catch (err) {
        console.error('refreshAllSources error:', err.message || err);
        return { total: 0, error: err.message, sources: [] };
    }
}

// ===== 频道固定映射 =====
// 从 M3U 内容中提取频道 ID 并更新映射
async function updateChannelMappingsFromM3U(content, pruneMissing = false) {
    const channels = parseM3U(content, 1);
    // 默认保留旧映射；pruneMissing 开启时同步清理本次未出现的频道
    const existingIds = await getAllChannelIds();
    const seenIds = new Set();
    let newCount = 0, updateCount = 0, removedCount = 0;
    
    for (const ch of channels) {
        const channelId = extractChannelId(ch.url);
        if (!channelId) continue;
        
        const existing = await getChannelMapping(channelId);
        if (!existing) {
            // 全新频道，生成固定映射
            await saveChannelMapping(channelId, ch.name, ch.url);
            newCount++;
        } else if (existing.url !== ch.url) {
            // 已有频道但地址变了，只更新地址
            await saveChannelMapping(channelId, ch.name, ch.url);
            updateCount++;
        }
        seenIds.add(channelId);
    }

    if (pruneMissing) {
        for (const id of existingIds) {
            if (!seenIds.has(id)) {
                await SOURCES_KV.delete(CHMAP_PREFIX + id);
                removedCount++;
            }
        }
    }
    
    const finalIds = pruneMissing ? seenIds : new Set([...existingIds, ...seenIds]);
    await saveAllChannelIds(Array.from(finalIds));
    return { total: channels.length, new: newCount, updated: updateCount, removed: removedCount };
}

// 生成固定地址的 M3U（供前端电视使用）
async function genFixedM3U(baseUrl) {
    const ids = await getAllChannelIds();
    let m3u = '#EXTM3U\n';
    for (const id of ids) {
        const mapping = await getChannelMapping(id);
        if (!mapping) continue;
        m3u += `#EXTINF:-1 group-title="${escapeM3UAttr(CONFIG.GROUP_NAME)}",${escapeM3UName(mapping.name)}\n`;
        m3u += `${baseUrl}/${id}\n`;
    }
    return m3u;
}

// ===== 请求处理 =====
async function handleRequest(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const query = url.searchParams;
    const method = request.method.toUpperCase();

    // CORS
    if (method === 'OPTIONS') {
        return new Response(null, {
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password'
            }
        });
    }

    // 如果缓存为空或是示例数据，自动刷新数据
    if (cacheData.channels.length === 0 || 
        (cacheData.channels.length === 3 && cacheData.channels[0].name === '示例频道1')) {
        await refreshAllSources();
    }

    // 首页
    if (path === '/' || path === '/index.html') {
        return new Response(FRONTEND_HTML, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
    }

    // API - 获取状态
    if (path === '/api/status') {
        const sources = await getSources();
        return new Response(JSON.stringify({
            version: CONFIG.VERSION,
            totalChannels: cacheData.channels.length,
            totalCategories: cacheData.categories.length,
            lastUpdated: cacheData.lastUpdated,
            sourceCount: sources.length,
            enabledSources: sources.filter(s => s.enabled).length,
            sources: sources.map(s => ({ name: s.name, url: s.url, enabled: s.enabled, priority: s.priority })),
            sourceDetails: cacheData.sourceDetails || null
        }, null, 2), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    }

    // API - 获取频道
    if (path === '/api/channels') {
        const filtered = filterChannels(cacheData.channels, {
            group: query.get('group'),
            search: query.get('search')
        });
        return new Response(JSON.stringify({
            total: cacheData.channels.length,
            filtered: filtered.length,
            channels: filtered,
            categories: cacheData.categories,
            lastUpdated: cacheData.lastUpdated
        }, null, 2), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    }

    // API - 获取合并后的频道组（前端展示用）
    if (path === '/api/merged-channels') {
        const merged = buildMergedChannels();
        let result = merged;
        const search = query.get('search');
        if (search) {
            const kw = search.toLowerCase();
            result = merged.filter(g => g.name.toLowerCase().includes(kw));
        }
        const group = query.get('group');
        if (group) {
            result = result.filter(g => g.group === group);
        }
        return new Response(JSON.stringify({
            total: merged.length,
            filtered: result.length,
            channels: result,
            categories: cacheData.categories,
            lastUpdated: cacheData.lastUpdated
        }, null, 2), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    }

    // API - 获取分类
    if (path === '/api/categories') {
        return new Response(JSON.stringify({
            categories: cacheData.categories,
            lastUpdated: cacheData.lastUpdated
        }, null, 2), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    }

    // API - 手动刷新数据
    if (path === '/api/refresh') {
        try {
            const result = await refreshAllSources();
            return new Response(JSON.stringify({
                success: true,
                totalChannels: result.total,
                sourceDetails: result.sources,
                lastUpdated: cacheData.lastUpdated
            }, null, 2), {
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        } catch (err) {
            return new Response(JSON.stringify({
                success: false,
                error: err.message,
                totalChannels: cacheData.channels.length
            }, null, 2), {
                status: 500,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }
    }

    // API - 获取数据源列表
    if (path === '/api/sources') {
        const sources = await getSources();
        return new Response(JSON.stringify({ sources }, null, 2), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    }

    // API - 获取单个数据源
    const sourceMatch = path.match(/^\/api\/source\/(.+)$/);
    if (sourceMatch && method === 'GET') {
        const srcId = decodeURIComponent(sourceMatch[1]);
        const src = await getSource(srcId);
        if (!src) {
            return new Response(JSON.stringify({ success: false, error: '数据源未找到' }, null, 2), {
                status: 404,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }
        return new Response(JSON.stringify(src, null, 2), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    }

    // API - 添加数据源（URL）
    if (path === '/api/source' && method === 'POST') {
        try {
            const body = await request.json();
            if (!body.url || !isSafeSourceUrl(body.url)) {
                return new Response(JSON.stringify({ success: false, error: '无效或不安全的源 URL' }, null, 2), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json; charset=utf-8' }
                });
            }
            const id = generateSourceId(body.name);
            const refreshTimes = Array.isArray(body.refreshTimes) ? body.refreshTimes : ['05:00'];
            const source = {
                id: id,
                name: body.name || '新数据源',
                url: body.url,
                enabled: body.enabled !== undefined ? body.enabled : true,
                priority: body.priority !== undefined ? body.priority : 99,
                refreshTimes: refreshTimes,
                createdAt: new Date().toISOString()
            };
            await saveSource(id, source);
            return new Response(JSON.stringify({
                success: true,
                source: source
            }, null, 2), {
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        } catch (err) {
            return new Response(JSON.stringify({ success: false, error: err.message }, null, 2), {
                status: 500,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }
    }

    // API - 更新数据源
    if (sourceMatch && method === 'PUT') {
        const srcId = decodeURIComponent(sourceMatch[1]);
        let src = await getSource(srcId);
        if (!src) {
            return new Response(JSON.stringify({ success: false, error: '数据源未找到' }, null, 2), {
                status: 404,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }
        const body = await request.json();
        if (body.url && !isSafeSourceUrl(body.url)) {
            return new Response(JSON.stringify({ success: false, error: '无效或不安全的源 URL' }, null, 2), {
                status: 400,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }
        if (body.name) src.name = body.name;
        if (body.url) src.url = body.url;
        if (body.enabled !== undefined) src.enabled = body.enabled;
        if (body.priority !== undefined) src.priority = body.priority;
        if (body.refreshTimes !== undefined) src.refreshTimes = Array.isArray(body.refreshTimes) ? body.refreshTimes : ['05:00'];
        await saveSource(srcId, src);
        return new Response(JSON.stringify({ success: true, source: src }, null, 2), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    }

    // API - 删除数据源
    if (sourceMatch && method === 'DELETE') {
        const srcId = decodeURIComponent(sourceMatch[1]);
        const src = await getSource(srcId);
        if (!src) {
            return new Response(JSON.stringify({ success: false, error: '数据源未找到' }, null, 2), {
                status: 404,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }
        await deleteSource(srcId);
        return new Response(JSON.stringify({ success: true }, null, 2), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    }

    // API - 刷新单个数据源
    const sourceRefreshMatch = path.match(/^\/api\/source\/(.+)\/refresh$/);
    if (sourceRefreshMatch && method === 'POST') {
        const srcId = decodeURIComponent(sourceRefreshMatch[1]);
        const src = await getSource(srcId);
        if (!src) {
            return new Response(JSON.stringify({ success: false, error: '数据源未找到' }, null, 2), {
                status: 404,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }
        try {
            let content;
            if (src.content) {
                content = src.content;
            } else if (src.id === '_fixed_mapping') {
                // 固定映射源，内部生成（避免自请求 522）
                const baseUrl = src.url ? new URL(src.url).origin : 'https://iptv.mhtc.top';
                content = await genFixedM3U(baseUrl);
            } else if (src.url) {
                const resp = await fetchSourceContent(src.url);
                if (!resp.ok) {
                    return new Response(JSON.stringify({ success: false, error: 'HTTP ' + resp.status }, null, 2), {
                        status: 500,
                        headers: { 'Content-Type': 'application/json; charset=utf-8' }
                    });
                }
                content = await resp.text();
            } else {
                return new Response(JSON.stringify({ success: false, error: '数据源没有 URL' }, null, 2), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json; charset=utf-8' }
                });
            }
            const channels = parseSourceContent(content, src.priority || 99);
            if (channels.length > 0) {
                src.updatedAt = new Date().toISOString();
                if (src.content) {
                    src.content = content;
                }
                await saveSource(srcId, src);
            }
            await refreshAllSources();
            return new Response(JSON.stringify({
                success: true,
                message: '数据源已更新',
                channelCount: channels.length,
                lastUpdated: cacheData.lastUpdated
            }, null, 2), {
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        } catch (err) {
            return new Response(JSON.stringify({ success: false, error: err.message }, null, 2), {
                status: 500,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }
    }

    // API - 获取播放列表列表
    if (path === '/api/playlists') {
        const playlists = await getPlaylists();
        const list = Object.keys(playlists).map(id => ({
            id: id,
            name: playlists[id].name,
            protected: isProtectedPlaylist(id, playlists[id]),
            channelCount: playlists[id].channelCount,
            refreshTimes: playlists[id].refreshTimes || ['05:05'],
            url: `/playlist/${id}.m3u`,
            createdAt: playlists[id].createdAt,
            updatedAt: playlists[id].updatedAt
        }));
        return new Response(JSON.stringify({ playlists: list }, null, 2), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    }

    // API - 获取单个播放列表（包含频道详情）
    const plMatch = path.match(/^\/api\/playlist\/(.+)$/);
    if (plMatch && method === 'GET') {
        const plId = decodeURIComponent(plMatch[1]);
        const pl = await getPlaylist(plId);
        if (!pl) {
            return new Response(JSON.stringify({ success: false, error: '播放列表未找到' }, null, 2), {
                status: 404,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }
        const channels = cacheData.channels.filter(ch => pl.urls.includes(ch.url));
        return new Response(JSON.stringify({
            id: plId,
            name: pl.name,
            urls: pl.urls,
            channels: channels,
            channelCount: pl.channelCount,
            url: `/playlist/${plId}.m3u`,
            createdAt: pl.createdAt
        }, null, 2), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    }

    // API - 创建播放列表
    if (path === '/api/playlist' && method === 'POST') {
        try {
            const body = await request.json();
            let channels = [...cacheData.channels];
            
            if (body.urls && Array.isArray(body.urls)) {
                channels = channels.filter(ch => body.urls.includes(ch.url));
            } else if (body.channelGroups && Array.isArray(body.channelGroups)) {
                // 按合并后的频道组创建（自动包含所有源 URL）
                const matchedUrls = new Set();
                for (const ch of cacheData.channels) {
                    if (body.channelGroups.includes(getChannelKey(ch.name))) {
                        matchedUrls.add(ch.url);
                    }
                }
                channels = channels.filter(ch => matchedUrls.has(ch.url));
            } else {
                if (body.groups && body.groups.length > 0) {
                    channels = channels.filter(ch => body.groups.includes(ch.group));
                }
                if (body.search) {
                    const kw = body.search.toLowerCase();
                    channels = channels.filter(ch => ch.name.toLowerCase().includes(kw));
                }
            }

            if (channels.length === 0) {
                return new Response(JSON.stringify({ success: false, error: '没有匹配的频道' }, null, 2), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json; charset=utf-8' }
                });
            }

            const id = await generatePlaylistId(body.name);
            const now = new Date().toISOString();
            const refreshTimes = Array.isArray(body.refreshTimes) ? body.refreshTimes : ['05:05'];
            const playlist = {
                name: body.name || id,
                urls: channels.map(ch => ch.url),
                channelCount: channels.length,
                refreshTimes: refreshTimes,
                createdAt: now,
                updatedAt: now
            };
            await savePlaylist(id, playlist);
            await invalidatePlaylistCache(url.origin, id);

            return new Response(JSON.stringify({
                success: true,
                id: id,
                name: playlist.name,
                url: `/playlist/${id}.m3u`,
                channelCount: channels.length
            }, null, 2), {
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        } catch (err) {
            return new Response(JSON.stringify({ success: false, error: err.message }, null, 2), {
                status: 500,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }
    }

    // API - 更新播放列表（支持编辑频道）
    if (plMatch && method === 'PUT') {
        const plId = decodeURIComponent(plMatch[1]);
        let pl = await getPlaylist(plId);
        if (!pl) {
            return new Response(JSON.stringify({ success: false, error: '播放列表未找到' }, null, 2), {
                status: 404,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }
        const body = await request.json();
        if (body.name) pl.name = body.name;
        if (body.urls && Array.isArray(body.urls)) {
            pl.urls = body.urls;
            pl.channelCount = body.urls.length;
        }
        if (body.addUrls && Array.isArray(body.addUrls)) {
            body.addUrls.forEach(url => {
                if (!pl.urls.includes(url)) {
                    pl.urls.push(url);
                }
            });
            pl.channelCount = pl.urls.length;
        }
        if (body.removeUrls && Array.isArray(body.removeUrls)) {
            pl.urls = pl.urls.filter(url => !body.removeUrls.includes(url));
            pl.channelCount = pl.urls.length;
        }
        if (body.refreshTimes !== undefined) pl.refreshTimes = Array.isArray(body.refreshTimes) ? body.refreshTimes : ['05:05'];
        pl.updatedAt = new Date().toISOString();
        await savePlaylist(plId, pl);
        await invalidatePlaylistCache(url.origin, plId);
        return new Response(JSON.stringify({
            success: true,
            id: plId,
            name: pl.name,
            url: `/playlist/${plId}.m3u`,
            channelCount: pl.channelCount
        }, null, 2), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    }

    // API - 删除播放列表
    if (plMatch && method === 'DELETE') {
        const plId = decodeURIComponent(plMatch[1]);
        const pl = await getPlaylist(plId);
        if (!pl) {
            return new Response(JSON.stringify({ success: false, error: '播放列表未找到' }, null, 2), {
                status: 404,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }
        if (isProtectedPlaylist(plId, pl)) {
            return playlistProtectedError();
        }
        await deletePlaylist(plId);
        await invalidatePlaylistCache(url.origin, plId);
        return new Response(JSON.stringify({ success: true }, null, 2), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    }

    // API - 刷新播放列表（重新匹配频道，添加新源）
    const plRefreshMatch = path.match(/^\/api\/playlist\/(.+)\/refresh$/);
    if (plRefreshMatch && method === 'POST') {
        const plId = decodeURIComponent(plRefreshMatch[1]);
        const pl = await getPlaylist(plId);
        if (!pl) {
            return new Response(JSON.stringify({ success: false, error: '播放列表未找到' }, null, 2), {
                status: 404,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }
        try {
            await refreshAllSources();
            const r = await rematchPlaylist(plId, pl);
            await invalidatePlaylistCache(url.origin, plId);
            return new Response(JSON.stringify({
                success: true,
                message: '播放列表已更新',
                oldChannelCount: r.oldCount,
                newChannelCount: r.newCount,
                addedCount: r.addedCount,
                url: `/playlist/${plId}.m3u`,
                lastUpdated: pl.updatedAt
            }, null, 2), {
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        } catch (err) {
            return new Response(JSON.stringify({ success: false, error: err.message }, null, 2), {
                status: 500,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }
    }

    // ===== 频道固定映射 API =====
    
    // API - 上传 M3U 更新频道映射
    if (path === '/api/channel-mapping' && method === 'POST') {
        try {
            const body = await request.json();
            const content = body.content;
            if (!content) {
                return new Response(JSON.stringify({ success: false, error: '内容不能为空' }, null, 2), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json; charset=utf-8' }
                });
            }
            const result = await updateChannelMappingsFromM3U(content, body.pruneMissing === true);
            // 自动创建/更新固定映射数据源，显示在数据源管理中
            const baseUrl = url.origin;
            const fixedSource = {
                id: '_fixed_mapping',
                name: '固定映射',
                url: baseUrl + '/iptv2026.m3u',
                enabled: true,
                priority: 3,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            await saveSource('_fixed_mapping', fixedSource);
            // 刷新数据合并到频道列表
            await refreshAllSources();
            // 记录上传日志
            await addUploadLog({
                total: result.total,
                new: result.new,
                updated: result.updated,
                removed: result.removed,
                success: true
            });
            return new Response(JSON.stringify({
                success: true,
                totalChannels: result.total,
                newChannels: result.new,
                updatedChannels: result.updated,
                removedChannels: result.removed
            }, null, 2), {
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        } catch (err) {
            // 记录失败日志
            await addUploadLog({ total: 0, new: 0, updated: 0, success: false, error: err.message }).catch(() => {});
            return new Response(JSON.stringify({ success: false, error: err.message }, null, 2), {
                status: 500,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }
    }

    // API - 获取所有频道映射列表
    if (path === '/api/channel-mapping' && method === 'GET') {
        try {
            const ids = await getAllChannelIds();
            const mappings = [];
            for (const id of ids) {
                const m = await getChannelMapping(id);
                if (m) mappings.push({ id, name: m.name, url: m.url, updatedAt: m.updatedAt });
            }
            return new Response(JSON.stringify({ count: mappings.length, mappings }, null, 2), {
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        } catch (err) {
            return new Response(JSON.stringify({ success: false, error: err.message }, null, 2), {
                status: 500,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }
    }

    // API - 批量更新频道映射（修改名称/删除）
    if (path === '/api/channel-mapping/batch-update' && method === 'POST') {
        try {
            const body = await request.json();
            const updates = body.updates || [];
            const deletes = body.deletes || [];
            let updatedCount = 0, deletedCount = 0;

            // 更新名称
            for (const item of updates) {
                const mapping = await getChannelMapping(item.id);
                if (mapping) {
                    mapping.name = item.name;
                    mapping.updatedAt = new Date().toISOString();
                    await saveChannelMapping(item.id, mapping.name, mapping.url);
                    updatedCount++;
                }
            }

            // 删除频道
            for (const id of deletes) {
                await SOURCES_KV.delete(CHMAP_PREFIX + id);
                deletedCount++;
            }

            if (deletes.length > 0) {
                // 重新计算 ID 列表
                const ids = await getAllChannelIds();
                const newIds = ids.filter(id => !deletes.includes(id));
                await saveAllChannelIds(newIds);
            }

            // 刷新数据
            await refreshAllSources();

            return new Response(JSON.stringify({
                success: true,
                updated: updatedCount,
                deleted: deletedCount
            }, null, 2), {
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        } catch (err) {
            return new Response(JSON.stringify({ success: false, error: err.message }, null, 2), {
                status: 500,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }
    }

    // API - 获取上传日志
    if (path === '/api/channel-mapping/logs') {
        try {
            const logs = await getUploadLogs();
            return new Response(JSON.stringify({ logs }, null, 2), {
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        } catch (err) {
            return new Response(JSON.stringify({ success: false, error: err.message }, null, 2), {
                status: 500,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }
    }

    // API - 清理缓存
    if (path === '/api/clear-cache' && method === 'POST') {
        try {
            // 重置内存缓存
            cacheData = {
                channels: [],
                categories: [],
                lastUpdated: null
            };
            // 重新拉取数据
            await refreshAllSources();
            return new Response(JSON.stringify({
                success: true,
                message: '缓存已清理，数据已重新加载'
            }, null, 2), {
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        } catch (err) {
            return new Response(JSON.stringify({ success: false, error: err.message }, null, 2), {
                status: 500,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }
    }

    // M3U - 固定映射播放列表（供前端电视使用）
    if (path === '/iptv2026.m3u') {
        const m3uHeaders = {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        };
        try {
            const baseUrl = url.origin;
            const m3u = await genFixedM3U(baseUrl);
            return new Response(m3u || '#EXTM3U\n# 暂无映射', {
                headers: m3uHeaders
            });
        } catch (err) {
            return new Response('#EXTM3U\n# 生成失败: ' + (err.message || ''), {
                status: 500,
                headers: m3uHeaders
            });
        }
    }

    // M3U - 动态播放列表
    if (path === '/playlist.m3u') {
        const m3uHeaders = {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        };
        const filtered = filterChannels(cacheData.channels, {
            group: query.get('group'),
            search: query.get('search')
        });
        if (filtered.length === 0) {
            return new Response('#EXTM3U\n# 暂无频道', {
                status: 200,
                headers: m3uHeaders
            });
        }
        return new Response(await genM3U(filtered, url.origin), {
            headers: m3uHeaders
        });
    }

    // M3U - 已保存播放列表（动态生成，自动更新）
    const playlistMatch = path.match(/^\/playlist\/(.+)\.m3u$/);
    if (playlistMatch && method === 'GET') {
        const m3uHeaders = {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Cache-Control': 'public, max-age=14400'
        };

        // 构造稳定的 Cache Key：scheme + hostname + pathname（忽略 query，避免不同播放列表错误共享缓存）
        const cacheKey = new Request(url.origin + url.pathname, request);

        // 缓存命中直接返回，不再执行 PLAYLISTS_KV.get(id)
        const cached = await caches.default.match(cacheKey);
        if (cached) {
            const headers = new Headers(cached.headers);
            headers.set('X-Worker-Cache', 'HIT');
            return new Response(cached.body, {
                status: cached.status,
                statusText: cached.statusText,
                headers
            });
        }

        const plId = decodeURIComponent(playlistMatch[1]);
        const pl = await getPlaylist(plId);
        if (!pl) {
            return new Response('#EXTM3U\n# 播放列表未找到', {
                status: 404,
                headers: m3uHeaders
            });
        }
        const channels = cacheData.channels.filter(ch => pl.urls.includes(ch.url));

        if (channels.length === 0) {
            return new Response('#EXTM3U\n# 播放列表为空', {
                status: 200,
                headers: m3uHeaders
            });
        }

        const response = new Response(await genM3U(channels, url.origin), {
            headers: m3uHeaders
        });

        // 只缓存 HTTP 200 且确实生成了有效 M3U 内容的成功响应
        // 先写缓存（写入的副本不含 MISS 标记），再给原始响应标记 MISS
        if (response.ok) {
            await caches.default.put(cacheKey, response.clone());
        }
        response.headers.set('X-Worker-Cache', 'MISS');
        return response;
    }

    // 302 跳转 - 固定频道 ID 映射到实际播放地址
    {
        const channelId = path.replace(/^\//, '');
        if (channelId && !channelId.includes('/') && !channelId.includes('.')) {
            const mapping = await getChannelMapping(channelId);
            if (mapping) {
                return new Response(null, {
                    status: 302,
                    headers: {
                        'Location': mapping.url,
                        'Access-Control-Allow-Origin': '*'
                    }
                });
            }
        }
    }

    // 404
    return new Response('Not found', { status: 404 });
}

// 前端 HTML（支持编辑播放列表频道）
const FRONTEND_HTML = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>IPTV 管理器</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f3f4f6; }
        .header { background: #1f2937; color: white; padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; }
        .header h1 { font-size: 18px; }
        .header-right { display: flex; gap: 12px; align-items: center; }
        .btn { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
        .btn-primary { background: #3b82f6; color: white; }
        .btn-primary:hover { background: #2563eb; }
        .btn-success { background: #10b981; color: white; }
        .btn-success:hover { background: #059669; }
        .btn-danger { background: #ef4444; color: white; }
        .btn-danger:hover { background: #dc2626; }
        .btn-secondary { background: #6b7280; color: white; }
        .btn-secondary:hover { background: #4b5563; }
        .container { display: flex; height: calc(100vh - 64px); }
        .sidebar { width: 200px; background: #ffffff; border-right: 1px solid #e5e7eb; padding: 16px; }
        .sidebar a { display: block; padding: 10px 12px; color: #374151; text-decoration: none; border-radius: 4px; margin-bottom: 4px; }
        .sidebar a:hover { background: #f3f4f6; }
        .sidebar a.active { background: #dbeafe; color: #1d4ed8; }
        .main { flex: 1; padding: 20px; overflow-y: auto; }
        .panel { background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
        .panel-title { font-size: 16px; font-weight: 600; margin-bottom: 16px; color: #1f2937; }
        .form-group { margin-bottom: 12px; }
        .form-group label { display: block; margin-bottom: 4px; font-size: 14px; color: #374151; }
        .form-group input, .form-group textarea, .form-group select { width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 14px; }
        .form-row { display: flex; gap: 12px; }
        .form-row .form-group { flex: 1; }
        .status-bar { display: flex; gap: 24px; margin-bottom: 16px; }
        .status-item { padding: 12px 20px; background: #f9fafb; border-radius: 8px; }
        .status-item .value { font-size: 24px; font-weight: 700; color: #1f2937; }
        .status-item .label { font-size: 12px; color: #6b7280; margin-top: 2px; }
        .table { width: 100%; border-collapse: collapse; }
        .table th, .table td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #e5e7eb; }
        .table th { background: #f9fafb; font-weight: 600; color: #374151; }
        .table tr:hover { background: #f9fafb; }
        .actions { display: flex; gap: 8px; }
        .badge { padding: 2px 8px; border-radius: 12px; font-size: 12px; }
        .badge-success { background: #d1fae5; color: #065f46; }
        .badge-danger { background: #fee2e2; color: #991b1b; }
        .search-box { display: flex; gap: 12px; margin-bottom: 16px; }
        .search-box input { flex: 1; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 4px; }
        .category-filter { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
        .category-tag { padding: 4px 12px; background: #f3f4f6; border-radius: 16px; cursor: pointer; font-size: 13px; }
        .category-tag.active { background: #3b82f6; color: white; }
        .channel-list { display: flex; flex-direction: column; gap: 4px; }
        .channel-item { display: flex; align-items: center; padding: 10px 12px; background: #f9fafb; border-radius: 6px; }
        .channel-checkbox { margin-right: 12px; flex-shrink: 0; }
        .channel-logo { width: 36px; height: 36px; margin-right: 12px; background: #e5e7eb; border-radius: 4px; object-fit: contain; flex-shrink: 0; }
        .channel-info { flex: 1; display: flex; flex-direction: column; align-items: flex-start; }
        .channel-name { font-weight: 500; color: #1f2937; text-align: left; }
        .source-badge { display: inline-block; font-size: 10px; background: #3b82f6; color: white; padding: 1px 6px; border-radius: 8px; margin-left: 6px; vertical-align: middle; }
        .fixed-badge { display: inline-block; font-size: 10px; background: #92400e; color: #fef3c7; padding: 2px 8px; border-radius: 8px; margin-left: 6px; vertical-align: middle; }
        .channel-group { font-size: 12px; color: #6b7280; }
        .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 1000; }
        .modal { background: white; border-radius: 8px; padding: 24px; width: 90%; max-width: 900px; max-height: 90vh; overflow-y: auto; }
        .modal-title { font-size: 18px; font-weight: 600; margin-bottom: 20px; }
        .modal-footer { display: flex; justify-content: flex-end; gap: 12px; margin-top: 20px; }
        .hidden { display: none; }
        .checkbox-label { display: flex; align-items: center; gap: 8px; cursor: pointer; }
        .loading { text-align: center; padding: 40px; color: #6b7280; }
        .select-controls { display: flex; gap: 12px; margin-bottom: 12px; align-items: center; }
        .select-controls label { margin-right: 8px; }
        .playlist-url { font-family: monospace; font-size: 12px; padding: 8px; background: #f3f4f6; border-radius: 4px; word-break: break-all; }
        .pagination { display: flex; justify-content: center; gap: 8px; margin-top: 16px; }
        .pagination button { padding: 4px 12px; border: 1px solid #d1d5db; border-radius: 4px; background: white; cursor: pointer; }
        .pagination button.active { background: #3b82f6; color: white; border-color: #3b82f6; }
        .pagination button:disabled { opacity: 0.5; cursor: not-allowed; }
        .playlist-editor { display: flex; gap: 20px; }
        .playlist-editor .available, .playlist-editor .selected { flex: 1; }
        .playlist-editor h3 { margin-bottom: 12px; }
        .playlist-editor .channel-mini-list { max-height: 400px; overflow-y: auto; }
        .btn-add { background: #10b981; color: white; padding: 4px 8px; border: none; border-radius: 4px; cursor: pointer; }
        .btn-remove { background: #ef4444; color: white; padding: 4px 8px; border: none; border-radius: 4px; cursor: pointer; }
        .btn-sm { padding: 4px 10px; font-size: 12px; }
        .name-input { width: 120px; padding: 3px 6px; border: 1px solid #d1d5db; border-radius: 3px; font-size: 13px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>IPTV 管理器</h1>
        <div class="header-right">
            <span id="lastUpdate">-</span>
            <button class="btn btn-primary" onclick="refreshData()">刷新数据</button>
            <button class="btn btn-secondary" onclick="clearCache()">清理缓存</button>
        </div>
    </div>
    
    <div class="container">
        <div class="sidebar">
            <a href="#" class="active" data-tab="sources">数据源管理</a>
            <a href="#" data-tab="channels">频道管理</a>
            <a href="#" data-tab="playlists">播放列表</a>
            <a href="#" data-tab="mapping">固定映射</a>
        </div>
        
        <div class="main">
            <!-- 数据源管理 -->
            <div id="tab-sources">
                <div class="panel">
                    <div class="panel-title">数据源列表</div>
                    <table class="table">
                        <thead>
                            <tr><th>名称</th><th>URL</th><th>优先级</th><th>刷新时间</th><th>状态</th><th>更新时间</th><th>操作</th></tr>
                        </thead>
                        <tbody id="sourcesTable"></tbody>
                    </table>
                </div>
                
                <div class="panel">
                    <div class="panel-title">添加数据源（URL）</div>
                    <div class="form-group">
                        <label>名称</label>
                        <input type="text" id="sourceName" placeholder="数据源名称">
                    </div>
                    <div class="form-group">
                        <label>URL</label>
                        <input type="text" id="sourceUrl" placeholder="M3U 地址">
                    </div>
                    <div class="form-group">
                        <label>优先级（数字越小越优先）</label>
                        <input type="number" id="sourcePriority" value="99" placeholder="优先级">
                    </div>
                    <div class="form-group">
                        <label>刷新时间（北京时间 HH:MM，多个用逗号分隔，如 05:00,17:00）</label>
                        <input type="text" id="sourceRefreshTimes" value="05:00" placeholder="05:00,17:00">
                    </div>
                    <div class="form-group">
                        <label class="checkbox-label">
                            <input type="checkbox" id="sourceEnabled" checked> 启用
                        </label>
                    </div>
                    <button class="btn btn-primary" onclick="addSource()">添加数据源</button>
                </div>
            </div>
            
            <!-- 播放列表 -->
            <div id="tab-playlists" class="hidden">
                <div class="panel">
                    <div class="panel-title">播放列表列表</div>
                    <table class="table">
                        <thead>
                            <tr><th>名称</th><th>频道数</th><th>刷新时间</th><th>创建时间</th><th>更新时间</th><th>访问地址</th><th>操作</th></tr>
                        </thead>
                        <tbody id="playlistsTable"></tbody>
                    </table>
                </div>
                
                <div class="panel">
                    <div class="panel-title">创建播放列表</div>
                    <div class="form-group">
                        <label>播放列表名称</label>
                        <input type="text" id="playlistName" placeholder="播放列表名称">
                    </div>
                    <div class="form-group">
                        <label>筛选条件（可选）</label>
                        <input type="text" id="playlistSearch" placeholder="搜索关键词">
                    </div>
                    <div class="form-group">
                        <label>刷新时间（北京时间 HH:MM，多个用逗号分隔，如 05:00,17:00）</label>
                        <input type="text" id="playlistRefreshTimes" value="05:05" placeholder="05:00,17:00">
                    </div>
                    <button class="btn btn-primary" onclick="createPlaylist()">创建播放列表</button>
                </div>
            </div>
            
            <!-- 固定映射 -->
            <div id="tab-mapping" class="hidden">
                <div class="panel">
                    <div class="panel-title">上传 M3U 文件更新频道映射</div>
                    <div class="form-group">
                        <label>选择 iptv2026.m3u 文件（频道ID将从URL中自动提取）</label>
                        <input type="file" id="mappingFileInput" accept=".m3u,.txt">
                    </div>
                    <div class="form-group">
                        <label class="checkbox-label">
                            <input type="checkbox" id="pruneMissingMappings" checked> 同步删除本次 M3U 中已不存在的频道
                        </label>
                    </div>
                    <button class="btn btn-primary" onclick="uploadMapping()">上传并更新映射</button>
                    <div id="mappingUploadStatus" class="loading" style="margin-top:8px"></div>
                </div>
                
                <div class="panel">
                    <div class="panel-title">固定地址播放列表</div>
                    <div class="form-group">
                        <label>固定 M3U 地址（供前端电视使用，地址永不变）：</label>
                        <div class="playlist-url" id="fixedM3uUrl">加载中...</div>
                    </div>
                    <button class="btn btn-secondary" onclick="refreshFixedM3uUrl()">刷新地址</button>
                </div>
                
                <div class="panel">
                    <div class="panel-title">
                        当前频道映射列表 <span id="mappingCount"></span>
                        <span style="float:right;display:flex;gap:8px">
                            <button class="btn btn-primary btn-sm" onclick="saveMappingChanges()">保存更改</button>
                            <button class="btn btn-danger btn-sm" onclick="deleteSelectedMappings()">删除选中</button>
                        </span>
                    </div>
                    <div id="mappingList" class="loading">加载中...</div>
                </div>
                
                <div class="panel">
                    <div class="panel-title">上传日志</div>
                    <div id="uploadLogList"><div class="loading">暂无上传记录</div></div>
                </div>
            </div>
            
            <!-- 频道管理 -->
            <div id="tab-channels" class="hidden">
                <div class="status-bar">
                    <div class="status-item">
                        <div class="value" id="totalChannels">-</div>
                        <div class="label">总频道数</div>
                    </div>
                    <div class="status-item">
                        <div class="value" id="filteredChannels">-</div>
                        <div class="label">筛选后</div>
                    </div>
                    <div class="status-item">
                        <div class="value" id="totalCategories">-</div>
                        <div class="label">分类数</div>
                    </div>
                </div>
                
                <div class="search-box">
                    <input type="text" id="searchInput" placeholder="搜索频道..." oninput="filterChannels()">
                </div>
                
                <div class="category-filter" id="categoryFilter"></div>
                
                <div class="select-controls">
                    <label class="checkbox-label">
                        <input type="checkbox" id="selectAll" onchange="toggleSelectAll()"> 全选
                    </label>
                    <button class="btn btn-secondary" onclick="selectCurrentPage()">选中当前页</button>
                    <button class="btn btn-secondary" onclick="clearSelection()">清除选择</button>
                    <button class="btn btn-success" onclick="createPlaylistFromSelection()">从选中创建播放列表</button>
                </div>
                
                <div id="channelList" class="loading">加载中...</div>
                
                <div class="pagination" id="pagination"></div>
            </div>
        </div>
    </div>
    
    <!-- 编辑数据源弹窗 -->
    <div class="modal-overlay hidden" id="editSourceModal">
        <div class="modal">
            <div class="modal-title">编辑数据源</div>
            <input type="hidden" id="editSourceId">
            <div class="form-group">
                <label>名称</label>
                <input type="text" id="editSourceName">
            </div>
            <div class="form-group">
                <label>URL</label>
                <input type="text" id="editSourceUrl">
            </div>
            <div class="form-group">
                <label>优先级（数字越小越优先）</label>
                <input type="number" id="editSourcePriority" value="99">
            </div>
            <div class="form-group">
                <label>刷新时间（北京时间 HH:MM，多个用逗号分隔）</label>
                <input type="text" id="editSourceRefreshTimes" value="05:00" placeholder="05:00,17:00">
            </div>
            <div class="form-group">
                <label class="checkbox-label">
                    <input type="checkbox" id="editSourceEnabled"> 启用
                </label>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeEditSourceModal()">取消</button>
                <button class="btn btn-primary" onclick="saveSource()">保存</button>
            </div>
        </div>
    </div>
    
    <!-- 编辑播放列表弹窗（支持编辑频道） -->
    <div class="modal-overlay hidden" id="editPlaylistModal">
        <div class="modal">
            <div class="modal-title">编辑播放列表</div>
            <input type="hidden" id="editPlaylistId">
            <div class="form-group">
                <label>名称</label>
                <input type="text" id="editPlaylistName">
            </div>
            <div class="form-group">
                <label>访问地址</label>
                <div class="playlist-url" id="editPlaylistUrl"></div>
            </div>
            
            <div class="playlist-editor">
                <div class="available">
                    <h3>可用频道</h3>
                    <input type="text" id="availableSearch" placeholder="搜索频道..." oninput="filterAvailableChannels()">
                    <div class="channel-mini-list" id="availableChannels"></div>
                </div>
                
                <div class="selected">
                    <h3>已选频道</h3>
                    <input type="text" id="selectedSearch" placeholder="搜索已选..." oninput="filterSelectedChannels()">
                    <div class="channel-mini-list" id="selectedChannels"></div>
                </div>
            </div>
            
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeEditPlaylistModal()">取消</button>
                <button class="btn btn-primary" onclick="savePlaylist()">保存更改</button>
            </div>
        </div>
    </div>

    <script>
        let allChannels = [];
        let selectedChannels = new Set();
        let currentPage = 1;
        const pageSize = 50;

        const _rawFetch = window.fetch.bind(window);

        function escapeHtml(value) {
            return String(value == null ? '' : value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function jsArg(value) {
            return encodeURIComponent(String(value == null ? '' : value)).replace(/'/g, '%27');
        }

        async function adminFetch(path, options) {
            return _rawFetch(path, options || {});
        }
        window.fetch = adminFetch;
        
        let playlistEditor = {
            available: [],
            selected: [],
            selectedUrls: new Set()
        };
        
        document.querySelectorAll('.sidebar a').forEach(link => {
            link.addEventListener('click', e => {
                e.preventDefault();
                document.querySelectorAll('.sidebar a').forEach(a => a.classList.remove('active'));
                link.classList.add('active');
                const tab = link.dataset.tab;
                document.querySelectorAll('[id^="tab-"]').forEach(t => t.classList.add('hidden'));
                document.getElementById('tab-' + tab).classList.remove('hidden');
                if (tab === 'sources') loadSources();
                if (tab === 'playlists') loadPlaylists();
                if (tab === 'mapping') loadMapping();
            });
        });
        
        async function refreshData() {
            const res = await fetch('/api/refresh');
            const data = await res.json();
            if (data.success) {
                loadChannels();
                loadStatus();
            }
        }
        
        async function loadStatus() {
            const res = await fetch('/api/status');
            const data = await res.json();
            document.getElementById('totalChannels').textContent = data.totalChannels;
            document.getElementById('totalCategories').textContent = data.totalCategories;
            document.getElementById('lastUpdate').textContent = data.lastUpdated ? '最后更新: ' + new Date(data.lastUpdated).toLocaleString() : '-';
        }
        
        async function loadChannels() {
            const res = await fetch('/api/merged-channels');
            const data = await res.json();
            allChannels = data.channels;
            selectedChannels.clear();
            currentPage = 1;
            renderChannels();
            renderCategories(data.categories);
            renderPagination();
        }
        
        function renderChannels() {
            const channels = filteredChannels();
            const start = (currentPage - 1) * pageSize;
            const end = start + pageSize;
            const pageChannels = channels.slice(start, end);
            
            const list = document.getElementById('channelList');
            if (channels.length === 0) {
                list.innerHTML = '<div class="loading">暂无频道</div>';
                return;
            }
            list.innerHTML = pageChannels.map(ch => \`
                <div class="channel-item">
                    <input type="checkbox" class="channel-checkbox" \${selectedChannels.has(ch.key) ? 'checked' : ''} onchange="toggleChannel('\${jsArg(ch.key)}')">
                    <img class="channel-logo" src="\${escapeHtml(ch.tvgLogo || '')}" onerror="this.style.display='none'">
                    <div class="channel-info">
                        <div class="channel-name">\${escapeHtml(ch.name)}\${ch.urlCount > 1 ? ' <span class="source-badge">' + escapeHtml(ch.urlCount) + '源</span>' : ''}</div>
                        <div class="channel-group">\${escapeHtml(ch.group)}</div>
                    </div>
                </div>
            \`).join('');
        }
        
        function renderCategories(categories) {
            const filter = document.getElementById('categoryFilter');
            filter.innerHTML = \`<span class="category-tag active" onclick="filterByCategory('')">全部</span>\` +
                categories.map(cat => \`<span class="category-tag" onclick="filterByCategory('\${jsArg(cat)}')">\${escapeHtml(cat)}</span>\`).join('');
        }
        
        function renderPagination() {
            const channels = filteredChannels();
            const totalPages = Math.ceil(channels.length / pageSize);
            const pagination = document.getElementById('pagination');
            
            if (totalPages <= 1) {
                pagination.innerHTML = '';
                return;
            }
            
            let html = '';
            if (currentPage > 1) {
                html += \`<button onclick="goToPage(1)">首页</button>\`;
                html += \`<button onclick="goToPage(\${currentPage - 1})">上一页</button>\`;
            }
            
            for (let i = 1; i <= totalPages; i++) {
                if (i === currentPage) {
                    html += \`<button class="active">\${i}</button>\`;
                } else if (i >= currentPage - 2 && i <= currentPage + 2) {
                    html += \`<button onclick="goToPage(\${i})">\${i}</button>\`;
                }
            }
            
            if (currentPage < totalPages) {
                html += \`<button onclick="goToPage(\${currentPage + 1})">下一页</button>\`;
                html += \`<button onclick="goToPage(\${totalPages})">末页</button>\`;
            }
            
            pagination.innerHTML = html;
        }
        
        function goToPage(page) {
            currentPage = page;
            renderChannels();
            renderPagination();
        }
        
        function toggleChannel(key) {
            const decoded = decodeURIComponent(key);
            if (selectedChannels.has(decoded)) {
                selectedChannels.delete(decoded);
            } else {
                selectedChannels.add(decoded);
            }
            document.getElementById('selectAll').checked = selectedChannels.size === filteredChannels().length;
        }
        
        function toggleSelectAll() {
            const checked = document.getElementById('selectAll').checked;
            const channels = filteredChannels();
            if (checked) {
                channels.forEach(ch => selectedChannels.add(ch.key));
            } else {
                selectedChannels.clear();
            }
            renderChannels();
        }
        
        function selectCurrentPage() {
            const channels = filteredChannels();
            const start = (currentPage - 1) * pageSize;
            const end = start + pageSize;
            const pageChannels = channels.slice(start, end);
            pageChannels.forEach(ch => selectedChannels.add(ch.key));
            renderChannels();
        }
        
        function clearSelection() {
            selectedChannels.clear();
            document.getElementById('selectAll').checked = false;
            renderChannels();
        }
        
        function filteredChannels() {
            let channels = [...allChannels];
            const search = document.getElementById('searchInput').value.toLowerCase();
            if (search) {
                channels = channels.filter(ch => ch.name.toLowerCase().includes(search));
            }
            const activeCat = document.querySelector('.category-tag.active')?.textContent;
            if (activeCat && activeCat !== '全部') {
                channels = channels.filter(ch => ch.group === activeCat);
            }
            return channels;
        }
        
        function filterChannels() {
            currentPage = 1;
            const channels = filteredChannels();
            renderChannels();
            renderPagination();
            document.getElementById('filteredChannels').textContent = channels.length;
        }
        
        function filterByCategory(cat) {
            document.querySelectorAll('.category-tag').forEach(t => t.classList.remove('active'));
            event.target.classList.add('active');
            filterChannels();
        }
        
        async function createPlaylist() {
            const name = document.getElementById('playlistName').value;
            const search = document.getElementById('playlistSearch').value;
            const refreshTimesStr = document.getElementById('playlistRefreshTimes').value;
            const refreshTimes = refreshTimesStr.split(',').map(s => s.trim()).filter(Boolean);
            
            const body = { name };
            if (search) body.search = search;
            if (refreshTimes.length > 0) body.refreshTimes = refreshTimes;
            
            const res = await fetch('/api/playlist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (data.success) {
                alert('播放列表创建成功！');
                document.getElementById('playlistName').value = '';
                document.getElementById('playlistSearch').value = '';
                loadPlaylists();
            } else {
                alert('创建失败: ' + data.error);
            }
        }
        
        async function createPlaylistFromSelection() {
            if (selectedChannels.size === 0) {
                alert('请先选择频道');
                return;
            }
            const name = prompt('请输入播放列表名称:');
            if (!name) return;
            
            const res = await fetch('/api/playlist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, channelGroups: Array.from(selectedChannels) })
            });
            const data = await res.json();
            if (data.success) {
                alert('播放列表创建成功！已自动包含各频道的所有源地址');
                clearSelection();
                loadPlaylists();
            } else {
                alert('创建失败: ' + data.error);
            }
        }
        
        async function loadSources() {
            const res = await fetch('/api/sources');
            const data = await res.json();
            const table = document.getElementById('sourcesTable');
            table.innerHTML = data.sources.map(src => \`
                <tr>
                    <td>\${escapeHtml(src.name)}</td>
                    <td>\${escapeHtml(src.url || '-')}</td>
                    <td>\${escapeHtml(src.priority || 99)}</td>
                    <td>\${src.refreshTimes && src.refreshTimes.length > 0 ? src.refreshTimes.join(', ') : '05:00'}</td>
                    <td><span class="badge \${src.enabled ? 'badge-success' : 'badge-danger'}">\${src.enabled ? '启用' : '禁用'}</span></td>
                    <td>\${src.updatedAt ? new Date(src.updatedAt).toLocaleString('zh-CN') : '-'}<br><span style="font-size:10px;color:#9ca3af">\${src.createdAt ? new Date(src.createdAt).toLocaleString('zh-CN') : ''}</span></td>
                    <td class="actions">
                        <button class="btn btn-primary" onclick="refreshSingleSource('\${jsArg(src.id)}', '\${jsArg(src.name)}')">更新</button>
                        <button class="btn btn-secondary" onclick="editSource('\${jsArg(src.id)}')">编辑</button>
                        <button class="btn btn-danger" onclick="deleteSource('\${jsArg(src.id)}')">删除</button>
                    </td>
                </tr>
            \`).join('');
        }
        
        async function refreshSingleSource(id, name) {
            const btn = event.target;
            btn.disabled = true;
            btn.textContent = '更新中...';
            try {
                const res = await fetch('/api/source/' + id + '/refresh', { method: 'POST' });
                const data = await res.json();
                if (data.success) {
                    alert(decodeURIComponent(name) + ' 更新成功！频道数: ' + data.channelCount);
                    loadSources();
                    loadChannels();
                    loadStatus();
                } else {
                    alert('更新失败: ' + data.error);
                }
            } catch (err) {
                alert('更新失败: ' + err.message);
            } finally {
                btn.disabled = false;
                btn.textContent = '更新';
            }
        }
        
        async function addSource() {
            const name = document.getElementById('sourceName').value;
            const url = document.getElementById('sourceUrl').value;
            const priority = parseInt(document.getElementById('sourcePriority').value) || 99;
            const enabled = document.getElementById('sourceEnabled').checked;
            const refreshTimesStr = document.getElementById('sourceRefreshTimes').value;
            const refreshTimes = refreshTimesStr.split(',').map(s => s.trim()).filter(Boolean);
            
            if (!name || !url) {
                alert('请填写名称和URL');
                return;
            }
            
            const res = await fetch('/api/source', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, url, priority, enabled, refreshTimes })
            });
            const data = await res.json();
            if (data.success) {
                alert('数据源添加成功！正在刷新数据...');
                document.getElementById('sourceName').value = '';
                document.getElementById('sourceUrl').value = '';
                document.getElementById('sourcePriority').value = '99';
                document.getElementById('sourceRefreshTimes').value = '05:00';
                loadSources();
                await refreshData();
            } else {
                alert('添加失败: ' + data.error);
            }
        }
        
        async function editSource(id) {
            const res = await fetch('/api/source/' + id);
            const data = await res.json();
            document.getElementById('editSourceId').value = id;
            document.getElementById('editSourceName').value = data.name;
            document.getElementById('editSourceUrl').value = data.url;
            document.getElementById('editSourcePriority').value = data.priority || 99;
            document.getElementById('editSourceRefreshTimes').value = data.refreshTimes && data.refreshTimes.length > 0 ? data.refreshTimes.join(', ') : '05:00';
            document.getElementById('editSourceEnabled').checked = data.enabled;
            document.getElementById('editSourceModal').classList.remove('hidden');
        }
        
        function closeEditSourceModal() {
            document.getElementById('editSourceModal').classList.add('hidden');
        }
        
        async function saveSource() {
            const id = document.getElementById('editSourceId').value;
            const name = document.getElementById('editSourceName').value;
            const url = document.getElementById('editSourceUrl').value;
            const priority = parseInt(document.getElementById('editSourcePriority').value) || 99;
            const enabled = document.getElementById('editSourceEnabled').checked;
            const refreshTimesStr = document.getElementById('editSourceRefreshTimes').value;
            const refreshTimes = refreshTimesStr.split(',').map(s => s.trim()).filter(Boolean);
            
            const res = await fetch('/api/source/' + id, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, url, priority, enabled, refreshTimes })
            });
            const data = await res.json();
            if (data.success) {
                alert('数据源更新成功！');
                closeEditSourceModal();
                loadSources();
            } else {
                alert('更新失败: ' + data.error);
            }
        }
        
        async function deleteSource(id) {
            if (!confirm('确定要删除这个数据源吗？')) return;
            
            const res = await fetch('/api/source/' + id, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                loadSources();
            } else {
                alert('删除失败: ' + data.error);
            }
        }
        
        async function loadPlaylists() {
            const res = await fetch('/api/playlists');
            const data = await res.json();
            const table = document.getElementById('playlistsTable');
            if (data.playlists.length === 0) {
                table.innerHTML = '<tr><td colspan="7" class="loading">暂无播放列表</td></tr>';
                return;
            }
            table.innerHTML = data.playlists.map(pl => \`
                <tr>
                    <td>\${escapeHtml(pl.name)}\${pl.protected ? '<span class="fixed-badge">固定</span>' : ''}</td>
                    <td>\${pl.channelCount}</td>
                    <td>\${pl.refreshTimes && pl.refreshTimes.length > 0 ? pl.refreshTimes.join(', ') : '05:05'}</td>
                    <td>\${new Date(pl.createdAt).toLocaleString()}</td>
                    <td>\${pl.updatedAt ? new Date(pl.updatedAt).toLocaleString() : '-'}</td>
                    <td><a href="\${escapeHtml(pl.url)}" target="_blank">\${escapeHtml(pl.url)}</a></td>
                    <td class="actions">
                        \${pl.protected
                            ? '<button class="btn btn-primary" onclick="refreshPlaylist(' + jsArg(pl.id) + ', ' + jsArg(pl.name) + ')">更新</button>' +
                              '<button class="btn btn-secondary" onclick="editPlaylist(' + jsArg(pl.id) + ')">编辑频道</button>' +
                              '<span class="fixed-badge" title="固定播放列表，不可删除">不可删除</span>'
                            : '<button class="btn btn-primary" onclick="refreshPlaylist(' + jsArg(pl.id) + ', ' + jsArg(pl.name) + ')">更新</button>' +
                              '<button class="btn btn-secondary" onclick="editPlaylist(' + jsArg(pl.id) + ')">编辑频道</button>' +
                              '<button class="btn btn-danger" onclick="deletePlaylist(' + jsArg(pl.id) + ')">删除</button>'}
                    </td>
                </tr>
            \`).join('');
        }
        
        async function refreshPlaylist(id, name) {
            const btn = event.target;
            btn.disabled = true;
            btn.textContent = '更新中...';
            try {
                const res = await fetch('/api/playlist/' + id + '/refresh', { method: 'POST' });
                const data = await res.json();
                if (data.success) {
                    const msg = decodeURIComponent(name) + ' 更新成功！';
                    if (data.addedCount > 0) {
                        alert(msg + '新增 ' + data.addedCount + ' 个频道，总计 ' + data.newChannelCount + ' 个');
                    } else {
                        alert(msg + '频道数: ' + data.newChannelCount + '（无新增）');
                    }
                    loadPlaylists();
                } else {
                    alert('更新失败: ' + data.error);
                }
            } catch (err) {
                alert('更新失败: ' + err.message);
            } finally {
                btn.disabled = false;
                btn.textContent = '更新';
            }
        }
        
        async function editPlaylist(id) {
            const res = await fetch('/api/playlist/' + id);
            const data = await res.json();
            
            document.getElementById('editPlaylistId').value = id;
            document.getElementById('editPlaylistName').value = data.name;
            document.getElementById('editPlaylistUrl').textContent = window.location.origin + data.url;
            
            playlistEditor.selectedUrls = new Set(data.urls);
            playlistEditor.selected = data.channels || [];
            
            const allRes = await fetch('/api/channels');
            const allData = await allRes.json();
            playlistEditor.available = allData.channels.filter(ch => !playlistEditor.selectedUrls.has(ch.url));
            
            renderPlaylistEditor();
            document.getElementById('editPlaylistModal').classList.remove('hidden');
        }
        
        function renderPlaylistEditor() {
            const availableSearch = document.getElementById('availableSearch').value.toLowerCase();
            const filteredAvailable = playlistEditor.available.filter(ch => 
                ch.name.toLowerCase().includes(availableSearch)
            );
            
            const selectedSearch = document.getElementById('selectedSearch').value.toLowerCase();
            const filteredSelected = playlistEditor.selected.filter(ch => 
                ch.name.toLowerCase().includes(selectedSearch)
            );
            
            document.getElementById('availableChannels').innerHTML = filteredAvailable.map(ch => \`
                <div class="channel-item">
                    <button class="btn-add" onclick="addToPlaylist('\${jsArg(ch.url)}')">+</button>
                    <img class="channel-logo" src="\${escapeHtml(ch.tvgLogo || '')}" onerror="this.style.display='none'">
                    <div class="channel-info">
                        <div class="channel-name">\${escapeHtml(ch.name)}</div>
                        <div class="channel-group">\${escapeHtml(ch.group)}</div>
                    </div>
                </div>
            \`).join('');
            
            document.getElementById('selectedChannels').innerHTML = filteredSelected.map(ch => \`
                <div class="channel-item">
                    <button class="btn-remove" onclick="removeFromPlaylist('\${jsArg(ch.url)}')">-</button>
                    <img class="channel-logo" src="\${escapeHtml(ch.tvgLogo || '')}" onerror="this.style.display='none'">
                    <div class="channel-info">
                        <div class="channel-name">\${escapeHtml(ch.name)}</div>
                        <div class="channel-group">\${escapeHtml(ch.group)}</div>
                    </div>
                </div>
            \`).join('');
        }
        
        function filterAvailableChannels() {
            renderPlaylistEditor();
        }
        
        function filterSelectedChannels() {
            renderPlaylistEditor();
        }
        
        function addToPlaylist(url) {
            const decoded = decodeURIComponent(url);
            const channel = playlistEditor.available.find(ch => ch.url === decoded);
            if (channel) {
                playlistEditor.selected.push(channel);
                playlistEditor.selectedUrls.add(decoded);
                playlistEditor.available = playlistEditor.available.filter(ch => ch.url !== decoded);
                renderPlaylistEditor();
            }
        }
        
        function removeFromPlaylist(url) {
            const decoded = decodeURIComponent(url);
            const channel = playlistEditor.selected.find(ch => ch.url === decoded);
            if (channel) {
                playlistEditor.available.push(channel);
                playlistEditor.selectedUrls.delete(decoded);
                playlistEditor.selected = playlistEditor.selected.filter(ch => ch.url !== decoded);
                renderPlaylistEditor();
            }
        }
        
        function closeEditPlaylistModal() {
            document.getElementById('editPlaylistModal').classList.add('hidden');
            document.getElementById('availableSearch').value = '';
            document.getElementById('selectedSearch').value = '';
        }
        
        async function savePlaylist() {
            const id = document.getElementById('editPlaylistId').value;
            const name = document.getElementById('editPlaylistName').value;
            const urls = Array.from(playlistEditor.selectedUrls);
            
            const res = await fetch('/api/playlist/' + id, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, urls })
            });
            const data = await res.json();
            if (data.success) {
                alert('播放列表更新成功！');
                closeEditPlaylistModal();
                loadPlaylists();
            } else {
                alert('更新失败: ' + data.error);
            }
        }
        
        async function deletePlaylist(id) {
            if (!confirm('确定要删除这个播放列表吗？')) return;
            
            const res = await fetch('/api/playlist/' + id, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                loadPlaylists();
            } else {
                alert('删除失败: ' + data.error);
            }
        }
        
        // ===== 固定映射功能 =====
        
        async function loadMapping() {
            await loadMappingList();
            await loadUploadLogs();
            refreshFixedM3uUrl();
        }
        
        async function loadMappingList() {
            const list = document.getElementById('mappingList');
            list.innerHTML = '<div class="loading">加载中...</div>';
            
            try {
                const res = await fetch('/api/channel-mapping');
                const data = await res.json();
                document.getElementById('mappingCount').textContent = '(共 ' + data.count + ' 个频道)';
                
                if (data.count === 0) {
                    list.innerHTML = '<div class="loading">暂无映射，请上传 M3U 文件创建</div>';
                    return;
                }
                
                list.innerHTML = '<table class="table" id="mappingEditTable"><thead><tr><th style="width:30px"><input type="checkbox" id="mappingSelectAll" onchange="toggleAllMappings()"></th><th>频道名称</th><th>固定地址</th><th>实际播放地址</th><th>更新时间</th></tr></thead><tbody>' +
                    data.mappings.map(m => \`
                        <tr>
                            <td><input type="checkbox" class="mapping-checkbox" data-id="\${escapeHtml(m.id)}"></td>
                            <td><input type="text" class="name-input" data-id="\${escapeHtml(m.id)}" value="\${escapeHtml(m.name)}"></td>
                            <td><a href="/\${escapeHtml(m.id)}" target="_blank">/\${escapeHtml(m.id)}</a></td>
                            <td style="font-size:12px;word-break:break-all;max-width:250px">\${escapeHtml(m.url)}</td>
                            <td>\${new Date(m.updatedAt).toLocaleString()}</td>
                        </tr>
                    \`).join('') +
                    '</tbody></table>';
            } catch (err) {
                list.innerHTML = '<div class="loading">加载失败: ' + escapeHtml(err.message) + '</div>';
            }
        }
        
        function refreshFixedM3uUrl() {
            document.getElementById('fixedM3uUrl').textContent = window.location.origin + '/iptv2026.m3u';
        }
        
        // ===== 映射编辑功能 =====
        
        function toggleAllMappings() {
            const checked = document.getElementById('mappingSelectAll').checked;
            document.querySelectorAll('.mapping-checkbox').forEach(cb => cb.checked = checked);
        }
        
        async function saveMappingChanges() {
            const updates = [];
            document.querySelectorAll('.name-input').forEach(inp => {
                const id = inp.dataset.id;
                const val = inp.value.trim();
                // 获取当前显示的名称（从原始数据中获取）
                const origRow = inp.closest('tr');
                const origName = origRow ? origRow.querySelector('.name-input').defaultValue : '';
                if (val && val !== inp.defaultValue) {
                    updates.push({ id, name: val });
                }
            });
            
            if (updates.length === 0) {
                alert('没有检测到名称修改');
                return;
            }
            
            try {
                const res = await fetch('/api/channel-mapping/batch-update', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ updates, deletes: [] })
                });
                const data = await res.json();
                if (data.success) {
                    alert('已更新 ' + data.updated + ' 个频道名称');
                    loadMappingList();
                    loadUploadLogs();
                } else {
                    alert('保存失败: ' + data.error);
                }
            } catch (err) {
                alert('保存失败: ' + err.message);
            }
        }
        
        async function deleteSelectedMappings() {
            const checked = document.querySelectorAll('.mapping-checkbox:checked');
            if (checked.length === 0) {
                alert('请先选择要删除的频道');
                return;
            }
            if (!confirm('确定要删除选中的 ' + checked.length + ' 个频道映射吗？')) return;
            
            const deletes = Array.from(checked).map(cb => cb.dataset.id);
            
            try {
                const res = await fetch('/api/channel-mapping/batch-update', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ updates: [], deletes })
                });
                const data = await res.json();
                if (data.success) {
                    alert('已删除 ' + data.deleted + ' 个频道');
                    loadMappingList();
                    loadUploadLogs();
                } else {
                    alert('删除失败: ' + data.error);
                }
            } catch (err) {
                alert('删除失败: ' + err.message);
            }
        }
        
        async function uploadMapping() {
            const fileInput = document.getElementById('mappingFileInput');
            const status = document.getElementById('mappingUploadStatus');
            
            if (!fileInput.files || fileInput.files.length === 0) {
                status.textContent = '请先选择 M3U 文件';
                return;
            }
            
            status.textContent = '正在读取文件...';
            const file = fileInput.files[0];
            const reader = new FileReader();
            reader.onload = async function(e) {
                const content = e.target.result;
                if (!content || content.length < 20) {
                    status.textContent = '文件内容为空或格式不正确';
                    return;
                }
                status.textContent = '正在上传更新 (' + (content.length / 1024).toFixed(1) + ' KB)...';
                try {
                    const res = await fetch('/api/channel-mapping', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ content, pruneMissing: document.getElementById('pruneMissingMappings').checked })
                    });
                    const data = await res.json();
                    if (data.success) {
                        status.textContent = '更新成功！共 ' + data.totalChannels + ' 个频道，新增 ' + data.newChannels + ' 个，更新 ' + data.updatedChannels + ' 个' + (data.removedChannels ? '，删除 ' + data.removedChannels + ' 个' : '');
                        document.getElementById('mappingFileInput').value = '';
                        loadMappingList();
                        loadUploadLogs();
                    } else {
                        status.textContent = '更新失败: ' + data.error;
                    }
                } catch (err) {
                    status.textContent = '上传失败: ' + err.message;
                }
            };
            reader.onerror = function() {
                status.textContent = '文件读取失败';
            };
            reader.readAsText(file);
        }
        
        // ===== 上传日志 =====
        
        async function loadUploadLogs() {
            const el = document.getElementById('uploadLogList');
            try {
                const res = await fetch('/api/channel-mapping/logs');
                const data = await res.json();
                const logs = data.logs || [];
                if (logs.length === 0) {
                    el.innerHTML = '<div class="loading">暂无上传记录</div>';
                    return;
                }
                el.innerHTML = '<table class="table"><thead><tr><th>时间</th><th>状态</th><th>总频道</th><th>新增</th><th>更新</th><th>删除</th><th>错误信息</th></tr></thead><tbody>' +
                    logs.map(log => \`
                        <tr>
                            <td>\${new Date(log.time).toLocaleString()}</td>
                            <td><span class="badge \${log.success ? 'badge-success' : 'badge-danger'}">\${log.success ? '成功' : '失败'}</span></td>
                            <td>\${log.total}</td>
                            <td>\${log.new}</td>
                            <td>\${log.updated}</td>
                            <td>\${escapeHtml(log.removed || 0)}</td>
                            <td style="font-size:12px;color:#ef4444">\${escapeHtml(log.error || '-')}</td>
                        </tr>
                    \`).join('') +
                    '</tbody></table>';
            } catch (err) {
                el.innerHTML = '<div class="loading">加载失败: ' + escapeHtml(err.message) + '</div>';
            }
        }
        
        // ===== 清理缓存 =====
        
        async function clearCache() {
            if (!confirm('确定要清理缓存并重新加载数据吗？')) return;
            try {
                const res = await fetch('/api/clear-cache', { method: 'POST' });
                const data = await res.json();
                if (data.success) {
                    alert('缓存已清理，数据已重新加载');
                    loadStatus();
                    loadChannels();
                } else {
                    alert('清理失败: ' + data.error);
                }
            } catch (err) {
                alert('清理失败: ' + err.message);
            }
        }
        
        loadStatus();
        loadChannels();
    </script>
</body>
</html>
`;

addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request));
});

addEventListener('scheduled', event => {
    event.waitUntil((async () => {
        try {
            // 计算当前北京时间（注意：用北京时间日期而不是 UTC 日期）
            const d = new Date();
            const utcMs = d.getTime();
            const beijingMs = utcMs + 8 * 60 * 60 * 1000;
            const beijing = new Date(beijingMs);
            const nowDate = beijing.toISOString().slice(0, 10); // 北京时间日期
            const nowHour = beijing.getUTCHours();
            const nowMinute = beijing.getUTCMinutes();
            const nowTime = String(nowHour).padStart(2, '0') + ':' + String(nowMinute).padStart(2, '0');

            console.log('[定时检查] 当前北京时间:', nowDate, nowTime);

            let needRefreshSources = false;

            // 检查数据源是否需要刷新
            const sources = await getSources();
            for (const src of sources) {
                if (!src.enabled) continue;
                const times = Array.isArray(src.refreshTimes) && src.refreshTimes.length > 0 ? src.refreshTimes : ['05:00'];
                for (const t of times) {
                    if (t === nowTime) {
                        const lastKey = 'src_' + src.id + '_' + t;
                        const last = await SOURCES_KV.get('_lastRef_' + lastKey);
                        if (last !== nowDate) {
                            needRefreshSources = true;
                            await SOURCES_KV.put('_lastRef_' + lastKey, nowDate);
                            console.log('定时刷新数据源:', src.name, '时间:', t);
                        }
                    }
                }
            }

            // 如果有源到期，刷新所有源数据
            if (needRefreshSources) {
                await refreshAllSources();
            }

            // 检查播放列表是否需要刷新
            const playlists = await getPlaylists();
            const playlistResults = [];
            for (const [id, pl] of Object.entries(playlists)) {
                const times = Array.isArray(pl.refreshTimes) && pl.refreshTimes.length > 0 ? pl.refreshTimes : ['05:05'];
                let shouldRefresh = false;
                for (const t of times) {
                    if (t === nowTime) {
                        const lastKey = 'pl_' + id + '_' + t;
                        const last = await SOURCES_KV.get('_lastRef_' + lastKey);
                        if (last !== nowDate) {
                            shouldRefresh = true;
                            await SOURCES_KV.put('_lastRef_' + lastKey, nowDate);
                        }
                    }
                }
                if (shouldRefresh) {
                    try {
                        // 确保源数据是最新的（播放列表比源晚5分钟，此时源数据应已刷新）
                        if (!needRefreshSources) {
                            await refreshAllSources();
                        }
                        const r = await rematchPlaylist(id, pl);
                        // 清理缓存：尝试多种可能的 origin
                        const origins = ['http://localhost', 'https://localhost', 'http://127.0.0.1', 'http://192.168.100.88:8787', 'https://iptv.mhtc.top'];
                        for (const origin of origins) {
                            try { await invalidatePlaylistCache(origin, id); } catch {}
                        }
                        playlistResults.push({ id, name: pl.name, refreshed: true, count: r.newCount });
                        console.log('定时刷新播放列表:', pl.name, '时间:', nowTime);
                    } catch (err) {
                        playlistResults.push({ id, name: pl.name, refreshed: false, error: err.message });
                    }
                }
            }

            if (needRefreshSources || playlistResults.length > 0) {
                console.log('定时刷新完成:', JSON.stringify({
                    date: nowDate, time: nowTime,
                    sources: needRefreshSources ? '已刷新' : '无到期',
                    playlists: playlistResults
                }));
            }
        } catch (err) {
            console.error('定时刷新失败:', err.message || err);
        }
    })());
});
