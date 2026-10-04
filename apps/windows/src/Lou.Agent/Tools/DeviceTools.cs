using System.Diagnostics;
using System.Text.Json;
using Lou.Agent.Platform;
using Microsoft.Win32;

namespace Lou.Agent.Tools;

public sealed class ToolException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

/// <summary>A device capability. Input shapes mirror packages/tools/src/device.ts.</summary>
public interface IDeviceTool
{
    string ToolId { get; }
    string Capability { get; }
    Task<object> ExecuteAsync(JsonElement input, CancellationToken ct);
}

internal static class Input
{
    public static string Str(JsonElement input, string name, int max = 4096)
    {
        if (!input.TryGetProperty(name, out var v) || v.ValueKind != JsonValueKind.String) throw new ToolException("VALIDATION_FAILED", $"Missing \"{name}\".");
        var s = v.GetString() ?? "";
        if (s.Length == 0 || s.Length > max) throw new ToolException("VALIDATION_FAILED", $"Invalid \"{name}\".");
        return s;
    }

    public static string? OptStr(JsonElement input, string name) =>
        input.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    public static int OptInt(JsonElement input, string name, int fallback, int min, int max) =>
        input.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i) ? Math.Clamp(i, min, max) : fallback;
}

internal static class Shell
{
    public static void Open(string target)
    {
        using var _ = Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
    }
}

/// <summary>device.open_app — launches an installed app by display name via its Start menu shortcut.</summary>
public sealed class OpenAppTool : IDeviceTool
{
    public string ToolId => "device.open_app";
    public string Capability => "open_app";

    public Task<object> ExecuteAsync(JsonElement input, CancellationToken ct)
    {
        var name = Input.Str(input, "name", 120).Trim();
        var shortcut = FindShortcut(name);
        if (shortcut is not null)
        {
            Shell.Open(shortcut);
            return Task.FromResult<object>(new { launched = Path.GetFileNameWithoutExtension(shortcut) });
        }
        // Registered "App Paths" executables (e.g. "winword", "notepad"), never arbitrary paths or arguments.
        var exe = name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? name : name + ".exe";
        if (!exe.Contains('\\') && !exe.Contains('/') && AppPathRegistered(exe))
        {
            Shell.Open(exe);
            return Task.FromResult<object>(new { launched = name });
        }
        throw new ToolException("NOT_FOUND", $"Couldn't find an app called \"{name}\".");
    }

    internal static string? FindShortcut(string name)
    {
        var roots = new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu),
            Environment.GetFolderPath(Environment.SpecialFolder.StartMenu),
        };
        var candidates = roots
            .Where(Directory.Exists)
            .SelectMany(r => Directory.EnumerateFiles(r, "*.lnk", new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true, MaxRecursionDepth = 4 }))
            .Select(p => (Path: p, Name: Path.GetFileNameWithoutExtension(p)))
            .Where(c => !c.Name.Contains("uninstall", StringComparison.OrdinalIgnoreCase))
            .ToList();
        return candidates.FirstOrDefault(c => c.Name.Equals(name, StringComparison.OrdinalIgnoreCase)).Path
            ?? candidates.Where(c => c.Name.StartsWith(name, StringComparison.OrdinalIgnoreCase)).OrderBy(c => c.Name.Length).FirstOrDefault().Path
            ?? candidates.Where(c => c.Name.Contains(name, StringComparison.OrdinalIgnoreCase)).OrderBy(c => c.Name.Length).FirstOrDefault().Path;
    }

    private static bool AppPathRegistered(string exe)
    {
        const string key = @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\";
        using var hklm = Registry.LocalMachine.OpenSubKey(key + exe);
        using var hkcu = Registry.CurrentUser.OpenSubKey(key + exe);
        return hklm is not null || hkcu is not null || File.Exists(Path.Combine(Environment.SystemDirectory, exe));
    }
}

/// <summary>device.open_url — http(s) only, in the default browser.</summary>
public sealed class OpenUrlTool : IDeviceTool
{
    public string ToolId => "device.open_url";
    public string Capability => "open_url";

    public Task<object> ExecuteAsync(JsonElement input, CancellationToken ct)
    {
        var url = Input.Str(input, "url", 2048);
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
            throw new ToolException("VALIDATION_FAILED", "Only http(s) links can be opened.");
        Shell.Open(uri.AbsoluteUri);
        return Task.FromResult<object>(new { opened = true });
    }
}

/// <summary>device.open_file — personal folders only; never executables or scripts.</summary>
public sealed class OpenFileTool(LocalPolicy policy) : IDeviceTool
{
    public string ToolId => "device.open_file";
    public string Capability => "open_file";

    public Task<object> ExecuteAsync(JsonElement input, CancellationToken ct)
    {
        var path = Input.Str(input, "path", 1024);
        if (!policy.IsPathAllowed(path)) throw new ToolException("FORBIDDEN", "That file is outside your personal folders.");
        if (LocalPolicy.ExecutableExtensions.Contains(Path.GetExtension(path))) throw new ToolException("FORBIDDEN", "Lou doesn't open programs or scripts.");
        if (!File.Exists(path)) throw new ToolException("NOT_FOUND", "That file doesn't exist anymore.");
        Shell.Open(Path.GetFullPath(path));
        return Task.FromResult<object>(new { opened = true });
    }
}

