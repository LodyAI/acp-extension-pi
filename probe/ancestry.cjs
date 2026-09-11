const { spawn } = require('node:child_process');
const net = require('node:net');
const role = process.argv[2];
if ((role === 'adapter' || role === 'host') && process.env.PROOF_JOB === '1')
  require(process.env.PROOF_MODULE).join();
const socket = net.connect(Number(process.env.PROOF_PORT), '127.0.0.1', () => {
  socket.write(JSON.stringify({ role, pid: process.pid }) + '\n');
});
socket.on('data', data => { if (String(data).trim() === 'exit') process.exit(0); });
const child = next => spawn(process.execPath, [__filename, next], { stdio: 'ignore', windowsHide: true });
if (role === 'adapter') child('root').once('exit', () => process.exit(0));
if (role === 'root') child('leaf');
if (role === 'host') { child('adapter'); child('sibling'); }
