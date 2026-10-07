/**
 * Phase 18 observability: JSON logs that carry the request and tenant, never
 * a secret; metrics that an alert rule can read.
 */

import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import express from 'express';

import { ErrorCode } from '../src/messaging/errors.js';
import {
    bindContext, createLogger, logger, requestContext, runWithContext, scrub, setLevel, setSink,
} from '../src/observability/logger.js';
import * as metrics from '../src/observability/metrics.js';

const lines = [];
before(() => setSink((level, line) => lines.push(JSON.parse(line))));
afterEach(() => { lines.length = 0; setLevel('info'); });

describe('scrub', () => {
    it('redacts secrets by key name at any depth, and leaves working keys alone', () => {
        const out = scrub({
            accessToken: 'EAAB', password: 'pw', key: 'k', secret: 's', authorization: 'Bearer x',
            nested: { apiKey: 'a', api_key: 'b', webhookVerifyToken: 't', encryptionKey: 'e', list: [{ token: 'x' }] },
            idempotencyKey: 'keep-me', keyword: 'hi', phoneNumberId: '123', empty: '', none: null,
        });
        for (const k of ['accessToken', 'password', 'key', 'secret', 'authorization']) assert.equal(out[k], '[redacted]');
        for (const k of ['apiKey', 'api_key', 'webhookVerifyToken', 'encryptionKey']) assert.equal(out.nested[k], '[redacted]');
        assert.equal(out.nested.list[0].token, '[redacted]');
        assert.equal(out.idempotencyKey, 'keep-me');
        assert.equal(out.keyword, 'hi');
        assert.equal(out.phoneNumberId, '123');
        assert.equal(out.empty, '', 'an empty secret says "unset", which is not a leak');
        assert.equal(out.none, null);
    });

    it('survives cycles and errors', () => {
        const a = { name: 'a' };
        a.self = a;
        assert.equal(scrub(a).self, '[circular]');
        const err = new Error('boom');
        err.accessToken = 'x';
        const out = scrub(err);
        assert.equal(out.message, 'boom');
        assert.equal(out.accessToken, '[redacted]');
    });
});

describe('logger', () => {
    it('writes one JSON object per line with level, time and message', () => {
        logger.info('hello', { tenantId: 3, config: { accessToken: 'leak' } });
        assert.equal(lines.length, 1);
        const [line] = lines;
        assert.equal(line.level, 'info');
        assert.equal(line.message, 'hello');
        assert.equal(line.tenantId, 3);
        assert.equal(line.config.accessToken, '[redacted]');
        assert.ok(!Number.isNaN(Date.parse(line.time)));
    });

    it('filters below the threshold', () => {
        logger.debug('quiet');
        assert.equal(lines.length, 0);
        setLevel('debug');
        logger.debug('loud');
        assert.equal(lines.length, 1);
    });

    it('child loggers and ambient context both land on the line, context underneath', async () => {
        const child = createLogger({ channelId: 7 }).child({ component: 'queue' });
        await runWithContext({ requestId: 'r1', tenantId: 1 }, async () => {
            await Promise.resolve();
            bindContext({ tenantId: 2 });
            child.warn('x');
        });
        assert.deepEqual(
            { ...lines[0], time: undefined },
            { level: 'warn', message: 'x', requestId: 'r1', tenantId: 2, channelId: 7, component: 'queue', time: undefined },
        );
        child.info('outside');
        assert.equal(lines[1].requestId, undefined, 'context does not leak out of the run');
    });
});

describe('requestContext middleware', () => {
    let server;
    let base;
    before(async () => {
        const app = express();
        app.use(requestContext());
        app.get('/t', async (req, res) => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            req.tenantId = 42;
            bindContext({ tenantId: 42 });
            logger.info('inside handler');
            res.json({ id: req.id });
        });
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => new Promise((resolve) => server.close(resolve)));

    it('honours an inbound X-Request-Id, echoes it, and threads it through awaited code', async () => {
        const res = await fetch(`${base}/t`, { headers: { 'x-request-id': 'abc-123' } });
        assert.equal(res.headers.get('x-request-id'), 'abc-123');
        assert.equal((await res.json()).id, 'abc-123');
        await new Promise((resolve) => setTimeout(resolve, 10));
        const inside = lines.find((l) => l.message === 'inside handler');
        const access = lines.find((l) => l.message === 'request');
        assert.equal(inside.requestId, 'abc-123');
        assert.equal(inside.tenantId, 42);
        assert.equal(access.requestId, 'abc-123');
        assert.equal(access.tenantId, 42);
        assert.equal(access.status, 200);
        assert.ok(access.durationMs >= 0);
    });

    it('generates an id when none is sent', async () => {
        const res = await fetch(`${base}/t`);
        assert.match(res.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
    });
});

describe('metrics', () => {
    afterEach(() => metrics.reset());

    it('counts, times and reads gauges live in snapshot()', () => {
        metrics.inc('sends', { channelId: 1 });
        metrics.inc('sends', { channelId: 1 });
        metrics.observe('provider_latency_ms', 100, { provider: 'cloud_api' });
        metrics.observe('provider_latency_ms', 300, { provider: 'cloud_api' });
        let depth = 3;
        metrics.registerQueue(1, () => depth);
        const snap = metrics.snapshot();
        assert.equal(snap.counters['sends{channelId=1}'], 2);
        assert.deepEqual(snap.timers['provider_latency_ms{provider=cloud_api}'], { count: 2, totalMs: 400, maxMs: 300, avgMs: 200 });
        assert.equal(snap.gauges['queue_depth{channelId=1}'], 3);
        depth = 0;
        assert.equal(metrics.snapshot().gauges['queue_depth{channelId=1}'], 0, 'gauges are read at snapshot time');
        metrics.unregisterQueue(1);
        assert.equal('queue_depth{channelId=1}' in metrics.snapshot().gauges, false);
        assert.equal(typeof snap.uptimeSec, 'number');
    });

    it('folds unknown error codes into UNKNOWN and reports a rate and a recent window', () => {
        metrics.recordProviderLatency(50, { provider: 'cloud_api' });
        metrics.recordProviderLatency(50, { provider: 'cloud_api' });
        metrics.recordError(ErrorCode.RATE_LIMITED);
        metrics.recordError('SOMETHING_NEW');
        metrics.recordWorkflowRun('completed');
        const snap = metrics.snapshot();
        assert.equal(snap.counters['errors{code=RATE_LIMITED}'], 1);
        assert.equal(snap.counters['errors{code=UNKNOWN}'], 1);
        assert.equal(snap.counters['workflow_runs{outcome=completed}'], 1);
        assert.deepEqual(snap.errors, { total: 2, last5m: 2, rate: 1 });
        assert.equal(metrics.snapshot(Date.now() + 6 * 60 * 1000).errors.last5m, 0);
    });

    it('a broken gauge does not break the snapshot', () => {
        metrics.gauge('bad', () => { throw new Error('nope'); });
        const snap = metrics.snapshot();
        assert.equal(snap.gauges.bad, null);
        assert.equal(snap.counters['metrics_gauge_errors{gauge=bad}'], 1);
    });

    it('timed() measures a block', () => {
        const done = metrics.timed('block');
        done();
        assert.equal(metrics.snapshot().timers.block.count, 1);
    });
});
