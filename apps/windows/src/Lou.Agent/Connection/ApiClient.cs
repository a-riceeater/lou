using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Lou.Agent.Protocol;
using Lou.Agent.Security;

namespace Lou.Agent.Connection;

/// <summary>HTTPS API calls on behalf of the UI. The host attaches the device credential.</summary>
public sealed class ApiClient : IDisposable
{
    private static readonly HashSet<string> AllowedMethods = ["GET", "POST", "PATCH", "DELETE"];
    private readonly HttpClient _http;

    public ApiClient(DeviceCredentials creds, HttpMessageHandler? handler = null)
    {
        _http = handler is null ? new HttpClient() : new HttpClient(handler);
        _http.BaseAddress = new Uri(creds.ServerUrl.TrimEnd('/') + "/");
        _http.Timeout = TimeSpan.FromSeconds(60);
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", creds.DeviceToken);
    }

    public async Task<(int Status, JsonElement Body)> SendAsync(string method, string path, JsonElement? body, CancellationToken ct = default)
    {
        // The UI may only reach the device API, never arbitrary URLs.
        if (!AllowedMethods.Contains(method)) throw new ArgumentException("Method not allowed");
        if (!path.StartsWith("/api/", StringComparison.Ordinal) || path.Contains("..", StringComparison.Ordinal) || path.Contains("://", StringComparison.Ordinal))
            throw new ArgumentException("Path not allowed");

        using var request = new HttpRequestMessage(new HttpMethod(method), path.TrimStart('/'));
        if (body is { ValueKind: not JsonValueKind.Undefined and not JsonValueKind.Null } b)
            request.Content = new StringContent(b.GetRawText(), Encoding.UTF8, "application/json");
        using var response = await _http.SendAsync(request, ct);
        var text = await response.Content.ReadAsStringAsync(ct);
        var json = string.IsNullOrWhiteSpace(text) ? JsonDocument.Parse("null").RootElement : JsonDocument.Parse(text).RootElement.Clone();
        return ((int)response.StatusCode, json);
    }

    public async Task<JsonElement> TranscribeAsync(byte[] audio, string mimeType, CancellationToken ct = default)
    {
        using var form = new MultipartFormDataContent();
        var file = new ByteArrayContent(audio);
        file.Headers.ContentType = new MediaTypeHeaderValue(mimeType.Split(';')[0]);
        form.Add(file, "file", "voice.webm");
        using var response = await _http.PostAsync("api/transcribe", form, ct);
        var text = await response.Content.ReadAsStringAsync(ct);
        var json = JsonDocument.Parse(text).RootElement.Clone();
        if (!response.IsSuccessStatusCode)
        {
            var err = json.TryGetProperty("error", out var e) ? e : default;
            throw new BridgeException(err.ValueKind == JsonValueKind.Object ? err.GetProperty("code").GetString() ?? "UPSTREAM_ERROR" : "UPSTREAM_ERROR",
                err.ValueKind == JsonValueKind.Object ? err.GetProperty("message").GetString() ?? "Transcription failed." : "Transcription failed.");
        }
        return json;
    }

    /// <summary>Exchanges a one-time pairing code for device credentials.</summary>
    public static async Task<DeviceCredentials> RegisterAsync(string serverUrl, DeviceRegisterRequest request, HttpMessageHandler? handler = null, CancellationToken ct = default)
    {
        var url = NormalizeServerUrl(serverUrl);
        using var http = handler is null ? new HttpClient() : new HttpClient(handler);
        http.Timeout = TimeSpan.FromSeconds(20);
        HttpResponseMessage response;
        try
        {
            response = await http.PostAsync(new Uri(new Uri(url), "/api/devices/register"), new StringContent(Json.Serialize(request), Encoding.UTF8, "application/json"), ct);
        }
        catch (HttpRequestException)
        {
            throw new BridgeException("OFFLINE", "Can't reach that server. Check the address.");
        }
        var text = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode) throw RegistrationError(response.StatusCode, text, url);
        DeviceRegisterResponse? reg = null;
        try
        {
            reg = Json.Deserialize<DeviceRegisterResponse>(text);
        }
        catch (JsonException) { /* reported below */ }
        if (reg is null || string.IsNullOrEmpty(reg.DeviceId) || string.IsNullOrEmpty(reg.DeviceToken))
            throw new BridgeException("PAIRING_FAILED", $"{url} didn't answer like a Lou server. Check the address and that your proxy forwards it to Lou.");
        return new DeviceCredentials(url, reg.DeviceId, reg.DeviceToken, reg.CommandKey, reg.UserId);
    }

    /// <summary>
    /// Pairing failures are not "signed out": they say why the code was refused,
    /// or that something other than Lou (a proxy, an old server) answered.
    /// </summary>
    internal static BridgeException RegistrationError(HttpStatusCode status, string body, string url)
    {
        string? message = null;
        try
        {
            message = JsonDocument.Parse(body).RootElement.GetProperty("error").GetProperty("message").GetString();
        }
        catch { /* not a Lou error body */ }
        return (int)status switch
        {
            401 or 403 => new BridgeException("PAIRING_REJECTED",
                $"{message ?? "The server refused that pairing code."} Codes work once and expire after 10 minutes; create one on the server this address reaches."),
            429 => new BridgeException("RATE_LIMITED", "Too many pairing attempts. Wait a minute, then try again."),
            _ when message is not null => new BridgeException("PAIRING_FAILED", message),
            _ => new BridgeException("PAIRING_FAILED",
                $"{url} answered HTTP {(int)status} instead of Lou. Check the address and that your proxy forwards it to Lou (127.0.0.1:8787)."),
        };
    }

    /// <summary>TLS everywhere except loopback during development (SECURITY.md §7).</summary>
    public static string NormalizeServerUrl(string input)
    {
        var raw = input.Trim().TrimEnd('/');
        if (!raw.Contains("://", StringComparison.Ordinal)) raw = "https://" + raw;
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var uri)) throw new BridgeException("VALIDATION_FAILED", "That doesn't look like a server address.");
        var loopback = uri.IsLoopback;
        if (uri.Scheme == Uri.UriSchemeHttp && !loopback) throw new BridgeException("VALIDATION_FAILED", "Use an https:// address for your server.");
        if (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp) throw new BridgeException("VALIDATION_FAILED", "Unsupported address.");
        return uri.GetLeftPart(UriPartial.Authority);
    }

    public void Dispose() => _http.Dispose();
}

public sealed class BridgeException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}
