// Tests must never touch the real ~/.whatsapp_sender_web data: give every run its own home.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.WHATSAPP_SENDER_HOME ||= fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-test-home-'));
// The offline sandbox transport exists only for tests and the demo script.
process.env.WHATSAPP_SENDER_SANDBOX ||= '1';
// The nightly rest and recipient-hours holds depend on the wall clock; tests must not.
process.env.WHATSAPP_SENDER_FAST ||= '1';
