using System.Text.Json.Serialization;

namespace FalloutMaW.Launcher.Core;

public sealed class ChannelManifest
{
    [JsonPropertyName("schemaVersion")]
    public int SchemaVersion { get; set; }

    [JsonPropertyName("productId")]
    public string ProductId { get; set; } = "";

    [JsonPropertyName("channel")]
    public string Channel { get; set; } = "";

    [JsonPropertyName("publishedAt")]
    public DateTimeOffset PublishedAt { get; set; }

    [JsonPropertyName("sequence")]
    public long Sequence { get; set; }

    [JsonPropertyName("signature")]
    public SignatureDescriptor Signature { get; set; } = new();

    [JsonPropertyName("system")]
    public SystemRelease System { get; set; } = new();
}

public sealed class SignatureDescriptor
{
    [JsonPropertyName("algorithm")]
    public string Algorithm { get; set; } = "";

    [JsonPropertyName("keyId")]
    public string KeyId { get; set; } = "";

    [JsonPropertyName("url")]
    public string Url { get; set; } = "";
}

public sealed class SystemRelease
{
    [JsonPropertyName("version")]
    public string Version { get; set; } = "";

    [JsonPropertyName("minimumLauncherVersion")]
    public string MinimumLauncherVersion { get; set; } = "1.0.0";

    [JsonPropertyName("foundryCompatibility")]
    public FoundryCompatibility FoundryCompatibility { get; set; } = new();

    [JsonPropertyName("foundryManifestUrl")]
    public string FoundryManifestUrl { get; set; } = "";

    [JsonPropertyName("releaseNotes")]
    public string ReleaseNotes { get; set; } = "";

    [JsonPropertyName("full")]
    public FullReleaseArtifact Full { get; set; } = new();

    [JsonPropertyName("patches")]
    public List<PatchArtifact> Patches { get; set; } = [];
}

public sealed class FoundryCompatibility
{
    [JsonPropertyName("minimum")]
    public string Minimum { get; set; } = "";

    [JsonPropertyName("verified")]
    public string Verified { get; set; } = "";
}

public class ReleaseArtifact
{
    [JsonPropertyName("url")]
    public string Url { get; set; } = "";

    [JsonPropertyName("size")]
    public long Size { get; set; }

    [JsonPropertyName("sha256")]
    public string Sha256 { get; set; } = "";
}

public sealed class FullReleaseArtifact : ReleaseArtifact
{
    [JsonPropertyName("version")]
    public string Version { get; set; } = "";
}

public sealed class PatchArtifact : ReleaseArtifact
{
    [JsonPropertyName("from")]
    public string From { get; set; } = "";

    [JsonPropertyName("to")]
    public string To { get; set; } = "";
}

public sealed class ReleaseReceipt
{
    [JsonPropertyName("schemaVersion")]
    public int SchemaVersion { get; set; }

    [JsonPropertyName("productId")]
    public string ProductId { get; set; } = "";

    [JsonPropertyName("version")]
    public string Version { get; set; } = "";

    [JsonPropertyName("fingerprint")]
    public string Fingerprint { get; set; } = "";

    [JsonPropertyName("preserve")]
    public List<string> Preserve { get; set; } = [];

    [JsonPropertyName("files")]
    public Dictionary<string, FileReceipt> Files { get; set; } = new(StringComparer.Ordinal);
}

public class FileReceipt
{
    [JsonPropertyName("size")]
    public long Size { get; set; }

    [JsonPropertyName("sha256")]
    public string Sha256 { get; set; } = "";
}

public sealed class PatchPackage
{
    [JsonPropertyName("schemaVersion")]
    public int SchemaVersion { get; set; }

    [JsonPropertyName("productId")]
    public string ProductId { get; set; } = "";

    [JsonPropertyName("from")]
    public string From { get; set; } = "";

    [JsonPropertyName("to")]
    public string To { get; set; } = "";

    [JsonPropertyName("fromFingerprint")]
    public string FromFingerprint { get; set; } = "";

    [JsonPropertyName("toFingerprint")]
    public string ToFingerprint { get; set; } = "";

    [JsonPropertyName("writes")]
    public List<PatchWrite> Writes { get; set; } = [];

    [JsonPropertyName("deletes")]
    public List<string> Deletes { get; set; } = [];

    [JsonPropertyName("preserve")]
    public List<string> Preserve { get; set; } = [];
}

public sealed class PatchWrite : FileReceipt
{
    [JsonPropertyName("path")]
    public string Path { get; set; } = "";
}

public sealed class LauncherSettings
{
    public string DataPath { get; set; } = "";
    public string ManifestUrl { get; set; } = "";
    public string FoundryExecutable { get; set; } = "";
    public bool AllowUnsignedManifest { get; set; }
    public long HighestTrustedSequence { get; set; }
    public string HighestTrustedVersion { get; set; } = "";
}

public sealed record UpdatePlan(
    ChannelManifest Manifest,
    Uri ManifestUri,
    string? InstalledVersion,
    IReadOnlyList<PatchArtifact> Patches,
    bool UseFullPackage,
    bool IsUpdateAvailable,
    string Description);

public sealed record ProgressInfo(string Phase, long Completed, long? Total, string Message)
{
    public double? Percent => Total is > 0 ? Math.Clamp(Completed * 100d / Total.Value, 0d, 100d) : null;
}
