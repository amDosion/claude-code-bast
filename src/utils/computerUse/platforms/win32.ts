/**
 * Windows platform backend for Computer Use.
 *
 * Combines:
 * - PowerShell SetCursorPos/SendInput for global input (fallback)
 * - win32/windowMessage.ts for window-bound SendMessage input (preferred)
 * - win32/windowCapture.ts for PrintWindow screenshots
 * - win32/windowEnum.ts for EnumWindows app listing
 * - PowerShell CopyFromScreen for full-screen/region screenshots
 * - PowerShell Screen.AllScreens for display enumeration
 *
 * CRITICAL: All screenshots output JPEG (ImageFormat::Jpeg), not PNG.
 */

import type { Platform } from './index.js'
import type {
  InputPlatform,
  ScreenshotPlatform,
  DisplayPlatform,
  AppsPlatform,
  WindowHandle,
  ScreenshotResult,
  DisplayInfo,
  InstalledApp,
  FrontmostAppInfo,
} from './types.js'
import { listWindows } from '../win32/windowEnum.js'
import { captureWindowByHwnd } from '../win32/windowCapture.js'
import { detectAppType, openWithController } from '../win32/appDispatcher.js'
import { markBound, unmarkBound, cleanupAllBorders } from '../win32/windowBorder.js'

// ---------------------------------------------------------------------------
// PowerShell helpers
// ---------------------------------------------------------------------------

