/** Single Code.gs file: no web app, advanced service, manifest, or Google token export. */
export function generateGmailScript(server: string, integrationId: string, secret: string): string {
  return `// Generated specifically for your Lou Gmail integration. Do not share this script:
// it contains a credential that permits access to this Lou email integration.
const LOU_SERVER = ${JSON.stringify(server.replace(/\/$/, ""))};
const INTEGRATION_ID = ${JSON.stringify(integrationId)};
const INTEGRATION_SECRET = ${JSON.stringify(secret)};
const LOU_PROTOCOL_VERSION = 1;
` + String.raw`
function louProperties() { return PropertiesService.getScriptProperties(); }
function louKey(name) { return 'LOU_' + INTEGRATION_ID + '_' + name; }
function louConfig() {
  const value = louProperties().getProperty(louKey('config'));
  if (!value) throw new Error('Run setupLou first.');
  return JSON.parse(value);
}
// Only network requests are retried. Gmail mutations are NEVER retried.
function louRequest(path, payload) {
  const config = louConfig();
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = UrlFetchApp.fetch(config.server + '/api/integrations/gmail-appscript/' + path, {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        followRedirects: false, headers: { Authorization: 'Bearer ' + config.secret },
        payload: JSON.stringify(Object.assign({}, payload, { integrationId: config.id, protocolVersion: config.version }))
      });
    } catch (networkError) {
      if (attempt === 2) throw new Error('Cannot reach Lou. Check your Lou server URL and network.');
      Utilities.sleep(500 * Math.pow(2, attempt));
      continue;
    }
    const status = response.getResponseCode();
    let data;
    try { data = JSON.parse(response.getContentText()); } catch (_) { data = {}; }
    if (status >= 200 && status < 300) return data;
    if ((status === 429 || status >= 500) && attempt < 2) {
      Utilities.sleep(500 * Math.pow(2, attempt));
      continue;
    }
    const error = new Error((data.error && data.error.message) || 'Lou request failed (' + status + ').');
    error.status = status;
    throw error;
  }
}
function louSafeError(error) {
  return String(error && error.message || error).split(INTEGRATION_SECRET).join('[redacted]').slice(0, 1000);
}
function louDeleteTriggers() {
  // Only our handler in this project, never unrelated triggers or email.
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'louSync').forEach(t => ScriptApp.deleteTrigger(t));
}
function setupLou() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    louProperties().setProperty(louKey('config'), JSON.stringify({ server: LOU_SERVER, id: INTEGRATION_ID, secret: INTEGRATION_SECRET, version: LOU_PROTOCOL_VERSION }));
    louRequest('heartbeat', { state: 'syncing' });
    // Access must be permitted by your Google Workspace administrator.
    GmailApp.getInboxUnreadCount();
    const address = Session.getEffectiveUser().getEmail();
    louRequest('register', { address: address || undefined });
    louDeleteTriggers();
    ScriptApp.newTrigger('louSync').timeBased().everyMinutes(1).create();
  } catch (error) {
    louDeleteTriggers();
    try { louRequest('heartbeat', { state: /authoriz|permission|access denied/i.test(louSafeError(error)) ? 'authorization_required' : 'error', error: louSafeError(error) }); } catch (_) {}
    throw new Error(louSafeError(error));
  } finally { lock.releaseLock(); }
  louSync();
  console.log('Lou Gmail connected. Your mailbox will sync approximately every minute.');
  return 'Lou Gmail connected.';
}
function testLouConnection() {
  GmailApp.getInboxUnreadCount();
  louRequest('heartbeat', { state: 'connected' });
  return 'Lou connection and Gmail access are working.';
}
function removeLou() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    louDeleteTriggers();
    try { louRequest('heartbeat', { state: 'error', error: 'Script removed. Disconnect this account in Lou.' }); } catch (_) {}
    const props = louProperties();
    Object.keys(props.getProperties()).filter(k => k.indexOf(louKey('')) === 0).forEach(k => props.deleteProperty(k));
  } finally { lock.releaseLock(); }
  return 'Lou triggers and local configuration removed. Your email was not changed.';
}
function louMessage(message) {
  const thread = message.getThread();
  const labels = thread.getLabels().map(l => l.getName()).slice(0, 90);
  if (message.isInInbox()) labels.push('INBOX');
  if (message.isUnread()) labels.push('UNREAD');
  if (message.isStarred()) labels.push('STARRED');
  if (message.isInTrash()) labels.push('TRASH');
  if (message.isDraft()) labels.push('DRAFT');
  const address = Session.getEffectiveUser().getEmail().toLowerCase();
  if (address && message.getFrom().toLowerCase().indexOf(address) >= 0) labels.push('SENT');
  const body = message.getPlainBody().slice(0, 6000);
  const attachments = message.getAttachments({ includeInlineImages: false, includeAttachments: true });
  return {
    id: message.getId(), threadId: thread.getId(), from: message.getFrom(), to: message.getTo(), cc: message.getCc(),
    replyTo: message.getReplyTo(), subject: message.getSubject(), date: message.getDate().toISOString(),
    messageIdHeader: message.getHeader('Message-ID'), references: message.getHeader('References'),
    snippet: body.slice(0, 300), labelIds: labels, unread: message.isUnread(),
    bulk: !!message.getHeader('List-Unsubscribe') || /bulk|list|junk/i.test(message.getHeader('Precedence')) || /auto-/i.test(message.getHeader('Auto-Submitted')),
    body: body.split(/\nOn .{4,200}wrote:\s*\n/)[0].split('\n').filter(line => line.charAt(0) !== '>').join('\n'),
    attachments: attachments.slice(0, 100).map(a => a.getName()),
    attachmentMetadata: attachments.slice(0, 100).map((a, index) => ({ index: index, filename: a.getName(), mimeType: a.getContentType(), size: a.getSize() }))
  };
}
function louSent(message) { return { id: message.getId(), threadId: message.getThread().getId() }; }
function louOptions(email) {
  const options = { cc: (email.cc || []).join(','), bcc: (email.bcc || []).join(',') };
  if (email.htmlBody) options.htmlBody = email.htmlBody;
  if (email.attachments) options.attachments = email.attachments.map(a => Utilities.newBlob(Utilities.base64Decode(a.data), a.mimeType, a.filename));
  return options;
}
function louDraft(email) {
  const options = louOptions(email);
  if (email.messageId) {
    const message = GmailApp.getMessageById(email.messageId);
    // Keep the approved recipients while letting Gmail build reply threading.
    options.cc = (email.cc || []).join(',');
    const draft = email.replyAll ? message.createDraftReplyAll(email.body, options) : message.createDraftReply(email.body, options);
    return draft.update(email.to.join(','), email.subject, email.body, options);
  }
  return GmailApp.createDraft(email.to.join(','), email.subject, email.body, options);
}
function louExecute(input) {
  switch (input.operation) {
    case 'PROFILE': return { emailAddress: Session.getEffectiveUser().getEmail(), historyId: '' };
    case 'SEARCH': {
      // Pagination is by Gmail threads; flatten matching threads into bounded message results.
      const threads = GmailApp.search(input.query, input.offset || 0, input.limit);
      return threads.reduce((out, thread) => out.concat(thread.getMessages().slice(-input.limit).map(louMessage)), []).slice(0, input.limit);
    }
    case 'MESSAGE': return louMessage(GmailApp.getMessageById(input.messageId));
    case 'THREAD': {
      const thread = GmailApp.getThreadById(input.threadId);
      return { threadId: thread.getId(), subject: thread.getFirstMessageSubject(), messages: thread.getMessages().slice(-input.limit).map(louMessage) };
    }
    case 'SEND': return louSent(louDraft(input.email).send());
    case 'DRAFT': {
      const draft = louDraft(input.email);
      return { id: draft.getId(), message: louSent(draft.getMessage()) };
    }
    case 'UPDATE_DRAFT': {
      const email = input.email;
      const draft = GmailApp.getDraft(input.draftId).update(email.to.join(','), email.subject, email.body, louOptions(email));
      return { id: draft.getId(), message: louSent(draft.getMessage()) };
    }
    case 'SEND_DRAFT': return louSent(GmailApp.getDraft(input.draftId).send());
    case 'FORWARD': {
      // Draft then send gives us the actual resulting sent message ID.
      const original = GmailApp.getMessageById(input.messageId);
      const email = input.email;
      const options = louOptions(email);
      options.attachments = (options.attachments || []).concat(original.getAttachments({ includeInlineImages: false }));
      const draft = GmailApp.createDraft(email.to.join(','), email.subject || 'Fwd: ' + original.getSubject(), email.body + '\n\n' + original.getPlainBody(), options);
      return louSent(draft.send());
    }
    case 'MODIFY': {
      const thread = GmailApp.getThreadById(input.threadId);
      switch (input.action) {
        case 'read': thread.markRead(); break;
        case 'unread': thread.markUnread(); break;
        case 'archive': thread.moveToArchive(); break;
        case 'inbox': thread.moveToInbox(); break;
        case 'trash': thread.moveToTrash(); break;
        case 'star': thread.getMessages().forEach(m => m.star()); break;
        case 'unstar': thread.getMessages().forEach(m => m.unstar()); break;
        case 'addLabel': thread.addLabel(GmailApp.getUserLabelByName(input.label) || GmailApp.createLabel(input.label)); break;
        case 'removeLabel': { const label = GmailApp.getUserLabelByName(input.label); if (label) thread.removeLabel(label); break; }
      }
      return { ok: true };
    }
    case 'ATTACHMENT': {
      const attachment = GmailApp.getMessageById(input.messageId).getAttachments({ includeInlineImages: false, includeAttachments: true })[input.index];
      if (!attachment) throw new Error('Attachment not found.');
      if (attachment.getSize() > 500000) throw new Error('Attachment exceeds Lou’s 500 KB transfer limit. Open it in Gmail.');
      return { filename: attachment.getName(), mimeType: attachment.getContentType(), data: Utilities.base64Encode(attachment.getBytes()) };
    }
    default: throw new Error('Unsupported Lou command. Regenerate your script.');
  }
}
// Journal small results (especially sends) before reporting them. A started command
// is never executed again, even if Gmail succeeded but the script was interrupted.
function louFlushResults() {
  const props = louProperties();
  const prefix = louKey('command_');
  const values = props.getProperties();
  Object.keys(values).filter(k => k.indexOf(prefix) === 0).forEach(key => {
    const entry = JSON.parse(values[key]);
    louRequest('commands/' + key.slice(prefix.length) + '/result', entry.started ? { error: 'Execution interrupted; outcome unknown. Check Gmail before retrying.' } : entry);
    props.deleteProperty(key);
  });
}
function louRunCommands(deadline) {
  louFlushResults();
  const commands = louRequest('commands', {}).commands;
  for (const command of commands) {
    if (Date.now() >= deadline || Date.parse(command.expiresAt) <= Date.now()) break;
    if (!louRequest('commands/' + command.id + '/claim', {}).execute) continue;
    const key = louKey('command_' + command.id);
    const props = louProperties();
    props.setProperty(key, JSON.stringify({ started: true }));
    let entry;
    try { entry = { result: louExecute(command.input) }; }
    catch (error) { entry = { error: louSafeError(error) }; }
    const serialized = JSON.stringify(entry);
    if (Utilities.newBlob(serialized).getBytes().length <= 8000) props.setProperty(key, serialized);
    // Large read results are retried over HTTPS in this run, never stored in Properties.
    louRequest('commands/' + command.id + '/result', entry);
    props.deleteProperty(key);
  }
}
function louSync() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  const deadline = Date.now() + 45000;
  try {
    louRequest('heartbeat', { state: 'syncing' });
    louRunCommands(deadline);
    const props = louProperties();
    let window = JSON.parse(props.getProperty(louKey('window')) || 'null');
    if (!window) {
      const last = Number(props.getProperty(louKey('lastSync')) || Date.now() - 86400000);
      window = { after: Math.floor((last - 300000) / 1000), before: Math.floor(Date.now() / 1000) + 1, offset: 0 };
      props.setProperty(louKey('window'), JSON.stringify(window));
    }
    let known = JSON.parse(props.getProperty(louKey('known')) || '{}');
    // Fixed window and persisted thread pagination recover after missed runs.
    // The query includes read mail, with a five-minute overlap; no unread-only filter.
    while (Date.now() < deadline) {
      const threads = GmailApp.search('after:' + window.after + ' before:' + window.before + ' -in:chats', window.offset, 10);
      for (const thread of threads) {
        let batch = [];
        for (const message of thread.getMessages()) {
          if (message.getDate().getTime() < window.after * 1000 || message.getDate().getTime() >= window.before * 1000) continue;
          const signature = [message.isUnread(), message.isStarred(), message.isInInbox(), message.isInTrash(), thread.getLabels().map(l => l.getName()).join(',')].join('|');
          if (known[message.getId()] === signature) continue;
          batch.push(louMessage(message));
          if (batch.length === 10) {
            louRequest('sync', { messages: batch, cursor: JSON.stringify(window) });
            batch = [];
          }
          known[message.getId()] = signature;
        }
        if (batch.length) louRequest('sync', { messages: batch, cursor: JSON.stringify(window) });
      }
      window.offset += threads.length;
      props.setProperty(louKey('window'), JSON.stringify(window));
      // Bound local state well below Apps Script's per-property 9 KB limit.
      known = Object.fromEntries(Object.entries(known).slice(-100));
      props.setProperty(louKey('known'), JSON.stringify(known));
      if (threads.length < 10) {
        props.setProperty(louKey('lastSync'), String((window.before - 1) * 1000));
        props.deleteProperty(louKey('window'));
        break;
      }
    }
    // Recent arrival scan cannot see old read/archive changes. Rotate through the
    // bounded recent message cache to refresh those states without scanning all mail.
    const tracked = Object.keys(known);
    const position = Number(props.getProperty(louKey('stateOffset')) || 0);
    const refreshed = [];
    for (const id of tracked.slice(position, position + 5)) {
      if (Date.now() >= deadline) break;
      try { refreshed.push(louMessage(GmailApp.getMessageById(id))); } catch (_) {}
    }
    if (refreshed.length) louRequest('sync', { messages: refreshed, cursor: JSON.stringify(window) });
    props.setProperty(louKey('stateOffset'), String(position + 5 >= tracked.length ? 0 : position + 5));
    louRequest('sync', { messages: [], cursor: JSON.stringify(window) });
  } catch (error) {
    if (error.status === 401) louDeleteTriggers();
    try { louRequest('heartbeat', { state: /authoriz|permission|access denied/i.test(louSafeError(error)) ? 'authorization_required' : 'error', error: louSafeError(error) }); } catch (_) {}
    throw new Error(louSafeError(error));
  } finally { lock.releaseLock(); }
}
`;
}
