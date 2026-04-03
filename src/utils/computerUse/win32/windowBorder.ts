/**
 * Visual indicator for bound windows — 4 overlay windows (top/bottom/left/right).
 *
 * Spawns a background PowerShell process that:
 * 1. Creates 4 thin WinForms overlay windows (green, semi-transparent, topmost, click-through)
 * 2. Polls the target window's position at ~30fps via GetWindowRect
 * 3. Repositions the 4 overlays to surround the target window
 * 4. Exits when a stop-signal file appears or the target window closes
 *
 * Advantages over DWM border color:
 * - Works on ALL Windows versions (not just Win11 22000+)
 * - Works on frameless / Electron windows
 * - Thicker, more visible border (configurable)
 */

import * as fs from 'fs'
import * as path from 'path'

const BORDER_THICKNESS = 3
const BORDER_COLOR_R = 0
const BORDER_COLOR_G = 200
const BORDER_COLOR_B = 0
const BORDER_OPACITY = 0.85
const POLL_INTERVAL_MS = 33 // ~30fps

// Track running overlay processes per HWND
const overlayProcesses = new Map<number, {
  proc: ReturnType<typeof Bun.spawn>
  stopFile: string
  scriptFile: string
}>()

function getTmpDir(): string {
  return process.env.TEMP || process.env.TMP || '/tmp'
}

/**
 * PowerShell script that creates 4 overlay border windows and tracks a target HWND.
 * Checks for a stop-signal file to exit cleanly.
 */
