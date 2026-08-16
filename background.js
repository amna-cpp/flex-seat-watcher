importScripts("scanner.js", "config.js");
try {
  importScripts("config.local.js");
} catch {
  // Email alerts stay unavailable until optional local configuration is added.
}

"use strict";

const ALARM_NAME = "flex-seat-watch";
const CURRENT_SCHEMA_VERSION = 6;
const AUTO_REGISTER_TARGETS = ["Multiagent Systems", "Edge Computing"];
const PRIVATE_CONFIG = globalThis.FLEX_SEAT_WATCHER_CONFIG || {};
const EMAIL_RECIPIENT = PRIVATE_CONFIG.emailRecipient || "";
const EMAIL_SECRET = PRIVATE_CONFIG.emailSecret || "";
const DEFAULT_EMAIL_WEBHOOK = PRIVATE_CONFIG.defaultEmailWebhook || "";
const DEFAULT_WATCHER = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  enabled: false,
  tabId: null,
  intervalMinutes: 1,
  targets: ["Multiagent Systems", "Edge Computing"],
  autoRegisterTargets: AUTO_REGISTER_TARGETS,
  autoLogin: false,
  autoRegister: false,
  runId: null,
  autoLoginStatus: null,
  autoLoginAttemptedAt: null,
  results: [],
  checkedAt: null,
  url: null,
  openTargets: [],
  signedOut: false,
  sessionAlerted: false,
  activeFrameId: null,
  coordinateFallback: {
    xRatio: null,
    yRatio: null,
    calibratedAt: null,
    lastClickedAt: null
  },
  email: {
    recipient: EMAIL_RECIPIENT,
    enabled: false,
    webhookUrl: DEFAULT_EMAIL_WEBHOOK,
    lastSentAt: null,
    lastError: null
  },
  registration: {
    phase: "idle",
    target: null,
    attemptedAt: null,
    completedAt: null,
    detail: null
  },
  navigation: {
    status: "idle",
    attemptedAt: null,
    detail: null,
    source: null
  },
  error: null
};

async function getWatcher() {
  const stored = await chrome.storage.local.get("watcher");
  const saved = stored.watcher || {};
  return {
    ...DEFAULT_WATCHER,
    ...saved,
    registration: { ...DEFAULT_WATCHER.registration, ...(saved.registration || {}) },
    navigation: { ...DEFAULT_WATCHER.navigation, ...(saved.navigation || {}) },
    coordinateFallback: {
      ...DEFAULT_WATCHER.coordinateFallback,
      ...(saved.coordinateFallback || {})
    },
    email: {
      ...DEFAULT_WATCHER.email,
      ...(saved.email || {}),
      recipient: EMAIL_RECIPIENT,
      webhookUrl: saved.email?.webhookUrl || DEFAULT_EMAIL_WEBHOOK
    }
  };
}

async function saveWatcher(next) {
  await chrome.storage.local.set({ watcher: next });
  await updateBadge(next);
}

async function updateBadge(watcher) {
  if (watcher.registration.phase === "success") {
    await chrome.action.setBadgeBackgroundColor({ color: "#087445" });
    await chrome.action.setBadgeText({ text: "DONE" });
  } else if (watcher.registration.phase === "error") {
    await chrome.action.setBadgeBackgroundColor({ color: "#b33a3a" });
    await chrome.action.setBadgeText({ text: "ERR" });
  } else if (["attempting", "verifying"].includes(watcher.registration.phase)) {
    await chrome.action.setBadgeBackgroundColor({ color: "#b26b00" });
    await chrome.action.setBadgeText({ text: "REG" });
  } else if (watcher.openTargets.length) {
    await chrome.action.setBadgeBackgroundColor({ color: "#0b8f55" });
    await chrome.action.setBadgeText({ text: "OPEN" });
  } else if (watcher.enabled) {
    await chrome.action.setBadgeBackgroundColor({ color: "#4f6b85" });
    await chrome.action.setBadgeText({ text: "ON" });
  } else {
    await chrome.action.setBadgeText({ text: "" });
  }
}

