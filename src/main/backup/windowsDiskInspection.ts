import { execFile } from 'node:child_process';

/**
 * Trusted Windows storage inspection used to classify an OFF_DEVICE target.
 *
 * The script is fixed application code. Filesystem paths are supplied only in
 * dedicated environment variables and are consumed with `-LiteralPath`; they
 * are never interpolated into a command string. The renderer never receives
 * the command, its output, disk numbers, or bus type.
 */

export const WINDOWS_DISK_INSPECTION_ERROR_CODES = {
  unavailable: 'OFF_DEVICE_INSPECTION_UNAVAILABLE',
  timeout: 'OFF_DEVICE_INSPECTION_TIMEOUT',
  failed: 'OFF_DEVICE_INSPECTION_FAILED',
  malformed: 'OFF_DEVICE_INSPECTION_MALFORMED',
  ambiguous: 'OFF_DEVICE_DISK_MAPPING_AMBIGUOUS',
} as const;

export type WindowsDiskInspectionErrorCode =
  (typeof WINDOWS_DISK_INSPECTION_ERROR_CODES)[keyof typeof WINDOWS_DISK_INSPECTION_ERROR_CODES];

export type WindowsDiskInspectionResult =
  | {
      readonly ok: true;
      readonly destinationDriveType: 'LOCAL';
      readonly sourceDiskNumber: number;
      readonly destinationDiskNumber: number;
      readonly destinationBusType: string;
    }
  | {
      readonly ok: true;
      readonly destinationDriveType: 'MAPPED_NETWORK';
      readonly sourceDiskNumber: null;
      readonly destinationDiskNumber: null;
      readonly destinationBusType: null;
    }
  | { readonly ok: false; readonly errorCode: WindowsDiskInspectionErrorCode };

interface PowerShellOutput {
  readonly destinationDriveType: unknown;
  readonly sourceDiskNumber: unknown;
  readonly destinationDiskNumber: unknown;
  readonly destinationBusType: unknown;
}

export interface PowerShellInvocation {
  readonly executable: 'powershell.exe';
  readonly args: readonly string[];
  readonly options: {
    readonly windowsHide: true;
    readonly timeout: number;
    readonly maxBuffer: number;
    readonly encoding: 'utf8';
    readonly env: NodeJS.ProcessEnv;
  };
}

export interface PowerShellExecutionResult {
  readonly ok: boolean;
  readonly stdout?: string;
  readonly timedOut?: boolean;
  readonly unavailable?: boolean;
}

export type PowerShellExecutor = (
  invocation: PowerShellInvocation,
) => Promise<PowerShellExecutionResult>;

export interface WindowsDiskInspector {
  inspect(
    sourceDatabasePath: string,
    destinationPath: string,
  ): Promise<WindowsDiskInspectionResult>;
}

