const tabButtons = Array.from(document.querySelectorAll("[data-tab]"));
const tabPanels = Array.from(document.querySelectorAll("[data-panel]"));
const signInForm = document.querySelector('[data-panel="sign-in"]');
const registerForm = document.querySelector('[data-panel="create-account"]');
const connectionTitle = document.getElementById("connection-title");
const connectionMessage = document.getElementById("connection-message");
const lockButton = document.getElementById("lock-button");
const gatedSections = Array.from(document.querySelectorAll("[data-when]"));
const unlockForm = document.getElementById("unlock-form");

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
    setStatus("Extension ready", "Connects to the local backend on localhost:3001.");
    setViewState({ isAuthed: false, isUnlocked: false });
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
    await clearSession();
    setStatus("Session expired", "Please sign in again.", true);
    setViewState({ isAuthed: false, isUnlocked: false });
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
  await sendMessage({ type: "CLEAR_KEY" });
  setStatus("Vault locked", "Vault locked. Unlock to view passwords.");
  setViewState({ isAuthed: true, isUnlocked: false });
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
    reportActivity();
  } else {
    setStatus("Unlock failed", unlockResp?.error || "Unable to unlock vault.", true);
  }
});

window.addEventListener("mousemove", reportActivity);
window.addEventListener("keydown", reportActivity);
window.addEventListener("click", reportActivity);

setActiveTab("sign-in");
setViewState({ isAuthed: false, isUnlocked: false });
void refreshSessionState();