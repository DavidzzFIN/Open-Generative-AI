// Drives one image generation in a ChatGPT / Gemini tab (see webAiSites.js).
// Pure puppeteer-core logic: it receives an already-connected Browser, so it can
// be exercised in tests against a mock page without Electron.

const fs = require('fs');
const path = require('path');

const MIN_IMAGE_PX = 400;       // skips avatars, icons and thumbnails
const POLL_MS = 1000;
const STABLE_POLLS = 3;         // same image set + not busy for this many polls = done
const TEXT_ONLY_POLLS = 20;     // reply stopped changing, no image: refusal / quota message
const LOGIN_SETTLE_MS = 1500;

class WebAiError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'WebAiError';
        this.code = code;
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openSitePage(browser, site) {
    for (const page of await browser.pages()) {
        try {
            if (site.hostMatch.test(new URL(page.url()).hostname)) return page;
        } catch { /* about:blank etc. */ }
    }
    return browser.newPage();
}

// 'ready' once the prompt box is there and no login prompt shows; 'loggedOut' otherwise.
async function waitForInputOrLogin(page, site, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let inputSeenAt = 0;
    while (Date.now() < deadline) {
        const state = await page.evaluate((input, loggedOut) => ({
            hasInput: !!document.querySelector(input),
            loggedOut: !!document.querySelector(loggedOut) || location.hostname === 'accounts.google.com',
        }), site.input, site.loggedOut).catch(() => null);
        if (state) {
            if (state.loggedOut) return 'loggedOut';
            if (state.hasInput) {
                inputSeenAt ||= Date.now();
                // Login buttons render a beat after the prompt box (ChatGPT works as a guest).
                if (Date.now() - inputSeenAt >= LOGIN_SETTLE_MS) return 'ready';
            }
        }
        await sleep(300);
    }
    throw new WebAiError('PAGE_NOT_READY', `${site.name} did not show its prompt box in time. Is the page loading, or did the site change?`);
}

function pageSnapshotFn(imageScope, busySel, replySel, minPx, baseline) {
    const base = new Set(baseline);
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const pick = (nodes) => [...nodes]
        .filter((img) => img.complete && img.naturalWidth >= minPx && img.naturalHeight >= minPx && visible(img))
        .map((img) => ({ src: img.currentSrc || img.src, w: img.naturalWidth, h: img.naturalHeight }))
        .filter((i) => i.src && !base.has(i.src));
    // Sites reshuffle their markup (Gemini's A/B answer view lives outside the usual
    // containers), so when the scoped lookup finds nothing, look at every image: the
    // chat is fresh and `baseline` already excludes what was on the page before.
    let images = pick(document.querySelectorAll(imageScope));
    if (!images.length) images = pick(document.images);
    const replies = replySel ? [...document.querySelectorAll(replySel)] : [];
    const last = replies[replies.length - 1];
    return {
        busy: [...document.querySelectorAll(busySel)].some(visible),
        images,
        reply: last ? (last.innerText || '').trim().slice(0, 300) : '',
    };
}

async function typePrompt(page, site, text) {
    const flat = text.replace(/\s*\n+\s*/g, ' ').trim();
    const ok = await page.evaluate((sel, value) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        el.focus();
        if (el.isContentEditable) {
            document.execCommand('selectAll', false);
            document.execCommand('insertText', false, value);
            return (el.innerText || '').trim().length > 0;
        }
        const proto = Object.getPrototypeOf(el);
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return el.value.length > 0;
    }, site.input, flat);
    if (!ok) throw new WebAiError('INPUT_FAILED', `Could not type the prompt into ${site.name}'s prompt box.`);
}

async function clickSend(page, site) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        const clicked = await page.evaluate((sel) => {
            const btn = document.querySelector(sel);
            if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
            btn.click();
            return true;
        }, site.send);
        if (clicked) return;
        await sleep(250);
    }
    await page.keyboard.press('Enter'); // button selector may be stale; Enter sends on both sites
}

// googleusercontent URLs end in a size directive (=s512-rj); =s0 asks for the original.
function fullResVariants(src) {
    try {
        const u = new URL(src);
        if (/googleusercontent\.com$/.test(u.hostname) && /=[swh]\d[^/=]*$/.test(src)) {
            return [src.replace(/=[swh]\d[^/=]*$/, '=s0'), src];
        }
    } catch { /* data:/blob: URLs */ }
    return [src];
}

function parseDataUrl(dataUrl) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
    if (!m) throw new Error('not a data URL');
    return { mime: m[1] || 'image/png', buffer: Buffer.from(m[3], m[2] ? 'base64' : 'utf8') };
}

