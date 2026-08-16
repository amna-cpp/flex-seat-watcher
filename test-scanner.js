"use strict";

const assert = require("node:assert/strict");
const { choosePreferredTarget, scanRows } = require("./scanner.js");

const targets = ["Multiagent Systems", "Edge Computing"];

assert.deepEqual(
  scanRows([
    { text: "AI402-Multiagent Systems and Game Theory No Seats Available Sections Full" },
    { text: "AI409-Edge Computing and Intelligent Systems No Seats Available Sections Full" }
  ], targets).map((result) => result.state),
  ["full", "full"]
);

assert.deepEqual(
  scanRows([
    {
      text: "AI402-Multiagent Systems and Game Theory Not Registered Register",
      hasEnabledRegisterControl: true,
      hasSectionSelect: true
    },
    { text: "AI409-Edge Computing and Intelligent Systems Sections Full" }
  ], targets).map((result) => result.state),
  ["available", "full"]
);

assert.equal(
  scanRows([{ text: "CY4054-Unlisted Elective" }], targets)[0].state,
  "not-found"
);

assert.equal(
  choosePreferredTarget([
    { target: "Multiagent Systems", available: true },
    { target: "Edge Computing", available: true }
  ]).target,
  "Edge Computing"
);

assert.equal(
  choosePreferredTarget([
    { target: "Multiagent Systems", available: true },
    { target: "Edge Computing", available: false }
  ]).target,
  "Multiagent Systems"
);

assert.equal(
  choosePreferredTarget(
    [{ target: "Unlisted Course", available: true }],
    ["Multiagent Systems", "Edge Computing"]
  ),
  null
);

console.log("Scanner tests passed.");
