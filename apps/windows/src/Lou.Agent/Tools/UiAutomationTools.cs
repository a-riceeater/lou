using System.Text.Json;
using FlaUI.Core.AutomationElements;
using FlaUI.UIA3;
using Lou.Agent.Platform;

namespace Lou.Agent.Tools;

/// <summary>
/// Windows UI Automation (DESKTOP_CLIENT.md §9): the server refers to temporary
/// element IDs, never screen coordinates. IDs expire when a new tree is read or
/// after a short time. Password fields and password managers are never exposed.
/// </summary>
public sealed class UiAutomationService : IDisposable
{
    private static readonly TimeSpan TreeLifetime = TimeSpan.FromMinutes(2);
    private readonly UIA3Automation _automation = new();
    private readonly IForegroundWindowSource _foreground;
    private readonly object _lock = new();
    private Dictionary<string, AutomationElement> _elements = new();
    private string _treeId = "";
    private DateTimeOffset _treeAt;

    public UiAutomationService(IForegroundWindowSource foreground) => _foreground = foreground;

    public object ReadTree(int maxDepth, int maxNodes)
    {
        var hwnd = _foreground.LastExternalWindow;
        if (hwnd == 0) throw new ToolException("NOT_FOUND", "No window to read.");
        var (_, process) = Win32.WindowProcess(hwnd);
        if (LocalPolicy.ProtectedProcesses.Contains(process)) throw new ToolException("FORBIDDEN", "That window is protected.");

        var root = _automation.FromHandle(hwnd);
        var elements = new Dictionary<string, AutomationElement>();
        var output = new List<object>();
        var queue = new Queue<(AutomationElement El, int Depth)>();
        queue.Enqueue((root, 0));
        var walker = _automation.TreeWalkerFactory.GetControlViewWalker();
        while (queue.Count > 0 && output.Count < maxNodes)
        {
            var (el, depth) = queue.Dequeue();
            string role, name;
            bool enabled, isPassword;
            try
            {
                role = el.Properties.ControlType.ValueOrDefault.ToString().ToLowerInvariant();
                name = el.Properties.Name.ValueOrDefault ?? "";
                enabled = el.Properties.IsEnabled.ValueOrDefault;
                isPassword = el.Properties.IsPassword.ValueOrDefault;
            }
            catch
            {
                continue;
            }
            var id = $"ui_{output.Count + 1}";
            elements[id] = el;
            output.Add(new { id, role, name = isPassword ? "(password field)" : Truncate(name, 200), depth, enabled });
            if (depth >= maxDepth) continue;
            try
            {
                var child = walker.GetFirstChild(el);
                while (child is not null && queue.Count < maxNodes * 2)
                {
                    queue.Enqueue((child, depth + 1));
                    child = walker.GetNextSibling(child);
                }
            }
            catch
            {
                /* element vanished */
            }
        }

        lock (_lock)
        {
            _elements = elements;
            _treeId = Guid.NewGuid().ToString("N")[..12];
            _treeAt = DateTimeOffset.UtcNow;
        }
        return new { treeId = _treeId, window = Win32.WindowTitle(hwnd), elements = output };
    }

    public object Invoke(string elementId, string action, string? value)
    {
        AutomationElement? el;
        lock (_lock)
        {
            if (DateTimeOffset.UtcNow - _treeAt > TreeLifetime) _elements.Clear();
            _elements.TryGetValue(elementId, out el);
        }
        if (el is null) throw new ToolException("NOT_FOUND", "That element expired. Read the window again.");
        try
        {
            if (el.Properties.IsPassword.ValueOrDefault) throw new ToolException("FORBIDDEN", "Lou doesn't interact with password fields.");
            switch (action)
            {
                case "invoke":
                    if (el.Patterns.Invoke.IsSupported) el.Patterns.Invoke.Pattern.Invoke();
                    else if (el.Patterns.Toggle.IsSupported) el.Patterns.Toggle.Pattern.Toggle();
                    else if (el.Patterns.SelectionItem.IsSupported) el.Patterns.SelectionItem.Pattern.Select();
                    else throw new ToolException("VALIDATION_FAILED", "That element can't be activated.");
                    break;
                case "focus":
                    el.Focus();
                    break;
                case "set_value":
                    if (!el.Patterns.Value.IsSupported || el.Patterns.Value.Pattern.IsReadOnly.ValueOrDefault) throw new ToolException("VALIDATION_FAILED", "That element doesn't accept text.");
                    el.Patterns.Value.Pattern.SetValue(value ?? "");
                    break;
                default:
                    throw new ToolException("VALIDATION_FAILED", "Unknown action.");
            }
        }
        catch (ToolException)
        {
            throw;
        }
        catch (Exception ex)
        {
            throw new ToolException("UPSTREAM_ERROR", $"The app didn't accept that: {ex.Message}");
        }
        lock (_lock) _elements.Clear(); // the UI likely changed
        return new { done = true };
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];

    public void Dispose() => _automation.Dispose();
}

public sealed class UiTreeTool(UiAutomationService uia) : IDeviceTool
{
    public string ToolId => "device.get_ui_tree";
    public string Capability => "ui_automation";

    public Task<object> ExecuteAsync(JsonElement input, CancellationToken ct) =>
        Task.Run(() => uia.ReadTree(Input.OptInt(input, "maxDepth", 6, 1, 12), Input.OptInt(input, "maxNodes", 150, 1, 400)), ct);
}

public sealed class InvokeUiElementTool(UiAutomationService uia) : IDeviceTool
{
    public string ToolId => "device.invoke_ui_element";
    public string Capability => "ui_automation";

    public Task<object> ExecuteAsync(JsonElement input, CancellationToken ct) =>
        Task.Run(() => uia.Invoke(Input.Str(input, "elementId", 64), Input.Str(input, "action", 20), Input.OptStr(input, "value")), ct);
}
