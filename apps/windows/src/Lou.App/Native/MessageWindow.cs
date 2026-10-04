using System.Runtime.InteropServices;
using static Lou.App.Native.NativeMethods;

namespace Lou.App.Native;

/// <summary>
/// Hidden Win32 window that receives the global hotkey and tray icon callbacks.
/// It lives as long as the process, independent of any visible window.
/// </summary>
internal sealed class MessageWindow : IDisposable
{
    private readonly WndProc _proc; // kept alive for the native callback
    private readonly uint _taskbarCreated;

    public MessageWindow()
    {
        _proc = Proc;
        _taskbarCreated = RegisterWindowMessage("TaskbarCreated");
        var cls = new WNDCLASSEX
        {
            cbSize = (uint)Marshal.SizeOf<WNDCLASSEX>(),
            lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_proc),
            hInstance = GetModuleHandle(null),
            lpszClassName = "LouMessageWindow",
        };
        RegisterClassEx(ref cls);
        Handle = CreateWindowEx(0, cls.lpszClassName, "Lou", 0, 0, 0, 0, 0, 0, 0, cls.hInstance, 0);
        if (Handle == 0) throw new InvalidOperationException($"CreateWindowEx failed ({Marshal.GetLastWin32Error()})");
    }

    public nint Handle { get; }

    public event Action<int>? Hotkey;
    public event Action? TrayClick;
    public event Action? TrayMenu;
    public event Action? TaskbarCreated;

    private nint Proc(nint hWnd, uint msg, nint wParam, nint lParam)
    {
        if (msg == WM_HOTKEY)
        {
            Hotkey?.Invoke((int)wParam);
            return 0;
        }
        if (msg == WM_TRAY)
        {
            var evt = (int)(lParam & 0xFFFF);
            if (evt == WM_LBUTTONUP) TrayClick?.Invoke();
            else if (evt == WM_RBUTTONUP || evt == WM_CONTEXTMENU) TrayMenu?.Invoke();
            return 0;
        }
        if (msg == _taskbarCreated)
        {
            TaskbarCreated?.Invoke();
            return 0;
        }
        return DefWindowProc(hWnd, msg, wParam, lParam);
    }

    public void Dispose() => DestroyWindow(Handle);
}

/// <summary>Global shortcut (default Alt+Space) via RegisterHotKey.</summary>
internal sealed class GlobalHotkey : IDisposable
{
    private const int Id = 0x4C4F; // "LO"
    private readonly MessageWindow _window;

    public GlobalHotkey(MessageWindow window) => _window = window;

    public string? Active { get; private set; }

    /// <summary>Registers the shortcut; returns false if another app owns it.</summary>
    public bool Register(string shortcut)
    {
        UnregisterHotKey(_window.Handle, Id);
        if (!TryParse(shortcut, out var mods, out var vk)) return false;
        var ok = RegisterHotKey(_window.Handle, Id, mods | MOD_NOREPEAT, vk);
        Active = ok ? shortcut : null;
        return ok;
    }

    public static bool TryParse(string shortcut, out uint modifiers, out uint vk)
    {
        modifiers = 0;
        vk = 0;
        foreach (var raw in shortcut.Split('+', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        {
            switch (raw.ToLowerInvariant())
            {
                case "alt": modifiers |= MOD_ALT; break;
                case "ctrl" or "control": modifiers |= MOD_CONTROL; break;
                case "shift": modifiers |= MOD_SHIFT; break;
                case "win": modifiers |= MOD_WIN; break;
                case "space": vk = 0x20; break;
                case var k when k.Length == 1 && char.IsLetterOrDigit(k[0]): vk = char.ToUpperInvariant(k[0]); break;
                case var f when f.StartsWith('f') && int.TryParse(f[1..], out var n) && n is >= 1 and <= 12: vk = (uint)(0x6F + n); break;
                default: return false;
            }
        }
        return modifiers != 0 && vk != 0;
    }

    public void Dispose() => UnregisterHotKey(_window.Handle, Id);
}
