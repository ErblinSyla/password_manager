chrome.runtime.onInstalled.addListener(() => {
  console.debug("Password Manager background service worker installed");
});

let derivedKey = null;

const AUTO_LOCK_MS = 5 * 60 * 1000;
const AUTO_LOCK_ALARM = "pm_auto_lock";
const LAST_ACTIVITY_KEY = "password-manager-last-activity";

const API_BASE = "http://localhost:3001/api";
const SESSION_KEY = "password-manager-session";

const KEY_CHECK_PLAINTEXT = "pm:vault-key-check:v1";

function storageSessionGet(key) {
  return new Promise((resolve) => {
    chrome.storage.session.get(key, (result) => {
      resolve(result?.[key] ?? null);
    });
  });
}

function storageSessionGetMany(keys) {
  return new Promise((resolve) => {
    chrome.storage.session.get(keys, (result) => {
      resolve(result || {});
    });
  });
}

function storageSessionSet(key, value) {
  return new Promise((resolve) => {
    chrome.storage.session.set({ [key]: value }, () => resolve());
  });
}

function storageSessionRemove(keys) {
  return new Promise((resolve) => {
    chrome.storage.session.remove(keys, () => resolve());
  });
}

async function scheduleAutoLockFromLastActivity() {
  const lastActivity = await storageSessionGet(LAST_ACTIVITY_KEY);

  if (!derivedKey || typeof lastActivity !== "number") {
    chrome.alarms.clear(AUTO_LOCK_ALARM);
    return;
  }

  const when = lastActivity + AUTO_LOCK_MS;
  chrome.alarms.create(AUTO_LOCK_ALARM, { when });
}

async function touchActivity() {
  if (!derivedKey) {
    return;
  }
  await storageSessionSet(LAST_ACTIVITY_KEY, Date.now());
  await scheduleAutoLockFromLastActivity();
}

async function lockNow(reason) {
  derivedKey = null;
  await storageSessionRemove([LAST_ACTIVITY_KEY]);
  chrome.alarms.clear(AUTO_LOCK_ALARM);
  console.debug("Auto-locked vault key", reason);
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== AUTO_LOCK_ALARM) {
    return;
  }

  if (!derivedKey) {
    chrome.alarms.clear(AUTO_LOCK_ALARM);
    return;
  }

  const lastActivity = await storageSessionGet(LAST_ACTIVITY_KEY);

  if (typeof lastActivity !== "number") {
    return;
  }

  const idleFor = Date.now() - lastActivity;
  if (idleFor >= AUTO_LOCK_MS) {
    await lockNow("idle");
    return;
  }

  await scheduleAutoLockFromLastActivity();
});

chrome.runtime.onStartup?.addListener(() => {
  void scheduleAutoLockFromLastActivity();
});

void scheduleAutoLockFromLastActivity();

function hexToBytes(hex) {
  if (typeof hex !== "string") {
    throw new Error("Salt must be a hex string");
  }
  const normalized = hex.trim().toLowerCase();
  if (normalized.length % 2 !== 0) {
    throw new Error("Invalid hex salt length");
  }
  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < out.length; i++) {
    const value = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(value)) {
      throw new Error("Invalid hex salt");
    }
    out[i] = value;
  }
  return out;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  if (typeof base64 !== "string") {
    throw new Error("Invalid base64");
  }

  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function aesGcmEncrypt(key, plaintextBytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintextBytes
  );

  return {
    ciphertextBase64: bytesToBase64(new Uint8Array(ciphertext)),
    ivBase64: bytesToBase64(iv),
  };
}

async function aesGcmDecrypt(key, ciphertextBase64, ivBase64) {
  const ciphertext = base64ToBytes(ciphertextBase64);
  const iv = base64ToBytes(ivBase64);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );
  return new Uint8Array(plaintext);
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
  if (text !== KEY_CHECK_PLAINTEXT) {
    throw new Error("Master password is incorrect");
  }
}

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
  if (!response.ok) {
    throw new Error(data?.error || "Request failed");
  }
  return data;
}

async function readAuthToken() {
  const result = await storageSessionGetMany([SESSION_KEY]);
  const session = result?.[SESSION_KEY] ?? null;
  const token = typeof session?.token === "string" ? session.token : "";
  return token || null;
}

async function decryptCredentialPayload(ciphertextBase64, ivBase64) {
  if (!derivedKey) {
    throw new Error("Vault is locked");
  }
  const bytes = await aesGcmDecrypt(derivedKey, ciphertextBase64, ivBase64);
  const text = new TextDecoder().decode(bytes);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Credential payload is not valid JSON");
  }

  const username = typeof parsed?.username === "string" ? parsed.username : "";
  const password = typeof parsed?.password === "string" ? parsed.password : "";
  if (!password) {
    throw new Error("Credential payload missing password");
  }

  return { username, password };
}

