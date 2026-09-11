import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  OFF_DEVICE_DESTINATION_ERROR_CODES,
  createOffDeviceDestinationVerifier,
} from '../../src/main/backup/offDeviceDestination';
import type { OffDeviceFilesystem } from '../../src/main/backup/offDeviceDestination';
import type { HostnameResolver } from '../../src/main/backup/boundedHostnameResolver';
import {
  WINDOWS_DISK_INSPECTION_ERROR_CODES,
  WINDOWS_DISK_INSPECTION_SCRIPT,
  createWindowsDiskInspector,
  createWindowsPathResolver,
  createWindowsWritabilityProbe,
} from '../../src/main/backup/windowsDiskInspection';
import type {
  PowerShellExecutor,
  PowerShellInvocation,
  WindowsDiskInspectionResult,
  WindowsDiskInspector,
} from '../../src/main/backup/windowsDiskInspection';
import {
  clearOffDeviceBackupDestination,
  readOffDeviceBackupDestination,
  writeOffDeviceBackupDestination,
} from '../../src/main/settings/offDeviceBackupSettingsRepository';
import { createMigratedDb, makeTempDir } from '../helpers/database';

const DATABASE = String.raw`C:\Users\owner\AppData\Local\GoPhonesPOS\gophones.sqlite`;
const DESTINATION = String.raw`E:\GoPhonesPOS Backups`;

/** A `HostnameResolver` fake that never touches real DNS. */
function fakeResolver(
  behavior: (
    hostname: string,
  ) => { readonly ok: true; readonly addresses: readonly string[] } | { readonly ok: false },
): HostnameResolver {
  return {
    resolve: async (hostname) => {
      const result = behavior(hostname);
      return result.ok ? result : { ok: false, errorCode: 'RESOLUTION_UNAVAILABLE' };
    },
  };
}

/** A resolver that never finds anything — the safe default for "genuinely remote, no local match." */
function unavailableResolver(): HostnameResolver {
  return fakeResolver(() => ({ ok: false }));
}

function fakeInterfaces(
  ...addresses: readonly string[]
): () => NodeJS.Dict<readonly { readonly address: string }[]> {
  return () => ({ eth0: addresses.map((address) => ({ address })) });
}

function filesystem(options?: {
  readonly canonicalDestination?: string;
  readonly writable?: boolean;
  readonly rejectCanonicalize?: boolean;
}): OffDeviceFilesystem {
  return {
    async canonicalize(path): Promise<string> {
      if (options?.rejectCanonicalize) throw new Error('private raw path');
      return path === DESTINATION ? (options?.canonicalDestination ?? path) : path;
    },
    async probeWritable(): Promise<boolean> {
      return options?.writable ?? true;
    },
  };
}

function inspector(...results: readonly WindowsDiskInspectionResult[]): WindowsDiskInspector {
  let call = 0;
  return {
    inspect: vi.fn(async () => results[Math.min(call++, results.length - 1)]!),
  };
}

function localInspection(
  sourceDiskNumber: number,
  destinationDiskNumber: number,
  destinationBusType: string,
): WindowsDiskInspectionResult {
  return {
    ok: true,
    destinationDriveType: 'LOCAL',
    sourceDiskNumber,
    destinationDiskNumber,
    destinationBusType,
  };
}

