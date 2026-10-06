import paramiko, json
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('192.168.100.88', username='root', password='sunshi523', timeout=10)

# 1. 直接 curl playlist 1 看有没有 invalidUrls 字段
i, o, e = ssh.exec_command("curl -s http://localhost:8787/api/playlist/1")
pl1 = json.loads(o.read().decode('utf-8', errors='replace'))
print("=== /api/playlist/1 完整字段 ===")
for k, v in pl1.items():
    if k == 'urls':
        print(f"  {k}: [{len(v)} items]")
    elif k == 'channels':
        print(f"  {k}: [{len(v)} items]")
    else:
        print(f"  {k}: {v}")

# 2. 看 playlist 2
print("\n=== /api/playlist/2 完整字段 ===")
i, o, e = ssh.exec_command("curl -s http://localhost:8787/api/playlist/2")
pl2 = json.loads(o.read().decode('utf-8', errors='replace'))
for k, v in pl2.items():
    if k == 'urls': print(f"  {k}: [{len(v)} items]")
    elif k == 'channels': print(f"  {k}: [{len(v)} items]")
    else: print(f"  {k}: {v}")

# 3. 在运行时 worker.js 里 grep 看有没有 invalidUrls 相关代码
i, o, e = ssh.exec_command("docker exec iptv-local grep -c 'invalidUrls\\|invalidCount\\|validCount' /app/worker.js")
count = o.read().strip()
print(f"\n=== worker.js 里 invalidUrls 相关代码出现次数: {count} ===")

i, o, e = ssh.exec_command("docker exec iptv-local grep -n 'invalidUrls' /app/worker.js")
print(o.read().decode('utf-8', errors='replace'))

# 4. 故意造点失效数据测试
# 从 playlist 1 拿一个真实 URL，直接在 KV 里加一个不存在的 URL
# 先看看 KV 里 playlists 存的是什么结构
i, o, e = ssh.exec_command("docker exec iptv-local cat /app/data/playlists_kv.json")
import os
# 试试直接看 data dir
i, o, e = ssh.exec_command("ls -la /app/data/")
print(f"\n=== data dir ===")
print(o.read().decode('utf-8', errors='replace'))

i, o, e = ssh.exec_command("cat /root/iptv-data/playlists_kv.json 2>/dev/null || find /root/iptv-data -name '*playlist*' -type f")
print(f"\n=== playlist KV 内容 ===")
print(o.read().decode('utf-8', errors='replace')[:500])

ssh.close()
