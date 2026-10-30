import {networkInterfaces} from 'node:os';

// Opt-in LAN test mode. npm start keeps its existing loopback-only default.
process.env.ORDER_HUB_HOST = '0.0.0.0';
await import('./server.mjs');
const port = Number(process.env.ORDER_HUB_PORT) || 4318;
console.log(`本机访问：http://127.0.0.1:${port}/`);
for (const entries of Object.values(networkInterfaces())) {
  for (const entry of entries || []) {
    if (entry.family === 'IPv4' && !entry.internal) console.log(`局域网测试地址：http://${entry.address}:${port}/`);
  }
}
