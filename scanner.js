(function (root) {
  "use strict";

  const CLOSED_PATTERNS = [
    "no seat available",
    "no seats available",
    "section full",
    "sections full"
  ];

  const OPEN_PATTERNS = [
    "seat available",
    "seats available",
    "vacant seat",
    "vacant seats"
  ];

  function normalize(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function evaluateRow(row) {
    const text = normalize(row.text);
    const explicitlyClosed = CLOSED_PATTERNS.some((pattern) => text.includes(pattern));
    const explicitlyOpen = OPEN_PATTERNS.some((pattern) => text.includes(pattern));
    const actionable = Boolean(row.hasEnabledRegisterControl || row.hasSectionSelect);

    return {
      available: !explicitlyClosed && (actionable || explicitlyOpen),
      explicitlyClosed,
      actionable
    };
  }

  function scanRows(rows, targets) {
    return targets.map((target) => {
      const normalizedTarget = normalize(target);
      const matchingRows = rows.filter((row) => normalize(row.text).includes(normalizedTarget));
      const evaluated = matchingRows.map(evaluateRow);
      const available = evaluated.some((result) => result.available);

      return {
        target,
        found: matchingRows.length > 0,
        available,
        state: available ? "available" : matchingRows.length ? "full" : "not-found"
      };
    });
  }

  function choosePreferredTarget(results, allowedTargets) {
    const allowed = (allowedTargets || []).map(normalize);
    const available = results.filter((result) => {
      if (!result.available) return false;
      if (!allowed.length) return true;
      const target = normalize(result.target);
      return allowed.some((candidate) => target.includes(candidate) || candidate.includes(target));
    });
    return available.find((result) => normalize(result.target).includes("edge computing"))
      || available[0]
      || null;
  }

  const api = { normalize, evaluateRow, scanRows, choosePreferredTarget };
  root.FlexSeatScanner = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
