using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace Lou.Agent.Platform;

internal static partial class Win32
{
    [LibraryImport("user32.dll")]
    internal static partial nint GetForegroundWindow();

    [LibraryImport("user32.dll", EntryPoint = "GetWindowTextW", StringMarshalling = StringMarshalling.Utf16)]
    internal static partial int GetWindowText(nint hWnd, [Out] char[] text, int maxCount);

    [LibraryImport("user32.dll")]
    internal static partial uint GetWindowThreadProcessId(nint hWnd, out uint processId);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool IsWindow(nint hWnd);

    public static string WindowTitle(nint hwnd)
    {
        var buffer = new char[512];
        var len = GetWindowText(hwnd, buffer, buffer.Length);
        return new string(buffer, 0, Math.Max(0, len));
    }

    public static (uint Pid, string ProcessName) WindowProcess(nint hwnd)
    {
        GetWindowThreadProcessId(hwnd, out var pid);
        try
        {
            using var p = Process.GetProcessById((int)pid);
            return (pid, p.ProcessName);
        }
        catch
        {
            return (pid, "");
        }
    }
}

/// <summary>Fallback foreground source when the host does not track windows.</summary>
public sealed class CurrentForegroundWindow : IForegroundWindowSource
{
    public nint LastExternalWindow
    {
        get
        {
            var hwnd = Win32.GetForegroundWindow();
            var (pid, _) = Win32.WindowProcess(hwnd);
            return pid == (uint)Environment.ProcessId ? 0 : hwnd;
        }
    }
}
