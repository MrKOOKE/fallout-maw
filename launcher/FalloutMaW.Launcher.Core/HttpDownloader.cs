using System.Net;
using System.Net.Http.Headers;

namespace FalloutMaW.Launcher.Core;

public sealed class HttpDownloader : IDisposable
{
    private readonly HttpClient _client;
    private readonly bool _ownsClient;

    public HttpDownloader(HttpClient? client = null)
    {
        _ownsClient = client is null;
        _client = client ?? new HttpClient(new HttpClientHandler
        {
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate
        });
        _client.Timeout = Timeout.InfiniteTimeSpan;
        _client.DefaultRequestHeaders.UserAgent.ParseAdd("Fallout-TTG-Launcher/1.0");
    }

    public async Task<byte[]> GetBytesLimitedAsync(Uri uri, int maximumBytes, CancellationToken cancellationToken)
    {
        EnsureHttpUri(uri);
        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        using var response = await _client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength is > 0 and var length && length > maximumBytes)
            throw new InvalidDataException($"Ответ {uri} превышает допустимый размер.");

        await using var source = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var destination = new MemoryStream();
        var buffer = new byte[64 * 1024];
        int read;
        while ((read = await source.ReadAsync(buffer, cancellationToken)) > 0)
        {
            if (destination.Length + read > maximumBytes)
                throw new InvalidDataException($"Ответ {uri} превышает допустимый размер.");
            await destination.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
        }
        return destination.ToArray();
    }

    public async Task<string> DownloadAsync(
        Uri uri,
        ReleaseArtifact artifact,
        string downloadsDirectory,
        IProgress<ProgressInfo>? progress,
        CancellationToken cancellationToken)
    {
        EnsureHttpUri(uri);
        Directory.CreateDirectory(downloadsDirectory);
        var expectedHash = ManifestSecurity.NormalizeSha256(artifact.Sha256);
        var extension = Path.GetExtension(uri.AbsolutePath);
        if (string.IsNullOrWhiteSpace(extension) || extension.Length > 8) extension = ".bin";
        var completedPath = Path.Combine(downloadsDirectory, $"{expectedHash}{extension}");
        var partialPath = completedPath + ".partial";

        if (await IsCompleteAndValidAsync(completedPath, artifact, cancellationToken))
        {
            progress?.Report(new ProgressInfo("download", artifact.Size, artifact.Size, "Используется уже загруженный файл."));
            return completedPath;
        }
        if (File.Exists(completedPath)) File.Delete(completedPath);

        if (File.Exists(partialPath) && artifact.Size > 0 && new FileInfo(partialPath).Length == artifact.Size)
        {
            progress?.Report(new ProgressInfo("verify", 0, artifact.Size, "Проверка ранее завершённой загрузки…"));
            var partialHash = await ManifestSecurity.ComputeFileSha256Async(partialPath, cancellationToken);
            if (string.Equals(partialHash, expectedHash, StringComparison.OrdinalIgnoreCase))
            {
                File.Move(partialPath, completedPath, true);
                return completedPath;
            }
            File.Delete(partialPath);
        }

        for (var attempt = 0; attempt < 2; attempt++)
        {
            var existingLength = File.Exists(partialPath) ? new FileInfo(partialPath).Length : 0L;
            if (artifact.Size > 0 && existingLength > artifact.Size)
            {
                File.Delete(partialPath);
                existingLength = 0;
            }

            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            request.Headers.AcceptEncoding.Clear();
            request.Headers.AcceptEncoding.Add(new StringWithQualityHeaderValue("identity"));
            if (existingLength > 0) request.Headers.Range = new RangeHeaderValue(existingLength, null);

            using var response = await _client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            if (response.StatusCode == HttpStatusCode.RequestedRangeNotSatisfiable && existingLength > 0)
            {
                File.Delete(partialPath);
                continue;
            }
            response.EnsureSuccessStatusCode();

            var append = existingLength > 0 && response.StatusCode == HttpStatusCode.PartialContent;
            if (!append) existingLength = 0;
            var mode = append ? FileMode.Append : FileMode.Create;
            await using var destination = new FileStream(
                partialPath,
                mode,
                FileAccess.Write,
                FileShare.None,
                1024 * 1024,
                FileOptions.Asynchronous | FileOptions.SequentialScan);
            await using var source = await response.Content.ReadAsStreamAsync(cancellationToken);
            var buffer = new byte[1024 * 1024];
            var downloaded = existingLength;
            int read;
            while ((read = await source.ReadAsync(buffer, cancellationToken)) > 0)
            {
                await destination.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                downloaded += read;
                progress?.Report(new ProgressInfo("download", downloaded, artifact.Size > 0 ? artifact.Size : null, "Загрузка обновления…"));
            }
            await destination.FlushAsync(cancellationToken);
            await destination.DisposeAsync();
            await source.DisposeAsync();

            if (artifact.Size > 0 && downloaded != artifact.Size)
                throw new InvalidDataException($"Размер загрузки не совпал: ожидалось {artifact.Size}, получено {downloaded}.");

            progress?.Report(new ProgressInfo("verify", 0, artifact.Size > 0 ? artifact.Size : null, "Проверка SHA-256…"));
            var actualHash = await ManifestSecurity.ComputeFileSha256Async(partialPath, cancellationToken);
            if (!string.Equals(actualHash, expectedHash, StringComparison.OrdinalIgnoreCase))
            {
                File.Delete(partialPath);
                throw new InvalidDataException("SHA-256 загруженного файла не совпал с подписанным манифестом.");
            }

            File.Move(partialPath, completedPath, true);
            return completedPath;
        }

        throw new HttpRequestException("Сервер не позволил продолжить загрузку файла.");
    }

    private static async Task<bool> IsCompleteAndValidAsync(string path, ReleaseArtifact artifact, CancellationToken cancellationToken)
    {
        if (!File.Exists(path)) return false;
        if (artifact.Size > 0 && new FileInfo(path).Length != artifact.Size) return false;
        var actual = await ManifestSecurity.ComputeFileSha256Async(path, cancellationToken);
        return string.Equals(actual, ManifestSecurity.NormalizeSha256(artifact.Sha256), StringComparison.OrdinalIgnoreCase);
    }

    private static void EnsureHttpUri(Uri uri)
    {
        if (!uri.IsAbsoluteUri || (uri.Scheme != Uri.UriSchemeHttps && !(uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback)))
            throw new InvalidOperationException("Для обновлений разрешён HTTPS; HTTP допустим только для локальной проверки.");
    }

    public void Dispose()
    {
        if (_ownsClient) _client.Dispose();
    }
}
