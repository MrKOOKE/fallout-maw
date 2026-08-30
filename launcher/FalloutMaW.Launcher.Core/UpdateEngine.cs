using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace FalloutMaW.Launcher.Core;

public sealed class UpdateEngine : IDisposable
{
    public const string ProductId = "fallout-maw";
    public const string LauncherVersion = "1.0.0";
    private const string SystemFolderName = "fallout-maw";
    private const string BackupFolderName = ".fallout-maw-launcher-backup";
    private const string JournalFileName = ".fallout-maw-launcher-transaction.json";
    private const string StorageHoldingName = ".fallout-maw-launcher-storage";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = false,
        WriteIndented = true
    };

    private readonly HttpDownloader _downloader;
    private readonly ArchiveService _archives;
    private readonly bool _ownsDownloader;
    private readonly Func<bool> _isFoundryRunning;

    public UpdateEngine(HttpDownloader? downloader = null, ArchiveService? archives = null, Func<bool>? isFoundryRunning = null)
    {
        _ownsDownloader = downloader is null;
        _downloader = downloader ?? new HttpDownloader();
        _archives = archives ?? new ArchiveService();
        _isFoundryRunning = isFoundryRunning ?? IsFoundryRunning;
    }

    public async Task<UpdatePlan> CheckAsync(LauncherSettings settings, CancellationToken cancellationToken)
    {
        var manifestUri = ParseManifestUri(settings.ManifestUrl);
        var manifestBytes = await _downloader.GetBytesLimitedAsync(manifestUri, 8 * 1024 * 1024, cancellationToken);
        var manifest = JsonSerializer.Deserialize<ChannelManifest>(manifestBytes, JsonOptions)
            ?? throw new InvalidDataException("Канал обновлений содержит пустой JSON.");
        ValidateManifest(manifest);

        var publicKey = PublisherDefaults.PublicKeyPem;
        if (!string.IsNullOrWhiteSpace(publicKey))
        {
            var signatureUri = ResolveArtifactUri(manifestUri, manifest.Signature.Url);
            if (!SameOrigin(manifestUri, signatureUri))
                throw new InvalidDataException("Файл подписи должен находиться на том же HTTPS-источнике, что и manifest.");
            var signatureBytes = await _downloader.GetBytesLimitedAsync(signatureUri, 64 * 1024, cancellationToken);
            ManifestSecurity.Verify(manifestBytes, signatureBytes, manifest.Signature, publicKey);
        }
        else if (!settings.AllowUnsignedManifest)
        {
            throw new InvalidOperationException("Эта сборка лаунчера не привязана к публичному ключу. Соберите publisher-версию или явно разрешите тестовый неподписанный канал.");
        }

        ValidateAntiRollback(manifest, settings);
        settings.HighestTrustedSequence = Math.Max(settings.HighestTrustedSequence, manifest.Sequence);
        settings.HighestTrustedVersion = manifest.System.Version;

        var installedVersion = GetInstalledVersion(settings.DataPath);
        var baselineVersion = manifest.System.Full.Version;
        var baselinePatches = RequirePatchChain(baselineVersion, manifest.System.Version, manifest.System.Patches);
        var recoveryBytes = checked(manifest.System.Full.Size + baselinePatches.Sum(patch => patch.Size));
        if (installedVersion is null)
        {
            return new UpdatePlan(manifest, manifestUri, null, baselinePatches, true, true,
                $"Система не установлена. Будет загружен baseline {baselineVersion} и обновления до {manifest.System.Version} ({FormatBytes(recoveryBytes)})." );
        }

        var installed = SemanticVersion.Parse(installedVersion);
        var available = SemanticVersion.Parse(manifest.System.Version);
        if (installed.CompareTo(available) == 0)
        {
            return new UpdatePlan(manifest, manifestUri, installedVersion, [], false, false,
                $"Установлена актуальная версия {installedVersion}.");
        }
        if (installed.CompareTo(available) > 0)
        {
            return new UpdatePlan(manifest, manifestUri, installedVersion, [], false, false,
                $"Локальная версия {installedVersion} новее опубликованной {manifest.System.Version}.");
        }

        var patches = FindCheapestPatchChain(installedVersion, manifest.System.Version, manifest.System.Patches);
        var patchBytes = patches.Sum(patch => patch.Size);
        var useFull = patches.Count == 0 || patchBytes >= recoveryBytes;
        var selectedPatches = useFull ? baselinePatches : patches;
        var description = useFull
            ? $"Доступна версия {manifest.System.Version}; восстановление от baseline займёт {FormatBytes(recoveryBytes)}."
            : $"Доступна версия {manifest.System.Version}; патчи займут {FormatBytes(patchBytes)}.";
        return new UpdatePlan(manifest, manifestUri, installedVersion, selectedPatches, useFull, true, description);
    }

    public async Task InstallAsync(
        UpdatePlan plan,
        LauncherSettings settings,
        string downloadsDirectory,
        bool forceFull,
        IProgress<ProgressInfo>? progress,
        CancellationToken cancellationToken)
    {
        EnsureFoundryClosed();
        var paths = EnsureInstallationPaths(settings.DataPath);
        RecoverInterruptedSwap(paths);
        ValidateExistingTarget(paths.Target);

        if (!forceFull && !plan.UseFullPackage && plan.Patches.Count > 0 && Directory.Exists(paths.Target))
        {
            try
            {
                await ApplyPatchChainAsync(plan.Patches, plan.ManifestUri, paths, downloadsDirectory, progress, cancellationToken);
                return;
            }
            catch (InvalidDataException error)
            {
                progress?.Report(new ProgressInfo("fallback", 0, null,
                    $"Патч неприменим ({error.Message}). Выполняется безопасное восстановление полным пакетом."));
                RecoverInterruptedSwap(paths);
            }
        }

        var full = plan.Manifest.System.Full;
        var fullUri = ResolveArtifactUri(plan.ManifestUri, full.Url);
        var fullArchive = await _downloader.DownloadAsync(fullUri, full, downloadsDirectory, progress, cancellationToken);
        var fullStaging = CreateStagingPath(paths.SystemsRoot);
        await _archives.PrepareFullAsync(
            fullArchive,
            fullStaging,
            ProductId,
            full.Version,
            Directory.Exists(paths.Target),
            progress,
            cancellationToken);
        SwapIntoPlace(paths, fullStaging);
        progress?.Report(new ProgressInfo("baseline", 1, 1, $"Baseline {full.Version} установлен."));

        var patchesAfterBaseline = RequirePatchChain(full.Version, plan.Manifest.System.Version, plan.Manifest.System.Patches);
        await ApplyPatchChainAsync(patchesAfterBaseline, plan.ManifestUri, paths, downloadsDirectory, progress, cancellationToken);
        progress?.Report(new ProgressInfo("done", 1, 1, $"Версия {plan.Manifest.System.Version} установлена."));
    }

    private async Task ApplyPatchChainAsync(
        IReadOnlyList<PatchArtifact> patches,
        Uri manifestUri,
        InstallationPaths paths,
        string downloadsDirectory,
        IProgress<ProgressInfo>? progress,
        CancellationToken cancellationToken)
    {
        foreach (var patch in patches)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var uri = ResolveArtifactUri(manifestUri, patch.Url);
            var archivePath = await _downloader.DownloadAsync(uri, patch, downloadsDirectory, progress, cancellationToken);
            var staging = CreateStagingPath(paths.SystemsRoot);
            await _archives.PreparePatchAsync(
                archivePath,
                paths.Target,
                staging,
                ProductId,
                patch.From,
                patch.To,
                progress,
                cancellationToken);
            SwapIntoPlace(paths, staging);
            progress?.Report(new ProgressInfo("patch", 1, 1, $"Патч {patch.From} → {patch.To} установлен."));
        }
    }

    public void Rollback(string dataPath)
    {
        EnsureFoundryClosed();
        var paths = EnsureInstallationPaths(dataPath);
        RecoverInterruptedSwap(paths);
        if (!Directory.Exists(paths.Target) || !Directory.Exists(paths.Backup))
            throw new InvalidOperationException("Рабочая резервная копия для отката отсутствует.");
        ValidateExistingTarget(paths.Target);
        ValidateExistingTarget(paths.Backup);

        var temporaryCurrent = CreateStagingPath(paths.SystemsRoot);
        DeletePathIfExists(paths.StorageHolding);
        var journal = new SwapJournal(paths.Target, paths.Backup, temporaryCurrent, paths.StorageHolding, "rollback-prepared");
        WriteJournal(paths.Journal, journal);
        try
        {
            var currentStorage = Path.Combine(paths.Target, "storage");
            if (Directory.Exists(currentStorage))
            {
                Directory.Move(currentStorage, paths.StorageHolding);
                journal.Phase = "rollback-storage-held";
                WriteJournal(paths.Journal, journal);
            }
            Directory.Move(paths.Target, temporaryCurrent);
            journal.Phase = "rollback-current-moved";
            WriteJournal(paths.Journal, journal);
            Directory.Move(paths.Backup, paths.Target);
            journal.Phase = "rollback-backup-moved";
            WriteJournal(paths.Journal, journal);
            Directory.Move(temporaryCurrent, paths.Backup);
            journal.Phase = "rollback-complete";
            WriteJournal(paths.Journal, journal);
            RestoreHeldStorage(paths);
            File.Delete(paths.Journal);
        }
        catch
        {
            RecoverInterruptedSwap(paths);
            throw;
        }
    }

    public void Recover(string dataPath) => RecoverInterruptedSwap(EnsureInstallationPaths(dataPath));

    public static string? GetInstalledVersion(string dataPath)
    {
        try
        {
            var manifestPath = Path.Combine(Path.GetFullPath(dataPath), "systems", SystemFolderName, "system.json");
            if (!File.Exists(manifestPath)) return null;
            using var document = JsonDocument.Parse(File.ReadAllText(manifestPath));
            if (!document.RootElement.TryGetProperty("id", out var id)
                || !string.Equals(id.GetString(), ProductId, StringComparison.Ordinal)) return null;
            return document.RootElement.TryGetProperty("version", out var version) ? version.GetString() : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public static bool IsFoundryRunning()
    {
        foreach (var process in Process.GetProcesses())
        {
            using (process)
            {
                try
                {
                    if (process.ProcessName.Contains("Foundry", StringComparison.OrdinalIgnoreCase)) return true;
                }
                catch (InvalidOperationException)
                {
                    // Process exited during enumeration.
                }
            }
        }
        return false;
    }

    public static void LaunchFoundry(string configuredExecutable)
    {
        var executable = configuredExecutable;
        if (string.IsNullOrWhiteSpace(executable) || !File.Exists(executable)) executable = SettingsStore.DetectFoundryExecutable();
        if (string.IsNullOrWhiteSpace(executable) || !File.Exists(executable))
            throw new FileNotFoundException("Не найден Foundry Virtual Tabletop.exe. Укажите путь в настройках.");
        Process.Start(new ProcessStartInfo(executable) { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(executable)! });
    }

    private static void SwapIntoPlace(InstallationPaths paths, string staging)
    {
        if (!Directory.Exists(staging)) throw new DirectoryNotFoundException(staging);
        DeletePathIfExists(paths.Backup);
        DeletePathIfExists(paths.StorageHolding);
        var journal = new SwapJournal(paths.Target, paths.Backup, staging, paths.StorageHolding, "prepared");
        WriteJournal(paths.Journal, journal);
        try
        {
            if (Directory.Exists(paths.Target))
            {
                Directory.Move(paths.Target, paths.Backup);
                journal.Phase = "backup-moved";
                WriteJournal(paths.Journal, journal);
                var oldStorage = Path.Combine(paths.Backup, "storage");
                if (Directory.Exists(oldStorage))
                {
                    Directory.Move(oldStorage, paths.StorageHolding);
                    journal.Phase = "storage-held";
                    WriteJournal(paths.Journal, journal);
                }
            }

            Directory.Move(staging, paths.Target);
            journal.Phase = "target-moved";
            WriteJournal(paths.Journal, journal);
            RestoreHeldStorage(paths);
            File.Delete(paths.Journal);
        }
        catch
        {
            RecoverInterruptedSwap(paths);
            throw;
        }
    }

    private static void RecoverInterruptedSwap(InstallationPaths paths)
    {
        if (!File.Exists(paths.Journal)) return;
        SwapJournal journal;
        try
        {
            journal = JsonSerializer.Deserialize<SwapJournal>(File.ReadAllText(paths.Journal), JsonOptions)
                ?? throw new InvalidDataException("Пустой transaction journal.");
        }
        catch (JsonException error)
        {
            throw new InvalidDataException("Повреждён transaction journal лаунчера; автоматическое удаление небезопасно.", error);
        }

        if (!PathsEqual(journal.Target, paths.Target)
            || !PathsEqual(journal.Backup, paths.Backup)
            || !PathsEqual(journal.StorageHolding, paths.StorageHolding)
            || !IsSafeStagingPath(paths.SystemsRoot, journal.Staging))
            throw new InvalidDataException("Transaction journal содержит пути вне каталога системы.");

        if (journal.Phase.StartsWith("rollback", StringComparison.Ordinal))
        {
            RecoverRollback(paths, journal);
            return;
        }

        if (!Directory.Exists(paths.Target))
        {
            if (Directory.Exists(paths.Backup)) Directory.Move(paths.Backup, paths.Target);
            else if (Directory.Exists(journal.Staging)) Directory.Move(journal.Staging, paths.Target);
        }
        RestoreHeldStorage(paths);
        if (Directory.Exists(journal.Staging) && !PathsEqual(journal.Staging, paths.Target)) Directory.Delete(journal.Staging, true);
        File.Delete(paths.Journal);
    }

    private static void RecoverRollback(InstallationPaths paths, SwapJournal journal)
    {
        var hasTarget = Directory.Exists(paths.Target);
        var hasBackup = Directory.Exists(paths.Backup);
        var hasStaging = Directory.Exists(journal.Staging);

        if (!hasTarget && hasBackup && hasStaging)
        {
            Directory.Move(paths.Backup, paths.Target);
            Directory.Move(journal.Staging, paths.Backup);
        }
        else if (hasTarget && !hasBackup && hasStaging)
        {
            Directory.Move(journal.Staging, paths.Backup);
        }
        else if (!hasTarget && !hasBackup && hasStaging)
        {
            Directory.Move(journal.Staging, paths.Target);
        }
        else if (hasTarget && hasBackup && hasStaging)
        {
            Directory.Delete(journal.Staging, true);
        }

        RestoreHeldStorage(paths);
        if (!Directory.Exists(paths.Target))
            throw new InvalidDataException("Не удалось восстановить рабочую систему после прерванного отката.");
        File.Delete(paths.Journal);
    }

    private static void RestoreHeldStorage(InstallationPaths paths)
    {
        if (!Directory.Exists(paths.StorageHolding) || !Directory.Exists(paths.Target)) return;
        var targetStorage = Path.Combine(paths.Target, "storage");
        if (Directory.Exists(targetStorage)) Directory.Delete(targetStorage, true);
        Directory.Move(paths.StorageHolding, targetStorage);
    }

    private static void WriteJournal(string path, SwapJournal journal)
    {
        var temporary = path + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(journal, JsonOptions));
        File.Move(temporary, path, true);
    }

    private static void ValidateExistingTarget(string target)
    {
        if (!Directory.Exists(target)) return;
        var manifestPath = Path.Combine(target, "system.json");
        if (!File.Exists(manifestPath)) throw new InvalidDataException($"Каталог {target} существует, но не содержит system.json.");
        using var document = JsonDocument.Parse(File.ReadAllText(manifestPath));
        var id = document.RootElement.TryGetProperty("id", out var idElement) ? idElement.GetString() : null;
        if (!string.Equals(id, ProductId, StringComparison.Ordinal))
            throw new InvalidDataException($"Лаунчер не будет заменять чужой пакет в {target}.");
    }

    private static InstallationPaths EnsureInstallationPaths(string dataPath)
    {
        if (string.IsNullOrWhiteSpace(dataPath)) throw new InvalidOperationException("Укажите папку FoundryVTT\\Data.");
        var dataRoot = Path.GetFullPath(dataPath.Trim());
        var systemsRoot = Path.Combine(dataRoot, "systems");
        Directory.CreateDirectory(systemsRoot);
        return new InstallationPaths(
            systemsRoot,
            Path.Combine(systemsRoot, SystemFolderName),
            Path.Combine(systemsRoot, BackupFolderName),
            Path.Combine(systemsRoot, JournalFileName),
            Path.Combine(systemsRoot, StorageHoldingName));
    }

    private static string CreateStagingPath(string systemsRoot) =>
        Path.Combine(systemsRoot, $".fallout-maw-launcher-staging-{Guid.NewGuid():N}");

    private static bool IsSafeStagingPath(string systemsRoot, string path)
    {
        var parent = Path.GetDirectoryName(Path.GetFullPath(path));
        return PathsEqual(parent ?? "", systemsRoot)
            && Path.GetFileName(path).StartsWith(".fallout-maw-launcher-staging-", StringComparison.Ordinal);
    }

    private static void DeletePathIfExists(string path)
    {
        if (Directory.Exists(path)) Directory.Delete(path, true);
        else if (File.Exists(path)) File.Delete(path);
    }

    private void EnsureFoundryClosed()
    {
        if (_isFoundryRunning()) throw new InvalidOperationException("Полностью закройте Foundry VTT перед установкой, обновлением или откатом.");
    }

    private static Uri ParseManifestUri(string value)
    {
        if (!Uri.TryCreate(value?.Trim(), UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttps && !(uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback)))
            throw new InvalidOperationException("Укажите полный HTTPS URL канала (HTTP разрешён только для localhost).");
        return uri;
    }

    private static Uri ResolveArtifactUri(Uri manifestUri, string value)
    {
        if (!Uri.TryCreate(manifestUri, value, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttps && !(uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback)))
            throw new InvalidDataException($"Некорректный URL артефакта: {value}");
        return uri;
    }

    private static bool SameOrigin(Uri left, Uri right) =>
        left.Scheme == right.Scheme && left.Host == right.Host && left.Port == right.Port;

    private static void ValidateManifest(ChannelManifest manifest)
    {
        if (manifest.SchemaVersion != 1) throw new InvalidDataException("Неподдерживаемая версия channel manifest.");
        if (!string.Equals(manifest.ProductId, ProductId, StringComparison.Ordinal))
            throw new InvalidDataException("Канал обновлений предназначен для другого продукта.");
        if (manifest.Sequence <= 0) throw new InvalidDataException("В channel manifest отсутствует монотонный sequence.");
        SemanticVersion.Parse(manifest.System.Version);
        var fullVersion = SemanticVersion.Parse(manifest.System.Full.Version);
        if (fullVersion.CompareTo(SemanticVersion.Parse(manifest.System.Version)) > 0)
            throw new InvalidDataException("Версия baseline новее целевой версии канала.");
        var minimumLauncher = SemanticVersion.Parse(manifest.System.MinimumLauncherVersion);
        if (SemanticVersion.Parse(LauncherVersion).CompareTo(minimumLauncher) < 0)
            throw new InvalidOperationException($"Для этого обновления нужен лаунчер {minimumLauncher} или новее.");
        ValidateArtifact(manifest.System.Full);
        foreach (var patch in manifest.System.Patches)
        {
            SemanticVersion.Parse(patch.From);
            SemanticVersion.Parse(patch.To);
            ValidateArtifact(patch);
        }
        RequirePatchChain(manifest.System.Full.Version, manifest.System.Version, manifest.System.Patches);
        if (manifest.Signature.Algorithm != ManifestSecurity.SupportedAlgorithm)
            throw new InvalidDataException("Channel manifest использует неизвестный алгоритм подписи.");
    }

    private static void ValidateArtifact(ReleaseArtifact artifact)
    {
        if (artifact.Size <= 0) throw new InvalidDataException("В channel manifest указан пустой артефакт.");
        if (string.IsNullOrWhiteSpace(artifact.Url)) throw new InvalidDataException("В channel manifest отсутствует URL артефакта.");
        ManifestSecurity.NormalizeSha256(artifact.Sha256);
    }

    private static void ValidateAntiRollback(ChannelManifest manifest, LauncherSettings settings)
    {
        if (manifest.Sequence < settings.HighestTrustedSequence)
            throw new InvalidDataException($"Отклонён подписанный rollback канала: sequence {manifest.Sequence} ниже уже доверенного {settings.HighestTrustedSequence}.");
        if (manifest.Sequence == settings.HighestTrustedSequence
            && settings.HighestTrustedSequence > 0
            && !string.IsNullOrWhiteSpace(settings.HighestTrustedVersion)
            && !string.Equals(settings.HighestTrustedVersion, manifest.System.Version, StringComparison.Ordinal))
            throw new InvalidDataException("Один sequence подписан для разных версий; публикация канала неконсистентна.");
    }

    private static IReadOnlyList<PatchArtifact> FindCheapestPatchChain(string from, string target, IEnumerable<PatchArtifact> patches)
    {
        var edges = patches.GroupBy(patch => patch.From, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.ToList(), StringComparer.Ordinal);
        var queue = new PriorityQueue<(string Version, List<PatchArtifact> Path), long>();
        var best = new Dictionary<string, long>(StringComparer.Ordinal) { [from] = 0 };
        queue.Enqueue((from, []), 0);
        while (queue.TryDequeue(out var state, out var cost))
        {
            if (state.Version == target) return state.Path;
            if (state.Path.Count >= 64 || best[state.Version] < cost || !edges.TryGetValue(state.Version, out var next)) continue;
            foreach (var patch in next)
            {
                if (SemanticVersion.Parse(patch.To).CompareTo(SemanticVersion.Parse(state.Version)) <= 0) continue;
                var nextCost = checked(cost + patch.Size);
                if (best.TryGetValue(patch.To, out var previousCost) && previousCost <= nextCost) continue;
                best[patch.To] = nextCost;
                var path = new List<PatchArtifact>(state.Path) { patch };
                queue.Enqueue((patch.To, path), nextCost);
            }
        }
        return [];
    }

    private static IReadOnlyList<PatchArtifact> RequirePatchChain(string from, string target, IEnumerable<PatchArtifact> patches)
    {
        if (string.Equals(from, target, StringComparison.Ordinal)) return [];
        var chain = FindCheapestPatchChain(from, target, patches);
        if (chain.Count == 0)
            throw new InvalidDataException($"Канал не содержит непрерывной цепочки патчей {from} → {target}.");
        return chain;
    }

    private static string FormatBytes(long bytes)
    {
        string[] units = ["Б", "КиБ", "МиБ", "ГиБ"];
        var value = (double)bytes;
        var unit = 0;
        while (value >= 1024 && unit < units.Length - 1)
        {
            value /= 1024;
            unit++;
        }
        return $"{value:0.##} {units[unit]}";
    }

    private static bool PathsEqual(string left, string right) =>
        string.Equals(Path.GetFullPath(left).TrimEnd('\\', '/'), Path.GetFullPath(right).TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase);

    public void Dispose()
    {
        if (_ownsDownloader) _downloader.Dispose();
    }

    private sealed record InstallationPaths(string SystemsRoot, string Target, string Backup, string Journal, string StorageHolding);

    private sealed class SwapJournal
    {
        public SwapJournal() { }

        public SwapJournal(string target, string backup, string staging, string storageHolding, string phase)
        {
            Target = target;
            Backup = backup;
            Staging = staging;
            StorageHolding = storageHolding;
            Phase = phase;
        }

        public string Target { get; set; } = "";
        public string Backup { get; set; } = "";
        public string Staging { get; set; } = "";
        public string StorageHolding { get; set; } = "";
        public string Phase { get; set; } = "";
    }
}
