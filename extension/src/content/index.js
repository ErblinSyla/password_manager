(() => {
	if (globalThis.__pmContentScriptLoaded) {
		console.debug("Password Manager content script already loaded");
		return;
	}

	globalThis.__pmContentScriptLoaded = true;
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

function safeLower(value) {
	return typeof value === "string" ? value.toLowerCase() : "";
}

function getInputHint(input) {
	const name = safeLower(input?.getAttribute?.("name"));
	const id = safeLower(input?.getAttribute?.("id"));
	const autocomplete = safeLower(input?.getAttribute?.("autocomplete"));
	return `${name} ${id} ${autocomplete}`.trim();
}

function getFormText(form) {
	try {
		return safeLower(`${form?.textContent || ""} ${form?.getAttribute?.("aria-label") || ""}`);
	} catch {
		return "";
	}
}

function getSubmitText(form) {
	try {
		const submitters = queryAllDeepWithin(form, 'button, input[type="submit"], input[type="button"]');
		return safeLower(
			submitters
				.map((el) => `${el?.textContent || ""} ${el?.getAttribute?.("value") || ""} ${el?.getAttribute?.("aria-label") || ""}`)
				.join(" ")
		);
	} catch {
		return "";
	}
}

function hasLoginIntent(form) {
	return /log\s*in|login|sign\s*in|continue/.test(getSubmitText(form));
}

function hasSignupIntent(form) {
	const submitText = getSubmitText(form);
	if (/sign\s*up|signup|register|create\s+account|new\s+account|join\s+now/.test(submitText) && !hasLoginIntent(form)) {
		return true;
	}
	return /confirm\s+password|repeat\s+password/.test(getFormText(form)) && !hasLoginIntent(form);
}

function isIgnoredField(input) {
	const hint = getInputHint(input);
	return /otp|one.?time|2fa|mfa|verification|security.?code|card|cc-|credit|cvc|cvv|expiry|address|street|city|state|zip|postal/.test(hint);
}

function isExcludedCredentialForm(form) {
	if (hasSignupIntent(form)) {
		return true;
	}

	const fields = queryAllDeepWithin(form, "input").filter(isVisibleInput);
	return fields.some(isIgnoredField);
}

function looksLikeCurrentPasswordField(input) {
	const autocomplete = safeLower(input?.getAttribute?.("autocomplete"));
	if (autocomplete === "current-password") return true;
	const hint = getInputHint(input);
	return /current|old/.test(hint);
}

function looksLikeNewPasswordField(input) {
	const autocomplete = safeLower(input?.getAttribute?.("autocomplete"));
	if (autocomplete === "new-password") return true;
	const hint = getInputHint(input);
	return /new|confirm|repeat|again|verify/.test(hint);
}

function collectSearchContexts() {
	const contexts = [];
	const seen = new Set();
	const scanned = new Set();

	function addContext(ctx) {
		if (!ctx || seen.has(ctx)) return;
		seen.add(ctx);
		contexts.push(ctx);
	}

	function scanNodeForContexts(root) {
		if (!root || scanned.has(root)) {
			return;
		}
		scanned.add(root);
		addContext(root);

		const doc = root?.ownerDocument || (root?.nodeType === 9 ? root : null);
		if (!doc) return;

		let walkerRoot = root;
		if (root.nodeType === 9) {
			walkerRoot = root.documentElement;
		}
		if (!walkerRoot) return;

		const walker = doc.createTreeWalker(walkerRoot, NodeFilter.SHOW_ELEMENT);
		let node = walker.currentNode;
		while (node) {
			const el = node;
			if (el && el.shadowRoot) {
				addContext(el.shadowRoot);
				scanNodeForContexts(el.shadowRoot);
			}

			if (el && el.tagName === "IFRAME") {
				try {
					const frameDoc = el.contentDocument;
					if (frameDoc) {
						addContext(frameDoc);
						scanNodeForContexts(frameDoc);
					}
				} catch {
					// Cross-origin iframe; cannot access.
				}
			}
			node = walker.nextNode();
		}
	}

	scanNodeForContexts(document);
	return contexts;
}

function queryAllDeepWithin(rootElement, selector) {
	if (!rootElement || typeof rootElement.querySelectorAll !== "function") {
		return [];
	}

	const out = [];
	const seen = new Set();

	function add(node) {
		if (!node || seen.has(node)) return;
		seen.add(node);
		out.push(node);
	}

	function scan(node) {
		try {
			for (const el of Array.from(node.querySelectorAll(selector))) {
				add(el);
			}
		} catch {
			// ignore
		}

		let walker;
		try {
			walker = (node.ownerDocument || document).createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
		} catch {
			return;
		}

		let current = walker.currentNode;
		while (current) {
			const el = current;
			if (el && el.shadowRoot) {
				scan(el.shadowRoot);
			}
			current = walker.nextNode();
		}
	}

	scan(rootElement);
	return out;
}

function findPasswordField(root = document) {
	try {
		const candidates = Array.from(root.querySelectorAll('input[type="password"]'));
		return candidates.find(isVisibleInput) || null;
	} catch {
		return null;
	}
}

function findPasswordFieldDeep() {
	const contexts = collectSearchContexts();
	for (const ctx of contexts) {
		const found = findPasswordField(ctx);
		if (found) return found;
	}
	return null;
}

function findPasswordFieldsInFormDeep(form) {
	const candidates = queryAllDeepWithin(form, 'input[type="password"]');
	return candidates.filter((input) => isVisibleInput(input) && !isIgnoredField(input));
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

	const candidates = queryAllDeepWithin(scope, selector).filter(isVisibleInput);
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

function isLikelyLoginForm(form, passwordField, usernameField) {
	if (!form || !passwordField) return false;

	const pwAutocomplete = safeLower(passwordField.getAttribute("autocomplete"));
	if (pwAutocomplete === "current-password") return true;
	if (usernameField) return true;
	if (hasLoginIntent(form)) return true;

	try {
		const submit = form.querySelector('button[type="submit"], input[type="submit"]');
		const text = safeLower(submit?.textContent || submit?.getAttribute?.("value") || "");
		if (/log\s*in|sign\s*in|continue/.test(text)) return true;
	} catch {
		// ignore
	}

	return false;
}

function classifyCredentialForm(form) {
	if (!form || !(form instanceof HTMLFormElement)) {
		return null;
	}

	if (isExcludedCredentialForm(form)) {
		return null;
	}

	const passwordFields = findPasswordFieldsInFormDeep(form);
	if (passwordFields.length === 0) {
		return null;
	}

	if (passwordFields.length === 1) {
		const passwordField = passwordFields[0];
		if (looksLikeNewPasswordField(passwordField)) {
			return null;
		}

		const password = typeof passwordField.value === "string" ? passwordField.value : "";
		if (!password) {
			return null;
		}

		const usernameField = findUsernameField(passwordField);
		const username = usernameField && typeof usernameField.value === "string" ? usernameField.value : "";
		if (!isLikelyLoginForm(form, passwordField, usernameField)) {
			return null;
		}

		return { mode: "login", username, password };
	}

	const currentField = passwordFields.find(looksLikeCurrentPasswordField) || null;
	let newField = passwordFields.find((f) => f !== currentField && looksLikeNewPasswordField(f)) || null;
	if (newField && currentField && newField === currentField) {
		newField = null;
	}

	if (!currentField || !newField) {
		return null;
	}

	const confirmField = passwordFields.find((f) => f !== currentField && f !== newField && looksLikeNewPasswordField(f)) || null;

	const currentPassword = typeof currentField.value === "string" ? currentField.value : "";
	const newPassword = typeof newField.value === "string" ? newField.value : "";
	const confirmPassword = confirmField && typeof confirmField.value === "string" ? confirmField.value : "";

	if (!currentPassword || !newPassword) {
		return null;
	}

	if (confirmField && confirmPassword && confirmPassword !== newPassword) {
		return null;
	}

	const usernameField = findUsernameField(currentField);
	const username = usernameField && typeof usernameField.value === "string" ? usernameField.value : "";

	return { mode: "changePassword", username, currentPassword, newPassword };
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

function findStandaloneUsernameFieldDeep() {
	const selector = [
		'input[autocomplete="username"]',
		'input[type="email"]',
		'input[name*="email" i]',
		'input[id*="email" i]',
		'input[name*="user" i]',
		'input[id*="user" i]',
		'input[name*="login" i]',
		'input[id*="login" i]',
	].join(",");

	for (const ctx of collectSearchContexts()) {
		const candidates = queryAllDeepWithin(ctx, selector).filter((input) => isVisibleInput(input) && !isIgnoredField(input));
		if (candidates.length > 0) return candidates[0];
	}
	return null;
}

let lastSavedSignature = "";
let lastSavedAt = 0;

function shouldDedupeSave(signature) {
	const now = Date.now();
	if (signature && signature === lastSavedSignature && now - lastSavedAt < 30_000) {
		return true;
	}
	lastSavedSignature = signature;
	lastSavedAt = now;
	return false;
}

function sendSaveRequest(classified) {
	try {
		chrome.runtime.sendMessage(
			{
				type: "SAVE_CREDENTIALS",
				url: location.href,
				mode: classified.mode,
				username: classified.username,
				password: classified.mode === "login" ? classified.password : undefined,
				currentPassword: classified.mode === "changePassword" ? classified.currentPassword : undefined,
				newPassword: classified.mode === "changePassword" ? classified.newPassword : undefined,
			},
			(response) => {
				if (chrome.runtime.lastError) {
					console.debug("Auto-save message failed:", chrome.runtime.lastError.message);
					return;
				}
				if (!response?.ok) {
					console.debug("Auto-save skipped/failed:", response?.error);
				}
			}
		);
	} catch (error) {
		console.debug("Auto-save error:", error);
	}
}

function tryAutoSaveFromForm(form) {
	const classified = classifyCredentialForm(form);
	if (!classified) {
		return;
	}

	const signature = (() => {
		if (classified.mode === "login") {
			return `${location.hostname}|login|${classified.username || ""}|${classified.password}`;
		}
		return `${location.hostname}|change|${classified.username || ""}|${classified.currentPassword}|${classified.newPassword}`;
	})();
	if (shouldDedupeSave(signature)) {
		return;
	}

	sendSaveRequest(classified);
}

function findSubmitFormFromEvent(event) {
	const target = event.target;
	if (!target || !(target instanceof Element)) return null;
	const submitter = target.closest('button, input[type="submit"], input[type="button"], [role="button"]');
	if (!submitter) return null;
	return submitter.form || submitter.closest("form");
}

document.addEventListener(
	"submit",
	(event) => {
		const form = event.target;
		tryAutoSaveFromForm(form);
	},
	true
);

document.addEventListener(
	"click",
	(event) => {
		const form = findSubmitFormFromEvent(event);
		if (form) {
			tryAutoSaveFromForm(form);
		}
	},
	true
);

function waitForPasswordField(timeoutMs = 2500) {
	const existing = findPasswordFieldDeep();
	if (existing) {
		return Promise.resolve(existing);
	}

	return new Promise((resolve) => {
		let done = false;
		const finish = (value) => {
			if (done) return;
			done = true;
			try {
				observer.disconnect();
			} catch {
				// ignore
			}
			resolve(value || null);
		};

		const observer = new MutationObserver(() => {
			const found = findPasswordFieldDeep();
			if (found) {
				finish(found);
			}
		});

		try {
			observer.observe(document, { subtree: true, childList: true, attributes: true });
		} catch {
			// ignore
		}

		setTimeout(() => finish(null), timeoutMs);
	});
}

	chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (!message || typeof message.type !== "string") {
		return;
	}

	if (message.type === "DETECT_LOGIN_FIELDS") {
		void (async () => {
			const passwordField = await waitForPasswordField(1200);
			const usernameField = passwordField ? findUsernameField(passwordField) : findStandaloneUsernameFieldDeep();

			sendResponse?.({
				ok: true,
				hasPasswordField: !!passwordField,
				hasUsernameField: !!usernameField,
			});
		})();
		return true;
	}

	if (message.type === "FILL_CREDENTIALS") {
		void (async () => {
			const username = typeof message.username === "string" ? message.username : "";
			const password = typeof message.password === "string" ? message.password : "";

			if (!password) {
				sendResponse?.({ ok: false, error: "Missing password" });
				return;
			}

			const passwordField = await waitForPasswordField(2500);
			if (!passwordField) {
				const usernameField = findStandaloneUsernameFieldDeep();
				if (usernameField && username) {
					setInputValue(usernameField, username);
					sendResponse?.({ ok: true, partial: "username" });
					return;
				}
				sendResponse?.({ ok: false, error: "No password field found" });
				return;
			}

			const usernameField = findUsernameField(passwordField);
			if (usernameField && username) {
				setInputValue(usernameField, username);
			}

			setInputValue(passwordField, password);
			sendResponse?.({ ok: true });
		})();
		return true;
	}
	});
})();
