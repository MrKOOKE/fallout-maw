using Microsoft.Win32;
using System.Runtime.Versioning;
using System.Text.Json;

namespace FalloutMaW.Launcher.Core;

public sealed class SettingsStore
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    public string ApplicationDirectory { get; }
    public string SettingsPath => Path.Combine(ApplicationDirectory, "settings.json");
    public string DownloadsDirectory => Path.Combine(ApplicationDirectory, "downloads");

    public SettingsStore(string? applicationDirectory = null)
    {
        ApplicationDirectory = applicationDirectory ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "FalloutMaWLauncher");
    }

    public LauncherSettings Load()
    {
        LauncherSettings settings;
        try
        {
            settings = File.Exists(SettingsPath)
                ? JsonSerializer.Deserialize<LauncherSettings>(File.ReadAllText(SettingsPath), JsonOptions) ?? new LauncherSettings()
                : new LauncherSettings();
        }
        catch (JsonException)
        {
            settings = new LauncherSettings();
        }

        if (string.IsNullOrWhiteSpace(settings.DataPath)) settings.DataPath = DetectDataPath();
        if (string.IsNullOrWhiteSpace(settings.ManifestUrl)) settings.ManifestUrl = PublisherDefaults.ManifestUrl;
        if (string.IsNullOrWhiteSpace(settings.FoundryExecutable) || !File.Exists(settings.FoundryExecutable))
            settings.FoundryExecutable = DetectFoundryExecutable();
        return settings;
    }

    public void Save(LauncherSettings settings)
    {
        Directory.CreateDirectory(ApplicationDirectory);
        var temporaryPath = SettingsPath + ".tmp";
        File.WriteAllText(temporaryPath, JsonSerializer.Serialize(settings, JsonOptions));
        File.Move(temporaryPath, SettingsPath, true);
    }

    public static string DetectDataPath()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return Path.Combine(local, "FoundryVTT", "Data");
    }

    public static string DetectFoundryExecutable()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        var candidates = new List<string>();

        if (OperatingSystem.IsWindows()) candidates.AddRange(DetectFoundryFromRegistry());
        candidates.AddRange(
        [
            Path.Combine(local, "Programs", "Foundry Virtual Tabletop", "Foundry Virtual Tabletop.exe"),
            Path.Combine(programFiles, "Foundry Virtual Tabletop", "Foundry Virtual Tabletop.exe"),
            Path.Combine(programFilesX86, "Foundry Virtual Tabletop", "Foundry Virtual Tabletop.exe")
        ]);

        return candidates
            .Where(path => !string.IsNullOrWhiteSpace(path))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault(File.Exists) ?? "";
    }

    [SupportedOSPlatform("windows")]
    private static IEnumerable<string> DetectFoundryFromRegistry()
    {
        var candidates = new List<string>();
        foreach (var hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        {
            foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
            {
                try
                {
                    using var root = RegistryKey.OpenBaseKey(hive, view);
                    using (var appPath = root.OpenSubKey(
                               @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Foundry Virtual Tabletop.exe"))
                    {
                        AddExecutableCandidate(candidates, appPath?.GetValue(null) as string);
                    }

                    using var uninstall = root.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall");
                    if (uninstall is null) continue;
                    foreach (var subKeyName in uninstall.GetSubKeyNames())
                    {
                        using var application = uninstall.OpenSubKey(subKeyName);
                        if (application is null) continue;
                        var displayName = application.GetValue("DisplayName") as string;
                        if (string.IsNullOrWhiteSpace(displayName)
                            || !displayName.Contains("Foundry Virtual Tabletop", StringComparison.OrdinalIgnoreCase))
                            continue;

                        AddExecutableCandidate(candidates, application.GetValue("DisplayIcon") as string);
                        var installLocation = application.GetValue("InstallLocation") as string;
                        if (!string.IsNullOrWhiteSpace(installLocation))
                            candidates.Add(Path.Combine(installLocation.Trim().Trim('"'), "Foundry Virtual Tabletop.exe"));

                        var uninstallExecutable = ExtractExecutablePath(application.GetValue("UninstallString") as string);
                        var installDirectory = uninstallExecutable is null ? null : Path.GetDirectoryName(uninstallExecutable);
                        if (!string.IsNullOrWhiteSpace(installDirectory))
                            candidates.Add(Path.Combine(installDirectory, "Foundry Virtual Tabletop.exe"));
                    }
                }
                catch (Exception error) when (error is UnauthorizedAccessException or IOException or System.Security.SecurityException)
                {
                    // A locked registry view must not prevent checks of the remaining locations.
                }
            }
        }
        return candidates;
    }

    private static void AddExecutableCandidate(ICollection<string> candidates, string? rawPath)
    {
        var path = ExtractExecutablePath(rawPath);
        if (!string.IsNullOrWhiteSpace(path)) candidates.Add(path);
    }

    private static string? ExtractExecutablePath(string? rawPath)
    {
        if (string.IsNullOrWhiteSpace(rawPath)) return null;
        var value = Environment.ExpandEnvironmentVariables(rawPath.Trim());
        if (value.StartsWith('"'))
        {
            var closingQuote = value.IndexOf('"', 1);
            if (closingQuote > 1) return value[1..closingQuote];
        }

        var executableEnd = value.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
        if (executableEnd >= 0) value = value[..(executableEnd + 4)];
        return value.Trim().Trim('"');
    }
}