async function notifyRegistration(outcome, target, detail) {
  const success = outcome === "success";
  await chrome.notifications.create(`flex-registration-${outcome}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon128.png"),
    title: success ? "Flex registration verified" : "Manual Flex registration needed",
    message: success
      ? `${target} was confirmed under Already Registered Courses.`
      : `${target}: ${detail || "Flex could not complete registration. Please register manually."}`,
    buttons: [{ title: "Open Flex" }],
    priority: 2,
    requireInteraction: true
  });
}

function isFlexUrl(url) {
  try {
    return new URL(url).hostname === "flexstudent.nu.edu.pk";
  } catch {
    return false;
  }
}

function normalizeEmailWebhookUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(String(value).trim());
    if (url.protocol !== "https:" || url.hostname !== "script.google.com") return "";
    if (!/^\/macros\/s\/[^/]+\/exec\/?$/.test(url.pathname)) return "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function emailEventDetail(event, target, detail) {
  if (detail) return detail;
  if (event === "test") return "Your Flex Seat Watcher email connection is working.";
  if (event === "seat-available") return `${target} has changed to available. Open Flex immediately.`;
  if (event === "registration-success") return `${target} was verified under Already Registered Courses.`;
  return `${target} could not be registered automatically. Please register it manually.`;
}

async function deliverEmail(email, event, target, detail, checkedAt, url) {
  if (!email?.enabled || !email.webhookUrl) return false;
  if (!EMAIL_RECIPIENT || !EMAIL_SECRET) {
    throw new Error("Email is not configured. Copy config.local.example.js to config.local.js and add your private email settings.");
  }
  const webhookUrl = normalizeEmailWebhookUrl(email.webhookUrl);
  if (!webhookUrl) throw new Error("The email webhook URL is invalid. It must be a deployed script.google.com /exec URL.");

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      secret: EMAIL_SECRET,
      event,
      target: target || null,
      detail: emailEventDetail(event, target, detail),
      checkedAt: checkedAt || new Date().toISOString(),
      url: isFlexUrl(url) ? url : "https://flexstudent.nu.edu.pk"
    }),
    redirect: "follow",
    credentials: "omit"
  });
  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error("The Google Apps Script webhook returned an unreadable response.");
  }
  if (!response.ok || !result.ok) {
    throw new Error(result.error || `Email webhook failed with HTTP ${response.status}.`);
  }
  return true;
}

async function sendConfiguredEmail(watcher, event, target, detail, checkedAt, url) {
  if (!watcher.email?.enabled) return false;
  try {
    await deliverEmail(watcher.email, event, target, detail, checkedAt, url);
    const current = await getWatcher();
    await saveWatcher({
      ...current,
      email: {
        ...current.email,
        lastSentAt: new Date().toISOString(),
        lastError: null
      }
    });
    return true;
  } catch (error) {
    const current = await getWatcher();
    await saveWatcher({
      ...current,
      email: {
        ...current.email,
        lastError: `Email failed: ${error.message}`
      }
    });
    return false;
  }
}

async function testEmailWebhook(message) {
  const webhookUrl = normalizeEmailWebhookUrl(message.webhookUrl);
  if (!webhookUrl) throw new Error("Paste the deployed Google Apps Script URL ending in /exec.");
  const watcher = await getWatcher();
  const next = {
    ...watcher,
    email: {
      ...watcher.email,
      recipient: EMAIL_RECIPIENT,
      enabled: true,
      webhookUrl,
      lastError: null
    }
  };
  await saveWatcher(next);
  const sent = await sendConfiguredEmail(
    next,
    "test",
    null,
    "Your Flex Seat Watcher email connection is working.",
    new Date().toISOString(),
    next.url
  );
  if (!sent) {
    const current = await getWatcher();
    throw new Error(current.email.lastError || "The test email could not be sent.");
  }
  return getWatcher();
}

const nativeNavigationInProgress = new Set();

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function cdpChildren(node) {
  return [
    ...(node.children || []),
    ...(node.shadowRoots || []),
    ...(node.contentDocument ? [node.contentDocument] : []),
    ...(node.templateContent ? [node.templateContent] : []),
    ...(node.pseudoElements || [])
  ];
}

function flattenCdpTree(root) {
  const nodes = [];
  const pending = root ? [root] : [];
  while (pending.length) {
    const node = pending.shift();
    nodes.push(node);
    pending.push(...cdpChildren(node));
  }
  return nodes;
}

function cdpAttributes(node) {
  const attributes = {};
  for (let index = 0; index < (node.attributes || []).length; index += 2) {
    attributes[String(node.attributes[index]).toLowerCase()] = String(node.attributes[index + 1] || "");
  }
  return attributes;
}

function cdpNodeText(node) {
  const attributes = cdpAttributes(node);
  const ownText = [
    node.nodeValue,
    attributes.value,
    attributes.title,
    attributes["aria-label"]
  ].filter(Boolean);
  const childText = cdpChildren(node).flatMap((child) => cdpNodeText(child));
  return [...ownText, ...childText];
}

function isCdpNodeEnabled(node) {
  const attributes = cdpAttributes(node);
  return !("disabled" in attributes) && attributes["aria-disabled"] !== "true";
}

function describeCdpRow(row) {
  const descendants = flattenCdpTree(row);
  const hasEnabledRegisterControl = descendants.some((node) => {
    if (!isCdpNodeEnabled(node)) return false;
    const attributes = cdpAttributes(node);
    const name = String(node.nodeName || "").toUpperCase();
    if (name === "INPUT" && /^(checkbox|radio)$/i.test(attributes.type || "")) return true;
    if (!["A", "BUTTON", "INPUT", "LABEL"].includes(name)) return false;
    return /\bregister\b/.test(FlexSeatScanner.normalize(cdpNodeText(node).join(" ")));
  });
  const hasSectionSelect = descendants.some((node) => {
    if (String(node.nodeName || "").toUpperCase() !== "SELECT" || !isCdpNodeEnabled(node)) return false;
    return flattenCdpTree(node).some((candidate) => {
      if (String(candidate.nodeName || "").toUpperCase() !== "OPTION" || !isCdpNodeEnabled(candidate)) return false;
      const value = cdpNodeText(candidate).join(" ");
      return value && !/select|choose/i.test(value);
    });
  });

  return {
    text: cdpNodeText(row).join(" "),
    hasEnabledRegisterControl,
    hasSectionSelect
  };
}

async function withFlexDebugger(tabId, action) {
  const tab = await chrome.tabs.get(tabId);
  if (!isFlexUrl(tab.url)) throw new Error("Native inspection is restricted to the watched Flex tab.");
  const target = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    return await action(target);
  } finally {
    if (attached) await chrome.debugger.detach(target).catch(() => {});
  }
}

async function debuggerDocument(target) {
  const response = await chrome.debugger.sendCommand(target, "DOM.getDocument", {
    depth: -1,
    pierce: true
  });
  return response.root;
}

async function debuggerClickPoint(target, x, y) {
  const point = { x: Math.round(x), y: Math.round(y) };
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    ...point
  });
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    clickCount: 1,
    ...point
  });
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    ...point
  });
}

async function debuggerClickLabel(target, label) {
  const wanted = FlexSeatScanner.normalize(label);
  const root = await debuggerDocument(target);
  const nodes = flattenCdpTree(root);
  const textNodes = nodes.filter((node) => FlexSeatScanner.normalize(node.nodeValue) === wanted);
  const elementNodes = nodes.filter((node) => {
    if (node.nodeType !== 1) return false;
    return FlexSeatScanner.normalize(cdpNodeText(node).join(" ")) === wanted;
  });

  for (const node of [...textNodes, ...elementNodes]) {
    if (!node.backendNodeId) continue;
    try {
      const response = await chrome.debugger.sendCommand(target, "DOM.getBoxModel", {
        backendNodeId: node.backendNodeId
      });
      const quad = response.model?.border || response.model?.content;
      if (!quad || quad.length < 8) continue;
      const xs = [quad[0], quad[2], quad[4], quad[6]];
      const ys = [quad[1], quad[3], quad[5], quad[7]];
      const x = (Math.min(...xs) + Math.max(...xs)) / 2;
      const y = (Math.min(...ys) + Math.max(...ys)) / 2;
      if (x < 0 || y < 0) continue;
      await debuggerClickPoint(target, x, y);
      return true;
    } catch {
      // Try the next matching text or element node.
    }
  }
  return false;
}

async function debuggerScanCourses(target, targets) {
  const root = await debuggerDocument(target);
  const rows = flattenCdpTree(root)
    .filter((node) => String(node.nodeName || "").toUpperCase() === "TR")
    .map(describeCdpRow);
  return FlexSeatScanner.scanRows(rows, targets || []);
}

async function beginCoordinateCalibration(message) {
  const tab = await chrome.tabs.get(message.tabId);
  if (!isFlexUrl(tab.url)) throw new Error("Open the Flex Course Registration tab first.");
  const response = await chrome.tabs.sendMessage(
    tab.id,
    { type: "BEGIN_COORDINATE_CALIBRATION" },
    { frameId: 0 }
  );
  if (!response?.ok || !response.result) {
    throw new Error("Refresh the Flex page once, then try calibration again.");
  }
  return true;
}

async function handleCalibrationSaved(message, tabId, frameId) {
  if (frameId !== 0) return getWatcher();
  const tab = await chrome.tabs.get(tabId);
  if (!isFlexUrl(tab.url)) throw new Error("Calibration is restricted to Flex.");
  const xRatio = Number(message.xRatio);
  const yRatio = Number(message.yRatio);
  if (!(xRatio > 0 && xRatio < 1 && yRatio > 0 && yRatio < 1)) {
    throw new Error("That click position was outside the Flex page.");
  }
  const watcher = await getWatcher();
  const next = {
    ...watcher,
    coordinateFallback: {
      xRatio,
      yRatio,
      calibratedAt: message.checkedAt,
      lastClickedAt: null
    },
    navigation: {
      status: "calibrated",
      attemptedAt: message.checkedAt,
      detail: "Native click position saved.",
      source: "calibration"
    }
  };
  await saveWatcher(next);
  return next;
}

async function handleNativeNavigationRequest(message, tabId, frameId) {
  const watcher = await getWatcher();
  if (!watcher.enabled || watcher.tabId !== tabId || frameId !== 0) return { clicked: false };
  if (nativeNavigationInProgress.has(tabId)) return { clicked: true, detail: "Native navigation is already running." };

  const lastClick = Date.parse(watcher.coordinateFallback.lastClickedAt || "") || 0;
  if (Date.now() - lastClick < 7000) {
    return { clicked: true, detail: "Native navigation was requested recently." };
  }

  nativeNavigationInProgress.add(tabId);
  try {
    const nativeResult = await withFlexDebugger(tabId, async (target) => {
      let clickedBy = null;
      if (await debuggerClickLabel(target, message.label || "Available Courses")) {
        clickedBy = "page-label";
      } else if (watcher.coordinateFallback.calibratedAt) {
        const width = Math.max(1, Number(message.viewportWidth) || 1);
        const height = Math.max(1, Number(message.viewportHeight) || 1);
        await debuggerClickPoint(
          target,
          watcher.coordinateFallback.xRatio * width,
          watcher.coordinateFallback.yRatio * height
        );
        clickedBy = "calibrated-position";
      }

      if (!clickedBy) {
        return {
          clicked: false,
          resultsFound: false,
          detail: "Chrome's native inspector could not locate the label. Use Teach Available Courses position once."
        };
      }

      await delay(1400);
      const results = await debuggerScanCourses(target, watcher.targets);
      const resultsFound = results.some((result) => result.found);
      if (resultsFound) {
        await handlePageScan({
          signedOut: false,
          results,
          checkedAt: new Date().toISOString(),
          url: message.url,
          frameId: -1
        }, tabId);
      }
      return {
        clicked: true,
        resultsFound,
        detail: clickedBy === "page-label"
          ? "Chrome located and clicked the Available Courses label natively."
          : "Chrome clicked the taught Available Courses screen position."
      };
    });

    const current = await getWatcher();
    await saveWatcher({
      ...current,
      coordinateFallback: {
        ...current.coordinateFallback,
        lastClickedAt: new Date().toISOString()
      }
    });
    return nativeResult;
  } catch (error) {
    return {
      clicked: false,
      resultsFound: false,
      detail: `Native Chrome navigation failed: ${error.message}`
    };
  } finally {
    nativeNavigationInProgress.delete(tabId);
  }
}

function canAutoRegister(watcher, target) {
  const normalized = String(target || "").toLowerCase();
  return (watcher.autoRegisterTargets || AUTO_REGISTER_TARGETS)
    .some((allowed) => normalized.includes(allowed.toLowerCase()));
}

async function notifyCourse(target) {
  await chrome.notifications.create(`flex-seat-${target}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon128.png"),
    title: "Flex seat may be available",
    message: `${target} now shows a registration control. Open Flex and register immediately.`,
    buttons: [{ title: "Open Flex" }],
    priority: 2,
    requireInteraction: true
  });
}

