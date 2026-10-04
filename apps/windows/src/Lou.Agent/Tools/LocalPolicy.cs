namespace Lou.Agent.Tools;

/// <summary>
/// Local, device-side policy (DESKTOP_CLIENT.md §11). Applied after the server's
/// policy: the device decides what can happen here, whatever the server asks.
/// </summary>
public sealed class LocalPolicy
{
    /// <summary>Opening these runs code; the agent never launches them via open_file.</summary>
    public static readonly HashSet<string> ExecutableExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".exe", ".com", ".bat", ".cmd", ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".msi", ".msp", ".scr",
        ".pif", ".cpl", ".hta", ".jar", ".reg", ".lnk", ".url", ".appref-ms", ".application", ".msc", ".dll", ".sys", ".inf",
    };

    /// <summary>Password managers and credential UIs are never automated or read.</summary>
    public static readonly HashSet<string> ProtectedProcesses = new(StringComparer.OrdinalIgnoreCase)
    {
        "CredentialUIBroker", "consent", "LogonUI", "KeePass", "KeePassXC", "1Password", "Bitwarden", "Dashlane", "LastPass",
        "NordPass", "Keeper", "RoboForm", "ProtonPass", "Enpass", "lsass", "SecHealthUI",
    };

    /// <summary>Folders device tools may search and open from: the user's personal folders.</summary>
    public IReadOnlyList<string> AllowedRoots { get; }

    /// <summary>Capabilities the user turned off locally.</summary>
    public HashSet<string> DisabledCapabilities { get; } = new(StringComparer.Ordinal);

    public LocalPolicy(IReadOnlyList<string>? roots = null)
    {
        AllowedRoots = roots ?? KnownFolders.All().Select(f => f.Path).Where(Directory.Exists).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }

    public bool IsPathAllowed(string path)
    {
        string full;
        try
        {
            full = Path.GetFullPath(path);
        }
        catch
        {
            return false;
        }
        if (full.StartsWith(@"\\", StringComparison.Ordinal)) return false; // no UNC / device paths
        var hidden = full.Split(Path.DirectorySeparatorChar).Any(p => p.Equals("AppData", StringComparison.OrdinalIgnoreCase) || p.StartsWith('.'));
        if (hidden) return false;
        return AllowedRoots.Any(root => full.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>Commands that need confirmation from the person at this computer.</summary>
    public bool RequiresLocalApproval(string toolId, string? approvalId) =>
        toolId == "device.invoke_ui_element" && approvalId is null;
}

public static class KnownFolders
{
    public static IEnumerable<(string Name, string Path)> All()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        yield return ("documents", Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments));
        yield return ("downloads", Path.Combine(home, "Downloads"));
        yield return ("desktop", Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory));
        yield return ("pictures", Environment.GetFolderPath(Environment.SpecialFolder.MyPictures));
        yield return ("music", Environment.GetFolderPath(Environment.SpecialFolder.MyMusic));
        yield return ("videos", Environment.GetFolderPath(Environment.SpecialFolder.MyVideos));
        yield return ("home", home);
    }

    public static string? Resolve(string name) => All().FirstOrDefault(f => f.Name == name).Path;
}
