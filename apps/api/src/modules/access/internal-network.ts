import { BlockList, isIPv4, isIPv6 } from 'node:net';

/**
 * The internal panel's network (doc 04 §6; owner 1405/07/18, R10 of task 9-3): the VPN only,
 * or the office's address where there is no VPN, and never left open. Closed by default: no
 * listed network lets no internal role in. In production `enabled: false` is closed too; only
 * a throwaway development or test database may turn the limit off.
 *
 * Two sources, both lists of CIDRs:
 * - INTERNAL_PANEL_CIDRS on the server (the VPN's range at deploy, task 10-1): what lets the
 *   first administrators in while the versioned list is still empty, and back in if a change
 *   to it locked everyone out. Set by whoever runs the server, as TRUST_PROXY is.
 * - `access.internal_panel_ip_allowlist`, versioned, changed by two people from the panel.
 */
export interface InternalNetworkPolicy {
  readonly enabled: boolean;
  readonly cidrs: readonly string[];
}

const CIDR = /^([0-9a-fA-F:.]+)\/(\d{1,3})$/;

/** The server's ranges; a malformed one stops the API at start rather than letting anyone in. */
export function internalPanelCidrsFromEnv(env: NodeJS.ProcessEnv): string[] {
  const cidrs = (env['INTERNAL_PANEL_CIDRS'] ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c !== '');
  for (const cidr of cidrs) {
    const [, address = '', prefix = ''] = CIDR.exec(cidr) ?? [];
    const max = isIPv4(address) ? 32 : isIPv6(address) ? 128 : -1;
    if (max < 0 || Number(prefix) > max) {
      throw new Error('INTERNAL_PANEL_CIDRS: each entry must be an address/prefix (CIDR)');
    }
  }
  return cidrs;
}

export function internalPanelAllows(input: {
  policy: InternalNetworkPolicy;
  serverCidrs: readonly string[];
  production: boolean;
  ip: string | null;
}): boolean {
  const { policy, production, ip } = input;
  if (!policy.enabled && !production) return true;
  if (ip === null) return false;
  const family = isIPv4(ip) ? 'ipv4' : isIPv6(ip) ? 'ipv6' : null;
  if (family === null) return false;
  const cidrs = [...input.serverCidrs, ...(policy.enabled ? policy.cidrs : [])];
  if (cidrs.length === 0) return false;
  const allowed = new BlockList();
  for (const cidr of cidrs) {
    const [address = '', prefix = ''] = cidr.split('/');
    allowed.addSubnet(address, Number(prefix), isIPv4(address) ? 'ipv4' : 'ipv6');
  }
  return allowed.check(ip, family);
}
