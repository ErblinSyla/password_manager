console.debug("Password Manager content script loaded");

function isVisibleInput(el) {
	if (!el) return false;
	if (el.disabled) return false;
	if (el.type === "hidden") return false;
	const style = window.getComputedStyle(el);
	if (style.visibility === "hidden" || style.display === "none") return false;
	const rect = el.getBoundingClientRect();
	return rect.width > 0 && rect.height > 0;
}

function findPasswordField(root = document) {
	const candidates = Array.from(root.querySelectorAll('input[type="password"]'));
	return candidates.find(isVisibleInput) || null;
}

function findUsernameField(passwordEl) {
	const scope = passwordEl?.form || passwordEl?.closest("form") || document;
	const selector = [
		'input[autocomplete="username"]',
		'input[type="email"]',
		'input[name*="email" i]',
		'input[id*="email" i]',
		'input[name*="user" i]',
		'input[id*="user" i]',
		'input[name*="login" i]',
		'input[id*="login" i]',
		'input[type="text"]',
	].join(",");

	const candidates = Array.from(scope.querySelectorAll(selector)).filter(isVisibleInput);
	if (!passwordEl) {
		return candidates[0] || null;
	}

	const passwordRect = passwordEl.getBoundingClientRect();
	const beforePassword = candidates.filter((candidate) => {
		const rect = candidate.getBoundingClientRect();
		return rect.top <= passwordRect.top + 6;
	});

	return (beforePassword[beforePassword.length - 1] || candidates[0] || null);
}

function setInputValue(input, value) {
	try {
		input.focus();
		input.value = value;
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));
	} catch {
		// ignore
	}
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (!message || typeof message.type !== "string") {
		return;
	}

	if (message.type === "DETECT_LOGIN_FIELDS") {
		const passwordField = findPasswordField();
		const usernameField = passwordField ? findUsernameField(passwordField) : null;

		sendResponse?.({
			ok: true,
			hasPasswordField: !!passwordField,
			hasUsernameField: !!usernameField,
		});
		return true;
	}

	if (message.type === "FILL_CREDENTIALS") {
		const username = typeof message.username === "string" ? message.username : "";
		const password = typeof message.password === "string" ? message.password : "";

		if (!password) {
			sendResponse?.({ ok: false, error: "Missing password" });
			return true;
		}

		const passwordField = findPasswordField();
		if (!passwordField) {
			sendResponse?.({ ok: false, error: "No password field found" });
			return true;
		}

		const usernameField = findUsernameField(passwordField);
		if (usernameField && username) {
			setInputValue(usernameField, username);
		}

		setInputValue(passwordField, password);
		sendResponse?.({ ok: true });
		return true;
	}
});