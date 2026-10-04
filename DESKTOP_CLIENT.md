# DESKTOP_CLIENT.md

# Windows Desktop Client and Device Agent

## 1. Goal

The Windows application should provide:

- a polished Apple-like assistant UI
- global command palette / Siri-style popup
- local desktop control
- notifications
- approval windows
- voice/text entry
- secure persistent connection to the central assistant server

The native Windows layer should be C#/.NET.

The primary visible UI should be React rendered through WebView2.

---

# 2. Technology

Recommended:

```text
C# / .NET
WinUI 3
WebView2
React
TypeScript
Vite
Motion / Framer Motion
WebSocket
Windows UI Automation
Win32 where needed
```

Structure:

```text
windows/
  Assistant.Windows/
    App.xaml
    MainWindow.xaml
    Native/
      DeviceAgent.cs
      UiAutomationService.cs
      WindowService.cs
      ClipboardService.cs
      FileService.cs
      NotificationService.cs
      GlobalHotkeyService.cs
      WebSocketService.cs
      ApprovalService.cs

frontend/
  src/
    app/
    components/
    screens/
    stores/
    bridge/
    styles/
```

---

# 3. UI Philosophy

The interface should feel:

- clean
- minimal
- calm
- fast
- spatially consistent
- native-quality
- not like an admin dashboard

Avoid:

- excessive borders
- dense settings panels
- giant button grids
- unnecessary labels
- chat-bubble-heavy UI
- exposing raw JSON or tool names

The design itself should communicate state.

---

# 4. Main UI Surfaces

## Command Palette

Opened with a configurable global hotkey, initially:

```text
Alt + Space
```

States:

- idle
- listening
- transcribing
- thinking
- tool-running
- approval
- result
- error

---

## Approval Window

Used for:

- sending email
- sending Instagram replies
- creating calendar events
- editing cloud data
- file moves
- destructive actions

Editable fields should be actual inputs.

Do not require the user to approve generated content they cannot inspect.

---

## Activity / History

Show:

- recent requests
- actions taken
- approvals
- errors
- device status
- learned skills where useful

Do not expose raw chain-of-thought.

---

## Settings

Sections:

- Accounts
- Devices
- Notifications
- Permissions
- Skills
- Memory
- Models
- Privacy
- Developer

---

# 5. React ↔ C# Bridge

Use WebView2 messaging.

Frontend request:

```json
{
  "type": "native.request",
  "requestId": "req_123",
  "method": "clipboard.read",
  "params": {}
}
```

Native response:

```json
{
  "type": "native.response",
  "requestId": "req_123",
  "success": true,
  "result": {
    "text": "..."
  }
}
```

Native event:

```json
{
  "type": "native.event",
  "event": "approval.received",
  "payload": {}
}
```

Every request must include a request ID.

---

# 6. Device Agent

The Device Agent is the trusted local execution layer.

It should register capabilities:

```json
{
  "deviceId": "windows-main",
  "platform": "windows",
  "capabilities": [
    "open_app",
    "open_file",
    "open_url",
    "search_files",
    "clipboard_read",
    "clipboard_write",
    "active_window",
    "ui_automation",
    "notifications"
  ]
}
```

The device should create an outbound WebSocket to the server.

Do not expose a local control port publicly.

---

# 7. Initial Device Tools

Implement first:

```text
device.open_app
device.open_file
device.open_url
device.search_files
device.get_active_window
device.get_clipboard
device.set_clipboard
device.get_ui_tree
device.invoke_ui_element
device.show_notification
```

Add later:

```text
device.type_text
device.keyboard_shortcut
device.mouse_click
device.screenshot
device.run_powershell
device.browser_extension_call
```

---

# 8. Desktop Automation Priority

Use, in order:

1. direct OS API
2. app-specific API
3. Windows UI Automation
4. browser extension
5. browser automation
6. keyboard/mouse fallback
7. screenshot + vision fallback

Avoid coordinate-based automation where possible.

---

# 9. Windows UI Automation

Use accessibility/UI Automation trees to identify controls.

Example representation:

```json
[
  {
    "id": "ui_1",
    "role": "textbox",
    "name": "Search"
  },
  {
    "id": "ui_2",
    "role": "button",
    "name": "Send"
  }
]
```

The server should refer to stable temporary element IDs rather than raw screen coordinates.

Element IDs expire when the UI tree changes.

---

# 10. Browser Extension

For Chrome/Firefox/Edge, provide an optional extension.

Capabilities:

```text
browser.get_current_tab
browser.get_page_text
browser.get_selection
browser.list_tabs
browser.open_url
browser.focus_tab
```

This should be preferred over attempting to scrape browser UI through Windows UI Automation.

---

# 11. Local Security

The Windows client must:

- verify server identity
- authenticate its device session
- reject unsigned or invalid commands
- enforce local permission policy
- maintain an audit log
- never return secrets unless explicitly permitted
- never expose stored browser passwords or password-manager content

High-risk commands should require local approval even if the server requests them.

---

# 12. Background Operation

The native C# host should remain running in the tray.

The visible React UI can be hidden.

The C# host handles:

- global shortcut
- notifications
- server WebSocket
- device commands
- approval popups

---

# 13. Performance

WebView2 is acceptable because the visible app is primarily:

- text
- lists
- cards
- forms
- animations
- notifications

Heavy operations stay in:

- server backend
- C# native layer

Do not place desktop automation or filesystem-heavy work inside React.

---

# 14. macOS and iOS

macOS later:

```text
Swift
SwiftUI
AXUIElement
NSWorkspace
Apple Events where appropriate
```

iOS later:

```text
SwiftUI
push notifications
voice input
approval UI
deep links
App Intents / Shortcuts where supported
```

iOS should not be treated as a fully controllable desktop device.
