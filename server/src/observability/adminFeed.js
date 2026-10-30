/**
 * The super admin's live stream: one SSE feed across every tenant.
 *
 * Tenant browsers each get their number's own stream (`/api/events`); the admin screens span every tenant and had
 * none, so they polled every 30s and showed a finished campaign or a dropped number half a minute late. This feed
 * carries only "topic X changed (for tenant N)" — never message text or phone numbers — and the page reloads what it
 * shows. A busy sender emits a status per message, so each topic is coalesced to one event per `coalesceMs`.
 */

/** The admin topic for a tenant-runtime event; null for events no admin screen shows. */
export function adminTopics(event) {
    switch (event?.type) {
        case 'connection':
        case 'connectionLost':
        case 'transportState':
        case 'safetyEvent':
            return ['channels'];
        case 'status':
        case 'stats':
        case 'receipt':
            return ['campaigns', 'usage'];
        case 'quotaReached':
        case 'policyHold':
        case 'policyStop':
        case 'failureStop':
            return ['campaigns', 'usage', 'channels'];
        case 'changed': {
            const topic = String(event.topic ?? '');
            if (['channels', 'connection', 'config', 'safety'].includes(topic)) return ['channels'];
            if (['campaigns', 'campaign'].includes(topic)) return ['campaigns'];
            if (['templates'].includes(topic)) return ['templates'];
            return ['tenants'];
        }
        default:
            return /^campaign[A-Z]/.test(String(event?.type ?? '')) ? ['campaigns'] : null;
    }
}

/**
 * @param {{ coalesceMs?: number }} [options]
 */
export function createAdminFeed({ coalesceMs = 700 } = {}) {
    const clients = new Set();
    const pending = new Map(); // topic -> Set(tenantId|null), flushed by `timer`
    let timer = null;

    const send = (payload) => {
        const line = `data: ${JSON.stringify(payload)}\n\n`;
        for (const res of clients) {
            if (res.writableEnded || res.destroyed) {
                clients.delete(res);
                continue;
            }
            // A tab that stopped reading must not grow this process: drop it, its EventSource reconnects.
            if (res.writableLength > 256 * 1024) {
                clients.delete(res);
                res.end();
                continue;
            }
            res.write(line, (err) => {
                if (err) clients.delete(res);
            });
        }
    };

    const flush = () => {
        timer = null;
        for (const [topic, tenants] of pending) {
            send({ type: 'changed', topic, tenantIds: [...tenants].filter((id) => id !== null) });
        }
        pending.clear();
    };

    return {
        /** Note that `topic` changed (for `tenantId`, or platform-wide with null); sent within `coalesceMs`. */
        publish(topic, tenantId = null) {
            if (!clients.size || !topic) return;
            if (!pending.has(topic)) pending.set(topic, new Set());
            pending.get(topic).add(tenantId == null ? null : Number(tenantId));
            timer ??= setTimeout(flush, coalesceMs);
            timer.unref?.();
        },
        /** Forward a tenant runtime's event as the admin topics it touches. */
        fromRuntime(tenantId, event) {
            for (const topic of adminTopics(event) ?? []) this.publish(topic, tenantId);
        },
        /** Express handler for GET /api/admin/events (the caller has already checked the role). */
        stream(req, res) {
            req.socket.setTimeout(0);
            req.socket.setKeepAlive(true, 30000);
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no',
            });
            res.write('event: hello\ndata: {}\n\n');
            res.sessionToken = req.token;
            clients.add(res);
            // Proxies drop an idle stream; a comment every 25s keeps it open.
            const keepAlive = setInterval(() => res.write(': ping\n\n', () => {}), 25000);
            keepAlive.unref?.();
            const cleanup = () => {
                clearInterval(keepAlive);
                clients.delete(res);
            };
            req.on('close', cleanup);
            res.on('error', cleanup);
        },
        /** End every stream whose session `alive(token)` no longer accepts. */
        prune(alive) {
            for (const res of clients) {
                if (res.sessionToken === undefined || alive(res.sessionToken)) continue;
                clients.delete(res);
                res.end();
            }
        },
        get size() {
            return clients.size;
        },
    };
}
