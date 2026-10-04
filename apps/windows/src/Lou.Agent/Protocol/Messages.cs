using System.Text.Json;
using System.Text.Json.Serialization;

namespace Lou.Agent.Protocol;

/// <summary>
/// C# mirror of packages/protocol (ws.ts, api.ts, bridge.ts). Keep field names in
/// sync with the TypeScript zod schemas; JSON uses camelCase.
/// </summary>
public static class ProtocolInfo
{
    public const int Version = 1;
}

public static class Json
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Options);

    public static T Deserialize<T>(string json) =>
        JsonSerializer.Deserialize<T>(json, Options) ?? throw new JsonException($"Could not parse {typeof(T).Name}");

    public static T Deserialize<T>(JsonElement element) =>
        element.Deserialize<T>(Options) ?? throw new JsonException($"Could not parse {typeof(T).Name}");
}

/// <summary>Every WebSocket frame: { v, id, type, ts, payload, seq?, deviceId?, runId?, replyTo? }.</summary>
public sealed record Envelope(
    int V,
    string Id,
    string Type,
    string Ts,
    JsonElement Payload,
    long? Seq = null,
    string? DeviceId = null,
    string? RunId = null,
    string? ReplyTo = null)
{
    public static Envelope Create(string type, object payload) =>
        new(ProtocolInfo.Version, Ids.New("c"), type, DateTimeOffset.UtcNow.ToString("O"), JsonSerializer.SerializeToElement(payload, Json.Options));
}

public static class FrameTypes
{
    public const string DeviceHello = "device.hello";
    public const string DeviceHeartbeat = "device.heartbeat";
    public const string DeviceCommandResult = "device.command.result";
    public const string Ping = "ping";

    public const string SessionReady = "session.ready";
    public const string DeviceCommand = "device.command";
    public const string DeviceRevoked = "device.revoked";
    public const string AgentProgress = "agent.progress";
    public const string AgentCompleted = "agent.completed";
    public const string ApprovalRequested = "approval.requested";
    public const string ApprovalResolved = "approval.resolved";
    public const string NotificationCreated = "notification.created";
    public const string Error = "error";
    public const string Pong = "pong";
}

public sealed record ErrorDto(string Code, string Message, bool? Retryable = null);

public sealed record DeviceHelloPayload(string Platform, string ClientVersion, IReadOnlyList<string> Capabilities, long? LastSeq);

public sealed record SessionReadyPayload(string SessionId, string DeviceId, int ProtocolVersion, string ServerTime, long CurrentSeq, bool ResyncRequired);

public sealed record DeviceCommandPayload(string CommandId, string Body, string Signature);

/// <summary>The signed body of a device command. Verified before any field is trusted.</summary>
public sealed record DeviceCommandBody(
    string CommandId,
    string DeviceId,
    string ToolId,
    JsonElement Input,
    string IssuedAt,
    string ExpiresAt,
    string? ApprovalId);

public sealed record DeviceCommandResultPayload(string CommandId, bool Success, object? Result, ErrorDto? Error);

public sealed record DeviceRegisterRequest(string PairingCode, string Name, string Platform, string ClientVersion, IReadOnlyList<string> Capabilities);

public sealed record DeviceRegisterResponse(string DeviceId, string DeviceToken, string CommandKey, string UserId);

// ---- WebView2 bridge (React ↔ C#) -----------------------------------------

public sealed record NativeRequest(string Type, string RequestId, string Method, JsonElement Params);

public sealed record NativeResponse(string RequestId, bool Success, object? Result = null, ErrorDto? Error = null)
{
    public string Type => "native.response";
}

public sealed record NativeEvent(string Event, object? Payload)
{
    public string Type => "native.event";
}

public sealed record ConnectionStateDto(string State, string? ServerUrl, string? DeviceId, string? Error = null);

public static class Ids
{
    public static string New(string prefix) => $"{prefix}_{Guid.NewGuid():N}";
}
