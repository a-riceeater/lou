using System.Runtime.InteropServices;
using static Lou.App.Native.NativeMethods;

namespace Lou.App.Native;

/// <summary>Notification-area icon with a small native menu.</summary>
internal sealed class TrayIcon : IDisposable
{
    public const int CmdAsk = 1, CmdOpen = 2, CmdPause = 3, CmdQuit = 4;
    private readonly MessageWindow _window;
    private readonly nint _icon;
    private bool _added;

    public TrayIcon(MessageWindow window, string iconPath)
    {
        _window = window;
        _icon = LoadImage(0, iconPath, IMAGE_ICON, 16, 16, LR_LOADFROMFILE);
        window.TaskbarCreated += Add; // re-add after Explorer restarts
    }

    public void Add()
    {
        var data = Data();
        data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP;
        _added = Shell_NotifyIcon(_added ? NIM_MODIFY : NIM_ADD, ref data);
        data.uVersion = 4;
        Shell_NotifyIcon(NIM_SETVERSION, ref data);
    }

    public void SetTooltip(string text)
    {
        var data = Data(text);
        data.uFlags = NIF_TIP | NIF_SHOWTIP;
        Shell_NotifyIcon(NIM_MODIFY, ref data);
    }

    /// <summary>Shows the context menu and returns the chosen command (0 = none).</summary>
    public int ShowMenu(bool paused)
    {
        var menu = CreatePopupMenu();
        AppendMenu(menu, MF_STRING, CmdAsk, "Ask Lou\tAlt+Space");
        AppendMenu(menu, MF_STRING, CmdOpen, "Open Lou");
        AppendMenu(menu, MF_SEPARATOR, 0, null);
        AppendMenu(menu, MF_STRING | (paused ? MF_CHECKED : 0), CmdPause, "Pause assistant");
        AppendMenu(menu, MF_SEPARATOR, 0, null);
        AppendMenu(menu, MF_STRING, CmdQuit, "Quit Lou");
        GetCursorPos(out var pt);
        SetForegroundWindow(_window.Handle);
        var cmd = TrackPopupMenuEx(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_BOTTOMALIGN, pt.X, pt.Y, _window.Handle, 0);
        PostMessage(_window.Handle, WM_NULL, 0, 0);
        DestroyMenu(menu);
        return cmd;
    }

    private NOTIFYICONDATA Data(string tip = "Lou") => new()
    {
        cbSize = (uint)Marshal.SizeOf<NOTIFYICONDATA>(),
        hWnd = _window.Handle,
        uID = 1,
        uCallbackMessage = WM_TRAY,
        hIcon = _icon,
        szTip = tip,
        szInfo = "",
        szInfoTitle = "",
    };

    public void Dispose()
    {
        if (!_added) return;
        var data = Data();
        Shell_NotifyIcon(NIM_DELETE, ref data);
        _added = false;
    }
}
