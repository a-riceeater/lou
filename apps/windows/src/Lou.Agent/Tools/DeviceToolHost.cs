using Lou.Agent.Platform;
using Lou.Agent.Protocol;

namespace Lou.Agent.Tools;

/// <summary>Executes verified device commands under local policy and records them locally.</summary>
public sealed class DeviceToolHost
{
    private readonly Dictionary<string, IDeviceTool> _tools;
    private readonly LocalPolicy _policy;
    private readonly ILocalApprovalPrompt? _prompt;
    private readonly LocalAuditLog _audit;

    public DeviceToolHost(IEnumerable<IDeviceTool> tools, LocalPolicy policy, LocalAuditLog audit, ILocalApprovalPrompt? prompt = null)
    {
        _tools = tools.ToDictionary(t => t.ToolId);
        _policy = policy;
        _audit = audit;
        _prompt = prompt;
    }

    public LocalPolicy Policy => _policy;

    /// <summary>Capabilities announced to the server (minus anything turned off locally).</summary>
    public IReadOnlyList<string> Capabilities() =>
        _tools.Values.Select(t => t.Capability).Distinct().Where(c => !_policy.DisabledCapabilities.Contains(c)).OrderBy(c => c).ToList();

    public async Task<DeviceCommandResultPayload> ExecuteAsync(DeviceCommandBody body, CancellationToken ct)
    {
        try
        {
            if (!_tools.TryGetValue(body.ToolId, out var tool)) throw new ToolException("NOT_FOUND", $"This device doesn't support {body.ToolId}.");
            if (_policy.DisabledCapabilities.Contains(tool.Capability)) throw new ToolException("FORBIDDEN", "That capability is turned off on this device.");
            if (_policy.RequiresLocalApproval(body.ToolId, body.ApprovalId))
            {
                var ok = _prompt is not null && await _prompt.ConfirmAsync("Allow Lou to use this app?", "Lou wants to interact with a window on this computer.", ct);
                if (!ok) throw new ToolException("USER_REJECTED", "Declined on this computer.");
            }
            var result = await tool.ExecuteAsync(body.Input, ct);
            _audit.Write(body, "succeeded", null);
            return new DeviceCommandResultPayload(body.CommandId, true, result, null);
        }
        catch (ToolException ex)
        {
            _audit.Write(body, "failed", ex.Code);
            return new DeviceCommandResultPayload(body.CommandId, false, null, new ErrorDto(ex.Code, ex.Message, false));
        }
        catch (Exception ex)
        {
            _audit.Write(body, "failed", "INTERNAL");
            return new DeviceCommandResultPayload(body.CommandId, false, null, new ErrorDto("UPSTREAM_ERROR", $"The device couldn't do that: {ex.Message}", false));
        }
    }
}

/// <summary>Append-only local record of device actions (no command payloads, which may hold personal text).</summary>
public sealed class LocalAuditLog
{
    private readonly string _path;
    private readonly object _lock = new();

    public LocalAuditLog(string? directory = null)
    {
        var dir = directory ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Lou");
        Directory.CreateDirectory(dir);
        _path = Path.Combine(dir, "audit.log");
    }

    public void Write(DeviceCommandBody body, string outcome, string? errorCode) =>
        Append(new { at = DateTimeOffset.UtcNow.ToString("O"), commandId = body.CommandId, tool = body.ToolId, approvalId = body.ApprovalId, outcome, errorCode });

    public void Append(object entry)
    {
        lock (_lock)
        {
            try
            {
                if (File.Exists(_path) && new FileInfo(_path).Length > 5 * 1024 * 1024) File.Move(_path, _path + ".1", overwrite: true);
                File.AppendAllText(_path, Json.Serialize(entry) + Environment.NewLine);
            }
            catch
            {
                /* never let auditing crash a command */
            }
        }
    }
}
