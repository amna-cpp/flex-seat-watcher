# Flex Seat Watcher

A local Microsoft Edge/Chrome extension that watches selected course rows on the authenticated Flex registration page. It refreshes only the chosen Flex tab, opens **Available Courses** after Flex resets to **Student Info**, checks for an enabled registration control or section selector, and shows a desktop notification when a target course changes from full to potentially available.

It does **not** store your roll number or password or send page data anywhere. Optional automatic sign-in relies on your browser's password manager. Optional automatic registration is separately armed by you and is limited to one attempt per watcher run.

## Install in Microsoft Edge

1. Open `edge://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked**.
4. Select the folder where you cloned or downloaded this repository.
5. Pin **Flex Seat Watcher** from Edge's Extensions menu.

After clicking **Reload** on an already installed unpacked extension, refresh the open Flex page once. Chrome/Edge otherwise leaves the previous page's content script detached from the newly loaded extension.

## Use it

1. Sign in at <https://flexstudent.nu.edu.pk>.
2. Go to **Course Registration → Available Courses** and keep that tab open.
3. Click the extension icon.
4. Keep the default course names (`Multiagent Systems` and `Edge Computing`) or edit them.
5. Choose a refresh interval.
6. Optionally enable **Automatic sign-in** after following the setup below.
7. Optionally enable **Automatically register**. Read and approve the confirmation carefully.
8. Click **Start watching this tab** and allow browser notifications if macOS asks.

With automatic registration off, click the seat notification, select/register the course, and press **Confirm Registration** yourself.

With automatic registration on:

1. If only one eligible target—Multiagent or Edge Computing—is available, that course is selected.
2. If both eligible targets are available, **Edge Computing** is selected.
3. The extension chooses the available row's current/first valid section, ticks **Register**, and presses **Confirm Registration** once.
4. It opens **Already Registered Courses** and verifies that the chosen course appears with status **Registered**.
5. A verified registration stops the watcher and displays a `DONE` badge and desktop notification.
6. A portal error, missing control, or failed verification disables automatic registration, displays an `ERR` badge, and sends a desktop notification asking you to register manually.

## Set up automatic sign-in safely

1. Open your browser's password manager settings.
2. Turn on password saving and autofill.
3. Sign in to Flex manually once and accept your browser's prompt to save the login.
4. Return to **Available Courses**, open the extension, and enable **Automatic sign-in**.

If Flex logs out, the extension waits for the browser to autofill the saved roll number and password, verifies that both fields are non-empty, then presses **Sign In**. It never copies, transmits, or stores either credential value. It makes only one automatic attempt per logout, preventing a wrong saved password from being submitted repeatedly. If the browser requires macOS Touch ID/device authentication, you will need to approve that prompt.

## Email notifications

Version 1.5.2 can email your configured address when a target seat changes to available, when registration is verified, or when automatic registration fails and needs manual action. It uses the send-only Google Apps Script `MailApp` service; no Gmail password is stored in the extension.

1. Copy `config.local.example.js` to `config.local.js`.
2. In `config.local.js`, set your recipient email and replace the example secret with a long random value.
3. Open <https://script.google.com> while signed into the Gmail account that should send the alerts.
4. Choose **New project** and paste the contents of `email-webhook.example.gs` into the editor.
5. Replace its example recipient and secret. The secret must exactly match `config.local.js`.
6. Choose **Deploy → New deployment**, then choose **Web app**.
7. Set **Execute as** to **Me** and **Who has access** to **Anyone**.
8. Choose **Deploy**, approve the send-email authorization, and copy the deployed URL ending in `/exec`.
9. Add that URL to `defaultEmailWebhook` in `config.local.js`, then reload the extension.
10. In the popup, choose **Save and send test email**. Confirm the test arrives, keep **Email alerts** checked, and start the watcher.

The private `config.local.js` and `email-webhook.gs` files are ignored by Git. The repository contains only safe examples. The webhook accepts only requests containing the token shared between your local extension and Apps Script. If that token is exposed, replace it in both places and redeploy the script.

## Important limitations

- The browser must remain open and the computer must stay awake.
- If automatic sign-in is off or the browser cannot autofill, the extension alerts you when it reaches the login page.
- The shortest interval is one minute to avoid putting unnecessary load on the university portal.
- Flex may change its page markup. The checker deliberately uses the visible course text and registration controls rather than fixed table-column numbers, but re-check the extension if the portal is redesigned.
- A native confirmation dialog, CAPTCHA, device-authentication prompt, or portal redesign can require manual action.
- Follow your university's portal rules. This tool does not bypass capacity or registration controls.

### “Extension context invalidated”

This can be recorded when an unpacked extension is reloaded while an older Flex page is still open. Version 1.3.1 and later shut the stale script down quietly. Refresh the Flex page once after reloading the extension, then start the watcher again.

Version 1.3.2 and later also request **Available Courses** after the watched tab reports that each refresh is complete, then retry three seconds later in case Flex resets its tabs asynchronously. The popup displays **Opening** or **Not found** for this navigation step when useful.

Version 1.3.3 recognizes link-, button-, input-, and script-backed Flex tabs. It also runs in embedded registration frames and prevents an outer frame's **Not found** result from overwriting a successful inner-frame scan.

Version 1.3.4 searches through same-origin frames and open component roots from the top page, and permits content-script injection only on HTTPS subdomains belonging to `nu.edu.pk`. This covers Flex layouts whose visible registration controls are not children of the outer document.

Version 1.4.0 adds an optional native Chrome fallback. It first uses Chrome's debugging interface to locate the visible **Available Courses** label across encapsulated page content and issue a real mouse click. If Chrome still cannot expose that label, **Teach Available Courses position** places a temporary overlay so the user can save a normalized click location. The fallback is restricted to the watched Flex tab and detaches immediately after each inspection.

Version 1.4.1 removes the temporary Blockchain test course. Existing saved settings are migrated back to only Multiagent Systems and Edge Computing.

Version 1.5.0 adds authenticated email alerts through a user-deployed Google Apps Script web app. Email delivery is triggered only on a new seat-available transition, verified registration success, or registration failure requiring manual action.

Version 1.5.1 preconfigures the current Apps Script deployment URL and reports a clear reload instruction if a newly opened popup is still connected to an older background worker.

Version 1.5.2 moves the email address, webhook URL, and shared secret into ignored local configuration so the extension can be published without exposing private notification credentials.

## Quick test

With Node.js installed, run:

```sh
node test-scanner.js
```

`test-registration-fixture.html` is a local Flex imitation used to verify the automatic navigation, registration, success-verification, and portal-error paths without touching the real portal.
