/* global chrome */

import {
  CustomListenerName,
  EmitEventDetail,
  RequestEventDetail,
  RequestParams,
  ResponseEventDetail,
  YoursEventName,
} from './inject';

console.log('🌱 Anvil Wallet Loaded');

const script = document.createElement('script');
script.src = chrome.runtime.getURL('inject.js');
(document.head || document.documentElement).appendChild(script);

self.addEventListener(CustomListenerName.YOURS_REQUEST, (e: Event) => {
  const { type, messageId, params: originalParams = {} } = (e as CustomEvent<RequestEventDetail>).detail;
  if (!type) return;

  let params: RequestParams = {};

  if (type === YoursEventName.CONNECT) {
    params.appName =
      document.title ||
      (document.querySelector('meta[name="application-name"]') as HTMLMetaElement)?.content ||
      'Unknown';

    params.appIcon =
      (document.querySelector('link[rel="apple-touch-icon"]') as HTMLLinkElement)?.href ||
      (document.querySelector('link[rel="icon"]') as HTMLLinkElement)?.href ||
      '';
  }

  if (Array.isArray(originalParams)) {
    params.data = originalParams;
  } else if (typeof originalParams === 'object') {
    params = { ...params, ...originalParams };
  }

  // Use `host` (hostname + port) not `hostname` (port stripped). For
  // production HTTPS origins the two are equivalent — browsers strip
  // the default :443 — but for local development (vite on :5173, etc.)
  // the port is critical: BRC-73's manifest fetch resolves
  // `https://{domain}/manifest.json`, and `localhost` (no port) 404s
  // while `localhost:5173` succeeds. Existing whitelist entries
  // recorded under just `localhost` won't match new connections; the
  // user can clear those from Settings → Connected Apps and reconnect.
  params.domain = window.location.host;

  chrome.runtime.sendMessage({ action: type, params }, buildResponseCallback(messageId));
});

const buildResponseCallback = (messageId: string) => {
  return (response: ResponseEventDetail) => {
    const responseEvent = new CustomEvent(messageId, { detail: response });
    self.dispatchEvent(responseEvent);
  };
};

chrome.runtime.onMessage.addListener((message: EmitEventDetail) => {
  const { type, action, params } = message;
  if (type === CustomListenerName.YOURS_EMIT_EVENT) {
    const event = new CustomEvent(type, { detail: { action, params } });
    self.dispatchEvent(event);
  }
});
