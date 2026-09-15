"""SPDX-License-Identifier: AGPL-3.0-only. Print paths/types only, never matches."""
import argparse
import json
from pathlib import Path
import re
import subprocess

p = argparse.ArgumentParser()
p.add_argument('--private-prompt', required=True)
p.add_argument('--env-file', required=True)
p.add_argument('--tree')
p.add_argument('--history', action='store_true')
a = p.parse_args()
repo = Path(__file__).resolve().parents[2]
private = Path(a.private_prompt).read_text(encoding='utf-8-sig')
section = private.split('三、本轮用户指定的新访问码',1)[1].split('这些值',1)[0]
secrets = []
for line in section.splitlines():
    line = re.sub(r'^\s*\d+[.)、]\s*', '', line).strip().strip('`"\'')
    if re.fullmatch(r'[A-Za-z0-9_-]{4,100}', line):
        secrets.append(line.encode())
if len(secrets) != 3:
    raise SystemExit('Private access-code input could not be recognized safely')
for line in Path(a.env_file).read_text(encoding='utf-8-sig').splitlines():
    if '=' not in line or line.lstrip().startswith('#'): continue
    key,value = line.split('=',1)
    if re.search(r'KEY|TOKEN|SECRET',key):
        value=value.strip().strip('"\'')
        if len(value)>=4: secrets.append(value.encode())
patterns = [(b'AIza[0-9A-Za-z_-]{35}', 'google-key'),
            (b'gh[pousr]_[0-9A-Za-z]{30,}', 'github-token'),
            (b'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----', 'private-key')]
findings=[]
def inspect(data,label,generic=True):
    text_like = b'\0' not in data[:8192]
    if any((secret in data if len(secret)>=12 else
            text_like and re.search(rb'(?<![A-Za-z0-9_])'+re.escape(secret)+rb'(?![A-Za-z0-9_])',data))
           for secret in secrets): findings.append((label,'known-private-credential'))
    if generic:
        for pattern,kind in patterns:
            if re.search(pattern,data): findings.append((label,kind))

if a.tree:
    root=Path(a.tree)
    for path in root.rglob('*'):
        if path.is_file():
            # Upstream source tests can contain public synthetic key fixtures.
            generic=not any(x in path.parts for x in ('vendor','upstream'))
            inspect(path.read_bytes(),path.relative_to(root).as_posix(),generic)
else:
    paths=subprocess.check_output(['git','ls-files','-z'],cwd=repo).decode().split('\0')
    for name in filter(None,paths):
        path=repo/name
        if path.is_file(): inspect(path.read_bytes(),name)
if a.history:
    objects=subprocess.check_output(['git','rev-list','--objects','--all'],cwd=repo).splitlines()
    for row in objects:
        fields=row.split(b' ',1)
        oid=fields[0].decode()
        kind=subprocess.check_output(['git','cat-file','-t',oid],cwd=repo).strip()
        if kind==b'blob':
            data=subprocess.check_output(['git','cat-file','blob',oid],cwd=repo)
            label=fields[1].decode(errors='replace') if len(fields)>1 else oid
            inspect(data,'history:'+label)
print(json.dumps(dict(findings=sorted(set(findings)),count=len(findings),
                     shortCodeScan='text whole-token only; binary short-byte collisions are not meaningful'),ensure_ascii=False))
raise SystemExit(1 if findings else 0)
