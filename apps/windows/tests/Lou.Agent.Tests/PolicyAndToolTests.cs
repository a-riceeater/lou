using System.Text.Json;
using Lou.Agent.Connection;
using Lou.Agent.Platform;
using Lou.Agent.Protocol;
using Lou.Agent.Security;
using Lou.Agent.Tools;
using Xunit;

namespace Lou.Agent.Tests;

public sealed class TempDir : IDisposable
{
    public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "lou-tests-" + Guid.NewGuid().ToString("N"));
    public TempDir() => Directory.CreateDirectory(Path);
    public void Dispose()
    {
        try { Directory.Delete(Path, true); } catch { }
    }
}

public class LocalPolicyTests
{
    [Fact]
    public void AllowsOnlyPathsInsideRootsAndOutsideHiddenFolders()
    {
        using var tmp = new TempDir();
        var policy = new LocalPolicy([tmp.Path]);
        Assert.True(policy.IsPathAllowed(System.IO.Path.Combine(tmp.Path, "notes.txt")));
        Assert.False(policy.IsPathAllowed(System.IO.Path.Combine(tmp.Path, "..", "escape.txt")));
        Assert.False(policy.IsPathAllowed(System.IO.Path.Combine(tmp.Path, "AppData", "secrets.txt")));
        Assert.False(policy.IsPathAllowed(System.IO.Path.Combine(tmp.Path, ".ssh", "id_rsa")));
        Assert.False(policy.IsPathAllowed(@"\\server\share\file.txt"));
        Assert.False(policy.IsPathAllowed(@"C:\Windows\System32\cmd.exe"));
    }

    [Fact]
    public async Task OpenFileRefusesExecutables()
    {
        using var tmp = new TempDir();
        var exe = System.IO.Path.Combine(tmp.Path, "setup.exe");
        await File.WriteAllTextAsync(exe, "x");
        var tool = new OpenFileTool(new LocalPolicy([tmp.Path]));
        var input = JsonSerializer.SerializeToElement(new { path = exe });
        var ex = await Assert.ThrowsAsync<ToolException>(() => tool.ExecuteAsync(input, CancellationToken.None));
        Assert.Equal("FORBIDDEN", ex.Code);
    }

    [Fact]
    public async Task SearchFilesMatchesNamesWithinRoots()
    {
        using var tmp = new TempDir();
        Directory.CreateDirectory(System.IO.Path.Combine(tmp.Path, "school"));
        await File.WriteAllTextAsync(System.IO.Path.Combine(tmp.Path, "school", "Robotics Budget 2026.xlsx"), "x");
        await File.WriteAllTextAsync(System.IO.Path.Combine(tmp.Path, "other.txt"), "x");
        Directory.CreateDirectory(System.IO.Path.Combine(tmp.Path, "node_modules"));
        await File.WriteAllTextAsync(System.IO.Path.Combine(tmp.Path, "node_modules", "budget.js"), "x");

        var tool = new SearchFilesTool(new LocalPolicy([tmp.Path]));
        var result = await tool.ExecuteAsync(JsonSerializer.SerializeToElement(new { query = "budget" }), CancellationToken.None);
        var json = JsonSerializer.SerializeToElement(result);
        var names = json.GetProperty("files").EnumerateArray().Select(f => f.GetProperty("name").GetString()).ToList();
        Assert.Equal(["Robotics Budget 2026.xlsx"], names);
    }

    [Fact]
    public async Task OpenUrlRejectsNonHttpSchemes()
    {
        var tool = new OpenUrlTool();
        var ex = await Assert.ThrowsAsync<ToolException>(() => tool.ExecuteAsync(JsonSerializer.SerializeToElement(new { url = "file:///C:/Windows/System32/calc.exe" }), CancellationToken.None));
        Assert.Equal("VALIDATION_FAILED", ex.Code);
    }

    [Fact]
    public void ServerUrlRequiresTlsExceptLoopback()
    {
        Assert.Equal("https://lou.example.com", ApiClient.NormalizeServerUrl("lou.example.com/"));
        Assert.Equal("http://localhost:8787", ApiClient.NormalizeServerUrl("http://localhost:8787"));
        Assert.Throws<BridgeException>(() => ApiClient.NormalizeServerUrl("http://lou.example.com"));
    }
}

public class ToolHostTests
{
    private sealed class FakeClipboard : IClipboardAccess
    {
        public string Text = "hello";
        public Task<string> GetTextAsync() => Task.FromResult(Text);
        public Task SetTextAsync(string text) { Text = text; return Task.CompletedTask; }
    }

    private static DeviceCommandBody Command(string tool, object input, string? approvalId = null) =>
        new("cmd_1", "dev_1", tool, JsonSerializer.SerializeToElement(input), DateTimeOffset.UtcNow.ToString("O"), DateTimeOffset.UtcNow.AddMinutes(1).ToString("O"), approvalId);

    [Fact]
    public async Task ExecutesAndHonorsLocallyDisabledCapabilities()
    {
        using var tmp = new TempDir();
        var host = new DeviceToolHost([new ClipboardReadTool(new FakeClipboard())], new LocalPolicy([tmp.Path]), new LocalAuditLog(tmp.Path));
        var ok = await host.ExecuteAsync(Command("device.get_clipboard", new { }), CancellationToken.None);
        Assert.True(ok.Success);

        host.Policy.DisabledCapabilities.Add("clipboard_read");
        Assert.DoesNotContain("clipboard_read", host.Capabilities());
        var denied = await host.ExecuteAsync(Command("device.get_clipboard", new { }), CancellationToken.None);
        Assert.False(denied.Success);
        Assert.Equal("FORBIDDEN", denied.Error!.Code);
        Assert.True(File.Exists(System.IO.Path.Combine(tmp.Path, "audit.log")));
    }

    [Fact]
    public async Task UnknownToolsFailCleanly()
    {
        using var tmp = new TempDir();
        var host = new DeviceToolHost([], new LocalPolicy([tmp.Path]), new LocalAuditLog(tmp.Path));
        var result = await host.ExecuteAsync(Command("device.run_powershell", new { script = "rm -r ~" }), CancellationToken.None);
        Assert.False(result.Success);
        Assert.Equal("NOT_FOUND", result.Error!.Code);
    }

    [Fact]
    public void CredentialsRoundTripThroughDpapi()
    {
        using var tmp = new TempDir();
        var store = new CredentialStore(tmp.Path);
        var creds = new DeviceCredentials("https://lou.example.com", "dev_1", "lou_dev_secret", "a2V5", "usr_1");
        store.Save(creds);
        Assert.DoesNotContain("lou_dev_secret", File.ReadAllText(System.IO.Path.Combine(tmp.Path, "device.bin")));
        Assert.Equal(creds, store.Load());
        store.Clear();
        Assert.Null(store.Load());
    }

    [Fact]
    public void EnvelopeMatchesProtocolShape()
    {
        var json = Json.Serialize(Envelope.Create(FrameTypes.DeviceHello, new DeviceHelloPayload("windows", "0.1.0", ["clipboard_read"], 42)));
        var doc = JsonDocument.Parse(json).RootElement;
        Assert.Equal(1, doc.GetProperty("v").GetInt32());
        Assert.Equal("device.hello", doc.GetProperty("type").GetString());
        Assert.Equal(42, doc.GetProperty("payload").GetProperty("lastSeq").GetInt64());
        Assert.Equal("windows", doc.GetProperty("payload").GetProperty("platform").GetString());
    }
}
