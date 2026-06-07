// background/index.js
// ─────────────────────────────────────────────────────────────────────────────
// Cross-browser compatibility shim
// Wraps chrome.* APIs so they work identically in Chrome, Firefox, Edge, and
// Safari. Firefox exposes `browser` (Promise-based); all others use `chrome`
// (callback-based). This thin shim normalises everything to Promises without
// requiring a build step or npm dependency.
// ─────────────────────────────────────────────────────────────────────────────
const _api = (() => {
  // Firefox already provides a promise-based `browser` global.
  if (typeof browser !== "undefined" && browser.runtime) return browser;
  // Chrome / Edge / Safari — wrap callback APIs in Promises.
  const promisify = (fn) => (...args) =>
    new Promise((resolve, reject) => {
      fn(...args, (result) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(result);
      });
    });

  return {
    runtime: {
      ...chrome.runtime,
      sendMessage: promisify(chrome.runtime.sendMessage.bind(chrome.runtime)),
      getURL: chrome.runtime.getURL.bind(chrome.runtime),
      onMessage: chrome.runtime.onMessage,
      onInstalled: chrome.runtime.onInstalled,
      onStartup: chrome.runtime.onStartup,
      lastError: chrome.runtime.lastError,
    },
    storage: {
      session: {
        get: promisify(chrome.storage.session.get.bind(chrome.storage.session)),
        set: promisify(chrome.storage.session.set.bind(chrome.storage.session)),
        remove: promisify(chrome.storage.session.remove.bind(chrome.storage.session)),
      },
      local: {
        get: promisify(chrome.storage.local.get.bind(chrome.storage.local)),
        set: promisify(chrome.storage.local.set.bind(chrome.storage.local)),
      },
    },
    alarms: {
      create: chrome.alarms.create.bind(chrome.alarms),
      clear: promisify(chrome.alarms.clear.bind(chrome.alarms)),
      onAlarm: chrome.alarms.onAlarm,
    },
    tabs: {
      sendMessage: (...args) =>
        new Promise((resolve) => {
          try {
            chrome.tabs.sendMessage(...args, (response) => {
              if (chrome.runtime.lastError) {
                resolve({ ok: false, error: chrome.runtime.lastError.message });
              } else {
                resolve(response ?? { ok: true });
              }
            });
          } catch (e) {
            resolve({ ok: false, error: e.message });
          }
        }),
    },
    windows: chrome.windows,
    scripting: chrome.scripting,
    webNavigation: chrome.webNavigation,
  };
})();

// ─────────────────────────────────────────────────────────────────────────────

_api.runtime.onInstalled.addListener(() => {
  console.debug("Password Manager background service worker installed");
});

let derivedKey = null;

// FIX: Changed from 5 min to 10 min as intended
const AUTO_LOCK_MS = 10 * 60 * 1000;
const AUTO_LOCK_ALARM = "pm_auto_lock";
const LAST_ACTIVITY_KEY = "password-manager-last-activity";
const DEFAULT_CREDENTIALS_KEY = "password-manager-default-credentials";
const PENDING_SAVE_KEY = "password-manager-pending-save";
const REMEMBER_ME_KEY = "password-manager-remember-me";

const API_BASE = "http://localhost:3001/api";
const SESSION_KEY = "password-manager-session";

const KEY_CHECK_PLAINTEXT = "pm:vault-key-check:v1";

// ─────────────────────────────────────────────────────────────────────────────
// Storage helpers (all use the compatibility shim)
// ─────────────────────────────────────────────────────────────────────────────

async function storageSessionGet(key) {
  try {
    const result = await _api.storage.session.get(key);
    return result?.[key] ?? null;
  } catch {
    return null;
  }
}

async function storageSessionGetMany(keys) {
  try {
    return (await _api.storage.session.get(keys)) || {};
  } catch {
    return {};
  }
}

async function storageSessionSet(key, value) {
  try {
    await _api.storage.session.set({ [key]: value });
  } catch {
    // session storage unavailable (e.g. Firefox MV2 fallback) — silently ignore
  }
}

async function storageSessionRemove(keys) {
  try {
    await _api.storage.session.remove(keys);
  } catch {}
}

async function storageLocalGet(key) {
  try {
    const result = await _api.storage.local.get(key);
    return result?.[key] ?? null;
  } catch {
    return null;
  }
}