// Fetch with the page's own cookies; if the CDN blocks cross-origin reads, open the
// image in its own tab and screenshot it.
async function downloadImage(browser, page, src) {
    for (const candidate of fullResVariants(src)) {
        try {
            const dataUrl = await page.evaluate(async (url) => {
                const res = await fetch(url, { credentials: 'include' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const blob = await res.blob();
                return new Promise((resolve, reject) => {
                    const fr = new FileReader();
                    fr.onload = () => resolve(fr.result);
                    fr.onerror = () => reject(fr.error);
                    fr.readAsDataURL(blob);
                });
            }, candidate);
            const out = parseDataUrl(dataUrl);
            if (out.buffer.length > 2048) return out;
        } catch { /* try next variant / fallback */ }
    }
    let failure = 'fetch blocked';
    if (!/^blob:|^data:/.test(src)) {
        const tab = await browser.newPage();
        try {
            await tab.goto(src, { waitUntil: 'load', timeout: 30000 });
            const img = await tab.$('img');
            if (!img) throw new Error('no image element');
            return { buffer: Buffer.from(await img.screenshot({ type: 'png' })), mime: 'image/png' };
        } catch (err) {
            failure = err.message;
        } finally {
            await tab.close().catch(() => {});
        }
    }
    // Last resort: screenshot the <img> where it is rendered (display size, but always works).
    try {
        const marked = await page.evaluate((url) => {
            const img = [...document.images].find((i) => (i.currentSrc || i.src) === url);
            if (!img) return false;
            img.scrollIntoView({ block: 'center' });
            img.setAttribute('data-webai-target', '1');
            return true;
        }, src);
        const el = marked && await page.$('[data-webai-target]');
        if (!el) throw new Error('image element not found on the page');
        return { buffer: Buffer.from(await el.screenshot({ type: 'png' })), mime: 'image/png' };
    } catch (err) {
        throw new WebAiError('DOWNLOAD_FAILED', `Could not download the generated image (${failure}; ${err.message}).`);
    }
}

// Saves what the page looked like when a run failed, so a broken selector can be diagnosed.
async function dumpDebug(page, dir, err) {
    fs.mkdirSync(dir, { recursive: true });
    const info = await page.evaluate(() => {
        const trail = (el) => { const t = []; for (let n = el.parentElement; n && t.length < 5; n = n.parentElement) t.push(n.tagName.toLowerCase()); return t.join('<'); };
        return {
            url: location.href,
            title: document.title,
            images: [...document.images].map((i) => ({
                src: (i.currentSrc || i.src).slice(0, 140),
                w: i.naturalWidth, h: i.naturalHeight, complete: i.complete,
                shown: i.getBoundingClientRect().width > 0,
                inside: trail(i),
            })),
            buttons: [...document.querySelectorAll('button')]
                .filter((b) => b.getBoundingClientRect().width > 0)
                .map((b) => (b.getAttribute('aria-label') || b.innerText || '').trim().slice(0, 40))
                .filter(Boolean).slice(0, 60),
        };
    });
    fs.writeFileSync(path.join(dir, 'last-failure.json'), JSON.stringify({
        time: new Date().toISOString(),
        error: { code: err.code, message: err.message },
        ...info,
    }, null, 2));
    await page.screenshot({ path: path.join(dir, 'last-failure.png') }).catch(() => {});
}

/**
 * @returns {Promise<{buffer: Buffer, mime: string, width: number, height: number, src: string}>}
 */
async function generateImage(opts) {
    const { browser, site, onProgress = () => {}, debugDir } = opts;
    onProgress({ status: 'starting', progress: 0.02, message: `Opening ${site.name}…` });
    const page = await openSitePage(browser, site);
    try {
        return await generateOnPage(browser, page, opts);
    } catch (err) {
        if (debugDir && err.code !== 'CANCELLED') await dumpDebug(page, debugDir, err).catch(() => {});
        throw err;
    }
}

async function generateOnPage(browser, page, { site, prompt, aspectRatio, timeoutMs = 180000, onProgress = () => {}, signal }) {
    const checkAbort = () => { if (signal?.aborted) throw new WebAiError('CANCELLED', 'Generation cancelled.'); };

    await page.bringToFront();
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 }); // fresh chat: no old images in scope
    checkAbort();

    const state = await waitForInputOrLogin(page, site, 45000);
    if (state === 'loggedOut') {
        throw new WebAiError('NOT_LOGGED_IN', `Sign in to ${site.name} in the browser window that just opened, then press Generate again.`);
    }

    const baseline = await page.evaluate((scope) => (
        [...document.querySelectorAll(scope)].map((i) => i.currentSrc || i.src)
    ), site.imageScope);

    onProgress({ status: 'generating', progress: 0.08, message: `Sending prompt to ${site.name}…` });
    await typePrompt(page, site, site.buildPrompt({ prompt, aspectRatio }));
    await clickSend(page, site);

    const started = Date.now();
    let lastKey = '';
    let stable = 0;
    let lastReply = '';
    let replyStable = 0;
    for (;;) {
        checkAbort();
        const elapsed = Date.now() - started;
        if (elapsed > timeoutMs) {
            throw new WebAiError('TIMEOUT', `${site.name} produced no image within ${Math.round(timeoutMs / 1000)}s.${lastReply ? ` Last reply: "${lastReply}"` : ''}`);
        }
        await sleep(POLL_MS);
        const snap = await page.evaluate(pageSnapshotFn, site.imageScope, site.busy, site.lastReply, MIN_IMAGE_PX, baseline);

        onProgress({
            status: 'generating',
            progress: 0.1 + 0.8 * (1 - Math.exp(-elapsed / 40000)),
            message: snap.images.length ? 'Image ready, finishing…' : `${site.name} is generating…`,
        });

        const key = snap.images.map((i) => i.src).sort().join('|');
        if (snap.images.length && !snap.busy && key === lastKey) {
            if (++stable >= STABLE_POLLS) {
                const best = snap.images.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
                onProgress({ status: 'saving', progress: 0.95, message: 'Downloading image…' });
                const { buffer, mime } = await downloadImage(browser, page, best.src);
                return { buffer, mime, width: best.w, height: best.h, src: best.src };
            }
        } else {
            stable = 0;
        }
        lastKey = key;

        // No image, not busy, reply text frozen: the site answered with words (refusal, quota, error).
        if (!snap.images.length && !snap.busy && snap.reply) {
            replyStable = snap.reply === lastReply ? replyStable + 1 : 0;
            if (replyStable >= TEXT_ONLY_POLLS) {
                throw new WebAiError('NO_IMAGE', `${site.name} answered without an image: "${snap.reply}"`);
            }
        } else {
            replyStable = 0;
        }
        lastReply = snap.reply || lastReply;
    }
}

module.exports = { WebAiError, generateImage, openSitePage, fullResVariants, parseDataUrl };
