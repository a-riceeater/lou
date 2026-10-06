using System.Net;
using System.Text;
using Lou.Agent.Connection;
using Lou.Agent.Protocol;
using Lou.Agent.Security;
using Xunit;

namespace Lou.Agent.Tests;

public class PairingTests
{
    private sealed class FixedResponse(HttpStatusCode status, string body, string mediaType = "application/json") : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, mediaType) });
    }

    private static readonly DeviceRegisterRequest Request = new("ABCD-EFGH", "PC", "windows", "test", []);

    private static Task<DeviceCredentials> Register(HttpStatusCode status, string body, string mediaType = "application/json") =>
        ApiClient.RegisterAsync("https://lou.example.com", Request, new FixedResponse(status, body, mediaType));

    [Fact]
    public async Task RefusedCodeIsReportedAsPairingNotSignOut()
    {
        var ex = await Assert.ThrowsAsync<BridgeException>(() => Register(HttpStatusCode.Unauthorized,
            """{"error":{"code":"UNAUTHORIZED","message":"That pairing code is invalid or has expired."}}"""));
        Assert.Equal("PAIRING_REJECTED", ex.Code);
        Assert.Contains("invalid or has expired", ex.Message);
        Assert.Contains("server this address reaches", ex.Message);
    }

    [Fact]
    public async Task NonLouResponsesNameTheStatus()
    {
        var ex = await Assert.ThrowsAsync<BridgeException>(() => Register(HttpStatusCode.BadGateway, "<html>Bad gateway</html>", "text/html"));
        Assert.Equal("PAIRING_FAILED", ex.Code);
        Assert.Contains("HTTP 502", ex.Message);

        ex = await Assert.ThrowsAsync<BridgeException>(() => Register(HttpStatusCode.OK, "<html>Welcome to nginx</html>", "text/html"));
        Assert.Equal("PAIRING_FAILED", ex.Code);
        Assert.Contains("didn't answer like a Lou server", ex.Message);
    }

    [Fact]
    public async Task RateLimitIsNotASignOut()
    {
        var ex = await Assert.ThrowsAsync<BridgeException>(() => Register(HttpStatusCode.TooManyRequests, """{"error":{"code":"RATE_LIMITED","message":"slow down"}}"""));
        Assert.Equal("RATE_LIMITED", ex.Code);
    }

    [Fact]
    public async Task SuccessfulRegistrationReturnsCredentials()
    {
        var creds = await Register(HttpStatusCode.Created,
            """{"deviceId":"dev_1","deviceToken":"lou_dev_x","commandKey":"a2V5","userId":"usr_1"}""");
        Assert.Equal("dev_1", creds.DeviceId);
        Assert.Equal("https://lou.example.com", creds.ServerUrl);
    }
}