async function notifySignedOut(autoLogin) {
  await chrome.notifications.create("flex-seat-signed-out", {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon128.png"),
    title: "Flex Seat Watcher needs you",
    message: autoLogin
      ? "Automatic sign-in did not complete. Your browser may need device authentication or updated saved credentials."
      : "Your Flex session appears to be signed out. Log in again to continue checking.",
    buttons: [{ title: "Open Flex" }],
    priority: 1,
    requireInteraction: true
  });
}

async function focusWatchedTab() {
  const watcher = await getWatcher();
  if (!watcher.tabId) return;
  try {
    const tab = await chrome.tabs.get(watcher.tabId);
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    // The popup will show that the watched tab was closed.
  }
}

async function findFlexTab() {
  const tabs = await chrome.tabs.query({ url: "https://flexstudent.nu.edu.pk/*" });
  return tabs.find((tab) => !/\/login\/?$/i.test(new URL(tab.url).pathname)) || tabs[0] || null;
}

async function ensureAlarm() {
  const watcher = await getWatcher();
  await updateBadge(watcher);
  if (!watcher.enabled) return;

  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: watcher.intervalMinutes });
  }
}

async function initializeExtensionState() {
  const stored = await chrome.storage.local.get("watcher");
  const savedSchemaVersion = stored.watcher?.schemaVersion;
  const watcher = await getWatcher();
  if (savedSchemaVersion !== CURRENT_SCHEMA_VERSION) {
    await chrome.alarms.clear(ALARM_NAME);
    await saveWatcher({
      ...watcher,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      enabled: false,
      autoRegister: false,
      targets: (watcher.targets || []).filter((target) => !target.toLowerCase().includes("blockchain")),
      autoRegisterTargets: AUTO_REGISTER_TARGETS,
      openTargets: [],
      registration: { ...DEFAULT_WATCHER.registration },
      navigation: { ...DEFAULT_WATCHER.navigation },
      error: null
    });
    return;
  }
  await ensureAlarm();
}

