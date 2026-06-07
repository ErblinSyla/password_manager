// save-prompt.js
// Cross-browser shim: Firefox uses `browser`, Chrome/Edge/Safari use `chrome`
const _rt = (() => {
  if (typeof browser !== "undefined" && browser.runtime) return browser.runtime;
  return {
    sendMessage: (msg) =>
      new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(msg, (response) => resolve(response || null));
        } catch { resolve(null); }
      }),
  };
})();

const form = document.getElementById("save-form");
const title = document.getElementById("save-title");
const domainLabel = document.getElementById("save-domain");
const usernameInput = document.getElementById("save-username");
const passwordInput = document.getElementById("save-password");
const targetSelect = document.getElementById("save-target");
const defaultCheckbox = document.getElementById("save-default");
const reason = document.getElementById("save-reason");
const feedback = document.getElementById("save-feedback");
const cancelButton = document.getElementById("save-cancel");

let pending = null;

function sendMessage(message) {
  return _rt.sendMessage(message).catch(() => null);
}

function setFeedback(message, isError = false) {
  if (!feedback) return;
  feedback.textContent = message || "";
  feedback.classList.toggle("is-error", isError);
}

function selectAction(action) {
  const input = form?.querySelector(`input[name="action"][value="${action}"]`);
  if (input) input.checked = true;
  if (targetSelect) targetSelect.disabled = action !== "update";
}

function renderPending(value) {
  pending = value;
  if (!pending) {
    setFeedback("There is no password waiting to be saved.", true);
    form?.querySelectorAll("input, select, button").forEach((el) => {
      if (el !== cancelButton) el.disabled = true;
    });
    return;
  }

  if (title) title.textContent = pending.mode === "changePassword" ? "Confirm password update" : "Review before saving";
  if (domainLabel) domainLabel.textContent = pending.hostname || "-";
  if (usernameInput) usernameInput.value = pending.username || "";
  if (passwordInput) passwordInput.value = pending.password || "";
  if (reason) reason.textContent = pending.reason || "";
  if (defaultCheckbox) defaultCheckbox.checked = true;

  const existing = Array.isArray(pending.existing) ? pending.existing : [];
  if (targetSelect) {
    targetSelect.innerHTML = "";
    for (const item of existing) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = `${item.usernameLabel || "(no username)"} on ${item.domain || pending.hostname}`;
      if (item.id === pending.suggestedTargetId) option.selected = true;
      targetSelect.appendChild(option);
    }
  }

  const canUpdate = existing.length > 0;
  const updateRadio = form?.querySelector('input[name="action"][value="update"]');
  if (updateRadio) updateRadio.disabled = !canUpdate;
  if (targetSelect) targetSelect.hidden = !canUpdate;
  selectAction(canUpdate && pending.suggestedAction === "update" ? "update" : "create");
}

async function init() {
  const response = await sendMessage({ type: "GET_PENDING_SAVE" });
  if (!response?.ok) {
    setFeedback(response?.error || "Unable to load save prompt.", true);
    return;
  }
  renderPending(response.pending);
}

form?.addEventListener("change", (event) => {
  if (event.target?.name === "action") selectAction(event.target.value);
});

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!pending) return;

  const formData = new FormData(form);
  const action = String(formData.get("action") || "");
  const username = String(formData.get("username") || "").trim();
  const password = String(formData.get("password") || "");
  const targetId = action === "update" ? targetSelect?.value || pending.suggestedTargetId || "" : "";

  setFeedback("");
  const response = await sendMessage({
    type: "RESOLVE_PENDING_SAVE",
    action, targetId, username, password,
    makeDefault: !!defaultCheckbox?.checked,
  });

  if (response?.ok) {
    setFeedback("Saved.");
    window.setTimeout(() => window.close(), 350);
  } else {
    setFeedback(response?.error || "Unable to save credential.", true);
  }
});

cancelButton?.addEventListener("click", async () => {
  await sendMessage({ type: "DISCARD_PENDING_SAVE" });
  window.close();
});

void init();