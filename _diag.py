import paramiko, json
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('192.168.100.88', username='root', password='sunshi523', timeout=10)

stdin, stdout, stderr = ssh.exec_command("curl -s http://localhost:8787/api/merged-channels")
d = json.loads(stdout.read().decode('utf-8', errors='replace'))

# 统计每个 sourceName 的频道数
from collections import Counter
c = Counter()
for ch in d['channels']:
    for s in ch.get('sources', []):
        c[s['sourceName']] += 1

print('=== 各来源频道数 ===')
for name, count in c.most_common():
    print(f'  {count:3d} | {name}')

# 同时看看 sources 结构有没有异常
print(f'\n=== 检查 source 字段 ===')
bad = 0
for ch in d['channels']:
    for s in ch.get('sources', []):
        if not s.get('sourceName'):
            bad += 1
print(f'sourceName 缺失: {bad} 处')
print(f'总频道: {d["total"]}, 带 sources 的: {sum(1 for ch in d["channels"] if ch.get("sources"))}')

ssh.close()
