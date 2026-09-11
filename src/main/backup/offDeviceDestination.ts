import { hostname, networkInterfaces } from 'node:os';
import { win32 } from 'node:path';
import type { OffDeviceDestinationKind } from '../../shared/backup';
import { createBoundedHostnameResolver } from './boundedHostnameResolver';
import type { HostnameResolver } from './boundedHostnameResolver';
import {
  WINDOWS_DISK_INSPECTION_ERROR_CODES,
  createWindowsDiskInspector,
  createWindowsPathResolver,
  createWindowsWritabilityProbe,
} from './windowsDiskInspection';
import type { WindowsDiskInspector } from './windowsDiskInspection';

export const OFF_DEVICE_DESTINATION_ERROR_CODES = {
  unsupportedPlatform: 'OFF_DEVICE_UNSUPPORTED_PLATFORM',
  inaccessible: 'OFF_DEVICE_DESTINATION_UNAVAILABLE',
  notWritable: 'OFF_DEVICE_DESTINATION_NOT_WRITABLE',
  localNetworkShare: 'OFF_DEVICE_LOCAL_NETWORK_SHARE_REJECTED',
  mappedNetworkDrive: 'OFF_DEVICE_MAPPED_NETWORK_AMBIGUOUS',
  samePhysicalDisk: 'OFF_DEVICE_SAME_PHYSICAL_DISK',
  internalDisk: 'OFF_DEVICE_NOT_EXTERNAL_USB',
  verificationFailed: 'OFF_DEVICE_VERIFICATION_FAILED',
} as const;

export type OffDeviceDestinationErrorCode =
  (typeof OFF_DEVICE_DESTINATION_ERROR_CODES)[keyof typeof OFF_DEVICE_DESTINATION_ERROR_CODES];

export type OffDeviceDestinationVerification =
  | {
      readonly ok: true;
      readonly kind: OffDeviceDestinationKind;
      /** Trusted-main-process value only. Never include this in renderer DTOs or logs. */
      readonly canonicalPath: string;
      /** Plain non-path UI label. */
      readonly displayName: string;
    }
  | { readonly ok: false; readonly errorCode: OffDeviceDestinationErrorCode };

export interface OffDeviceFilesystem {
  canonicalize(path: string): Promise<string>;
  probeWritable(directory: string): Promise<boolean>;
}

export interface OffDeviceDestinationVerifier {
  verify(
    operationalDatabasePath: string,
    destinationDirectory: string,
  ): Promise<OffDeviceDestinationVerification>;
}

/** The subset of `os.NetworkInterfaceInfo` this module actually needs — kept
 * loose so a test can inject a plain literal without importing Node's type. */
export interface NetworkInterfaceAddress {
  readonly address: string;
}

export interface OffDeviceDestinationVerifierOptions {
  readonly platform?: NodeJS.Platform;
  readonly computerName?: string;
  readonly filesystem?: OffDeviceFilesystem;
  readonly diskInspector?: WindowsDiskInspector;
  /** Injectable so tests never depend on the real machine's own network configuration. */
  readonly networkInterfaces?: () => NodeJS.Dict<readonly NetworkInterfaceAddress[]>;
  /** Injectable so tests control name resolution instead of hitting real DNS. */
  readonly hostnameResolver?: HostnameResolver;
}

const defaultWritabilityProbe = createWindowsWritabilityProbe();
const defaultPathResolver = createWindowsPathResolver();

const defaultFilesystem: OffDeviceFilesystem = {
  // Genuinely bounded via a killable child process (Phase 2L-C.2 remaining-
  // corrections fix) — `fs.promises.realpath()` gives no real cancellation on
  // this runtime either, and symlink/junction resolution here is not
  // cosmetic (see `createWindowsPathResolver`'s doc comment): a destination
  // reached through a junction must resolve to the disk actually backing its
  // bytes, not the junction's own drive, or the same-disk check downstream
  // could be bypassed.
  async canonicalize(path): Promise<string> {
    const result = await defaultPathResolver.resolve(path);
    if (!result.ok) {
      throw new Error(result.errorCode);
    }
    return result.resolvedPath;
  },
  async probeWritable(directory): Promise<boolean> {
    const result = await defaultWritabilityProbe.probe(directory);
    return result.ok && result.writable;
  },
};

function isUncPath(path: string): boolean {
  return /^\\\\(?![?.]\\)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(path);
}

function uncHost(path: string): string | null {
  if (!isUncPath(path)) return null;
  return path.slice(2).split(/[\\/]/, 1)[0]?.toLowerCase() ?? null;
}