async function reloadWatchedTab() {
  const watcher = await getWatcher();
  if (!watcher.enabled || !watcher.tabId) return;

  try {
    const tab = await chrome.tabs.get(watcher.tabId);
    if (!isFlexUrl(tab.url)) {
      await saveWatcher({ ...watcher, error: "The watched tab is no longer on Flex." });
      return;
    }
    await chrome.tabs.reload(watcher.tabId);
  } catch {
    const replacement = await findFlexTab();
    if (replacement) {
      await saveWatcher({ ...watcher, tabId: replacement.id, url: replacement.url, error: null });
      await chrome.tabs.reload(replacement.id);
    } else {
      await chrome.alarms.clear(ALARM_NAME);
      await saveWatcher({
        ...watcher,
        enabled: false,
        tabId: null,
        error: "The watched Flex tab was closed."
      });
    }
  }
}

async function requestAvailableCourses(tabId, source) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "OPEN_AVAILABLE_COURSES", source });
  } catch {
    // The content script may not be attached yet; the next delayed request retries.
  }
}

async function startWatcher(message) {
  const previous = await getWatcher();
  const tab = await chrome.tabs.get(message.tabId);
  if (!isFlexUrl(tab.url)) {
    throw new Error("Open flexstudent.nu.edu.pk in this tab first.");
  }

  const targets = message.targets.map((target) => target.trim()).filter(Boolean);
  if (!targets.length) throw new Error("Add at least one course name.");
  const webhookUrl = normalizeEmailWebhookUrl(message.emailWebhookUrl || previous.email.webhookUrl);
  if (message.emailEnabled && !webhookUrl) {
    throw new Error("Paste the deployed Google Apps Script /exec URL before enabling email alerts.");
  }

  const watcher = {
    ...DEFAULT_WATCHER,
    enabled: true,
    tabId: message.tabId,
    intervalMinutes: Math.max(1, Number(message.intervalMinutes) || 1),
    targets,
    autoRegisterTargets: AUTO_REGISTER_TARGETS,
    autoLogin: Boolean(message.autoLogin),
    autoRegister: Boolean(message.autoRegister),
    coordinateFallback: previous.coordinateFallback,
    email: {
      ...previous.email,
      recipient: EMAIL_RECIPIENT,
      enabled: Boolean(message.emailEnabled),
      webhookUrl,
      lastError: null
    },
    runId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    url: tab.url
  };
  await saveWatcher(watcher);
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: watcher.intervalMinutes });
  await chrome.tabs.reload(watcher.tabId);
  return watcher;
}