export interface WindowsDiskInspectorOptions {
  readonly execute?: PowerShellExecutor;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

const SOURCE_PATH_ENV = 'GO_PHONES_POS_SOURCE_PATH';
const DESTINATION_PATH_ENV = 'GO_PHONES_POS_DESTINATION_PATH';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;

// Keep this script path-independent. Do not insert values into it with a
// template literal or other string construction.
export const WINDOWS_DISK_INSPECTION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Resolve-DriveRoot([string] $LiteralPath) {
  $item = Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop
  $root = [System.IO.Path]::GetPathRoot($item.FullName)
  if ([string]::IsNullOrWhiteSpace($root)) { throw 'DRIVE_ROOT_UNKNOWN' }
  return $root
}

function Resolve-PhysicalDisk([string] $DriveRoot) {
  if ($DriveRoot -notmatch '^[A-Za-z]:\\$') { throw 'DRIVE_ROOT_UNSUPPORTED' }
  $letter = $DriveRoot.Substring(0, 1)
  $partitions = @(Get-Partition -DriveLetter $letter -ErrorAction Stop)
  if ($partitions.Count -ne 1) { throw 'PARTITION_MAPPING_AMBIGUOUS' }
  $disks = @(Get-Disk -Number $partitions[0].DiskNumber -ErrorAction Stop)
  if ($disks.Count -ne 1) { throw 'DISK_MAPPING_AMBIGUOUS' }
  return $disks[0]
}

$sourceRoot = Resolve-DriveRoot $env:GO_PHONES_POS_SOURCE_PATH
$destinationRoot = Resolve-DriveRoot $env:GO_PHONES_POS_DESTINATION_PATH
$destinationDriveType = ([System.IO.DriveInfo]::new($destinationRoot)).DriveType.ToString()

if ($destinationDriveType -eq 'Network') {
  [pscustomobject]@{
    destinationDriveType = 'MAPPED_NETWORK'
    sourceDiskNumber = $null
    destinationDiskNumber = $null
    destinationBusType = $null
  } | ConvertTo-Json -Compress
  exit 0
}

$sourceDisk = Resolve-PhysicalDisk $sourceRoot
$destinationDisk = Resolve-PhysicalDisk $destinationRoot

[pscustomobject]@{
  destinationDriveType = 'LOCAL'
  sourceDiskNumber = [int] $sourceDisk.Number
  destinationDiskNumber = [int] $destinationDisk.Number
  destinationBusType = [string] $destinationDisk.BusType
} | ConvertTo-Json -Compress
`;

function isDiskNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseInspectionOutput(stdout: string): WindowsDiskInspectionResult {
  let value: PowerShellOutput;
  try {
    value = JSON.parse(stdout.trim()) as PowerShellOutput;
  } catch {
    return { ok: false, errorCode: WINDOWS_DISK_INSPECTION_ERROR_CODES.malformed };
  }

  if (value.destinationDriveType === 'MAPPED_NETWORK') {
    if (
      value.sourceDiskNumber !== null ||
      value.destinationDiskNumber !== null ||
      value.destinationBusType !== null
    ) {
      return { ok: false, errorCode: WINDOWS_DISK_INSPECTION_ERROR_CODES.malformed };
    }
    return {
      ok: true,
      destinationDriveType: 'MAPPED_NETWORK',
      sourceDiskNumber: null,
      destinationDiskNumber: null,
      destinationBusType: null,
    };
  }

  if (
    value.destinationDriveType !== 'LOCAL' ||
    !isDiskNumber(value.sourceDiskNumber) ||
    !isDiskNumber(value.destinationDiskNumber) ||
    typeof value.destinationBusType !== 'string' ||
    value.destinationBusType.length === 0 ||
    value.destinationBusType.length > 40
  ) {
    return { ok: false, errorCode: WINDOWS_DISK_INSPECTION_ERROR_CODES.malformed };
  }

  return {
    ok: true,
    destinationDriveType: 'LOCAL',
    sourceDiskNumber: value.sourceDiskNumber,
    destinationDiskNumber: value.destinationDiskNumber,
    destinationBusType: value.destinationBusType,
  };
}

function defaultPowerShellExecutor(
  invocation: PowerShellInvocation,
): Promise<PowerShellExecutionResult> {
  return new Promise((resolve) => {
    execFile(invocation.executable, [...invocation.args], invocation.options, (error, stdout) => {
      if (!error) {
        resolve({ ok: true, stdout });
        return;
      }
      const info = error as NodeJS.ErrnoException & { killed?: boolean };
      resolve({
        ok: false,
        timedOut: info.killed === true || info.code === 'ETIMEDOUT',
        unavailable: info.code === 'ENOENT',
      });
    });
  });
}

export function createWindowsDiskInspector(
  options: WindowsDiskInspectorOptions = {},
): WindowsDiskInspector {
  const execute = options.execute ?? defaultPowerShellExecutor;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return {
    async inspect(sourceDatabasePath, destinationPath): Promise<WindowsDiskInspectionResult> {
      const invocation: PowerShellInvocation = {
        executable: 'powershell.exe',
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          WINDOWS_DISK_INSPECTION_SCRIPT,
        ],
        options: {
          windowsHide: true,
          timeout,
          maxBuffer,
          encoding: 'utf8',
          env: {
            ...process.env,
            [SOURCE_PATH_ENV]: sourceDatabasePath,
            [DESTINATION_PATH_ENV]: destinationPath,
          },
        },
      };

      let execution: PowerShellExecutionResult;
      try {
        execution = await execute(invocation);
      } catch {
        return { ok: false, errorCode: WINDOWS_DISK_INSPECTION_ERROR_CODES.failed };
      }
      if (!execution.ok) {
        return {
          ok: false,
          errorCode: execution.timedOut
            ? WINDOWS_DISK_INSPECTION_ERROR_CODES.timeout
            : execution.unavailable
              ? WINDOWS_DISK_INSPECTION_ERROR_CODES.unavailable
              : WINDOWS_DISK_INSPECTION_ERROR_CODES.failed,
        };
      }
      if (typeof execution.stdout !== 'string' || execution.stdout.length > maxBuffer) {
        return { ok: false, errorCode: WINDOWS_DISK_INSPECTION_ERROR_CODES.malformed };
      }
      return parseInspectionOutput(execution.stdout);
    },
  };
}

/**
 * A fixed, bounded, argument-safe subprocess check for whether a destination
 * directory is genuinely writable (Phase 2L-C.2 fix for audit finding H2).
 *
 * Node's own `fs.promises` primitives (`open`/`write`/`sync`) give no real
 * cancellation on this runtime: racing them with `Promise.race()` only
 * abandons the JS promise while the underlying libuv/OS work keeps running in
 * the background and can still create/write/leave a file on the destination
 * AFTER the app has already told the caller it failed — a cosmetic timeout
 * that does not actually bound the operation. Running the probe in a
 * short-lived child process with a hard `execFile` timeout instead gives a
 * genuine bound: killing the process reclaims its open handles at the OS
 * level, so an unresponsive network share cannot leave the app waiting
 * indefinitely, and no in-process write can straddle the timeout boundary.
 *
 * On an actual timeout kill, PowerShell has no opportunity to run its own
 * cleanup and a small, distinctively-named probe file MAY be left on the
 * destination. This is an accepted, disclosed tradeoff: the file is harmless,
 * self-describing, and not a source of truth for anything — it is far
 * preferable to an indefinite hang or a write racing an abandoned promise.
 */
export interface WindowsWritabilityProbe {
  probe(destinationDirectory: string): Promise<WindowsWritabilityProbeResult>;
}

export type WindowsWritabilityProbeResult =
  | { readonly ok: true; readonly writable: boolean }
  | { readonly ok: false; readonly errorCode: WindowsDiskInspectionErrorCode };

export interface WindowsWritabilityProbeOptions {
  readonly execute?: PowerShellExecutor;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

interface PowerShellWritabilityOutput {
  readonly writable: unknown;
}

// Keep this script path-independent, exactly like `WINDOWS_DISK_INSPECTION_SCRIPT` —
// do not insert values into it with a template literal or other string construction.
export const WINDOWS_WRITABILITY_PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Write-Result([bool] $Writable) {
  [pscustomobject]@{ writable = $Writable } | ConvertTo-Json -Compress
}

$destination = $env:GO_PHONES_POS_DESTINATION_PATH
try {
  $item = Get-Item -LiteralPath $destination -Force -ErrorAction Stop
  if (-not $item.PSIsContainer) { throw 'DESTINATION_NOT_A_DIRECTORY' }
} catch {
  Write-Result $false
  exit 0
}

$probeName = ".gophones-write-probe-$([guid]::NewGuid().ToString('N')).tmp"
$probePath = Join-Path -Path $destination -ChildPath $probeName
try {
  $stream = [System.IO.File]::Open($probePath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes('Go Phones POS backup destination verification')
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    $stream.Dispose()
  }
  Remove-Item -LiteralPath $probePath -Force -ErrorAction Stop
  Write-Result $true
} catch {
  try { Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue } catch {}
  Write-Result $false
}
`;

function parseWritabilityOutput(stdout: string): WindowsWritabilityProbeResult {
  let value: PowerShellWritabilityOutput;
  try {
    value = JSON.parse(stdout.trim()) as PowerShellWritabilityOutput;
  } catch {
    return { ok: false, errorCode: WINDOWS_DISK_INSPECTION_ERROR_CODES.malformed };
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    typeof value.writable !== 'boolean'
  ) {
    return { ok: false, errorCode: WINDOWS_DISK_INSPECTION_ERROR_CODES.malformed };
  }
  return { ok: true, writable: value.writable };
}

export function createWindowsWritabilityProbe(
  options: WindowsWritabilityProbeOptions = {},
): WindowsWritabilityProbe {
  const execute = options.execute ?? defaultPowerShellExecutor;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return {
    async probe(destinationDirectory): Promise<WindowsWritabilityProbeResult> {
      const invocation: PowerShellInvocation = {
        executable: 'powershell.exe',
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          WINDOWS_WRITABILITY_PROBE_SCRIPT,
        ],
        options: {
          windowsHide: true,
          timeout,
          maxBuffer,
          encoding: 'utf8',
          env: {
            ...process.env,
            [DESTINATION_PATH_ENV]: destinationDirectory,
          },
        },
      };

      let execution: PowerShellExecutionResult;
      try {
        execution = await execute(invocation);
      } catch {
        return { ok: false, errorCode: WINDOWS_DISK_INSPECTION_ERROR_CODES.failed };
      }
      if (!execution.ok) {
        return {
          ok: false,
          errorCode: execution.timedOut
            ? WINDOWS_DISK_INSPECTION_ERROR_CODES.timeout
            : execution.unavailable
              ? WINDOWS_DISK_INSPECTION_ERROR_CODES.unavailable
              : WINDOWS_DISK_INSPECTION_ERROR_CODES.failed,
        };
      }
      if (typeof execution.stdout !== 'string' || execution.stdout.length > maxBuffer) {
        return { ok: false, errorCode: WINDOWS_DISK_INSPECTION_ERROR_CODES.malformed };
      }
      return parseWritabilityOutput(execution.stdout);
    },
  };
}

