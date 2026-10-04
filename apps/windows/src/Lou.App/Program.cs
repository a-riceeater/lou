using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;

namespace Lou.App;

/// <summary>
/// Custom entry point: enforce a single instance (a second launch just opens the
/// palette in the running instance), then start the WinUI application.
/// </summary>
public static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        // Headless provisioning: Lou.exe --pair <server-url> <pairing-code> [device-name]
        if (args.Length >= 3 && args[0] == "--pair") return Pair(args[1], args[2], args.Length > 3 ? args[3] : Environment.MachineName);
        if (args.Length >= 1 && args[0] == "--unpair")
        {
            new Lou.Agent.Security.CredentialStore().Clear();
            return 0;
        }

        WinRT.ComWrappersSupport.InitializeComWrappers();
        var instance = AppInstance.FindOrRegisterForKey("lou-desktop");
        if (!instance.IsCurrent)
        {
            var activation = AppInstance.GetCurrent().GetActivatedEventArgs();
            instance.RedirectActivationToAsync(activation).AsTask().Wait();
            return 0;
        }

        Application.Start(p =>
        {
            var context = new DispatcherQueueSynchronizationContext(DispatcherQueue.GetForCurrentThread());
            SynchronizationContext.SetSynchronizationContext(context);
            _ = new App();
        });
        return 0;
    }

    private static int Pair(string serverUrl, string code, string name)
    {
        try
        {
            var capabilities = new[] { "open_app", "open_file", "open_url", "search_files", "clipboard_read", "clipboard_write", "active_window", "ui_automation", "notifications" };
            var creds = Lou.Agent.Connection.ApiClient
                .RegisterAsync(serverUrl, new Lou.Agent.Protocol.DeviceRegisterRequest(code, name, "windows", "0.1.0", capabilities))
                .GetAwaiter()
                .GetResult();
            new Lou.Agent.Security.CredentialStore().Save(creds);
            Console.WriteLine($"Paired as {creds.DeviceId} with {creds.ServerUrl}");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Pairing failed: {ex.Message}");
            return 1;
        }
    }
}
