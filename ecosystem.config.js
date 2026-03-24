// PM2 process manager config
// Usage:
//   pm2 start ecosystem.config.js          # start / restart
//   pm2 stop ecosystem.config.js           # stop
//   pm2 delete ecosystem.config.js         # remove from PM2 list
//   pm2 save                               # persist current process list across reboots
//   pm2 startup                            # configure OS service (Linux/macOS)

module.exports = {
  apps: [
    {
      name:    'dj-server',
      script:  './server.js',

      // Never spawn more than 1 — the server is stateful (WebSockets, FFmpeg, audio)
      instances:  1,
      exec_mode:  'fork',

      autorestart: true,
      watch:       false,   // don't watch files in production

      // Restart if RSS exceeds 512 MB (e.g. FFmpeg memory leak)
      max_memory_restart: '512M',

      // Logs — directory must exist; PM2 creates files automatically
      out_file:        './logs/out.log',
      error_file:      './logs/err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs:      true,

      // Rotate logs once they exceed 10 MB (requires pm2-logrotate module)
      // pm2 install pm2-logrotate

      // Graceful shutdown — wait up to 8 s for SIGTERM handler in server.js
      kill_timeout: 10000,

      // Production environment — .env file is loaded by server.js via dotenv
      env: {
        NODE_ENV: 'production',
      },

      // Development override: pm2 start ecosystem.config.js --env development
      env_development: {
        NODE_ENV: 'development',
        PORT:     3000,
      },
    },
  ],
};