async function storageLocalSet(key, value) {
  try {
    await _api.storage.local.set({ [key]: value });
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-lock
// FIX: Always check rememberMe before scheduling or firing the alarm.
//      The previous code ran scheduleAutoLockFromLastActivity() unconditionally
//      on startup which created an alarm even for "remember me" users.
// ─────────────────────────────────────────────────────────────────────────────

async function scheduleAutoLockFromLastActivity() {
  // FIX: Check rememberMe FIRST — never schedule if the user opted out of auto-lock
  const rememberMe = await storageLocalGet(REMEMBER_ME_KEY);
  if (rememberMe === true) {
    await _api.alarms.clear(AUTO_LOCK_ALARM);
    return;
  }

  const lastActivity = await storageSessionGet(LAST_ACTIVITY_KEY);

  if (!derivedKey || typeof lastActivity !== "number") {
    await _api.alarms.clear(AUTO_LOCK_ALARM);
    return;
  }

  // FIX: Add a small buffer (+500 ms) so the alarm never fires fractionally
  //      early due to timer imprecision — the onAlarm handler still does the
  //      definitive idle check, so the extra half-second is harmless.
  const when = lastActivity + AUTO_LOCK_MS + 500;
  _api.alarms.create(AUTO_LOCK_ALARM, { when });
}

async function touchActivity() {
  if (!derivedKey) return;

  await storageSessionSet(LAST_ACTIVITY_KEY, Date.now());

  const rememberMe = await storageLocalGet(REMEMBER_ME_KEY);
  if (rememberMe === true) {
    // FIX: Actively clear any stale alarm that may have been set before
    //      rememberMe was enabled, instead of just skipping scheduling.
    await _api.alarms.clear(AUTO_LOCK_ALARM);
    return;
  }

  await scheduleAutoLockFromLastActivity();
}

async function lockNow(reason) {
  derivedKey = null;
  await storageSessionRemove([LAST_ACTIVITY_KEY]);
  await _api.alarms.clear(AUTO_LOCK_ALARM);
  console.debug("Vault locked:", reason);
}

_api.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== AUTO_LOCK_ALARM) return;

  if (!derivedKey) {
    await _api.alarms.clear(AUTO_LOCK_ALARM);
    return;
  }

  // FIX: Re-check rememberMe here too — the preference may have been toggled
  //      while an alarm was already queued.
  const rememberMe = await storageLocalGet(REMEMBER_ME_KEY);
  if (rememberMe === true) {
    await _api.alarms.clear(AUTO_LOCK_ALARM);
    return;
  }

  const lastActivity = await storageSessionGet(LAST_ACTIVITY_KEY);
  if (typeof lastActivity !== "number") return;

  const idleFor = Date.now() - lastActivity;
  if (idleFor >= AUTO_LOCK_MS) {
    await lockNow("idle");
    return;
  }

  // Not yet idle — reschedule for the remaining time
  await scheduleAutoLockFromLastActivity();
});

// FIX: On startup, only schedule if vault is actually unlocked AND rememberMe
//      is off. The old code ran unconditionally and could create a phantom alarm.
_api.runtime.onStartup?.addListener(async () => {
  if (!derivedKey) return;
  const rememberMe = await storageLocalGet(REMEMBER_ME_KEY);
  if (rememberMe !== true) {
    void scheduleAutoLockFromLastActivity();
  }
});

// Initial schedule attempt — safe because scheduleAutoLockFromLastActivity
// now guards against rememberMe and missing derivedKey internally.
void scheduleAutoLockFromLastActivity();

// ─────────────────────────────────────────────────────────────────────────────
// Crypto utilities
// ─────────────────────────────────────────────────────────────────────────────

function hexToBytes(hex) {
  if (typeof hex !== "string") throw new Error("Salt must be a hex string");
  const normalized = hex.trim().toLowerCase();
  if (normalized.length % 2 !== 0) throw new Error("Invalid hex salt length");
  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < out.length; i++) {
    const value = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(value)) throw new Error("Invalid hex salt");
    out[i] = value;
  }
  return out;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(base64) {
  if (typeof base64 !== "string") throw new Error("Invalid base64");
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function aesGcmEncrypt(key, plaintextBytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintextBytes);
  return {
    ciphertextBase64: bytesToBase64(new Uint8Array(ciphertext)),
    ivBase64: bytesToBase64(iv),
  };
}

async function aesGcmDecrypt(key, ciphertextBase64, ivBase64) {
  const ciphertext = base64ToBytes(ciphertextBase64);
  const iv = base64ToBytes(ivBase64);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new Uint8Array(plaintext);
}

async function deriveVaultKey(masterPassword, saltHex) {
  const encoder = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex), iterations: 200_000 },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function createKeyCheck(masterPassword, saltHex) {
  const key = await deriveVaultKey(masterPassword, saltHex);
  const bytes = new TextEncoder().encode(KEY_CHECK_PLAINTEXT);
  const { ciphertextBase64, ivBase64 } = await aesGcmEncrypt(key, bytes);
  return { keyCheckCiphertext: ciphertextBase64, keyCheckIv: ivBase64 };
}

