# Gmail with Google Apps Script

Use **Sign in with Google** when available. Apps Script is an additional connection method for Workspace accounts whose administrators allow user-created scripts and Gmail access but block Lou's external OAuth application. It respects Google's permission decisions; it cannot override administrator restrictions.

## Connect

1. Open **Settings → Integrations → Manage integrations** (or **Accounts**).
2. Choose **Add Gmail → Connect using Google Apps Script**.
3. Choose **Open Google Apps Script**, sign into the intended Google account, and create a blank project.
4. Choose **Copy Script** in Lou, replace everything in `Code.gs`, and save. Keep the script private: it contains a credential scoped to this Lou Gmail integration.
5. Select `setupLou` in the function dropdown and press **Run**. Authorize the script's Gmail, external HTTPS requests, and scheduled trigger permissions. If Google or your administrator denies authorization, stop. Lou never asks for a Google password, cookie, or Google access/refresh token.
6. Return to Lou. The dialog automatically changes to **Connected** after the first successful synchronization. No deployment, Web App, Cloud project, Advanced Google Service, manifest edit, or connection-code round trip is required.

Lou's server must already have an internet-reachable HTTPS `LOU_PUBLIC_URL`; Google cannot call a server available only on localhost or a private LAN. This is server configuration, not something each Gmail user enters into their script. Google OAuth credentials are not required for this connection method.

## Daily use and limits

Both methods appear as Gmail accounts and use the same account selector, agent tools, approvals, event pipeline, and notification rules. A secondary **Connected via Apps Script** label identifies the method. New mail and Lou commands usually arrive within roughly one minute; busy triggers and Google's quotas can increase that delay. Lou waits up to two minutes for a queued command, so email requests may take longer than OAuth requests.

