// popup.js
// ─────────────────────────────────────────────────────────────────────────────
// Cross-browser shim — Firefox exposes `browser` (Promise-based);
// Chrome / Edge / Safari use `chrome` (callback-based).
// This shim normalises only what popup.js needs: runtime.sendMessage and
// tabs.query / tabs.sendMessage / scripting.executeScript.
// ─────────────────────────────────────────────────────────────────────────────
const _browser = (() => {
  if (typeof browser !== "undefined" && browser.runtime) return browser;

  const p = (fn) => (...args) =>
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
      sendMessage: p(chrome.runtime.sendMessage.bind(chrome.runtime)),
    },
    tabs: {
      query: p(chrome.tabs.query.bind(chrome.tabs)),
      sendMessage: (...args) =>
        new Promise((resolve) => {
          try {
            chrome.tabs.sendMessage(...args, (response) => {
              if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
              else resolve(response ?? { ok: true });
            });
          } catch (e) { resolve({ ok: false, error: e.message }); }
        }),
    },
    scripting: chrome.scripting,
  };
})();

// ─────────────────────────────────────────────────────────────────────────────

const tabButtons = Array.from(document.querySelectorAll("[data-tab]"));
const tabPanels = Array.from(document.querySelectorAll("[data-panel]"));
const signInForm = document.querySelector('[data-panel="sign-in"]');
const registerForm = document.querySelector('[data-panel="create-account"]');
const connectionTitle = document.getElementById("connection-title");
const connectionMessage = document.getElementById("connection-message");
const lockButton = document.getElementById("lock-button");
const signOutButton = document.getElementById("signout-button");
const gatedSections = Array.from(document.querySelectorAll("[data-when]"));
const unlockForm = document.getElementById("unlock-form");
const detectedPageLabel = document.getElementById("detected-page");
const siteDomainLabel = document.getElementById("site-domain");
const siteFieldsStatusLabel = document.getElementById("site-fields-status");
const autofillButton = document.getElementById("autofill-button");
const refreshTabButton = document.getElementById("refresh-tab-button");
const savedCountLabel = document.getElementById("saved-count");
const savedCountSubtitle = document.getElementById("saved-count-subtitle");
const vaultList = document.getElementById("vault-list");
const vaultPill = document.getElementById("vault-pill");
const vaultSearchInput = document.getElementById("vault-search");
const credentialEditor = document.getElementById("credential-editor");
const credentialEditForm = document.getElementById("credential-edit-form");
const editUsernameInput = document.getElementById("edit-username");
const editPasswordInput = document.getElementById("edit-password");
const vaultScopeButtons = Array.from(document.querySelectorAll("[data-vault-scope]"));
const editFeedback = document.getElementById("edit-feedback");
const editCancelButton = document.getElementById("edit-cancel-button");
const editRevealButton = document.getElementById("edit-reveal-button");

// ── Generator (edit panel) ────────────────────────────────────────────────────
const editGenerateButton = document.getElementById("edit-generate-button");
const generatorPanel = document.getElementById("generator-panel");
const generatorPreview = document.getElementById("generator-preview");
const generatorCopyButton = document.getElementById("generator-copy-button");
const generatorLength = document.getElementById("generator-length");
const generatorLengthValue = document.getElementById("generator-length-value");
const generatorRefreshButton = document.getElementById("generator-refresh-button");
const generatorUseButton = document.getElementById("generator-use-button");
const genUppercase = document.getElementById("gen-uppercase");
const genNumbers = document.getElementById("gen-numbers");
const genSymbols = document.getElementById("gen-symbols");

// ── Generator (register form) ─────────────────────────────────────────────────
const registerGenerateButton = document.getElementById("register-generate-button");
const registerPasswordInput = document.getElementById("register-password");
const confirmPasswordInput = document.getElementById("confirm-password");

// ── Standalone generator ──────────────────────────────────────────────────────
const standaloneGeneratorPanel = document.getElementById("standalone-generator-panel");
const standaloneGeneratorClose = document.getElementById("standalone-generator-close");
const standaloneGeneratorPreview = document.getElementById("standalone-generator-preview");
const standaloneGeneratorCopyButton = document.getElementById("standalone-generator-copy-button");
const standaloneGeneratorLength = document.getElementById("standalone-generator-length");
const standaloneGeneratorLengthValue = document.getElementById("standalone-generator-length-value");
const standaloneGeneratorRefreshButton = document.getElementById("standalone-generator-refresh-button");
const standaloneGenUppercase = document.getElementById("standalone-gen-uppercase");
const standaloneGenNumbers = document.getElementById("standalone-gen-numbers");
const standaloneGenSymbols = document.getElementById("standalone-gen-symbols");

let activeHostname = null;
let lastVaultCredentials = [];
let showAllCredentials = false;
let currentVaultToken = null;
let editingCredentialId = null;
let pendingDeleteId = null;
let pendingDeleteUntil = 0;
let currentPageHasLoginFields = false;

const API_BASE = (typeof window !== "undefined" && window.__EXTENSION_CONFIG__?.API_BASE)
  || "http://localhost:3001/api";
const SESSION_KEY = "password-manager-session";
const AUTOFILL_ON_LOAD_KEY = "password-manager-autofill-on-load";

// ─────────────────────────────────────────────────────────────────────────────
// Loader helpers
// ─────────────────────────────────────────────────────────────────────────────

// Spinning dots loader — used inline for single-value labels
const LOADER_HTML = `<span class="inline-loader" aria-label="Loading…">
  <span></span><span></span><span></span>
</span>`;

function setLoading(el, label = "") {
  if (!el) return;
  el.innerHTML = label ? `${label} ${LOADER_HTML}` : LOADER_HTML;
}

function showPageLoader() {
  const loader = document.getElementById('page-loader');
  if (loader) loader.hidden = false;
}

function hidePageLoader() {
  const loader = document.getElementById('page-loader');
  if (loader) loader.hidden = true;
}

// ── Auto-fill toggle ──────────────────────────────────────────────────────────
async function loadAutofillToggle() {
  const stored = await (isChromeSessionStorageAvailable()
    ? new Promise(r => chrome.storage.local.get(AUTOFILL_ON_LOAD_KEY, res => r(res?.[AUTOFILL_ON_LOAD_KEY] ?? false)))
    : Promise.resolve(JSON.parse(localStorage.getItem(AUTOFILL_ON_LOAD_KEY) || "false")));

  const btn = document.getElementById("autofill-toggle");
  if (btn) btn.setAttribute("aria-checked", String(!!stored));
}

async function setAutofillOnLoad(enabled) {
  if (isChromeSessionStorageAvailable()) {
    await new Promise(r => chrome.storage.local.set({ [AUTOFILL_ON_LOAD_KEY]: enabled }, r));
  } else {
    localStorage.setItem(AUTOFILL_ON_LOAD_KEY, JSON.stringify(enabled));
  }
  const btn = document.getElementById("autofill-toggle");
  if (btn) btn.setAttribute("aria-checked", String(enabled));
}