async function verifyKeyCheck(key, keyCheckCiphertext, keyCheckIv) {
  const bytes = await aesGcmDecrypt(key, keyCheckCiphertext, keyCheckIv);
  const text = new TextDecoder().decode(bytes);
  if (text !== KEY_CHECK_PLAINTEXT) throw new Error("Master password is incorrect");
}

// ─────────────────────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────────────────────

async function apiRequest(path, token, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
    body: options.body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || "Request failed");
  return data;
}

async function readAuthToken() {
  const result = await storageSessionGetMany([SESSION_KEY]);
  const session = result?.[SESSION_KEY] ?? null;
  const token = typeof session?.token === "string" ? session.token : "";
  return token || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Credential helpers
// ─────────────────────────────────────────────────────────────────────────────

function coerceString(value) {
  return typeof value === "string" ? value : "";
}

function normalizeUsername(value) {
  return typeof value === "string" ? value.trim() : "";
}

function usernamesEqual(a, b) {
  const left = normalizeUsername(a).toLowerCase();
  const right = normalizeUsername(b).toLowerCase();
  if (!left || !right) return false;
  return left === right;
}

function maskUsername(value) {
  const username = normalizeUsername(value);
  return username || "(no username)";
}

function computeBaseDomain(hostname) {
  if (typeof hostname !== "string") return null;
  const parts = hostname.split(".").filter(Boolean);
  if (parts.length < 2) return hostname;
  return parts.slice(-2).join(".");
}

async function decryptCredentialPayload(ciphertextBase64, ivBase64) {
  if (!derivedKey) throw new Error("Vault is locked");
  const bytes = await aesGcmDecrypt(derivedKey, ciphertextBase64, ivBase64);
  const text = new TextDecoder().decode(bytes);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error("Credential payload is not valid JSON"); }
  const username = typeof parsed?.username === "string" ? parsed.username : "";
  const password = typeof parsed?.password === "string" ? parsed.password : "";
  if (!password) throw new Error("Credential payload missing password");
  return { username, password };
}

async function encryptCredentialPayload(username, password) {
  if (!derivedKey) throw new Error("Vault is locked");
  const payload = JSON.stringify({ username: username || "", password });
  const bytes = new TextEncoder().encode(payload);
  const { ciphertextBase64, ivBase64 } = await aesGcmEncrypt(derivedKey, bytes);
  return { ciphertext: ciphertextBase64, iv: ivBase64 };
}

async function decryptCredentialRecord(cred) {
  const id = typeof cred?.id === "string" ? cred.id : "";
  const domain = typeof cred?.domain === "string" ? cred.domain : "";
  const ciphertext = typeof cred?.ciphertext === "string" ? cred.ciphertext : "";
  const iv = typeof cred?.iv === "string" ? cred.iv : "";
  if (!id || !ciphertext || !iv) return null;
  const decrypted = await decryptCredentialPayload(ciphertext, iv);
  return { id, domain, ciphertext, iv, createdAt: cred?.createdAt, decrypted };
}

async function listCredentialRecordsForHostname(token, hostname) {
  let credentials = await apiRequest(`/credentials/domain/${encodeURIComponent(hostname)}`, token);
  if (!Array.isArray(credentials) || credentials.length === 0) {
    const base = computeBaseDomain(hostname);
    if (base && base !== hostname) {
      credentials = await apiRequest(`/credentials/domain/${encodeURIComponent(base)}`, token);
    }
  }
  if (!Array.isArray(credentials)) return [];
  const out = [];
  for (const cred of credentials) {
    try {
      const record = await decryptCredentialRecord(cred);
      if (record) out.push(record);
    } catch {}
  }
  return out;
}

async function listAllCredentialRecords(token) {
  const credentials = await apiRequest("/credentials", token);
  if (!Array.isArray(credentials)) return [];
  const out = [];
  for (const cred of credentials) {
    try {
      const record = await decryptCredentialRecord(cred);
      if (record) out.push(record);
    } catch {}
  }
  return out;
}

async function listAllCredentialRecordsWithKey(token, key) {
  const credentials = await apiRequest("/credentials", token);
  if (!Array.isArray(credentials)) return [];
  const out = [];
  for (const cred of credentials) {
    try {
      const bytes = await aesGcmDecrypt(key, cred.ciphertext, cred.iv);
      const text = new TextDecoder().decode(bytes);
      const { username, password } = JSON.parse(text);
      out.push({ id: cred.id, domain: cred.domain, decrypted: { username: username || "", password } });
    } catch {}
  }
  return out;
}

