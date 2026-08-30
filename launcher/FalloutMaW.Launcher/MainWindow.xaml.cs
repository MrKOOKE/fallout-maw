using System.Windows;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Interop;
using FalloutMaW.Launcher.Core;
using Forms = System.Windows.Forms;
using WpfMessageBox = System.Windows.MessageBox;
using WpfOpenFileDialog = Microsoft.Win32.OpenFileDialog;

namespace FalloutMaW.Launcher;

public partial class MainWindow : Window
{
    private const int DwmUseImmersiveDarkMode = 20;
    private const int DwmUseImmersiveDarkModeLegacy = 19;
    private const int DwmBorderColor = 34;
    private const int DwmCaptionColor = 35;
    private const int DwmTextColor = 36;

    private readonly SettingsStore _settingsStore = new();
    private readonly UpdateEngine _engine = new();
    private LauncherSettings _settings = new();
    private UpdatePlan? _plan;
    private CancellationTokenSource? _operationCancellation;
    private bool _busy;

    public MainWindow()
    {
        InitializeComponent();
        Loaded += MainWindow_Loaded;
        Closed += (_, _) =>
        {
            _operationCancellation?.Cancel();
            _engine.Dispose();
        };
    }

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        ApplyDarkWindowFrame(new WindowInteropHelper(this).Handle);
    }

    private static void ApplyDarkWindowFrame(nint windowHandle)
    {
        if (windowHandle == nint.Zero) return;
        var enabled = 1;
        if (DwmSetWindowAttribute(windowHandle, DwmUseImmersiveDarkMode, ref enabled, sizeof(int)) != 0)
            DwmSetWindowAttribute(windowHandle, DwmUseImmersiveDarkModeLegacy, ref enabled, sizeof(int));

        var background = ColorRef(0x0C, 0x0E, 0x11);
        var foreground = ColorRef(0xF2, 0xF4, 0xF7);
        var border = ColorRef(0x2C, 0x35, 0x3F);
        DwmSetWindowAttribute(windowHandle, DwmCaptionColor, ref background, sizeof(uint));
        DwmSetWindowAttribute(windowHandle, DwmTextColor, ref foreground, sizeof(uint));
        DwmSetWindowAttribute(windowHandle, DwmBorderColor, ref border, sizeof(uint));
    }

    private static uint ColorRef(byte red, byte green, byte blue) =>
        red | ((uint)green << 8) | ((uint)blue << 16);

    [DllImport("dwmapi.dll", EntryPoint = "DwmSetWindowAttribute")]
    private static extern int DwmSetWindowAttribute(nint windowHandle, int attribute, ref int value, int valueSize);

    [DllImport("dwmapi.dll", EntryPoint = "DwmSetWindowAttribute")]
    private static extern int DwmSetWindowAttribute(nint windowHandle, int attribute, ref uint value, int valueSize);

    private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        _settings = _settingsStore.Load();
        DataPathBox.Text = _settings.DataPath;
        ManifestUrlBox.Text = _settings.ManifestUrl;
        FoundryPathBox.Text = _settings.FoundryExecutable;
        AllowUnsignedCheck.IsChecked = _settings.AllowUnsignedManifest;
        try
        {
            _engine.Recover(_settings.DataPath);
        }
        catch (Exception error)
        {
            AppendLog($"Восстановление незавершённой транзакции: {error.Message}");
        }
        RefreshInstalledVersion();
        StatusText.Text = "Готово к проверке.";
        if (!string.IsNullOrWhiteSpace(_settings.ManifestUrl)) await CheckUpdatesAsync();
    }

    private async void CheckButton_Click(object sender, RoutedEventArgs e) => await CheckUpdatesAsync();

    private async Task CheckUpdatesAsync()
    {
        await RunBusyAsync(async cancellationToken =>
        {
            SaveSettingsFromForm();
            StatusText.Text = "Проверка подписанного канала…";
            AppendLog("Проверка обновлений.");
            _plan = await _engine.CheckAsync(_settings, cancellationToken);
            _settingsStore.Save(_settings);
            StatusText.Text = _plan.Description;
            AvailableVersionText.Text = _plan.Manifest.System.Version;
            ReleaseNotesText.Text = _plan.Manifest.System.ReleaseNotes;
            InstallButton.IsEnabled = _plan.IsUpdateAvailable;
            AppendLog(_plan.Description);
        });
    }

    private async void InstallButton_Click(object sender, RoutedEventArgs e)
    {
        await RunBusyAsync(async cancellationToken =>
        {
            SaveSettingsFromForm();
            _plan ??= await _engine.CheckAsync(_settings, cancellationToken);
            if (!_plan.IsUpdateAvailable)
            {
                StatusText.Text = _plan.Description;
                return;
            }
            StatusText.Text = "Установка обновления…";
            await _engine.InstallAsync(_plan, _settings, _settingsStore.DownloadsDirectory, false, CreateProgress(), cancellationToken);
            RefreshInstalledVersion();
            _plan = await _engine.CheckAsync(_settings, cancellationToken);
            _settingsStore.Save(_settings);
            StatusText.Text = _plan.Description;
            InstallButton.IsEnabled = false;
        });
    }

    private async void RepairButton_Click(object sender, RoutedEventArgs e)
    {
        var answer = WpfMessageBox.Show(
            "Полное восстановление скачает весь пакет (около 10 ГиБ). Личные данные storage будут сохранены. Продолжить?",
            "Полное восстановление",
            MessageBoxButton.YesNo,
            MessageBoxImage.Question);
        if (answer != MessageBoxResult.Yes) return;

        await RunBusyAsync(async cancellationToken =>
        {
            SaveSettingsFromForm();
            _plan = await _engine.CheckAsync(_settings, cancellationToken);
            StatusText.Text = "Полное восстановление…";
            await _engine.InstallAsync(_plan, _settings, _settingsStore.DownloadsDirectory, true, CreateProgress(), cancellationToken);
            RefreshInstalledVersion();
            StatusText.Text = $"Версия {_plan.Manifest.System.Version} восстановлена.";
            AppendLog(StatusText.Text);
        });
    }

    private void RollbackButton_Click(object sender, RoutedEventArgs e)
    {
        if (_busy) return;
        var answer = WpfMessageBox.Show("Вернуть предыдущую рабочую версию? Текущий storage сохранится.", "Откат", MessageBoxButton.YesNo, MessageBoxImage.Question);
        if (answer != MessageBoxResult.Yes) return;
        try
        {
            SaveSettingsFromForm();
            _engine.Rollback(_settings.DataPath);
            RefreshInstalledVersion();
            _plan = null;
            StatusText.Text = "Откат выполнен. Проверьте обновления, чтобы вернуться вперёд.";
            AppendLog(StatusText.Text);
        }
        catch (Exception error)
        {
            ShowError(error);
        }
    }

    private void LaunchButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            SaveSettingsFromForm();
            UpdateEngine.LaunchFoundry(_settings.FoundryExecutable);
            AppendLog("Foundry VTT запущен.");
        }
        catch (Exception error)
        {
            ShowError(error);
        }
    }

    private void BrowseDataButton_Click(object sender, RoutedEventArgs e)
    {
        using var dialog = new Forms.FolderBrowserDialog
        {
            Description = "Выберите папку FoundryVTT\\Data",
            UseDescriptionForTitle = true,
            SelectedPath = Directory.Exists(DataPathBox.Text) ? DataPathBox.Text : SettingsStore.DetectDataPath()
        };
        if (dialog.ShowDialog() == Forms.DialogResult.OK) DataPathBox.Text = dialog.SelectedPath;
    }

    private void BrowseFoundryButton_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new WpfOpenFileDialog
        {
            Title = "Выберите Foundry Virtual Tabletop.exe",
            Filter = "Приложение Foundry (*.exe)|*.exe|Все файлы (*.*)|*.*",
            CheckFileExists = true
        };
        if (dialog.ShowDialog(this) == true) FoundryPathBox.Text = dialog.FileName;
    }

    private void CancelButton_Click(object sender, RoutedEventArgs e) => _operationCancellation?.Cancel();

    private async Task RunBusyAsync(Func<CancellationToken, Task> operation)
    {
        if (_busy) return;
        _busy = true;
        _operationCancellation = new CancellationTokenSource();
        SetBusyState(true);
        try
        {
            await operation(_operationCancellation.Token);
        }
        catch (OperationCanceledException)
        {
            StatusText.Text = "Операция отменена.";
            AppendLog(StatusText.Text);
        }
        catch (Exception error)
        {
            ShowError(error);
        }
        finally
        {
            _operationCancellation.Dispose();
            _operationCancellation = null;
            _busy = false;
            SetBusyState(false);
        }
    }

    private IProgress<ProgressInfo> CreateProgress() => new Progress<ProgressInfo>(info =>
    {
        ProgressText.Text = info.Message;
        if (info.Percent is { } percent)
        {
            ProgressBar.IsIndeterminate = false;
            ProgressBar.Value = percent;
        }
        else
        {
            ProgressBar.IsIndeterminate = true;
        }
        if (info.Phase is "done" or "fallback") AppendLog(info.Message);
    });

    private void SaveSettingsFromForm()
    {
        _settings.DataPath = DataPathBox.Text.Trim();
        _settings.ManifestUrl = ManifestUrlBox.Text.Trim();
        _settings.FoundryExecutable = FoundryPathBox.Text.Trim();
        _settings.AllowUnsignedManifest = AllowUnsignedCheck.IsChecked == true;
        _settingsStore.Save(_settings);
    }

    private void RefreshInstalledVersion()
    {
        var dataPath = string.IsNullOrWhiteSpace(DataPathBox.Text) ? _settings.DataPath : DataPathBox.Text.Trim();
        InstalledVersionText.Text = UpdateEngine.GetInstalledVersion(dataPath) ?? "не установлена";
    }

    private void SetBusyState(bool busy)
    {
        CheckButton.IsEnabled = !busy;
        InstallButton.IsEnabled = !busy && _plan?.IsUpdateAvailable == true;
        RepairButton.IsEnabled = !busy;
        RollbackButton.IsEnabled = !busy;
        LaunchButton.IsEnabled = !busy;
        DataPathBox.IsEnabled = !busy;
        ManifestUrlBox.IsEnabled = !busy;
        FoundryPathBox.IsEnabled = !busy;
        AllowUnsignedCheck.IsEnabled = !busy;
        CancelButton.Visibility = busy ? Visibility.Visible : Visibility.Collapsed;
        if (!busy)
        {
            ProgressBar.IsIndeterminate = false;
            ProgressBar.Value = 0;
        }
    }

    private void AppendLog(string message)
    {
        LogBox.AppendText($"[{DateTime.Now:HH:mm:ss}] {message}{Environment.NewLine}");
        LogBox.ScrollToEnd();
    }

    private void ShowError(Exception error)
    {
        StatusText.Text = "Ошибка: " + error.Message;
        AppendLog(StatusText.Text);
        WpfMessageBox.Show(error.Message, "Fallout TTG Launcher", MessageBoxButton.OK, MessageBoxImage.Error);
    }
}