async function getAutofillOnLoad() {
  if (isChromeSessionStorageAvailable()) {
    return new Promise(r => chrome.storage.local.get(AUTOFILL_ON_LOAD_KEY, res => r(res?.[AUTOFILL_ON_LOAD_KEY] === true)));
  }
  try { return JSON.parse(localStorage.getItem(AUTOFILL_ON_LOAD_KEY) || "false") === true; } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Password generator core
// ─────────────────────────────────────────────────────────────────────────────

const CHAR_SETS = {
  lower:   "abcdefghijklmnopqrstuvwxyz",
  upper:   "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  numbers: "0123456789",
  symbols: "!@#$%^&*()-_=+[]{}|;:,.<>?",
};

function generatePassword({ length = 20, uppercase = true, numbers = true, symbols = true } = {}) {
  let alphabet = CHAR_SETS.lower;
  const required = [];
  if (uppercase) { alphabet += CHAR_SETS.upper; required.push(pickRandom(CHAR_SETS.upper)); }
  if (numbers)   { alphabet += CHAR_SETS.numbers; required.push(pickRandom(CHAR_SETS.numbers)); }
  if (symbols)   { alphabet += CHAR_SETS.symbols; required.push(pickRandom(CHAR_SETS.symbols)); }
  required.push(pickRandom(CHAR_SETS.lower));
  const remaining = length - required.length;
  const chars = [...required];
  for (let i = 0; i < remaining; i++) chars.push(pickRandom(alphabet));
  shuffleArray(chars);
  return chars.join("");
}

function pickRandom(str) {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return str[a[0] % str.length];
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    const j = a[0] % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

async function copyToClipboard(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const original = button.textContent;
      button.textContent = "Copied ✓";
      button.disabled = true;
      setTimeout(() => { button.textContent = original; button.disabled = false; }, 1500);
    }
  } catch {}
}

// ── Edit-panel generator ──────────────────────────────────────────────────────

function refreshEditGenerator() {
  if (!generatorPreview) return;
  generatorPreview.textContent = generatePassword({
    length: Number(generatorLength?.value ?? 20),
    uppercase: genUppercase?.checked ?? true,
    numbers: genNumbers?.checked ?? true,
    symbols: genSymbols?.checked ?? true,
  });
}

editGenerateButton?.addEventListener("click", () => {
  if (!generatorPanel) return;
  const isHidden = generatorPanel.hidden;
  generatorPanel.hidden = !isHidden;
  if (isHidden) {
    refreshEditGenerator();
    if (editPasswordInput) editPasswordInput.type = "text";
    if (editRevealButton) editRevealButton.textContent = "Hide";
  }
});

generatorLength?.addEventListener("input", () => {
  if (generatorLengthValue) generatorLengthValue.textContent = generatorLength.value;
  refreshEditGenerator();
});

[genUppercase, genNumbers, genSymbols].forEach((cb) => cb?.addEventListener("change", refreshEditGenerator));
generatorRefreshButton?.addEventListener("click", refreshEditGenerator);
generatorCopyButton?.addEventListener("click", () => copyToClipboard(generatorPreview?.textContent ?? "", generatorCopyButton));
generatorUseButton?.addEventListener("click", () => {
  if (!editPasswordInput || !generatorPreview) return;
  editPasswordInput.value = generatorPreview.textContent;
  editPasswordInput.type = "text";
  if (editRevealButton) editRevealButton.textContent = "Hide";
  if (generatorPanel) generatorPanel.hidden = true;
});

// ── Register generator ────────────────────────────────────────────────────────

registerGenerateButton?.addEventListener("click", () => {
  const pwd = generatePassword({ length: 20, uppercase: true, numbers: true, symbols: true });
  if (registerPasswordInput) { registerPasswordInput.value = pwd; registerPasswordInput.type = "text"; }
  if (confirmPasswordInput)  { confirmPasswordInput.value = pwd; confirmPasswordInput.type = "text"; }
  copyToClipboard(pwd, registerGenerateButton);
  // Update strength meter
  const { score } = scorePassword(pwd);
  applyStrengthUI(score);
});

// ─────────────────────────────────────────────────────────────────────────────
// Password strength meter
// ─────────────────────────────────────────────────────────────────────────────

const strengthMeter = document.getElementById("strength-meter");
const strengthLabel = document.getElementById("strength-label");
const strengthSegs = Array.from(document.querySelectorAll(".strength-seg"));
const registerSubmitButton = document.getElementById("register-submit-button");

function scorePassword(pwd) {
  if (!pwd) return { score: -1, label: "" };
  let score = 0;
  if (pwd.length >= 10) score++;
  if (pwd.length >= 16) score++;
  if (/[a-z]/.test(pwd) && /[A-Z]/.test(pwd)) score++;
  if (/[0-9]/.test(pwd)) score++;
  if (/[^a-zA-Z0-9]/.test(pwd)) score++;
  if (/^(qwerty|asdf|zxcv|1234|abcd|password|letmein|iloveyou)/i.test(pwd) || /(.)\1{3,}/.test(pwd)) score = Math.max(0, score - 1);
  return { score: Math.min(4, Math.max(0, score)) };
}

const STRENGTH_CONFIG = [
  { filled: 1, color: "#dc2626" },
  { filled: 2, color: "#d97706" },
  { filled: 3, color: "#ca8a04" },
  { filled: 4, color: "#16a34a" },
  { filled: 5, color: "#0f766e" },
];
const MIN_SCORE_TO_PROCEED = 2;

function applyStrengthUI(score) {
  if (!strengthMeter || !strengthLabel || !strengthSegs.length) return;
  const isEmpty = score === -1;
  strengthMeter.hidden = isEmpty;
  if (isEmpty) {
    if (confirmPasswordInput) confirmPasswordInput.disabled = true;
    if (registerSubmitButton) registerSubmitButton.disabled = true;
    return;
  }
  const config = STRENGTH_CONFIG[score];
  strengthSegs.forEach((seg, i) => {
    const active = i < config.filled;
    seg.style.background = active ? config.color : "";
    seg.classList.toggle("is-active", active);
  });
  const labelText = ["Weak", "Fair", "Good", "Strong", "Very strong"][score] ?? "";
  strengthLabel.textContent = labelText;
  strengthLabel.style.color = score < MIN_SCORE_TO_PROCEED ? "#b45309" : score >= 3 ? "#0f766e" : "#1f2933";
  const canProceed = score >= MIN_SCORE_TO_PROCEED;
  if (confirmPasswordInput) confirmPasswordInput.disabled = !canProceed;
  if (registerSubmitButton) registerSubmitButton.disabled = !canProceed;
}

registerPasswordInput?.addEventListener("input", () => {
  const { score } = scorePassword(registerPasswordInput.value);
  applyStrengthUI(score);
});

if (strengthMeter) strengthMeter.hidden = true;

// ── Standalone generator ──────────────────────────────────────────────────────

