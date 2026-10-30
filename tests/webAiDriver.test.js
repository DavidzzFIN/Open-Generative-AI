const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

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

// A tiny chat UI: contenteditable prompt, send button, a "stop" button while busy, and a
// generated image (plus a small avatar that must be ignored) appearing after a delay.
function mockPage({ mode }) {
    return `<!doctype html><html><body>
<div id="chat"><img id="avatar" width="40" height="40" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></div>
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
      const img = new Image(); img.src = png; $('#chat').appendChild(img);
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

const e2e = { skip: !puppeteer || !chromePath ? 'puppeteer-core or a Chromium browser is not available' : false };

test('generateImage types the prompt, waits for the new large image and downloads it', e2e, async () => {
    const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(mockPage({ mode: 'image' })); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'webai-test-'));
    const port = 9400 + Math.floor(Math.random() * 400);
    let browser;
    try {
        browser = await ensureBrowser({ puppeteer, userDataDir: profile, executablePath: chromePath, port, extraArgs: ['--headless=new'] });
        const progress = [];
        const out = await generateImage({
            browser,
            site: mockSite(`http://127.0.0.1:${server.address().port}/`),
            prompt: 'a red fox',
            aspectRatio: '1:1',
            timeoutMs: 30000,
            onProgress: (p) => progress.push(p.status),
        });
        assert.equal(out.mime, 'image/png');
        assert.equal(out.width, 600);
        assert.ok(out.buffer.length > 1000);
        assert.deepEqual([...out.buffer.subarray(1, 4)], [0x50, 0x4e, 0x47]); // PNG magic
        assert.ok(progress.includes('starting') && progress.includes('generating') && progress.includes('saving'));
        const [page] = (await browser.pages()).filter((p) => p.url().startsWith('http://127.0.0.1'));
        assert.equal(await page.evaluate(() => window.__sent), 'Create an image (1:1): a red fox');
    } finally {
        await browser?.disconnect();
        browser?.process?.()?.kill();
        const { execSync } = require('node:child_process');
        try { execSync(`pkill -f "remote-debugging-port=${port}"`); } catch { /* already gone */ }
        server.close();
    }
});

test('generateImage reports a text-only answer instead of hanging', e2e, async () => {
    const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(mockPage({ mode: 'text' })); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'webai-test-'));
    const port = 9400 + Math.floor(Math.random() * 400);
    let browser;
    try {
        browser = await ensureBrowser({ puppeteer, userDataDir: profile, executablePath: chromePath, port, extraArgs: ['--headless=new'] });
        await assert.rejects(
            generateImage({ browser, site: mockSite(`http://127.0.0.1:${server.address().port}/`), prompt: 'x', aspectRatio: '1:1', timeoutMs: 60000 }),
            (err) => err.code === 'NO_IMAGE' && /cannot create that image/.test(err.message)
        );
    } finally {
        await browser?.disconnect();
        const { execSync } = require('node:child_process');
        try { execSync(`pkill -f "remote-debugging-port=${port}"`); } catch { /* already gone */ }
        server.close();
    }
});
