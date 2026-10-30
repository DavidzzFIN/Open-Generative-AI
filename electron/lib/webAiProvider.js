// "Web session" image provider — generates images through the ChatGPT / Gemini web
// apps using the subscription the user is signed in with, instead of an API key.
//
// A Chromium-based browser (Chrome / Edge / Brave) is started with a dedicated
// profile and driven over its loopback DevTools port. The user signs in there once
// (we never see credentials); the profile keeps the session. See webAiBrowser.js.
//
// Requests run strictly one at a time with a pause between them: this drives a
// consumer UI, not an API, so it must behave like one person using it.
//
// Heads up: automating the consumer web apps is not covered by OpenAI's or
// Google's API terms and may conflict with their Terms of Use. The user decides
// whether to use their own account this way.

const { ipcMain, app, BrowserWindow, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { siteForModel, SITES } = require('./webAiSites');
const { findBrowser, ensureBrowser, defaultProfileDir, DEFAULT_PORT } = require('./webAiBrowser');
const { generateImage, openSitePage, WebAiError } = require('./webAiDriver');

const MIN_GAP_MS = 8000;

const DATA_DIR = () => path.join(app.getPath('userData'), 'web-ai');
const CONFIG_FILE = () => path.join(app.getPath('userData'), 'local-ai', 'webai.json');
const OUT_DIR = () => path.join(DATA_DIR(), 'outputs');
const DEBUG_DIR = () => path.join(DATA_DIR(), 'debug');

// ─── Config ───────────────────────────────────────────────────────────────────
function readConfig() {
    try { return { browserPath: '', ...JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf-8')) }; }
    catch { return { browserPath: '' }; }
}
function writeConfig(cfg) {
    const next = { browserPath: (cfg.browserPath || '').trim() };
    fs.mkdirSync(path.dirname(CONFIG_FILE()), { recursive: true });
    fs.writeFileSync(CONFIG_FILE(), JSON.stringify(next, null, 2));
    return next;
}

// ─── Browser connection ───────────────────────────────────────────────────────
let browser = null;

async function getBrowser() {
    if (browser && browser.connected) return browser;
    // Lazy: a missing/broken dependency must not stop the rest of the app from starting.
    const puppeteer = require('puppeteer-core');
    browser = await ensureBrowser({
        puppeteer,
        userDataDir: defaultProfileDir(DATA_DIR()),
        executablePath: findBrowser({ preferred: readConfig().browserPath }),
        port: DEFAULT_PORT,
    });
    browser.on('disconnected', () => { browser = null; });
    return browser;
}

// ─── Serialized generation ────────────────────────────────────────────────────
let tail = Promise.resolve();
let current = null;     // AbortController of the running job
let lastFinishedAt = 0;

function enqueue(job) {
    const run = tail.then(job, job);
    tail = run.catch(() => {});
    return run;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (data) => BrowserWindow.getAllWindows()[0]?.webContents.send('local-ai:progress', data);

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

function generate(params) {
    const site = siteForModel(params.model);
    if (!site) return Promise.reject(new Error(`Unknown web AI model: ${params.model}`));
    if (!params.prompt || !params.prompt.trim()) return Promise.reject(new Error('Prompt is empty.'));

    return enqueue(async () => {
        const abort = new AbortController();
        current = abort;
        try {
            const wait = lastFinishedAt + MIN_GAP_MS - Date.now();
            if (wait > 0) {
                send({ status: 'starting', progress: 0.01, message: 'Pacing requests…' });
                await sleep(wait);
            }
            if (abort.signal.aborted) throw new WebAiError('CANCELLED', 'Generation cancelled.');

            const b = await getBrowser();
            const out = await generateImage({
                browser: b,
                site,
                prompt: params.prompt,
                aspectRatio: params.aspect_ratio,
                onProgress: send,
                signal: abort.signal,
                debugDir: DEBUG_DIR(),
            });

            fs.mkdirSync(OUT_DIR(), { recursive: true });
            const file = path.join(OUT_DIR(), `${site.id}-${Date.now()}.${EXT[out.mime] || 'png'}`);
            fs.writeFileSync(file, out.buffer);
            send({ status: 'done', progress: 1, message: 'Done' });
            return {
                url: `data:${out.mime};base64,${out.buffer.toString('base64')}`,
                mediaType: 'image',
                path: file,
                width: out.width,
                height: out.height,
            };
        } finally {
            lastFinishedAt = Date.now();
            current = null;
        }
    });
}

function cancelGeneration() {
    current?.abort();
    return { ok: true };
}

// ─── Status / sign-in helpers ─────────────────────────────────────────────────
async function status() {
    const exe = findBrowser({ preferred: readConfig().browserPath });
    return {
        browserPath: exe,
        browserFound: !!exe,
        connected: !!(browser && browser.connected),
        sites: Object.values(SITES).map((s) => ({ id: s.id, name: s.name, url: s.url })),
    };
}

// Brings the site's tab to the front so the user can sign in.
async function openSite(siteId) {
    const site = SITES[siteId];
    if (!site) throw new Error(`Unknown site: ${siteId}`);
    const b = await getBrowser();
    const page = await openSitePage(b, site);
    if (!site.hostMatch.test(new URL(page.url() === 'about:blank' ? site.url : page.url()).hostname)) {
        await page.goto(site.url, { waitUntil: 'domcontentloaded' });
    } else if (page.url() === 'about:blank') {
        await page.goto(site.url, { waitUntil: 'domcontentloaded' });
    }
    await page.bringToFront();
    return { ok: true };
}

async function pickBrowser() {
    const win = BrowserWindow.getAllWindows()[0];
    const res = await dialog.showOpenDialog(win, {
        title: 'Select your Chrome / Edge / Brave executable',
        properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
}

// Opens the folder holding the last failure's screenshot + page report.
async function revealDebug() {
    fs.mkdirSync(DEBUG_DIR(), { recursive: true });
    await shell.openPath(DEBUG_DIR());
    return { path: DEBUG_DIR() };
}

function register() {
    ipcMain.handle('web-ai:get-config', () => readConfig());
    ipcMain.handle('web-ai:set-config', (_, cfg) => writeConfig(cfg || {}));
    ipcMain.handle('web-ai:status', () => status());
    ipcMain.handle('web-ai:open-site', (_, siteId) => openSite(siteId));
    ipcMain.handle('web-ai:pick-browser', () => pickBrowser());
    ipcMain.handle('web-ai:generate', (_, params) => generate(params));
    ipcMain.handle('web-ai:cancel-generation', () => cancelGeneration());
    ipcMain.handle('web-ai:reveal-debug', () => revealDebug());
}

module.exports = { register, generate, cancelGeneration };