describe('OFF_DEVICE destination classification', () => {
  it('accepts a writable remote UNC location without invoking disk inspection', async () => {
    const diskInspector = inspector(localInspection(0, 1, 'USB'));
    const destination = String.raw`\\backup-server\store\GoPhonesPOS Backups`;
    const verifier = createOffDeviceDestinationVerifier({
      platform: 'win32',
      computerName: 'STORE-POS',
      filesystem: {
        canonicalize: async (path) => path,
        probeWritable: async () => true,
      },
      diskInspector,
      // A genuinely remote host: bounded name resolution finds nothing of
      // this machine's own here — deterministic, never touches real DNS.
      hostnameResolver: unavailableResolver(),
    });

    await expect(verifier.verify(DATABASE, destination)).resolves.toEqual({
      ok: true,
      kind: 'NETWORK',
      canonicalPath: destination,
      displayName: 'Network backup (backup-server)',
    });
    expect(diskInspector.inspect).not.toHaveBeenCalled();
  });

  it.each([
    String.raw`\\localhost\share\backups`,
    String.raw`\\127.0.0.1\share\backups`,
    String.raw`\\STORE-POS\share\backups`,
    String.raw`\\store-pos.local\share\backups`,
  ])('rejects an obvious local-machine UNC share: %s', async (destination) => {
    const verifier = createOffDeviceDestinationVerifier({
      platform: 'win32',
      computerName: 'STORE-POS',
      filesystem: {
        canonicalize: async (path) => path,
        probeWritable: async () => true,
      },
      diskInspector: inspector(localInspection(0, 1, 'USB')),
    });

    await expect(verifier.verify(DATABASE, destination)).resolves.toEqual({
      ok: false,
      errorCode: OFF_DEVICE_DESTINATION_ERROR_CODES.localNetworkShare,
    });
  });

  describe('rejects a UNC host that is this machine’s own network address (Phase 2L-C.2 fix)', () => {
    it('rejects this machine’s own IPv4 interface address', async () => {
      const verifier = createOffDeviceDestinationVerifier({
        platform: 'win32',
        computerName: 'STORE-POS',
        networkInterfaces: fakeInterfaces('192.168.1.50', 'fe80::1'),
        filesystem: {
          canonicalize: async (path) => path,
          probeWritable: async () => true,
        },
        diskInspector: inspector(localInspection(0, 1, 'USB')),
      });

      await expect(
        verifier.verify(DATABASE, String.raw`\\192.168.1.50\share\backups`),
      ).resolves.toEqual({
        ok: false,
        errorCode: OFF_DEVICE_DESTINATION_ERROR_CODES.localNetworkShare,
      });
    });

    it('rejects this machine’s own IPv6 interface address in Windows’ ipv6-literal.net UNC form', async () => {
      const verifier = createOffDeviceDestinationVerifier({
        platform: 'win32',
        computerName: 'STORE-POS',
        networkInterfaces: fakeInterfaces('fe80::1234:5678:9abc:def0'),
        filesystem: {
          canonicalize: async (path) => path,
          probeWritable: async () => true,
        },
        diskInspector: inspector(localInspection(0, 1, 'USB')),
      });
      const destination = String.raw`\\fe80--1234-5678-9abc-def0.ipv6-literal.net\share`;

      await expect(verifier.verify(DATABASE, destination)).resolves.toEqual({
        ok: false,
        errorCode: OFF_DEVICE_DESTINATION_ERROR_CODES.localNetworkShare,
      });
    });

    it('does not reject an unrelated private-LAN IP merely because it is private', async () => {
      const verifier = createOffDeviceDestinationVerifier({
        platform: 'win32',
        computerName: 'STORE-POS',
        networkInterfaces: fakeInterfaces('192.168.1.50'), // this machine's own address only
        filesystem: {
          canonicalize: async (path) => path,
          probeWritable: async () => true,
        },
        diskInspector: inspector(localInspection(0, 1, 'USB')),
      });
      // A DIFFERENT device on the same private LAN (e.g. a NAS), not this machine.
      const destination = String.raw`\\192.168.1.60\share\backups`;

      await expect(verifier.verify(DATABASE, destination)).resolves.toEqual({
        ok: true,
        kind: 'NETWORK',
        canonicalPath: destination,
        displayName: 'Network backup (192.168.1.60)',
      });
    });

    it('never compares a plain hostname against local interface addresses by literal form', async () => {
      const verifier = createOffDeviceDestinationVerifier({
        platform: 'win32',
        computerName: 'STORE-POS',
        // Even if this machine happens to also expose 10.0.0.5 on some
        // interface, a plain hostname destination must never be compared
        // against it as if the hostname string itself were that IP — only
        // literal IP/UNC-IPv6 host forms are checked that way. A genuine
        // alias is instead handled by bounded name resolution (below).
        networkInterfaces: fakeInterfaces('10.0.0.5'),
        hostnameResolver: unavailableResolver(),
        filesystem: {
          canonicalize: async (path) => path,
          probeWritable: async () => true,
        },
        diskInspector: inspector(localInspection(0, 1, 'USB')),
      });
      const destination = String.raw`\\real-backup-server\share\backups`;

      await expect(verifier.verify(DATABASE, destination)).resolves.toMatchObject({ ok: true });
    });
  });

  describe('rejects a UNC hostname that bounded name resolution proves is this machine (Phase 2L-C.2 fix)', () => {
    it('rejects an alias that resolves to this machine’s own IPv4 address', async () => {
      const verifier = createOffDeviceDestinationVerifier({
        platform: 'win32',
        computerName: 'STORE-POS',
        networkInterfaces: fakeInterfaces('192.168.1.50'),
        hostnameResolver: fakeResolver((hostname) =>
          hostname === 'pos-backup-alias'
            ? { ok: true, addresses: ['192.168.1.50'] }
            : { ok: false },
        ),
        filesystem: {
          canonicalize: async (path) => path,
          probeWritable: async () => true,
        },
        diskInspector: inspector(localInspection(0, 1, 'USB')),
      });

      await expect(
        verifier.verify(DATABASE, String.raw`\\pos-backup-alias\Backups`),
      ).resolves.toEqual({
        ok: false,
        errorCode: OFF_DEVICE_DESTINATION_ERROR_CODES.localNetworkShare,
      });
    });

    it('rejects an alias that resolves to this machine’s own IPv6 address', async () => {
      const verifier = createOffDeviceDestinationVerifier({
        platform: 'win32',
        computerName: 'STORE-POS',
        networkInterfaces: fakeInterfaces('fe80::1234:5678:9abc:def0'),
        hostnameResolver: fakeResolver((hostname) =>
          hostname === 'pos-backup-alias'
            ? { ok: true, addresses: ['fe80::1234:5678:9abc:def0'] }
            : { ok: false },
        ),
        filesystem: {
          canonicalize: async (path) => path,
          probeWritable: async () => true,
        },
        diskInspector: inspector(localInspection(0, 1, 'USB')),
      });

      await expect(
        verifier.verify(DATABASE, String.raw`\\pos-backup-alias\Backups`),
      ).resolves.toEqual({
        ok: false,
        errorCode: OFF_DEVICE_DESTINATION_ERROR_CODES.localNetworkShare,
      });
    });

    it('does not reject a remote hostname that resolves only to foreign addresses', async () => {
      const verifier = createOffDeviceDestinationVerifier({
        platform: 'win32',
        computerName: 'STORE-POS',
        networkInterfaces: fakeInterfaces('192.168.1.50'),
        hostnameResolver: fakeResolver((hostname) =>
          hostname === 'genuine-nas' ? { ok: true, addresses: ['192.168.1.60'] } : { ok: false },
        ),
        filesystem: {
          canonicalize: async (path) => path,
          probeWritable: async () => true,
        },
        diskInspector: inspector(localInspection(0, 1, 'USB')),
      });
      const destination = String.raw`\\genuine-nas\Backups`;

      await expect(verifier.verify(DATABASE, destination)).resolves.toEqual({
        ok: true,
        kind: 'NETWORK',
        canonicalPath: destination,
        displayName: 'Network backup (genuine-nas)',
      });
    });

    it.each([
      { label: 'unavailable', result: { ok: false as const } },
      { label: 'no addresses found', result: { ok: false as const } },
    ])(
      'does not falsely mark an arbitrary remote hostname as local when resolution is $label',
      async ({ result }) => {
        const verifier = createOffDeviceDestinationVerifier({
          platform: 'win32',
          computerName: 'STORE-POS',
          networkInterfaces: fakeInterfaces('192.168.1.50'),
          hostnameResolver: fakeResolver(() => result),
          filesystem: {
            canonicalize: async (path) => path,
            probeWritable: async () => true,
          },
          diskInspector: inspector(localInspection(0, 1, 'USB')),
        });
        const destination = String.raw`\\unreachable-dns-target\Backups`;

        await expect(verifier.verify(DATABASE, destination)).resolves.toMatchObject({ ok: true });
      },
    );

    it('passes a hostile hostname to the resolver verbatim — no command/script injection surface exists', async () => {
      const hostile = "evil'; Write-Output 'INJECTED'; #";
      let captured: string | undefined;
      const verifier = createOffDeviceDestinationVerifier({
        platform: 'win32',
        computerName: 'STORE-POS',
        networkInterfaces: fakeInterfaces('192.168.1.50'),
        hostnameResolver: {
          resolve: async (hostname) => {
            captured = hostname;
            return { ok: false, errorCode: 'RESOLUTION_UNAVAILABLE' };
          },
        },
        filesystem: {
          canonicalize: async (path) => path,
          probeWritable: async () => true,
        },
        diskInspector: inspector(localInspection(0, 1, 'USB')),
      });

      // The UNC-host regex requires a share segment after the host, and the
      // parsed host is always lowercased — this reflects that, while still
      // proving the exact hostile string reaches the resolver as a plain
      // function argument, never concatenated into a command/script.
      const destination = `\\\\${hostile}\\share`;
      await expect(verifier.verify(DATABASE, destination)).resolves.toMatchObject({ ok: true });
      expect(captured).toBe(hostile.toLowerCase());
    });
  });

  it('rejects a different partition or drive letter on the source physical disk', async () => {
    const verifier = createOffDeviceDestinationVerifier({
      platform: 'win32',
      filesystem: filesystem(),
      diskInspector: inspector(localInspection(7, 7, 'USB')),
    });

    await expect(verifier.verify(DATABASE, DESTINATION)).resolves.toEqual({
      ok: false,
      errorCode: OFF_DEVICE_DESTINATION_ERROR_CODES.samePhysicalDisk,
    });
  });

  it('rejects a different internal physical disk', async () => {
    const verifier = createOffDeviceDestinationVerifier({
      platform: 'win32',
      filesystem: filesystem(),
      diskInspector: inspector(localInspection(0, 3, 'NVMe')),
    });

    await expect(verifier.verify(DATABASE, DESTINATION)).resolves.toEqual({
      ok: false,
      errorCode: OFF_DEVICE_DESTINATION_ERROR_CODES.internalDisk,
    });
  });

  it('accepts only a different physical disk positively identified as USB', async () => {
    const verifier = createOffDeviceDestinationVerifier({
      platform: 'win32',
      filesystem: filesystem(),
      diskInspector: inspector(localInspection(0, 3, 'uSb')),
    });

    await expect(verifier.verify(DATABASE, DESTINATION)).resolves.toEqual({
      ok: true,
      kind: 'USB',
      canonicalPath: DESTINATION,
      displayName: 'External USB drive (E:)',
    });
  });

  it('fails closed for a mapped network drive instead of inferring from its letter', async () => {
    const verifier = createOffDeviceDestinationVerifier({
      platform: 'win32',
      filesystem: filesystem(),
      diskInspector: inspector({
        ok: true,
        destinationDriveType: 'MAPPED_NETWORK',
        sourceDiskNumber: null,
        destinationDiskNumber: null,
        destinationBusType: null,
      }),
    });

    await expect(verifier.verify(DATABASE, DESTINATION)).resolves.toEqual({
      ok: false,
      errorCode: OFF_DEVICE_DESTINATION_ERROR_CODES.mappedNetworkDrive,
    });
  });

  it('fails closed on inaccessible, read-only, and ambiguous inspection outcomes', async () => {
    const unavailable = createOffDeviceDestinationVerifier({
      platform: 'win32',
      filesystem: filesystem({ rejectCanonicalize: true }),
      diskInspector: inspector(localInspection(0, 1, 'USB')),
    });
    await expect(unavailable.verify(DATABASE, DESTINATION)).resolves.toEqual({
      ok: false,
      errorCode: OFF_DEVICE_DESTINATION_ERROR_CODES.inaccessible,
    });

    const readOnly = createOffDeviceDestinationVerifier({
      platform: 'win32',
      filesystem: filesystem({ writable: false }),
      diskInspector: inspector(localInspection(0, 1, 'USB')),
    });
    await expect(readOnly.verify(DATABASE, DESTINATION)).resolves.toEqual({
      ok: false,
      errorCode: OFF_DEVICE_DESTINATION_ERROR_CODES.notWritable,
    });

    const ambiguous = createOffDeviceDestinationVerifier({
      platform: 'win32',
      filesystem: filesystem(),
      diskInspector: inspector({
        ok: false,
        errorCode: WINDOWS_DISK_INSPECTION_ERROR_CODES.ambiguous,
      }),
    });
    await expect(ambiguous.verify(DATABASE, DESTINATION)).resolves.toEqual({
      ok: false,
      errorCode: OFF_DEVICE_DESTINATION_ERROR_CODES.verificationFailed,
    });
  });

  it('catches a reused destination letter when fresh inspection no longer proves USB', async () => {
    const verifier = createOffDeviceDestinationVerifier({
      platform: 'win32',
      filesystem: filesystem(),
      diskInspector: inspector(localInspection(0, 2, 'USB'), localInspection(0, 2, 'SATA')),
    });

    await expect(verifier.verify(DATABASE, DESTINATION)).resolves.toMatchObject({ ok: true });
    await expect(verifier.verify(DATABASE, DESTINATION)).resolves.toEqual({
      ok: false,
      errorCode: OFF_DEVICE_DESTINATION_ERROR_CODES.internalDisk,
    });
  });
});

