using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Lou.Agent.Protocol;
using Lou.Agent.Security;
using Xunit;

namespace Lou.Agent.Tests;

public class CommandVerifierTests
{
    private static readonly string Key = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
    private const string DeviceId = "dev_1";

    private static DeviceCommandPayload Sign(object body, string? key = null, string? commandId = null)
    {
        var json = JsonSerializer.Serialize(body, Json.Options);
        var sig = Convert.ToBase64String(HMACSHA256.HashData(Convert.FromBase64String(key ?? Key), Encoding.UTF8.GetBytes(json)));
        var id = commandId ?? JsonDocument.Parse(json).RootElement.GetProperty("commandId").GetString()!;
        return new DeviceCommandPayload(id, json, sig);
    }

    private static object Body(string id = "cmd_1", string device = DeviceId, int expiresInSeconds = 60) => new
    {
        commandId = id,
        deviceId = device,
        toolId = "device.get_clipboard",
        input = new { },
        issuedAt = DateTimeOffset.UtcNow.ToString("O"),
        expiresAt = DateTimeOffset.UtcNow.AddSeconds(expiresInSeconds).ToString("O"),
        approvalId = (string?)null,
    };

    [Fact]
    public void AcceptsValidCommand()
    {
        var verifier = new CommandVerifier(Key, DeviceId);
        var body = verifier.Verify(Sign(Body()));
        Assert.Equal("device.get_clipboard", body.ToolId);
    }

    [Fact]
    public void RejectsWrongKey()
    {
        var verifier = new CommandVerifier(Key, DeviceId);
        var other = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
        Assert.Throws<CommandRejectedException>(() => verifier.Verify(Sign(Body(), other)));
    }

    [Fact]
    public void RejectsTamperedBody()
    {
        var verifier = new CommandVerifier(Key, DeviceId);
        var signed = Sign(Body());
        var tampered = signed with { Body = signed.Body.Replace("device.get_clipboard", "device.open_app") };
        var ex = Assert.Throws<CommandRejectedException>(() => verifier.Verify(tampered));
        Assert.Equal("FORBIDDEN", ex.Code);
    }

    [Fact]
    public void RejectsOtherDevice()
    {
        var verifier = new CommandVerifier(Key, DeviceId);
        Assert.Throws<CommandRejectedException>(() => verifier.Verify(Sign(Body(device: "dev_2"))));
    }

    [Fact]
    public void RejectsExpired()
    {
        var verifier = new CommandVerifier(Key, DeviceId);
        var ex = Assert.Throws<CommandRejectedException>(() => verifier.Verify(Sign(Body(expiresInSeconds: -5))));
        Assert.Equal("TIMEOUT", ex.Code);
    }

    [Fact]
    public void RejectsReplay()
    {
        var verifier = new CommandVerifier(Key, DeviceId);
        var signed = Sign(Body());
        verifier.Verify(signed);
        Assert.Throws<CommandRejectedException>(() => verifier.Verify(signed));
    }

    [Fact]
    public void RejectsMismatchedEnvelopeId()
    {
        var verifier = new CommandVerifier(Key, DeviceId);
        Assert.Throws<CommandRejectedException>(() => verifier.Verify(Sign(Body(), commandId: "cmd_other")));
    }
}
