/**
 * PM2 Process Configuration for Express Backend (Production)
 * Run: pm2 start ecosystem.config.cjs
 * Reload: pm2 reload ecosystem.config.cjs
 */
module.exports = {
  apps: [
    {
      name: 'store-backend',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      watch: false,
      kill_timeout: 5000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
