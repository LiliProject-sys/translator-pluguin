"""SPDX-License-Identifier: AGPL-3.0-only. Synthetic PDF, no WPS/user data/network."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path(sys.argv[1]).resolve()
python = root / 'runtime/python/python.exe'
runtime = root / 'runtime/dotnet/dotnet.exe'
env = dict(os.environ)
env.update(PATH='', PYTHONHOME='Z:/absent', PYTHONPATH='Z:/absent',
           ORANGE_WPS_PYTHON='Z:/absent/python.exe', DOTNET_ROOT=str(runtime.parent),
           DOTNET_MULTILEVEL_LOOKUP='0')
with tempfile.TemporaryDirectory(prefix='orange-portable-public-') as temp:
    pdf = Path(temp) / 'public.pdf'
    code = ('import pymupdf,sys; d=pymupdf.open(); p=d.new_page(); '
            'p.insert_text((72,72),"This component is useful."); d.save(sys.argv[1]); d.close()')
    subprocess.run([str(python), '-E', '-s', '-c', code, str(pdf)], env=env, cwd=temp, check=True, timeout=15)
    request = dict(op='resolve', path=str(pdf), identity='synthetic-v1', target='component',
                   count=1, ranges=[[0, 5, 13]],
                   validation=dict(match=True, local='This component is useful.', targetOffset=5))
    result = subprocess.run([str(python), '-E', '-s', '-u', str(root/'python/worker.py')],
                            input=json.dumps(request)+'\n{"op":"exit"}\n', text=True,
                            capture_output=True, env=env, cwd=temp, check=True, timeout=15)
    data = json.loads(result.stdout)
    assert data['ok'] and data['text'] == 'This component is useful.', 'Bundled PDF resolution failed'
    subprocess.run([str(runtime), str(root/'WpsPdfHelper.dll'), '--self-test'],
                   env=env, cwd=temp, check=True, timeout=15)
    subprocess.run([str(runtime), str(root/'WpsPdfHelper.dll'), '--self-test-resolver', str(pdf)],
                   env=env, cwd=temp, check=True, timeout=15)
print('Relocated helper and synthetic PDF resolution passed with empty PATH and poisoned external Python paths.')
