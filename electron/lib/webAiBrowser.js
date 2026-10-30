// Launches (or reuses) the user's own Chromium-based browser with a dedicated
// profile and a loopback DevTools port, then attaches puppeteer-core to it.
//
// Why not an Electron window: Google refuses to sign in from embedded browsers
// (Electron's user agent), and faking a user agent to get around that is exactly
// what we don't want to do. A normal Chrome/Edge/Brave started without any
// automation flags signs in like any other browser, and the profile directory
// keeps the session between runs.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PORT = 9333;

function candidatePaths(platform = process.platform, env = process.env) {
    if (platform === 'darwin') {
        return [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ];
    }
    if (platform === 'win32') {
        const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
        const rel = [
            'Google\\Chrome\\Application\\chrome.exe',
            'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
            'Microsoft\\Edge\\Application\\msedge.exe',
            'Chromium\\Application\\chrome.exe',
        ];
        return roots.flatMap((root) => rel.map((r) => path.join(root, r)));
    }
    return [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/brave-browser',
        '/usr/bin/microsoft-edge',
        '/usr/bin/microsoft-edge-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
    ];
}

// Order: explicit path (setting / env var) → well-known install locations.
function findBrowser({ preferred, env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
    const explicit = [preferred, env.WEBAI_BROWSER_PATH].filter(Boolean);
    for (const p of explicit) if (exists(p)) return p;
    for (const p of candidatePaths(platform, env)) if (exists(p)) return p;
    if (platform !== 'win32') {
        for (const bin of ['google-chrome', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge']) {
            const r = spawnSync('which', [bin], { encoding: 'utf-8' });
            const p = r.status === 0 ? r.stdout.trim() : '';
            if (p && exists(p)) return p;
        }
    }
    return null;
}

async function debuggerUrl(port, fetchImpl = fetch) {
    try {
        const res = await fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
        return res.ok ? `http://127.0.0.1:${port}` : null;
    } catch {
        return null;
    }
}

async function waitForDebugger(port, timeoutMs, fetchImpl) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const url = await debuggerUrl(port, fetchImpl);
        if (url) return url;
        await new Promise((r) => setTimeout(r, 400));
    }
    return null;
}

/**
 * Returns a connected puppeteer Browser, starting the user's browser if needed.
 * `puppeteer` is injected so tests can use their own copy and Electron can
 * lazy-require it (a missing module must not stop the app from starting).
 */
async function ensureBrowser({ puppeteer, userDataDir, executablePath, port = DEFAULT_PORT, fetchImpl = fetch, extraArgs = [] }) {
    let url = await debuggerUrl(port, fetchImpl);
    if (!url) {
        if (!executablePath) {
            throw new Error(
                'No Chromium-based browser found. Install Chrome, Edge or Brave, or set its path in Settings → Web AI.'
            );
        }
        fs.mkdirSync(userDataDir, { recursive: true });
        const args = [
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${userDataDir}`,
            '--no-first-run',
            '--no-default-browser-check',
            ...extraArgs,
        ];
        // Containers / CI run as root, where Chromium refuses to start without this.
        if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) {
            args.push('--no-sandbox');
        }
        const child = spawn(executablePath, args, { detached: true, stdio: 'ignore' });
        child.on('error', () => {});
        child.unref();
        url = await waitForDebugger(port, 20000, fetchImpl);
        if (!url) throw new Error(`The browser started but its debugging port ${port} never answered.`);
    }
    return puppeteer.connect({ browserURL: url, defaultViewport: null });
}

function defaultProfileDir(userDataPath) {
    return path.join(userDataPath || os.tmpdir(), 'web-ai-profile');
}

module.exports = { DEFAULT_PORT, candidatePaths, findBrowser, ensureBrowser, defaultProfileDir };