function ps(script: string): string {
  const result = Bun.spawnSync({
    cmd: ['powershell', '-NoProfile', '-NonInteractive', '-Command', script],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return new TextDecoder().decode(result.stdout).trim()
}

async function psAsync(script: string): Promise<string> {
  const proc = Bun.spawn(
    ['powershell', '-NoProfile', '-NonInteractive', '-Command', script],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out.trim()
}

// ---------------------------------------------------------------------------
// Win32 P/Invoke types (compiled once per PS session)
// ---------------------------------------------------------------------------

const WIN32_TYPES = `
Add-Type -Language CSharp @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Diagnostics;

public class CuWin32 {
    // --- Cursor ---
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

    // --- SendInput ---
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
        public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Explicit)] public struct INPUT {
        [FieldOffset(0)] public uint type;
        [FieldOffset(4)] public MOUSEINPUT mi;
    }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
        public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Explicit)] public struct KINPUT {
        [FieldOffset(0)] public uint type;
        [FieldOffset(4)] public KEYBDINPUT ki;
    }
    [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] i, int cb);
    [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, KINPUT[] i, int cb);

    // --- Keyboard ---
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);

    // --- Window ---
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);

    // Constants
    public const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
    public const uint MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000;
    public const uint KEYEVENTF_KEYUP = 0x0002;
}
'@
`

// ---------------------------------------------------------------------------
// Virtual key code mapping
// ---------------------------------------------------------------------------

const VK_MAP: Record<string, number> = {
  return: 0x0D, enter: 0x0D, tab: 0x09, space: 0x20,
  backspace: 0x08, delete: 0x2E, escape: 0x1B, esc: 0x1B,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7A, f12: 0x7B,
  shift: 0xA0, lshift: 0xA0, rshift: 0xA1,
  control: 0xA2, ctrl: 0xA2, lcontrol: 0xA2, rcontrol: 0xA3,
  alt: 0xA4, option: 0xA4, lalt: 0xA4, ralt: 0xA5,
  win: 0x5B, meta: 0x5B, command: 0x5B, cmd: 0x5B, super: 0x5B,
  insert: 0x2D, printscreen: 0x2C, pause: 0x13,
  numlock: 0x90, capslock: 0x14, scrolllock: 0x91,
}

const MODIFIER_KEYS = new Set([
  'shift', 'lshift', 'rshift', 'control', 'ctrl', 'lcontrol', 'rcontrol',
  'alt', 'option', 'lalt', 'ralt', 'win', 'meta', 'command', 'cmd', 'super',
])

// ---------------------------------------------------------------------------
// Session-level HWND binding — all operations target this handle
// ---------------------------------------------------------------------------

let boundHwnd: number | null = null
let boundPid: number | null = null
let boundAppType: import('../win32/appDispatcher.js').AppType | null = null
let boundFilePath: string | null = null

/** Get the bound HWND, or null if not bound */
export function getBoundHwnd(): number | null { return boundHwnd }

/** Get the bound app type */
export function getBoundAppType(): string | null { return boundAppType }

/** Get the bound file path (for COM-controlled apps) */
export function getBoundFilePath(): string | null { return boundFilePath }

/** Bind to a window HWND — all subsequent input/screenshot operations target this handle */
export function bindWindow(hwnd: number, pid?: number): void {
  // Unmark previous window if any
  if (boundHwnd) unmarkBound(boundHwnd)
  boundHwnd = hwnd
  boundPid = pid ?? null
  boundAppType = 'generic'
  boundFilePath = null
  // Green border on the bound window
  markBound(hwnd)
}

/** Bind to a COM-controlled file (Excel/Word — no window needed) */
export function bindFile(filePath: string, appType: import('../win32/appDispatcher.js').AppType): void {
  boundHwnd = null
  boundPid = null
  boundAppType = appType
  boundFilePath = filePath
}

/** Unbind — revert to global mode, remove green border */
export function unbindWindow(): void {
  if (boundHwnd) unmarkBound(boundHwnd)
  boundHwnd = null
  boundPid = null
  boundAppType = null
  boundFilePath = null
}

// ---------------------------------------------------------------------------
// Window Message module (lazy loaded)
// ---------------------------------------------------------------------------

let _wm: typeof import('../win32/windowMessage.js') | undefined
function getWm() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (_wm ??= require('../win32/windowMessage.js') as typeof import('../win32/windowMessage.js'))
}

// ---------------------------------------------------------------------------
// Input — ALL text/key input goes through SendMessage when HWND is bound.
// Global SendInput/keybd_event is DISABLED to avoid interfering with user.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Input — When HWND is bound, ALL operations go through SendMessage.
// NO global API (SetCursorPos/SendInput/keybd_event/SendKeys) is used.
// This ensures the user's desktop is never disturbed.
// ---------------------------------------------------------------------------

const input: InputPlatform = {
  async moveMouse(x, y) {
    if (boundHwnd) {
      // Bound mode: no-op. Mouse position is meaningless for SendMessage operations.
      // Clicks use window-relative coordinates via sendClick.
      return
    }
    ps(`${WIN32_TYPES}; [CuWin32]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null`)
  },

  async click(x, y, button) {
    if (boundHwnd) {
      getWm().sendClick(boundHwnd, Math.round(x), Math.round(y), button)
      return
    }
    const downFlag = button === 'left' ? 'MOUSEEVENTF_LEFTDOWN' : button === 'right' ? 'MOUSEEVENTF_RIGHTDOWN' : 'MOUSEEVENTF_MIDDLEDOWN'
    const upFlag = button === 'left' ? 'MOUSEEVENTF_LEFTUP' : button === 'right' ? 'MOUSEEVENTF_RIGHTUP' : 'MOUSEEVENTF_MIDDLEUP'
    ps(`${WIN32_TYPES}; [CuWin32]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null; $i = New-Object CuWin32+INPUT; $i.type=[CuWin32]::INPUT_MOUSE; $i.mi.dwFlags=[CuWin32]::${downFlag}; [CuWin32]::SendInput(1, @($i), [Runtime.InteropServices.Marshal]::SizeOf($i)) | Out-Null; $i.mi.dwFlags=[CuWin32]::${upFlag}; [CuWin32]::SendInput(1, @($i), [Runtime.InteropServices.Marshal]::SizeOf($i)) | Out-Null`)
  },

  async typeText(text) {
    // COM-controlled apps: write directly via COM API
    if (boundAppType === 'word' && boundFilePath) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { appendText } = require('../win32/comWord.js') as typeof import('../win32/comWord.js')
      appendText(boundFilePath, text)
      return
    }
    // HWND-bound apps: SendMessage
    if (boundHwnd) {
      getWm().sendText(boundHwnd, text)
      return
    }
    throw new Error('typeText requires a bound window or file. Call open() first.')
  },

  async key(name, action) {
    if (boundHwnd) {
      const lower = name.toLowerCase()
      const vk = VK_MAP[lower] ?? (name.length === 1 ? name.charCodeAt(0) : 0)
      if (vk) getWm().sendKey(boundHwnd, vk, action === 'release' ? 'up' : 'down')
      return
    }
    throw new Error('key requires a bound window HWND. Call open() first.')
  },

  async keys(parts) {
    if (boundHwnd) {
      getWm().sendKeys(boundHwnd, parts)
      return
    }
    throw new Error('keys requires a bound window HWND. Call open() first.')
  },

  async scroll(amount, direction) {
    if (boundHwnd) {
      // WM_VSCROLL / WM_HSCROLL for window-bound scrolling
      const msg = direction === 'vertical' ? '0x0115' : '0x0114' // WM_VSCROLL / WM_HSCROLL
      const wParam = amount > 0 ? '0' : '1' // SB_LINEUP=0 / SB_LINEDOWN=1
      const n = Math.abs(Math.round(amount))
      let script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WScroll {
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
'@
`
      for (let i = 0; i < n; i++) {
        script += `[WScroll]::SendMessage([IntPtr]${boundHwnd}, ${msg}, [IntPtr]${wParam}, [IntPtr]::Zero) | Out-Null; `
      }
      ps(script)
      return
    }
    const flag = direction === 'vertical' ? 'MOUSEEVENTF_WHEEL' : 'MOUSEEVENTF_HWHEEL'
    ps(`${WIN32_TYPES}; $i = New-Object CuWin32+INPUT; $i.type=[CuWin32]::INPUT_MOUSE; $i.mi.dwFlags=[CuWin32]::${flag}; $i.mi.mouseData=${amount * 120}; [CuWin32]::SendInput(1, @($i), [Runtime.InteropServices.Marshal]::SizeOf($i)) | Out-Null`)
  },

  async mouseLocation() {
    // Always returns real cursor position (informational, doesn't move it)
    const out = ps(`${WIN32_TYPES}; $p = New-Object CuWin32+POINT; [CuWin32]::GetCursorPos([ref]$p) | Out-Null; "$($p.X),$($p.Y)"`)
    const [xStr, yStr] = out.split(',')
    return { x: Number(xStr), y: Number(yStr) }
  },

  async sendChar(hwnd, char) { getWm().sendChar(Number(hwnd), char) },
  async sendKey(hwnd, vk, action) { getWm().sendKey(Number(hwnd), vk, action) },
  async sendClick(hwnd, x, y, button) { getWm().sendClick(Number(hwnd), x, y, button) },
  async sendText(hwnd, text) { getWm().sendText(Number(hwnd), text) },
}

// ---------------------------------------------------------------------------
// Screenshot — JPEG output only
// ---------------------------------------------------------------------------

function parseCaptureOutput(raw: string): ScreenshotResult | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === 'NOT_FOUND' || trimmed === 'INVALID_SIZE') return null
  const firstComma = trimmed.indexOf(',')
  const secondComma = trimmed.indexOf(',', firstComma + 1)
  if (firstComma === -1 || secondComma === -1) return null
  const width = Number(trimmed.slice(0, firstComma))
  const height = Number(trimmed.slice(firstComma + 1, secondComma))
  const base64 = trimmed.slice(secondComma + 1)
  if (!width || !height || !base64) return null
  return { base64, width, height }
}

const screenshot: ScreenshotPlatform = {
  async captureScreen(displayId) {
    // If HWND is bound, capture that specific window via PrintWindow
    if (boundHwnd) {
      const result = this.captureWindow?.(String(boundHwnd))
      if (result) return result
    }
    // Full-screen: save JPEG to temp file, read back as base64
    const tmpFile = `${process.env.TEMP || '/tmp'}/cu_screen_${Date.now()}.jpg`.replace(/\\/g, '\\\\')
    const raw = await psAsync(`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screen = if (${displayId ?? -1} -ge 0) { [System.Windows.Forms.Screen]::AllScreens[${displayId ?? 0}] } else { [System.Windows.Forms.Screen]::PrimaryScreen }
$bounds = $screen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$g.Dispose()
$bmp.Save('${tmpFile}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$bmp.Dispose()
"$($bounds.Width),$($bounds.Height)"
`)
    const [wStr, hStr] = (raw || '').split(',')
    try {
      const fs = require('fs')
      const buf = fs.readFileSync(tmpFile.replace(/\\\\/g, '\\'))
      try { fs.unlinkSync(tmpFile.replace(/\\\\/g, '\\')) } catch {}
      return { base64: buf.toString('base64'), width: Number(wStr), height: Number(hStr) }
    } catch {
      return { base64: '', width: 0, height: 0 }
    }
  },

  async captureRegion(x, y, w, h) {
    // When HWND is bound, always use PrintWindow (captures the bound window only)
    if (boundHwnd) {
      const result = this.captureWindow?.(String(boundHwnd))
      if (result) return result
    }
    // No HWND bound: fall back to CopyFromScreen (captures real screen area)
    const tmpFile = `${process.env.TEMP || '/tmp'}/cu_region_${Date.now()}.jpg`.replace(/\\/g, '\\\\')
    const raw = await psAsync(`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(${w}, ${h})
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${x}, ${y}, 0, 0, (New-Object System.Drawing.Size(${w}, ${h})))
$g.Dispose()
$bmp.Save('${tmpFile}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$bmp.Dispose()
"${w},${h}"
`)
    const [wStr, hStr] = (raw || '').split(',')
    try {
      const fs = require('fs')
      const buf = fs.readFileSync(tmpFile.replace(/\\\\/g, '\\'))
      try { fs.unlinkSync(tmpFile.replace(/\\\\/g, '\\')) } catch {}
      return { base64: buf.toString('base64'), width: Number(wStr), height: Number(hStr) }
    } catch {
      return { base64: '', width: w, height: h }
    }
  },

  captureWindow(hwnd) {
    // PrintWindow via win32/windowCapture.ts — now outputs JPEG directly via temp file
    return captureWindowByHwnd(Number(hwnd))
  },
}

// ---------------------------------------------------------------------------
// Display — Screen.AllScreens
// ---------------------------------------------------------------------------

const display: DisplayPlatform = {
  listAll(): DisplayInfo[] {
    try {
      const raw = ps(`
Add-Type -AssemblyName System.Windows.Forms
$result = @()
$idx = 0
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
  $result += "$($s.Bounds.Width),$($s.Bounds.Height),$idx,$($s.Primary)"
  $idx++
}
$result -join "|"
`)
      return raw.split('|').filter(Boolean).map(entry => {
        const [w, h, id] = entry.split(',')
        return {
          width: Number(w),
          height: Number(h),
          scaleFactor: 1,
          displayId: Number(id),
        }
      })
    } catch {
      return [{ width: 1920, height: 1080, scaleFactor: 1, displayId: 0 }]
    }
  },

  getSize(displayId): DisplayInfo {
    const all = this.listAll()
    if (displayId !== undefined) {
      const found = all.find(d => d.displayId === displayId)
      if (found) return found
    }
    return all[0] ?? { width: 1920, height: 1080, scaleFactor: 1, displayId: 0 }
  },
}

// ---------------------------------------------------------------------------
// Apps — EnumWindows + registry + AppxPackage
// ---------------------------------------------------------------------------

const apps: AppsPlatform = {
  listRunning(): WindowHandle[] {
    const windows = listWindows()
    return windows.map(w => ({
      id: String(w.hwnd),
      pid: w.pid,
      title: w.title,
    }))
  },

  async listInstalled(): Promise<InstalledApp[]> {
    try {
      const raw = await psAsync(`
$apps = @()

# Traditional Win32 apps from registry
$paths = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
foreach ($p in $paths) {
  Get-ItemProperty $p -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | ForEach-Object {
    $apps += "$($_.DisplayName)|$($_.InstallLocation)|$($_.PSChildName)"
  }
}

# UWP/MSIX apps (Windows 10/11 Store apps)
Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.IsFramework -eq $false -and $_.SignatureKind -eq 'Store' } | ForEach-Object {
  $cleanName = $_.Name -replace '^Microsoft\\.Windows', '' -replace '^Microsoft\\.', ''
  $apps += "$cleanName|$($_.InstallLocation)|$($_.PackageFamilyName)"
}

$apps | Select-Object -Unique | Select-Object -First 300
`)
      return raw.split('\n').filter(Boolean).map(line => {
        const [name, path, id] = line.trim().split('|', 3)
        return {
          id: (id ?? name ?? '').trim(),
          displayName: (name ?? '').trim(),
          path: (path ?? '').trim(),
        }
      })
    } catch {
      return []
    }
  },

  async open(name) {
    // Detect app type and route to appropriate controller
    const appType = detectAppType(name)

    // Excel/Word → COM automation (no window, no HWND)
    if (appType === 'excel' || appType === 'word') {
      const result = await openWithController(name)
      if (result.filePath) {
        bindFile(result.filePath, result.type)
      }
      return
    }

    // Text/Browser/Generic → exe launch + HWND bind (offscreen)
    // If name is a UWP PackageFamilyName (e.g. Microsoft.WindowsNotepad_8wekyb3d8bbwe),
    // extract the app name and try as exe. This avoids launching through UWP shell.
    let launchName = name
    if (name.includes('_') && name.includes('.')) {
      // Microsoft.WindowsNotepad_xxx → Notepad
      // Microsoft.WindowsCalculator_xxx → Calculator
      // Microsoft.WindowsTerminal_xxx → Terminal
      const parts = name.split('_')[0]?.split('.') ?? []
      const appPart = parts[parts.length - 1] ?? name
      // Strip "Windows" prefix: WindowsNotepad → Notepad
      launchName = appPart.replace(/^Windows/, '') || appPart
    }
    const escaped = launchName.replace(/'/g, "''")
    const result = await psAsync(`
${WIN32_TYPES}
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class CuLaunch {
    public delegate bool EnumProc(IntPtr h, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    public const int SW_SHOWMINNOACTIVE = 7;
    // Get all visible window HWNDs as array
    public static long[] GetAllVisibleHwnds() {
        var list = new System.Collections.Generic.List<long>();
        EnumWindows((h, _) => {
            if (IsWindowVisible(h)) list.Add(h.ToInt64());
            return true;
        }, IntPtr.Zero);
        return list.ToArray();
    }
    // Get PID for a single HWND
    public static uint GetPidForHwnd(long hwnd) {
        uint pid; GetWindowThreadProcessId((IntPtr)hwnd, out pid);
        return pid;
    }
    // Get title for a single HWND
    public static string GetTitle(long hwnd) {
        var sb = new StringBuilder(256);
        GetWindowText((IntPtr)hwnd, sb, 256);
        return sb.ToString();
    }
}
'@
# Launch strategy: all exe-based, no GUI dialogs.
# 1) exact path  2) exe in PATH  3) registry install dir  4) raw name
$target = '${escaped}'
$proc = $null

# 1. Exact file path
if (Test-Path $target) {
    $proc = Start-Process $target -PassThru -ErrorAction SilentlyContinue
}

# 2. exe name in PATH (notepad.exe, code.exe, chrome.exe, etc.)
if (-not $proc) {
    # Try with .exe suffix if not already
    $tryExe = if ($target -notmatch '\.exe$') { "$target.exe" } else { $target }
    $found = Get-Command $tryExe -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $found) { $found = Get-Command $target -ErrorAction SilentlyContinue | Select-Object -First 1 }
    if ($found) { $proc = Start-Process $found.Source -PassThru -ErrorAction SilentlyContinue }
}

# 3. Search registry for install location by display name → find .exe
if (-not $proc) {
    $regPaths = @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')
    foreach ($p in $regPaths) {
        $app = Get-ItemProperty $p -ErrorAction SilentlyContinue | Where-Object {
            $_.DisplayName -and $_.DisplayName -match [regex]::Escape($target)
        } | Select-Object -First 1
        if ($app) {
            # Try DisplayIcon (often the exe path), then InstallLocation
            $exePath = $null
            if ($app.DisplayIcon -and $app.DisplayIcon -match '\.exe') {
                $exePath = ($app.DisplayIcon -split ',')[0].Trim('"')
            }
            if (-not $exePath -and $app.InstallLocation) {
                $exeFile = Get-ChildItem $app.InstallLocation -Filter '*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($exeFile) { $exePath = $exeFile.FullName }
            }
            if ($exePath -and (Test-Path $exePath)) {
                $proc = Start-Process $exePath -PassThru -ErrorAction SilentlyContinue
                break
            }
        }
    }
}

# 4. Last resort: direct Start-Process (Windows may resolve it)
if (-not $proc) { $proc = Start-Process -FilePath $target -PassThru -ErrorAction SilentlyContinue }

if (-not $proc) { Write-Host "LAUNCH_FAILED"; exit }

# Snapshot ALL visible window HWNDs before the new window appears
$beforeHwnds = [CuLaunch]::GetAllVisibleHwnds()

# Wait for a NEW window from our process PID
$hwnd = 0
for ($i = 0; $i -lt 50; $i++) {
    Start-Sleep -Milliseconds 200
    $afterHwnds = [CuLaunch]::GetAllVisibleHwnds()
    # Find new windows (in after but not in before)
    foreach ($h in $afterHwnds) {
        if ($beforeHwnds -contains $h) { continue }
        # New window found — check PID
        $wPid = [CuLaunch]::GetPidForHwnd($h)
        if ($wPid -eq [uint32]$proc.Id) {
            $hwnd = $h; break  # exact PID match
        }
    }
    if ($hwnd -ne 0) { break }
    # PID didn't match (process redirect) — accept new window matching title hint
    if ($i -gt 10) {
        $hint = '${escaped}'.Split('\')[-1].Replace('.exe','')
        foreach ($h in $afterHwnds) {
            if ($beforeHwnds -contains $h) { continue }
            $title = [CuLaunch]::GetTitle($h)
            if ($title -and $title.IndexOf($hint, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                $hwnd = $h; break
            }
        }
        if ($hwnd -ne 0) { break }
    }
}
if ($hwnd -eq 0) { Write-Host "HWND_NOT_FOUND|$($proc.Id)"; exit }
# Move offscreen instead of minimizing — keeps window restored so
# PrintWindow and SendMessage work without needing restore/re-minimize.
# User cannot see the window at -32000,-32000.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class CuPos {
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int h2, uint f);
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOZORDER = 0x0004;
    public const uint SWP_NOACTIVATE = 0x0010;
}
'@
[CuPos]::SetWindowPos([IntPtr]$hwnd, [IntPtr]::Zero, -32000, -32000, 0, 0, [CuPos]::SWP_NOSIZE -bor [CuPos]::SWP_NOZORDER -bor [CuPos]::SWP_NOACTIVATE) | Out-Null
Write-Host "$hwnd|$($proc.Id)"
`)
    if (!result || result.startsWith('LAUNCH_FAILED') || result.startsWith('HWND_NOT_FOUND')) {
      return
    }
    const parts = result.trim().split('|')
    const hwnd = Number(parts[0])
    const pid = Number(parts[1])
    if (hwnd > 0) {
      // Bind to the launched window — all subsequent operations target this HWND
      bindWindow(hwnd, pid)
    }
  },

  getFrontmostApp(): FrontmostAppInfo | null {
    try {
      const out = ps(`${WIN32_TYPES}
$hwnd = [CuWin32]::GetForegroundWindow()
$procId = [uint32]0
[CuWin32]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
$proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
"$($proc.MainModule.FileName)|$($proc.ProcessName)"`)
      if (!out || !out.includes('|')) return null
      const [exePath, appName] = out.split('|', 2)
      return { id: exePath!, appName: appName! }
    } catch {
      return null
    }
  },

  findWindowByTitle(title): WindowHandle | null {
    const windows = listWindows()
    const found = windows.find(w => w.title.includes(title))
    if (!found) return null
    return { id: String(found.hwnd), pid: found.pid, title: found.title }
  },
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

// Clean up overlay borders on process exit
process.on('exit', () => cleanupAllBorders())
process.on('SIGINT', () => { cleanupAllBorders(); process.exit() })
process.on('SIGTERM', () => { cleanupAllBorders(); process.exit() })

export const platform: Platform = { input, screenshot, display, apps }
