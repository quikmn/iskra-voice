using System.Diagnostics;

namespace Iskra.Server.Updates;

/// <summary>An update that has been swapped in but hasn't confirmed itself yet ("pending"), or one that was undone.</summary>
public sealed record UpdateMarker(string From, string To);

/// <summary>
/// Swaps a verified, unpacked package into the folder iskra-server runs from, keeping the files it replaces in
/// .update/previous so the update can be undone. Everything happens inside that folder, so each swap is a rename.
///
/// Markers in .update/ (plain text, shared with the iskra-update-guard script that systemd runs before each start):
///   pending       "from to": swapped in, not confirmed yet. The new version confirms after running a while.
///   starts        how many times the guard saw it start while pending; at 3 it puts the previous files back
///   rolled-back   "from to": the guard (or <see cref="Rollback"/>) undid the update
///   added         names that are new in this version (removed again on rollback)
///   last          "from to": the last update that confirmed itself
///   guard-ran     touched by the guard on every start (shows that the systemd unit runs it)
/// </summary>
public sealed class UpdateInstaller(string appDir)
{
    public string AppDir { get; } = appDir;
    public string UpdateDir => Path.Combine(AppDir, ".update");
    private string Marker(string name) => Path.Combine(UpdateDir, name);
    public string PreviousDir => Marker("previous");

    /// <summary>Whether this process may write the files it runs from (a package manager or root may own them).</summary>
    public bool CanWrite()
    {
        try
        {
            Directory.CreateDirectory(UpdateDir);
            var probe = Marker($"probe-{Environment.ProcessId}");
            File.WriteAllText(probe, "");
            File.Delete(probe);
            var exe = Path.Combine(AppDir, "iskra-server");
            if (File.Exists(exe))
            {
                using var _ = new FileStream(exe, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete);
            }
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    /// <summary>True if the guard script ran shortly before this process started.</summary>
    public bool GuardRanBefore(DateTime processStartUtc)
    {
        var file = Marker("guard-ran");
        if (!File.Exists(file)) return false;
        var ran = File.GetLastWriteTimeUtc(file);
        return ran <= processStartUtc.AddSeconds(5) && ran >= processStartUtc.AddMinutes(-5);
    }

    /// <summary>Where a package is unpacked before it's swapped in (same disk, so the swap is a rename).</summary>
    public string StagingDir(string version) => Marker($"staged-{version}");

    /// <summary>
    /// Runs the unpacked iskra-server with "version" and checks it says <paramref name="version"/>: a package that
    /// can't even start on this machine never gets swapped in.
    /// </summary>
    public static async Task CheckRunsAsync(string stagedExe, string version, CancellationToken cancel)
    {
        var start = new ProcessStartInfo(stagedExe, "version") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        using var process = Process.Start(start) ?? throw new UpdateVerificationException("The new version didn't start.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel);
        timeout.CancelAfter(TimeSpan.FromSeconds(60));
        string output;
        try
        {
            var stderr = process.StandardError.ReadToEndAsync(timeout.Token);
            output = (await process.StandardOutput.ReadToEndAsync(timeout.Token)).Trim();
            await process.WaitForExitAsync(timeout.Token);
            await stderr;
        }
        catch (OperationCanceledException) when (!cancel.IsCancellationRequested)
        {
            try { process.Kill(); } catch (InvalidOperationException) { }
            throw new UpdateVerificationException("The new version didn't answer in time.");
        }
        if (process.ExitCode != 0 || output != version)
            throw new UpdateVerificationException($"The new version doesn't run on this machine (it answered \"{Truncate(output)}\", exit code {process.ExitCode}).");
    }

    private static string Truncate(string s) => s.Length > 80 ? s[..80] + "…" : s;

    /// <summary>Moves the staged files in, keeping the ones they replace. On a failure halfway, puts everything back.</summary>
    public void Apply(string stagedDir, IReadOnlyList<string> names, string from, string to)
    {
        if (Directory.Exists(PreviousDir)) Directory.Delete(PreviousDir, recursive: true);
        Directory.CreateDirectory(PreviousDir);
        foreach (var name in new[] { "pending", "starts", "rolled-back", "added" }) File.Delete(Marker(name));
        var added = names.Where(n => !File.Exists(Path.Combine(AppDir, n))).ToList();
        File.WriteAllLines(Marker("added"), added);
        var moved = new List<string>();
        try
        {
            foreach (var name in names)
            {
                var current = Path.Combine(AppDir, name);
                if (File.Exists(current)) File.Move(current, Path.Combine(PreviousDir, name));
                File.Move(Path.Combine(stagedDir, name), current);
                moved.Add(name);
            }
            File.WriteAllText(Marker("pending"), $"{from} {to}\n");
        }
        catch
        {
            Restore(added);
            File.Delete(Marker("added"));
            throw;
        }
        finally
        {
            try { Directory.Delete(stagedDir, recursive: true); } catch (IOException) { }
        }
    }

    /// <summary>Puts the previous files back (what the guard does after three failed starts) and marks it rolled back.</summary>
    public void Rollback()
    {
        var pending = Read("pending");
        Restore(File.Exists(Marker("added")) ? File.ReadAllLines(Marker("added")) : []);
        foreach (var name in new[] { "pending", "starts", "added" }) File.Delete(Marker(name));
        if (pending is not null) File.WriteAllText(Marker("rolled-back"), $"{pending.From} {pending.To}\n");
    }

    private void Restore(IEnumerable<string> added)
    {
        foreach (var name in added.Where(n => n.Length > 0 && !n.Contains('/') && !n.Contains('\\') && !n.StartsWith('.')))
            File.Delete(Path.Combine(AppDir, name));
        if (!Directory.Exists(PreviousDir)) return;
        foreach (var file in Directory.GetFiles(PreviousDir)) File.Move(file, Path.Combine(AppDir, Path.GetFileName(file)), overwrite: true);
    }

    public UpdateMarker? Pending => Read("pending");

    /// <summary>The new version has run long enough: keep it (the previous files stay until the next update).</summary>
    public UpdateMarker? Confirm()
    {
        var pending = Read("pending");
        if (pending is null) return null;
        File.WriteAllText(Marker("last"), $"{pending.From} {pending.To}\n");
        foreach (var name in new[] { "pending", "starts", "added" }) File.Delete(Marker(name));
        return pending;
    }

    /// <summary>An update that was undone since we last looked; the marker is removed.</summary>
    public UpdateMarker? TakeRolledBack()
    {
        var marker = Read("rolled-back");
        if (marker is not null) File.Delete(Marker("rolled-back"));
        return marker;
    }

    public UpdateMarker? Last => Read("last");

    private UpdateMarker? Read(string name)
    {
        try
        {
            var parts = File.ReadAllText(Marker(name)).Split(' ', '\n', '\r').Where(p => p.Length > 0).ToArray();
            return parts.Length == 2 && Versions.IsValid(parts[0]) && Versions.IsValid(parts[1]) ? new UpdateMarker(parts[0], parts[1]) : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}
