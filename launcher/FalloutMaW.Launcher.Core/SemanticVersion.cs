using System.Globalization;

namespace FalloutMaW.Launcher.Core;

public readonly record struct SemanticVersion(int Major, int Minor, int Patch, string? Prerelease) : IComparable<SemanticVersion>
{
    public static SemanticVersion Parse(string value)
    {
        if (!TryParse(value, out var version))
            throw new FormatException($"Некорректная версия: {value}");
        return version;
    }

    public static bool TryParse(string? value, out SemanticVersion version)
    {
        version = default;
        if (string.IsNullOrWhiteSpace(value)) return false;

        var withoutBuild = value.Trim().Split('+', 2)[0];
        var parts = withoutBuild.Split('-', 2);
        var numbers = parts[0].Split('.');
        if (numbers.Length is < 1 or > 3) return false;
        if (!int.TryParse(numbers[0], NumberStyles.None, CultureInfo.InvariantCulture, out var major)) return false;
        var minor = 0;
        var patch = 0;
        if (numbers.Length > 1 && !int.TryParse(numbers[1], NumberStyles.None, CultureInfo.InvariantCulture, out minor)) return false;
        if (numbers.Length > 2 && !int.TryParse(numbers[2], NumberStyles.None, CultureInfo.InvariantCulture, out patch)) return false;
        version = new SemanticVersion(major, minor, patch, parts.Length == 2 ? parts[1] : null);
        return true;
    }

    public int CompareTo(SemanticVersion other)
    {
        var result = Major.CompareTo(other.Major);
        if (result != 0) return result;
        result = Minor.CompareTo(other.Minor);
        if (result != 0) return result;
        result = Patch.CompareTo(other.Patch);
        if (result != 0) return result;
        if (Prerelease is null && other.Prerelease is null) return 0;
        if (Prerelease is null) return 1;
        if (other.Prerelease is null) return -1;
        return ComparePrerelease(Prerelease, other.Prerelease);
    }

    private static int ComparePrerelease(string left, string right)
    {
        var leftParts = left.Split('.');
        var rightParts = right.Split('.');
        for (var index = 0; index < Math.Max(leftParts.Length, rightParts.Length); index++)
        {
            if (index >= leftParts.Length) return -1;
            if (index >= rightParts.Length) return 1;
            var leftNumeric = int.TryParse(leftParts[index], NumberStyles.None, CultureInfo.InvariantCulture, out var leftNumber);
            var rightNumeric = int.TryParse(rightParts[index], NumberStyles.None, CultureInfo.InvariantCulture, out var rightNumber);
            int result;
            if (leftNumeric && rightNumeric) result = leftNumber.CompareTo(rightNumber);
            else if (leftNumeric) result = -1;
            else if (rightNumeric) result = 1;
            else result = string.Compare(leftParts[index], rightParts[index], StringComparison.Ordinal);
            if (result != 0) return result;
        }
        return 0;
    }

    public override string ToString() => $"{Major}.{Minor}.{Patch}{(Prerelease is null ? "" : $"-{Prerelease}")}";
}
