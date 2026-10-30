const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { execSync } = require('node:child_process');

const { findBrowser, candidatePaths, ensureBrowser } = require('../electron/lib/webAiBrowser');
const { fullResVariants, parseDataUrl, generateImage } = require('../electron/lib/webAiDriver');
const { siteForModel } = require('../electron/lib/webAiSites');

// ── Pure helpers ─────────────────────────────────────────────────────────────
test('siteForModel maps catalog ids and rejects unknown ones', () => {
    assert.equal(siteForModel('webai:chatgpt-image').id, 'chatgpt');
    assert.equal(siteForModel('webai:gemini-image').id, 'gemini');
    assert.equal(siteForModel('z-image-turbo'), null);
});

test('chatgpt/gemini prompts ask for an image and carry the aspect ratio', () => {
    for (const id of ['webai:chatgpt-image', 'webai:gemini-image']) {
        const text = siteForModel(id).buildPrompt({ prompt: 'a red fox', aspectRatio: '16:9' });
        assert.match(text, /image/i);
        assert.match(text, /16:9/);
        assert.match(text, /a red fox/);
    }
});

test('fullResVariants upgrades googleusercontent size directives and keeps the original as fallback', () => {
    assert.deepEqual(
        fullResVariants('https://lh3.googleusercontent.com/gg-dl/abc=s1024-rj'),
        ['https://lh3.googleusercontent.com/gg-dl/abc=s0', 'https://lh3.googleusercontent.com/gg-dl/abc=s1024-rj']
    );
    assert.deepEqual(fullResVariants('https://chatgpt.com/backend-api/estuary/content?id=x'), ['https://chatgpt.com/backend-api/estuary/content?id=x']);
    assert.deepEqual(fullResVariants('blob:null/123'), ['blob:null/123']);
});

test('parseDataUrl decodes base64 payloads', () => {
    const { mime, buffer } = parseDataUrl(`data:image/png;base64,${Buffer.from('hello').toString('base64')}`);
    assert.equal(mime, 'image/png');
    assert.equal(buffer.toString(), 'hello');
});

test('findBrowser prefers an explicit path, then well-known locations, else null', () => {
    const exists = (set) => (p) => set.includes(p);
    assert.equal(findBrowser({ preferred: '/custom/chrome', env: {}, platform: 'linux', exists: exists(['/custom/chrome', '/usr/bin/chromium']) }), '/custom/chrome');
    assert.equal(findBrowser({ env: { WEBAI_BROWSER_PATH: '/env/brave' }, platform: 'linux', exists: exists(['/env/brave']) }), '/env/brave');
    assert.equal(findBrowser({ env: {}, platform: 'darwin', exists: exists([candidatePaths('darwin')[0]]) }), candidatePaths('darwin')[0]);
    assert.equal(findBrowser({ env: {}, platform: 'win32', exists: () => false }), null);
});

// ── End-to-end against a mock chat page ──────────────────────────────────────
let puppeteer = null;
try { puppeteer = require('puppeteer-core'); } catch { /* optional in CI */ }
const chromePath = findBrowser();
const e2e = { skip: !puppeteer || !chromePath ? 'puppeteer-core or a Chromium browser is not available' : false };

