const tabButtons = Array.from(document.querySelectorAll("[data-tab]"));
const tabPanels = Array.from(document.querySelectorAll("[data-panel]"));
const signInForm = document.querySelector('[data-panel="sign-in"]');
const registerForm = document.querySelector('[data-panel="create-account"]');
const connectionTitle = document.getElementById("connection-title");
const connectionMessage = document.getElementById("connection-message");
const lockButton = document.getElementById("lock-button");
const gatedSections = Array.from(document.querySelectorAll("[data-when]"));

const API_BASE = "http://localhost:3001/api";
const SESSION_KEY = "password-manager-session";
const AUTO_LOCK_MS = 5 * 60 * 1000;

let autoLockTimer = null;

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

function setAuthVisibility(isAuthed) {
  gatedSections.forEach((section) => {
    const when = section.getAttribute("data-when");
    if (when === "authed") {
      section.hidden = !isAuthed;
    }
    if (when === "unauthed") {
      section.hidden = isAuthed;
    }
  });

  if (lockButton) {
    lockButton.hidden = !isAuthed;
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

function resetAutoLockTimer() {
  if (autoLockTimer) {
    clearTimeout(autoLockTimer);
  }

  if (isChromeSessionStorageAvailable()) {
    try {
      chrome?.runtime?.sendMessage?.({ type: "ACTIVITY" });
    } catch {
      // ignore
    }
  }

  autoLockTimer = setTimeout(async () => {
    await clearSession();
    try {
      chrome?.runtime?.sendMessage?.({ type: "CLEAR_KEY" });
    } catch {
      // ignore
    }
    setStatus("Locked", "Session cleared due to inactivity.", true);
    setAuthVisibility(false);
  }, AUTO_LOCK_MS);
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
    setAuthVisibility(false);
    return;
  }

  setAuthVisibility(true);
  resetAutoLockTimer();

  try {
    const data = await apiRequest("/auth/me", {
      headers: {
        Authorization: `Bearer ${session.token}`,
      },
    });

    setStatus(
      "Signed in",
      `Welcome back, ${data.user.email}. Your session is active.`
    );
  } catch {
    await clearSession();
    setStatus("Session expired", "Please sign in again.", true);
    setAuthVisibility(false);
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

    await writeSession(data);
    try {
      chrome?.runtime?.sendMessage?.({ type: "SESSION_STARTED" });
    } catch {
      // ignore
    }
    setStatus("Signed in", `Welcome back, ${data.user.email}. Your session is active.`);
    feedback.textContent = "Logged in successfully.";
    setAuthVisibility(true);
    resetAutoLockTimer();
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

    await writeSession(data);
    try {
      chrome?.runtime?.sendMessage?.({ type: "SESSION_STARTED" });
    } catch {
      // ignore
    }
    setStatus("Signed in", `Welcome, ${data.user.email}. Your account is ready.`);
    feedback.textContent = "Account created successfully.";
    setAuthVisibility(true);
    resetAutoLockTimer();
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
  await clearSession();
  try {
    chrome?.runtime?.sendMessage?.({ type: "CLEAR_KEY" });
  } catch {
    // ignore
  }
  setStatus("Locked", "Session cleared.");
  setAuthVisibility(false);
});

window.addEventListener("mousemove", resetAutoLockTimer);
window.addEventListener("keydown", resetAutoLockTimer);
window.addEventListener("click", resetAutoLockTimer);

setActiveTab("sign-in");
setAuthVisibility(false);
void refreshSessionState();