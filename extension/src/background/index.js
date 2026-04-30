chrome.runtime.onInstalled.addListener(() => {
  console.debug("Password Manager background service worker installed");
});

let derivedKeyBytes = null;

const AUTO_LOCK_MS = 5 * 60 * 1000;
const AUTO_LOCK_ALARM = "pm_auto_lock";
const SESSION_KEY = "password-manager-session";
const LAST_ACTIVITY_KEY = "password-manager-last-activity";

function storageSessionGet(key) {
  return new Promise((resolve) => {
    chrome.storage.session.get(key, (result) => {
      resolve(result?.[key] ?? null);
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
  const session = await storageSessionGet(SESSION_KEY);

  if (!session || typeof lastActivity !== "number") {
    chrome.alarms.clear(AUTO_LOCK_ALARM);
    return;
  }

  const when = lastActivity + AUTO_LOCK_MS;
  chrome.alarms.create(AUTO_LOCK_ALARM, { when });
}

async function touchActivity() {
  await storageSessionSet(LAST_ACTIVITY_KEY, Date.now());
  await scheduleAutoLockFromLastActivity();
}

async function lockNow(reason) {
  derivedKeyBytes = null;
  await storageSessionRemove([SESSION_KEY, LAST_ACTIVITY_KEY]);
  chrome.alarms.clear(AUTO_LOCK_ALARM);
  console.debug("Auto-locked session", reason);
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== AUTO_LOCK_ALARM) {
    return;
  }

  const lastActivity = await storageSessionGet(LAST_ACTIVITY_KEY);
  const session = await storageSessionGet(SESSION_KEY);

  if (!session || typeof lastActivity !== "number") {
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === "ACTIVITY" || message.type === "SESSION_STARTED") {
    void touchActivity().then(() => sendResponse?.({ ok: true }));
    return true;
  }

  if (message.type === "SET_KEY") {
    derivedKeyBytes = message.keyBytes ?? null;
    sendResponse?.({ ok: true });
    return true;
  }

  if (message.type === "GET_KEY") {
    sendResponse?.({ ok: true, keyBytes: derivedKeyBytes });
    return true;
  }

  if (message.type === "CLEAR_KEY") {
    derivedKeyBytes = null;
    sendResponse?.({ ok: true });
    return true;
  }
});