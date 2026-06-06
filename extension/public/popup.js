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

// ── Standalone generator panel ────────────────────────────────────────────────
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

const API_BASE = "http://localhost:3001/api";
const SESSION_KEY = "password-manager-session";

// ═══════════════════════════════════════════════════════════════════════════════
// PASSWORD GENERATOR CORE
// ═══════════════════════════════════════════════════════════════════════════════

const CHAR_SETS = {
  lower:   "abcdefghijklmnopqrstuvwxyz",
  upper:   "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  numbers: "0123456789",
  symbols: "!@#$%^&*()-_=+[]{}|;:,.<>?",
};

/**
 * Generates a cryptographically random password using the Web Crypto API.
 * Always includes at least one character from each enabled set so the result
 * satisfies common "must contain X" requirements.
 *
 * @param {object} opts
 * @param {number}  opts.length    - Total character count (8–64)
 * @param {boolean} opts.uppercase - Include A–Z
 * @param {boolean} opts.numbers   - Include 0–9
 * @param {boolean} opts.symbols   - Include symbols
 * @returns {string} The generated password
 */
function generatePassword({ length = 20, uppercase = true, numbers = true, symbols = true } = {}) {
  // Build the full alphabet and note required characters
  let alphabet = CHAR_SETS.lower;
  const required = [];

  if (uppercase) {
    alphabet += CHAR_SETS.upper;
    required.push(pickRandom(CHAR_SETS.upper));
  }
  if (numbers) {
    alphabet += CHAR_SETS.numbers;
    required.push(pickRandom(CHAR_SETS.numbers));
  }
  if (symbols) {
    alphabet += CHAR_SETS.symbols;
    required.push(pickRandom(CHAR_SETS.symbols));
  }

  // Always require at least one lowercase
  required.push(pickRandom(CHAR_SETS.lower));

  // Fill the rest randomly from the full alphabet
  const remaining = length - required.length;
  const chars = [...required];

  for (let i = 0; i < remaining; i++) {
    chars.push(pickRandom(alphabet));
  }

  // Shuffle using Fisher-Yates with crypto random values
  shuffleArray(chars);
  return chars.join("");
}

/** Picks a single cryptographically random character from a string. */
function pickRandom(str) {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return str[array[0] % str.length];
}

/** Fisher-Yates shuffle using crypto random values (in-place). */
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const randomArr = new Uint32Array(1);
    crypto.getRandomValues(randomArr);
    const j = randomArr[0] % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * Copies text to clipboard and gives brief visual feedback on a button.
 *
 * @param {string} text     - Text to copy
 * @param {HTMLButtonElement} button - Button to animate
 */
async function copyToClipboard(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const original = button.textContent;
      button.textContent = "Copied ✓";
      button.disabled = true;
      setTimeout(() => {
        button.textContent = original;
        button.disabled = false;
      }, 1500);
    }
  } catch {
    // Clipboard API may be unavailable on some extension pages; fail silently.
  }
}

// ─── Edit-panel generator ─────────────────────────────────────────────────────

/** Reads current options from the edit-panel generator controls and regenerates. */
function refreshEditGenerator() {
  if (!generatorPreview) return;
  const pwd = generatePassword({
    length: Number(generatorLength?.value ?? 20),
    uppercase: genUppercase?.checked ?? true,
    numbers: genNumbers?.checked ?? true,
    symbols: genSymbols?.checked ?? true,
  });
  generatorPreview.textContent = pwd;
}

editGenerateButton?.addEventListener("click", () => {
  if (!generatorPanel) return;
  const isHidden = generatorPanel.hidden;
  generatorPanel.hidden = !isHidden;
  if (isHidden) {
    refreshEditGenerator();
    // Show the password so the user can see what they're about to use
    if (editPasswordInput) editPasswordInput.type = "text";
    if (editRevealButton) editRevealButton.textContent = "Hide";
  }
});

generatorLength?.addEventListener("input", () => {
  if (generatorLengthValue) generatorLengthValue.textContent = generatorLength.value;
  refreshEditGenerator();
});

[genUppercase, genNumbers, genSymbols].forEach((checkbox) => {
  checkbox?.addEventListener("change", refreshEditGenerator);
});

generatorRefreshButton?.addEventListener("click", refreshEditGenerator);

generatorCopyButton?.addEventListener("click", () => {
  copyToClipboard(generatorPreview?.textContent ?? "", generatorCopyButton);
});

generatorUseButton?.addEventListener("click", () => {
  if (!editPasswordInput || !generatorPreview) return;
  editPasswordInput.value = generatorPreview.textContent;
  editPasswordInput.type = "text";
  if (editRevealButton) editRevealButton.textContent = "Hide";
  if (generatorPanel) generatorPanel.hidden = true;
});

// ─── Register-form generator (fills both password fields) ────────────────────

registerGenerateButton?.addEventListener("click", () => {
  const pwd = generatePassword({ length: 20, uppercase: true, numbers: true, symbols: true });
  if (registerPasswordInput) {
    registerPasswordInput.value = pwd;
    registerPasswordInput.type = "text"; // Reveal so user can see/copy it
  }
  if (confirmPasswordInput) {
    confirmPasswordInput.value = pwd;
    confirmPasswordInput.type = "text";
  }
  // Copy to clipboard automatically — convenient for onboarding
  copyToClipboard(pwd, registerGenerateButton);
});

