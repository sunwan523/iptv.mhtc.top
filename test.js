const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const workerSource = fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8');

const sandbox = {
    console,
    URL,
    setTimeout,
    clearTimeout,
    addEventListener: () => {},
    fetch: () => {
        throw new Error('fetch should not be called in these tests');
    }
};
sandbox.globalThis = sandbox;

const exportSnippet = `
this.__testExports = {
  parseM3U,
  parseTXT,
  parseSourceContent,
  getChannelKey,
  mergeChannels,
  isSafeSourceUrl,
  escapeM3UAttr,
  escapeM3UName,
  replaceUrl
};
`;

vm.runInNewContext(workerSource + '\n' + exportSnippet, sandbox, { filename: 'worker.js' });
const t = sandbox.__testExports;

const m3u = '#EXTM3U\n' +
    '#EXTINF:-1 tvg-id="cctv1" tvg-logo="https://example.com/logo.png" group-title="新闻",CCTV-1\n' +
    'https://example.com/live/cctv1/index.m3u8\n';
assert.strictEqual(t.parseM3U(m3u).length, 1);
assert.strictEqual(t.parseM3U(m3u)[0].name, 'CCTV-1');
assert.strictEqual(t.parseM3U(m3u)[0].group, '新闻');

const txt = '新闻,#genre#\nCCTV-1,https://example.com/live/cctv1/index.m3u8\n';
assert.strictEqual(t.parseTXT(txt).length, 1);
assert.strictEqual(t.parseTXT(txt)[0].group, '新闻');

assert.strictEqual(t.getChannelKey('CCTV5+'), 'cctv5+');
assert.strictEqual(t.getChannelKey('CCTV-5高清'), 'cctv5');

assert.strictEqual(
    t.mergeChannels([
        [{ name: 'A', url: 'https://example.com/a' }],
        [{ name: 'B', url: 'https://example.com/a' }]
    ]).length,
    1
);

assert.strictEqual(t.isSafeSourceUrl('https://example.com/a.m3u'), true);
assert.strictEqual(t.isSafeSourceUrl('http://p.mhtc.top:3000/'), true);
assert.strictEqual(t.isSafeSourceUrl('http://192.168.100.1/a.m3u'), false);
assert.strictEqual(t.isSafeSourceUrl('http://10.0.0.1/a.m3u'), false);
assert.strictEqual(t.isSafeSourceUrl('http://169.254.169.254/latest/meta-data'), false);
assert.strictEqual(t.isSafeSourceUrl('http://localhost/a.m3u'), false);
assert.strictEqual(t.isSafeSourceUrl('http://[::1]/a.m3u'), false);
assert.strictEqual(t.isSafeSourceUrl('file:///etc/passwd'), false);

assert.strictEqual(t.escapeM3UName('a,b\nc'), 'a\uFF0Cb c');
assert.strictEqual(t.escapeM3UAttr('a"b\r\nc'), 'abc');

console.log('All tests passed');