/** Canonicalize an IPv6 literal for robust comparison (case, compression, brackets). */
function normalizeIpv6(address: string): string | null {
  try {
    // The zone id (`%eth0`) is stripped for comparison — link-local scope
    // disambiguation is not meaningful for a backup-destination host check.
    return new URL(`http://[${address.split('%')[0]}]`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const WINDOWS_IPV6_LITERAL_SUFFIX = '.ipv6-literal.net';

/**
 * Decode Windows' UNC-safe IPv6 literal host form — e.g.
 * `fe80--1234-5678-9abc-def0.ipv6-literal.net` → `fe80::1234:5678:9abc:def0`
 * (`-` stands in for `:` because `:` cannot appear in a UNC host segment) —
 * or `null` when `host` is not that form.
 */
function decodeWindowsIpv6LiteralHost(host: string): string | null {
  if (!host.endsWith(WINDOWS_IPV6_LITERAL_SUFFIX)) return null;
  const encoded = host.slice(0, -WINDOWS_IPV6_LITERAL_SUFFIX.length);
  const withoutZone = encoded.split('s')[0] ?? encoded; // Windows encodes a zone id as `s<id>`
  return normalizeIpv6(withoutZone.replace(/-/g, ':'));
}

/** This machine's own interface addresses, split by family, normalized for comparison. */
function localInterfaceAddresses(interfaces: NodeJS.Dict<readonly NetworkInterfaceAddress[]>): {
  readonly ipv4: ReadonlySet<string>;
  readonly ipv6: ReadonlySet<string>;
} {
  const ipv4 = new Set<string>();
  const ipv6 = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.address.includes(':')) {
        const normalized = normalizeIpv6(entry.address);
        if (normalized) ipv6.add(normalized);
      } else {
        ipv4.add(entry.address.toLowerCase());
      }
    }
  }
  return { ipv4, ipv6 };
}

/**
 * `true` only when `host` is a literal IP address (plain IPv4, or Windows'
 * `ipv6-literal.net` UNC form) that positively matches one of THIS machine's
 * own interface addresses right now. Never attempts DNS resolution — an
 * ordinary hostname that merely happens to resolve to a local address is
 * deliberately NOT caught here, so an unreachable/unavailable DNS server can
 * never turn a genuine remote UNC host into a false rejection.
 */
function isOwnNetworkAddress(
  host: string,
  interfaces: NodeJS.Dict<readonly NetworkInterfaceAddress[]>,
): boolean {
  const local = localInterfaceAddresses(interfaces);
  if (IPV4_LITERAL.test(host)) {
    return local.ipv4.has(host);
  }
  const decodedIpv6 = decodeWindowsIpv6LiteralHost(host);
  if (decodedIpv6 !== null) {
    return local.ipv6.has(decodedIpv6);
  }
  return false;
}

function isLiteralIpForm(host: string): boolean {
  return IPV4_LITERAL.test(host) || decodeWindowsIpv6LiteralHost(host) !== null;
}

/**
 * `true` when `host` is obviously this machine, either by literal form
 * (checked synchronously, no I/O) or — for an ordinary hostname/alias not
 * already caught by a literal check — by bounded name resolution positively
 * matching one of this machine's own addresses (Phase 2L-C.2 remaining-
 * corrections fix: an alias like `pos-backup-alias` that happens to resolve
 * back to this machine must not qualify as genuine off-device storage).
 *
 * Resolution is never attempted for an already-literal IP form (resolving an
 * IP as a hostname is meaningless), and a resolution failure/timeout/
 * unavailability is never treated as evidence of anything — it only means
 * this positive check cannot fire, so an unrelated remote host is never
 * falsely rejected merely because DNS is flaky.
 */
async function isObviousLocalHost(
  host: string,
  computerName: string,
  interfaces: NodeJS.Dict<readonly NetworkInterfaceAddress[]>,
  resolver: HostnameResolver,
): Promise<boolean> {
  const normalizedComputerName = computerName.trim().toLowerCase();
  if (
    host === '.' ||
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(host) ||
    (normalizedComputerName.length > 0 &&
      (host === normalizedComputerName || host === `${normalizedComputerName}.local`)) ||
    isOwnNetworkAddress(host, interfaces)
  ) {
    return true;
  }
  if (isLiteralIpForm(host)) {
    // A literal IP that did not match this machine's own addresses above —
    // never attempt to "resolve" an IP address as if it were a hostname.
    return false;
  }

  const resolution = await resolver.resolve(host);
  if (!resolution.ok) {
    return false;
  }
  const local = localInterfaceAddresses(interfaces);
  return resolution.addresses.some((address) =>
    address.includes(':')
      ? local.ipv6.has(normalizeIpv6(address) ?? '')
      : local.ipv4.has(address.toLowerCase()),
  );
}

function usbDisplayName(canonicalPath: string): string {
  const root = win32.parse(canonicalPath).root;
  return root.length > 0 ? `External USB drive (${root.replace(/\\$/, '')})` : 'External USB drive';
}