// ═══════════════════════════════════════════════════════════════════════════════
// PASSWORD STRENGTH METER
// ═══════════════════════════════════════════════════════════════════════════════

const strengthMeter = document.getElementById("strength-meter");
const strengthLabel = document.getElementById("strength-label");
const strengthSegs = Array.from(document.querySelectorAll(".strength-seg"));
const registerSubmitButton = document.getElementById("register-submit-button");

/**
 * Scores a password 0–4 using a set of heuristics.
 *
 * Score breakdown:
 *   +1  length ≥ 10
 *   +1  length ≥ 16
 *   +1  contains both lower + upper case
 *   +1  contains at least one digit
 *   +1  contains at least one symbol
 *   −1  very common patterns (keyboard walks, repeated chars)
 *
 * Result is clamped 0–4.
 *
 * @param {string} pwd
 * @returns {{ score: number, label: string }}
 */
function scorePassword(pwd) {
  if (!pwd) return { score: -1, label: "" };

  let score = 0;

  // Length bonuses
  if (pwd.length >= 10) score++;
  if (pwd.length >= 16) score++;

  // Character variety
  if (/[a-z]/.test(pwd) && /[A-Z]/.test(pwd)) score++;
  if (/[0-9]/.test(pwd)) score++;
  if (/[^a-zA-Z0-9]/.test(pwd)) score++;

  // Penalty: very common patterns
  const commonWalks = /^(qwerty|asdf|zxcv|1234|abcd|password|letmein|iloveyou)/i;
  const repeatedChars = /(.)\1{3,}/; // same char 4+ times in a row
  if (commonWalks.test(pwd) || repeatedChars.test(pwd)) score = Math.max(0, score - 1);

  const clamped = Math.min(4, Math.max(0, score));
  const labels = ["Weak", "Fair", "Good", "Strong", "Very strong"];

  return { score: clamped, label: labels[clamped] };
}

// Score → visual config: how many segments to fill and what colour to use
const STRENGTH_CONFIG = [
  { filled: 1, color: "#dc2626" }, // Weak     — red
  { filled: 2, color: "#d97706" }, // Fair     — amber
  { filled: 3, color: "#ca8a04" }, // Good     — yellow-amber
  { filled: 4, color: "#16a34a" }, // Strong   — green
  { filled: 5, color: "#0f766e" }, // Very strong — accent teal
];

// Minimum score the user must reach before the confirm field + submit unlock
const MIN_SCORE_TO_PROCEED = 2; // "Good"

