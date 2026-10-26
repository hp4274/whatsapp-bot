// pm2 process file: `pm2 start ecosystem.config.cjs` (scripts/deploy.sh uses startOrRestart).
// The server exits on an uncaught exception (server/src/index.js); pm2 brings it back with a growing
// delay. Restarts are counted in the `process_restarts` metric only, never in the reconnect brake.
module.exports = {
    apps: [{
        name: 'whatsapp-bot',
        cwd: __dirname,
        script: 'server/src/index.js',
        env: { NODE_ENV: 'production' },
        max_memory_restart: '1G',
        exp_backoff_restart_delay: 200,
        max_restarts: 15,
        min_uptime: '60s',
        kill_timeout: 8000,
    }],
};
