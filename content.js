(function () {
  "use strict";

  const AUTO_LOGIN_ATTEMPT_KEY = "flexSeatWatcherAutoLoginAttempted";
  const REGISTRATION_ATTEMPT_KEY = "flexSeatWatcherRegistrationAttempt";
  const AUTO_LOGIN_GRACE_MS = 8000;
  const VERIFY_DELAY_MS = 3000;
  const VERIFY_TIMEOUT_MS = 20000;
  const CALIBRATION_OVERLAY_ID = "flex-seat-watcher-calibration-overlay";
  const contentStartedAt = Date.now();
  let lastSignature = "";
  let scanTimer;
  let navigationLockedUntil = 0;
  let actionInProgress = false;
  let observer;
  let scanInterval;
  let stopped = false;
  let lastNavigationDetail = null;

  function stopContentScript() {
    stopped = true;
    clearTimeout(scanTimer);
    clearInterval(scanInterval);
    observer?.disconnect();
  }

  function isInvalidatedContext(error) {
    return /extension context invalidated/i.test(String(error?.message || error));
  }

  function isEnabled(element) {
    return !element.disabled && element.getAttribute("aria-disabled") !== "true";
  }

  function isVisible(element) {
    return Boolean(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));
  }

  function controlText(element) {
    return [
      element.textContent,
      element.value,
      element.title,
      element.getAttribute("aria-label")
    ].join(" ");
  }

  function deepRoots() {
    const roots = [];
    const visited = new Set();
    const pending = [document];

    while (pending.length) {
      const root = pending.shift();
      if (!root || visited.has(root)) continue;
      visited.add(root);
      roots.push(root);

      let elements = [];
      try {
        elements = Array.from(root.querySelectorAll("*"));
      } catch {
        continue;
      }

      for (const element of elements) {
        if (element.shadowRoot) pending.push(element.shadowRoot);
        if (/^(iframe|frame)$/i.test(element.tagName)) {
          try {
            if (element.contentDocument) pending.push(element.contentDocument);
          } catch {
            // Cross-origin frames receive their own content script when their NU URL is permitted.
          }
        }
      }
    }

    return roots;
  }

  function deepQueryAll(selector) {
    const matches = [];
    const visited = new Set();
    for (const root of deepRoots()) {
      let elements = [];
      try {
        elements = Array.from(root.querySelectorAll(selector));
      } catch {
        continue;
      }
      for (const element of elements) {
        if (!visited.has(element)) {
          visited.add(element);
          matches.push(element);
        }
      }
    }
    return matches;
  }

  function deepPageContains(label) {
    const wanted = FlexSeatScanner.normalize(label);
    return deepRoots().some((root) => {
      const text = root.body?.innerText || root.textContent || "";
      return FlexSeatScanner.normalize(text).includes(wanted);
    });
  }

  function frameDiagnostic() {
    const frames = deepQueryAll("iframe, frame");
    if (!frames.length) return "no frames detected";
    const states = frames.map((frame) => {
      let host = "inline";
      try {
        const source = frame.getAttribute("src");
        host = source ? (new URL(source, location.href).hostname || "inline") : "inline";
      } catch {
        host = "unknown-host";
      }
      let accessible = false;
      try {
        accessible = Boolean(frame.contentDocument);
      } catch {
        accessible = false;
      }
      return `${host} ${accessible ? "readable" : "locked"}`;
    });
    return `${frames.length} frame(s): ${states.join(", ")}`;
  }

  function beginCoordinateCalibration() {
    if (window.top !== window) return false;
    document.getElementById(CALIBRATION_OVERLAY_ID)?.remove();

    const overlay = document.createElement("div");
    overlay.id = CALIBRATION_OVERLAY_ID;
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      cursor: "crosshair",
      background: "rgba(11, 119, 197, 0.06)"
    });

    const instruction = document.createElement("div");
    instruction.textContent = "Click the visible Available Courses tab once. Press Esc to cancel.";
    Object.assign(instruction.style, {
      position: "fixed",
      left: "50%",
      bottom: "24px",
      transform: "translateX(-50%)",
      padding: "12px 18px",
      borderRadius: "10px",
      background: "#17324a",
      color: "white",
      font: "600 14px system-ui, sans-serif",
      boxShadow: "0 8px 24px rgba(0,0,0,.28)",
      pointerEvents: "none"
    });
    overlay.appendChild(instruction);

    const cancel = (event) => {
      if (event.key !== "Escape") return;
      overlay.remove();
      document.removeEventListener("keydown", cancel, true);
    };
    document.addEventListener("keydown", cancel, true);

    overlay.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      overlay.remove();
      document.removeEventListener("keydown", cancel, true);
      await send({
        type: "CALIBRATION_SAVED",
        xRatio: event.clientX / viewportWidth,
        yRatio: event.clientY / viewportHeight,
        viewportWidth,
        viewportHeight,
        checkedAt: new Date().toISOString(),
        url: location.href
      }).catch(() => {});
    }, { once: true, capture: true });

    document.documentElement.appendChild(overlay);
    return true;
  }

  async function tryNativeNavigation(watcher, source) {
    if (window.top !== window) return { clicked: false };
    return send({
      type: "NATIVE_NAVIGATION_REQUEST",
      label: "Available Courses",
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      source,
      checkedAt: new Date().toISOString(),
      url: location.href
    }).catch((error) => ({ clicked: false, detail: error.message }));
  }

  function describeRow(row) {
    const choice = Array.from(row.querySelectorAll('input[type="checkbox"], input[type="radio"]'))
      .some(isEnabled);
    const registerAction = Array.from(row.querySelectorAll("button, input, a"))
      .some((element) => isEnabled(element)
        && /\bregister\b/.test(FlexSeatScanner.normalize(controlText(element))));
    const sectionSelect = Array.from(row.querySelectorAll("select")).some((select) => {
      if (!isEnabled(select)) return false;
      return Array.from(select.options).some((option) => {
        const value = `${option.value} ${option.textContent}`.trim();
        return !option.disabled && value && !/select|choose/i.test(value);
      });
    });

    return {
      text: row.textContent || "",
      hasEnabledRegisterControl: choice || registerAction,
      hasSectionSelect: sectionSelect
    };
  }

  function isSignedOut() {
    return /\/login\/?$/i.test(location.pathname) || Boolean(deepQueryAll('input[type="password"]')[0]);
  }

  function findUsernameInput(passwordInput) {
    const form = passwordInput.closest("form") || document;
    return form.querySelector([
      'input[autocomplete="username"]',
      'input[name*="roll" i]',
      'input[id*="roll" i]',
      'input[type="text"]',
      'input:not([type])'
    ].join(", "));
  }

  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (response && response.ok === false) throw new Error(response.error);
    return response?.result;
  }

  async function tryAutomaticLogin(watcher) {
    if (!watcher.autoLogin) return "disabled";
    if (sessionStorage.getItem(AUTO_LOGIN_ATTEMPT_KEY)) return "already-attempted";

    const passwordInput = deepQueryAll('input[type="password"]')[0];
    if (!passwordInput) return "waiting";
    const usernameInput = findUsernameInput(passwordInput);
    const form = passwordInput.closest("form");
    const submitControl = (form || document).querySelector([
      'button[type="submit"]',
      'input[type="submit"]',
      'button:not([type])'
    ].join(", "));
    const browserFilledCredentials = Boolean(
      usernameInput?.value.trim() && passwordInput.value && submitControl && isEnabled(submitControl)
    );

    if (!browserFilledCredentials) {
      return Date.now() - contentStartedAt < AUTO_LOGIN_GRACE_MS ? "waiting" : "not-filled";
    }

    sessionStorage.setItem(AUTO_LOGIN_ATTEMPT_KEY, new Date().toISOString());
    await send({
      type: "AUTO_LOGIN_ATTEMPTED",
      checkedAt: new Date().toISOString(),
      url: location.href
    }).catch(() => {});
    submitControl.click();
    return "submitted";
  }

  function findPortalTab(label) {
    const wanted = FlexSeatScanner.normalize(label);
    const interactiveSelector = [
      "a",
      "button",
      'input[type="button"]',
      'input[type="submit"]',
      '[role="tab"]',
      '[data-toggle="tab"]',
      '[data-bs-toggle="tab"]',
      "[onclick]",
      "li",
      "label"
    ].join(", ");
    const matchesLabel = (element) => {
      const text = FlexSeatScanner.normalize(controlText(element));
      return isEnabled(element) && text.startsWith(wanted);
    };
    let textCandidates = deepQueryAll([
      interactiveSelector,
      "span",
      "div",
      ".nav-link",
      ".nav-item",
      "[value]",
      "[title]",
      "[aria-label]"
    ].join(", ")).filter(matchesLabel);

    if (!textCandidates.length) {
      textCandidates = deepQueryAll("*").filter(matchesLabel);
    }

    textCandidates.sort((left, right) => {
      const leftText = FlexSeatScanner.normalize(controlText(left));
      const rightText = FlexSeatScanner.normalize(controlText(right));
      return Number(isVisible(right)) - Number(isVisible(left))
        || Number(rightText === wanted) - Number(leftText === wanted)
        || leftText.length - rightText.length;
    });

    for (const candidate of textCandidates) {
      const control = candidate.matches(interactiveSelector)
        ? candidate
        : candidate.closest(interactiveSelector) || candidate;
      if (isEnabled(control)) return control;
    }

    const attributeWord = wanted.includes("available") ? "available" : "registered";
    const attributeCandidate = deepQueryAll([
      `[id*="${attributeWord}" i]`,
      `[href*="${attributeWord}" i]`,
      `[data-target*="${attributeWord}" i]`,
      `[aria-controls*="${attributeWord}" i]`
    ].join(", ")).find(isVisible);
    if (!attributeCandidate) return null;
    return attributeCandidate.matches(interactiveSelector)
      ? attributeCandidate
      : attributeCandidate.closest(interactiveSelector);
  }

  function isPortalTabActive(tab) {
    return Boolean(tab && (
      tab.getAttribute("aria-selected") === "true"
      || /active|selected/i.test(tab.className)
      || /active|selected/i.test(tab.parentElement?.className || "")
    ));
  }

  function clickPortalTab(label) {
    if (Date.now() < navigationLockedUntil) return false;
    const tab = findPortalTab(label);
    if (!tab) {
      const pageContainsLabel = deepPageContains(label);
      const frameName = window.top === window ? "top page" : "embedded frame";
      lastNavigationDetail = `Could not find the ${label} control from this ${frameName}; deep page text: ${pageContainsLabel ? "yes" : "no"}; ${frameDiagnostic()}.`;
      return false;
    }
    navigationLockedUntil = Date.now() + 1200;
    lastNavigationDetail = `${tab.tagName.toLowerCase()}#${tab.id || "(no-id)"}.${String(tab.className || "").trim() || "(no-class)"}`;
    tab.click();
    setTimeout(scan, 800);
    return true;
  }

  async function ensureAvailableCourses(watcher, source) {
    const availableRowsPresent = (watcher.targets || []).some(looksLikeAvailableCourseRow);
    if (availableRowsPresent) {
      await send({
        type: "NAVIGATION_STATUS",
        status: "ready",
        detail: "Available Courses rows are visible.",
        source,
        checkedAt: new Date().toISOString(),
        url: location.href
      }).catch(() => {});
      return true;
    }

    let clicked = clickPortalTab("Available Courses");
    let nativeResult = null;
    if (!clicked) {
      nativeResult = await tryNativeNavigation(watcher, source);
      clicked = Boolean(nativeResult?.clicked);
      if (nativeResult?.detail) lastNavigationDetail = nativeResult.detail;
    }
    await send({
      type: "NAVIGATION_STATUS",
      status: nativeResult?.resultsFound ? "ready" : clicked ? "clicked" : "not-found",
      detail: nativeResult?.resultsFound
        ? "Available Courses rows were read through Chrome's native page inspection."
        : lastNavigationDetail,
      source,
      checkedAt: new Date().toISOString(),
      url: location.href
    }).catch(() => {});
    return clicked;
  }

  function findTargetRow(target) {
    const wanted = FlexSeatScanner.normalize(target);
    return deepQueryAll("tr")
      .find((row) => isVisible(row) && FlexSeatScanner.normalize(row.textContent).includes(wanted));
  }

  function looksLikeAvailableCourseRow(target) {
    const row = findTargetRow(target);
    if (!row) return false;
    const text = FlexSeatScanner.normalize(row.textContent);
    return text.includes("not registered")
      || text.includes("no seats available")
      || text.includes("sections full")
      || Boolean(findRegisterControl(row));
  }

  function findRegisterControl(row) {
    const choice = Array.from(row.querySelectorAll('input[type="checkbox"], input[type="radio"]'))
      .find((element) => isEnabled(element) && isVisible(element));
    if (choice) return choice;

    return Array.from(row.querySelectorAll("button, input, a"))
      .find((element) => isEnabled(element)
        && isVisible(element)
        && FlexSeatScanner.normalize(controlText(element)) === "register");
  }

  function findConfirmRegistrationControl() {
    return deepQueryAll("button, input, a")
      .find((element) => isEnabled(element)
        && isVisible(element)
        && FlexSeatScanner.normalize(controlText(element)).includes("confirm registration"));
  }

  function ensureSectionSelected(row) {
    const select = Array.from(row.querySelectorAll("select"))
      .find((element) => isEnabled(element) && isVisible(element));
    if (!select) return true;

    const current = select.options[select.selectedIndex];
    const validCurrent = current
      && !current.disabled
      && current.value
      && !/select|choose/i.test(`${current.value} ${current.textContent}`);
    if (validCurrent) return true;

    const option = Array.from(select.options).find((candidate) => candidate
      && !candidate.disabled
      && candidate.value
      && !/select|choose/i.test(`${candidate.value} ${candidate.textContent}`));
    if (!option) return false;
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function visiblePortalError() {
    const selectors = [
      '[role="alert"]',
      ".alert-danger",
      ".alert-error",
      ".toast-error",
      ".swal2-popup",
      ".bootbox"
    ];
    const candidates = deepQueryAll(selectors.join(", "))
      .filter(isVisible);
    const error = candidates.find((element) => /error|failed|unable|cannot|not allowed|clash|limit|full|prerequisite/i
      .test(element.textContent || ""));
    return error ? (error.textContent || "Registration failed").trim().replace(/\s+/g, " ").slice(0, 240) : null;
  }

  async function reportRegistrationError(target, detail) {
    await send({
      type: "REGISTRATION_ERROR",
      target,
      detail,
      checkedAt: new Date().toISOString(),
      url: location.href
    }).catch(() => {});
  }

  async function attemptRegistration(watcher, target) {
    if (actionInProgress) return;
    const attemptId = `${watcher.runId}:${FlexSeatScanner.normalize(target)}`;
    if (sessionStorage.getItem(REGISTRATION_ATTEMPT_KEY) === attemptId) return;

    actionInProgress = true;
    try {
      const row = findTargetRow(target);
      if (!row) throw new Error("The available course row disappeared before it could be selected.");
      const registerControl = findRegisterControl(row);
      if (!registerControl) throw new Error("A seat appeared, but the Register control could not be selected.");
      if (!ensureSectionSelected(row)) throw new Error("A seat appeared, but no selectable section was found.");
      const confirmControl = findConfirmRegistrationControl();
      if (!confirmControl) throw new Error("The Confirm Registration button could not be found.");

      sessionStorage.setItem(REGISTRATION_ATTEMPT_KEY, attemptId);
      await send({
        type: "REGISTRATION_STARTED",
        target,
        checkedAt: new Date().toISOString(),
        url: location.href
      });

      if ("checked" in registerControl && !registerControl.checked) registerControl.click();
      else if (!("checked" in registerControl)) registerControl.click();

      if ("checked" in registerControl && !registerControl.checked) {
        throw new Error("Flex did not accept the Register selection.");
      }

      setTimeout(() => {
        const liveConfirm = findConfirmRegistrationControl();
        if (liveConfirm && isEnabled(liveConfirm) && isVisible(liveConfirm)) {
          liveConfirm.click();
          setTimeout(scan, 1000);
        } else {
          reportRegistrationError(target, "The Confirm Registration button became unavailable.");
        }
      }, 350);
    } catch (error) {
      await reportRegistrationError(target, error.message);
    } finally {
      actionInProgress = false;
    }
  }

  async function driveRegistrationVerification(watcher) {
    const registration = watcher.registration || {};
    const target = registration.target;
    if (!target) return false;

    const portalError = visiblePortalError();
    if (portalError) {
      await reportRegistrationError(target, portalError);
      return true;
    }

    const row = findTargetRow(target);
    const rowText = FlexSeatScanner.normalize(row?.textContent);
    if (row && rowText.includes("registered") && !rowText.includes("not registered")) {
      sessionStorage.removeItem(REGISTRATION_ATTEMPT_KEY);
      await send({
        type: "REGISTRATION_SUCCESS",
        target,
        checkedAt: new Date().toISOString(),
        url: location.href
      }).catch(() => {});
      return true;
    }

    const attemptedAt = Date.parse(registration.attemptedAt || "") || Date.now();
    const age = Date.now() - attemptedAt;
    if (age < VERIFY_DELAY_MS) {
      setTimeout(scan, VERIFY_DELAY_MS - age + 150);
      return true;
    }

    const registeredTab = findPortalTab("Already Registered Courses");
    const registeredTabActive = isPortalTabActive(registeredTab);
    if (!registeredTabActive && clickPortalTab("Already Registered Courses")) return true;

    if (age >= VERIFY_TIMEOUT_MS) {
      await reportRegistrationError(
        target,
        "Flex did not show the course under Already Registered Courses after confirmation. Please register manually."
      );
      return true;
    }

    setTimeout(scan, 1200);
    return true;
  }

  async function emitPageScan(signedOut, results) {
    const checkedAt = new Date().toISOString();
    const message = {
      type: "PAGE_SCAN",
      signedOut,
      results,
      url: location.href,
      checkedAt
    };
    const signature = JSON.stringify({ signedOut, results, url: location.href });
    if (signature !== lastSignature) {
      lastSignature = signature;
      await send(message).catch(() => {});
    }
  }

  async function runScan() {
    if (actionInProgress) return;
    const stored = await chrome.storage.local.get("watcher");
    const watcher = stored.watcher;
    if (!watcher || !watcher.enabled) return;

    const signedOut = isSignedOut();
    if (signedOut) {
      const autoLoginState = await tryAutomaticLogin(watcher);
      if (autoLoginState === "waiting") {
        setTimeout(scan, 1000);
        return;
      }
      if (autoLoginState === "submitted") return;
      await emitPageScan(true, []);
      return;
    }

    sessionStorage.removeItem(AUTO_LOGIN_ATTEMPT_KEY);

    if (["attempting", "verifying"].includes(watcher.registration?.phase)) {
      await driveRegistrationVerification(watcher);
      return;
    }

    const availableRowsPresent = (watcher.targets || []).some(looksLikeAvailableCourseRow);
    if (!availableRowsPresent) {
      if (!await ensureAvailableCourses(watcher, "page-scan")) {
        await emitPageScan(false, (watcher.targets || []).map((target) => ({
          target,
          found: false,
          available: false,
          state: "not-found"
        })));
      }
      return;
    }

    const rows = deepQueryAll("tr").map(describeRow);
    const results = FlexSeatScanner.scanRows(rows, watcher.targets || []);
    await emitPageScan(false, results);

    if (watcher.autoRegister && watcher.registration?.phase === "idle") {
      const preferred = FlexSeatScanner.choosePreferredTarget(results, watcher.autoRegisterTargets || []);
      if (preferred) await attemptRegistration(watcher, preferred.target);
    }
  }

  async function scan() {
    if (stopped) return;
    try {
      await runScan();
    } catch (error) {
      if (isInvalidatedContext(error)) {
        stopContentScript();
        return;
      }
      console.error("Flex Seat Watcher scan failed:", error);
    }
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 600);
  }

  scan();
  observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  scanInterval = setInterval(scan, 10000);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "BEGIN_COORDINATE_CALIBRATION") {
      sendResponse({ ok: true, result: beginCoordinateCalibration() });
      return false;
    }
    if (message.type !== "OPEN_AVAILABLE_COURSES") return false;
    (async () => {
      const stored = await chrome.storage.local.get("watcher");
      if (!stored.watcher?.enabled) return false;
      return ensureAvailableCourses(stored.watcher, message.source || "background");
    })()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => {
        if (isInvalidatedContext(error)) stopContentScript();
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  });
})();
