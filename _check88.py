import paramiko
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('192.168.100.88', username='root', password='sunshi523', timeout=10)

stdin, stdout, stderr = ssh.exec_command("curl -s http://localhost:8787/api/merged-channels")
raw = stdout.read().decode('utf-8', errors='replace')
import json
d = json.loads(raw)

cats = {}
for c in d['channels']:
    cats[c['group']] = cats.get(c['group'], 0) + 1

print('=== 所有分类及数量 ===')
for k, v in sorted(cats.items()):
    print(f'{v:4d} | {k}')

print('\n=== 体育相关 (name或group包含"体育") ===')
for c in d['channels']:
    if '体育' in c['group'] or '体育' in c['name'] or '赛事' in c['group'] or '赛事' in c['name']:
        print(f"  [{c['group']}] {c['name']} ({c['urlCount']}源)")

ssh.close()