/**
 * A fixed, bounded, argument-safe subprocess that resolves a path to its
 * final target — the Windows equivalent of Node's `fs.realpath()` — used
 * because `fs.promises.realpath()` gives no real cancellation on this
 * runtime either (Phase 2L-C.2 remaining-corrections fix). Symlink/junction
 * resolution here is not cosmetic: `Get-Partition -DriveLetter` in
 * `WINDOWS_DISK_INSPECTION_SCRIPT` reasons about whichever drive letter the
 * path's root names, and `Get-Item`'s own `.FullName` does NOT rewrite a
 * junction to its target — it reports the path as given. Without genuine
 * final-path resolution first, a destination reached through a junction
 * could be classified by the JUNCTION's own drive rather than the physical
 * disk actually backing the bytes, which is exactly the kind of same-disk
 * bypass this whole feature exists to prevent.
 *
 * Implementation: `GetFinalPathNameByHandleW`, the same Win32 API Node's own
 * `fs.realpath()` uses internally on Windows, invoked via `Add-Type`
 * (built-in PowerShell/.NET P/Invoke — no compiled Node dependency, no new
 * package). Running it in a killable child process with a hard `execFile`
 * timeout gives the same genuine bound as the writability probe: killing the
 * process reclaims its handle at the OS level, so an unresponsive UNC path
 * cannot hang path resolution indefinitely.
 */