describe('Windows PowerShell disk inspection', () => {
  it('uses a fixed noninteractive bounded invocation and passes hostile paths only via env', async () => {
    let captured: PowerShellInvocation | undefined;
    const execute: PowerShellExecutor = async (invocation) => {
      captured = invocation;
      return {
        ok: true,
        stdout: JSON.stringify({
          destinationDriveType: 'LOCAL',
          sourceDiskNumber: 0,
          destinationDiskNumber: 4,
          destinationBusType: 'USB',
        }),
      };
    };
    const source = String.raw`C:\safe\gophones.sqlite`;
    const hostile = String.raw`E:\x'; Write-Output 'INJECTED'; #`;
    const diskInspector = createWindowsDiskInspector({
      execute,
      timeoutMs: 1234,
      maxOutputBytes: 2048,
    });

    await expect(diskInspector.inspect(source, hostile)).resolves.toMatchObject({
      ok: true,
      destinationDiskNumber: 4,
      destinationBusType: 'USB',
    });
    expect(captured).toBeDefined();
    expect(captured!.executable).toBe('powershell.exe');
    expect(captured!.args).toContain('-NoProfile');
    expect(captured!.args).toContain('-NonInteractive');
    expect(captured!.args).not.toContain('Bypass');
    expect(captured!.args).toContain(WINDOWS_DISK_INSPECTION_SCRIPT);
    expect(captured!.args.join(' ')).not.toContain(hostile);
    expect(captured!.options).toMatchObject({
      windowsHide: true,
      timeout: 1234,
      maxBuffer: 2048,
      encoding: 'utf8',
    });
    expect(captured!.options.env['GO_PHONES_POS_SOURCE_PATH']).toBe(source);
    expect(captured!.options.env['GO_PHONES_POS_DESTINATION_PATH']).toBe(hostile);
  });

  it.each([
    {
      execution: { ok: false, timedOut: true },
      expected: WINDOWS_DISK_INSPECTION_ERROR_CODES.timeout,
    },
    {
      execution: { ok: false, unavailable: true },
      expected: WINDOWS_DISK_INSPECTION_ERROR_CODES.unavailable,
    },
    {
      execution: { ok: false },
      expected: WINDOWS_DISK_INSPECTION_ERROR_CODES.failed,
    },
    {
      execution: { ok: true, stdout: 'not json: C:\\private\\path' },
      expected: WINDOWS_DISK_INSPECTION_ERROR_CODES.malformed,
    },
  ])('returns only the stable failure code for $expected', async ({ execution, expected }) => {
    const diskInspector = createWindowsDiskInspector({ execute: async () => execution });
    await expect(diskInspector.inspect(DATABASE, DESTINATION)).resolves.toEqual({
      ok: false,
      errorCode: expected,
    });
  });

  it('rejects unknown or malformed storage output', async () => {
    const diskInspector = createWindowsDiskInspector({
      execute: async () => ({
        ok: true,
        stdout: JSON.stringify({
          destinationDriveType: 'LOCAL',
          sourceDiskNumber: 0,
          destinationDiskNumber: 'one',
          destinationBusType: 'USB',
        }),
      }),
    });

    await expect(diskInspector.inspect(DATABASE, DESTINATION)).resolves.toEqual({
      ok: false,
      errorCode: WINDOWS_DISK_INSPECTION_ERROR_CODES.malformed,
    });
  });
});

