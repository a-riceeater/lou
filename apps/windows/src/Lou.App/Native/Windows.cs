using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.Web.WebView2.Core;
using Windows.Graphics;
using WinRT.Interop;
using static Lou.App.Native.NativeMethods;

namespace Lou.App.Native;

/// <summary>
/// The floating assistant (Alt+Space): borderless, always on top, translucent
/// acrylic, hidden from Alt+Tab, positioned on the monitor with the cursor, and
/// dismissed when it loses focus.
/// </summary>
internal sealed class PaletteWindow : Window
{
    private const int WidthDip = 680;
    private readonly WebView2 _web = new();
    private int _heightDip = 72;

    public PaletteWindow()
    {
        Title = "Lou";
        // Opened by hotkey, so WinUI would draw its keyboard focus rectangle around the whole page.
        _web.UseSystemFocusVisuals = false;
        _web.FocusVisualPrimaryThickness = new Thickness(0);
        _web.FocusVisualSecondaryThickness = new Thickness(0);
        Content = new Grid { Background = new SolidColorBrush(Colors.Transparent), Children = { _web } };
        SystemBackdrop = new DesktopAcrylicBackdrop();
        var presenter = OverlappedPresenter.CreateForDialog();
        presenter.SetBorderAndTitleBar(false, false);
        presenter.IsResizable = false;
        presenter.IsAlwaysOnTop = true;
        AppWindow.SetPresenter(presenter);
        AppWindow.IsShownInSwitchers = false;
        var corner = 2; // DWMWCP_ROUND
        DwmSetWindowAttribute(Hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref corner, sizeof(int));
        // Windows 11 outlines rounded windows with a light 1px border; the acrylic panel needs none.
        var border = DWMWA_COLOR_NONE;
        DwmSetWindowAttribute(Hwnd, DWMWA_BORDER_COLOR, ref border, sizeof(int));
        Activated += (_, e) =>
        {
            if (e.WindowActivationState == WindowActivationState.Deactivated) Hide();
        };
        AppWindow.Closing += (_, e) =>
        {
            e.Cancel = true;
            Hide();
        };
    }

    public nint Hwnd => WindowNative.GetWindowHandle(this);
    public CoreWebView2? Core => _web.CoreWebView2;
    public bool Visible => AppWindow.IsVisible;

    public Task InitializeAsync(Action<CoreWebView2, string> onMessage) => WebViewHost.InitializeAsync(_web, "#/palette", onMessage);

    public void ShowAtCursor()
    {
        GetCursorPos(out var pt);
        var area = DisplayArea.GetFromPoint(new PointInt32(pt.X, pt.Y), DisplayAreaFallback.Nearest).WorkArea;
        var scale = Scale;
        var width = (int)(WidthDip * scale);
        var height = (int)Math.Ceiling(_heightDip * scale);
        AppWindow.MoveAndResize(new RectInt32(area.X + (area.Width - width) / 2, area.Y + (int)(area.Height * 0.2), width, height));
        AppWindow.Show();
        Activate();
        SetForegroundWindow(Hwnd);
        // Programmatic focus right after a key press counts as keyboard focus and shows the focus visual; pointer focus never does.
        _web.Focus(FocusState.Pointer);
    }

    public void Hide() => AppWindow.Hide();

    public void ResizeTo(double heightDip)
    {
        _heightDip = (int)Math.Clamp(heightDip, 56, 720);
        var size = AppWindow.Size;
        AppWindow.Resize(new SizeInt32(size.Width, (int)Math.Ceiling(_heightDip * Scale)));
    }

    private double Scale => GetDpiForWindow(Hwnd) / 96.0;
}

/// <summary>Main window (Inbox, History, Skills, …): Mica, content extends into the title bar; closing hides to tray.</summary>
internal sealed class MainWindow : Window
{
    private readonly WebView2 _web = new();

    public MainWindow()
    {
        Title = "Lou";
        Content = new Grid { Children = { _web } };
        SystemBackdrop = new MicaBackdrop();
        AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "lou.ico"));
        AppWindow.TitleBar.ExtendsContentIntoTitleBar = true;
        AppWindow.TitleBar.ButtonBackgroundColor = Colors.Transparent;
        AppWindow.TitleBar.ButtonInactiveBackgroundColor = Colors.Transparent;
        var scale = GetDpiForWindow(WindowNative.GetWindowHandle(this)) / 96.0;
        AppWindow.Resize(new SizeInt32((int)(1000 * scale), (int)(680 * scale)));
        AppWindow.Closing += (_, e) =>
        {
            e.Cancel = true;
            AppWindow.Hide();
        };
    }

    public CoreWebView2? Core => _web.CoreWebView2;

    public Task InitializeAsync(Action<CoreWebView2, string> onMessage) => WebViewHost.InitializeAsync(_web, "#/app/inbox", onMessage);

    public void ShowAndFocus()
    {
        AppWindow.Show();
        Activate();
        SetForegroundWindow(WindowNative.GetWindowHandle(this));
    }
}