function applyStrengthUI(score) {
  if (!strengthMeter || !strengthLabel || !strengthSegs.length) return;

  const isEmpty = score === -1;
  strengthMeter.hidden = isEmpty;

  if (isEmpty) {
    // Lock confirm + submit when field is blank
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

  strengthLabel.textContent = STRENGTH_CONFIG[score]
    ? `${STRENGTH_CONFIG[score - 0]?.color ? "" : ""}${scorePassword._lastLabel || ""}`
    : "";

  // Re-derive label text from the score index
  const labelText = ["Weak", "Fair", "Good", "Strong", "Very strong"][score] ?? "";
  strengthLabel.textContent = labelText;
  strengthLabel.style.color =
    score < MIN_SCORE_TO_PROCEED ? "#b45309" : score >= 3 ? "#0f766e" : "#1f2933";

  // Gate confirm field and submit button on minimum strength
  const canProceed = score >= MIN_SCORE_TO_PROCEED;
  if (confirmPasswordInput) confirmPasswordInput.disabled = !canProceed;
  if (registerSubmitButton) registerSubmitButton.disabled = !canProceed;
}

// Wire up: score on every keystroke in the register password input
registerPasswordInput?.addEventListener("input", () => {
  const pwd = registerPasswordInput.value;
  const { score } = scorePassword(pwd);
  applyStrengthUI(score);
});

// Also reset meter when the generate button fills the field
// (We override the generate button handler defined earlier to also call applyStrengthUI)
const _originalRegisterGenerateClick = registerGenerateButton?.onclick ?? null;
registerGenerateButton?.addEventListener("click", () => {
  // The generate handler already ran (event listeners fire in order).
  // We just need to score whatever value ended up in the field.
  const pwd = registerPasswordInput?.value ?? "";
  const { score } = scorePassword(pwd);
  applyStrengthUI(score);
});

// Initialise hidden on load
if (strengthMeter) strengthMeter.hidden = true;

// ─── Standalone generator panel ───────────────────────────────────────────────

function refreshStandaloneGenerator() {
  if (!standaloneGeneratorPreview) return;
  const pwd = generatePassword({
    length: Number(standaloneGeneratorLength?.value ?? 20),
    uppercase: standaloneGenUppercase?.checked ?? true,
    numbers: standaloneGenNumbers?.checked ?? true,
    symbols: standaloneGenSymbols?.checked ?? true,
  });
  standaloneGeneratorPreview.textContent = pwd;
}

standaloneGeneratorLength?.addEventListener("input", () => {
  if (standaloneGeneratorLengthValue) {
    standaloneGeneratorLengthValue.textContent = standaloneGeneratorLength.value;
  }
  refreshStandaloneGenerator();
});

[standaloneGenUppercase, standaloneGenNumbers, standaloneGenSymbols].forEach((cb) => {
  cb?.addEventListener("change", refreshStandaloneGenerator);
});

standaloneGeneratorRefreshButton?.addEventListener("click", refreshStandaloneGenerator);

standaloneGeneratorCopyButton?.addEventListener("click", () => {
  copyToClipboard(standaloneGeneratorPreview?.textContent ?? "", standaloneGeneratorCopyButton);
});

standaloneGeneratorClose?.addEventListener("click", () => {
  if (standaloneGeneratorPanel) standaloneGeneratorPanel.hidden = true;
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXISTING POPUP LOGIC (unchanged except renderVaultItems — see below)
// ═══════════════════════════════════════════════════════════════════════════════

function hasChromeRuntime() {
  return typeof chrome !== "undefined" && !!chrome.runtime && typeof chrome.runtime.sendMessage === "function";
}

function setActiveTab(tabName) {
  tabButtons.forEach((button) => {
    const isActive = button.dataset.tab === tabName;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });

  tabPanels.forEach((panel) => {
    const isActive = panel.dataset.panel === tabName;
    panel.hidden = !isActive;
    panel.classList.toggle("is-active", isActive);
  });
}

function setStatus(title, message, isError = false) {
  if (connectionTitle) {
    connectionTitle.textContent = title;
  }

  if (connectionMessage) {
    connectionMessage.textContent = message;
    connectionMessage.classList.toggle("is-error", isError);
  }
}

function setViewState({ isAuthed, isUnlocked }) {
  gatedSections.forEach((section) => {
    const when = section.getAttribute("data-when");
    if (when === "unauthed") section.hidden = isAuthed;
    if (when === "locked") section.hidden = !isAuthed || isUnlocked;
    if (when === "unlocked") section.hidden = !isAuthed || !isUnlocked;
  });

  if (lockButton) {
    lockButton.hidden = !isAuthed || !isUnlocked;
  }

  if (signOutButton) {
    signOutButton.hidden = !isAuthed;
  }
  
  const changePasswordButton = document.getElementById("change-password-button");
  if (changePasswordButton) {
    changePasswordButton.hidden = !isAuthed || !isUnlocked;
  }
}

function isChromeSessionStorageAvailable() {
  return (
    typeof chrome !== "undefined" &&
    !!chrome.storage &&
    !!chrome.storage.session &&
    typeof chrome.storage.session.get === "function"
  );
}

function sendMessage(message) {
  if (!hasChromeRuntime()) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        resolve(response ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

function queryActiveTab() {
  if (typeof chrome === "undefined" || !chrome.tabs || typeof chrome.tabs.query !== "function") {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(Array.isArray(tabs) && tabs.length > 0 ? tabs[0] : null);
      });
    } catch {
      resolve(null);
    }
  });
}

function sendMessageToTab(tabId, message) {
  if (typeof chrome === "undefined" || !chrome.tabs || typeof chrome.tabs.sendMessage !== "function") {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime?.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }

        resolve(response ?? { ok: true });
      });
    } catch {
      resolve(null);
    }
  });
}

function isInjectableUrl(url) {
  return typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"));
}

function injectContentScript(tabId, url) {
  if (!isInjectableUrl(url)) {
    return Promise.resolve({ ok: false, error: "This page does not allow autofill." });
  }

  if (typeof chrome === "undefined" || !chrome.scripting || typeof chrome.scripting.executeScript !== "function") {
    return Promise.resolve({ ok: false, error: "Scripting API not available." });
  }

  return new Promise((resolve) => {
    try {
      chrome.scripting.executeScript(
        {
          target: { tabId, allFrames: true },
          files: ["src/content/index.js"],
        },
        () => {
          if (chrome.runtime?.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve({ ok: true });
        }
      );
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : "Unable to inject content script" });
    }
  });
}

function setDetectedSiteLabels({ url, fieldStatusText }) {
  const domain = (() => {
    try {
      return url ? new URL(url).hostname : "-";
    } catch {
      return "-";
    }
  })();

  activeHostname = domain && domain !== "-" ? domain : null;

  if (detectedPageLabel) detectedPageLabel.textContent = domain;
  if (siteDomainLabel) siteDomainLabel.textContent = domain;
  if (siteFieldsStatusLabel) siteFieldsStatusLabel.textContent = fieldStatusText || "-";
}

function setSavedCount(count, subtitle) {
  if (savedCountLabel) {
    savedCountLabel.textContent = typeof count === "number" ? String(count) : "-";
  }

  if (savedCountSubtitle) {
    savedCountSubtitle.textContent = subtitle || "";
  }
}

function clearVaultList(message) {
  if (!vaultList) {
    return;
  }

  vaultList.innerHTML = "";
  const p = document.createElement("p");
  p.className = "vault-empty";
  p.textContent = message;
  vaultList.appendChild(p);
}

function formatTimestamp(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  return d.toLocaleString();
}

// ═══════════════════════════════════════════════════════════════════════════════
// VAULT ITEM RENDERING — now includes Copy username / Copy password buttons
// ═══════════════════════════════════════════════════════════════════════════════

