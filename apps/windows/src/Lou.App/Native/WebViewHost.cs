using Microsoft.UI;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;

namespace Lou.App.Native;

/// <summary>
/// Hardened WebView2 setup shared by both windows: bundled UI served from a
/// virtual host, transparent background over the window's native material, no
/// navigation away from the app, no new windows, microphone only for the app.
/// </summary>
internal static class WebViewHost
{
    public const string AppHost = "app.lou.local";
    private static CoreWebView2Environment? _environment;

    /// <summary>Set LOU_UI_DEV_URL=http://localhost:5173 to load the Vite dev server (hot reload).</summary>
    public static string? DevUrl => Environment.GetEnvironmentVariable("LOU_UI_DEV_URL");

    public static string Origin => DevUrl?.TrimEnd('/') ?? $"https://{AppHost}";

    public static async Task InitializeAsync(WebView2 view, string hash, Action<CoreWebView2, string> onMessage)
    {
        view.DefaultBackgroundColor = Colors.Transparent;
        _environment ??= await CoreWebView2Environment.CreateWithOptionsAsync(
            null,
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Lou", "WebView2"),
            new CoreWebView2EnvironmentOptions());
        await view.EnsureCoreWebView2Async(_environment);
        var core = view.CoreWebView2;

        var s = core.Settings;
        s.AreDefaultContextMenusEnabled = false;
        s.AreBrowserAcceleratorKeysEnabled = false;
        s.IsStatusBarEnabled = false;
        s.IsZoomControlEnabled = false;
        s.IsPasswordAutosaveEnabled = false;
        s.IsGeneralAutofillEnabled = false;
        s.IsNonClientRegionSupportEnabled = true;
#if DEBUG
        s.AreDevToolsEnabled = true;
#else
        s.AreDevToolsEnabled = DevUrl is not null;
#endif

        var wwwroot = Path.Combine(AppContext.BaseDirectory, "wwwroot");
        core.SetVirtualHostNameToFolderMapping(AppHost, wwwroot, CoreWebView2HostResourceAccessKind.DenyCors);

        core.NavigationStarting += (_, e) =>
        {
            if (!e.Uri.StartsWith(Origin, StringComparison.OrdinalIgnoreCase)) e.Cancel = true;
        };
        core.NewWindowRequested += (_, e) => e.Handled = true;
        core.PermissionRequested += (_, e) =>
        {
            var ours = e.Uri.StartsWith(Origin, StringComparison.OrdinalIgnoreCase);
            e.State = ours && e.PermissionKind == CoreWebView2PermissionKind.Microphone ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
        };
        core.WebMessageReceived += (_, e) =>
        {
            // Only our own page may talk to the native host.
            if (!e.Source.StartsWith(Origin, StringComparison.OrdinalIgnoreCase)) return;
            onMessage(core, e.WebMessageAsJson);
        };

        core.Navigate($"{Origin}/index.html{hash}");
    }
}