/// <summary>device.search_files — file names (never contents) in personal folders, time-boxed.</summary>
public sealed class SearchFilesTool(LocalPolicy policy) : IDeviceTool
{
    private static readonly HashSet<string> SkipDirs = new(StringComparer.OrdinalIgnoreCase) { "node_modules", "AppData", "$Recycle.Bin", "bin", "obj", "venv", "__pycache__" };
    public string ToolId => "device.search_files";
    public string Capability => "search_files";

    public Task<object> ExecuteAsync(JsonElement input, CancellationToken ct)
    {
        var query = Input.Str(input, "query", 200);
        var limit = Input.OptInt(input, "limit", 20, 1, 50);
        var folder = Input.OptStr(input, "folder");
        var roots = folder is null ? policy.AllowedRoots : [KnownFolders.Resolve(folder) ?? throw new ToolException("VALIDATION_FAILED", "Unknown folder.")];
        var terms = query.ToLowerInvariant().Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var deadline = Stopwatch.StartNew();
        var results = new List<(FileInfo File, int Score)>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var root in roots.Where(Directory.Exists))
        {
            var stack = new Stack<(string Dir, int Depth)>();
            stack.Push((root, 0));
            while (stack.Count > 0 && deadline.ElapsedMilliseconds < 3000 && !ct.IsCancellationRequested)
            {
                var (dir, depth) = stack.Pop();
                IEnumerable<string> files, dirs;
                try
                {
                    files = Directory.EnumerateFiles(dir);
                    dirs = depth < 6 ? Directory.EnumerateDirectories(dir) : [];
                }
                catch
                {
                    continue;
                }
                foreach (var f in files)
                {
                    var name = Path.GetFileName(f).ToLowerInvariant();
                    if (!terms.All(name.Contains) || !seen.Add(f) || !policy.IsPathAllowed(f)) continue;
                    var info = new FileInfo(f);
                    if ((info.Attributes & (FileAttributes.Hidden | FileAttributes.System)) != 0) continue;
                    results.Add((info, name.StartsWith(terms[0], StringComparison.Ordinal) ? 2 : 1));
                }
                foreach (var d in dirs)
                {
                    var n = Path.GetFileName(d);
                    if (n.StartsWith('.') || SkipDirs.Contains(n)) continue;
                    try
                    {
                        if ((File.GetAttributes(d) & (FileAttributes.Hidden | FileAttributes.System | FileAttributes.ReparsePoint)) != 0) continue;
                    }
                    catch
                    {
                        continue;
                    }
                    stack.Push((d, depth + 1));
                }
            }
        }

        var files_ = results
            .OrderByDescending(r => r.Score)
            .ThenByDescending(r => r.File.LastWriteTimeUtc)
            .Take(limit)
            .Select(r => new { path = r.File.FullName, name = r.File.Name, size = r.File.Length, modifiedAt = r.File.LastWriteTimeUtc.ToString("O") })
            .ToList();
        return Task.FromResult<object>(new { files = files_ });
    }
}

/// <summary>device.get_active_window — what the user was looking at before summoning Lou.</summary>
public sealed class ActiveWindowTool(IForegroundWindowSource source) : IDeviceTool
{
    public string ToolId => "device.get_active_window";
    public string Capability => "active_window";

    public Task<object> ExecuteAsync(JsonElement input, CancellationToken ct)
    {
        var hwnd = source.LastExternalWindow;
        if (hwnd == 0 || !Win32.IsWindow(hwnd)) throw new ToolException("NOT_FOUND", "No active window.");
        var (_, process) = Win32.WindowProcess(hwnd);
        if (LocalPolicy.ProtectedProcesses.Contains(process)) return Task.FromResult<object>(new { title = "(protected window)", processName = process });
        return Task.FromResult<object>(new { title = Win32.WindowTitle(hwnd), processName = process });
    }
}

public sealed class ClipboardReadTool(IClipboardAccess clipboard) : IDeviceTool
{
    public string ToolId => "device.get_clipboard";
    public string Capability => "clipboard_read";

    public async Task<object> ExecuteAsync(JsonElement input, CancellationToken ct)
    {
        var text = await clipboard.GetTextAsync();
        return new { text = text.Length > 20_000 ? text[..20_000] : text };
    }
}

public sealed class ClipboardWriteTool(IClipboardAccess clipboard) : IDeviceTool
{
    public string ToolId => "device.set_clipboard";
    public string Capability => "clipboard_write";

    public async Task<object> ExecuteAsync(JsonElement input, CancellationToken ct)
    {
        if (!input.TryGetProperty("text", out var t) || t.ValueKind != JsonValueKind.String) throw new ToolException("VALIDATION_FAILED", "Missing \"text\".");
        await clipboard.SetTextAsync(t.GetString() ?? "");
        return new { copied = true };
    }
}

public sealed class ShowNotificationTool(INotifier notifier) : IDeviceTool
{
    public string ToolId => "device.show_notification";
    public string Capability => "notifications";

    public Task<object> ExecuteAsync(JsonElement input, CancellationToken ct)
    {
        notifier.Show(Input.Str(input, "title", 120), Input.OptStr(input, "body") ?? "");
        return Task.FromResult<object>(new { shown = true });
    }
}
