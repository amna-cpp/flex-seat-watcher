"use strict";

const elements = {
  headline: document.querySelector("#headline"),
  targets: document.querySelector("#targets"),
  interval: document.querySelector("#interval"),
  autoLogin: document.querySelector("#auto-login"),
  autoRegister: document.querySelector("#auto-register"),
  emailEnabled: document.querySelector("#email-enabled"),
  emailRecipient: document.querySelector("#email-recipient"),
  emailWebhook: document.querySelector("#email-webhook"),
  testEmail: document.querySelector("#test-email"),
  start: document.querySelector("#start"),
  stop: document.querySelector("#stop"),
  scan: document.querySelector("#scan"),
  calibrate: document.querySelector("#calibrate"),
  status: document.querySelector("#status")
};

function formatTime(value) {
  if (!value) return "Waiting for the first check";
  return `Last checked ${new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
}

function stateLabel(state) {
  if (state === "available") return "Available";
  if (state === "full") return "Full";
  return "Not found";
}

function setBusy(busy) {
  elements.start.disabled = busy;
  elements.stop.disabled = busy;
  elements.scan.disabled = busy;
  elements.calibrate.disabled = busy;
  elements.testEmail.disabled = busy;
}

function render(watcher) {
  if (!watcher) {
    throw new Error("The extension background is out of date. Reload Flex Seat Watcher on chrome://extensions, then reopen this popup.");
  }
  elements.targets.value = (watcher.targets || []).join("\n");
  elements.interval.value = String(watcher.intervalMinutes || 1);
  elements.targets.disabled = watcher.enabled;
  elements.interval.disabled = watcher.enabled;
  elements.autoLogin.checked = Boolean(watcher.autoLogin);
  elements.autoLogin.disabled = watcher.enabled;
  elements.autoRegister.checked = Boolean(watcher.autoRegister);
  elements.autoRegister.disabled = watcher.enabled;
  elements.emailEnabled.checked = Boolean(watcher.email?.enabled);
  elements.emailEnabled.disabled = watcher.enabled;
  elements.emailRecipient.textContent = watcher.email?.recipient || "not configured";
  elements.emailWebhook.value = watcher.email?.webhookUrl || "";
  elements.emailWebhook.disabled = watcher.enabled;
  elements.start.hidden = watcher.enabled;
  elements.stop.hidden = !watcher.enabled;
  elements.scan.hidden = !watcher.enabled;
  elements.calibrate.textContent = watcher.coordinateFallback?.calibratedAt
    ? "Re-teach Available Courses position"
    : "Teach Available Courses position";

  if (watcher.registration?.phase === "success") {
    elements.headline.textContent = "Registration completed";
  } else if (watcher.registration?.phase === "error") {
    elements.headline.textContent = "Manual registration needed";
  } else if (["attempting", "verifying"].includes(watcher.registration?.phase)) {
    elements.headline.textContent = "Registering and verifying…";
  } else if (!watcher.enabled) {
    elements.headline.textContent = "Ready to watch";
  } else if (watcher.signedOut) {
    elements.headline.textContent = watcher.autoLogin
      ? "Automatic sign-in needs attention"
      : "Sign in to Flex again";
  } else if (watcher.autoLoginStatus === "attempting") {
    elements.headline.textContent = "Signing in automatically…";
  } else if (watcher.openTargets.length) {
    elements.headline.textContent = "A seat may be open!";
  } else {
    elements.headline.textContent = formatTime(watcher.checkedAt);
  }

  elements.status.replaceChildren();
  if (watcher.checkedAt) {
    const checked = document.createElement("div");
    checked.className = "course";
    const label = document.createElement("strong");
    label.textContent = "Last checked";
    const time = document.createElement("span");
    time.className = "pill time";
    time.textContent = new Date(watcher.checkedAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    checked.append(label, time);
    elements.status.append(checked);
  }
  if (watcher.coordinateFallback?.calibratedAt) {
    const calibration = document.createElement("div");
    calibration.className = "course";
    const label = document.createElement("strong");
    label.textContent = "Native click fallback";
    const badge = document.createElement("span");
    badge.className = "pill success";
    badge.textContent = "Calibrated";
    calibration.append(label, badge);
    elements.status.append(calibration);
  }
  if (watcher.email?.enabled) {
    const email = document.createElement("div");
    email.className = "course";
    const label = document.createElement("strong");
    label.textContent = "Email alerts";
    const badge = document.createElement("span");
    badge.className = `pill ${watcher.email.lastError ? "error" : "success"}`;
    badge.textContent = watcher.email.lastError ? "Error" : "Enabled";
    email.append(label, badge);
    elements.status.append(email);
    if (watcher.email.lastError) {
      const detail = document.createElement("div");
      detail.className = "message error";
      detail.textContent = watcher.email.lastError;
      elements.status.append(detail);
    }
  }
  if (watcher.registration?.phase && watcher.registration.phase !== "idle") {
    const registration = document.createElement("div");
    registration.className = "course";
    const label = document.createElement("strong");
    label.textContent = watcher.registration.target || "Registration";
    const badge = document.createElement("span");
    const phase = watcher.registration.phase;
    badge.className = `pill ${phase === "success" ? "success" : phase === "error" ? "error" : "registering"}`;
    badge.textContent = phase === "success" ? "Registered" : phase === "error" ? "Needs help" : "Registering";
    registration.append(label, badge);
    elements.status.append(registration);
  }
  if (watcher.enabled && watcher.navigation?.status && watcher.navigation.status !== "ready") {
    const navigation = document.createElement("div");
    navigation.className = "course";
    const label = document.createElement("strong");
    label.textContent = "Available Courses tab";
    const badge = document.createElement("span");
    const missing = watcher.navigation.status === "not-found";
    badge.className = `pill ${missing ? "error" : "registering"}`;
    badge.textContent = missing ? "Not found" : "Opening";
    navigation.append(label, badge);
    elements.status.append(navigation);
    if (missing && watcher.navigation.detail) {
      const detail = document.createElement("div");
      detail.className = "message error";
      detail.textContent = watcher.navigation.detail;
      elements.status.append(detail);
    }
  }
  if (watcher.error) {
    const error = document.createElement("div");
    error.className = "message error";
    error.textContent = watcher.error;
    elements.status.append(error);
  }
  if (watcher.signedOut) {
    const note = document.createElement("div");
    note.className = "message error";
    note.textContent = watcher.autoLogin
      ? "Your browser did not autofill both fields, or the saved login failed. Open the tab, complete any device-authentication prompt, and sign in manually once."
      : "The watcher reached the Flex login page. Sign in, return to Available Courses, then leave this tab open.";
    elements.status.append(note);
  }
  if (watcher.results && watcher.results.length) {
    watcher.results.forEach((result) => {
      const row = document.createElement("div");
      row.className = "course";
      const name = document.createElement("strong");
      name.textContent = result.target;
      const badge = document.createElement("span");
      badge.className = `pill ${result.state}`;
      badge.textContent = stateLabel(result.state);
      row.append(name, badge);
      elements.status.append(row);
    });
  } else if (!watcher.error && !watcher.signedOut) {
    const note = document.createElement("div");
    note.className = "message";
    note.textContent = watcher.enabled
      ? "The Flex tab is refreshing; results will appear after the page loads."
      : "Open Flex → Course Registration → Available Courses, then start the watcher.";
    elements.status.append(note);
  }
}

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "The extension background did not respond.");
  if (response.result == null) {
    throw new Error("The extension background is out of date. Reload Flex Seat Watcher on chrome://extensions, then try again.");
  }
  return response.result;
}

async function refresh() {
  try {
    render(await send({ type: "GET_STATE" }));
  } catch (error) {
    elements.status.textContent = error.message;
  }
}

elements.start.addEventListener("click", async () => {
  setBusy(true);
  try {
    if (elements.autoRegister.checked) {
      const approved = window.confirm(
        "Automatic registration will tick Register and press Confirm Registration without asking again when a seat appears. Edge Computing is preferred if both courses are available. Continue?"
      );
      if (!approved) return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const targets = elements.targets.value.split("\n").map((value) => value.trim()).filter(Boolean);
    render(await send({
      type: "START",
      tabId: tab.id,
      targets,
      intervalMinutes: Number(elements.interval.value),
      autoLogin: elements.autoLogin.checked,
      autoRegister: elements.autoRegister.checked,
      emailEnabled: elements.emailEnabled.checked,
      emailWebhookUrl: elements.emailWebhook.value.trim()
    }));
  } catch (error) {
    elements.status.innerHTML = "";
    const note = document.createElement("div");
    note.className = "message error";
    note.textContent = error.message;
    elements.status.append(note);
  } finally {
    setBusy(false);
  }
});

elements.stop.addEventListener("click", async () => {
  setBusy(true);
  try {
    render(await send({ type: "STOP" }));
  } finally {
    setBusy(false);
  }
});

elements.scan.addEventListener("click", async () => {
  setBusy(true);
  try {
    await send({ type: "SCAN_NOW" });
    window.close();
  } finally {
    setBusy(false);
  }
});

elements.calibrate.addEventListener("click", async () => {
  setBusy(true);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await send({ type: "BEGIN_CALIBRATION", tabId: tab.id });
    window.close();
  } catch (error) {
    elements.status.innerHTML = "";
    const note = document.createElement("div");
    note.className = "message error";
    note.textContent = error.message;
    elements.status.append(note);
  } finally {
    setBusy(false);
  }
});

elements.testEmail.addEventListener("click", async () => {
  setBusy(true);
  try {
    render(await send({
      type: "TEST_EMAIL",
      webhookUrl: elements.emailWebhook.value.trim()
    }));
  } catch (error) {
    elements.status.innerHTML = "";
    const note = document.createElement("div");
    note.className = "message error";
    note.textContent = error.message;
    elements.status.append(note);
  } finally {
    setBusy(false);
  }
});

refresh();
