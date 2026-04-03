/**
 * Cross-platform (Windows/Linux) ComputerExecutor implementation.
 *
 * Unlike the macOS executor which uses @ant native modules + drainRunLoop +
 * CGEventTap, this executor delegates everything to src/utils/computerUse/platforms/.
 *
 * All operations go through the platform abstraction:
 * - Input: SendMessage (HWND-bound, no focus steal)
 * - Screenshot: PrintWindow (per-window JPEG)
 * - Display: platform-native enumeration
 * - Apps: platform-native listing/launching
 *
 * No drainRunLoop, no CGEventTap, no pbcopy/pbpaste, no @ant packages.
 */

import type {
  ComputerExecutor,
  DisplayGeometry,
  FrontmostApp,
  InstalledApp,
  ResolvePrepareCaptureResult,
  RunningApp,
  ScreenshotResult,
} from '@ant/computer-use-mcp'

import { API_RESIZE_PARAMS, targetImageSize } from '@ant/computer-use-mcp'
import { logForDebugging } from '../debug.js'
import { sleep } from '../sleep.js'
import {
  CLI_CU_CAPABILITIES,
  CLI_HOST_BUNDLE_ID,
} from './common.js'
import { loadPlatform } from './platforms/index.js'
import type { Platform } from './platforms/index.js'

function computeTargetDims(
  logicalW: number,
  logicalH: number,
  scaleFactor: number,
): [number, number] {
  const physW = Math.round(logicalW * scaleFactor)
  const physH = Math.round(logicalH * scaleFactor)
  return targetImageSize(physW, physH, API_RESIZE_PARAMS)
}