function renderVaultItems(credentials, { onFill, onEdit, onDelete, onDefault } = {}) {
  if (!vaultList) {
    return;
  }

  vaultList.innerHTML = "";

  if (!Array.isArray(credentials) || credentials.length === 0) {
    clearVaultList("No saved credentials for this site yet.");
    return;
  }

  for (const cred of credentials) {
    const article = document.createElement("article");
    article.className = "vault-item";

    // ── Left column: identity info ─────────────────────────────────────────
    const left = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = String(cred?.usernameLabel || cred?.username || "(no username)");
    const meta = document.createElement("p");
    const defaultText = cred?.isDefault ? "Default. " : "";
    meta.textContent = `${defaultText}${cred?.domain || "(unknown)"}${cred?.createdAt ? `, saved ${formatTimestamp(cred.createdAt)}` : ""}`;
    left.appendChild(title);
    left.appendChild(meta);

    // ── Right column: action buttons ───────────────────────────────────────
    const actions = document.createElement("div");
    actions.className = "vault-item-actions";

    // Fill button
    const fillBtn = document.createElement("button");
    fillBtn.type = "button";
    fillBtn.textContent = "Fill";
    fillBtn.addEventListener("click", () => onFill?.(cred));
    actions.appendChild(fillBtn);

    // ── NEW: Copy username button ──────────────────────────────────────────
    const copyUserBtn = document.createElement("button");
    copyUserBtn.type = "button";
    copyUserBtn.textContent = "Copy user";
    copyUserBtn.title = "Copy username to clipboard";
    copyUserBtn.addEventListener("click", async () => {
      const username = cred?.username || cred?.usernameLabel || "";
      await copyToClipboard(username, copyUserBtn);
    });
    actions.appendChild(copyUserBtn);

    // ── NEW: Copy password button ─────────────────────────────────────────
    // We need the decrypted password — request it via GET_CREDENTIAL_FOR_EDIT
    // which the background already exposes. We fetch on-demand (click) to
    // avoid keeping plaintext in the DOM longer than necessary.
    const copyPassBtn = document.createElement("button");
    copyPassBtn.type = "button";
    copyPassBtn.textContent = "Copy pass";
    copyPassBtn.title = "Copy password to clipboard";
    copyPassBtn.addEventListener("click", async () => {
      copyPassBtn.textContent = "…";
      copyPassBtn.disabled = true;

      try {
        const hostnameToFetch = showAllCredentials ? null : activeHostname;
        const response = await sendMessage({
          type: "GET_CREDENTIAL_FOR_EDIT",
          hostname: hostnameToFetch,
          id: String(cred?.id || ""),
        });

        if (!response?.ok) {
          copyPassBtn.textContent = "Error";
          setTimeout(() => {
            copyPassBtn.textContent = "Copy pass";
            copyPassBtn.disabled = false;
          }, 1500);
          return;
        }

        await copyToClipboard(response.credential?.password ?? "", copyPassBtn);
      } catch {
        copyPassBtn.textContent = "Copy pass";
        copyPassBtn.disabled = false;
      }
    });
    actions.appendChild(copyPassBtn);

    // Edit button
    if (typeof onEdit === "function") {
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.textContent = "Edit";
      editBtn.addEventListener("click", () => onEdit?.(cred));
      actions.appendChild(editBtn);
    }

    // Default button
    if (typeof onDefault === "function" && !cred?.isDefault) {
      const defaultBtn = document.createElement("button");
      defaultBtn.type = "button";
      defaultBtn.textContent = "Default";
      defaultBtn.addEventListener("click", () => onDefault?.(cred));
      actions.appendChild(defaultBtn);
    }

    // Delete button
    if (typeof onDelete === "function") {
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      const isPendingDelete = pendingDeleteId === cred?.id && Date.now() < pendingDeleteUntil;
      deleteBtn.textContent = isPendingDelete ? "Confirm" : "Delete";
      deleteBtn.classList.toggle("danger-button", isPendingDelete);
      deleteBtn.addEventListener("click", () => onDelete?.(cred));
      actions.appendChild(deleteBtn);
    }

    article.appendChild(left);
    article.appendChild(actions);
    vaultList.appendChild(article);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REST OF EXISTING LOGIC — unchanged
// ═══════════════════════════════════════════════════════════════════════════════

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
  if (typeof hostname !== "string") {
    return null;
  }
  const parts = hostname.split(".").filter(Boolean);
  if (parts.length < 2) {
    return hostname;
  }
  return parts.slice(-2).join(".");
}

async function fetchCredentialsForDomain(token, hostname) {
  if (!hostname) {
    return [];
  }
  const response = await sendMessage({ type: "LIST_CREDENTIALS_FOR_DOMAIN", hostname });
  if (!response?.ok) {
    throw new Error(response?.error || "Unable to load credentials.");
  }
  return Array.isArray(response.credentials) ? response.credentials : [];
}

async function deleteCredential(token, credentialId) {
  if (!token || !credentialId) {
    return;
  }

  const response = await sendMessage({ type: "DELETE_CREDENTIAL", id: credentialId });
  if (!response?.ok) {
    throw new Error(response?.error || "Unable to delete.");
  }
}

async function handleVaultFill(cred) {
  const tab = await queryActiveTab();
  const tabId = typeof tab?.id === "number" ? tab.id : null;
  const url = typeof tab?.url === "string" ? tab.url : null;

  if (!tabId || !url) {
    setStatus("Autofill failed", "No active tab detected.", true);
    return;
  }

  const injectResp = await injectContentScript(tabId, url);
  if (!injectResp?.ok && injectResp?.error) {
    setStatus("Autofill failed", injectResp.error, true);
    return;
  }

  const resp = await sendMessage({
    type: "AUTOFILL_ACTIVE_TAB",
    tabId,
    url,
    credentialId: cred?.id,
  });

  if (resp?.ok) {
    setStatus("Autofill", "Credentials filled on the current page.");
    reportActivity();
  } else {
    setStatus("Autofill failed", resp?.error || "Unable to autofill.", true);
  }
}

async function handleVaultDelete(cred) {
  try {
    const token = currentVaultToken;
    const id = String(cred?.id || "");
    if (!token) {
      setStatus("Delete failed", "Missing session token.", true);
      return;
    }
    if (!id) {
      setStatus("Delete failed", "Missing credential id.", true);
      return;
    }

    const now = Date.now();
    if (pendingDeleteId !== id || now >= pendingDeleteUntil) {
      pendingDeleteId = id;
      pendingDeleteUntil = now + 10_000;
      setStatus("Confirm delete", "Click Confirm on the same credential to delete it.");
      renderVaultItems(filterCredentials(lastVaultCredentials, vaultSearchInput?.value), {
        onFill: handleVaultFill,
        onEdit: handleVaultEdit,
        onDelete: handleVaultDelete,
        onDefault: handleVaultDefault,
      });
      return;
    }

    await deleteCredential(token, id);
    pendingDeleteId = null;
    pendingDeleteUntil = 0;
    setStatus("Deleted", "Credential removed from the vault.");
    closeCredentialEditor();
    await refreshVaultView();
  } catch (error) {
    setStatus("Delete failed", error instanceof Error ? error.message : "Unable to delete.", true);
  }
}

async function handleVaultDefault(cred) {
  const id = String(cred?.id || "");
  const hostname = showAllCredentials ? cred.domain : activeHostname;

  if (!hostname || !id) {
    setStatus("Default failed", "Missing active domain or credential id.", true);
    return;
  }

  const response = await sendMessage({ type: "SET_DEFAULT_CREDENTIAL", hostname, id });
  if (response?.ok) {
    setStatus("Default updated", "This credential will be used first for the domain.");
    await refreshVaultView();
  } else {
    setStatus("Default failed", response?.error || "Unable to set default.", true);
  }
}

function setEditFeedback(message, isError = false) {
  if (!editFeedback) return;
  editFeedback.textContent = message || "";
  editFeedback.classList.toggle("is-error", isError);
}

function openCredentialEditor({ id, username, password }) {
  editingCredentialId = id;
  if (editUsernameInput) editUsernameInput.value = username || "";
  if (editPasswordInput) {
    editPasswordInput.type = "password";
    editPasswordInput.value = password || "";
  }
  if (editRevealButton) editRevealButton.textContent = "Show";
  // Reset generator panel state whenever the editor opens
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

  if (!id) {
    setStatus("Edit failed", "Missing active domain or credential id.", true);
    return;
  }

  const response = await sendMessage({ type: "GET_CREDENTIAL_FOR_EDIT", hostname: hostnameToFetch, id });
  if (!response?.ok) {
    setStatus("Edit failed", response?.error || "Unable to load credential.", true);
    return;
  }

  const current = response.credential || {};
  openCredentialEditor({
    id,
    username: current.username || "",
    password: current.password || "",
  });
}

async function refreshVaultView() {
  const session = await readSession();
  const token = session?.token;

  if (!token) {
    currentVaultToken = null;
    closeCredentialEditor();
    setSavedCount(null, "For this site");
    if (vaultPill) vaultPill.textContent = "";
    if (vaultList) clearVaultList("Please sign in to view credentials.");
    return;
  }

  currentVaultToken = token;

  try {
    let credentials = [];
    let subtitle = "";
    let pillText = "";

    if (showAllCredentials) {
      const response = await sendMessage({ type: "LIST_ALL_CREDENTIALS" });
      if (!response?.ok) {
        throw new Error(response?.error || "Unable to load all credentials.");
      }
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
      return;
    }

    const count = Array.isArray(credentials) ? credentials.length : 0;
    setSavedCount(count, subtitle);
    if (vaultPill) vaultPill.textContent = pillText;

    lastVaultCredentials = Array.isArray(credentials) ? credentials : [];
    const filtered = filterCredentials(lastVaultCredentials, vaultSearchInput?.value);

    renderVaultItems(filtered, {
      onFill: handleVaultFill,
      onEdit: handleVaultEdit,
      onDelete: handleVaultDelete,
      onDefault: handleVaultDefault,
    });
  } catch (error) {
    setSavedCount(null, "For this site");
    if (vaultPill) vaultPill.textContent = "Error";
    clearVaultList(error instanceof Error ? error.message : "Unable to load credentials.");
  }
}

vaultSearchInput?.addEventListener("input", () => {
  const filtered = filterCredentials(lastVaultCredentials, vaultSearchInput.value);
  renderVaultItems(filtered, {
    onFill: handleVaultFill,
    onEdit: handleVaultEdit,
    onDelete: handleVaultDelete,
    onDefault: handleVaultDefault,
  });
});

editCancelButton?.addEventListener("click", () => {
  closeCredentialEditor();
});

editRevealButton?.addEventListener("click", () => {
  if (!editPasswordInput || !editRevealButton) return;
  const showing = editPasswordInput.type === "text";
  editPasswordInput.type = showing ? "password" : "text";
  editRevealButton.textContent = showing ? "Show" : "Hide";
});

credentialEditForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!editingCredentialId) {
    setEditFeedback("No credential selected.", true);
    return;
  }

  const username = editUsernameInput?.value?.trim() || "";
  const password = editPasswordInput?.value || "";
  if (!password) {
    setEditFeedback("Password is required.", true);
    return;
  }

  setEditFeedback("Saving...");
  const update = await sendMessage({
    type: "UPDATE_CREDENTIAL",
    id: editingCredentialId,
    username,
    password,
  });

  if (update?.ok) {
    setStatus("Credential updated", "Saved changes to the vault.");
    closeCredentialEditor();
    await refreshVaultView();
  } else {
    setEditFeedback(update?.error || "Unable to update credential.", true);
  }
});