async function encryptCredentialPayload(username, password) {
  if (!derivedKey) {
    throw new Error("Vault is locked");
  }

  const payload = JSON.stringify({ username: username || "", password });
  const bytes = new TextEncoder().encode(payload);
  const { ciphertextBase64, ivBase64 } = await aesGcmEncrypt(derivedKey, bytes);
  return { ciphertext: ciphertextBase64, iv: ivBase64 };
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response ?? { ok: true });
      });
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : "Unable to message tab" });
    }
  });
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
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: hexToBytes(saltHex),
      iterations: 200_000,
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === "ACTIVITY" || message.type === "SESSION_STARTED") {
    void touchActivity().then(() => sendResponse?.({ ok: true }));
    return true;
  }

  if (message.type === "IS_UNLOCKED") {
    sendResponse?.({ ok: true, unlocked: !!derivedKey });
    return true;
  }

  if (message.type === "CREATE_KEY_CHECK") {
    const masterPassword = message.masterPassword;
    const salt = message.salt;

    if (typeof masterPassword !== "string" || masterPassword.length === 0) {
      sendResponse?.({ ok: false, error: "Missing master password" });
      return true;
    }

    if (typeof salt !== "string" || salt.length === 0) {
      sendResponse?.({ ok: false, error: "Missing salt" });
      return true;
    }

    void (async () => {
      try {
        const result = await createKeyCheck(masterPassword, salt);
        sendResponse?.({ ok: true, ...result });
      } catch (error) {
        sendResponse?.({ ok: false, error: error instanceof Error ? error.message : "Unable to create key check" });
      }
    })();

    return true;
  }

  if (message.type === "UNLOCK") {
    const masterPassword = message.masterPassword;
    const salt = message.salt;
    const keyCheckCiphertext = message.keyCheckCiphertext;
    const keyCheckIv = message.keyCheckIv;

    if (typeof masterPassword !== "string" || masterPassword.length === 0) {
      sendResponse?.({ ok: false, error: "Missing master password" });
      return true;
    }

    if (typeof salt !== "string" || salt.length === 0) {
      sendResponse?.({ ok: false, error: "Missing salt" });
      return true;
    }

    if (typeof keyCheckCiphertext !== "string" || keyCheckCiphertext.length === 0) {
      sendResponse?.({ ok: false, error: "Missing key check" });
      return true;
    }

    if (typeof keyCheckIv !== "string" || keyCheckIv.length === 0) {
      sendResponse?.({ ok: false, error: "Missing key check iv" });
      return true;
    }

    void (async () => {
      try {
        const key = await deriveVaultKey(masterPassword, salt);
        await verifyKeyCheck(key, keyCheckCiphertext, keyCheckIv);
        derivedKey = key;
        await touchActivity();
        sendResponse?.({ ok: true });
      } catch (error) {
        derivedKey = null;
        sendResponse?.({ ok: false, error: error instanceof Error ? error.message : "Unlock failed" });
      }
    })();

    return true;
  }

  if (message.type === "SET_KEY") {
    sendResponse?.({ ok: false, error: "Deprecated" });
    return true;
  }

  if (message.type === "GET_KEY") {
    sendResponse?.({ ok: false, error: "Not supported" });
    return true;
  }

  if (message.type === "CLEAR_KEY") {
    void lockNow("manual").then(() => sendResponse?.({ ok: true }));
    return true;
  }

  if (message.type === "AUTOFILL_ACTIVE_TAB") {
    const tabId = message.tabId;
    const url = message.url;

    if (!derivedKey) {
      sendResponse?.({ ok: false, error: "Vault is locked" });
      return true;
    }

    if (typeof tabId !== "number") {
      sendResponse?.({ ok: false, error: "Missing tab id" });
      return true;
    }

    if (typeof url !== "string" || url.length === 0) {
      sendResponse?.({ ok: false, error: "Missing tab url" });
      return true;
    }

    void (async () => {
      try {
        const token = await readAuthToken();
        if (!token) {
          throw new Error("Not signed in");
        }

        let hostname;
        try {
          hostname = new URL(url).hostname;
        } catch {
          throw new Error("Invalid tab url");
        }

        const credentials = await apiRequest(`/credentials/domain/${encodeURIComponent(hostname)}`, token);
        if (!Array.isArray(credentials) || credentials.length === 0) {
          throw new Error("No saved credential for this domain");
        }

        const first = credentials[0];
        const ciphertext = typeof first?.ciphertext === "string" ? first.ciphertext : "";
        const iv = typeof first?.iv === "string" ? first.iv : "";
        if (!ciphertext || !iv) {
          throw new Error("Stored credential is missing ciphertext/iv");
        }

        const { username, password } = await decryptCredentialPayload(ciphertext, iv);
        const fillResp = await sendMessageToTab(tabId, {
          type: "FILL_CREDENTIALS",
          username,
          password,
        });

        if (!fillResp?.ok) {
          throw new Error(fillResp?.error || "Unable to fill this page");
        }

        await touchActivity();
        sendResponse?.({ ok: true });
      } catch (error) {
        sendResponse?.({ ok: false, error: error instanceof Error ? error.message : "Autofill failed" });
      }
    })();

    return true;
  }

  if (message.type === "SAVE_CREDENTIALS") {
    const url = message.url;
    const username = typeof message.username === "string" ? message.username : "";
    const password = typeof message.password === "string" ? message.password : "";

    if (!derivedKey) {
      sendResponse?.({ ok: false, error: "Vault is locked" });
      return true;
    }

    if (typeof url !== "string" || url.length === 0) {
      sendResponse?.({ ok: false, error: "Missing url" });
      return true;
    }

    if (!password) {
      sendResponse?.({ ok: false, error: "Missing password" });
      return true;
    }

    void (async () => {
      try {
        const token = await readAuthToken();
        if (!token) {
          throw new Error("Not signed in");
        }

        let hostname;
        try {
          hostname = new URL(url).hostname;
        } catch {
          throw new Error("Invalid url");
        }

        const { ciphertext, iv } = await encryptCredentialPayload(username, password);
        await apiRequest("/credentials", token, {
          method: "POST",
          body: JSON.stringify({ domain: hostname, ciphertext, iv }),
        });

        await touchActivity();
        sendResponse?.({ ok: true });
      } catch (error) {
        sendResponse?.({ ok: false, error: error instanceof Error ? error.message : "Save failed" });
      }
    })();

    return true;
  }
});