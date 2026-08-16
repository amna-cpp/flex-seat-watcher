const FLEX_EMAIL_RECIPIENT = "you@example.com";
const FLEX_EMAIL_SECRET = "replace-with-the-same-secret-used-in-config.js";

function jsonResponse_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return jsonResponse_({ ok: true, service: "Flex Seat Watcher email webhook" });
}

function doPost(event) {
  try {
    const payload = JSON.parse(event.postData.contents || "{}");
    if (payload.secret !== FLEX_EMAIL_SECRET) {
      return jsonResponse_({ ok: false, error: "Unauthorized" });
    }

    const subjects = {
      "test": "Flex Seat Watcher test email",
      "seat-available": `Flex seat available: ${payload.target || "target course"}`,
      "registration-success": `Flex registration confirmed: ${payload.target || "course"}`,
      "registration-error": `Manual Flex registration needed: ${payload.target || "course"}`
    };
    const subject = subjects[payload.event];
    if (!subject) return jsonResponse_({ ok: false, error: "Unsupported event" });

    const lines = [
      payload.detail || "Flex Seat Watcher sent an update.",
      "",
      `Course: ${payload.target || "N/A"}`,
      `Event: ${payload.event}`,
      `Checked at: ${payload.checkedAt || new Date().toISOString()}`,
      `Flex page: ${payload.url || "https://flexstudent.nu.edu.pk"}`
    ];

    MailApp.sendEmail({
      to: FLEX_EMAIL_RECIPIENT,
      subject,
      body: lines.join("\n"),
      name: "Flex Seat Watcher"
    });
    return jsonResponse_({ ok: true });
  } catch (error) {
    return jsonResponse_({ ok: false, error: String(error && error.message || error) });
  }
}