function crc32(buf) {
    let crc = 0xffffffff;
    for (const b of buf) {
        crc ^= b;
        for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function makePng(w, h) {
    const chunk = (type, data) => {
        const body = Buffer.concat([Buffer.from(type), data]);
        const out = Buffer.alloc(8 + data.length + 4);
        out.writeUInt32BE(data.length, 0);
        body.copy(out, 4);
        out.writeUInt32BE(crc32(body), 8 + data.length);
        return out;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    const row = Buffer.alloc(1 + w * 3, 0x80);
    row[0] = 0;
    const raw = Buffer.concat(Array.from({ length: h }, () => row));
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]);
}

// A tiny chat UI: contenteditable prompt, send button, a "stop" button while busy, and a
// generated image (plus a small avatar that must be ignored) appearing after a delay.
//   mode 'image'  → a 600px image appears in <target>
//   mode 'text'   → only a refusal sentence appears
//   imgSrc        → image URL; default is a canvas data URL
function mockPage({ mode, target = 'chat', imgSrc = '', blobImage = false }) {
    return `<!doctype html><html><body>
<div id="chat"><img id="avatar" width="40" height="40" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></div>
<div id="elsewhere"></div>
<div id="p" contenteditable="true" role="textbox"></div>
<button id="send">send</button><button id="stop" style="display:none">stop</button>
<div id="reply"></div>
<script>
const $ = (s) => document.querySelector(s);
const png = (() => { const c = document.createElement('canvas'); c.width = 600; c.height = 600;
  const x = c.getContext('2d'); x.fillStyle = '#c33'; x.fillRect(0,0,600,600); x.fillStyle='#fff'; x.fillRect(100,100,400,400);
  return c.toDataURL('image/png'); })();
$('#send').onclick = () => {
  window.__sent = $('#p').innerText;
  $('#stop').style.display = 'block';
  setTimeout(() => {
    $('#stop').style.display = 'none';
    if ('${mode}' === 'image') {
      const img = new Image();
      if (${blobImage}) {
        // Like Gemini: a blob: URL, shown smaller than its real size.
        const c2 = document.createElement('canvas'); c2.width = 600; c2.height = 600;
        const x2 = c2.getContext('2d'); x2.fillStyle = '#36c'; x2.fillRect(0, 0, 600, 600);
        c2.toBlob((b) => { img.src = URL.createObjectURL(b); img.style.width = '300px'; $('#${target}').appendChild(img); });
      } else {
        img.src = '${imgSrc}' || png; $('#${target}').appendChild(img);
      }
    } else {
      $('#reply').innerText = 'Sorry, I cannot create that image.';
    }
  }, 1500);
};
</script></body></html>`;
}

function mockSite(url) {
    return {
        id: 'mock', name: 'Mock', url,
        hostMatch: /^127\.0\.0\.1$/,
        input: '#p', send: '#send', busy: '#stop',
        imageScope: '#chat img', lastReply: '#reply',
        loggedOut: '#login',
        buildPrompt: ({ prompt, aspectRatio }) => `Create an image (${aspectRatio}): ${prompt}`,
    };
}

// Serves the mock chat (and, on a second origin with no CORS headers, a PNG — like Google's CDN).
async function withMock(pageOpts, fn) {
    const png = makePng(600, 600);
    const cdn = http.createServer((req, res) => { res.setHeader('content-type', 'image/png'); res.end(png); });
    await new Promise((r) => cdn.listen(0, '127.0.0.1', r));
    const cdnUrl = `http://127.0.0.1:${cdn.address().port}/fox.png`;
    const web = http.createServer((req, res) => {
        res.setHeader('content-type', 'text/html');
        // 'none' blocks every fetch(), which is what stops the driver reading a blob: URL.
        if (pageOpts.blobImage) res.setHeader('content-security-policy', "connect-src 'none'; img-src 'self' data: blob:");
        res.end(mockPage({ ...pageOpts, imgSrc: pageOpts.crossOrigin ? cdnUrl : '' }));
    });
    await new Promise((r) => web.listen(0, '127.0.0.1', r));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'webai-test-'));
    const port = 9400 + Math.floor(Math.random() * 400);
    let browser;
    try {
        browser = await ensureBrowser({ puppeteer, userDataDir: profile, executablePath: chromePath, port, extraArgs: ['--headless=new'] });
        return await fn({ browser, site: mockSite(`http://127.0.0.1:${web.address().port}/`), profile });
    } finally {
        await browser?.disconnect();
        try { execSync(`pkill -f "remote-debugging-port=${port}"`); } catch { /* already gone */ }
        web.close(); cdn.close();
    }
}

const assertPng = (out) => {
    assert.equal(out.mime, 'image/png');
    assert.ok(out.buffer.length > 1000);
    assert.deepEqual([...out.buffer.subarray(1, 4)], [0x50, 0x4e, 0x47]); // PNG magic
};

test('generateImage types the prompt, waits for the new large image and downloads it', e2e, () =>
    withMock({ mode: 'image' }, async ({ browser, site }) => {
        const progress = [];
        const out = await generateImage({
            browser, site, prompt: 'a red fox', aspectRatio: '1:1', timeoutMs: 30000,
            onProgress: (p) => progress.push(p.status),
        });
        assertPng(out);
        assert.equal(out.width, 600);
        assert.ok(progress.includes('starting') && progress.includes('generating') && progress.includes('saving'));
        const [page] = (await browser.pages()).filter((p) => p.url().startsWith('http://127.0.0.1'));
        assert.equal(await page.evaluate(() => window.__sent), 'Create an image (1:1): a red fox');
    }));

test('finds the image even when the site renders it outside the expected container', e2e, () =>
    withMock({ mode: 'image', target: 'elsewhere' }, async ({ browser, site }) => {
        assertPng(await generateImage({ browser, site, prompt: 'x', aspectRatio: '1:1', timeoutMs: 30000 }));
    }));

test('downloads a cross-origin image whose CDN blocks reads from the page (no CORS)', e2e, () =>
    withMock({ mode: 'image', crossOrigin: true }, async ({ browser, site }) => {
        const out = await generateImage({ browser, site, prompt: 'x', aspectRatio: '1:1', timeoutMs: 30000 });
        assertPng(out);
        assert.equal(out.width, 600);
    }));

test('reads a blob: image at full resolution when the page blocks fetch (CSP)', e2e, () =>
    withMock({ mode: 'image', blobImage: true }, async ({ browser, site }) => {
        const out = await generateImage({ browser, site, prompt: 'x', aspectRatio: '1:1', timeoutMs: 30000 });
        assertPng(out);
        // Shown at 300px, but the canvas copy must carry the real 600px pixels.
        assert.equal(out.buffer.readUInt32BE(16), 600);
    }));

test('reports a text-only answer instead of hanging, and saves a diagnostics report', e2e, () =>
    withMock({ mode: 'text' }, async ({ browser, site, profile }) => {
        const debugDir = path.join(profile, 'debug');
        await assert.rejects(
            generateImage({ browser, site, prompt: 'x', aspectRatio: '1:1', timeoutMs: 60000, debugDir }),
            (err) => err.code === 'NO_IMAGE' && /cannot create that image/.test(err.message)
        );
        const report = JSON.parse(fs.readFileSync(path.join(debugDir, 'last-failure.json'), 'utf-8'));
        assert.equal(report.error.code, 'NO_IMAGE');
        assert.ok(report.images.length >= 1 && 'inside' in report.images[0], 'lists the page images');
        assert.ok(report.buttons.includes('send'));
        assert.ok(fs.statSync(path.join(debugDir, 'last-failure.png')).size > 500);
    }));