The script uses [GmailApp](https://developers.google.com/apps-script/reference/gmail/gmail-app), which searches **threads** rather than individual messages. Search returns bounded, newest message information from matching threads; other messages in a matching thread can also appear. Protocol search accepts a thread `offset` and a limit up to 50; `gmail.search` keeps Lou's existing limit of 10. Thread reads retain the existing six-message/6,000-character agent view. `gmail.read_message` supplies attachment metadata; `gmail.read_attachment` retrieves the selected attachment on demand. Transfers over 500 KB fail clearly; open those files in Gmail. No attachments are automatically uploaded during sync.

The first sync starts with the last 24 hours. Subsequent queries include both read and unread mail, a five-minute overlap, a fixed query window, and resumable thread/message pagination. Gmail message IDs deduplicate messages and events. The script keeps a bounded recent-message cache and rotates through it to detect older read/unread, star, archive, and label changes. This is incremental arrival monitoring and recent-state refresh, not a complete mirror or Gmail history feed. Arbitrarily old changes outside that cache are visible through live searches/reads.

Additional shared tools cover draft creation/update/send, forwarding, read/unread, archive/inbox/trash, star/unstar, and label add/remove. New mail and replies support plain text, HTML, CC, BCC for new mail, and small attachments. Mutations use Lou's ordinary approval policy. Newly authorized OAuth accounts request `gmail.modify` for mailbox changes; older OAuth connections may need to reconnect to grant that additional scope.

Google [installable triggers](https://developers.google.com/apps-script/guides/triggers/installable) can run every minute, but are not a delivery-time guarantee. [Apps Script and Gmail quotas](https://developers.google.com/apps-script/guides/services/quotas) apply, including daily trigger runtime and mail sending limits. A Workspace administrator can still disable Apps Script or refuse Gmail authorization. Google may reject authorization before any code executes; in that case Lou remains waiting, and the Google error appears in the script editor. Fix permissions with your administrator or disconnect; no workaround is attempted.

## Status, recovery, and disconnect

The account shows Connected, Syncing, Authorization required, useful connection errors, last successful sync, or **Script not running / stale connection** after five minutes without a heartbeat. **Test connection** queues a Gmail-access check for the next trigger; it does not directly invoke Apps Script. If the script has stopped, open its project and run `setupLou` again. It replaces only Lou's triggers in that project and syncs immediately.

**Regenerate script** resets the connection and immediately invalidates its old credential and outstanding commands. Replace `Code.gs` with the newly generated script and run `setupLou`. Lou cannot redisplay a stored secret: only its SHA-256 hash is kept on the server. Keep one installation per generated integration. Run `setupLou` again rather than installing duplicate copies.

**Disconnect** immediately revokes the integration credential and cancels queued commands. The next request from the old script is refused; the script removes its trigger when it receives that refusal. Already started Google operations cannot be recalled. To remove local configuration immediately, run `removeLou` in Apps Script as well. It deletes Lou's triggers and this installation's Script Properties, and never modifies or deletes email. Historical Lou events/cache follow the existing account retention behavior.

## Security and command reliability

Each installation gets a cryptographically random 256-bit bearer secret. HTTPS carries it in the Authorization header, redirects are disabled, and Lou stores only its SHA-256 hash. Normal account/status responses expose neither the secret nor its hash. The script contains no Lou admin key, database credential, OAuth client secret, or Google token. Installation authentication is isolated from device authentication: the credential cannot read other integrations, other owners, or general Lou resources.

Registration, sync, heartbeat, polling, claim, and result endpoints share the existing API process under `/api/integrations/gmail-appscript`. They validate the protocol and payloads, enforce request size/rate limits, and verify command ownership. Message upserts and event IDs are durable; command results accept duplicates without changing an already completed outcome. A lock prevents overlapping local syncs. Network calls retry at most three times with bounded exponential backoff; Gmail mutations do not retry.

Before executing **any** command, the script atomically claims its unique ID on Lou. A claimed command is never dispatched again, even to another copy of the script. Before a Gmail mutation, a local journal records that execution started. Small results, especially send IDs, are saved before reporting them and replayed until acknowledged. Approval IDs also deduplicate queued sends on the server. Sending drafts additionally checks a frozen draft fingerprint and refuses a draft changed since approval.

Apps Script/Gmail offer no transaction spanning Google's send operation and Lou's database. Therefore this adapter favors **at-most-once execution**: if a script stops after claiming or while sending, Lou reports an uncertain outcome instead of sending again. Check Gmail's Sent folder before approving another send. A lost claim response can mean the command never executes; a lost result response does not repeat an already successful send. Expired or interrupted commands fail after their deadline. Large read results that cannot fit in Script Properties are retried during that run and may fail if execution is interrupted.

## Manual end-to-end acceptance test

Use a Workspace test account whose administrator permits Apps Script and Gmail authorization. Automated tests exercise the server routes and generated JavaScript with built-in-service doubles; this test verifies actual Google authorization, triggers, Gmail behavior, and quotas.

1. Add Gmail via Apps Script in Lou.
2. Copy the generated script; verify the normal account list does not reveal its credential.
3. Paste it into a blank project's `Code.gs` under the intended account.
4. Save and run `setupLou`.
5. Approve Google's permissions. If denied, confirm setup stops and no workaround is offered.
6. Confirm Lou automatically reports Connected with the Gmail address and a last-sync timestamp; run setup again and verify exactly one Lou trigger exists.
7. Send the account an email, including a small attachment. Also send one and mark it read immediately.
8. Confirm Lou detects both within approximately one polling interval; rerun `louSync` and verify no duplicate message/event appears.
9. Search and read the email through Lou. Fetch attachment metadata, then content on demand.
10. Reply through Lou, reviewing and approving the reply.
11. Verify Gmail's Sent folder contains exactly one reply and Lou returns its message/thread IDs. Simulate a transient Lou outage after a send and verify rerunning sync does not send again.
12. Create and send a new email with CC/BCC, HTML, and a small attachment. Create, update, and send a draft; modify a draft after approval preparation and verify sending is refused. Test forward and reply-all.
13. Mark an email read/unread and star/unstar through Lou; confirm Gmail changes.
14. Archive it, move it back to inbox, and add/remove a label. Confirm both Gmail and Lou's recent-state refresh reflect the changes.
15. Disconnect in Lou. Also test regeneration on another installation and confirm its previous script is refused. Wait five minutes with a trigger disabled and confirm stale status.
16. Run the old script's `testLouConnection`; confirm authentication is refused. Run `removeLou` and verify triggers/properties are removed while emails remain intact. Confirm an OAuth Gmail account still works alongside the Apps Script account.
