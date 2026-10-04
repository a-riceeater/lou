using System.Net;
using System.Net.Security;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using Lou.Agent.Protocol;
using Lou.Agent.Security;

namespace Lou.Agent.Connection;

public enum LinkState
{
    Connecting,
    Online,
    Offline,
    Revoked,
}

/// <summary>
/// Persistent outbound WebSocket to the server: authenticate, hello (with the
/// last seen seq for replay), heartbeat, and reconnect with jittered backoff.
/// Desktops never listen on a port.
/// </summary>
public sealed class ServerConnection : IAsyncDisposable
{
    private static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(20);
    private readonly DeviceCredentials _creds;
    private readonly Func<IReadOnlyList<string>> _capabilities;
    private readonly string _clientVersion;
    private readonly ILog _log;
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private ClientWebSocket? _socket;
    private long? _lastSeq;
    private CancellationTokenSource? _cts;
    private Task? _loop;

    public ServerConnection(DeviceCredentials creds, Func<IReadOnlyList<string>> capabilities, string clientVersion, ILog log)
    {
        _creds = creds;
        _capabilities = capabilities;
        _clientVersion = clientVersion;
        _log = log;
    }

    public LinkState State { get; private set; } = LinkState.Connecting;
    public string? LastError { get; private set; }

    public event Action<LinkState>? StateChanged;

    /// <summary>Raised for every server frame (raw JSON + parsed envelope).</summary>
    public event Action<string, Envelope>? FrameReceived;

    public void Start()
    {
        _cts = new CancellationTokenSource();
        _loop = Task.Run(() => RunAsync(_cts.Token));
    }

    public async Task SendAsync(string type, object payload, CancellationToken ct = default)
    {
        var socket = _socket;
        if (socket is not { State: WebSocketState.Open }) throw new InvalidOperationException("Not connected");
        var bytes = Encoding.UTF8.GetBytes(Json.Serialize(Envelope.Create(type, payload)));
        await _sendLock.WaitAsync(ct);
        try
        {
            await socket.SendAsync(bytes, WebSocketMessageType.Text, true, ct);
        }
        finally
        {
            _sendLock.Release();
        }
    }

    private async Task RunAsync(CancellationToken ct)
    {
        var attempt = 0;
        while (!ct.IsCancellationRequested && State != LinkState.Revoked)
        {
            SetState(LinkState.Connecting);
            try
            {
                await ConnectOnceAsync(ct);
                attempt = 0;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (UnauthorizedDeviceException)
            {
                LastError = "This device was signed out.";
                SetState(LinkState.Revoked);
                break;
            }
            catch (Exception ex)
            {
                LastError = ex.Message;
                _log.Warn($"connection failed: {ex.Message}");
            }
            if (State == LinkState.Revoked || ct.IsCancellationRequested) break;
            SetState(LinkState.Offline);
            var delay = TimeSpan.FromMilliseconds(Math.Min(30_000, 1000 * Math.Pow(2, attempt++)) * (0.75 + Random.Shared.NextDouble() * 0.5));
            try
            {
                await Task.Delay(delay, ct);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    private async Task ConnectOnceAsync(CancellationToken ct)
    {
        using var socket = new ClientWebSocket();
        socket.Options.SetRequestHeader("Authorization", $"Bearer {_creds.DeviceToken}");
        socket.Options.AddSubProtocol("lou.v1");
        socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);
        socket.Options.CollectHttpResponseDetails = true;
        if (_creds.PinnedCertSha256 is { Length: > 0 } pin)
        {
            // Optional certificate pinning on top of normal TLS validation.
            socket.Options.RemoteCertificateValidationCallback = (_, cert, _, errors) =>
                errors == SslPolicyErrors.None && cert is not null &&
                string.Equals(Convert.ToHexString(SHA256.HashData(cert.GetRawCertData())), pin, StringComparison.OrdinalIgnoreCase);
        }

        var uri = new Uri(new Uri(_creds.ServerUrl.Replace("https://", "wss://").Replace("http://", "ws://")), "/ws");
        try
        {
            await socket.ConnectAsync(uri, ct);
        }
        catch (WebSocketException) when (socket.HttpStatusCode == HttpStatusCode.Unauthorized)
        {
            throw new UnauthorizedDeviceException();
        }

        _socket = socket;
        await SendAsync(FrameTypes.DeviceHello, new DeviceHelloPayload("windows", _clientVersion, _capabilities(), _lastSeq), ct);

        using var heartbeatCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var heartbeat = HeartbeatAsync(heartbeatCts.Token);
        try
        {
            await ReceiveLoopAsync(socket, ct);
        }
        finally
        {
            heartbeatCts.Cancel();
            _socket = null;
            try { await heartbeat; } catch { /* ignored */ }
        }
        if (socket.CloseStatus == (WebSocketCloseStatus)4001) throw new UnauthorizedDeviceException();
    }

    private async Task ReceiveLoopAsync(ClientWebSocket socket, CancellationToken ct)
    {
        var buffer = new byte[64 * 1024];
        using var message = new MemoryStream();
        while (socket.State == WebSocketState.Open && !ct.IsCancellationRequested)
        {
            var result = await socket.ReceiveAsync(buffer, ct);
            if (result.MessageType == WebSocketMessageType.Close) break;
            message.Write(buffer, 0, result.Count);
            if (message.Length > 4 * 1024 * 1024) throw new InvalidOperationException("Frame too large");
            if (!result.EndOfMessage) continue;

            var json = Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length);
            message.SetLength(0);
            Envelope envelope;
            try
            {
                envelope = Json.Deserialize<Envelope>(json);
            }
            catch (JsonException)
            {
                _log.Warn("ignored malformed frame");
                continue;
            }
            if (envelope.Seq is { } seq) _lastSeq = seq;
            if (envelope.Type == FrameTypes.SessionReady) SetState(LinkState.Online);
            if (envelope.Type == FrameTypes.DeviceRevoked)
            {
                SetState(LinkState.Revoked);
            }
            try
            {
                FrameReceived?.Invoke(json, envelope);
            }
            catch (Exception ex)
            {
                _log.Error($"frame handler failed: {ex.Message}");
            }
        }
    }

    private async Task HeartbeatAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(HeartbeatInterval);
        while (await timer.WaitForNextTickAsync(ct))
        {
            try { await SendAsync(FrameTypes.DeviceHeartbeat, new { }, ct); } catch { /* reconnect loop handles it */ }
        }
    }

    private void SetState(LinkState state)
    {
        if (State == state) return;
        if (State == LinkState.Revoked) return;
        State = state;
        StateChanged?.Invoke(state);
    }

    public async ValueTask DisposeAsync()
    {
        _cts?.Cancel();
        try { _socket?.Abort(); } catch { /* ignored */ }
        if (_loop is not null)
        {
            try { await _loop; } catch { /* ignored */ }
        }
    }
}

public sealed class UnauthorizedDeviceException : Exception;

public interface ILog
{
    void Info(string message);
    void Warn(string message);
    void Error(string message);
}