async function refreshActiveTabAutofillState() {
  if (!hasChromeRuntime()) {
    setDetectedSiteLabels({ url: null, fieldStatusText: "-" });
    return;
  }

  const tab = await queryActiveTab();
  const url = typeof tab?.url === "string" ? tab.url : null;
  const tabId = typeof tab?.id === "number" ? tab.id : null;

  const domain = (() => {
    try {
      return url ? new URL(url).hostname : "-";
    } catch {
      return "-";
    }
  })();
  activeHostname = domain && domain !== "-" ? domain : null;

  setDetectedSiteLabels({ url, fieldStatusText: "Checking page fields…" });

  if (!tabId) {
    setDetectedSiteLabels({ url, fieldStatusText: "No active tab" });
    return;
  }

  let detectResp = await sendMessageToTab(tabId, { type: "DETECT_LOGIN_FIELDS" });
  if (detectResp?.ok === false && typeof detectResp?.error === "string") {
    const looksLikeMissingReceiver = /receiving end does not exist|could not establish connection/i.test(
      detectResp.error
    );

    if (looksLikeMissingReceiver) {
      const injectResp = await injectContentScript(tabId, url);
      if (injectResp?.ok) {
        detectResp = await sendMessageToTab(tabId, { type: "DETECT_LOGIN_FIELDS" });
      }
    }
  }

  if (detectResp?.ok === false) {
    setDetectedSiteLabels({ url, fieldStatusText: detectResp?.error || "Unable to detect fields" });
    await refreshVaultView();
    return;
  }

  if (detectResp?.ok && detectResp?.hasPasswordField) {
    if (detectResp?.hasUsernameField) {
      setDetectedSiteLabels({ url, fieldStatusText: "Username and password fields found" });
    } else {
      setDetectedSiteLabels({ url, fieldStatusText: "Password field found" });
    }
  } else {
    setDetectedSiteLabels({ url, fieldStatusText: "No login fields detected" });
  }

  await refreshVaultView();
}