describe('real Windows PowerShell round trip (smoke test)', () => {
  // Every test above injects a fake `execute`/`diskInspector`, so none of them
  // ever launch a real `powershell.exe` process. These tests use NO override —
  // they exercise the actual production path: PowerShell launches, the fixed
  // script parses both paths, `Get-Partition`/`Get-Disk`/`GetFinalPathNameByHandleW`
  // actually run, `ConvertTo-Json -Compress` actually emits output, and the
  // strict TypeScript parser actually accepts it (Phase 2L-C.2 fix for audit
  // finding H1).
  it.skipIf(process.platform !== 'win32')(
    'invokes the actual PowerShell script and resolves two same-volume paths consistently',
    async () => {
      // Both paths are created underneath ONE temp root, so same-volume
      // identity is guaranteed by construction — never by an assumption that
      // `process.execPath` and `os.tmpdir()` happen to share a disk, which is
      // not true on every Windows installation or CI runner (Phase 2L-C.2
      // remaining-corrections fix).
      const temp = makeTempDir('gpp-disk-inspection-smoke-');
      try {
        const sourceFile = join(temp.path, 'source.sqlite');
        writeFileSync(sourceFile, 'placeholder');
        const destinationDir = join(temp.path, 'destination');
        mkdirSync(destinationDir);

        const inspector = createWindowsDiskInspector({ timeoutMs: 10_000 });
        const result = await inspector.inspect(sourceFile, destinationDir);

        // `result` is always the strict, sanitized union — never raw stdout —
        // so even a failed assertion here cannot leak command output.
        expect(result.ok).toBe(true);
        if (result.ok && result.destinationDriveType === 'LOCAL') {
          expect(Number.isInteger(result.sourceDiskNumber)).toBe(true);
          expect(result.destinationDiskNumber).toBe(result.sourceDiskNumber);
          expect(result.destinationBusType.length).toBeGreaterThan(0);
        } else if (result.ok) {
          // An unusual environment (e.g. the whole temp root itself redirected
          // to a network share) — still proves the round trip works, just not
          // the same-disk fact.
          expect(result.destinationDriveType).toBe('MAPPED_NETWORK');
        }
      } finally {
        temp.cleanup();
      }
    },
    15_000,
  );

  it.skipIf(process.platform !== 'win32')(
    'the real writability probe round-trips against a genuine writable directory',
    async () => {
      const probe = createWindowsWritabilityProbe({ timeoutMs: 10_000 });
      const result = await probe.probe(tmpdir());
      expect(result).toEqual({ ok: true, writable: true });
    },
    15_000,
  );

  it.skipIf(process.platform !== 'win32')(
    'the real path resolver round-trips a genuine existing directory',
    async () => {
      const resolver = createWindowsPathResolver({ timeoutMs: 10_000 });
      const result = await resolver.resolve(tmpdir());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolvedPath.length).toBeGreaterThan(0);
        expect(result.resolvedPath.startsWith('\\\\?\\')).toBe(false);
      }
    },
    15_000,
  );
});