function networkDisplayName(canonicalPath: string): string {
  const host = uncHost(canonicalPath);
  return host ? `Network backup (${host})` : 'Network backup';
}

function mapInspectionFailure(errorCode: string): OffDeviceDestinationErrorCode {
  if (
    errorCode === WINDOWS_DISK_INSPECTION_ERROR_CODES.unavailable ||
    errorCode === WINDOWS_DISK_INSPECTION_ERROR_CODES.timeout ||
    errorCode === WINDOWS_DISK_INSPECTION_ERROR_CODES.failed ||
    errorCode === WINDOWS_DISK_INSPECTION_ERROR_CODES.malformed ||
    errorCode === WINDOWS_DISK_INSPECTION_ERROR_CODES.ambiguous
  ) {
    return OFF_DEVICE_DESTINATION_ERROR_CODES.verificationFailed;
  }
  return OFF_DEVICE_DESTINATION_ERROR_CODES.verificationFailed;
}

export function createOffDeviceDestinationVerifier(
  options: OffDeviceDestinationVerifierOptions = {},
): OffDeviceDestinationVerifier {
  const platform = options.platform ?? process.platform;
  const computerName = options.computerName ?? hostname();
  const filesystem = options.filesystem ?? defaultFilesystem;
  const diskInspector = options.diskInspector ?? createWindowsDiskInspector();
  const getNetworkInterfaces = options.networkInterfaces ?? networkInterfaces;
  const hostnameResolver = options.hostnameResolver ?? createBoundedHostnameResolver();

  return {
    async verify(operationalDatabasePath, destinationDirectory) {
      if (platform !== 'win32') {
        return {
          ok: false,
          errorCode: OFF_DEVICE_DESTINATION_ERROR_CODES.unsupportedPlatform,
        };
      }

      let canonicalDatabase: string;
      let canonicalDestination: string;
      try {
        [canonicalDatabase, canonicalDestination] = await Promise.all([
          filesystem.canonicalize(operationalDatabasePath),
          filesystem.canonicalize(destinationDirectory),
        ]);
      } catch {
        return { ok: false, errorCode: OFF_DEVICE_DESTINATION_ERROR_CODES.inaccessible };
      }

      if (isUncPath(canonicalDestination)) {
        const host = uncHost(canonicalDestination);
        if (
          host === null ||
          (await isObviousLocalHost(host, computerName, getNetworkInterfaces(), hostnameResolver))
        ) {
          return {
            ok: false,
            errorCode: OFF_DEVICE_DESTINATION_ERROR_CODES.localNetworkShare,
          };
        }
        if (!(await filesystem.probeWritable(canonicalDestination))) {
          return { ok: false, errorCode: OFF_DEVICE_DESTINATION_ERROR_CODES.notWritable };
        }
        return {
          ok: true,
          kind: 'NETWORK',
          canonicalPath: canonicalDestination,
          displayName: networkDisplayName(canonicalDestination),
        };
      }

      const inspection = await diskInspector.inspect(canonicalDatabase, canonicalDestination);
      if (!inspection.ok) {
        return { ok: false, errorCode: mapInspectionFailure(inspection.errorCode) };
      }
      if (inspection.destinationDriveType === 'MAPPED_NETWORK') {
        return {
          ok: false,
          errorCode: OFF_DEVICE_DESTINATION_ERROR_CODES.mappedNetworkDrive,
        };
      }
      if (
        inspection.sourceDiskNumber === null ||
        inspection.destinationDiskNumber === null ||
        inspection.sourceDiskNumber === inspection.destinationDiskNumber
      ) {
        return {
          ok: false,
          errorCode: OFF_DEVICE_DESTINATION_ERROR_CODES.samePhysicalDisk,
        };
      }
      if (inspection.destinationBusType.trim().toUpperCase() !== 'USB') {
        return { ok: false, errorCode: OFF_DEVICE_DESTINATION_ERROR_CODES.internalDisk };
      }
      if (!(await filesystem.probeWritable(canonicalDestination))) {
        return { ok: false, errorCode: OFF_DEVICE_DESTINATION_ERROR_CODES.notWritable };
      }

      return {
        ok: true,
        kind: 'USB',
        canonicalPath: canonicalDestination,
        displayName: usbDisplayName(canonicalDestination),
      };
    },
  };
}

/** A stable app-owned folder name for the configuration service to append to a selected root. */
export const OFF_DEVICE_MANAGED_DIRECTORY_NAME = 'GoPhonesPOS Backups';

/** Safe display fallback for a selected directory; never returns a full path. */
export function offDeviceDirectoryLabel(path: string): string {
  return win32.basename(path) || 'Go Phones POS backups';
}
