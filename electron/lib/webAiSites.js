// Per-site configuration for the "web session" image provider.
//
// The provider drives the real ChatGPT / Gemini web UIs in the user's own
// Chromium-based browser (Chrome, Edge, Brave…), using the subscription the user
// is already logged in with. Both UIs change without notice, so every DOM
// assumption lives here as a selector list — when a site changes its markup,
// this is the only file to touch.

const SITES = {
    chatgpt: {
        id: 'chatgpt',
        name: 'ChatGPT',
        url: 'https://chatgpt.com/',
        hostMatch: /(^|\.)chatgpt\.com$|(^|\.)openai\.com$/,
        input: '#prompt-textarea',
        send: 'button[data-testid="send-button"]',
        busy: 'button[data-testid="stop-button"]',
        // Where generated images appear; the driver only looks inside this scope.
        imageScope: '[data-message-author-role="assistant"] img, article img, main img',
        lastReply: '[data-message-author-role="assistant"]',
        loggedOut: '[data-testid="login-button"], [data-testid="welcome-login-button"], a[href*="/auth/login"]',
        // ChatGPT only routes to its image tool when asked explicitly.
        buildPrompt: ({ prompt, aspectRatio }) =>
            `Create an image${aspectRatio ? ` (aspect ratio ${aspectRatio})` : ''}: ${prompt}`,
    },
    gemini: {
        id: 'gemini',
        name: 'Gemini',
        url: 'https://gemini.google.com/app',
        hostMatch: /(^|\.)gemini\.google\.com$/,
        input: 'rich-textarea .ql-editor, div.ql-editor[contenteditable="true"], div[contenteditable="true"][role="textbox"]',
        send: 'button.send-button, button[aria-label*="Send" i], button[aria-label*="Enviar" i]',
        busy: 'button.stop, button[aria-label*="Stop" i], button[aria-label*="Detener" i]',
        imageScope: 'generated-image img, single-image img, model-response img, message-content img, main img',
        lastReply: 'model-response, message-content',
        loggedOut: 'a[href*="accounts.google.com/ServiceLogin"], a[href*="accounts.google.com/signin"]',
        buildPrompt: ({ prompt, aspectRatio }) =>
            `Generate an image${aspectRatio ? ` (aspect ratio ${aspectRatio})` : ''}: ${prompt}`,
    },
};

// Catalog model id → site id. Mirrored in src/lib/localModels.js.
const MODEL_SITE = {
    'webai:chatgpt-image': 'chatgpt',
    'webai:gemini-image': 'gemini',
};

function siteForModel(modelId) {
    const siteId = MODEL_SITE[modelId];
    return siteId ? SITES[siteId] : null;
}

module.exports = { SITES, MODEL_SITE, siteForModel };