function buildOverlayScript(hwnd: number, stopFile: string): string {
  const stopFileEscaped = stopFile.replace(/\\/g, '\\\\')
  return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;

public class BorderTracker {
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_LAYERED = 0x80000;
    public const int WS_EX_TRANSPARENT = 0x20;
    public const int WS_EX_TOOLWINDOW = 0x80;
    public const int WS_EX_NOACTIVATE = 0x08000000;
    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_SHOWWINDOW = 0x0040;

    public static void MakeOverlay(IntPtr formHandle) {
        int exStyle = GetWindowLong(formHandle, GWL_EXSTYLE);
        exStyle |= WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
        SetWindowLong(formHandle, GWL_EXSTYLE, exStyle);
    }
}
'@

$targetHwnd = [IntPtr]${hwnd}
$thickness = ${BORDER_THICKNESS}
$stopFile = '${stopFileEscaped}'

function New-BorderForm {
    $f = New-Object System.Windows.Forms.Form
    $f.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
    $f.BackColor = [System.Drawing.Color]::FromArgb(${BORDER_COLOR_R}, ${BORDER_COLOR_G}, ${BORDER_COLOR_B})
    $f.Opacity = ${BORDER_OPACITY}
    $f.ShowInTaskbar = $false
    $f.TopMost = $true
    $f.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
    $f.Size = New-Object System.Drawing.Size(1, 1)
    $f.Location = New-Object System.Drawing.Point(-32000, -32000)
    return $f
}

$top = New-BorderForm
$bottom = New-BorderForm
$left = New-BorderForm
$right = New-BorderForm

$top.Show()
$bottom.Show()
$left.Show()
$right.Show()

[BorderTracker]::MakeOverlay($top.Handle)
[BorderTracker]::MakeOverlay($bottom.Handle)
[BorderTracker]::MakeOverlay($left.Handle)
[BorderTracker]::MakeOverlay($right.Handle)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = ${POLL_INTERVAL_MS}

$script:lastLeft = 0
$script:lastTop = 0
$script:lastRight = 0
$script:lastBottom = 0
$script:stopCheckCounter = 0

$timer.Add_Tick({
    # Check stop signal every ~10 ticks (~330ms) to reduce I/O
    $script:stopCheckCounter++
    if ($script:stopCheckCounter -ge 10) {
        $script:stopCheckCounter = 0
        if (Test-Path $stopFile) {
            $timer.Stop()
            $top.Close(); $bottom.Close(); $left.Close(); $right.Close()
            try { Remove-Item $stopFile -ErrorAction SilentlyContinue } catch {}
            [System.Windows.Forms.Application]::ExitThread()
            return
        }
    }

    # Check if target window still exists
    if (-not [BorderTracker]::IsWindow($targetHwnd)) {
        $timer.Stop()
        $top.Close(); $bottom.Close(); $left.Close(); $right.Close()
        try { Remove-Item $stopFile -ErrorAction SilentlyContinue } catch {}
        [System.Windows.Forms.Application]::ExitThread()
        return
    }

    $rect = New-Object BorderTracker+RECT
    if (-not [BorderTracker]::GetWindowRect($targetHwnd, [ref]$rect)) { return }

    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    if ($w -le 0 -or $h -le 0 -or $rect.Left -le -30000) {
        $top.Visible = $false; $bottom.Visible = $false
        $left.Visible = $false; $right.Visible = $false
        return
    }

    # Only update if position changed
    if ($rect.Left -eq $script:lastLeft -and $rect.Top -eq $script:lastTop -and $rect.Right -eq $script:lastRight -and $rect.Bottom -eq $script:lastBottom) { return }
    $script:lastLeft = $rect.Left; $script:lastTop = $rect.Top
    $script:lastRight = $rect.Right; $script:lastBottom = $rect.Bottom

    # Top bar
    [BorderTracker]::SetWindowPos($top.Handle, [BorderTracker]::HWND_TOPMOST,
        $rect.Left, ($rect.Top - $thickness), $w, $thickness,
        [BorderTracker]::SWP_NOACTIVATE -bor [BorderTracker]::SWP_SHOWWINDOW) | Out-Null
    $top.Visible = $true

    # Bottom bar
    [BorderTracker]::SetWindowPos($bottom.Handle, [BorderTracker]::HWND_TOPMOST,
        $rect.Left, $rect.Bottom, $w, $thickness,
        [BorderTracker]::SWP_NOACTIVATE -bor [BorderTracker]::SWP_SHOWWINDOW) | Out-Null
    $bottom.Visible = $true

    # Left bar (includes corners)
    [BorderTracker]::SetWindowPos($left.Handle, [BorderTracker]::HWND_TOPMOST,
        ($rect.Left - $thickness), ($rect.Top - $thickness), $thickness, ($h + 2 * $thickness),
        [BorderTracker]::SWP_NOACTIVATE -bor [BorderTracker]::SWP_SHOWWINDOW) | Out-Null
    $left.Visible = $true

    # Right bar (includes corners)
    [BorderTracker]::SetWindowPos($right.Handle, [BorderTracker]::HWND_TOPMOST,
        $rect.Right, ($rect.Top - $thickness), $thickness, ($h + 2 * $thickness),
        [BorderTracker]::SWP_NOACTIVATE -bor [BorderTracker]::SWP_SHOWWINDOW) | Out-Null
    $right.Visible = $true
})

$timer.Start()
[System.Windows.Forms.Application]::Run()
`
}

/**
 * Start overlay border around a bound window.
 * Spawns a background PowerShell process with 4 overlay windows.
 */
export function markBound(hwnd: number): boolean {
  try {
    // Kill existing overlay for this HWND if any
    unmarkBound(hwnd)

    const tmpDir = getTmpDir()
    const ts = Date.now()
    const stopFile = path.join(tmpDir, `cu_border_stop_${hwnd}_${ts}`)
    const scriptFile = path.join(tmpDir, `cu_border_${hwnd}_${ts}.ps1`)

    const script = buildOverlayScript(hwnd, stopFile)
    fs.writeFileSync(scriptFile, script, 'utf-8')

    const proc = Bun.spawn(
      ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile],
      {
        stdout: 'ignore',
        stderr: 'ignore',
      },
    )

    overlayProcesses.set(hwnd, { proc, stopFile, scriptFile })
    return true
  } catch {
    return false
  }
}

/**
 * Remove overlay border, signal the background PowerShell process to exit.
 */
export function unmarkBound(hwnd: number): boolean {
  const entry = overlayProcesses.get(hwnd)
  if (!entry) return true
  try {
    // Write stop-signal file — the PS script checks for this
    fs.writeFileSync(entry.stopFile, 'STOP', 'utf-8')
    // Force kill after 3s if still alive
    setTimeout(() => {
      try { entry.proc.kill() } catch {}
      // Clean up temp files
      try { fs.unlinkSync(entry.scriptFile) } catch {}
      try { fs.unlinkSync(entry.stopFile) } catch {}
    }, 3000)
    overlayProcesses.delete(hwnd)
    return true
  } catch {
    overlayProcesses.delete(hwnd)
    return false
  }
}

/**
 * Kill all overlay processes (cleanup on exit).
 */
export function cleanupAllBorders(): void {
  for (const [hwnd] of overlayProcesses) {
    unmarkBound(hwnd)
  }
}

/**
 * Set custom border color — not supported in overlay mode without restart.
 * Kept for API compatibility.
 */
export function setBorderColor(_hwnd: number, _r: number, _g: number, _b: number): boolean {
  // Dynamic color change would require restarting the overlay process.
  // For now, return false to indicate not supported.
  return false
}
