/**
 * The public API's IP allow-list (`security.ipAllowList`). An entry is an
 * exact address (IPv4 or IPv6) or an IPv4 CIDR block. Express reports an IPv4
 * client on a dual-stack socket as `::ffff:1.2.3.4`, so that prefix is
 * stripped on both sides before comparing, and IPv6 is compared in its
 * canonical form so `2001:0db8:0:0::1` matches `2001:db8::1`.
 *
 * Behind a reverse proxy `req.ip` is the proxy unless `trust proxy` is set
 * (TRUST_PROXY in app.js), and then every client would share one address.
 */

import net from 'node:net';

/** The URL parser compresses IPv6 the standard way; a zone id (`%eth0`) it rejects is left as written. */
function canonical6(ip) {
    try {
        return new URL(`http://[${ip}]`).hostname.slice(1, -1);
    } catch {
        return ip;
    }
}

function bare(ip) {
    const s = String(ip ?? '').trim().toLowerCase().replace(/^::ffff:(?=\d+\.)/, '');
    return net.isIPv6(s) ? canonical6(s) : s;
}

/** An IPv4 address as a number, or null. */
function v4(ip) {
    return net.isIPv4(ip) ? ip.split('.').reduce((n, part) => n * 256 + Number(part), 0) : null;
}

/** Why an entry cannot be used, or null when it is a valid address or IPv4 CIDR. */
export function ipEntryError(entry) {
    const e = bare(entry);
    if (!e.includes('/')) return net.isIP(e) ? null : `"${entry}" is not an IP address`;
    const [base, bits] = e.split('/');
    return v4(base) !== null && /^\d{1,2}$/.test(bits) && Number(bits) <= 32
        ? null : `"${entry}" is not an IPv4 CIDR block (like 10.0.0.0/24)`;
}

/** True when `ip` matches an entry. An empty list allows every address. */
export function ipAllowed(list, ip) {
    if (!Array.isArray(list) || !list.length) return true;
    const addr = bare(ip);
    const a = v4(addr);
    return list.some((entry) => {
        const e = bare(entry);
        if (!e.includes('/')) return e === addr;
        const [base, bits] = e.split('/');
        const n = v4(base);
        const size = 2 ** (32 - Number(bits));
        // Division rather than bit masks: JS bitwise ops are signed 32-bit.
        return a !== null && n !== null && !ipEntryError(e) && Math.floor(a / size) === Math.floor(n / size);
    });
}
