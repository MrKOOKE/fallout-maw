using System.Reflection;
using System.Text;

namespace FalloutMaW.Launcher.Core;

public static class PublisherDefaults
{
    public static string ManifestUrl => DecodeMetadata("PublisherManifestUrlBase64");
    public static string PublicKeyPem => DecodeMetadata("PublisherPublicKeyBase64");

    private static string DecodeMetadata(string key)
    {
        var assembly = Assembly.GetEntryAssembly() ?? typeof(PublisherDefaults).Assembly;
        var encoded = assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(attribute => attribute.Key == key)?.Value;
        if (string.IsNullOrWhiteSpace(encoded)) return "";
        try
        {
            return Encoding.UTF8.GetString(Convert.FromBase64String(encoded));
        }
        catch (FormatException)
        {
            return "";
        }
    }
}
