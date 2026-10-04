using System.Text.Json;
using Lou.Agent;
using Lou.Agent.Protocol;
using Microsoft.UI.Dispatching;
using Microsoft.Web.WebView2.Core;

namespace Lou.App.Native;

/// <summary>Window operations the bridge can ask the shell for.</summary>
internal interface IShell
{
    void ShowPalette(string? prefill = null);
    void HidePalette();
    void ResizePalette(double heightDip);
    void ShowMain(string? route = null);
    string HotkeyLabel { get; }
}

/// <summary>
/// Dispatches React requests (DESKTOP_CLIENT.md §5) and fans native events out to
/// every attached WebView. Every request carries a request ID and gets exactly one
/// response. Credentials never cross this boundary.
/// </summary>
internal sealed class WebBridge
{
    private readonly DeviceAgent _agent;
    private readonly IShell _shell;
    private readonly DispatcherQueue _ui;
    private readonly LocalSettings _settings;
    private readonly FileLog _log;
    private readonly List<CoreWebView2> _views = [];

    public WebBridge(DeviceAgent agent, IShell shell, DispatcherQueue ui, LocalSettings settings, FileLog log)
    {
        _agent = agent;
        _shell = shell;
        _ui = ui;
        _settings = settings;
        _log = log;
        agent.ConnectionChanged += state => Broadcast("connection.state", state);
        agent.ServerFrame += (json, _) => BroadcastRaw("server.message", json);
    }

    public void Attach(CoreWebView2 view) => _views.Add(view);

    public void Broadcast(string evt, object? payload) =>
        _ui.TryEnqueue(() =>
        {
            var json = Json.Serialize(new NativeEvent(evt, payload));
            foreach (var v in _views) Post(v, json);
        });

    /// <summary>Forwards a server frame without re-serializing it.</summary>
    private void BroadcastRaw(string evt, string payloadJson) =>
        _ui.TryEnqueue(() =>
        {
            var json = $"{{\"type\":\"native.event\",\"event\":\"{evt}\",\"payload\":{payloadJson}}}";
            foreach (var v in _views) Post(v, json);
        });

    public void SendTo(CoreWebView2 view, string evt, object? payload) => _ui.TryEnqueue(() => Post(view, Json.Serialize(new NativeEvent(evt, payload))));

    public async void Handle(CoreWebView2 view, string json)
    {
        NativeRequest request;
        try
        {
            request = Json.Deserialize<NativeRequest>(json);
            if (request.Type != "native.request" || string.IsNullOrEmpty(request.RequestId)) return;
        }
        catch
        {
            return;
        }

        NativeResponse response;
        try
        {
            var result = await DispatchAsync(request.Method, request.Params);
            response = new NativeResponse(request.RequestId, true, result);
        }
        catch (Exception ex)
        {
            if (ex is not Agent.Connection.BridgeException) _log.Warn($"bridge {request.Method} failed: {ex.Message}");
            response = new NativeResponse(request.RequestId, false, null, Errors.From(ex));
        }
        Post(view, Json.Serialize(response));
    }

    private async Task<object?> DispatchAsync(string method, JsonElement p)
    {
        switch (method)
        {
            case "api.request":
            {
                var api = _agent.Api ?? throw new Agent.Connection.BridgeException("UNAUTHORIZED", "This computer isn't connected yet.");
                var body = p.TryGetProperty("body", out var b) ? b : (JsonElement?)null;
                var (status, json) = await api.SendAsync(Str(p, "method"), Str(p, "path"), body);
                return new { status, body = json };
            }
            case "api.transcribe":
            {
                var api = _agent.Api ?? throw new Agent.Connection.BridgeException("UNAUTHORIZED", "This computer isn't connected yet.");
                var audio = Convert.FromBase64String(Str(p, "audioBase64"));
                if (audio.Length > 15 * 1024 * 1024) throw new ArgumentException("Recording too long.");
                return await api.TranscribeAsync(audio, Str(p, "mimeType"));
            }
            case "app.info":
                return new { version = typeof(App).Assembly.GetName().Version?.ToString(3) ?? "0.1.0", platform = "windows", hotkey = _shell.HotkeyLabel, connection = _agent.ConnectionState };
            case "app.openExternal":
            {
                // Used for OAuth sign-in pages: open in the user's real browser, http(s) only.
                var url = Str(p, "url");
                if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
                    throw new ArgumentException("Only web links can be opened.");
                await Windows.System.Launcher.LaunchUriAsync(uri);
                return null;
            }
            case "window.hide":
                _ui.TryEnqueue(_shell.HidePalette);
                return null;
            case "window.resize":
                if (p.TryGetProperty("height", out var h) && h.TryGetDouble(out var height)) _ui.TryEnqueue(() => _shell.ResizePalette(height));
                return null;
            case "window.show":
            {
                var surface = OptStr(p, "surface") ?? "palette";
                if (surface == "app") _ui.TryEnqueue(() => _shell.ShowMain(OptStr(p, "route")));
                else _ui.TryEnqueue(() => _shell.ShowPalette(OptStr(p, "prefill")));
                return null;
            }
            case "pairing.complete":
                await _agent.PairAsync(Str(p, "serverUrl"), Str(p, "pairingCode"), OptStr(p, "name") ?? Environment.MachineName);
                return _agent.ConnectionState;
            case "pairing.reset":
                await _agent.UnpairAsync();
                return null;
            case "clipboard.write":
                await new ClipboardAccess(_ui).SetTextAsync(OptStr(p, "text") ?? "");
                return null;
            case "clipboard.read":
                return new { text = await new ClipboardAccess(_ui).GetTextAsync() };
            case "settings.get":
                return new { hotkey = _settings.Hotkey, disabledCapabilities = _settings.DisabledCapabilities };
            case "settings.set":
                if (p.TryGetProperty("disabledCapabilities", out var caps) && caps.ValueKind == JsonValueKind.Array)
                    _settings.DisabledCapabilities = caps.EnumerateArray().Select(c => c.GetString() ?? "").Where(c => c.Length > 0).ToList();
                _settings.Save();
                return null;
            default:
                throw new Agent.Connection.BridgeException("NOT_FOUND", $"Unknown method {method}.");
        }
    }

    private static string Str(JsonElement p, string name) =>
        p.ValueKind == JsonValueKind.Object && p.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()! : throw new ArgumentException($"Missing {name}.");

    private static string? OptStr(JsonElement p, string name) =>
        p.ValueKind == JsonValueKind.Object && p.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static void Post(CoreWebView2 view, string json)
    {
        try { view.PostWebMessageAsJson(json); } catch { /* view closing */ }
    }
}
