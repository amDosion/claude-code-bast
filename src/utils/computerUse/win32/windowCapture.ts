/**
 * Window-level screenshot capture using Win32 PrintWindow API.
 * Captures windows even when occluded or minimized.
 */

interface CaptureResult {
  base64: string
  width: number
  height: number
}

const CAPTURE_BY_TITLE_PS = `
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing @'
using System;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;
public class WinCap {
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    public static extern IntPtr FindWindow(string c, string t);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int L, T, R, B; }

    public static string Capture(string title) {
        IntPtr hwnd = FindWindow(null, title);
        if (hwnd == IntPtr.Zero) return "NOT_FOUND";
        RECT r; GetWindowRect(hwnd, out r);
        int w = r.R - r.L; int h = r.B - r.T;
        if (w <= 0 || h <= 0) return "INVALID_SIZE";
        Bitmap bmp = new Bitmap(w, h);
        Graphics g = Graphics.FromImage(bmp);
        IntPtr hdc = g.GetHdc();
        PrintWindow(hwnd, hdc, 2);
        g.ReleaseHdc(hdc); g.Dispose();
        var ms = new System.IO.MemoryStream();
        bmp.Save(ms, ImageFormat.Png);
        bmp.Dispose();
        return w + "," + h + "," + Convert.ToBase64String(ms.ToArray());
    }
}
'@
`

const CAPTURE_BY_HWND_PS = `
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing @'
using System;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;
public class WinCapH {
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int L, T, R, B; }
    public const int SW_RESTORE = 9;
    public const int SW_SHOWMINNOACTIVE = 7;

    [DllImport("user32.dll")]
    public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT wp);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT wp);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT2 { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    public struct WINDOWPLACEMENT {
        public int length; public int flags; public int showCmd;
        public POINT2 ptMinPosition; public POINT2 ptMaxPosition;
        public RECT rcNormalPosition;
    }
    public const int SW_SHOWNOACTIVATE = 4;

    public static string Capture(IntPtr hwnd) {
        if (!IsWindow(hwnd)) return "NOT_FOUND";

        bool wasMinimized = IsIconic(hwnd);
        WINDOWPLACEMENT origWp = new WINDOWPLACEMENT();
        origWp.length = Marshal.SizeOf(origWp);

        if (wasMinimized) {
            // Save original placement, temporarily restore offscreen
            GetWindowPlacement(hwnd, ref origWp);
            RECT rc = origWp.rcNormalPosition;
            int nw = rc.R - rc.L; int nh = rc.B - rc.T;
            if (nw <= 0 || nh <= 0) return "INVALID_SIZE";

            WINDOWPLACEMENT tempWp = origWp;
            tempWp.showCmd = SW_SHOWNOACTIVATE;
            tempWp.rcNormalPosition = new RECT { L = -32000, T = -32000, R = -32000 + nw, B = -32000 + nh };
            SetWindowPlacement(hwnd, ref tempWp);
            System.Threading.Thread.Sleep(100);
        }

        RECT r; GetWindowRect(hwnd, out r);
        int w = r.R - r.L; int h = r.B - r.T;
        if (w <= 0 || h <= 0) {
            if (wasMinimized) SetWindowPlacement(hwnd, ref origWp);
            return "INVALID_SIZE";
        }

        Bitmap bmp = new Bitmap(w, h);
        Graphics g = Graphics.FromImage(bmp);
        IntPtr hdc = g.GetHdc();
        PrintWindow(hwnd, hdc, 2); // PW_RENDERFULLCONTENT
        g.ReleaseHdc(hdc); g.Dispose();

        string tmp = System.IO.Path.GetTempFileName() + ".jpg";
        bmp.Save(tmp, ImageFormat.Jpeg);
        bmp.Dispose();

        // Restore minimized state
        if (wasMinimized) SetWindowPlacement(hwnd, ref origWp);

        return w + "," + h + "," + tmp;
    }
}
'@
`

function parseCaptureOutput(raw: string): CaptureResult | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === 'NOT_FOUND' || trimmed === 'INVALID_SIZE') {
    return null
  }
  const firstComma = trimmed.indexOf(',')
  const secondComma = trimmed.indexOf(',', firstComma + 1)
  if (firstComma === -1 || secondComma === -1) return null

  const width = Number(trimmed.slice(0, firstComma))
  const height = Number(trimmed.slice(firstComma + 1, secondComma))
  const thirdPart = trimmed.slice(secondComma + 1)

  if (!width || !height || !thirdPart) return null

  // Third part is a temp file path (JPEG) — read and convert to base64
  try {
    const fs = require('fs')
    const buf = fs.readFileSync(thirdPart)
    const base64 = buf.toString('base64')
    // Clean up temp file
    try { fs.unlinkSync(thirdPart) } catch {}
    return { base64, width, height }
  } catch {
    return null
  }
}

function runPs(script: string): string {
  const result = Bun.spawnSync({
    cmd: ['powershell', '-NoProfile', '-NonInteractive', '-Command', script],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return new TextDecoder().decode(result.stdout).trim()
}

/**
 * Capture a window screenshot by its exact title.
 * Uses PrintWindow which works even for occluded/background windows.
 */
export function captureWindow(title: string): CaptureResult | null {
  const escaped = title.replace(/'/g, "''")
  const script = `${CAPTURE_BY_TITLE_PS}\n[WinCap]::Capture('${escaped}')`
  const raw = runPs(script)
  return parseCaptureOutput(raw)
}

/**
 * Capture a window screenshot by its HWND handle.
 */
export function captureWindowByHwnd(hwnd: number): CaptureResult | null {
  const script = `${CAPTURE_BY_HWND_PS}\n[WinCapH]::Capture([IntPtr]::new(${hwnd}))`
  const raw = runPs(script)
  return parseCaptureOutput(raw)
}
