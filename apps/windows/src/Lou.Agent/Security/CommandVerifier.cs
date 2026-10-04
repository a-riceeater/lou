using System.Security.Cryptography;
using System.Text;
using Lou.Agent.Protocol;

namespace Lou.Agent.Security;

public sealed class CommandRejectedException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

/// <summary>
/// Rejects unsigned, tampered, misaddressed, expired or replayed commands
/// (DESKTOP_CLIENT.md §11). The HMAC covers the exact body string the server
/// sent, so there is no cross-language canonicalization to get wrong.
/// </summary>
public sealed class CommandVerifier
{
    private static readonly TimeSpan ClockSkew = TimeSpan.FromMinutes(2);
    private readonly byte[] _key;
    private readonly string _deviceId;
    private readonly TimeProvider _time;
    private readonly Dictionary<string, DateTimeOffset> _seen = new();
    private readonly object _lock = new();

    public CommandVerifier(string commandKeyBase64, string deviceId, TimeProvider? time = null)
    {
        _key = Convert.FromBase64String(commandKeyBase64);
        if (_key.Length < 32) throw new ArgumentException("Command key too short");
        _deviceId = deviceId;
        _time = time ?? TimeProvider.System;
    }

    public DeviceCommandBody Verify(DeviceCommandPayload payload)
    {
        byte[] signature;
        try
        {
            signature = Convert.FromBase64String(payload.Signature);
        }
        catch (FormatException)
        {
            throw new CommandRejectedException("FORBIDDEN", "Malformed command signature.");
        }

        var expected = HMACSHA256.HashData(_key, Encoding.UTF8.GetBytes(payload.Body));
        if (!CryptographicOperations.FixedTimeEquals(expected, signature))
            throw new CommandRejectedException("FORBIDDEN", "Command signature is invalid.");

        DeviceCommandBody body;
        try
        {
            body = Json.Deserialize<DeviceCommandBody>(payload.Body);
        }
        catch (Exception)
        {
            throw new CommandRejectedException("VALIDATION_FAILED", "Command body is malformed.");
        }

        if (body.CommandId != payload.CommandId) throw new CommandRejectedException("FORBIDDEN", "Command ID mismatch.");
        if (body.DeviceId != _deviceId) throw new CommandRejectedException("FORBIDDEN", "Command is addressed to another device.");

        var now = _time.GetUtcNow();
        if (!DateTimeOffset.TryParse(body.ExpiresAt, out var expires) || expires < now)
            throw new CommandRejectedException("TIMEOUT", "Command expired.");
        if (!DateTimeOffset.TryParse(body.IssuedAt, out var issued) || issued > now + ClockSkew)
            throw new CommandRejectedException("FORBIDDEN", "Command issued in the future.");

        lock (_lock)
        {
            foreach (var stale in _seen.Where(kv => kv.Value < now).Select(kv => kv.Key).ToList()) _seen.Remove(stale);
            if (_seen.ContainsKey(body.CommandId)) throw new CommandRejectedException("FORBIDDEN", "Command was already executed.");
            _seen[body.CommandId] = expires;
        }
        return body;
    }
}
