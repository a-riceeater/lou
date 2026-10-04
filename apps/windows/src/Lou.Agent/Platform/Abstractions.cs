namespace Lou.Agent.Platform;

/// <summary>
/// Capabilities that need the UI thread or WinUI APIs are provided by the host app
/// through these interfaces, keeping the agent library free of UI dependencies.
/// </summary>
public interface IClipboardAccess
{
    Task<string> GetTextAsync();
    Task SetTextAsync(string text);
}

public interface INotifier
{
    void Show(string title, string body, string? launchArgs = null);
}

public interface IForegroundWindowSource
{
    /// <summary>The last window the user used that does not belong to Lou.</summary>
    nint LastExternalWindow { get; }
}

public interface ILocalApprovalPrompt
{
    /// <summary>Asks the person at this computer to confirm a high-risk command.</summary>
    Task<bool> ConfirmAsync(string title, string detail, CancellationToken ct);
}