describe('Windows writability probe (bounded subprocess)', () => {
  it('uses a fixed noninteractive bounded invocation and passes hostile paths only via env', async () => {
    let captured: PowerShellInvocation | undefined;
    const execute: PowerShellExecutor = async (invocation) => {
      captured = invocation;
      return { ok: true, stdout: JSON.stringify({ writable: true }) };
    };
    const hostile = String.raw`E:\x'; Write-Output 'INJECTED'; #`;
    const probe = createWindowsWritabilityProbe({ execute, timeoutMs: 1234, maxOutputBytes: 2048 });

    await expect(probe.probe(hostile)).resolves.toEqual({ ok: true, writable: true });
    expect(captured).toBeDefined();
    expect(captured!.executable).toBe('powershell.exe');
    expect(captured!.args).toContain('-NoProfile');
    expect(captured!.args).toContain('-NonInteractive');
    expect(captured!.args).not.toContain('Bypass');
    expect(captured!.args.join(' ')).not.toContain(hostile);
    expect(captured!.options).toMatchObject({
      windowsHide: true,
      timeout: 1234,
      maxBuffer: 2048,
      encoding: 'utf8',
    });
    expect(captured!.options.env['GO_PHONES_POS_DESTINATION_PATH']).toBe(hostile);
  });

  it('reports not-writable without throwing', async () => {
    const probe = createWindowsWritabilityProbe({
      execute: async () => ({ ok: true, stdout: JSON.stringify({ writable: false }) }),
    });
    await expect(probe.probe(DESTINATION)).resolves.toEqual({ ok: true, writable: false });
  });

  it.each([
    {
      execution: { ok: false, timedOut: true },
      expected: WINDOWS_DISK_INSPECTION_ERROR_CODES.timeout,
    },
    {
      execution: { ok: false, unavailable: true },
      expected: WINDOWS_DISK_INSPECTION_ERROR_CODES.unavailable,
    },
    {
      execution: { ok: false },
      expected: WINDOWS_DISK_INSPECTION_ERROR_CODES.failed,
    },
    {
      execution: { ok: true, stdout: 'not json' },
      expected: WINDOWS_DISK_INSPECTION_ERROR_CODES.malformed,
    },
  ])(
    'genuinely bounds the probe and fails closed: returns $expected rather than hanging or guessing',
    async ({ execution, expected }) => {
      const probe = createWindowsWritabilityProbe({ execute: async () => execution });
      await expect(probe.probe(DESTINATION)).resolves.toEqual({ ok: false, errorCode: expected });
    },
  );

  it('rejects malformed output shapes (extra field, wrong type, non-object)', async () => {
    for (const stdout of [
      JSON.stringify({ writable: true, extra: 'field' }),
      JSON.stringify({ writable: 'yes' }),
      JSON.stringify(['not', 'an', 'object']),
      JSON.stringify(null),
    ]) {
      const probe = createWindowsWritabilityProbe({ execute: async () => ({ ok: true, stdout }) });
      await expect(probe.probe(DESTINATION)).resolves.toEqual({
        ok: false,
        errorCode: WINDOWS_DISK_INSPECTION_ERROR_CODES.malformed,
      });
    }
  });
});

