'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { parsePlaylist, probeUrl, isSelfBuiltUrl } = require('./server.js');

const execFileAsync = promisify(execFile);

function startServer(handler) {
    return new Promise(resolve => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

test('parsePlaylist parses M3U and TXT', () => {
    const m3u = '#EXTM3U\n' +
        '#EXTINF:-1 tvg-id="cctv1" group-title="新闻",CCTV-1\n' +
        'https://iptv.mhtc.top/01000000000000000000000001825531\n' +
        '#EXTINF:-1 group-title="体育",CCTV-5\n' +
        'http://192.168.100.1:4000/live/cctv5/index.m3u8\n';
    const parsed = parsePlaylist(m3u);
    assert.strictEqual(parsed.length, 2);
    assert.strictEqual(parsed[0].name, 'CCTV-1');
    assert.strictEqual(parsed[0].group, '新闻');
    assert.strictEqual(parsed[1].group, '体育');

    const txt = '新闻,#genre#\nCCTV-1,http://192.168.100.1:3000/cctv1.m3u8\n';
    const parsedTxt = parsePlaylist(txt);
    assert.strictEqual(parsedTxt.length, 1);
    assert.strictEqual(parsedTxt[0].name, 'CCTV-1');
    assert.strictEqual(parsedTxt[0].url, 'http://192.168.100.1:3000/cctv1.m3u8');
});

test('isSelfBuiltUrl detects self-built hosts', () => {
    assert.strictEqual(isSelfBuiltUrl('http://192.168.100.1:4000/live/a.m3u8'), true);
    assert.strictEqual(isSelfBuiltUrl('http://192.168.100.1:3000/a'), true);
    assert.strictEqual(isSelfBuiltUrl('https://iptv.mhtc.top/01000000000000000000000001825531'), true);
    assert.strictEqual(isSelfBuiltUrl('https://example.com/live/a.m3u8'), false);
});

test('probeUrl checks playable HLS, redirects, and failures', async () => {
    const server = await startServer((req, res) => {
        if (req.url === '/ok.m3u8') {
            res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
            res.end('#EXTM3U\n#EXTINF:-1,CCTV-1\nhttp://127.0.0.1/ts');
        } else if (req.url === '/bad.m3u8') {
            res.writeHead(500);
            res.end('error');
        } else if (req.url === '/empty') {
            res.writeHead(200, { 'Content-Length': '0' });
            res.end();
        } else if (req.url === '/redirect.m3u8') {
            res.writeHead(302, { Location: '/ok.m3u8' });
            res.end();
        } else if (req.url === '/html') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html>ok</html>');
        } else {
            res.writeHead(404);
            res.end('not found');
        }
    });
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
        const ok = await probeUrl(base + '/ok.m3u8', 3000);
        assert.strictEqual(ok.ok, true);
        assert.match(ok.contentType, /mpegurl/);

        const redirect = await probeUrl(base + '/redirect.m3u8', 3000);
        assert.strictEqual(redirect.ok, true);
        assert.strictEqual(redirect.finalUrl, base + '/ok.m3u8');

        const html = await probeUrl(base + '/html', 3000);
        assert.strictEqual(html.ok, true);

        const bad = await probeUrl(base + '/bad.m3u8', 3000);
        assert.strictEqual(bad.ok, false);
        assert.strictEqual(bad.status, 500);

        const empty = await probeUrl(base + '/empty', 3000);
        assert.strictEqual(empty.ok, false);
        assert.match(empty.error || '', /为空/);
    } finally {
        server.close();
    }
});

test('runCheck end-to-end via --check-once', async () => {
    const server = await startServer((req, res) => {
        if (req.url === '/ok.m3u8') {
            res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
            res.end('#EXTM3U\n#EXTINF:-1,Test A\nhttp://127.0.0.1/ts');
        } else if (req.url === '/bad.m3u8') {
            res.writeHead(500);
            res.end('error');
        } else if (req.url === '/playlist.m3u') {
            res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
            res.end('#EXTM3U\n' +
                '#EXTINF:-1 group-title="测试",Test A\n' +
                'http://127.0.0.1:' + server.address().port + '/ok.m3u8\n' +
                '#EXTINF:-1 group-title="测试",Test B\n' +
                'http://127.0.0.1:' + server.address().port + '/bad.m3u8\n');
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html>ok</html>');
        }
    });

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-checker-test-'));
    const configFile = path.join(tmp, 'config.json');
    const stateFile = path.join(tmp, 'state.json');
    const port = server.address().port;
    fs.writeFileSync(configFile, JSON.stringify({
        port: 0,
        checkIntervalSeconds: 300,
        timeoutMs: 3000,
        concurrency: 2,
        openBrowserOnStart: false,
        alertOnAllFailures: false,
        reAlertMinutes: 30,
        playlistUrls: ['http://127.0.0.1:' + port + '/playlist.m3u'],
        selfBuiltHosts: ['127.0.0.1'],
        baseEndpoints: ['http://127.0.0.1:' + port]
    }), 'utf8');

    try {
        const { stdout } = await execFileAsync(process.execPath, [path.join(__dirname, 'server.js'), '--check-once'], {
            env: Object.assign({}, process.env, {
                IPTV_CHECKER_CONFIG: configFile,
                IPTV_CHECKER_STATE: stateFile,
                IPTV_CHECKER_NO_NOTIFY: '1'
            }),
            timeout: 15000,
            encoding: 'utf8'
        });
        const report = JSON.parse(stdout);
        assert.strictEqual(report.totalChannels, 2, stdout);
        assert.strictEqual(report.okCount, 1);
        assert.strictEqual(report.failureCount, 1);
        assert.strictEqual(report.selfBuiltFailureCount, 1);
        assert.strictEqual(report.baseFailureCount, 0);
        assert.strictEqual(report.failures[0].name, 'Test B');
    } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
