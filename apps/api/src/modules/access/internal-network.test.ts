import { describe, expect, it } from 'vitest';
import { internalPanelAllows, internalPanelCidrsFromEnv } from './internal-network';

const closed = { enabled: true, cidrs: [] };
const office = { enabled: true, cidrs: ['10.250.0.0/16'] };
const off = { enabled: false, cidrs: [] };

const allows = (
  policy: { enabled: boolean; cidrs: string[] },
  ip: string | null,
  options: { serverCidrs?: string[]; production?: boolean } = {},
) =>
  internalPanelAllows({
    policy,
    ip,
    serverCidrs: options.serverCidrs ?? [],
    production: options.production ?? true,
  });

describe('the internal panel network (R10, owner 1405/07/18)', () => {
  it('is closed by default: no listed network lets nobody in', () => {
    expect(allows(closed, '10.250.7.7')).toBe(false);
    expect(allows(closed, '127.0.0.1')).toBe(false);
    expect(allows(closed, null)).toBe(false);
  });

  it('is never left open in production, even when switched off', () => {
    expect(allows(off, '10.250.7.7', { production: true })).toBe(false);
    expect(allows(off, '10.8.0.5', { production: true, serverCidrs: ['10.8.0.0/24'] })).toBe(true);
    expect(allows(off, '10.250.7.7', { production: true, serverCidrs: ['10.8.0.0/24'] })).toBe(
      false,
    );
    // Only a throwaway development or test database may turn it off.
    expect(allows(off, '203.0.113.9', { production: false })).toBe(true);
  });

  it('lets in the VPN range of the server and the versioned list, nothing else', () => {
    const vpn = { serverCidrs: ['10.8.0.0/24', 'fd00:8::/64'] };
    expect(allows(closed, '10.8.0.17', vpn)).toBe(true);
    expect(allows(closed, 'fd00:8::42', vpn)).toBe(true);
    expect(allows(closed, '10.8.1.17', vpn)).toBe(false);
    expect(allows(office, '10.250.7.7')).toBe(true);
    expect(allows(office, '10.251.7.7')).toBe(false);
    expect(allows(office, 'not-an-ip')).toBe(false);
  });

  it('refuses to start on a malformed server range', () => {
    expect(internalPanelCidrsFromEnv({})).toEqual([]);
    expect(internalPanelCidrsFromEnv({ INTERNAL_PANEL_CIDRS: ' 10.8.0.0/24, ::1/128 ' })).toEqual([
      '10.8.0.0/24',
      '::1/128',
    ]);
    for (const bad of ['10.8.0.0', '10.8.0.0/33', 'vpn/24', '::1/129']) {
      expect(() => internalPanelCidrsFromEnv({ INTERNAL_PANEL_CIDRS: bad })).toThrow(
        'INTERNAL_PANEL_CIDRS',
      );
    }
  });
});