async function stopWatcher() {
  const watcher = await getWatcher();
  await chrome.alarms.clear(ALARM_NAME);
  const next = { ...watcher, enabled: false, openTargets: [] };
  await saveWatcher(next);
  return next;
}

async function handlePageScan(message, tabId) {
  const watcher = await getWatcher();
  if (!watcher.enabled || watcher.tabId !== tabId) return watcher;

  if (message.signedOut) {
    if (message.frameId !== 0) return watcher;
    if (!watcher.sessionAlerted) await notifySignedOut(watcher.autoLogin);
    const next = {
      ...watcher,
      signedOut: true,
      autoLoginStatus: watcher.autoLogin ? "needs-attention" : null,
      sessionAlerted: true,
      checkedAt: message.checkedAt,
      url: message.url,
      results: [],
      openTargets: [],
      error: null
    };
    await saveWatcher(next);
    return next;
  }

  const hasCourseRows = message.results.some((result) => result.found);
  if (watcher.activeFrameId !== null
      && watcher.activeFrameId !== message.frameId
      && !hasCourseRows) {
    return watcher;
  }

  const openTargets = message.results
    .filter((result) => result.available)
    .map((result) => result.target);
  const newlyOpen = openTargets.filter((target) => !watcher.openTargets.includes(target));

  const next = {
    ...watcher,
    signedOut: false,
    autoLoginStatus: null,
    autoLoginAttemptedAt: null,
    sessionAlerted: false,
    activeFrameId: hasCourseRows ? message.frameId : watcher.activeFrameId,
    checkedAt: message.checkedAt,
    url: message.url,
    results: message.results,
    openTargets,
    navigation: message.results.some((result) => result.found)
      ? {
          status: "ready",
          attemptedAt: message.checkedAt,
          detail: "Available Courses rows are visible.",
          source: "page-scan"
        }
      : watcher.navigation,
    error: null
  };
  await saveWatcher(next);
  for (const target of newlyOpen) {
    if (!watcher.autoRegister || !canAutoRegister(watcher, target)) await notifyCourse(target);
    await sendConfiguredEmail(
      next,
      "seat-available",
      target,
      `${target} has changed from unavailable to available. Open Flex immediately.`,
      message.checkedAt,
      message.url
    );
  }
  return next;
}