function summarizeCredential(record, defaultCredentialId) {
  return {
    id: record.id,
    domain: record.domain,
    username: record.decrypted?.username || "",
    usernameLabel: maskUsername(record.decrypted?.username),
    createdAt: record.createdAt,
    isDefault: !!defaultCredentialId && record.id === defaultCredentialId,
  };
}

async function getDefaultCredentialId(hostname) {
  const defaults = (await storageLocalGet(DEFAULT_CREDENTIALS_KEY)) || {};
  const base = computeBaseDomain(hostname);
  return defaults?.[hostname] || (base ? defaults?.[base] : null) || null;
}

async function setDefaultCredentialId(hostname, credentialId) {
  const defaults = (await storageLocalGet(DEFAULT_CREDENTIALS_KEY)) || {};
  const base = computeBaseDomain(hostname);
  defaults[hostname] = credentialId;
  if (base) defaults[base] = credentialId;
  await storageLocalSet(DEFAULT_CREDENTIALS_KEY, defaults);
}

async function updateCredential(token, id, username, password) {
  const { ciphertext, iv } = await encryptCredentialPayload(username, password);
  await apiRequest(`/credentials/${encodeURIComponent(id)}`, token, {
    method: "PUT",
    body: JSON.stringify({ ciphertext, iv }),
  });
}

