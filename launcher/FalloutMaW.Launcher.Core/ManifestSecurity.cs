using System.Security.Cryptography;
using System.Text;

namespace FalloutMaW.Launcher.Core;

public static class ManifestSecurity
{
    public const string SupportedAlgorithm = "ECDSA_P256_SHA256";

    public static void Verify(byte[] manifestBytes, string signatureText, SignatureDescriptor descriptor, string publicKeyPem)
    {
        Verify(manifestBytes, Convert.FromBase64String(signatureText.Trim()), descriptor, publicKeyPem);
    }

    public static void Verify(byte[] manifestBytes, byte[] signature, SignatureDescriptor descriptor, string publicKeyPem)
    {
        if (!string.Equals(descriptor.Algorithm, SupportedAlgorithm, StringComparison.Ordinal))
            throw new InvalidDataException($"Неподдерживаемая подпись: {descriptor.Algorithm}");
        if (string.IsNullOrWhiteSpace(publicKeyPem))
            throw new InvalidOperationException("В лаунчер не встроен публичный ключ канала обновлений.");

        using var ecdsa = ECDsa.Create();
        ecdsa.ImportFromPem(publicKeyPem);
        var valid = ecdsa.VerifyData(
            manifestBytes,
            signature,
            HashAlgorithmName.SHA256,
            DSASignatureFormat.Rfc3279DerSequence);
        if (!valid) throw new CryptographicException("Подпись канала обновлений недействительна.");

        var keyId = ComputeKeyId(ecdsa);
        if (!string.Equals(keyId, descriptor.KeyId, StringComparison.OrdinalIgnoreCase))
            throw new CryptographicException("Идентификатор ключа канала не совпадает с ключом лаунчера.");
    }

    public static string ComputeKeyId(ECDsa key)
    {
        var hash = SHA256.HashData(key.ExportSubjectPublicKeyInfo());
        return $"p256-{Convert.ToHexString(hash).ToLowerInvariant()[..24]}";
    }

    public static string ComputeFileSha256(string filePath)
    {
        using var stream = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.Read, 1024 * 1024, FileOptions.SequentialScan);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    public static async Task<string> ComputeFileSha256Async(string filePath, CancellationToken cancellationToken = default)
    {
        await using var stream = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.Read, 1024 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[1024 * 1024];
        int read;
        while ((read = await stream.ReadAsync(buffer, cancellationToken)) > 0)
            hash.AppendData(buffer, 0, read);
        return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }

    public static string NormalizeSha256(string value)
    {
        var normalized = value.Trim().ToLowerInvariant();
        if (normalized.Length != 64 || normalized.Any(character => !Uri.IsHexDigit(character)))
            throw new InvalidDataException("В манифесте указан некорректный SHA-256.");
        return normalized;
    }
}
