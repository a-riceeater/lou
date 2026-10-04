using System.Text.Json;
using Lou.Agent;
using Lou.Agent.Protocol;
using Lou.Agent.Security;
using Lou.Agent.Tools;
using Lou.App.Native;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;

namespace Lou.App;

/// <summary>
/// Application lifecycle. The device agent and tray live for the whole process;
/// windows are created once and shown/hidden, so the agent keeps running (and
/// executing device commands) while nothing is visible.
/// </summary>
public partial class App : Application, IShell
{
    private readonly FileLog _log = new();
    private DispatcherQueue _ui = null!;
    private LocalSettings _settings = null!;
    private MessageWindow _messages = null!;
    private GlobalHotkey _hotkey = null!;
    private TrayIcon _tray = null!;
    private ForegroundTracker _foreground = null!;
    private NotificationService _notifications = null!;
    private UiAutomationService _uia = null!;
    private DeviceAgent _agent = null!;
    private WebBridge _bridge = null!;
    private PaletteWindow _palette = null!;
    private MainWindow? _main;
    private bool _paused;

    public App()
    {
        InitializeComponent();
        UnhandledException += (_, e) =>
        {
            _log.Error($"unhandled: {e.Exception}");
            e.Handled = true;
        };
    }

    public string HotkeyLabel => _hotkey.Active ?? $"{_settings.Hotkey} (unavailable)";

    protected override async void OnLaunched(LaunchActivatedEventArgs args)
    {
        _ui = DispatcherQueue.GetForCurrentThread();
        _settings = LocalSettings.Load();
        _messages = new MessageWindow();
        _foreground = new ForegroundTracker();
        _notifications = new NotificationService();
        _notifications.Register();
        _notifications.Invoked += action => _ui.TryEnqueue(() =>
        {
            if (action == "review") ShowPalette();
            else ShowMain();
        });

        // ---- Device agent (no UI dependencies) ----
        var policy = new LocalPolicy();
        foreach (var cap in _settings.DisabledCapabilities) policy.DisabledCapabilities.Add(cap);
        var clipboard = new ClipboardAccess(_ui);
        _uia = new UiAutomationService(_foreground);
        var tools = new DeviceToolHost(
            [
                new OpenAppTool(), new OpenUrlTool(), new OpenFileTool(policy), new SearchFilesTool(policy),
                new ActiveWindowTool(_foreground), new ClipboardReadTool(clipboard), new ClipboardWriteTool(clipboard),
                new UiTreeTool(_uia), new InvokeUiElementTool(_uia), new ShowNotificationTool(_notifications),
            ],
            policy,
            new LocalAuditLog(),
            new LocalApprovalPrompt());
        var version = typeof(App).Assembly.GetName().Version?.ToString(3) ?? "0.1.0";
        _agent = new DeviceAgent(new CredentialStore(), tools, version, _log);
        _bridge = new WebBridge(_agent, this, _ui, _settings, _log);
        _agent.ServerFrame += OnServerFrame;
        _agent.ConnectionChanged += state => _ui.TryEnqueue(() => _tray?.SetTooltip(state.State switch
        {
            "online" => "Lou",
            "unpaired" => "Lou — not connected",
            "revoked" => "Lou — signed out",
            _ => "Lou — reconnecting…",
        }));

        // ---- Windows ----
        _palette = new PaletteWindow();
        await _palette.InitializeAsync(_bridge.Handle);
        _bridge.Attach(_palette.Core!);

        // ---- Shell integration ----
        _tray = new TrayIcon(_messages, Path.Combine(AppContext.BaseDirectory, "Assets", "lou.ico"));
        _tray.Add();
        _messages.TrayClick += () => _ui.TryEnqueue(() => ShowPalette());
        _messages.TrayMenu += () => _ui.TryEnqueue(OnTrayMenu);
        _hotkey = new GlobalHotkey(_messages);
        _messages.Hotkey += _ => _ui.TryEnqueue(TogglePalette);
        if (!_hotkey.Register(_settings.Hotkey))
        {
            _log.Warn($"hotkey {_settings.Hotkey} unavailable; trying Ctrl+Space");
            if (_hotkey.Register("Ctrl+Space")) _notifications.Show("Lou is ready", $"{_settings.Hotkey} is taken by another app, so use Ctrl+Space.");
        }

        AppInstance.GetCurrent().Activated += (_, _) => _ui.TryEnqueue(() => ShowPalette());

        _agent.Start();
        _log.Info("lou started");
        if (_agent.Credentials is null) ShowMain(); // first run: pairing screen
    }