async function readSession() {
  if (isChromeSessionStorageAvailable()) {
    const result = await chrome.storage.session.get(SESSION_KEY);
    return result?.[SESSION_KEY] ?? null;
  }

  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

async function writeSession(session) {
  if (isChromeSessionStorageAvailable()) {
    await chrome.storage.session.set({ [SESSION_KEY]: session });
    return;
  }

  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

async function clearSession() {
  if (isChromeSessionStorageAvailable()) {
    await chrome.storage.session.remove(SESSION_KEY);
    return;
  }

  localStorage.removeItem(SESSION_KEY);
}

function reportActivity() {
  if (isChromeSessionStorageAvailable()) {
    void sendMessage({ type: "ACTIVITY" });
  }
}

async function clearVaultKey() {
  if (!hasChromeRuntime()) {
    return;
  }

  await sendMessage({ type: "CLEAR_KEY" });
}

async function signOut({ title, message, isError = false } = {}) {
  closeCredentialEditor();
  await clearVaultKey();
  await clearSession();
  signInForm?.reset();
  registerForm?.reset();
  signInForm?.querySelector(".auth-feedback")?.classList.remove("is-error");
  registerForm?.querySelector(".auth-feedback")?.classList.remove("is-error");
  const signInFeedback = signInForm?.querySelector(".auth-feedback");
  if (signInFeedback) signInFeedback.textContent = "";
  const registerFeedback = registerForm?.querySelector(".auth-feedback");
  if (registerFeedback) registerFeedback.textContent = "";
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
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }

  return data;
}

async function refreshSessionState() {
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

  let isUnlocked = !hasChromeRuntime();

  if (hasChromeRuntime()) {
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
    if (vaultList) clearVaultList("Vault locked. Unlock to view passwords.");
    closeCredentialEditor();
    resetVaultScope();
  }

  try {
    const data = await apiRequest("/auth/me", {
      headers: {
        Authorization: `Bearer ${session.token}`,
      },
    });

    if (isUnlocked) {
      setStatus("Unlocked", `Vault ready for ${data.user.email}. Auto-lock after inactivity.`);
    } else {
      setStatus("Vault locked", `Signed in as ${data.user.email}. Unlock to view passwords.`);
    }
  } catch {
    await signOut({ title: "Session expired", message: "Please sign in again.", isError: true });
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

  if (!signInForm) {
    return;
  }

  const feedback = attachAuthFeedback(signInForm);
  const formData = new FormData(signInForm);
  const email = String(formData.get("email") || "").trim();
  const password = String(formData.get("password") || "");

  feedback.textContent = "";
  feedback.classList.remove("is-error");

  try {
    const data = await apiRequest("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });

    if (hasChromeRuntime()) {
      const keyCheckResp = await sendMessage({
        type: "CREATE_KEY_CHECK",
        masterPassword: password,
        salt: data.salt,
      });

      if (!keyCheckResp?.ok) {
        throw new Error(keyCheckResp?.error || "Unable to initialize vault session");
      }

      await writeSession({
        ...data,
        keyCheckCiphertext: keyCheckResp.keyCheckCiphertext,
        keyCheckIv: keyCheckResp.keyCheckIv,
      });

      setViewState({ isAuthed: true, isUnlocked: false });
      setStatus("Vault locked", `Signed in as ${data.user.email}. Unlock to view passwords.`);
    } else {
      await writeSession(data);
      setViewState({ isAuthed: true, isUnlocked: true });
      setStatus("Signed in", `Welcome back, ${data.user.email}.`);
    }

    reportActivity();
    feedback.textContent = "Signed in. Vault is locked.";
  } catch (error) {
    feedback.textContent = error instanceof Error ? error.message : "Unable to log in.";
    feedback.classList.add("is-error");
    setStatus("Login failed", "Check your credentials and try again.", true);
  }
}

async function handleRegister(event) {
  event.preventDefault();

  if (!registerForm) {
    return;
  }

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
      body: JSON.stringify({ email, password }),
    });

    if (data.recoveryKey) {
      showRecoveryKeyModal(data.recoveryKey, () => {
      console.log("Recovery key saved by user");
    });
  }

    if (hasChromeRuntime()) {
      const keyCheckResp = await sendMessage({
        type: "CREATE_KEY_CHECK",
        masterPassword: password,
        salt: data.salt,
      });

      if (!keyCheckResp?.ok) {
        throw new Error(keyCheckResp?.error || "Unable to initialize vault session");
      }

      await writeSession({
        ...data,
        keyCheckCiphertext: keyCheckResp.keyCheckCiphertext,
        keyCheckIv: keyCheckResp.keyCheckIv,
      });

      setViewState({ isAuthed: true, isUnlocked: false });
      setStatus("Vault locked", `Signed in as ${data.user.email}. Unlock to view passwords.`);
    } else {
      await writeSession(data);
      setViewState({ isAuthed: true, isUnlocked: true });
      setStatus("Signed in", `Welcome, ${data.user.email}.`);
    }

    reportActivity();
    feedback.textContent = "Account created. Vault is locked.";
  } catch (error) {
    feedback.textContent = error instanceof Error ? error.message : "Unable to create account.";
    feedback.classList.add("is-error");
    setStatus("Registration failed", "Try a different email or check the backend.", true);
  }
}

tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (button.dataset.tab) {
      setActiveTab(button.dataset.tab);
    }
  });
});

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

signOutButton?.addEventListener("click", async () => {
  await signOut({ title: "Signed out", message: "Session cleared. Sign in to continue." });
});

unlockForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const session = await readSession();
  if (!session?.salt) {
    setStatus("Unlock failed", "Missing salt in session. Please sign in again.", true);
    return;
  }

  if (!session?.keyCheckCiphertext || !session?.keyCheckIv) {
    setStatus(
      "Unlock failed",
      "Missing vault verifier. Please sign out and sign in again.",
      true
    );
    return;
  }

  const formData = new FormData(unlockForm);
  const masterPassword = String(formData.get("unlock-password") || "");
  if (!masterPassword) {
    setStatus("Unlock failed", "Enter your master password.", true);
    return;
  }

  const unlockResp = await sendMessage({
    type: "UNLOCK",
    masterPassword,
    salt: session.salt,
    keyCheckCiphertext: session.keyCheckCiphertext,
    keyCheckIv: session.keyCheckIv,
  });

  if (unlockResp?.ok) {
    setViewState({ isAuthed: true, isUnlocked: true });
    setStatus("Unlocked", "Vault unlocked. Auto-lock after inactivity.");
    unlockForm.reset();
    resetVaultScope();
    reportActivity();
    void refreshActiveTabAutofillState();
  } else {
    setStatus("Unlock failed", unlockResp?.error || "Unable to unlock vault.", true);
  }
});

autofillButton?.addEventListener("click", async () => {
  if (!hasChromeRuntime()) {
    return;
  }

  const tab = await queryActiveTab();
  const tabId = typeof tab?.id === "number" ? tab.id : null;
  const url = typeof tab?.url === "string" ? tab.url : null;

  if (!tabId || !url) {
    setStatus("Autofill failed", "No active tab detected.", true);
    return;
  }

  const injectResp = await injectContentScript(tabId, url);
  if (!injectResp?.ok && injectResp?.error) {
    setStatus("Autofill failed", injectResp.error, true);
    return;
  }

  const resp = await sendMessage({ type: "AUTOFILL_ACTIVE_TAB", tabId, url });
  if (resp?.ok) {
    setStatus("Autofill", "Credentials filled on the current page.");
    reportActivity();
  } else {
    setStatus("Autofill failed", resp?.error || "Unable to autofill.", true);
  }
});

refreshTabButton?.addEventListener("click", async () => {
  await refreshActiveTabAutofillState();
});

