'use strict';

const $ = selector => document.querySelector(selector);
let appData = { config: {}, state: {} };
let pollTimer = null;

function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[ch]);
}

function fmtTime(iso) {
    if (!iso) return '-';
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

function fmtDuration(ms) {
    if (ms == null) return '-';
    return ms + ' ms';
}

function statusBadge(status) {
    if (status === 'ok') return '<span class="badge ok">正常</span>';
    return '<span class="badge bad">故障</span>';
}

function sourceBadge(selfBuilt) {
    return selfBuilt
        ? '<span class="badge self">自建</span>'
        : '<span class="badge ext">外网</span>';
}

function renderBaseEndpoints() {
    const entries = Object.values(appData.state.baseEndpoints || {});
    const box = $('#baseList');
    const summary = $('#baseSummary');
    if (entries.length === 0) {
        box.innerHTML = '<div class="muted">暂无自建服务配置</div>';
        summary.textContent = '-';
        return;
    }
    const okCount = entries.filter(e => e.ok).length;
    summary.textContent = okCount + ' / ' + entries.length + ' 个服务正常';
    box.innerHTML = entries.map(e => `
        <div class="endpoint">
            <div class="endpoint-main">
                <div class="endpoint-url" title="${escapeHtml(e.url)}">${escapeHtml(e.url)}</div>
                <div class="endpoint-meta">${escapeHtml(fmtTime(e.checkedAt))} · ${escapeHtml(fmtDuration(e.durationMs))}</div>
            </div>
            <div class="endpoint-status">
                ${statusBadge(e.ok ? 'ok' : 'fail')}
                <small title="${escapeHtml(e.error || '')}">${escapeHtml(e.status || (e.error || '-'))}</small>
            </div>
        </div>
    `).join('');
}

function filteredChannels() {
    const type = $('#filterType').value;
    const status = $('#filterStatus').value;
    const keyword = $('#searchInput').value.trim().toLowerCase();
    return (appData.state.channels || []).filter(ch => {
        if (type === 'self' && !ch.selfBuilt) return false;
        if (type === 'external' && ch.selfBuilt) return false;
        if (status === 'fail' && ch.status === 'ok') return false;
        if (status === 'ok' && ch.status !== 'ok') return false;
        if (keyword && !String(ch.name || '').toLowerCase().includes(keyword)) return false;
        return true;
    });
}

function renderChannels() {
    const channels = filteredChannels();
    const body = $('#channelBody');
    $('#tableEmpty').style.display = channels.length ? 'none' : 'block';
    body.innerHTML = channels.slice(0, 500).map(ch => `
        <tr>
            <td>
                <div class="channel-name">${escapeHtml(ch.name || '-')}</div>
                <div class="url-cell" title="${escapeHtml(ch.url)}">${escapeHtml(ch.url)}</div>
            </td>
            <td>${sourceBadge(ch.selfBuilt)}</td>
            <td>${statusBadge(ch.status)}${ch.failureStreak > 1 ? ` <span class="muted">连败 ${ch.failureStreak}</span>` : ''}</td>
            <td>${ch.statusCode || '-'}</td>
            <td>${escapeHtml(fmtDuration(ch.durationMs))}</td>
            <td>${escapeHtml(fmtTime(ch.lastOkAt))}</td>
            <td class="error-cell" title="${escapeHtml(ch.error || '')}">${escapeHtml(ch.error || '-')}</td>
        </tr>
    `).join('');
}

function renderHistory() {
    const list = $('#historyList');
    const history = appData.state.history || [];
    if (history.length === 0) {
        list.innerHTML = '<div class="muted">还没有检测记录</div>';
        return;
    }
    list.innerHTML = history.slice(0, 10).map(h => `
        <div class="mini-item">
            <div class="line">
                <strong>${escapeHtml(fmtTime(h.at))}</strong>
                <span class="muted">${escapeHtml(fmtDuration(h.durationMs))}</span>
            </div>
            <div class="metrics">
                <span>频道 ${h.totalChannels || 0}</span>
                <span>正常 ${h.okCount || 0}</span>
                <span class="fail">故障 ${h.failureCount || 0}</span>
                <span>自建故障 ${h.selfBuiltFailureCount || 0}</span>
                ${h.baseFailureCount ? `<span class="fail">服务 ${h.baseFailureCount}</span>` : ''}
            </div>
        </div>
    `).join('');
}

function renderAlerts() {
    const list = $('#alertList');
    const alerts = appData.state.alerts || [];
    if (alerts.length === 0) {
        list.innerHTML = '<div class="muted">暂无提醒记录</div>';
        return;
    }
    list.innerHTML = alerts.slice(0, 10).map(a => `
        <div class="mini-item">
            <div class="line">
                <strong>${escapeHtml(fmtTime(a.at))}</strong>
                <span class="fail">${a.count} 个故障</span>
            </div>
            <div class="message">${escapeHtml(a.message)}</div>
        </div>
    `).join('');
}

function renderStats() {
    const s = appData.state;
    const last = s.lastCheck || {};
    $('#lastCheckAt').textContent = fmtTime(last.at);
    $('#lastCheckMeta').textContent = last.durationMs != null ? '耗时 ' + last.durationMs + ' ms' : (s.running ? '检测中...' : '尚未检测');
    $('#channelTotal').textContent = s.channels ? s.channels.length : 0;
    $('#channelMeta').textContent = '正常 ' + (last.okCount || 0) + ' · 故障 ' + (last.failureCount || 0);
    $('#selfFailures').textContent = last.selfBuiltFailureCount || 0;
    $('#baseFailureMeta').textContent = '自建服务故障 ' + (last.baseFailureCount || 0);
    $('#nextCheckAt').textContent = s.autoCheck ? fmtTime(s.nextCheckAt) : '已暂停';
    $('#runState').textContent = s.running ? '正在检测' : (s.autoCheck ? '自动检测' : '手动检测');
}

function renderSettings() {
    const cfg = appData.config || {};
    if (document.activeElement !== $('#intervalInput')) $('#intervalInput').value = cfg.checkIntervalSeconds || 300;
    if (document.activeElement !== $('#reAlertInput')) $('#reAlertInput').value = cfg.reAlertMinutes || 30;
    $('#alertAllInput').checked = Boolean(cfg.alertOnAllFailures);
    $('#notifyInput').checked = cfg.enableNotifications !== false;
}

function render() {
    const s = appData.state || {};
    const badge = $('#autoBadge');
    badge.textContent = s.autoCheck ? '自动检测中' : '已暂停';
    badge.className = 'badge ' + (s.autoCheck ? 'ok' : 'warn');
    $('#toggleBtn').textContent = s.autoCheck ? '暂停检测' : '开始检测';
    renderStats();
    renderBaseEndpoints();
    renderChannels();
    renderHistory();
    renderAlerts();
    renderSettings();
}

async function refresh() {
    try {
        const res = await fetch('/api/state');
        appData = await res.json();
        render();
    } catch (err) {
        console.error('加载状态失败:', err);
    }
}

async function postJson(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
    });
    return res.json();
}

