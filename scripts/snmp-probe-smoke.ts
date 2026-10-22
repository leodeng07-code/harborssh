import { spawn } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { snmpFixture } from '../tests/snmp-fixture';

const fixture = await snmpFixture(), blackhole = dgram.createSocket('udp4');
await new Promise<void>(resolve => blackhole.bind(0, '127.0.0.1', resolve));
async function probe(port: number, extended = false) {
  const filename = path.resolve('assets/Test-HarborSnmp.ps1').replace(/'/g, "''");
  const command = `& '${filename}' -ComputerName '127.0.0.1' -Port ${port} -TimeoutMs 500 -Attempts 1 ${extended ? '-Extended -MaxRepetitions 30' : ''} -Community (ConvertTo-SecureString 'fixture-read' -AsPlainText -Force)`;
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.env.PWSH_BINARY || 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', command]); let output = '';
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    child.once('error', reject); child.once('exit', code => resolve({ code, output }));
  });
}
try {
  const success = await probe(fixture.port); assert.equal(success.code, 0, success.output);
  assert.equal((success.output.match(/PASS: response/g) || []).length, 3, success.output); assert.match(success.output, /GE|1\.3\.6\.1\.2\.1\.2\.2\.1\.1\.101/);
  assert.ok(!success.output.includes('fixture-read')); assert.equal(fixture.writes.length, 0);
  const extended = await probe(fixture.port, true); assert.equal(extended.code, 0, extended.output); assert.equal((extended.output.match(/PASS: response/g) || []).length, 6, extended.output); assert.ok(!extended.output.includes('fixture-read'));
  const failure = await probe((blackhole.address() as { port: number }).port); assert.equal(failure.code, 1, failure.output);
  assert.ok(!failure.output.includes('PASS: response') && !failure.output.includes('fixture-read'), failure.output);
  console.log('PowerShell read-only SNMP probe verified on real local UDP: single GET, Harbor system GET, small GETBULK, binding decode, request correlation, no SET, timeout failure and no community in output.');
} finally { await fixture.close(); await new Promise<void>(resolve => blackhole.close(resolve)); }
