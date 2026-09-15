# Build Orange Desktop (Windows x64)

The version in package.json is unchanged. Use the matching source archive supplied
with the binary, not a different branch. Keep Cargo.lock and package-lock.json.

Prerequisites: Windows x64, Visual Studio C++ build tools/Windows SDK, Rust stable,
Node.js/npm, .NET 8 SDK. WPS must be installed for WPS PDF capture; WebView2 Runtime
must be installed for the desktop UI. Neither WPS nor WebView2 is bundled here.

From the source root:

```powershell
cd desktop
npm ci
dotnet build helpers/wps-pdf/WpsPdfHelper.csproj -c Release
npm run tauri -- build --no-bundle
cd ..
```

Do not substitute a plain Cargo release build for the Tauri build, which embeds
the frontend. The dictionary files under src-tauri/resources/dictionary must be
present (git lfs pull when obtaining source through Git). They are ECDICT-derived
data with separate notices; no user lexicon belongs in these resources.

Portable packaging is a separate step: see desktop/scripts/prepare-wps-runtime.ps1.
The helper layout is helpers/wps-pdf/WpsPdfHelper.dll, python/*.py,
runtime/dotnet/dotnet.exe and runtime/python/python.exe beside the application.
It deliberately does not use an installed Python or a development checkout.

The existing tested dependency versions are Python 3.10.11, .NET runtime 8.0.7
and PyMuPDF 1.28.2. These are pinned for reproduction, not a claim that they are
the newest security releases. Upgrade and regression review remain separate work.
PyMuPDF matching source is its 1.28.2 sdist plus the matching MuPDF source fetched
by its setup.py; retain both source distributions and build files. Follow that
distribution's setup.py/README for upstream rebuilds.

Verification (no paid API calls):

```powershell
cd desktop/src-tauri
cargo test --offline
cargo test --offline --test local_dictionary_real -- --ignored
cd ..
npm run build
node --test tests/popup-editor.test.cjs
```

The Portable runtime and matching source archives must pass relocation, file
manifest and credential checks before sharing. A successful build alone is not
an end-to-end WPS acceptance test.

Runtime downloads (exact versions, HTTPS; see preparation script for checksums):

- https://www.python.org/ftp/python/3.10.11/python-3.10.11-embed-amd64.zip
- https://pypi.org/project/PyMuPDF/1.28.2/#files (Windows cp310-abi3 win_amd64 wheel)
- https://mupdf.com/downloads/archive/mupdf-1.28.2-source.tar.gz

Example packaging from the source root (paths are examples, use fresh outputs):

```powershell
desktop/scripts/prepare-wps-runtime.ps1 -OutputDirectory release_output/runtime -DownloadDirectory release_output/downloads
python desktop/scripts/test-wps-portable.py release_output/runtime
```

The script takes .NET runtime files from -DotnetDirectory (default Program Files/dotnet),
which must contain 8.0.7. It does not silently upgrade dependencies or download them.
The supplied source archive includes vendored Rust crates and a relative Cargo
configuration; building from Git can instead fetch the versions in Cargo.lock.
Build tools are installed separately. npm ci obtains the pinned frontend packages.
