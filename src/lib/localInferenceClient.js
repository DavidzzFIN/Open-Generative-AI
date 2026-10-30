// Frontend client for local inference — wraps window.localAI (Electron IPC).
// Two providers live behind the same surface:
//   - sd.cpp: bundled engine, downloads weights to disk, runs locally
//   - wan2gp: user-installed Wan2GP — a local folder (wgp.py CLI) or a remote MCP server
//   - webai: ChatGPT / Gemini web apps driven in the user's own Chromium-based browser
// Provider is read off the model entry's `provider` field.

import { getLocalModelById } from './localModels.js';

export const isLocalAIAvailable = () => typeof window !== 'undefined' && !!window.localAI?.isElectron;

// Electron wraps errors thrown in the main process as
// "Error invoking remote method 'x': Error: message" — keep only the message.
async function cleanIpcError(fn) {
    try {
        return await fn();
    } catch (err) {
        const msg = String(err?.message || err).replace(/^Error invoking remote method '[^']*':\s*(\w*Error:\s*)?/, '');
        throw new Error(msg);
    }
}

class LocalInferenceClient {
    // ── sd.cpp APIs ───────────────────────────────────────────────────────
    async getBinaryStatus() {
        if (!isLocalAIAvailable()) return { exists: false };
        return window.localAI.getBinaryStatus();
    }
    async downloadBinary() {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        return window.localAI.downloadBinary();
    }
    async downloadModel(modelId) {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        return window.localAI.downloadModel(modelId);
    }
    async downloadAuxiliary(auxKey) {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        return window.localAI.downloadAuxiliary(auxKey);
    }
    async deleteModel(modelId) {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        return window.localAI.deleteModel(modelId);
    }

    // ── Wan2GP APIs ───────────────────────────────────────────────────────
    // Config: { dir, python, url, mode, defaultPython } — a folder wins over a URL.
    async getWan2gpConfig() {
        if (!isLocalAIAvailable()) return { dir: '', python: '', url: '' };
        return window.localAI.wan2gp.getConfig();
    }
    async setWan2gpConfig(cfg) {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        return window.localAI.wan2gp.setConfig(cfg);
    }
    async setWan2gpUrl(url) {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        return window.localAI.wan2gp.setUrl(url);
    }
    // Local folder: `wgp.py --dry-run` on a test task. Remote URL: MCP probe.
    async checkWan2gp(cfg) {
        if (!isLocalAIAvailable()) return { ok: false, error: 'Not in desktop app' };
        return window.localAI.wan2gp.check(cfg);
    }
    async pickWan2gpFolder() {
        if (!isLocalAIAvailable()) return null;
        return window.localAI.wan2gp.pickFolder();
    }
    async probeWan2gp(url) {
        if (!isLocalAIAvailable()) return { ok: false, error: 'Not in desktop app' };
        return window.localAI.wan2gp.probe(url);
    }
    // Saves a start frame on disk and returns { url: file://…, path }. Local
    // runs pass the path to Wan2GP; remote runs upload it to the MCP server.
    async uploadFileToWan2gp(file) {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        const buf = await file.arrayBuffer();
        return window.localAI.wan2gp.uploadFile({
            name: file.name,
            type: file.type,
            bytes: new Uint8Array(buf),
        });
    }

    // ── Web session (ChatGPT / Gemini) APIs ───────────────────────────────
    async getWebAiConfig() {
        if (!isLocalAIAvailable()) return { browserPath: '' };
        return window.localAI.webai.getConfig();
    }
    async setWebAiConfig(cfg) {
        if (!isLocalAIAvailable()) throw new Error('Web AI only available in the desktop app.');
        return window.localAI.webai.setConfig(cfg);
    }
    async webAiStatus() {
        if (!isLocalAIAvailable()) return { browserFound: false, connected: false, sites: [] };
        return window.localAI.webai.status();
    }
    // Opens the site's tab in the user's browser so they can sign in.
    async openWebAiSite(siteId) {
        if (!isLocalAIAvailable()) throw new Error('Web AI only available in the desktop app.');
        return cleanIpcError(() => window.localAI.webai.openSite(siteId));
    }
    async revealWebAiDebug() {
        if (!isLocalAIAvailable()) return null;
        return window.localAI.webai.revealDebug();
    }
    async pickWebAiBrowser() {
        if (!isLocalAIAvailable()) return null;
        return window.localAI.webai.pickBrowser();
    }

    // ── Unified model list (both providers merged) ────────────────────────
    async listModels() {
        if (!isLocalAIAvailable()) return [];
        const [sdcpp, wan2gp] = await Promise.all([
            window.localAI.listModels(),
            window.localAI.wan2gp.listModels().catch(() => []),
        ]);
        return [
            ...sdcpp.map(m => ({ ...m, provider: m.provider || 'sdcpp' })),
            ...wan2gp,
        ];
    }

    // ── Provider-aware generate ───────────────────────────────────────────
    async generate(params) {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        const model = getLocalModelById(params.model);
        if (model?.provider === 'wan2gp') {
            return window.localAI.wan2gp.generate(params);
        }
        if (model?.provider === 'webai') {
            return cleanIpcError(() => window.localAI.webai.generate(params));
        }
        return window.localAI.generate(params);
    }

    cancelGeneration() {
        if (!isLocalAIAvailable()) return;
        // Ask both — only the running one reacts.
        window.localAI.cancelGeneration();
        window.localAI.wan2gp.cancelGeneration();
        window.localAI.webai?.cancelGeneration();
    }

    /**
     * Subscribe to generation progress events.
     * sd.cpp emits { step, totalSteps, progress, status }.
     * Wan2GP emits { progress, status, step?, totalSteps?, downloadedBytes? } with status
     * starting | downloading | loading | encoding | generating | decoding | saving | done.
     */
    onProgress(callback) {
        if (!isLocalAIAvailable()) return () => {};
        return window.localAI.onProgress(callback);
    }

    onDownloadProgress(callback) {
        if (!isLocalAIAvailable()) return () => {};
        return window.localAI.onDownloadProgress(callback);
    }
}

export const localAI = new LocalInferenceClient();
