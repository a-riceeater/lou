using System.Security.Cryptography;
using System.Text;
using Lou.Agent.Protocol;

namespace Lou.Agent.Security;

public sealed record DeviceCredentials(string ServerUrl, string DeviceId, string DeviceToken, string CommandKey, string UserId, string? PinnedCertSha256 = null);

/// <summary>
/// Stores the device credential with Windows DPAPI (current-user scope), so it is
/// unreadable by other users and useless if copied to another machine. The token
/// never reaches the WebView; React talks to the server only through the host.
/// </summary>
public sealed class CredentialStore
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("lou.device.credentials.v1");
    private readonly string _path;

    public CredentialStore(string? directory = null)
    {
        var dir = directory ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Lou");
        Directory.CreateDirectory(dir);
        _path = Path.Combine(dir, "device.bin");
    }

    public DeviceCredentials? Load()
    {
        if (!File.Exists(_path)) return null;
        try
        {
            var plain = ProtectedData.Unprotect(File.ReadAllBytes(_path), Entropy, DataProtectionScope.CurrentUser);
            return Json.Deserialize<DeviceCredentials>(Encoding.UTF8.GetString(plain));
        }
        catch (Exception)
        {
            // Corrupt or from another user/machine: treat as unpaired.
            return null;
        }
    }

    public void Save(DeviceCredentials credentials)
    {
        var plain = Encoding.UTF8.GetBytes(Json.Serialize(credentials));
        var protectedBytes = ProtectedData.Protect(plain, Entropy, DataProtectionScope.CurrentUser);
        var tmp = _path + ".tmp";
        File.WriteAllBytes(tmp, protectedBytes);
        File.Move(tmp, _path, overwrite: true);
        CryptographicOperations.ZeroMemory(plain);
    }

    public void Clear()
    {
        if (File.Exists(_path)) File.Delete(_path);
    }
}
