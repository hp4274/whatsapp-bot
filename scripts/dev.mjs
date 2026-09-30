import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const children = [
    spawn(npm, ['--prefix', 'server', 'run', 'dev'], { stdio: 'inherit' }),
    spawn(npm, ['--prefix', 'web', 'start'], { stdio: 'inherit' }),
];

let shuttingDown = false;

function stopAll(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
        if (!child.killed) child.kill(signal);
    }
}

for (const child of children) {
    child.on('exit', (code, signal) => {
        if (!shuttingDown) {
            stopAll(signal ?? 'SIGTERM');
            process.exitCode = code ?? 1;
        }
    });
}

process.on('SIGINT', () => stopAll('SIGINT'));
process.on('SIGTERM', () => stopAll('SIGTERM'));