$('#checkNowBtn').addEventListener('click', async () => {
    const btn = $('#checkNowBtn');
    btn.disabled = true;
    btn.textContent = '检测中...';
    try {
        await postJson('/api/check');
        setTimeout(() => refresh(), 500);
    } catch (err) {
        console.error(err);
    }
    setTimeout(() => {
        btn.disabled = false;
        btn.textContent = '立即检测';
    }, 5000);
});

$('#toggleBtn').addEventListener('click', async () => {
    const next = !appData.state.autoCheck;
    try {
        await postJson('/api/toggle', { autoCheck: next });
        await refresh();
    } catch (err) {
        console.error(err);
    }
});

$('#shutdownBtn').addEventListener('click', async () => {
    if (!confirm('确定要完全退出检测器吗？退出后可用桌面快捷方式重新启动。')) return;
    const btn = $('#shutdownBtn');
    btn.disabled = true;
    btn.textContent = '退出中...';
    try {
        await postJson('/api/shutdown');
    } catch (err) {
        console.error(err);
    }
    if (pollTimer) window.clearInterval(pollTimer);
    document.body.innerHTML = '<div class="shutdown-screen"><strong>检测器已退出</strong><p>可以关闭本页面，或用桌面快捷方式重新启动。</p></div>';
});

$('#settingsForm').addEventListener('submit', async event => {
    event.preventDefault();
    const interval = Math.min(86400, Math.max(30, Number($('#intervalInput').value) || 300));
    const reAlert = Math.min(1440, Math.max(1, Number($('#reAlertInput').value) || 30));
    try {
        await postJson('/api/config', {
            checkIntervalSeconds: interval,
            reAlertMinutes: reAlert,
            alertOnAllFailures: $('#alertAllInput').checked,
            enableNotifications: $('#notifyInput').checked
        });
        const status = $('#settingsStatus');
        status.textContent = '设置已保存';
        setTimeout(() => { status.textContent = ''; }, 2500);
        await refresh();
    } catch (err) {
        console.error(err);
    }
});

$('#filterType').addEventListener('change', renderChannels);
$('#filterStatus').addEventListener('change', renderChannels);
$('#searchInput').addEventListener('input', renderChannels);

refresh();
pollTimer = setInterval(refresh, 5000);