export interface WindowsPathResolver {
  resolve(targetPath: string): Promise<WindowsPathResolutionResult>;
}

export type WindowsPathResolutionResult =
  | { readonly ok: true; readonly resolvedPath: string }
  | { readonly ok: false; readonly errorCode: WindowsDiskInspectionErrorCode };

export interface WindowsPathResolverOptions {
  readonly execute?: PowerShellExecutor;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

interface PowerShellPathResolutionOutput {
  readonly resolvedPath: unknown;
}

const TARGET_PATH_ENV = 'GO_PHONES_POS_TARGET_PATH';
const MAX_RESOLVED_PATH_LENGTH = 4096;

// Keep this script path-independent, exactly like the other fixed scripts in
// this file — do not insert values into it with a template literal or other
// string construction.
export const WINDOWS_PATH_RESOLUTION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class GoPhonesPosFinalPath {
  private const uint GENERIC_READ = 0x80000000;
  private const uint FILE_SHARE_READ = 0x1;
  private const uint FILE_SHARE_WRITE = 0x2;
  private const uint FILE_SHARE_DELETE = 0x4;
  private const uint OPEN_EXISTING = 3;
  private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern SafeFileHandle CreateFileW(
    string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes,
    uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern uint GetFinalPathNameByHandleW(
    SafeFileHandle hFile, StringBuilder lpszFilePath, uint cchFilePath, uint dwFlags);

  public static string Resolve(string path) {
    SafeFileHandle handle = CreateFileW(
      path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
    try {
      if (handle.IsInvalid) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      StringBuilder buffer = new StringBuilder(4096);
      uint length = GetFinalPathNameByHandleW(handle, buffer, (uint) buffer.Capacity, 0);
      if (length == 0 || length >= buffer.Capacity) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      return buffer.ToString();
    } finally {
      handle.Dispose();
    }
  }
}
'@

$resolved = [GoPhonesPosFinalPath]::Resolve($env:GO_PHONES_POS_TARGET_PATH)

# GetFinalPathNameByHandleW returns an extended-length-prefixed path
# (\\?\C:\... for a local drive, \\?\UNC\server\share\... for a UNC target).
# Normalize both back to ordinary Win32 form so downstream UNC/path parsing —
# which has never expected the \\?\ prefix — sees the same shape it always has.
if ($resolved.StartsWith('\\?\UNC\')) {
  $resolved = '\\' + $resolved.Substring(8)
} elseif ($resolved.StartsWith('\\?\')) {
  $resolved = $resolved.Substring(4)
}

[pscustomobject]@{ resolvedPath = $resolved } | ConvertTo-Json -Compress
`;

function parsePathResolutionOutput(stdout: string): WindowsPathResolutionResult {
  let value: PowerShellPathResolutionOutput;
  try {
    value = JSON.parse(stdout.trim()) as PowerShellPathResolutionOutput;
  } catch {
    return { ok: false, errorCode: WINDOWS_DISK_INSPECTION_ERROR_CODES.malformed };
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    typeof value.resolvedPath !== 'string' ||
    value.resolvedPath.length === 0 ||
    value.resolvedPath.length > MAX_RESOLVED_PATH_LENGTH
  ) {
    return { ok: false, errorCode: WINDOWS_DISK_INSPECTION_ERROR_CODES.malformed };
  }
  return { ok: true, resolvedPath: value.resolvedPath };
}

export function createWindowsPathResolver(
  options: WindowsPathResolverOptions = {},
): WindowsPathResolver {
  const execute = options.execute ?? defaultPowerShellExecutor;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return {
    async resolve(targetPath): Promise<WindowsPathResolutionResult> {
      const invocation: PowerShellInvocation = {
        executable: 'powershell.exe',
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          WINDOWS_PATH_RESOLUTION_SCRIPT,
        ],
        options: {
          windowsHide: true,
          timeout,
          maxBuffer,
          encoding: 'utf8',
          env: {
            ...process.env,
            [TARGET_PATH_ENV]: targetPath,
          },
        },
      };

      let execution: PowerShellExecutionResult;
      try {
        execution = await execute(invocation);
      } catch {
        return { ok: false, errorCode: WINDOWS_DISK_INSPECTION_ERROR_CODES.failed };
      }
      if (!execution.ok) {
        return {
          ok: false,
          errorCode: execution.timedOut
            ? WINDOWS_DISK_INSPECTION_ERROR_CODES.timeout
            : execution.unavailable
              ? WINDOWS_DISK_INSPECTION_ERROR_CODES.unavailable
              : WINDOWS_DISK_INSPECTION_ERROR_CODES.failed,
        };
      }
      if (typeof execution.stdout !== 'string' || execution.stdout.length > maxBuffer) {
        return { ok: false, errorCode: WINDOWS_DISK_INSPECTION_ERROR_CODES.malformed };
      }
      return parsePathResolutionOutput(execution.stdout);
    },
  };
}
