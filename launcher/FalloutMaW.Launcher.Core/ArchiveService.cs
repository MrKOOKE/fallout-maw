using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;

namespace FalloutMaW.Launcher.Core;

public sealed class ArchiveService
{
    public const string ReceiptEntryName = "_fallout-maw-release.json";
    public const string BaseReceiptEntryName = "_fallout-maw-base.json";
    public const string PatchEntryName = "_fallout-maw-patch.json";

    private const int MaximumEntries = 250_000;
    private const long MaximumUncompressedBytes = 128L * 1024 * 1024 * 1024;
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = false };
    private static readonly HashSet<string> ReservedWindowsNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
    };

    public async Task<ReleaseReceipt> PrepareFullAsync(
        string archivePath,
        string stagingPath,
        string productId,
        string targetVersion,
        bool preserveExistingStorage,
        IProgress<ProgressInfo>? progress,
        CancellationToken cancellationToken)
    {
        EnsureFreshDirectory(stagingPath);
        try
        {
            using var archive = ZipFile.OpenRead(archivePath);
            ValidateArchiveShape(archive);
            var receipt = await ReadJsonEntryAsync<ReleaseReceipt>(archive, ReceiptEntryName, cancellationToken);
            ValidateReceiptIdentity(receipt, productId, targetVersion);

            var completed = 0L;
            var total = archive.Entries.Where(entry => !IsDirectory(entry)).Sum(entry => entry.Length);
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var entry in archive.Entries)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var relative = NormalizeArchivePath(entry.FullName);
                if (relative.Length == 0) continue;
                if (!seen.Add(relative)) throw new InvalidDataException($"В архиве конфликт путей с учётом регистра: {relative}");
                RejectLinkEntry(entry);
                var destination = ResolveSafePath(stagingPath, relative);
                if (IsDirectory(entry))
                {
                    Directory.CreateDirectory(destination);
                    continue;
                }
                Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                await ExtractEntryAsync(entry, destination, null, cancellationToken);
                completed += entry.Length;
                progress?.Report(new ProgressInfo("extract", completed, total, "Распаковка полного пакета…"));
            }

            if (preserveExistingStorage)
            {
                var stagedStorage = Path.Combine(stagingPath, "storage");
                if (Directory.Exists(stagedStorage)) Directory.Delete(stagedStorage, true);
            }
            await ValidateSystemManifestAsync(stagingPath, productId, targetVersion, cancellationToken);
            return receipt;
        }
        catch
        {
            TryDeleteDirectory(stagingPath);
            throw;
        }
    }

    public async Task<ReleaseReceipt> PreparePatchAsync(
        string archivePath,
        string installedPath,
        string stagingPath,
        string productId,
        string fromVersion,
        string toVersion,
        IProgress<ProgressInfo>? progress,
        CancellationToken cancellationToken)
    {
        EnsureFreshDirectory(stagingPath);
        try
        {
            using var archive = ZipFile.OpenRead(archivePath);
            ValidateArchiveShape(archive);
            var patch = await ReadJsonEntryAsync<PatchPackage>(archive, PatchEntryName, cancellationToken);
            var baseReceipt = await ReadJsonEntryAsync<ReleaseReceipt>(archive, BaseReceiptEntryName, cancellationToken);
            var targetReceipt = await ReadJsonEntryAsync<ReleaseReceipt>(archive, ReceiptEntryName, cancellationToken);
            ValidatePatchIdentity(patch, baseReceipt, targetReceipt, productId, fromVersion, toVersion);

            await ValidateInstalledBaseAsync(installedPath, baseReceipt, progress, cancellationToken);
            progress?.Report(new ProgressInfo("stage", 0, null, "Подготовка безопасной копии системы…"));
            await CloneDirectoryAsync(installedPath, stagingPath, "storage", progress, cancellationToken);

            foreach (var relative in patch.Deletes)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var destination = ResolveSafePath(stagingPath, NormalizeArchivePath(relative));
                if (File.Exists(destination)) File.Delete(destination);
                else if (Directory.Exists(destination)) Directory.Delete(destination, true);
            }

            var writes = patch.Writes.ToDictionary(
                write => NormalizeArchivePath(write.Path),
                StringComparer.OrdinalIgnoreCase);
            var seenWrites = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var completed = 0L;
            var total = patch.Writes.Sum(write => write.Size);
            foreach (var entry in archive.Entries.Where(entry => entry.FullName.Replace('\\', '/').StartsWith("payload/", StringComparison.Ordinal)))
            {
                cancellationToken.ThrowIfCancellationRequested();
                RejectLinkEntry(entry);
                if (IsDirectory(entry)) continue;
                var relative = NormalizeArchivePath(entry.FullName["payload/".Length..]);
                if (!writes.TryGetValue(relative, out var expected))
                    throw new InvalidDataException($"Патч содержит незаявленный файл: {relative}");
                if (!seenWrites.Add(relative)) throw new InvalidDataException($"Дубликат файла в патче: {relative}");
                if (entry.Length != expected.Size) throw new InvalidDataException($"Размер {relative} не совпал с patch manifest.");

                var destination = ResolveSafePath(stagingPath, relative);
                Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                if (File.Exists(destination)) File.Delete(destination);
                await ExtractEntryAsync(entry, destination, expected.Sha256, cancellationToken);
                completed += entry.Length;
                progress?.Report(new ProgressInfo("patch", completed, total, $"Применение патча: {relative}"));
            }
            if (seenWrites.Count != writes.Count)
            {
                var missing = writes.Keys.First(path => !seenWrites.Contains(path));
                throw new InvalidDataException($"В патче отсутствует заявленный файл: {missing}");
            }

            var receiptPath = Path.Combine(stagingPath, ReceiptEntryName);
            if (File.Exists(receiptPath)) File.Delete(receiptPath);
            await WriteJsonEntryToFileAsync(archive, ReceiptEntryName, receiptPath, cancellationToken);
            await ValidateSystemManifestAsync(stagingPath, productId, toVersion, cancellationToken);
            return targetReceipt;
        }
        catch
        {
            TryDeleteDirectory(stagingPath);
            throw;
        }
    }

    public static ReleaseReceipt? TryReadInstalledReceipt(string installedPath)
    {
        var path = Path.Combine(installedPath, ReceiptEntryName);
        if (!File.Exists(path)) return null;
        try
        {
            return JsonSerializer.Deserialize<ReleaseReceipt>(File.ReadAllText(path), JsonOptions);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static async Task ValidateInstalledBaseAsync(
        string installedPath,
        ReleaseReceipt expected,
        IProgress<ProgressInfo>? progress,
        CancellationToken cancellationToken)
    {
        var installedReceipt = TryReadInstalledReceipt(installedPath);
        if (installedReceipt is not null
            && (!string.Equals(installedReceipt.ProductId, expected.ProductId, StringComparison.Ordinal)
                || !string.Equals(installedReceipt.Version, expected.Version, StringComparison.Ordinal)
                || !string.Equals(installedReceipt.Fingerprint, expected.Fingerprint, StringComparison.OrdinalIgnoreCase)))
            throw new InvalidDataException("Установленная квитанция не совпадает с базой патча.");

        var total = expected.Files.Values.Sum(file => file.Size);
        var completed = 0L;
        foreach (var pair in expected.Files.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var path = ResolveSafePath(installedPath, NormalizeArchivePath(pair.Key));
            if (!File.Exists(path)) throw new InvalidDataException($"Базовая установка повреждена: отсутствует {pair.Key}");
            var info = new FileInfo(path);
            if (info.Length != pair.Value.Size) throw new InvalidDataException($"Базовая установка изменена: {pair.Key}");
            var hash = await ManifestSecurity.ComputeFileSha256Async(path, cancellationToken);
            if (!string.Equals(hash, pair.Value.Sha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException($"Базовая установка изменена: {pair.Key}");
            completed += info.Length;
            progress?.Report(new ProgressInfo("adopt", completed, total, "Проверка существующей установки для первого патча…"));
        }
    }

    private static Task CloneDirectoryAsync(
        string sourceRoot,
        string destinationRoot,
        string preservedTopLevelDirectory,
        IProgress<ProgressInfo>? progress,
        CancellationToken cancellationToken)
    {
        return Task.Run(() =>
        {
            Directory.CreateDirectory(destinationRoot);
            var files = EnumerateFilesSafely(sourceRoot, preservedTopLevelDirectory, cancellationToken);
            var completed = 0L;
            foreach (var source in files)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var relative = Path.GetRelativePath(sourceRoot, source).Replace('\\', '/');
                var destination = ResolveSafePath(destinationRoot, NormalizeArchivePath(relative));
                Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                // A hard link would also link the future rollback backup to the active
                // installation after the directory swap. Copying keeps both versions
                // independent even if a managed file is later changed or corrupted.
                File.Copy(source, destination, false);
                completed++;
                if (completed % 200 == 0)
                    progress?.Report(new ProgressInfo("stage", completed, files.Count, "Подготовка staging-каталога…"));
            }
        }, cancellationToken);
    }

    private static List<string> EnumerateFilesSafely(string sourceRoot, string preservedTopLevelDirectory, CancellationToken cancellationToken)
    {
        var files = new List<string>();
        var pending = new Stack<string>();
        pending.Push(sourceRoot);
        while (pending.TryPop(out var directory))
        {
            cancellationToken.ThrowIfCancellationRequested();
            foreach (var childDirectory in Directory.EnumerateDirectories(directory))
            {
                var relative = Path.GetRelativePath(sourceRoot, childDirectory).Replace('\\', '/');
                if (relative.Equals(preservedTopLevelDirectory, StringComparison.OrdinalIgnoreCase)) continue;
                if ((File.GetAttributes(childDirectory) & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException($"В установленной системе найден reparse point: {relative}");
                pending.Push(childDirectory);
            }
            foreach (var file in Directory.EnumerateFiles(directory))
            {
                var relative = Path.GetRelativePath(sourceRoot, file).Replace('\\', '/');
                if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException($"В установленной системе найден reparse point: {relative}");
                files.Add(file);
            }
        }
        return files;
    }

    private static async Task ValidateSystemManifestAsync(string root, string productId, string version, CancellationToken cancellationToken)
    {
        var path = Path.Combine(root, "system.json");
        if (!File.Exists(path)) throw new InvalidDataException("В пакете отсутствует system.json.");
        await using var stream = File.OpenRead(path);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var id = document.RootElement.GetProperty("id").GetString();
        var actualVersion = document.RootElement.GetProperty("version").GetString();
        if (!string.Equals(id, productId, StringComparison.Ordinal))
            throw new InvalidDataException($"Ожидалась система {productId}, получена {id}.");
        if (!string.Equals(actualVersion, version, StringComparison.Ordinal))
            throw new InvalidDataException($"Ожидалась версия {version}, получена {actualVersion}.");
    }

    private static void ValidatePatchIdentity(
        PatchPackage patch,
        ReleaseReceipt baseReceipt,
        ReleaseReceipt targetReceipt,
        string productId,
        string fromVersion,
        string toVersion)
    {
        if (patch.SchemaVersion != 1) throw new InvalidDataException("Неподдерживаемая версия patch manifest.");
        if (!string.Equals(patch.ProductId, productId, StringComparison.Ordinal)
            || !string.Equals(patch.From, fromVersion, StringComparison.Ordinal)
            || !string.Equals(patch.To, toVersion, StringComparison.Ordinal))
            throw new InvalidDataException("Патч предназначен для другой системы или версии.");
        ValidateReceiptIdentity(baseReceipt, productId, fromVersion);
        ValidateReceiptIdentity(targetReceipt, productId, toVersion);
        if (!string.Equals(patch.FromFingerprint, baseReceipt.Fingerprint, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(patch.ToFingerprint, targetReceipt.Fingerprint, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Fingerprint патча не совпал с вложенными индексами.");
        foreach (var path in patch.Deletes) NormalizeArchivePath(path);
        foreach (var write in patch.Writes)
        {
            NormalizeArchivePath(write.Path);
            ManifestSecurity.NormalizeSha256(write.Sha256);
            if (write.Size < 0) throw new InvalidDataException($"Отрицательный размер: {write.Path}");
        }
    }

    private static void ValidateReceiptIdentity(ReleaseReceipt receipt, string productId, string version)
    {
        if (receipt.SchemaVersion != 1
            || !string.Equals(receipt.ProductId, productId, StringComparison.Ordinal)
            || !string.Equals(receipt.Version, version, StringComparison.Ordinal))
            throw new InvalidDataException("Индекс файлов предназначен для другой системы или версии.");
        ManifestSecurity.NormalizeSha256(receipt.Fingerprint);
        foreach (var pair in receipt.Files)
        {
            NormalizeArchivePath(pair.Key);
            ManifestSecurity.NormalizeSha256(pair.Value.Sha256);
            if (pair.Value.Size < 0) throw new InvalidDataException($"Отрицательный размер: {pair.Key}");
        }
    }

    private static async Task<T> ReadJsonEntryAsync<T>(ZipArchive archive, string entryName, CancellationToken cancellationToken)
    {
        var entry = archive.GetEntry(entryName) ?? archive.GetEntry("./" + entryName)
            ?? throw new InvalidDataException($"В архиве отсутствует {entryName}.");
        if (entry.Length > 32 * 1024 * 1024) throw new InvalidDataException($"{entryName} имеет недопустимый размер.");
        await using var stream = entry.Open();
        return await JsonSerializer.DeserializeAsync<T>(stream, JsonOptions, cancellationToken)
            ?? throw new InvalidDataException($"Не удалось прочитать {entryName}.");
    }

    private static async Task WriteJsonEntryToFileAsync(ZipArchive archive, string entryName, string destination, CancellationToken cancellationToken)
    {
        var entry = archive.GetEntry(entryName) ?? archive.GetEntry("./" + entryName)
            ?? throw new InvalidDataException($"В архиве отсутствует {entryName}.");
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        await ExtractEntryAsync(entry, destination, null, cancellationToken);
    }

    private static async Task ExtractEntryAsync(ZipArchiveEntry entry, string destination, string? expectedHash, CancellationToken cancellationToken)
    {
        await using var source = entry.Open();
        await using var target = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1024 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
        using var hash = expectedHash is null ? null : IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[1024 * 1024];
        int read;
        while ((read = await source.ReadAsync(buffer, cancellationToken)) > 0)
        {
            await target.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            hash?.AppendData(buffer, 0, read);
        }
        await target.FlushAsync(cancellationToken);
        if (hash is not null)
        {
            var actual = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
            if (!string.Equals(actual, ManifestSecurity.NormalizeSha256(expectedHash!), StringComparison.OrdinalIgnoreCase))
            {
                target.Close();
                File.Delete(destination);
                throw new InvalidDataException($"SHA-256 файла {entry.FullName} не совпал.");
            }
        }
    }

    private static void ValidateArchiveShape(ZipArchive archive)
    {
        if (archive.Entries.Count > MaximumEntries) throw new InvalidDataException("В архиве слишком много файлов.");
        var total = 0L;
        foreach (var entry in archive.Entries)
        {
            if (entry.Length < 0 || entry.Length > MaximumUncompressedBytes - total)
                throw new InvalidDataException("Архив превышает допустимый распакованный размер.");
            total += entry.Length;
        }
    }

    public static string NormalizeArchivePath(string value)
    {
        var normalized = value.Replace('\\', '/');
        while (normalized.StartsWith("./", StringComparison.Ordinal)) normalized = normalized[2..];
        normalized = normalized.TrimEnd('/');
        if (normalized.Length == 0) return "";
        if (normalized.StartsWith("/", StringComparison.Ordinal) || Path.IsPathRooted(normalized) || normalized.Contains('\0'))
            throw new InvalidDataException($"Опасный путь в архиве: {value}");
        var segments = normalized.Split('/');
        foreach (var segment in segments)
        {
            if (segment.Length == 0 || segment is "." or ".." || segment.Contains(':')
                || segment.IndexOfAny(['<', '>', '"', '|', '?', '*']) >= 0
                || segment.EndsWith(' ') || segment.EndsWith('.'))
                throw new InvalidDataException($"Опасный путь в архиве: {value}");
            var baseName = segment.Split('.', 2)[0].TrimEnd(' ', '.');
            if (ReservedWindowsNames.Contains(baseName))
                throw new InvalidDataException($"Зарезервированное имя Windows в архиве: {value}");
        }
        return string.Join('/', segments);
    }

    public static string ResolveSafePath(string root, string relative)
    {
        if (relative.Length == 0) throw new InvalidDataException("Пустой путь файла.");
        var fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var fullPath = Path.GetFullPath(Path.Combine(fullRoot, relative.Replace('/', Path.DirectorySeparatorChar)));
        if (!fullPath.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"Путь выходит за staging-каталог: {relative}");
        return fullPath;
    }

    private static bool IsDirectory(ZipArchiveEntry entry) =>
        entry.FullName.EndsWith("/", StringComparison.Ordinal) || entry.FullName.EndsWith('\\');

    private static void RejectLinkEntry(ZipArchiveEntry entry)
    {
        var unixMode = (entry.ExternalAttributes >> 16) & 0xF000;
        if (unixMode == 0xA000) throw new InvalidDataException($"Символические ссылки запрещены: {entry.FullName}");
    }

    private static void EnsureFreshDirectory(string path)
    {
        if (Directory.Exists(path)) Directory.Delete(path, true);
        Directory.CreateDirectory(path);
    }

    private static void TryDeleteDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path)) Directory.Delete(path, true);
        }
        catch (IOException)
        {
            // The original exception is more useful than cleanup failure.
        }
        catch (UnauthorizedAccessException)
        {
            // The original exception is more useful than cleanup failure.
        }
    }

}