function refreshStandaloneGenerator() {
  if (!standaloneGeneratorPreview) return;
  standaloneGeneratorPreview.textContent = generatePassword({
    length: Number(standaloneGeneratorLength?.value ?? 20),
    uppercase: standaloneGenUppercase?.checked ?? true,
    numbers: standaloneGenNumbers?.checked ?? true,
    symbols: standaloneGenSymbols?.checked ?? true,
  });
}

standaloneGeneratorLength?.addEventListener("input", () => {
  if (standaloneGeneratorLengthValue) standaloneGeneratorLengthValue.textContent = standaloneGeneratorLength.value;
  refreshStandaloneGenerator();
});
[standaloneGenUppercase, standaloneGenNumbers, standaloneGenSymbols].forEach((cb) => cb?.addEventListener("change", refreshStandaloneGenerator));
standaloneGeneratorRefreshButton?.addEventListener("click", refreshStandaloneGenerator);
standaloneGeneratorCopyButton?.addEventListener("click", () => copyToClipboard(standaloneGeneratorPreview?.textContent ?? "", standaloneGeneratorCopyButton));
standaloneGeneratorClose?.addEventListener("click", () => { if (standaloneGeneratorPanel) standaloneGeneratorPanel.hidden = true; });

// ─────────────────────────────────────────────────────────────────────────────
// Browser API helpers
// ─────────────────────────────────────────────────────────────────────────────

function hasBrowserRuntime() {
  return (
    (typeof browser !== "undefined" && !!browser.runtime) ||
    (typeof chrome !== "undefined" && !!chrome.runtime && typeof chrome.runtime.sendMessage === "function")
  );
}

function sendMessage(message) {
  if (!hasBrowserRuntime()) return Promise.resolve(null);
  return _browser.runtime.sendMessage(message).catch(() => null);
}

function queryActiveTab() {
  if (!hasBrowserRuntime()) return Promise.resolve(null);
  return _browser.tabs.query({ active: true, currentWindow: true })
    .then((tabs) => (Array.isArray(tabs) && tabs.length > 0 ? tabs[0] : null))
    .catch(() => null);
}