export function createCrossPlatformExecutor(opts: {
  getMouseAnimationEnabled: () => boolean
  getHideBeforeActionEnabled: () => boolean
}): ComputerExecutor {
  const platform = loadPlatform()

  logForDebugging(
    `[computer-use] cross-platform executor for ${process.platform}`,
  )

  return {
    capabilities: {
      ...CLI_CU_CAPABILITIES,
      hostBundleId: CLI_HOST_BUNDLE_ID,
    },

    // ── Pre-action (no-op on non-macOS) ──────────────────────────────────

    async prepareForAction(): Promise<string[]> {
      return []
    },

    async previewHideSet(): Promise<Array<{ bundleId: string; displayName: string }>> {
      return []
    },

    // ── Display ──────────────────────────────────────────────────────────

    async getDisplaySize(displayId?: number): Promise<DisplayGeometry> {
      const d = platform.display.getSize(displayId)
      return { ...d, scaleFactor: d.scaleFactor ?? 1, displayId: d.displayId ?? 0 }
    },

    async listDisplays(): Promise<DisplayGeometry[]> {
      return platform.display.listAll()
    },

    async findWindowDisplays(
      bundleIds: string[],
    ): Promise<Array<{ bundleId: string; displayIds: number[] }>> {
      return bundleIds.map(b => ({ bundleId: b, displayIds: [0] }))
    },

    // ── Screenshot ───────────────────────────────────────────────────────

    async resolvePrepareCapture(opts: {
      allowedBundleIds: string[]
      preferredDisplayId?: number
      autoResolve: boolean
      doHide?: boolean
    }): Promise<ResolvePrepareCaptureResult> {
      const d = platform.display.getSize(opts.preferredDisplayId)
      const shot = await platform.screenshot.captureScreen(opts.preferredDisplayId)
      return {
        ...shot,
        hidden: [],
        displayId: opts.preferredDisplayId ?? d.displayId ?? 0,
      }
    },

    async screenshot(opts: {
      allowedBundleIds: string[]
      displayId?: number
    }): Promise<ScreenshotResult> {
      return platform.screenshot.captureScreen(opts.displayId)
    },

    async zoom(
      regionLogical: { x: number; y: number; w: number; h: number },
      _allowedBundleIds: string[],
      _displayId?: number,
    ): Promise<{ base64: string; width: number; height: number }> {
      return platform.screenshot.captureRegion(
        regionLogical.x,
        regionLogical.y,
        regionLogical.w,
        regionLogical.h,
      )
    },

    // ── Keyboard ─────────────────────────────────────────────────────────

    async key(keySequence: string, repeat?: number): Promise<void> {
      const parts = keySequence.split('+').filter(p => p.length > 0)
      const n = repeat ?? 1
      for (let i = 0; i < n; i++) {
        if (i > 0) await sleep(8)
        await platform.input.keys(parts)
      }
    },

    async holdKey(keyNames: string[], durationMs: number): Promise<void> {
      for (const k of keyNames) {
        await platform.input.key(k, 'press')
      }
      await sleep(durationMs)
      for (const k of [...keyNames].reverse()) {
        await platform.input.key(k, 'release')
      }
    },

    async type(text: string, _opts: { viaClipboard: boolean }): Promise<void> {
      await platform.input.typeText(text)
    },

    async readClipboard(): Promise<string> {
      // Platform-specific clipboard
      if (process.platform === 'win32') {
        const result = Bun.spawnSync({
          cmd: ['powershell', '-NoProfile', '-Command', 'Get-Clipboard'],
          stdout: 'pipe',
        })
        return new TextDecoder().decode(result.stdout).trim()
      }
      // Linux
      const result = Bun.spawnSync({
        cmd: ['xclip', '-selection', 'clipboard', '-o'],
        stdout: 'pipe',
      })
      return new TextDecoder().decode(result.stdout).trim()
    },

    async writeClipboard(text: string): Promise<void> {
      if (process.platform === 'win32') {
        const escaped = text.replace(/'/g, "''")
        Bun.spawnSync({
          cmd: ['powershell', '-NoProfile', '-Command', `Set-Clipboard -Value '${escaped}'`],
        })
        return
      }
      // Linux
      const proc = Bun.spawn(['xclip', '-selection', 'clipboard'], { stdin: 'pipe' })
      proc.stdin.write(text)
      proc.stdin.end()
      await proc.exited
    },

    // ── Mouse ────────────────────────────────────────────────────────────

    async moveMouse(x: number, y: number): Promise<void> {
      await platform.input.moveMouse(x, y)
    },

    async click(
      x: number,
      y: number,
      button: 'left' | 'right' | 'middle',
      count: 1 | 2 | 3,
      _modifiers?: string[],
    ): Promise<void> {
      // On Windows, identify the GUI element at the click point before acting
      if (process.platform === 'win32') {
        try {
          const { elementAtPoint } = require('../win32/uiAutomation.js') as typeof import('../win32/uiAutomation.js')
          const el = elementAtPoint(Math.round(x), Math.round(y))
          if (el) {
            logForDebugging(
              `[computer-use] click(${Math.round(x)},${Math.round(y)}) → ${el.controlType}` +
              (el.name ? ` "${el.name}"` : '') +
              (el.automationId ? ` [${el.automationId}]` : '') +
              (el.isEnabled ? '' : ' (DISABLED)'),
            )
          }
        } catch {
          // UI Automation lookup is best-effort — don't block the click
        }
      }
      for (let i = 0; i < count; i++) {
        await platform.input.click(x, y, button)
      }
    },

    async mouseDown(): Promise<void> {
      await platform.input.click(0, 0, 'left')
    },

    async mouseUp(): Promise<void> {
      // SendMessage approach doesn't have separate down/up in all cases
    },

    async getCursorPosition(): Promise<{ x: number; y: number }> {
      return platform.input.mouseLocation()
    },

    async drag(
      from: { x: number; y: number } | undefined,
      to: { x: number; y: number },
    ): Promise<void> {
      if (from) {
        await platform.input.click(from.x, from.y, 'left')
      }
      await sleep(50)
      await platform.input.click(to.x, to.y, 'left')
    },

    async scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
      if (dy !== 0) await platform.input.scroll(dy, 'vertical')
      if (dx !== 0) await platform.input.scroll(dx, 'horizontal')
    },

    // ── App management ───────────────────────────────────────────────────

    async getFrontmostApp(): Promise<FrontmostApp | null> {
      // When HWND is bound, return the first allowed app identity
      // so the frontmost gate passes (operations target bound window, not foreground)
      if (process.platform === 'win32') {
        try {
          const { getBoundHwnd } = require('./platforms/win32.js') as typeof import('./platforms/win32.js')
          if (getBoundHwnd()) {
            return { bundleId: 'cu-bound-window', displayName: 'Bound Window' }
          }
        } catch {}
      }
      const info = platform.apps.getFrontmostApp()
      if (!info) return null
      return { bundleId: info.id, displayName: info.appName }
    },

    async appUnderPoint(
      _x: number,
      _y: number,
    ): Promise<{ bundleId: string; displayName: string } | null> {
      // Non-macOS: no reliable per-pixel hit-test in HWND-bound mode
      return null
    },

    async listInstalledApps(): Promise<InstalledApp[]> {
      return (await platform.apps.listInstalled()).map(a => ({
        bundleId: a.id,
        displayName: a.displayName,
        path: a.path,
      }))
    },

    async getAppIcon(_path: string): Promise<string | undefined> {
      return undefined
    },

    async listRunningApps(): Promise<RunningApp[]> {
      return platform.apps.listRunning().map(w => ({
        bundleId: w.id,
        displayName: w.title,
      }))
    },

    async openApp(bundleId: string): Promise<void> {
      await platform.apps.open(bundleId)
    },
  }
}

/**
 * Module-level unhide — no-op on non-macOS (we don't hide apps).
 */
export async function unhideComputerUseAppsCrossPlatform(
  _bundleIds: readonly string[],
): Promise<void> {
  // No-op: Windows/Linux don't use hide/unhide
}