async function createCredential(token, domain, username, password) {
  const { ciphertext, iv } = await encryptCredentialPayload(username, password);
  return apiRequest("/credentials", token, {
    method: "POST",
    body: JSON.stringify({ domain, ciphertext, iv }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Save prompt window
// ─────────────────────────────────────────────────────────────────────────────

async function openSavePrompt(pending) {
  await storageSessionSet(PENDING_SAVE_KEY, pending);
  const url = _api.runtime.getURL("public/save-prompt.html");
  if (_api.windows && typeof _api.windows.create === "function") {
    _api.windows.create({ url, type: "popup", width: 430, height: 620, focused: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab / scripting helpers
// ─────────────────────────────────────────────────────────────────────────────

function sendMessageToTab(tabId, message) {
  return _api.tabs.sendMessage(tabId, message);
}

function getTabFrames(tabId) {
  if (!chrome.webNavigation || typeof chrome.webNavigation.getAllFrames !== "function") {
    return Promise.resolve([]);
  }
  return new Promise((resolve) => {
    try {
      chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
        if (chrome.runtime.lastError) { resolve([]); return; }
        resolve(Array.isArray(frames) ? frames : []);
      });
    } catch { resolve([]); }
  });
}

async function sendMessageToTabFrames(tabId, message) {
  const mainResponse = await sendMessageToTab(tabId, message);
  if (mainResponse?.ok) return mainResponse;

  const frames = await getTabFrames(tabId);
  for (const frame of frames) {
    const frameId = typeof frame?.frameId === "number" ? frame.frameId : null;
    if (frameId === null || frameId === 0) continue;
    const response = await new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(tabId, message, { frameId }, (resp) => {
          if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
          resolve(resp ?? { ok: true });
        });
      } catch (e) { resolve({ ok: false, error: e.message }); }
    });
    if (response?.ok) return response;
  }
  return mainResponse;
}

function isInjectableUrl(url) {
  return typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"));
}

function injectContentScript(tabId, url) {
  if (!isInjectableUrl(url)) return Promise.resolve({ ok: false, error: "This page does not allow autofill." });
  if (!chrome.scripting || typeof chrome.scripting.executeScript !== "function") {
    return Promise.resolve({ ok: false, error: "Scripting API not available." });
  }
  return new Promise((resolve) => {
    try {
      chrome.scripting.executeScript(
        { target: { tabId, allFrames: true }, files: ["src/content/index.js"] },
        () => {
          if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
          resolve({ ok: true });
        }
      );
    } catch (e) { resolve({ ok: false, error: e instanceof Error ? e.message : "Unable to inject content script" }); }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Message router
// ─────────────────────────────────────────────────────────────────────────────

_api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;

  if (message.type === "ACTIVITY" || message.type === "SESSION_STARTED") {
    void touchActivity().then(() => sendResponse?.({ ok: true }));
    return true;
  }

  if (message.type === "IS_UNLOCKED") {
    sendResponse?.({ ok: true, unlocked: !!derivedKey });
    return true;
  }

  if (message.type === "CREATE_KEY_CHECK") {
    const { masterPassword, salt } = message;
    if (typeof masterPassword !== "string" || !masterPassword) { sendResponse?.({ ok: false, error: "Missing master password" }); return true; }
    if (typeof salt !== "string" || !salt) { sendResponse?.({ ok: false, error: "Missing salt" }); return true; }
    void (async () => {
      try {
        const result = await createKeyCheck(masterPassword, salt);
        sendResponse?.({ ok: true, ...result });
      } catch (e) { sendResponse?.({ ok: false, error: e.message }); }
    })();
    return true;
  }

  if (message.type === "UNLOCK") {
    const { masterPassword, salt, keyCheckCiphertext, keyCheckIv } = message;
    if (!masterPassword) { sendResponse?.({ ok: false, error: "Missing master password" }); return true; }
    if (!salt) { sendResponse?.({ ok: false, error: "Missing salt" }); return true; }
    if (!keyCheckCiphertext) { sendResponse?.({ ok: false, error: "Missing key check" }); return true; }
    if (!keyCheckIv) { sendResponse?.({ ok: false, error: "Missing key check iv" }); return true; }
    void (async () => {
      try {
        const key = await deriveVaultKey(masterPassword, salt);
        await verifyKeyCheck(key, keyCheckCiphertext, keyCheckIv);
        derivedKey = key;
        await touchActivity();
        sendResponse?.({ ok: true });
      } catch (e) {
        derivedKey = null;
        sendResponse?.({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (message.type === "SET_KEY") { sendResponse?.({ ok: false, error: "Deprecated" }); return true; }
  if (message.type === "GET_KEY") { sendResponse?.({ ok: false, error: "Not supported" }); return true; }

  if (message.type === "CLEAR_KEY") {
    void lockNow("manual").then(() => sendResponse?.({ ok: true }));
    return true;
  }

  if (message.type === "AUTOFILL_ACTIVE_TAB") {
    const { tabId, url, credentialId: rawCredId } = message;
    const credentialId = typeof rawCredId === "string" ? rawCredId : null;
    if (!derivedKey) { sendResponse?.({ ok: false, error: "Vault is locked" }); return true; }
    if (typeof tabId !== "number") { sendResponse?.({ ok: false, error: "Missing tab id" }); return true; }
    if (!url) { sendResponse?.({ ok: false, error: "Missing tab url" }); return true; }
    void (async () => {
      try {
        const token = await readAuthToken();
        if (!token) throw new Error("Not signed in");
        let hostname;
        try { hostname = new URL(url).hostname; } catch { throw new Error("Invalid tab url"); }
        const credentials = await listCredentialRecordsForHostname(token, hostname);
        if (!Array.isArray(credentials) || credentials.length === 0) throw new Error("No saved credential for this domain");
        const defaultCredentialId = await getDefaultCredentialId(hostname);
        let selected = credentialId
          ? credentials.find((c) => c?.id === credentialId)
          : credentials.find((c) => c?.id === defaultCredentialId);
        if (credentialId && !selected) {
          const allRecords = await listAllCredentialRecords(token);
          selected = allRecords.find((c) => c?.id === credentialId) || null;
        }
        const first = selected || credentials[0];
        const username = first.decrypted?.username || "";
        const password = first.decrypted?.password || "";
        if (!password) throw new Error("Stored credential is missing a password");
        let fillResp = await sendMessageToTabFrames(tabId, { type: "FILL_CREDENTIALS", username, password });
        if (fillResp?.ok === false && /receiving end does not exist|could not establish connection/i.test(fillResp.error || "")) {
          const injectResp = await injectContentScript(tabId, url);
          if (injectResp?.ok) fillResp = await sendMessageToTabFrames(tabId, { type: "FILL_CREDENTIALS", username, password });
        }
        if (!fillResp?.ok) throw new Error(fillResp?.error || "Unable to fill this page");
        await touchActivity();
        sendResponse?.({ ok: true });
      } catch (e) { sendResponse?.({ ok: false, error: e.message }); }
    })();
    return true;
  }

  if (message.type === "LIST_CREDENTIALS_FOR_DOMAIN") {
    const hostname = coerceString(message.hostname);
    if (!derivedKey) { sendResponse?.({ ok: false, error: "Vault is locked" }); return true; }
    void (async () => {
      try {
        const token = await readAuthToken();
        if (!token) throw new Error("Not signed in");
        const records = await listCredentialRecordsForHostname(token, hostname);
        const defaultCredentialId = await getDefaultCredentialId(hostname);
        await touchActivity();
        sendResponse?.({ ok: true, credentials: records.map((r) => summarizeCredential(r, defaultCredentialId)) });
      } catch (e) { sendResponse?.({ ok: false, error: e.message }); }
    })();
    return true;
  }

  if (message.type === "LIST_ALL_CREDENTIALS") {
    if (!derivedKey) { sendResponse?.({ ok: false, error: "Vault is locked" }); return true; }
    void (async () => {
      try {
        const token = await readAuthToken();
        if (!token) throw new Error("Not signed in");
        const records = await listAllCredentialRecords(token);
        await touchActivity();
        sendResponse?.({ ok: true, credentials: records.map((r) => summarizeCredential(r, null)) });
      } catch (e) { sendResponse?.({ ok: false, error: e.message }); }
    })();
    return true;
  }

  if (message.type === "UPDATE_CREDENTIAL") {
    const id = coerceString(message.id);
    const username = coerceString(message.username);
    const password = coerceString(message.password);
    if (!derivedKey) { sendResponse?.({ ok: false, error: "Vault is locked" }); return true; }
    if (!id || !password) { sendResponse?.({ ok: false, error: "Missing credential id or password" }); return true; }
    void (async () => {
      try {
        const token = await readAuthToken();
        if (!token) throw new Error("Not signed in");
        await updateCredential(token, id, username, password);
        await touchActivity();
        sendResponse?.({ ok: true });
      } catch (e) { sendResponse?.({ ok: false, error: e.message }); }
    })();
    return true;
  }

  if (message.type === "GET_CREDENTIAL_FOR_EDIT") {
    const hostname = coerceString(message.hostname);
    const id = coerceString(message.id);
    if (!derivedKey) { sendResponse?.({ ok: false, error: "Vault is locked" }); return true; }
    if (!id) { sendResponse?.({ ok: false, error: "Missing credential id" }); return true; }
    void (async () => {
      try {
        const token = await readAuthToken();
        if (!token) throw new Error("Not signed in");
        const records = hostname
          ? await listCredentialRecordsForHostname(token, hostname)
          : await listAllCredentialRecords(token);
        const record = records.find((item) => item.id === id);
        if (!record) throw new Error("Credential not found");
        await touchActivity();
        sendResponse?.({ ok: true, credential: { id: record.id, domain: record.domain, username: record.decrypted?.username || "", password: record.decrypted?.password || "" } });
      } catch (e) { sendResponse?.({ ok: false, error: e.message }); }
    })();
    return true;
  }

  if (message.type === "DELETE_CREDENTIAL") {
    const id = coerceString(message.id);
    if (!id) { sendResponse?.({ ok: false, error: "Missing credential id" }); return true; }
    void (async () => {
      try {
        const token = await readAuthToken();
        if (!token) throw new Error("Not signed in");
        await apiRequest(`/credentials/${encodeURIComponent(id)}`, token, { method: "DELETE" });
        await touchActivity();
        sendResponse?.({ ok: true });
      } catch (e) { sendResponse?.({ ok: false, error: e.message }); }
    })();
    return true;
  }

  if (message.type === "SET_DEFAULT_CREDENTIAL") {
    const hostname = coerceString(message.hostname);
    const id = coerceString(message.id);
    if (!hostname || !id) { sendResponse?.({ ok: false, error: "Missing hostname or credential id" }); return true; }
    void (async () => {
      try {
        await setDefaultCredentialId(hostname, id);
        await touchActivity();
        sendResponse?.({ ok: true });
      } catch (e) { sendResponse?.({ ok: false, error: e.message }); }
    })();
    return true;
  }

  if (message.type === "GET_PENDING_SAVE") {
    void (async () => {
      const pending = await storageSessionGet(PENDING_SAVE_KEY);
      sendResponse?.({ ok: true, pending });
    })();
    return true;
  }

  if (message.type === "DISCARD_PENDING_SAVE") {
    void storageSessionRemove(PENDING_SAVE_KEY).then(() => sendResponse?.({ ok: true }));
    return true;
  }

  if (message.type === "RESOLVE_PENDING_SAVE") {
    const action = coerceString(message.action);
    const targetId = coerceString(message.targetId);
    const username = coerceString(message.username);
    const password = coerceString(message.password);
    if (!derivedKey) { sendResponse?.({ ok: false, error: "Vault is locked" }); return true; }
    if (!password || !["create", "update"].includes(action)) { sendResponse?.({ ok: false, error: "Choose a save action and enter a password" }); return true; }
    void (async () => {
      try {
        const pending = await storageSessionGet(PENDING_SAVE_KEY);
        if (!pending?.hostname) throw new Error("No pending save request");
        const token = await readAuthToken();
        if (!token) throw new Error("Not signed in");
        if (action === "update") {
          const id = targetId || pending?.suggestedTargetId || "";
          if (!id) throw new Error("Choose the credential to update");
          await updateCredential(token, id, username, password);
          if (message.makeDefault) await setDefaultCredentialId(pending.hostname, id);
        } else {
          const created = await createCredential(token, pending.hostname, username, password);
          if (message.makeDefault && created?.id) await setDefaultCredentialId(pending.hostname, created.id);
        }
        await storageSessionRemove(PENDING_SAVE_KEY);
        await touchActivity();
        sendResponse?.({ ok: true });
      } catch (e) { sendResponse?.({ ok: false, error: e.message }); }
    })();
    return true;
  }

  if (message.type === "SAVE_CREDENTIALS") {
    const { url, username: rawUser, password: rawPass, currentPassword: rawCurr, newPassword: rawNew } = message;
    const mode = typeof message.mode === "string" ? message.mode : "login";
    const username = coerceString(rawUser);
    const password = coerceString(rawPass);
    const currentPassword = coerceString(rawCurr);
    const newPassword = coerceString(rawNew);
    if (!derivedKey) { sendResponse?.({ ok: false, error: "Vault is locked" }); return true; }
    if (!url) { sendResponse?.({ ok: false, error: "Missing url" }); return true; }
    if (mode === "login" && !password) { sendResponse?.({ ok: false, error: "Missing password" }); return true; }
    if (mode === "changePassword" && (!currentPassword || !newPassword)) { sendResponse?.({ ok: false, error: "Missing password change fields" }); return true; }
    void (async () => {
      try {
        const token = await readAuthToken();
        if (!token) throw new Error("Not signed in");
        let hostname;
        try { hostname = new URL(url).hostname; } catch { throw new Error("Invalid url"); }
        const decryptedExisting = await listCredentialRecordsForHostname(token, hostname);
        const defaultCredentialId = await getDefaultCredentialId(hostname);
        if (mode === "changePassword") {
          if (newPassword === currentPassword) { sendResponse?.({ ok: true, action: "skipped" }); return; }
          const match = (() => {
            if (username) return decryptedExisting.find((c) => usernamesEqual(c.decrypted?.username, username) && c.decrypted?.password === currentPassword) || null;
            const matches = decryptedExisting.filter((c) => c.decrypted?.password === currentPassword);
            return matches.length === 1 ? matches[0] : null;
          })();
          if (!match) throw new Error("No matching credential found to update");
          const finalUsername = username || match.decrypted?.username || "";
          await openSavePrompt({ id: crypto.randomUUID(), hostname, url, mode, username: finalUsername, password: newPassword, currentPassword, suggestedAction: "update", suggestedTargetId: match.id, reason: "Password change detected", existing: decryptedExisting.map((r) => summarizeCredential(r, defaultCredentialId)), createdAt: Date.now() });
          await touchActivity();
          sendResponse?.({ ok: true, action: "prompted" });
          return;
        }
        const normalizedIncomingUser = normalizeUsername(username);
        const exactDuplicate = decryptedExisting.find((c) => {
          if (c.decrypted?.password !== password) return false;
          if (normalizedIncomingUser) return usernamesEqual(c.decrypted?.username, normalizedIncomingUser);
          return !normalizeUsername(c.decrypted?.username);
        });
        if (exactDuplicate) { await touchActivity(); sendResponse?.({ ok: true, action: "skipped" }); return; }
        let updateTarget = null;
        if (normalizedIncomingUser) updateTarget = decryptedExisting.find((c) => usernamesEqual(c.decrypted?.username, normalizedIncomingUser)) || null;
        else if (decryptedExisting.length === 1) updateTarget = decryptedExisting[0];
        await openSavePrompt({ id: crypto.randomUUID(), hostname, url, mode, username: normalizedIncomingUser || username, password, suggestedAction: updateTarget ? "update" : "create", suggestedTargetId: updateTarget?.id || "", reason: updateTarget ? "Saved username already exists for this site" : "New login detected", existing: decryptedExisting.map((r) => summarizeCredential(r, defaultCredentialId)), createdAt: Date.now() });
        await touchActivity();
        sendResponse?.({ ok: true, action: "prompted" });
      } catch (e) { sendResponse?.({ ok: false, error: e.message }); }
    })();
    return true;
  }

  if (message.type === "CHANGE_MASTER_PASSWORD") {
    const { oldPassword, newPassword } = message;
    if (!derivedKey) { sendResponse({ ok: false, error: "Vault is locked." }); return true; }
    void (async () => {
      try {
        const token = await readAuthToken();
        if (!token) throw new Error("Not signed in.");
        const allRecords = await listAllCredentialRecords(token);
        const changeResp = await fetch(`${API_BASE}/auth/change-password`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ oldPassword, newPassword }) });
        const changeData = await changeResp.json();
        if (!changeResp.ok) throw new Error(changeData.error || "Password change failed.");
        const newSalt = changeData.newSalt;
        if (!newSalt) throw new Error("Server did not return a new salt.");
        const newKey = await deriveVaultKey(newPassword, newSalt);
        const updates = [];
        for (const rec of allRecords) {
          const payload = JSON.stringify({ username: rec.decrypted.username, password: rec.decrypted.password });
          const bytes = new TextEncoder().encode(payload);
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, newKey, bytes);
          updates.push({ id: rec.id, ciphertext: bytesToBase64(new Uint8Array(ciphertext)), iv: bytesToBase64(iv) });
        }
        if (updates.length > 0) {
          const bulkResp = await fetch(`${API_BASE}/credentials/bulk`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ updates }) });
          if (!bulkResp.ok) { const bd = await bulkResp.json().catch(() => ({})); throw new Error(bd.error || "Bulk re-encryption failed."); }
        }
        const keyCheckResult = await createKeyCheck(newPassword, newSalt);
        derivedKey = newKey;
        await touchActivity();
        const existingSession = await storageSessionGet(SESSION_KEY);
        await storageSessionSet(SESSION_KEY, { ...(existingSession || {}), token, salt: newSalt, keyCheckCiphertext: keyCheckResult.keyCheckCiphertext, keyCheckIv: keyCheckResult.keyCheckIv });
        sendResponse({ ok: true, recoveryKey: changeData.recoveryKey });
      } catch (err) {
        console.error("CHANGE_MASTER_PASSWORD error:", err);
        sendResponse({ ok: false, error: err.message || "Password change failed." });
      }
    })();
    return true;
  }

  if (message.type === "RESET_WITH_RECOVERY") {
    const { email, recoveryKey, newPassword } = message;
    void (async () => {
      try {
        const resp = await fetch(`${API_BASE}/auth/reset-with-recovery`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, recoveryKey, newMasterPassword: newPassword }) });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || "Reset failed.");
        const { token, newSalt, vaultKey: oldVaultKeyB64, newRecoveryKey } = data;
        if (!token || !newSalt || !oldVaultKeyB64) throw new Error("Incomplete response from server.");
        const oldVaultKeyBytes = base64ToBytes(oldVaultKeyB64);
        const oldKey = await crypto.subtle.importKey("raw", oldVaultKeyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
        const allCredentials = await listAllCredentialRecordsWithKey(token, oldKey);
        const newKey = await deriveVaultKey(newPassword, newSalt);
        const updates = [];
        for (const rec of allCredentials) {
          const payload = JSON.stringify({ username: rec.decrypted.username, password: rec.decrypted.password });
          const bytes = new TextEncoder().encode(payload);
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, newKey, bytes);
          updates.push({ id: rec.id, ciphertext: bytesToBase64(new Uint8Array(ciphertext)), iv: bytesToBase64(iv) });
        }
        if (updates.length > 0) {
          const bulkResp = await fetch(`${API_BASE}/credentials/bulk`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ updates }) });
          if (!bulkResp.ok) { const bd = await bulkResp.json().catch(() => ({})); throw new Error(bd.error || "Bulk re-encryption failed."); }
        }
        const keyCheckResult = await createKeyCheck(newPassword, newSalt);
        derivedKey = newKey;
        await storageSessionSet(SESSION_KEY, { token, salt: newSalt, keyCheckCiphertext: keyCheckResult.keyCheckCiphertext, keyCheckIv: keyCheckResult.keyCheckIv });
        await touchActivity();
        sendResponse({ ok: true, recoveryKey: newRecoveryKey });
      } catch (err) {
        console.error("RESET_WITH_RECOVERY error:", err);
        sendResponse({ ok: false, error: err.message || "Recovery failed." });
      }
    })();
    return true;
  }

  if (message.type === "SET_REMEMBER_ME") {
    const rememberMe = message.rememberMe === true;
    void (async () => {
      try {
        await storageLocalSet(REMEMBER_ME_KEY, rememberMe);
        if (rememberMe) {
          // FIX: Actively clear any existing alarm when rememberMe is enabled
          await _api.alarms.clear(AUTO_LOCK_ALARM);
        } else {
          await scheduleAutoLockFromLastActivity();
        }
        sendResponse?.({ ok: true });
      } catch (e) { sendResponse?.({ ok: false, error: e.message }); }
    })();
    return true;
  }

  if (message.type === "GET_REMEMBER_ME") {
    void (async () => {
      const rememberMe = await storageLocalGet(REMEMBER_ME_KEY);
      sendResponse?.({ ok: true, rememberMe: rememberMe === true });
    })();
    return true;
  }
});