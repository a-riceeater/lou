using Lou.Agent.Connection;
using Lou.Agent.Platform;
using Lou.Agent.Protocol;
using Microsoft.UI.Dispatching;
using Microsoft.Windows.AppNotifications;
using Microsoft.Windows.AppNotifications.Builder;
using Windows.ApplicationModel.DataTransfer;
using static Lou.App.Native.NativeMethods;

namespace Lou.App.Native;

/// <summary>Tracks the last foreground window that isn't Lou, so "this window" means what the user was looking at.</summary>
internal sealed class ForegroundTracker : IForegroundWindowSource, IDisposable
{
    private readonly WinEventProc _proc;
    private readonly nint _hook;
    private nint _last;

    public ForegroundTracker()
    {
        _proc = OnForeground;
        _hook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, 0, _proc, 0, 0, WINEVENT_OUTOFCONTEXT);
        // Seed with whatever is in front right now.
        OnForeground(0, 0, Lou.Agent.Platform.Foreground.Current(), 0, 0, 0, 0);
    }

    public nint LastExternalWindow => _last;

    private void OnForeground(nint hook, uint eventType, nint hwnd, int idObject, int idChild, uint thread, uint time)
    {
        GetWindowThreadProcessId(hwnd, out var pid);
        if (pid != (uint)Environment.ProcessId && hwnd != 0) _last = hwnd;
    }

    public void Dispose() => UnhookWinEvent(_hook);
}

/// <summary>Clipboard access marshalled to the UI thread.</summary>
internal sealed class ClipboardAccess(DispatcherQueue dispatcher) : IClipboardAccess
{
    public Task<string> GetTextAsync() => OnUi(async () =>
    {
        var content = Clipboard.GetContent();
        return content.Contains(StandardDataFormats.Text) ? await content.GetTextAsync() : "";
    });

    public Task SetTextAsync(string text) => OnUi(() =>
    {
        var package = new DataPackage();
        package.SetText(text);
        Clipboard.SetContent(package);
        return Task.FromResult(true);
    });

    private Task<T> OnUi<T>(Func<Task<T>> work)
    {
        var tcs = new TaskCompletionSource<T>();
        dispatcher.TryEnqueue(async () =>
        {
            try { tcs.SetResult(await work()); }
            catch (Exception ex) { tcs.SetException(ex); }
        });
        return tcs.Task;
    }
}

/// <summary>Native toasts (Windows App SDK app notifications).</summary>
internal sealed class NotificationService : INotifier
{
    private bool _registered;

    public event Action<string>? Invoked;

    public void Register()
    {
        try
        {
            AppNotificationManager.Default.NotificationInvoked += (_, args) =>
                Invoked?.Invoke(args.Arguments.TryGetValue("action", out var a) ? a : "open");
            AppNotificationManager.Default.Register();
            _registered = true;
        }
        catch (Exception)
        {
            _registered = false; // notifications unavailable; the app still works
        }
    }

    public void Show(string title, string body, string? launchArgs = null)
    {
        if (!_registered) return;
        var builder = new AppNotificationBuilder()
            .AddArgument("action", launchArgs ?? "open")
            .AddText(title)
            .AddText(body);
        if (launchArgs == "review") builder.AddButton(new AppNotificationButton("Review").AddArgument("action", "review"));
        try { AppNotificationManager.Default.Show(builder.BuildNotification()); } catch { /* ignore */ }
    }

    public void Unregister()
    {
        if (_registered) AppNotificationManager.Default.Unregister();
    }
}

/// <summary>Local confirmation for high-risk commands, independent of the server.</summary>
internal sealed class LocalApprovalPrompt : ILocalApprovalPrompt
{
    public Task<bool> ConfirmAsync(string title, string detail, CancellationToken ct) =>
        Task.Run(() => MessageBox(0, detail, title, MB_YESNO | MB_ICONWARNING | MB_TOPMOST | MB_SETFOREGROUND) == IDYES, ct);
}

internal sealed class FileLog : ILog
{
    private readonly string _dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Lou", "logs");
    private readonly object _lock = new();

    public FileLog() => Directory.CreateDirectory(_dir);

    public void Info(string message) => Write("INFO", message);
    public void Warn(string message) => Write("WARN", message);
    public void Error(string message) => Write("ERROR", message);

    private void Write(string level, string message)
    {
        lock (_lock)
        {
            try { File.AppendAllText(Path.Combine(_dir, $"lou-{DateTime.UtcNow:yyyyMMdd}.log"), $"{DateTime.UtcNow:O} {level} {message}{Environment.NewLine}"); }
            catch { /* logging must never crash the app */ }
        }
    }
}

/// <summary>Per-computer preferences (not synced): shortcut and locally disabled capabilities.</summary>
internal sealed class LocalSettings
{
    private static readonly string FilePath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Lou", "settings.json");

    public string Hotkey { get; set; } = "Alt+Space";
    public List<string> DisabledCapabilities { get; set; } = [];

    public static LocalSettings Load()
    {
        try { return File.Exists(FilePath) ? Json.Deserialize<LocalSettings>(File.ReadAllText(FilePath)) : new LocalSettings(); }
        catch { return new LocalSettings(); }
    }

    public void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
        File.WriteAllText(FilePath, Json.Serialize(this));
    }
}

internal static class Errors
{
    public static ErrorDto From(Exception ex) => ex switch
    {
        BridgeException b => new ErrorDto(b.Code, b.Message),
        HttpRequestException => new ErrorDto("OFFLINE", "Can't reach your server right now."),
        TaskCanceledException => new ErrorDto("TIMEOUT", "Your server took too long to respond."),
        ArgumentException a => new ErrorDto("VALIDATION_FAILED", a.Message),
        _ => new ErrorDto("INTERNAL", ex.Message),
    };
}
