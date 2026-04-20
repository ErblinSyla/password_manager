const tabButtons = Array.from(document.querySelectorAll("[data-tab]"));
const tabPanels = Array.from(document.querySelectorAll("[data-panel]"));
const signInForm = document.querySelector('[data-panel="sign-in"]');
const registerForm = document.querySelector('[data-panel="create-account"]');
const connectionTitle = document.getElementById("connection-title");
const connectionMessage = document.getElementById("connection-message");

const API_BASE = "http://localhost:3001/api";
const SESSION_KEY = "password-manager-session";

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

function readSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

function writeSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
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
  const session = readSession();

  if (!session?.token) {
    setStatus("Extension ready", "Connects to the local backend on localhost:3001.");
    return;
  }

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
    clearSession();
    setStatus("Session expired", "Please sign in again.", true);
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

    writeSession(data);
    setStatus("Signed in", `Welcome back, ${data.user.email}. Your session is active.`);
    feedback.textContent = "Logged in successfully.";
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

    writeSession(data);
    setStatus("Signed in", `Welcome, ${data.user.email}. Your account is ready.`);
    feedback.textContent = "Account created successfully.";
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

setActiveTab("sign-in");
refreshSessionState();