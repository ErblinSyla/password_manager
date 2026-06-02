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

let activeHostname = null;

let lastVaultCredentials = [];
let showAllCredentials = false; // New state variable
let currentVaultToken = null;
let editingCredentialId = null;
let pendingDeleteId = null;
let pendingDeleteUntil = 0;

const API_BASE = "http://localhost:3001/api";
const SESSION_KEY = "password-manager-session";

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

    const left = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = String(cred?.usernameLabel || cred?.username || "(no username)");
    const meta = document.createElement("p");
    const defaultText = cred?.isDefault ? "Default. " : "";
    meta.textContent = `${defaultText}${cred?.domain || "(unknown)"}${cred?.createdAt ? `, saved ${formatTimestamp(cred.createdAt)}` : ""}`;
    left.appendChild(title);
    left.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "vault-item-actions";

    const fillBtn = document.createElement("button");
    fillBtn.type = "button";
    fillBtn.textContent = "Fill";
    fillBtn.addEventListener("click", () => {
      onFill?.(cred);
    });

    actions.appendChild(fillBtn);

    if (typeof onEdit === "function") {
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.textContent = "Edit";
      editBtn.addEventListener("click", () => {
        onEdit?.(cred);
      });
      actions.appendChild(editBtn);
    }

    if (typeof onDefault === "function" && !cred?.isDefault) {
      const defaultBtn = document.createElement("button");
      defaultBtn.type = "button";
      defaultBtn.textContent = "Default";
      defaultBtn.addEventListener("click", () => {
        onDefault?.(cred);
      });
      actions.appendChild(defaultBtn);
    }

    if (typeof onDelete === "function") {
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      const isPendingDelete = pendingDeleteId === cred?.id && Date.now() < pendingDeleteUntil;
      deleteBtn.textContent = isPendingDelete ? "Confirm" : "Delete";
      deleteBtn.classList.toggle("danger-button", isPendingDelete);
      deleteBtn.addEventListener("click", () => {
        onDelete?.(cred);
      });
      actions.appendChild(deleteBtn);
    }
    article.appendChild(left);
    article.appendChild(actions);
    vaultList.appendChild(article);
  }
}

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
  setEditFeedback("");
  if (credentialEditor) credentialEditor.hidden = false;
  editUsernameInput?.focus();
}

function closeCredentialEditor() {
  editingCredentialId = null;
  credentialEditForm?.reset();
  if (editPasswordInput) editPasswordInput.type = "password";
  if (editRevealButton) editRevealButton.textContent = "Show";
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

async function refreshVaultView() { // Renamed from refreshVaultForActiveDomain
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
  } catch (error) { // Catch errors from both fetchCredentialsForDomain and LIST_ALL_CREDENTIALS
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
    }); // This will now filter from lastVaultCredentials which can contain all credentials
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
  activeHostname = domain && domain !== "-" ? domain : null; // Update activeHostname here

  setDetectedSiteLabels({ url, fieldStatusText: "Checking page fields…" });

  if (!tabId) {
    setDetectedSiteLabels({ url, fieldStatusText: "No active tab" }); // activeHostname is already null
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

  // Ensure the vault list updates whenever tab state is refreshed
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

  // In Vite preview there is no chrome.runtime, so treat it as "unlocked" for UI.
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
  // This will update activeHostname and then call refreshVaultView
  await refreshActiveTabAutofillState();
});

async function setVaultScope(scope) {
  showAllCredentials = (scope === "all");
  
  vaultScopeButtons.forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.vaultScope === scope);
  });

  if (vaultSearchInput) {
    // Clear search when switching tabs for a fresh view
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

window.addEventListener("mousemove", reportActivity);
window.addEventListener("keydown", reportActivity);
window.addEventListener("click", reportActivity);
setActiveTab("sign-in");
setViewState({ isAuthed: false, isUnlocked: false });
void refreshSessionState();
