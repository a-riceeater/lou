using Lou.Agent.Connection;
using Lou.Agent.Protocol;
using Lou.Agent.Security;
using Lou.Agent.Tools;

namespace Lou.Agent;

/// <summary>
/// The trusted local execution layer (DESKTOP_CLIENT.md §6). Owns the server
/// connection and executes signed commands; it runs independently of any visible
/// window and has no UI dependencies. The UI subscribes to its events.
/// </summary>
public sealed class DeviceAgent : IAsyncDisposable
{
    private readonly CredentialStore _store;
    private readonly DeviceToolHost _tools;
    private readonly string _clientVersion;
    private readonly ILog _log;
    private ServerConnection? _connection;
    private CommandVerifier? _verifier;

    public DeviceAgent(CredentialStore store, DeviceToolHost tools, string clientVersion, ILog log)
    {
        _store = store;
        _tools = tools;
        _clientVersion = clientVersion;
        _log = log;
        Credentials = store.Load();
    }

    public DeviceCredentials? Credentials { get; private set; }
    public ApiClient? Api { get; private set; }

    public event Action<ConnectionStateDto>? ConnectionChanged;
    public event Action<string, Envelope>? ServerFrame;

    public ConnectionStateDto ConnectionState => Credentials is null
        ? new ConnectionStateDto("unpaired", null, null)
        : new ConnectionStateDto(
            _connection?.State switch
            {
                LinkState.Online => "online",
                LinkState.Offline => "offline",
                LinkState.Revoked => "revoked",
                _ => "connecting",
            },
            Credentials.ServerUrl,
            Credentials.DeviceId,
            _connection?.LastError);

    public void Start()
    {
        if (Credentials is null)
        {
            ConnectionChanged?.Invoke(ConnectionState);
            return;
        }
        _verifier = new CommandVerifier(Credentials.CommandKey, Credentials.DeviceId);
        Api = new ApiClient(Credentials);
        _connection = new ServerConnection(Credentials, _tools.Capabilities, _clientVersion, _log);
        _connection.StateChanged += state =>
        {
            if (state == LinkState.Revoked) _log.Warn("device credential revoked by server");
            ConnectionChanged?.Invoke(ConnectionState);
        };
        _connection.FrameReceived += OnFrame;
        _connection.Start();
        ConnectionChanged?.Invoke(ConnectionState);
    }

    public async Task PairAsync(string serverUrl, string pairingCode, string deviceName, CancellationToken ct = default)
    {
        var creds = await ApiClient.RegisterAsync(serverUrl, new DeviceRegisterRequest(pairingCode, deviceName, "windows", _clientVersion, _tools.Capabilities()), ct: ct);
        _store.Save(creds);
        await StopAsync();
        Credentials = creds;
        Start();
    }

    public async Task UnpairAsync()
    {
        await StopAsync();
        _store.Clear();
        Credentials = null;
        ConnectionChanged?.Invoke(ConnectionState);
    }

    private void OnFrame(string json, Envelope envelope)
    {
        if (envelope.Type == FrameTypes.DeviceCommand)
        {
            _ = HandleCommandAsync(envelope);
            return; // commands are never forwarded to the UI
        }
        if (envelope.Type == FrameTypes.DeviceRevoked)
        {
            _store.Clear();
        }
        ServerFrame?.Invoke(json, envelope);
    }

    private async Task HandleCommandAsync(Envelope envelope)
    {
        DeviceCommandPayload payload;
        try
        {
            payload = Json.Deserialize<DeviceCommandPayload>(envelope.Payload);
        }
        catch
        {
            _log.Warn("dropped malformed device command");
            return;
        }

        DeviceCommandResultPayload result;
        try
        {
            var body = _verifier!.Verify(payload);
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(55));
            result = await _tools.ExecuteAsync(body, cts.Token);
        }
        catch (CommandRejectedException ex)
        {
            _log.Warn($"rejected device command {payload.CommandId}: {ex.Message}");
            result = new DeviceCommandResultPayload(payload.CommandId, false, null, new ErrorDto(ex.Code, ex.Message, false));
        }
        try
        {
            if (_connection is not null) await _connection.SendAsync(FrameTypes.DeviceCommandResult, result);
        }
        catch (Exception ex)
        {
            _log.Warn($"could not send command result: {ex.Message}");
        }
    }

    private async Task StopAsync()
    {
        if (_connection is not null) await _connection.DisposeAsync();
        _connection = null;
        Api?.Dispose();
        Api = null;
    }

    public async ValueTask DisposeAsync() => await StopAsync();
}