async function handleNavigationStatus(message, tabId) {
  const watcher = await getWatcher();
  if (!watcher.enabled || watcher.tabId !== tabId) return watcher;

  if (watcher.activeFrameId !== null
      && watcher.activeFrameId !== message.frameId
      && message.status !== "ready") {
    return watcher;
  }

  const next = {
    ...watcher,
    url: message.url,
    activeFrameId: message.status === "ready" ? message.frameId : watcher.activeFrameId,
    navigation: {
      status: message.status,
      attemptedAt: message.checkedAt,
      detail: message.detail,
      source: message.source
    }
  };
  await saveWatcher(next);
  return next;
}

async function handleRegistrationStarted(message, tabId) {
  const watcher = await getWatcher();
  if (!watcher.enabled || watcher.tabId !== tabId || !watcher.autoRegister) return watcher;
  if (watcher.registration.phase !== "idle") return watcher;

  const next = {
    ...watcher,
    checkedAt: message.checkedAt,
    url: message.url,
    registration: {
      phase: "attempting",
      target: message.target,
      attemptedAt: message.checkedAt,
      completedAt: null,
      detail: null
    },
    error: null
  };
  await saveWatcher(next);
  return next;
}

async function handleRegistrationSuccess(message, tabId) {
  const watcher = await getWatcher();
  if (!watcher.enabled || watcher.tabId !== tabId) return watcher;
  if (watcher.registration.target !== message.target) return watcher;

  await chrome.alarms.clear(ALARM_NAME);
  const next = {
    ...watcher,
    enabled: false,
    autoRegister: false,
    checkedAt: message.checkedAt,
    url: message.url,
    openTargets: [],
    registration: {
      ...watcher.registration,
      phase: "success",
      completedAt: message.checkedAt,
      detail: "Verified under Already Registered Courses."
    },
    error: null
  };
  await saveWatcher(next);
  await notifyRegistration("success", message.target);
  await sendConfiguredEmail(
    next,
    "registration-success",
    message.target,
    next.registration.detail,
    message.checkedAt,
    message.url
  );
  return next;
}

