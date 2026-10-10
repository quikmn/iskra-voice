using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Iskra.Server.Hosting;

/// <summary>
/// Makes child processes (LiveKit) die with this process, even if it's killed abruptly.
/// Windows: a job object with KILL_ON_JOB_CLOSE. Elsewhere: graceful shutdown handles it.
/// </summary>
public static class ChildProcesses
{
    private static readonly Lazy<IntPtr> Job = new(CreateJob);

    public static void Bind(Process child)
    {
        if (!OperatingSystem.IsWindows() || Job.Value == IntPtr.Zero) return;
        AssignProcessToJobObject(Job.Value, child.Handle);
    }

    private static IntPtr CreateJob()
    {
        if (!OperatingSystem.IsWindows()) return IntPtr.Zero;
        var job = CreateJobObject(IntPtr.Zero, null);
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            BasicLimitInformation = new JOBOBJECT_BASIC_LIMIT_INFORMATION { LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE },
        };
        var size = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
        var pointer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, pointer, false);
            SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)size);
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
        return job; // never closed: the OS closes it when this process exits, which kills the children
    }

    /// <summary>When started by the desktop app: shut down cleanly once it's gone (even if it crashed).</summary>
    public static void StopWhenParentExits(IHostApplicationLifetime lifetime, ILogger log)
    {
        if (!int.TryParse(Environment.GetEnvironmentVariable("ISKRA_PARENT_PID"), out var pid)) return;
        Process parent;
        try
        {
            parent = Process.GetProcessById(pid);
        }
        catch (ArgumentException)
        {
            lifetime.StopApplication();
            return;
        }
        _ = Task.Run(async () =>
        {
            await parent.WaitForExitAsync(lifetime.ApplicationStopping);
            if (lifetime.ApplicationStopping.IsCancellationRequested) return;
            log.LogInformation("The app that started this server has closed; shutting down.");
            lifetime.StopApplication();
        });
    }

    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string? name);

    [DllImport("kernel32.dll")]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll")]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
}