describe('Windows path resolver (bounded subprocess) — Phase 2L-C.2 remaining-corrections fix', () => {
  it('uses a fixed noninteractive bounded invocation and passes hostile paths only via env', async () => {
    let captured: PowerShellInvocation | undefined;
    const execute: PowerShellExecutor = async (invocation) => {
      captured = invocation;
      return {
        ok: true,
        stdout: JSON.stringify({ resolvedPath: String.raw`E:\GoPhonesPOS Backups` }),
      };
    };
    const hostile = String.raw`E:\x'; Write-Output 'INJECTED'; #`;
    const resolver = createWindowsPathResolver({ execute, timeoutMs: 1234, maxOutputBytes: 2048 });

    await expect(resolver.resolve(hostile)).resolves.toEqual({
      ok: true,
      resolvedPath: String.raw`E:\GoPhonesPOS Backups`,
    });
    expect(captured).toBeDefined();
    expect(captured!.executable).toBe('powershell.exe');
    expect(captured!.args).toContain('-NoProfile');
    expect(captured!.args).toContain('-NonInteractive');
    expect(captured!.args).not.toContain('Bypass');
    expect(captured!.args.join(' ')).not.toContain(hostile);
    expect(captured!.options).toMatchObject({
      windowsHide: true,
      timeout: 1234,
      maxBuffer: 2048,
      encoding: 'utf8',
    });
    expect(captured!.options.env['GO_PHONES_POS_TARGET_PATH']).toBe(hostile);
  });

  it('successfully resolves and normalizes an extended-length-prefixed result', async () => {
    const resolver = createWindowsPathResolver({
      execute: async () => ({
        ok: true,
        stdout: JSON.stringify({ resolvedPath: String.raw`\\?\E:\GoPhonesPOS Backups` }),
      }),
    });
    // Normalization of the \\?\ prefix happens inside the fixed PowerShell
    // script itself (see WINDOWS_PATH_RESOLUTION_SCRIPT); this fake executor
    // returns a pre-normalized shape to prove the TypeScript side accepts it
    // as-is without re-deriving that logic.
    await expect(resolver.resolve(DESTINATION)).resolves.toEqual({
      ok: true,
      resolvedPath: String.raw`\\?\E:\GoPhonesPOS Backups`,
    });
  });

  it.each([
    {
      execution: { ok: false, timedOut: true },
      expected: WINDOWS_DISK_INSPECTION_ERROR_CODES.timeout,
    },
    {
      execution: { ok: false, unavailable: true },
      expected: WINDOWS_DISK_INSPECTION_ERROR_CODES.unavailable,
    },
    {
      execution: { ok: false },
      expected: WINDOWS_DISK_INSPECTION_ERROR_CODES.failed,
    },
    {
      execution: { ok: true, stdout: 'not json' },
      expected: WINDOWS_DISK_INSPECTION_ERROR_CODES.malformed,
    },
  ])(
    'genuinely bounds resolution and fails closed: returns $expected rather than hanging or guessing',
    async ({ execution, expected }) => {
      const resolver = createWindowsPathResolver({ execute: async () => execution });
      await expect(resolver.resolve(DESTINATION)).resolves.toEqual({
        ok: false,
        errorCode: expected,
      });
    },
  );

  it('rejects malformed output shapes (extra field, wrong type, empty, oversized, non-object)', async () => {
    for (const stdout of [
      JSON.stringify({ resolvedPath: String.raw`E:\ok`, extra: 'field' }),
      JSON.stringify({ resolvedPath: 42 }),
      JSON.stringify({ resolvedPath: '' }),
      JSON.stringify({ resolvedPath: 'x'.repeat(5000) }),
      JSON.stringify(['not', 'an', 'object']),
      JSON.stringify(null),
    ]) {
      const resolver = createWindowsPathResolver({ execute: async () => ({ ok: true, stdout }) });
      await expect(resolver.resolve(DESTINATION)).resolves.toEqual({
        ok: false,
        errorCode: WINDOWS_DISK_INSPECTION_ERROR_CODES.malformed,
      });
    }
  });
});

describe('OFF_DEVICE destination setting', () => {
  it('uses the existing settings table and can be explicitly cleared', async () => {
    const db = await createMigratedDb();
    try {
      expect(readOffDeviceBackupDestination(db)).toBeNull();

      writeOffDeviceBackupDestination(db, DESTINATION, '2026-09-11T12:00:00.000Z');
      expect(readOffDeviceBackupDestination(db)).toEqual({
        destinationPath: DESTINATION,
        updatedAt: '2026-09-11T12:00:00.000Z',
      });

      expect(clearOffDeviceBackupDestination(db)).toBe(true);
      expect(clearOffDeviceBackupDestination(db)).toBe(false);
      expect(readOffDeviceBackupDestination(db)).toBeNull();
    } finally {
      db.close();
    }
  });
});
