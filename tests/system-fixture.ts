export const systemSample = (step = 0) => `__HARBOR_SYS_V1__
[host]
fixture-linux
[kernel]
6.8.0-fixture
[release]
PRETTY_NAME="Ubuntu 24.04 LTS"
[uptime]
${1000 + step * 5}.00 500.00
[load]
0.50 0.20 0.10 1/200 1234
[cores]
4
[cpu]
cpu ${100 + step * 30} 0 100 ${800 + step * 50} ${step * 20} 0 0 0 ${90 + step * 20} 0
[memory]
MemTotal: 8388608 kB
MemFree: 1048576 kB
MemAvailable: 5242880 kB
Buffers: 100 kB
Cached: 200 kB
SwapTotal: 2097152 kB
SwapFree: 1048576 kB
[network]
Inter-| Receive | Transmit
 eth0: ${10000 + step * 5120} 1 0 0 0 0 0 0 ${20000 + step * 10240} 1 0 0 0 0 0 0
 lo: 500 1 0 0 0 0 0 0 500 1 0 0 0 0 0 0
[disk]
Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/vda1 104857600 52428800 47185920 53% /
/dev/vdb1 1000 100 900 10% /data\\040store
[end]
`;
