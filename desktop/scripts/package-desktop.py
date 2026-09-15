"""SPDX-License-Identifier: AGPL-3.0-only. Package explicit inputs; never clean or overwrite."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import zipfile

p = argparse.ArgumentParser()
p.add_argument('--output', required=True)
p.add_argument('--runtime', required=True)
p.add_argument('--downloads', required=True)
p.add_argument('--vendor', required=True)
a = p.parse_args()
def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b''):
            digest.update(chunk)
    return digest.hexdigest()
repo = Path(__file__).resolve().parents[2]
out = Path(a.output).resolve()
if out.exists():
    raise SystemExit('Output must not exist; existing releases are preserved')
out.mkdir(parents=True)
binary = out / 'Orange-Desktop-Windows-x64'
source = out / 'Orange-Desktop-Source'
binary.mkdir(); source.mkdir()

def copy(src, dst):
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)

desktop = repo/'desktop'
copy(desktop/'src-tauri/target/release/Orange翻译.exe', binary/'Orange翻译.exe')
shutil.copytree(desktop/'src-tauri/resources/dictionary', binary/'dictionary')
shutil.copytree(Path(a.runtime), binary/'helpers/wps-pdf',
                ignore=shutil.ignore_patterns('*.pdb','__pycache__','*.pyc','WpsPdfHelper.exe'))
for name in ['LICENSE.txt','LICENSING.md']:
    copy(desktop/name, binary/name)
copy(desktop/'PORTABLE-README.txt', binary/'使用说明.txt')

# Only tracked/staged Desktop inputs: no working tree experiments, credentials or logs.
tracked = subprocess.check_output(['git','ls-files','-z','desktop'], cwd=repo).decode().split('\0')
for relative in filter(None, tracked):
    path = repo/relative
    if path.is_file():
        copy(path, source/relative)
vendor = Path(a.vendor).resolve()
shutil.copytree(vendor, source/'vendor')
# Offline crates configuration is relative, not tied to the packager's home.
config = source/'desktop/src-tauri/.cargo/config.toml'
config.parent.mkdir(parents=True, exist_ok=True)
config.write_text('[source.crates-io]\nreplace-with = "vendored-sources"\n'
                  '[source.vendored-sources]\ndirectory = "../../vendor"\n', encoding='utf-8')
for name in ['pymupdf-1.28.2.tar.gz','mupdf-1.28.2-source.tar.gz']:
    copy(Path(a.downloads)/name, source/'upstream'/name)
shutil.copytree(desktop/'node_modules/@tauri-apps/api', source/'upstream/tauri-apps-api')

# Preserve Rust dependency license/copyright material in the binary distribution.
for path in vendor.rglob('*'):
    if path.is_file() and any(x in path.name.lower() for x in ['license','licence','copying','notice','copyright']):
        copy(path, binary/'licenses/rust'/path.relative_to(vendor))
for name in ['LICENSE_APACHE-2.0','LICENSE_MIT']:
    path = desktop/'node_modules/@tauri-apps/api'/name
    if path.exists(): copy(path, binary/'licenses/tauri-api'/name)
# MuPDF fonts and thirdparty code carry additional notices, not just AGPL.
with tarfile.open(Path(a.downloads)/'mupdf-1.28.2-source.tar.gz') as archive:
    for member in archive.getmembers():
        path = Path(member.name)
        if member.isfile() and any(x in path.name.lower() for x in ['license','licence','copying','notice','copyright']):
            if path.is_absolute() or '..' in path.parts: raise ValueError('Unsafe archive path')
            target = binary/'licenses/mupdf'/path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.extractfile(member).read())

revision = subprocess.check_output(['git','rev-parse','HEAD'], cwd=repo, text=True).strip()
for root in [binary, source]:
    records = []
    for path in sorted(root.rglob('*')):
        if path.is_file():
            records.append(dict(path=path.relative_to(root).as_posix(), size=path.stat().st_size,
                                sha256=sha256(path)))
    (root/'FILE-MANIFEST.json').write_text(json.dumps(dict(revision=revision,files=records),ensure_ascii=False,indent=2),encoding='utf-8')
    with zipfile.ZipFile(out/(root.name+'.zip'), 'x', zipfile.ZIP_DEFLATED, compresslevel=6, strict_timestamps=False) as z:
        for path in sorted(root.rglob('*')):
            if path.is_file(): z.write(path, root.name+'/'+path.relative_to(root).as_posix())
print('Binary and matching source archives generated; audit before sharing.')
