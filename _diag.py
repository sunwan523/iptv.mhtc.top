import paramiko
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('192.168.100.88', username='root', password='sunshi523', timeout=10)

# 看 88 上 running 容器的 VERSION 和 CONFIG.BLOCKED_GROUP_PATTERNS
stdin, stdout, stderr = ssh.exec_command("docker logs --tail 30 iptv-local 2>&1")
print('=== 容器最近日志 ===')
print(stdout.read().decode('utf-8', errors='replace'))

# 直接 curl playlist/1.m3u 看 EXTINF 分组
stdin, stdout, stderr = ssh.exec_command("curl -s http://localhost:8787/playlist/1.m3u")
m3u = stdout.read().decode('utf-8', errors='replace')
lines = m3u.split('\n')
extinf_count = sum(1 for l in lines if l.startswith('#EXTINF'))
print(f'\n=== playlist/1.m3u ===')
print(f'总行数: {len(lines)}, EXTINF数: {extinf_count}')

# 看还有没有"体育"相关
sports = [l for l in lines if '体育' in l]
print(f'含"体育"的行: {len(sports)}')
if sports:
    for s in sports[:10]:
        print(f'  {s}')

# 看 group-title 统计
import re
groups = {}
for l in lines:
    m = re.search(r'group-title="([^"]*)"', l)
    if m:
        g = m.group(1)
        groups[g] = groups.get(g, 0) + 1
print(f'\n=== group-title 分布 ===')
for g, c in sorted(groups.items()):
    print(f'  {c:4d} | {g}')

# 也看一下 API 返回的 merged-channels（不是 M3U，是源数据）
stdin, stdout, stderr = ssh.exec_command("curl -s http://localhost:8787/api/merged-channels")
import json
d = json.loads(stdout.read().decode('utf-8', errors='replace'))
print(f'\n=== /api/merged-channels 总数: {d["total"]} ===')
# 看体育分组在 API 里是否存在
for c in d['channels']:
    if '体育' in c['group']:
        print(f'  [API 源数据存在] group={c["group"]}, name={c["name"]}')
        break  # 只要一个样例确认

ssh.close()
