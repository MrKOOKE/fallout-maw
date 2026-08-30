using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FalloutMaW.Launcher.Core;

if (args.Length == 3 && args[0] == "--verify-channel")
{
    var manifestBytes = await File.ReadAllBytesAsync(args[1]);
    var manifest = JsonSerializer.Deserialize<ChannelManifest>(manifestBytes)
        ?? throw new InvalidDataException("Cannot parse channel manifest.");
    var signaturePath = Path.Combine(Path.GetDirectoryName(args[1])!, manifest.Signature.Url);
    ManifestSecurity.Verify(manifestBytes, await File.ReadAllBytesAsync(signaturePath), manifest.Signature, await File.ReadAllTextAsync(args[2]));
    Console.WriteLine($"Node/.NET channel signature compatibility: OK ({manifest.Signature.KeyId})");
}
else
{
    var test = new SmokeTest();
    await test.RunAsync();
    Console.WriteLine("Launcher smoke tests: OK");
}

internal sealed class SmokeTest
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };
    private readonly string _temporaryRoot = Path.Combine(Path.GetTempPath(), "fallout-maw-launcher-tests-" + Guid.NewGuid().ToString("N"));

    public async Task RunAsync()
    {
        try
        {
            Directory.CreateDirectory(_temporaryRoot);
            TestSemanticVersions();
            TestPathSafety();
            TestManifestSignature();
            await TestInstallPatchAndRollbackAsync();
        }
        finally
        {
            if (Directory.Exists(_temporaryRoot)) Directory.Delete(_temporaryRoot, true);
        }
    }

    private static void TestSemanticVersions()
    {
        Assert(SemanticVersion.Parse("1.2.3").CompareTo(SemanticVersion.Parse("1.2.3-beta.4")) > 0, "stable must be newer than prerelease");
        Assert(SemanticVersion.Parse("1.10.0").CompareTo(SemanticVersion.Parse("1.2.99")) > 0, "numeric comparison failed");
    }

    private static void TestPathSafety()
    {
        AssertThrows<InvalidDataException>(() => ArchiveService.NormalizeArchivePath("../escape.txt"));
        AssertThrows<InvalidDataException>(() => ArchiveService.NormalizeArchivePath("C:/escape.txt"));
        AssertThrows<InvalidDataException>(() => ArchiveService.NormalizeArchivePath("file.txt:stream"));
        AssertThrows<InvalidDataException>(() => ArchiveService.NormalizeArchivePath("CON.txt"));
        Assert(ArchiveService.NormalizeArchivePath("./src/main.mjs") == "src/main.mjs", "normal path failed");
    }

    private static void TestManifestSignature()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var bytes = Encoding.UTF8.GetBytes("signed manifest bytes");
        var signature = key.SignData(bytes, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);
        var descriptor = new SignatureDescriptor
        {
            Algorithm = ManifestSecurity.SupportedAlgorithm,
            KeyId = ManifestSecurity.ComputeKeyId(key),
            Url = "stable.json.sig"
        };
        ManifestSecurity.Verify(bytes, Convert.ToBase64String(signature), descriptor, key.ExportSubjectPublicKeyInfoPem());
        AssertThrows<CryptographicException>(() => ManifestSecurity.Verify(Encoding.UTF8.GetBytes("tampered"), Convert.ToBase64String(signature), descriptor, key.ExportSubjectPublicKeyInfoPem()));
    }

    private async Task TestInstallPatchAndRollbackAsync()
    {
        var dataPath = Path.Combine(_temporaryRoot, "FoundryVTT", "Data");
        var downloads = Path.Combine(_temporaryRoot, "downloads");
        var fullZip = Path.Combine(_temporaryRoot, "full.zip");
        var patchZip = Path.Combine(_temporaryRoot, "patch.zip");

        var version1Files = new Dictionary<string, byte[]>
        {
            ["system.json"] = JsonBytes(new { id = "fallout-maw", version = "1.0.0" }),
            ["src/main.mjs"] = Encoding.UTF8.GetBytes("export const value = 1;\n"),
            ["unchanged.txt"] = Encoding.UTF8.GetBytes("stable bytes\n"),
            ["obsolete.txt"] = Encoding.UTF8.GetBytes("old\n")
        };
        var receipt1 = MakeReceipt("1.0.0", version1Files, '1');
        CreateFullZip(fullZip, version1Files, receipt1);

        var fullArtifact = MakeArtifact("1.0.0", "../../releases/1.0.0/full.zip", fullZip);
        var manifest1 = MakeManifest(1, "1.0.0", fullArtifact, []);
        var manifest1Bytes = JsonSerializer.SerializeToUtf8Bytes(manifest1, JsonOptions);
        var handler = new MemoryHandler(new Dictionary<string, byte[]>
        {
            ["https://updates.example/releases/1.0.0/full.zip"] = await File.ReadAllBytesAsync(fullZip),
            ["https://updates.example/channels/stable.json"] = manifest1Bytes
        });
        using var client = new HttpClient(handler);
        using var downloader = new HttpDownloader(client);
        using var engine = new UpdateEngine(downloader, isFoundryRunning: () => false);
        var settings = new LauncherSettings
        {
            DataPath = dataPath,
            ManifestUrl = "https://updates.example/channels/stable.json",
            AllowUnsignedManifest = true
        };

        var plan1 = await engine.CheckAsync(settings, CancellationToken.None);
        Assert(plan1.UseFullPackage && plan1.IsUpdateAvailable, "initial full plan expected");
        await engine.InstallAsync(plan1, settings, downloads, false, null, CancellationToken.None);
        Assert(UpdateEngine.GetInstalledVersion(dataPath) == "1.0.0", "initial install failed");
        var installed = Path.Combine(dataPath, "systems", "fallout-maw");
        File.WriteAllText(Path.Combine(installed, "storage", "user.txt"), "keep me");

        var version2Files = new Dictionary<string, byte[]>
        {
            ["system.json"] = JsonBytes(new { id = "fallout-maw", version = "1.1.0" }),
            ["src/main.mjs"] = Encoding.UTF8.GetBytes("export const value = 2;\n"),
            ["unchanged.txt"] = Encoding.UTF8.GetBytes("stable bytes\n"),
            ["new.txt"] = Encoding.UTF8.GetBytes("new\n")
        };
        var receipt2 = MakeReceipt("1.1.0", version2Files, '2');
        CreatePatchZip(patchZip, receipt1, receipt2, version2Files);
        var patchArtifact = new PatchArtifact
        {
            From = "1.0.0",
            To = "1.1.0",
            Url = "../../patches/1.0.0--1.1.0/patch.zip",
            Size = new FileInfo(patchZip).Length,
            Sha256 = ManifestSecurity.ComputeFileSha256(patchZip)
        };
        var manifest2 = MakeManifest(2, "1.1.0", fullArtifact, [patchArtifact]);
        handler.Set("https://updates.example/channels/stable.json", JsonSerializer.SerializeToUtf8Bytes(manifest2, JsonOptions));
        handler.Set("https://updates.example/patches/1.0.0--1.1.0/patch.zip", await File.ReadAllBytesAsync(patchZip));

        var plan2 = await engine.CheckAsync(settings, CancellationToken.None);
        Assert(!plan2.UseFullPackage && plan2.Patches.Count == 1, "patch plan expected");
        File.WriteAllText(Path.Combine(installed, "unchanged.txt"), "corrupted locally\n");
        var validationStaging = Path.Combine(dataPath, "systems", ".fallout-maw.validation-test");
        var archiveService = new ArchiveService();
        await AssertThrowsAsync<InvalidDataException>(() =>
            archiveService.PreparePatchAsync(
                patchZip,
                installed,
                validationStaging,
                "fallout-maw",
                "1.0.0",
                "1.1.0",
                null,
                CancellationToken.None));
        File.WriteAllText(Path.Combine(installed, "unchanged.txt"), "stable bytes\n");
        await engine.InstallAsync(plan2, settings, downloads, false, null, CancellationToken.None);
        Assert(UpdateEngine.GetInstalledVersion(dataPath) == "1.1.0", "patch install failed");
        Assert(!File.Exists(Path.Combine(installed, "obsolete.txt")), "deleted file survived patch");
        Assert(File.Exists(Path.Combine(installed, "new.txt")), "new file missing after patch");
        Assert(File.ReadAllText(Path.Combine(installed, "storage", "user.txt")) == "keep me", "storage was not preserved");

        File.WriteAllText(Path.Combine(installed, "unchanged.txt"), "changed after update\n");
        engine.Rollback(dataPath);
        Assert(UpdateEngine.GetInstalledVersion(dataPath) == "1.0.0", "rollback failed");
        Assert(File.ReadAllText(Path.Combine(installed, "unchanged.txt")) == "stable bytes\n", "rollback backup shared a hard link with the active installation");
        Assert(File.ReadAllText(Path.Combine(installed, "storage", "user.txt")) == "keep me", "storage was not preserved by rollback");

        var cleanDataPath = Path.Combine(_temporaryRoot, "CleanFoundryVTT", "Data");
        var cleanSettings = new LauncherSettings
        {
            DataPath = cleanDataPath,
            ManifestUrl = settings.ManifestUrl,
            AllowUnsignedManifest = true
        };
        var cleanPlan = await engine.CheckAsync(cleanSettings, CancellationToken.None);
        Assert(cleanPlan.UseFullPackage && cleanPlan.Patches.Count == 1, "clean install must use baseline plus patch chain");
        await engine.InstallAsync(cleanPlan, cleanSettings, downloads, false, null, CancellationToken.None);
        Assert(UpdateEngine.GetInstalledVersion(cleanDataPath) == "1.1.0", "baseline plus patch clean install failed");
    }

    private static ChannelManifest MakeManifest(long sequence, string version, FullReleaseArtifact full, List<PatchArtifact> patches) => new()
    {
        SchemaVersion = 1,
        ProductId = "fallout-maw",
        Channel = "stable",
        PublishedAt = DateTimeOffset.UtcNow,
        Sequence = sequence,
        Signature = new SignatureDescriptor
        {
            Algorithm = ManifestSecurity.SupportedAlgorithm,
            KeyId = new string('b', 64),
            Url = "stable.json.sig"
        },
        System = new SystemRelease
        {
            Version = version,
            MinimumLauncherVersion = "1.0.0",
            Full = full,
            Patches = patches,
            ReleaseNotes = "Smoke test"
        }
    };

    private static FullReleaseArtifact MakeArtifact(string version, string url, string path) => new()
    {
        Version = version,
        Url = url,
        Size = new FileInfo(path).Length,
        Sha256 = ManifestSecurity.ComputeFileSha256(path)
    };

    private static ReleaseReceipt MakeReceipt(string version, Dictionary<string, byte[]> files, char fingerprintCharacter)
    {
        var receipts = files.ToDictionary(
            pair => pair.Key,
            pair => new FileReceipt { Size = pair.Value.Length, Sha256 = Sha(pair.Value) },
            StringComparer.Ordinal);
        return new ReleaseReceipt
        {
            SchemaVersion = 1,
            ProductId = "fallout-maw",
            Version = version,
            Fingerprint = new string(fingerprintCharacter, 64),
            Preserve = ["storage/**"],
            Files = receipts
        };
    }

    private static void CreateFullZip(string path, Dictionary<string, byte[]> files, ReleaseReceipt receipt)
    {
        using var archive = ZipFile.Open(path, ZipArchiveMode.Create);
        foreach (var pair in files) WriteEntry(archive, pair.Key, pair.Value);
        WriteEntry(archive, ArchiveService.ReceiptEntryName, JsonSerializer.SerializeToUtf8Bytes(receipt, JsonOptions));
        WriteEntry(archive, "storage/default.txt", Encoding.UTF8.GetBytes("default\n"));
    }

    private static void CreatePatchZip(string path, ReleaseReceipt from, ReleaseReceipt to, Dictionary<string, byte[]> targetFiles)
    {
        var changedFiles = targetFiles.Where(pair =>
            !from.Files.TryGetValue(pair.Key, out var existing)
            || existing.Size != pair.Value.Length
            || !string.Equals(existing.Sha256, Sha(pair.Value), StringComparison.OrdinalIgnoreCase)).ToList();
        var writes = changedFiles.Select(pair => new PatchWrite
        {
            Path = pair.Key,
            Size = pair.Value.Length,
            Sha256 = Sha(pair.Value)
        }).ToList();
        var patch = new PatchPackage
        {
            SchemaVersion = 1,
            ProductId = "fallout-maw",
            From = from.Version,
            To = to.Version,
            FromFingerprint = from.Fingerprint,
            ToFingerprint = to.Fingerprint,
            Writes = writes,
            Deletes = ["obsolete.txt"],
            Preserve = ["storage/**"]
        };
        using var archive = ZipFile.Open(path, ZipArchiveMode.Create);
        WriteEntry(archive, ArchiveService.PatchEntryName, JsonSerializer.SerializeToUtf8Bytes(patch, JsonOptions));
        WriteEntry(archive, ArchiveService.BaseReceiptEntryName, JsonSerializer.SerializeToUtf8Bytes(from, JsonOptions));
        WriteEntry(archive, ArchiveService.ReceiptEntryName, JsonSerializer.SerializeToUtf8Bytes(to, JsonOptions));
        foreach (var pair in changedFiles) WriteEntry(archive, "payload/" + pair.Key, pair.Value);
    }

    private static void WriteEntry(ZipArchive archive, string name, byte[] contents)
    {
        var entry = archive.CreateEntry(name, CompressionLevel.Fastest);
        using var stream = entry.Open();
        stream.Write(contents);
    }

    private static byte[] JsonBytes(object value) => JsonSerializer.SerializeToUtf8Bytes(value, JsonOptions);
    private static string Sha(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException("Assertion failed: " + message);
    }

    private static void AssertThrows<T>(Action action) where T : Exception
    {
        try
        {
            action();
        }
        catch (T)
        {
            return;
        }
        throw new InvalidOperationException($"Expected exception {typeof(T).Name}.");
    }

    private static async Task AssertThrowsAsync<T>(Func<Task> action) where T : Exception
    {
        try
        {
            await action();
        }
        catch (T)
        {
            return;
        }
        throw new InvalidOperationException($"Expected exception {typeof(T).Name}.");
    }

    private sealed class MemoryHandler(Dictionary<string, byte[]> responses) : HttpMessageHandler
    {
        private readonly Dictionary<string, byte[]> _responses = responses;

        public void Set(string uri, byte[] value) => _responses[uri] = value;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var uri = request.RequestUri?.AbsoluteUri ?? "";
            if (!_responses.TryGetValue(uri, out var bytes))
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
            var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) };
            response.Content.Headers.ContentLength = bytes.Length;
            return Task.FromResult(response);
        }
    }
}
