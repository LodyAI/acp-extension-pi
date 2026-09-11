const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createServer } = require('node:net');
const { join } = require('node:path');
const native = require(process.env.PROOF_MODULE);

async function scenario(name, enabled, target, nested = false) {
  const records = new Map();
  let ready;
  const allReady = new Promise(resolve => ready = resolve);
  const expected = nested ? 5 : 3;
  const server = createServer(socket => {
    let buffer = '';
    socket.on('data', data => {
      buffer += String(data);
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      const record = JSON.parse(buffer.slice(0, index));
      records.set(record.role, { ...record, socket });
      if (records.size === expected) ready();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const parent = spawn(process.execPath, [join(__dirname, 'ancestry.cjs'), nested ? 'host' : 'adapter'], {
    env: { ...process.env, PROOF_JOB: enabled ? '1' : '0', PROOF_PORT: String(server.address().port) },
    stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true,
  });
  const timeout = setTimeout(() => { console.error('Timed out:', name); parent.kill(); process.exit(1); }, 15000);
  try {
    await allReady;
    const chosen = records.get(target === 'normal' ? 'adapter' : target);
    if (target === 'normal') chosen.socket.write('exit\n');
    else process.kill(chosen.pid, 'SIGKILL');
    assert.ok(native.exited(records.get('adapter').pid, 5000), 'adapter exit');
    for (const role of ['root', 'leaf'])
      assert.equal(native.exited(records.get(role).pid, enabled ? 5000 : 0), enabled, `${name}: ${role}`);
    if (nested) {
      assert.equal(native.exited(records.get('host').pid, 0), false, 'host survives inner Job');
      assert.equal(native.exited(records.get('sibling').pid, 0), false, 'sibling survives inner Job');
      records.get('host').socket.write('exit\n');
      assert.ok(native.exited(records.get('host').pid, 5000));
      assert.ok(native.exited(records.get('sibling').pid, 5000));
    }
    console.log('PASS', name);
  } finally {
    clearTimeout(timeout);
    for (const {pid, socket} of records.values()) {
      if (!native.exited(pid, 0)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      socket.destroy();
    }
    server.close();
  }
}
(async () => {
  await scenario('baseline: descendants survive adapter exit', false, 'normal');
  await scenario('Job: normal adapter exit cleans descendants', true, 'normal');
  await scenario('Job: abrupt adapter death cleans descendants', true, 'adapter');
  await scenario('Job: root crash then adapter exit cleans leaf', true, 'root');
  await scenario('nested Job: inner exit preserves host and sibling', true, 'adapter', true);
})().catch(error => { console.error(error); process.exitCode = 1; });
