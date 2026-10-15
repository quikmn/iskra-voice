// Where the desktop app's windows go while the e2e suite drives it (desktop/src/testMode.ts places them).
// ISKRA_E2E_DISPLAY: "offscreen" (default: far off every monitor, still rendering, never focused, off the taskbar),
// "terminal" (the monitor of the window in front when the run starts, i.e. your terminal), a number (that monitor,
// 0-based, Windows' order) or "primary" (Electron's normal placement). Worked out once per run and handed to every
// electron.launch through ISKRA_E2E_WINDOW_AREA (the specs pass process.env on).
// Also: the desktop app under test never sees the developer's own hosted servers (Documents/Iskra/Servers) and only
// ever listens on localhost. A spec that hosts servers gives the app its own ISKRA_HOST_ROOT.
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** C# for one PowerShell call: a monitor's work area in physical pixels, "x,y,w,h". index < 0: the foreground window's. */
const MONITOR_CS = `
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class IskraMonitor {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct INFO { public int Size; public RECT Monitor; public RECT Work; public int Flags; }
  public delegate bool EnumProc(IntPtr monitor, IntPtr hdc, ref RECT rect, IntPtr data);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, int flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref INFO info);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, EnumProc proc, IntPtr data);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  static string Work(IntPtr monitor) {
    var info = new INFO(); info.Size = Marshal.SizeOf(info);
    if (!GetMonitorInfo(monitor, ref info)) return "";
    return info.Work.L + "," + info.Work.T + "," + (info.Work.R - info.Work.L) + "," + (info.Work.B - info.Work.T);
  }
  public static string Area(int index) {
    SetThreadDpiAwarenessContext(new IntPtr(-4)); // per-monitor aware: physical pixels, as Electron's screenToDipRect wants
    if (index < 0) return Work(MonitorFromWindow(GetForegroundWindow(), 2));
    var monitors = new List<IntPtr>();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr m, IntPtr h, ref RECT r, IntPtr d) => { monitors.Add(m); return true; }, IntPtr.Zero);
    return index < monitors.Count ? Work(monitors[index]) : "";
  }
}`

function monitorArea(index: number): string | null {
  if (process.platform !== 'win32') return null // elsewhere: the primary monitor
  try {
    const script = `Add-Type -TypeDefinition @'\n${MONITOR_CS}\n'@\n[IskraMonitor]::Area(${index})`
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 20_000, windowsHide: true }).trim()
    return /^-?\d+,-?\d+,\d+,\d+$/.test(out) ? out : null
  } catch {
    return null
  }
}

export function windowArea(display: string): string {
  if (display === '' || display === 'offscreen') return 'offscreen'
  if (display === 'terminal') return monitorArea(-1) ?? 'primary'
  if (/^\d+$/.test(display)) return monitorArea(Number(display)) ?? 'primary'
  return 'primary'
}

export default function globalSetup(): void {
  process.env.ISKRA_E2E_WINDOW_AREA ??= windowArea((process.env.ISKRA_E2E_DISPLAY ?? '').trim().toLowerCase())
  process.env.ISKRA_HOST_ROOT ??= mkdtempSync(join(tmpdir(), 'iskra-e2e-hosted-'))
  process.env.ISKRA_LOCAL_ONLY ??= '1'
}