async function handleRegistrationError(message, tabId) {
  const watcher = await getWatcher();
  if (!watcher.enabled || watcher.tabId !== tabId) return watcher;
  if (watcher.registration.phase === "success" || watcher.registration.phase === "error") return watcher;

  const next = {
    ...watcher,
    autoRegister: false,
    checkedAt: message.checkedAt,
    url: message.url,
    registration: {
      ...watcher.registration,
      phase: "error",
      target: message.target || watcher.registration.target,
      completedAt: message.checkedAt,
      detail: message.detail || "Flex could not complete registration."
    },
    error: "Automatic registration stopped. Please register manually."
  };
  await saveWatcher(next);
  await notifyRegistration("error", next.registration.target, next.registration.detail);
  await sendConfiguredEmail(
    next,
    "registration-error",
    next.registration.target,
    next.registration.detail,
    message.checkedAt,
    message.url
  );
  return next;
}

async function handleAutoLoginAttempt(message, tabId) {
  const watcher = await getWatcher();
  if (!watcher.enabled || watcher.tabId !== tabId || !watcher.autoLogin) return watcher;

  const next = {
    ...watcher,
    signedOut: false,
    autoLoginStatus: "attempting",
    autoLoginAttemptedAt: message.checkedAt,
    checkedAt: message.checkedAt,
    url: message.url,
    error: null
  };
  await saveWatcher(next);
  return next;
}

chrome.runtime.onInstalled.addListener(async () => {
  await initializeExtensionState();
});

chrome.runtime.onStartup.addListener(initializeExtensionState);
initializeExtensionState();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) reloadWatchedTab();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const watcher = await getWatcher();
  if (watcher.enabled && watcher.tabId === tabId) {
    await chrome.alarms.clear(ALARM_NAME);
    await saveWatcher({
      ...watcher,
      enabled: false,
      tabId: null,
      openTargets: [],
      error: "The watched Flex tab was closed."
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  (async () => {
    const watcher = await getWatcher();
    if (!watcher.enabled || watcher.tabId !== tabId) return;
    setTimeout(() => requestAvailableCourses(tabId, "load-complete"), 500);
    setTimeout(() => requestAvailableCourses(tabId, "delayed-retry"), 3000);
  })();
});

chrome.notifications.onClicked.addListener(focusWatchedTab);
chrome.notifications.onButtonClicked.addListener(focusWatchedTab);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === "GET_STATE") return getWatcher();
    if (message.type === "START") return startWatcher(message);
    if (message.type === "STOP") return stopWatcher();
    if (message.type === "TEST_EMAIL") return testEmailWebhook(message);
    if (message.type === "BEGIN_CALIBRATION") return beginCoordinateCalibration(message);
    if (message.type === "SCAN_NOW") {
      await reloadWatchedTab();
      return getWatcher();
    }
    if (message.type === "PAGE_SCAN" && sender.tab) {
      return handlePageScan({ ...message, frameId: sender.frameId ?? 0 }, sender.tab.id);
    }
    if (message.type === "CALIBRATION_SAVED" && sender.tab) {
      return handleCalibrationSaved(message, sender.tab.id, sender.frameId ?? 0);
    }
    if (message.type === "NATIVE_NAVIGATION_REQUEST" && sender.tab) {
      return handleNativeNavigationRequest(message, sender.tab.id, sender.frameId ?? 0);
    }
    if (message.type === "AUTO_LOGIN_ATTEMPTED" && sender.tab) {
      return handleAutoLoginAttempt(message, sender.tab.id);
    }
    if (message.type === "REGISTRATION_STARTED" && sender.tab) {
      return handleRegistrationStarted(message, sender.tab.id);
    }
    if (message.type === "REGISTRATION_SUCCESS" && sender.tab) {
      return handleRegistrationSuccess(message, sender.tab.id);
    }
    if (message.type === "REGISTRATION_ERROR" && sender.tab) {
      return handleRegistrationError(message, sender.tab.id);
    }
    if (message.type === "NAVIGATION_STATUS" && sender.tab) {
      return handleNavigationStatus({ ...message, frameId: sender.frameId ?? 0 }, sender.tab.id);
    }
    return null;
  })()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