async function setVaultScope(scope) {
  showAllCredentials = (scope === "all");

  vaultScopeButtons.forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.vaultScope === scope);
  });

  if (vaultSearchInput) {
    vaultSearchInput.value = "";
    vaultSearchInput.placeholder = showAllCredentials
      ? "Search all saved credentials"
      : "Search this site's saved credentials";
  }

  await refreshVaultView();
}

function resetVaultScope() {
  return setVaultScope("site");
}

vaultScopeButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.vaultScope) {
      void setVaultScope(btn.dataset.vaultScope);
    }
  });
});

// ============================================================
// NEW: Forgot password & Change master password handlers
// ============================================================

// Show Forgot Password modal
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

  // Reset
  emailInput.value = "";
  recoveryKeyInput.value = "";
  newPwdInput.value = "";
  confirmInput.value = "";
  feedback.textContent = "";

  const closeModal = () => {
    modal.hidden = true;
    submitBtn.onclick = null;
    cancelBtn.onclick = null;
    closeBtn.onclick = null;
  };

  const handleSubmit = async () => {
    const email = emailInput.value.trim();
    const recoveryKey = recoveryKeyInput.value.trim();
    const newPassword = newPwdInput.value;
    const confirm = confirmInput.value;

    if (!email) {
      feedback.textContent = "Email is required.";
      return;
    }
    if (!recoveryKey) {
      feedback.textContent = "Recovery key is required.";
      return;
    }
    if (newPassword.length < 8) {
      feedback.textContent = "New password must be at least 8 characters.";
      return;
    }
    if (newPassword !== confirm) {
      feedback.textContent = "Passwords do not match.";
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Resetting...";

    const response = await sendMessage({
      type: "RESET_WITH_RECOVERY",
      email,
      recoveryKey,
      newPassword,
    });

    submitBtn.disabled = false;
    submitBtn.textContent = "Reset Password";

    if (response?.ok && response.recoveryKey) {
      closeModal();
      showRecoveryKeyModal(response.recoveryKey, () => {
        refreshSessionState();
      });
    } else {
      feedback.textContent = response?.error || "Reset failed. Invalid recovery key or email.";
    }
  };

  submitBtn.onclick = handleSubmit;
  cancelBtn.onclick = closeModal;
  closeBtn.onclick = closeModal;

  modal.hidden = false;
  emailInput.focus();
}

// Show Change Password modal
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

  // Reset form
  oldPwdInput.value = "";
  newPwdInput.value = "";
  confirmInput.value = "";
  feedback.textContent = "";

  const closeModal = () => {
    modal.hidden = true;
    // Remove listeners to avoid duplicates
    submitBtn.onclick = null;
    cancelBtn.onclick = null;
    closeBtn.onclick = null;
  };

  const handleSubmit = async () => {
    const oldPwd = oldPwdInput.value;
    const newPwd = newPwdInput.value;
    const confirm = confirmInput.value;

    if (!oldPwd) {
      feedback.textContent = "Current password is required.";
      return;
    }
    if (newPwd.length < 8) {
      feedback.textContent = "New password must be at least 8 characters.";
      return;
    }
    if (newPwd !== confirm) {
      feedback.textContent = "New passwords do not match.";
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Changing...";

    const response = await sendMessage({
      type: "CHANGE_MASTER_PASSWORD",
      oldPassword: oldPwd,
      newPassword: newPwd,
    });

    submitBtn.disabled = false;
    submitBtn.textContent = "Change Password";

    if (response?.ok && response.recoveryKey) {
      closeModal();
      showRecoveryKeyModal(response.recoveryKey, () => {
        refreshSessionState();
      });
    } else {
      feedback.textContent = response?.error || "Change failed. Check your current password.";
    }
  };

  submitBtn.onclick = handleSubmit;
  cancelBtn.onclick = closeModal;
  closeBtn.onclick = closeModal;

  modal.hidden = false;
  oldPwdInput.focus();
}

// Recovery key modal handling
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

  // Copy handler
  const copyHandler = () => {
    navigator.clipboard.writeText(recoveryKey);
    copyBtn.textContent = "Copied!";
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
  };
  copyBtn.onclick = copyHandler;

  // Confirm / close handlers
  const closeModal = () => {
    modal.hidden = true;
    if (pendingCallback) pendingCallback();
    pendingRecoveryKey = null;
    pendingCallback = null;
    // Clean up listeners
    confirmBtn.onclick = null;
    closeBtn.onclick = null;
    copyBtn.onclick = null;
  };
  confirmBtn.onclick = closeModal;
  closeBtn.onclick = closeModal;

  modal.hidden = false;
}

window.addEventListener("mousemove", reportActivity);
window.addEventListener("keydown", reportActivity);
window.addEventListener("click", reportActivity);
// Attach change password and forgot password handlers
document.getElementById("change-password-button")?.addEventListener("click", showChangePasswordModal);
document.getElementById("forgot-password-link")?.addEventListener("click", (e) => {
  e.preventDefault();
  handleForgotPassword();
});
setActiveTab("sign-in");
document.getElementById("recovery-modal")?.setAttribute("hidden", "true");
document.getElementById("change-password-modal")?.setAttribute("hidden", "true");
document.getElementById("forgot-password-modal")?.setAttribute("hidden", "true");
setViewState({ isAuthed: false, isUnlocked: false });
void refreshSessionState();