function sendMessageToTab(tabId, message) {
  if (!hasBrowserRuntime()) return Promise.resolve(null);

  return new Promise((resolve) => {
    try {
      _browser.tabs.sendMessage(tabId, message, (response) => {
        const lastError = chrome?.runtime?.lastError || browser?.runtime?.lastError;
        if (lastError) {
          resolve({ ok: false, error: lastError.message });
        } else {
          resolve(response ?? { ok: true });
        }
      });
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

function isInjectableUrl(url) {
  return typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"));
}

function injectContentScript(tabId, url) {
  if (!isInjectableUrl(url)) return Promise.resolve({ ok: false, error: "This page does not allow autofill." });
  const scripting = (typeof browser !== "undefined" && browser.scripting) || chrome?.scripting;
  if (!scripting?.executeScript) return Promise.resolve({ ok: false, error: "Scripting API not available." });
  return new Promise((resolve) => {
    try {
      scripting.executeScript(
        { target: { tabId, allFrames: true }, files: ["src/content/index.js"] },
        () => {
          const err = chrome?.runtime?.lastError;
          if (err) { resolve({ ok: false, error: err.message }); return; }
          resolve({ ok: true });
        }
      );
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}

function isChromeSessionStorageAvailable() {
  return (
    typeof chrome !== "undefined" && !!chrome.storage?.session &&
    typeof chrome.storage.session.get === "function"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// UI helpers
// ─────────────────────────────────────────────────────────────────────────────

function setActiveTab(tabName) {
  tabButtons.forEach((btn) => {
    const isActive = btn.dataset.tab === tabName;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-selected", String(isActive));
  });
  tabPanels.forEach((panel) => {
    const isActive = panel.dataset.panel === tabName;
    panel.hidden = !isActive;
    panel.classList.toggle("is-active", isActive);
  });
}

function setStatus(title, message, isError = false) {
  if (connectionTitle) connectionTitle.textContent = title;
  if (connectionMessage) {
    connectionMessage.textContent = message;
    connectionMessage.classList.toggle("is-error", isError);
  }
}

function setViewState({ isAuthed, isUnlocked }) {
  gatedSections.forEach((section) => {
    const when = section.getAttribute("data-when");
    if (when === "unauthed") section.hidden = isAuthed;
    if (when === "locked")   section.hidden = !isAuthed || isUnlocked;
    if (when === "unlocked") section.hidden = !isAuthed || !isUnlocked;
  });
  if (lockButton) lockButton.hidden = !isAuthed || !isUnlocked;
  if (signOutButton) signOutButton.hidden = !isAuthed;
  const changePasswordButton = document.getElementById("change-password-button");
  if (changePasswordButton) changePasswordButton.hidden = !isAuthed || !isUnlocked;
}

function updateFillButtonsState() {
  const shouldEnable = currentPageHasLoginFields;

  // Main autofill button
  if (autofillButton) {
    autofillButton.disabled = !shouldEnable;
    autofillButton.title = shouldEnable 
      ? "Autofill credentials on current page" 
      : "No login fields detected on this page";
  }

  // Individual fill buttons in vault list
  const fillButtons = document.querySelectorAll('.vault-icon-btn[title="Autofill this credential"]');
  fillButtons.forEach(btn => {
    btn.disabled = !shouldEnable;
    if (!shouldEnable) {
      btn.title = "No login fields detected on this page";
    } else {
      btn.title = "Autofill this credential";
    }
  });
}

function setDetectedSiteLabels({ url, fieldStatusText }) {
  const domain = (() => { try { return url ? new URL(url).hostname : "-"; } catch { return "-"; } })();
  activeHostname = domain && domain !== "-" ? domain : null;

  if (detectedPageLabel) detectedPageLabel.textContent = domain;
  if (siteDomainLabel) siteDomainLabel.textContent = domain;
  if (siteFieldsStatusLabel) siteFieldsStatusLabel.textContent = fieldStatusText || "-";

  // Track whether current page has login fields
  currentPageHasLoginFields = fieldStatusText && 
    (fieldStatusText.includes("Login fields found") || 
     fieldStatusText.includes("Password field found"));

  updateFillButtonsState();
}

function setSavedCount(count, subtitle) {
  if (savedCountLabel) savedCountLabel.textContent = typeof count === "number" ? String(count) : "-";
  if (savedCountSubtitle) savedCountSubtitle.textContent = subtitle || "";
}

function clearVaultList(message) {
  if (!vaultList) return;
  vaultList.innerHTML = "";
  const p = document.createElement("p");
  p.className = "vault-empty";
  p.textContent = message;
  vaultList.appendChild(p);
}

// Shows a spinner inside the vault list while credentials are loading
function setVaultListLoading() {
  if (!vaultList) return;
  vaultList.innerHTML = `
    <div class="vault-loading" aria-label="Loading credentials…" aria-live="polite">
      <div class="vault-loading-spinner"></div>
      <p>Loading…</p>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SVG icons
// ─────────────────────────────────────────────────────────────────────────────

const ICONS = {
  fill:     `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  copyUser: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  copyPass: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`,
  edit:     `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  star:     `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  trash:    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`,
  check:    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  copied:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
};

function makeVaultIconButton(iconHtml, title, extraClass = "") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "vault-icon-btn" + (extraClass ? " " + extraClass : "");
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.innerHTML = iconHtml;
  return btn;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vault item rendering
// ─────────────────────────────────────────────────────────────────────────────

function renderVaultItems(credentials, { onFill, onEdit, onDelete, onDefault } = {}) {
  if (!vaultList) return;
  vaultList.innerHTML = "";

  if (!Array.isArray(credentials) || credentials.length === 0) {
    clearVaultList("No saved credentials yet.");
    updateFillButtonsState(); // still call it
    return;
  }

  for (const cred of credentials) {
    const article = document.createElement("article");
    article.className = "vault-item";

    const info = document.createElement("div");
    info.className = "vault-item-info";

    const titleEl = document.createElement("strong");
    titleEl.className = "vault-item-username";
    titleEl.textContent = String(cred?.usernameLabel || cred?.username || "(no username)");

    const meta = document.createElement("p");
    meta.className = "vault-item-domain";
    const badge = cred?.isDefault ? `<span class="default-badge" title="Default credential">★</span> ` : "";
    meta.innerHTML = `${badge}${cred?.domain || "(unknown)"}`;

    info.appendChild(titleEl);
    info.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "vault-item-actions";

    // Fill button
    const fillBtn = makeVaultIconButton(ICONS.fill, "Autofill this credential");
    fillBtn.addEventListener("click", () => onFill?.(cred));
    actions.appendChild(fillBtn);

    // Copy username
    const copyUserBtn = makeVaultIconButton(ICONS.copyUser, "Copy username");
    copyUserBtn.addEventListener("click", async () => {
      const username = cred?.username || cred?.usernameLabel || "";
      const prev = copyUserBtn.innerHTML;
      await copyToClipboard(username, null);
      copyUserBtn.innerHTML = ICONS.copied;
      copyUserBtn.classList.add("is-success");
      setTimeout(() => { copyUserBtn.innerHTML = prev; copyUserBtn.classList.remove("is-success"); }, 1500);
    });
    actions.appendChild(copyUserBtn);

    // Copy password
    const copyPassBtn = makeVaultIconButton(ICONS.copyPass, "Copy password");
    copyPassBtn.addEventListener("click", async () => {
      const prev = copyPassBtn.innerHTML;
      copyPassBtn.disabled = true;
      try {
        const response = await sendMessage({ type: "GET_CREDENTIAL_FOR_EDIT", hostname: showAllCredentials ? null : activeHostname, id: String(cred?.id || "") });
        if (!response?.ok) throw new Error();
        await copyToClipboard(response.credential?.password ?? "", null);
        copyPassBtn.innerHTML = ICONS.copied;
        copyPassBtn.classList.add("is-success");
        setTimeout(() => { copyPassBtn.innerHTML = prev; copyPassBtn.classList.remove("is-success"); copyPassBtn.disabled = false; }, 1500);
      } catch { copyPassBtn.innerHTML = prev; copyPassBtn.disabled = false; }
    });
    actions.appendChild(copyPassBtn);

    if (typeof onEdit === "function") {
      const editBtn = makeVaultIconButton(ICONS.edit, "Edit credential");
      editBtn.addEventListener("click", () => onEdit?.(cred));
      actions.appendChild(editBtn);
    }

    if (typeof onDefault === "function" && !cred?.isDefault) {
      const defaultBtn = makeVaultIconButton(ICONS.star, "Set as default");
      defaultBtn.addEventListener("click", () => onDefault?.(cred));
      actions.appendChild(defaultBtn);
    }

    if (typeof onDelete === "function") {
      const isPending = pendingDeleteId === cred?.id && Date.now() < pendingDeleteUntil;
      const deleteBtn = makeVaultIconButton(isPending ? ICONS.check : ICONS.trash, isPending ? "Confirm delete" : "Delete credential", isPending ? "is-danger" : "");
      deleteBtn.addEventListener("click", () => onDelete?.(cred));
      actions.appendChild(deleteBtn);
    }

    article.appendChild(info);
    article.appendChild(actions);
    vaultList.appendChild(article);
  }

  // Update fill button states after rendering the list
  updateFillButtonsState();
}

// ─────────────────────────────────────────────────────────────────────────────
// Credential operations
// ─────────────────────────────────────────────────────────────────────────────

function filterCredentials(credentials, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return credentials;
  return credentials.filter((cred) => {
    const domain = String(cred?.domain || "").toLowerCase();
    const username = String(cred?.username || cred?.usernameLabel || "").toLowerCase();
    return domain.includes(q) || username.includes(q);
  });
}

function computeBaseDomain(hostname) {
  if (typeof hostname !== "string") return null;
  const parts = hostname.split(".").filter(Boolean);
  if (parts.length < 2) return hostname;
  return parts.slice(-2).join(".");
}

async function fetchCredentialsForDomain(token, hostname) {
  if (!hostname) return [];
  const response = await sendMessage({ type: "LIST_CREDENTIALS_FOR_DOMAIN", hostname });
  if (!response?.ok) throw new Error(response?.error || "Unable to load credentials.");
  return Array.isArray(response.credentials) ? response.credentials : [];
}

async function deleteCredential(token, credentialId) {
  if (!token || !credentialId) return;
  const response = await sendMessage({ type: "DELETE_CREDENTIAL", id: credentialId });
  if (!response?.ok) throw new Error(response?.error || "Unable to delete.");
}

async function handleVaultFill(cred) {
  const tab = await queryActiveTab();
  const tabId = typeof tab?.id === "number" ? tab.id : null;
  const url = typeof tab?.url === "string" ? tab.url : null;
  if (!tabId || !url) { setStatus("Autofill failed", "No active tab detected.", true); return; }
  const injectResp = await injectContentScript(tabId, url);
  if (!injectResp?.ok && injectResp?.error) { setStatus("Autofill failed", injectResp.error, true); return; }
  const resp = await sendMessage({ type: "AUTOFILL_ACTIVE_TAB", tabId, url, credentialId: cred?.id });
  if (resp?.ok) { setStatus("Autofill", "Credentials filled on the current page."); reportActivity(); }
  else setStatus("Autofill failed", resp?.error || "Unable to autofill.", true);
}

async function handleVaultDelete(cred) {
  try {
    const token = currentVaultToken;
    const id = String(cred?.id || "");
    if (!token) { setStatus("Delete failed", "Missing session token.", true); return; }
    if (!id)    { setStatus("Delete failed", "Missing credential id.", true); return; }
    const now = Date.now();
    if (pendingDeleteId !== id || now >= pendingDeleteUntil) {
      pendingDeleteId = id;
      pendingDeleteUntil = now + 10_000;
      setStatus("Confirm delete", "Click Confirm on the same credential to delete it.");
      renderVaultItems(filterCredentials(lastVaultCredentials, vaultSearchInput?.value), { onFill: handleVaultFill, onEdit: handleVaultEdit, onDelete: handleVaultDelete, onDefault: handleVaultDefault });
      return;
    }
    await deleteCredential(token, id);
    pendingDeleteId = null;
    pendingDeleteUntil = 0;
    setStatus("Deleted", "Credential removed from the vault.");
    closeCredentialEditor();
    await refreshVaultView();
  } catch (e) { setStatus("Delete failed", e instanceof Error ? e.message : "Unable to delete.", true); }
}

async function handleVaultDefault(cred) {
  const id = String(cred?.id || "");

  // FIX: When in "all" view, pass the credential's actual domain, not the
  //      active tab hostname. But avoid double-applying computeBaseDomain —
  //      pass the raw domain and let the background script normalise it once.
  const hostname = showAllCredentials
    ? (cred?.domain || "")
    : (activeHostname || "");

  if (!hostname || !id) { setStatus("Default failed", "Missing domain or credential id.", true); return; }

  const response = await sendMessage({ type: "SET_DEFAULT_CREDENTIAL", hostname, id });
  if (response?.ok) { setStatus("Default updated", "This credential will be used first for the domain."); await refreshVaultView(); }
  else setStatus("Default failed", response?.error || "Unable to set default.", true);
}

function setEditFeedback(message, isError = false) {
  if (!editFeedback) return;
  editFeedback.textContent = message || "";
  editFeedback.classList.toggle("is-error", isError);
}

function openCredentialEditor({ id, username, password }) {
  editingCredentialId = id;
  if (editUsernameInput) editUsernameInput.value = username || "";
  if (editPasswordInput) { editPasswordInput.type = "password"; editPasswordInput.value = password || ""; }
  if (editRevealButton) editRevealButton.textContent = "Show";
  if (generatorPanel) generatorPanel.hidden = true;
  setEditFeedback("");
  if (credentialEditor) credentialEditor.hidden = false;
  editUsernameInput?.focus();
}

function closeCredentialEditor() {
  editingCredentialId = null;
  credentialEditForm?.reset();
  if (editPasswordInput) editPasswordInput.type = "password";
  if (editRevealButton) editRevealButton.textContent = "Show";
  if (generatorPanel) generatorPanel.hidden = true;
  setEditFeedback("");
  if (credentialEditor) credentialEditor.hidden = true;
}

async function handleVaultEdit(cred) {
  const id = String(cred?.id || "");
  const hostnameToFetch = showAllCredentials ? null : activeHostname;
  if (!id) { setStatus("Edit failed", "Missing credential id.", true); return; }
  const response = await sendMessage({ type: "GET_CREDENTIAL_FOR_EDIT", hostname: hostnameToFetch, id });
  if (!response?.ok) { setStatus("Edit failed", response?.error || "Unable to load credential.", true); return; }
  const current = response.credential || {};
  openCredentialEditor({ id, username: current.username || "", password: current.password || "" });
}

async function refreshVaultView() {
  const session = await readSession();
  const token = session?.token;

  if (!token) {
    currentVaultToken = null;
    closeCredentialEditor();
    setSavedCount(null, "For this site");
    if (vaultPill) vaultPill.textContent = "";
    clearVaultList("Please sign in to view credentials.");
    updateFillButtonsState(); // added
    return;
  }

  currentVaultToken = token;

  // Show loaders immediately
  setVaultListLoading();
  if (savedCountLabel) setLoading(savedCountLabel);

  try {
    let credentials = [];
    let subtitle = "";
    let pillText = "";

    if (showAllCredentials) {
      const response = await sendMessage({ type: "LIST_ALL_CREDENTIALS" });
      if (!response?.ok) throw new Error(response?.error || "Unable to load all credentials.");
      credentials = Array.isArray(response.credentials) ? response.credentials : [];
      subtitle = "All saved credentials";
      pillText = "All";
    } else if (activeHostname) {
      credentials = await fetchCredentialsForDomain(token, activeHostname);
      subtitle = `For ${activeHostname}`;
      if ((!Array.isArray(credentials) || credentials.length === 0) && activeHostname) {
        const base = computeBaseDomain(activeHostname);
        if (base && base !== activeHostname) {
          credentials = await fetchCredentialsForDomain(token, base);
          subtitle = `For ${base}`;
        }
      }
      pillText = "Live";
    } else {
      setSavedCount(null, "For this site");
      if (vaultPill) vaultPill.textContent = "";
      clearVaultList("Open a website tab to see saved credentials for that domain, or switch to 'All sites'.");
      updateFillButtonsState(); // added
      return;
    }

    const count = Array.isArray(credentials) ? credentials.length : 0;
    setSavedCount(count, subtitle);
    if (vaultPill) vaultPill.textContent = pillText;
    lastVaultCredentials = Array.isArray(credentials) ? credentials : [];
    const filtered = filterCredentials(lastVaultCredentials, vaultSearchInput?.value);
    renderVaultItems(filtered, { onFill: handleVaultFill, onEdit: handleVaultEdit, onDelete: handleVaultDelete, onDefault: handleVaultDefault });
    
    // Make sure buttons are updated
    updateFillButtonsState();
    
  } catch (e) {
    setSavedCount(null, "For this site");
    if (vaultPill) vaultPill.textContent = "Error";
    clearVaultList(e instanceof Error ? e.message : "Unable to load credentials.");
    updateFillButtonsState(); // added
  }
}

vaultSearchInput?.addEventListener("input", () => {
  const filtered = filterCredentials(lastVaultCredentials, vaultSearchInput.value);
  renderVaultItems(filtered, { onFill: handleVaultFill, onEdit: handleVaultEdit, onDelete: handleVaultDelete, onDefault: handleVaultDefault });
});

editCancelButton?.addEventListener("click", () => closeCredentialEditor());

editRevealButton?.addEventListener("click", () => {
  if (!editPasswordInput || !editRevealButton) return;
  const showing = editPasswordInput.type === "text";
  editPasswordInput.type = showing ? "password" : "text";
  editRevealButton.textContent = showing ? "Show" : "Hide";
});

credentialEditForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!editingCredentialId) { setEditFeedback("No credential selected.", true); return; }
  const username = editUsernameInput?.value?.trim() || "";
  const password = editPasswordInput?.value || "";
  if (!password) { setEditFeedback("Password is required.", true); return; }
  setEditFeedback("Saving...");
  const update = await sendMessage({ type: "UPDATE_CREDENTIAL", id: editingCredentialId, username, password });
  if (update?.ok) { setStatus("Credential updated", "Saved changes to the vault."); closeCredentialEditor(); await refreshVaultView(); }
  else setEditFeedback(update?.error || "Unable to update credential.", true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Active tab / autofill state
// ─────────────────────────────────────────────────────────────────────────────

async function refreshActiveTabAutofillState() {
  if (!hasBrowserRuntime()) {
    setDetectedSiteLabels({ url: null, fieldStatusText: "-" });
    return;
  }

  // Show loaders
  if (detectedPageLabel) setLoading(detectedPageLabel);
  if (siteFieldsStatusLabel) siteFieldsStatusLabel.textContent = "Checking…";

  const tab = await queryActiveTab();
  const url = typeof tab?.url === "string" ? tab.url : null;
  const tabId = typeof tab?.id === "number" ? tab.id : null;

  const domain = (() => { 
    try { return url ? new URL(url).hostname : "-"; } 
    catch { return "-"; } 
  })();
  
  activeHostname = domain && domain !== "-" ? domain : null;

  if (detectedPageLabel) detectedPageLabel.textContent = domain;
  if (siteDomainLabel) siteDomainLabel.textContent = domain;

  if (!tabId) {
    if (siteFieldsStatusLabel) siteFieldsStatusLabel.textContent = "No active tab";
    await refreshVaultView();
    return;
  }

  // First attempt
  let detectResp = await sendMessageToTab(tabId, { type: "DETECT_LOGIN_FIELDS" });

  // Retry with injection if needed
  if (detectResp?.ok === false) {
    const errorMsg = String(detectResp?.error || "").toLowerCase();

    if (errorMsg.includes("receiving end does not exist") ||
        errorMsg.includes("could not establish") ||
        errorMsg.includes("tab messaging failed") ||
        errorMsg.includes("could not connect")) {
      
      const injectResp = await injectContentScript(tabId, url);
      
      if (injectResp?.ok) {
        await new Promise(r => setTimeout(r, 120)); // slightly longer delay
        detectResp = await sendMessageToTab(tabId, { type: "DETECT_LOGIN_FIELDS" });
      }
    }
  }

  // === FINAL STATUS LOGIC (Fixed) ===
  if (!detectResp || detectResp.ok === false) {
    // Only real failure
    setDetectedSiteLabels({ 
      url, 
      fieldStatusText: "Unable to detect fields" 
    });
  } 
  else if (detectResp.hasPasswordField === true) {
    // Login page
    setDetectedSiteLabels({ 
      url, 
      fieldStatusText: detectResp.hasUsernameField 
        ? "Login fields found" 
        : "Password field found" 
    });
  } 
  else {
    // Normal page - no login fields
    setDetectedSiteLabels({ 
      url, 
      fieldStatusText: "No login fields detected" 
    });
  }

  await refreshVaultView();

  const autoFillEnabled = await getAutofillOnLoad();
  if (autoFillEnabled && tabId && isInjectableUrl(url)) {
    const tab2 = await queryActiveTab(); // re-fetch to get fresh tabId/url
    const freshTabId = typeof tab2?.id === "number" ? tab2.id : tabId;
    const freshUrl = typeof tab2?.url === "string" ? tab2.url : url;
    void sendMessage({ type: "AUTOFILL_ACTIVE_TAB", tabId: freshTabId, url: freshUrl });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Session storage
// ─────────────────────────────────────────────────────────────────────────────

async function readSession() {
  if (isChromeSessionStorageAvailable()) {
    const result = await chrome.storage.session.get(SESSION_KEY);
    return result?.[SESSION_KEY] ?? null;
  }
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
}

async function writeSession(session) {
  if (isChromeSessionStorageAvailable()) { await chrome.storage.session.set({ [SESSION_KEY]: session }); return; }
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

async function clearSession() {
  if (isChromeSessionStorageAvailable()) { await chrome.storage.session.remove(SESSION_KEY); return; }
  localStorage.removeItem(SESSION_KEY);
}

function reportActivity() {
  if (hasBrowserRuntime()) void sendMessage({ type: "ACTIVITY" });
}

async function clearVaultKey() {
  if (!hasBrowserRuntime()) return;
  await sendMessage({ type: "CLEAR_KEY" });
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────

async function signOut({ title, message, isError = false } = {}) {
  closeCredentialEditor();
  await clearVaultKey();
  await clearSession();
  signInForm?.reset();
  registerForm?.reset();
  const signInFeedback = signInForm?.querySelector(".auth-feedback");
  if (signInFeedback) { signInFeedback.textContent = ""; signInFeedback.classList.remove("is-error"); }
  const registerFeedback = registerForm?.querySelector(".auth-feedback");
  if (registerFeedback) { registerFeedback.textContent = ""; registerFeedback.classList.remove("is-error"); }
  unlockForm?.reset();
  setActiveTab("sign-in");
  setStatus(title || "Signed out", message || "Please sign in to continue.", isError);
  setViewState({ isAuthed: false, isUnlocked: false });
  setDetectedSiteLabels({ url: null, fieldStatusText: "-" });
  activeHostname = null;
  setSavedCount(null, "For this site");
  resetVaultScope();
  if (vaultPill) vaultPill.textContent = "";
  if (vaultList) vaultList.innerHTML = "";
}

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function refreshSessionState() {

  showPageLoader();
  try{
    const session = await readSession();

  if (!session?.token) {
    await clearVaultKey();
    setStatus("Extension ready", "Connects to the local backend on localhost:3001.");
    setViewState({ isAuthed: false, isUnlocked: false });
    setDetectedSiteLabels({ url: null, fieldStatusText: "-" });
    activeHostname = null;
    setSavedCount(null, "For this site");
    resetVaultScope();
    if (vaultPill) vaultPill.textContent = "";
    if (vaultList) vaultList.innerHTML = "";
    closeCredentialEditor();
    return;
  }

  let isUnlocked = !hasBrowserRuntime();
  if (hasBrowserRuntime()) {
    const response = await sendMessage({ type: "IS_UNLOCKED" });
    isUnlocked = Boolean(response?.unlocked);
  }

  setViewState({ isAuthed: true, isUnlocked });
  reportActivity();

  if (isUnlocked) {
    await refreshActiveTabAutofillState();
  } else {
    setSavedCount(null, "For this site");
    if (vaultPill) vaultPill.textContent = "";
    clearVaultList("Vault locked. Unlock to view passwords.");
    closeCredentialEditor();
    resetVaultScope();
  }

  try {
    const data = await apiRequest("/auth/me", { headers: { Authorization: `Bearer ${session.token}` } });
    if (isUnlocked) {
      const rememberResp = await sendMessage({ type: "GET_REMEMBER_ME" });
      const isRemembered = rememberResp?.rememberMe === true;
      setStatus("Unlocked", isRemembered ? `Vault ready for ${data.user.email}. Auto-lock disabled.` : `Vault ready for ${data.user.email}. Auto-lock after 10 minutes of inactivity.`);
    } else {
      setStatus("Vault locked", `Signed in as ${data.user.email}. Unlock to view passwords.`);
    }
  } catch {
    await signOut({ title: "Session expired", message: "Please sign in again.", isError: true });
  }
  } finally {
    hidePageLoader();
  }
  
}

function attachAuthFeedback(form) {
  let feedback = form.querySelector(".auth-feedback");
  if (!feedback) {
    feedback = document.createElement("p");
    feedback.className = "auth-feedback";
    feedback.setAttribute("aria-live", "polite");
    form.appendChild(feedback);
  }
  return feedback;
}

async function handleSignIn(event) {
  event.preventDefault();
  if (!signInForm) return;
  const feedback = attachAuthFeedback(signInForm);
  const formData = new FormData(signInForm);
  const email = String(formData.get("email") || "").trim();
  const password = String(formData.get("password") || "");
  const rememberMe = document.getElementById("remember-me-checkbox")?.checked ?? false;
  feedback.textContent = "";
  feedback.classList.remove("is-error");
  try {
    const data = await apiRequest("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    if (hasBrowserRuntime()) {
      const keyCheckResp = await sendMessage({ type: "CREATE_KEY_CHECK", masterPassword: password, salt: data.salt });
      if (!keyCheckResp?.ok) throw new Error(keyCheckResp?.error || "Unable to initialize vault session");
      await sendMessage({ type: "SET_REMEMBER_ME", rememberMe });
      await writeSession({ ...data, keyCheckCiphertext: keyCheckResp.keyCheckCiphertext, keyCheckIv: keyCheckResp.keyCheckIv });
      const unlockResp = await sendMessage({ type: "UNLOCK", masterPassword: password, salt: data.salt, keyCheckCiphertext: keyCheckResp.keyCheckCiphertext, keyCheckIv: keyCheckResp.keyCheckIv });
      if (unlockResp?.ok) {
        setViewState({ isAuthed: true, isUnlocked: true });
        setStatus("Unlocked", `Welcome back, ${data.user.email}.`);
        feedback.textContent = "Signed in and unlocked.";
        reportActivity();
        void refreshActiveTabAutofillState();
      } else {
        setViewState({ isAuthed: true, isUnlocked: false });
        setStatus("Vault locked", `Signed in as ${data.user.email}. Unlock to view passwords.`);
        feedback.textContent = "Signed in. Please unlock your vault.";
        reportActivity();
      }
    } else {
      await writeSession(data);
      setViewState({ isAuthed: true, isUnlocked: true });
      setStatus("Signed in", `Welcome back, ${data.user.email}.`);
      reportActivity();
    }
  } catch (e) {
    feedback.textContent = e instanceof Error ? e.message : "Unable to log in.";
    feedback.classList.add("is-error");
    setStatus("Login failed", "Check your credentials and try again.", true);
  }
}

async function handleRegister(event) {
  event.preventDefault();
  if (!registerForm) return;
  const feedback = attachAuthFeedback(registerForm);
  const formData = new FormData(registerForm);
  const email = String(formData.get("register-email") || "").trim();
  const password = String(formData.get("register-password") || "");
  const confirmPassword = String(formData.get("confirm-password") || "");
  feedback.textContent = "";
  feedback.classList.remove("is-error");
  if (password !== confirmPassword) {
    feedback.textContent = "Passwords do not match.";
    feedback.classList.add("is-error");
    return;
  }
  try {
    const data = await apiRequest("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });

    // Show the recovery key modal and, after closing, reset to sign‑in
    showRecoveryKeyModal(data.recoveryKey, () => {
      setActiveTab("sign-in");
      registerForm.reset();
      // reset strength meter
      if (strengthMeter) strengthMeter.hidden = true;
      if (registerPasswordInput) registerPasswordInput.value = "";
      if (confirmPasswordInput) confirmPasswordInput.value = "";
      setStatus("Account created", "You can now sign in with your master password.");
    });

    feedback.textContent = "Account created. Please sign in.";
  } catch (e) {
    feedback.textContent = e instanceof Error ? e.message : "Unable to create account.";
    feedback.classList.add("is-error");
    setStatus("Registration failed", "Try a different email or check the backend.", true);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Event listeners
// ─────────────────────────────────────────────────────────────────────────────

tabButtons.forEach((btn) => btn.addEventListener("click", () => { if (btn.dataset.tab) setActiveTab(btn.dataset.tab); }));
signInForm?.addEventListener("submit", handleSignIn);
registerForm?.addEventListener("submit", handleRegister);

lockButton?.addEventListener("click", async () => {
  closeCredentialEditor();
  await clearVaultKey();
  setStatus("Vault locked", "Vault locked. Unlock to view passwords.");
  setViewState({ isAuthed: true, isUnlocked: false });
  setDetectedSiteLabels({ url: null, fieldStatusText: "-" });
  activeHostname = null;
  setSavedCount(null, "For this site");
  resetVaultScope();
  if (vaultPill) vaultPill.textContent = "";
  if (vaultList) vaultList.innerHTML = "";
});

signOutButton?.addEventListener("click", async () => signOut({ title: "Signed out", message: "Session cleared. Sign in to continue." }));

unlockForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const session = await readSession();
  if (!session?.salt) { setStatus("Unlock failed", "Missing salt in session. Please sign in again.", true); return; }
  if (!session?.keyCheckCiphertext || !session?.keyCheckIv) { setStatus("Unlock failed", "Missing vault verifier. Please sign out and sign in again.", true); return; }
  const formData = new FormData(unlockForm);
  const masterPassword = String(formData.get("unlock-password") || "");
  if (!masterPassword) { setStatus("Unlock failed", "Enter your master password.", true); return; }
  const unlockResp = await sendMessage({ type: "UNLOCK", masterPassword, salt: session.salt, keyCheckCiphertext: session.keyCheckCiphertext, keyCheckIv: session.keyCheckIv });
  if (unlockResp?.ok) {
    setViewState({ isAuthed: true, isUnlocked: true });
    setStatus("Unlocked", "Vault unlocked. Auto-lock after 10 min inactivity.");
    unlockForm.reset();
    resetVaultScope();
    reportActivity();
    void refreshActiveTabAutofillState();
  } else {
    setStatus("Unlock failed", unlockResp?.error || "Unable to unlock vault.", true);
  }
});

autofillButton?.addEventListener("click", async () => {
  if (!hasBrowserRuntime()) return;
  const tab = await queryActiveTab();
  const tabId = typeof tab?.id === "number" ? tab.id : null;
  const url = typeof tab?.url === "string" ? tab.url : null;
  if (!tabId || !url) { setStatus("Autofill failed", "No active tab detected.", true); return; }
  const injectResp = await injectContentScript(tabId, url);
  if (!injectResp?.ok && injectResp?.error) { setStatus("Autofill failed", injectResp.error, true); return; }
  const resp = await sendMessage({ type: "AUTOFILL_ACTIVE_TAB", tabId, url });
  if (resp?.ok) { setStatus("Autofill", "Credentials filled on the current page."); reportActivity(); }
  else setStatus("Autofill failed", resp?.error || "Unable to autofill.", true);
});

refreshTabButton?.addEventListener("click", async () => refreshActiveTabAutofillState());

async function setVaultScope(scope) {
  showAllCredentials = scope === "all";
  vaultScopeButtons.forEach((btn) => btn.classList.toggle("is-active", btn.dataset.vaultScope === scope));
  if (vaultSearchInput) {
    vaultSearchInput.value = "";
    vaultSearchInput.placeholder = showAllCredentials ? "Search all saved credentials" : "Search this site's saved credentials";
  }
  await refreshVaultView();
}

function resetVaultScope() { return setVaultScope("site"); }

vaultScopeButtons.forEach((btn) => { btn.addEventListener("click", () => { if (btn.dataset.vaultScope) void setVaultScope(btn.dataset.vaultScope); }); });

// ─────────────────────────────────────────────────────────────────────────────
// Modals
// ─────────────────────────────────────────────────────────────────────────────

function handleForgotPassword() {
  const modal = document.getElementById("forgot-password-modal");
  const emailInput = document.getElementById("fp-email");
  const recoveryKeyInput = document.getElementById("fp-recovery-key");
  const newPwdInput = document.getElementById("fp-new-password");
  const confirmInput = document.getElementById("fp-confirm-password");
  const feedback = document.getElementById("fp-feedback");
  const submitBtn = document.getElementById("fp-submit-button");
  const cancelBtn = document.getElementById("fp-cancel-button");
  const closeBtn = document.getElementById("fp-modal-close");
  if (!modal) return;
  emailInput.value = ""; recoveryKeyInput.value = ""; newPwdInput.value = ""; confirmInput.value = ""; feedback.textContent = "";
  const closeModal = () => { modal.hidden = true; submitBtn.onclick = null; cancelBtn.onclick = null; closeBtn.onclick = null; };
  const handleSubmit = async () => {
    const email = emailInput.value.trim();
    const recoveryKey = recoveryKeyInput.value.trim();
    const newPassword = newPwdInput.value;
    const confirm = confirmInput.value;
    if (!email) { feedback.textContent = "Email is required."; return; }
    if (!recoveryKey) { feedback.textContent = "Recovery key is required."; return; }
    if (newPassword.length < 8) { feedback.textContent = "New password must be at least 8 characters."; return; }
    if (newPassword !== confirm) { feedback.textContent = "Passwords do not match."; return; }
    submitBtn.disabled = true; submitBtn.textContent = "Resetting...";
    const response = await sendMessage({ type: "RESET_WITH_RECOVERY", email, recoveryKey, newPassword });
    submitBtn.disabled = false; submitBtn.textContent = "Reset Password";
    if (response?.ok && response.recoveryKey) { closeModal(); showRecoveryKeyModal(response.recoveryKey, () => refreshSessionState()); }
    else feedback.textContent = response?.error || "Reset failed. Invalid recovery key or email.";
  };
  submitBtn.onclick = handleSubmit; cancelBtn.onclick = closeModal; closeBtn.onclick = closeModal;
  modal.hidden = false; emailInput.focus();
}

function showChangePasswordModal() {
  const modal = document.getElementById("change-password-modal");
  const oldPwdInput = document.getElementById("cp-old-password");
  const newPwdInput = document.getElementById("cp-new-password");
  const confirmInput = document.getElementById("cp-confirm-password");
  const feedback = document.getElementById("cp-feedback");
  const submitBtn = document.getElementById("cp-submit-button");
  const cancelBtn = document.getElementById("cp-cancel-button");
  const closeBtn = document.getElementById("cp-modal-close");
  if (!modal) return;
  oldPwdInput.value = ""; newPwdInput.value = ""; confirmInput.value = ""; feedback.textContent = "";
  const closeModal = () => { modal.hidden = true; submitBtn.onclick = null; cancelBtn.onclick = null; closeBtn.onclick = null; };
  const handleSubmit = async () => {
    const oldPwd = oldPwdInput.value;
    const newPwd = newPwdInput.value;
    const confirm = confirmInput.value;
    if (!oldPwd) { feedback.textContent = "Current password is required."; return; }
    if (newPwd.length < 8) { feedback.textContent = "New password must be at least 8 characters."; return; }
    if (newPwd !== confirm) { feedback.textContent = "New passwords do not match."; return; }
    submitBtn.disabled = true; submitBtn.textContent = "Changing...";
    const response = await sendMessage({ type: "CHANGE_MASTER_PASSWORD", oldPassword: oldPwd, newPassword: newPwd });
    submitBtn.disabled = false; submitBtn.textContent = "Change Password";
    if (response?.ok && response.recoveryKey) { closeModal(); showRecoveryKeyModal(response.recoveryKey, () => refreshSessionState()); }
    else feedback.textContent = response?.error || "Change failed. Check your current password.";
  };
  submitBtn.onclick = handleSubmit; cancelBtn.onclick = closeModal; closeBtn.onclick = closeModal;
  modal.hidden = false; oldPwdInput.focus();
}

let pendingRecoveryKey = null;
let pendingCallback = null;

function showRecoveryKeyModal(recoveryKey, onConfirm) {
  const modal = document.getElementById("recovery-modal");
  const display = document.getElementById("recovery-key-display");
  const copyBtn = document.getElementById("copy-recovery-key");
  const confirmBtn = document.getElementById("modal-confirm");
  const closeBtn = document.getElementById("modal-close");
  if (!modal || !display) return;
  pendingRecoveryKey = recoveryKey;
  pendingCallback = onConfirm;
  display.textContent = recoveryKey;
  copyBtn.onclick = () => { navigator.clipboard.writeText(recoveryKey); copyBtn.textContent = "Copied!"; setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500); };
  const closeModal = () => { modal.hidden = true; if (pendingCallback) pendingCallback(); pendingRecoveryKey = null; pendingCallback = null; confirmBtn.onclick = null; closeBtn.onclick = null; copyBtn.onclick = null; };
  confirmBtn.onclick = closeModal; closeBtn.onclick = closeModal;
  modal.hidden = false;
}

window.addEventListener("mousemove", reportActivity);
window.addEventListener("keydown", reportActivity);
window.addEventListener("click", reportActivity);

document.getElementById("autofill-toggle")?.addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const current = btn.getAttribute("aria-checked") === "true";
  await setAutofillOnLoad(!current);
});

document.getElementById("change-password-button")?.addEventListener("click", showChangePasswordModal);
document.getElementById("forgot-password-link")?.addEventListener("click", (e) => { e.preventDefault(); handleForgotPassword(); });

setActiveTab("sign-in");
document.getElementById("recovery-modal")?.setAttribute("hidden", "true");
document.getElementById("change-password-modal")?.setAttribute("hidden", "true");
document.getElementById("forgot-password-modal")?.setAttribute("hidden", "true");
setViewState({ isAuthed: false, isUnlocked: false });
void refreshSessionState();
void loadAutofillToggle();