    // ---- IShell -------------------------------------------------------------

    public void ShowPalette(string? prefill = null)
    {
        _palette.ShowAtCursor();
        if (_palette.Core is { } core)
        {
            _bridge.SendTo(core, "window.shown", new { surface = "palette" });
            if (prefill is not null) _bridge.SendTo(core, "palette.prefill", new { text = prefill });
        }
    }

    public void HidePalette() => _palette.Hide();

    public void ResizePalette(double heightDip) => _palette.ResizeTo(heightDip);

    public async void ShowMain(string? route = null)
    {
        if (_main is null)
        {
            _main = new MainWindow();
            await _main.InitializeAsync(_bridge.Handle);
            _bridge.Attach(_main.Core!);
        }
        _main.ShowAndFocus();
        if (_main.Core is { } core) _bridge.SendTo(core, "window.shown", new { surface = "app", route });
        _palette.Hide();
    }

    // -------------------------------------------------------------------------

    private void TogglePalette()
    {
        if (_palette.Visible) _palette.Hide();
        else ShowPalette();
    }

    /// <summary>When the palette is hidden, important pushes become native toasts.</summary>
    private void OnServerFrame(string json, Envelope envelope)
    {
        try
        {
            if (envelope.Type == FrameTypes.ApprovalRequested)
            {
                var title = envelope.Payload.GetProperty("approval").GetProperty("title").GetString() ?? "Lou needs your approval";
                _ui.TryEnqueue(() =>
                {
                    if (!_palette.Visible) _notifications.Show(title, "Ready for you to review.", "review");
                });
            }
            else if (envelope.Type == FrameTypes.NotificationCreated)
            {
                var n = envelope.Payload.GetProperty("notification");
                var title = n.GetProperty("title").GetString() ?? "Lou";
                var body = n.GetProperty("body").GetString() ?? "";
                _ui.TryEnqueue(() => _notifications.Show(title, body, "open"));
            }
            else if (envelope.Type == FrameTypes.DeviceRevoked)
            {
                _ui.TryEnqueue(() => ShowMain());
            }
        }
        catch (Exception ex) when (ex is KeyNotFoundException or InvalidOperationException or JsonException)
        {
            _log.Warn($"could not render push {envelope.Type}");
        }
    }

    private async void OnTrayMenu()
    {
        switch (_tray.ShowMenu(_paused))
        {
            case TrayIcon.CmdAsk:
                ShowPalette();
                break;
            case TrayIcon.CmdOpen:
                ShowMain();
                break;
            case TrayIcon.CmdPause:
                // Emergency control without involving the agent.
                if (_agent.Api is { } api)
                {
                    try
                    {
                        var body = JsonSerializer.SerializeToElement(new { agentPaused = !_paused });
                        var (status, _) = await api.SendAsync("PATCH", "/api/settings", body);
                        if (status < 400) _paused = !_paused;
                    }
                    catch (Exception ex)
                    {
                        _log.Warn($"pause failed: {ex.Message}");
                    }
                }
                break;
            case TrayIcon.CmdQuit:
                await QuitAsync();
                break;
        }
    }

    private async Task QuitAsync()
    {
        _tray.Dispose();
        _hotkey.Dispose();
        _foreground.Dispose();
        _notifications.Unregister();
        await _agent.DisposeAsync();
        _uia.Dispose();
        _messages.Dispose();
        Exit();
    }
}
