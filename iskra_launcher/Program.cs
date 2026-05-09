using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO.Compression;
using System.IO.Pipes;
using System.Text.Json;
using System.Windows.Forms;

static class Launcher
{
    static readonly HttpClient Http  = new();
    static readonly string AppDir    = AppContext.BaseDirectory;
    static readonly string ClientExe = Path.Combine(AppContext.BaseDirectory, "iskra_client.exe");

    static Process?      _client;
    static volatile bool _updating = false;
    static SplashForm?   _splash;

    [STAThread]
    static void Main(string[] args)
    {
        Application.SetHighDpiMode(HighDpiMode.SystemAware);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        if (!File.Exists(ClientExe))
        {
            MessageBox.Show("iskra_client.exe not found next to iskra_launcher.exe.",
                "Iskra Launcher", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        _splash = new SplashForm();
        _splash.Show();
        _splash.Update();

        StartClient(args);

        Task.Run(async () =>
        {
            if (_client != null)
            {
                try   { await Task.Run(() => _client.WaitForInputIdle(8000)); }
                catch { await Task.Delay(3000); }
                await Task.Delay(600);
            }
            CloseSplash();
        });

        Task.Run(PipeLoop);
        Application.Run();
    }

    static void CloseSplash()
    {
        if (_splash == null || _splash.IsDisposed) return;
        try { _splash.Invoke(() => { _splash.Close(); _splash = null; }); }
        catch { }
    }

    static void StartClient(string[]? args = null)
    {
        var psi = new ProcessStartInfo { FileName = ClientExe, UseShellExecute = false };
        if (args != null) foreach (var a in args) psi.ArgumentList.Add(a);

        _client = Process.Start(psi);
        if (_client == null) return;

        _client.EnableRaisingEvents = true;
        _client.Exited += (_, _) => { if (!_updating) Environment.Exit(0); };
    }

    static async Task PipeLoop()
    {
        while (true)
        {
            try
            {
                using var pipe = new NamedPipeServerStream(
                    "IskraLauncherUpdate", PipeDirection.In, 1,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous);

                await pipe.WaitForConnectionAsync();

                using var reader = new StreamReader(pipe);
                string json = await reader.ReadToEndAsync();
                if (string.IsNullOrWhiteSpace(json)) continue;

                var doc      = JsonDocument.Parse(json).RootElement;
                string url   = doc.GetProperty("url").GetString() ?? "";
                string? localZip = doc.TryGetProperty("localZip", out var lz) ? lz.GetString() : null;

                if (!string.IsNullOrEmpty(url)) await DoUpdate(url, localZip);
            }
            catch { }
        }
    }

    static async Task DoUpdate(string downloadUrl, string? localZip = null)
    {
        _updating = true;
        string tempDir     = Path.Combine(Path.GetTempPath(), "IskraUpdate_" + Guid.NewGuid().ToString("N")[..8]);
        string zipPath     = localZip ?? Path.Combine(tempDir, "Iskra-Client.zip");
        string extractPath = Path.Combine(tempDir, "extracted");

        try
        {
            if (_client != null && !_client.HasExited)
            {
                _client.WaitForExit(4000);
                if (!_client.HasExited) _client.Kill(entireProcessTree: true);
            }
            await Task.Delay(600);

            Directory.CreateDirectory(tempDir);
            Directory.CreateDirectory(extractPath);

            if (localZip == null || !File.Exists(localZip))
            {
                // Client didn't pre-download — do it ourselves (fallback path)
                Http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", "IskraLauncher/1.0");
                using var response = await Http.GetAsync(downloadUrl, HttpCompletionOption.ResponseHeadersRead);
                response.EnsureSuccessStatusCode();
                await using var fs = new FileStream(zipPath, FileMode.Create, FileAccess.Write, FileShare.None, 65536, true);
                await using var stream = await response.Content.ReadAsStreamAsync();
                byte[] buf = new byte[65536]; int read;
                while ((read = await stream.ReadAsync(buf)) > 0)
                    await fs.WriteAsync(buf.AsMemory(0, read));
            }

            ZipFile.ExtractToDirectory(zipPath, extractPath, overwriteFiles: true);

            foreach (var file in Directory.EnumerateFiles(extractPath, "*", SearchOption.AllDirectories))
            {
                string rel     = Path.GetRelativePath(extractPath, file);
                string dst     = Path.Combine(AppDir, rel);
                string? dstDir = Path.GetDirectoryName(dst);
                if (dstDir != null) Directory.CreateDirectory(dstDir);
                if (Path.GetFileName(dst).StartsWith("iskra_launcher.", StringComparison.OrdinalIgnoreCase)) continue;
                File.Copy(file, dst, overwrite: true);
            }

            StartClient();
        }
        catch (Exception ex)
        {
            MessageBox.Show($"Update failed: {ex.Message}\n\nThe app will restart with the existing version.",
                "Iskra Updater", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            StartClient();
        }
        finally
        {
            // Clean up temp dir (includes pre-downloaded zip if localZip was inside it)
            try { Directory.Delete(tempDir, recursive: true); } catch { }
            // If localZip was in a different temp dir created by the client, clean it up too
            if (localZip != null)
            {
                try { var d = Path.GetDirectoryName(localZip); if (d != null && d != tempDir) Directory.Delete(d, recursive: true); } catch { }
            }
            _updating = false;
        }
    }
}

// ─── Splash screen ───────────────────────────────────────────────────────────

class SplashForm : Form
{
    static readonly Color BgColor    = Color.FromArgb(10, 10, 18);
    static readonly Color TitleColor = Color.FromArgb(225, 225, 255);
    static readonly Color SubColor   = Color.FromArgb(110, 110, 160);

    readonly System.Windows.Forms.Timer _dotTimer;
    int _dots = 1;

    public SplashForm()
    {
        FormBorderStyle = FormBorderStyle.None;
        BackColor       = BgColor;
        StartPosition   = FormStartPosition.CenterScreen;
        Size            = new Size(480, 200);
        ShowInTaskbar   = true;
        TopMost         = true;
        DoubleBuffered  = true;

        SetRoundedRegion(16);

        _dotTimer = new System.Windows.Forms.Timer { Interval = 450 };
        _dotTimer.Tick += (_, _) => { _dots = (_dots % 3) + 1; Invalidate(); };
        _dotTimer.Start();
    }

    void SetRoundedRegion(int r)
    {
        var path = new GraphicsPath();
        int d = r * 2;
        path.AddArc(0,         0,          d, d, 180, 90);
        path.AddArc(Width - d, 0,          d, d, 270, 90);
        path.AddArc(Width - d, Height - d, d, d,   0, 90);
        path.AddArc(0,         Height - d, d, d,  90, 90);
        path.CloseAllFigures();
        Region = new Region(path);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode     = SmoothingMode.AntiAlias;
        g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

        // Subtle border
        using (var bp = RoundedRect(1, 1, Width - 2, Height - 2, 16))
        using (var pen = new Pen(Color.FromArgb(75, 50, 125), 1.5f))
            g.DrawPath(pen, bp);

        // Lightning bolt (left, vertically centered)
        DrawBolt(g, 44, 44, 112);

        // "Iskra Voice"
        float tx = 192;
        using (var f = new Font("Segoe UI", 26, FontStyle.Bold, GraphicsUnit.Pixel))
        using (var b = new SolidBrush(TitleColor))
            g.DrawString("Iskra Voice", f, b, tx, 66);

        // "starting..."
        using (var f = new Font("Segoe UI", 13, FontStyle.Regular, GraphicsUnit.Pixel))
        using (var b = new SolidBrush(SubColor))
            g.DrawString("starting" + new string('.', _dots), f, b, tx + 2, 112);
    }

    static GraphicsPath RoundedRect(float x, float y, float w, float h, int r)
    {
        var p = new GraphicsPath();
        int d = r * 2;
        p.AddArc(x,         y,         d, d, 180, 90);
        p.AddArc(x + w - d, y,         d, d, 270, 90);
        p.AddArc(x + w - d, y + h - d, d, d,   0, 90);
        p.AddArc(x,         y + h - d, d, d,  90, 90);
        p.CloseAllFigures();
        return p;
    }

    // SVG: M16 2L4 16h10l-2 10 14-16H16L18 2z  (viewbox ~[4,26]×[2,26])
    static void DrawBolt(Graphics g, float left, float top, float size)
    {
        float scale = Math.Min(size / 22f, size / 24f);
        float offX  = left + (size - 22f * scale) / 2f;
        float offY  = top  + (size - 24f * scale) / 2f;

        PointF T(float x, float y) => new((x - 4) * scale + offX, (y - 2) * scale + offY);

        PointF[] pts = { T(16,2), T(4,16), T(14,16), T(12,26), T(26,10), T(16,10), T(18,2) };

        using var path = new GraphicsPath();
        path.AddPolygon(pts);

        // Soft glow layer
        using (var glow = new SolidBrush(Color.FromArgb(35, 140, 80, 255)))
            g.FillPath(glow, path);

        // Gradient fill: purple → cyan
        using var brush = new LinearGradientBrush(
            new PointF(left + size / 2, top),
            new PointF(left + size / 2, top + size),
            Color.FromArgb(195, 110, 255),
            Color.FromArgb(0, 215, 255));
        g.FillPath(brush, path);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _dotTimer.Dispose();
        base.Dispose(disposing);
    }
}
