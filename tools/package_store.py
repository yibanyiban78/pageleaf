"""Build a Chrome Web Store upload ZIP, distinct from the historical unpack-and-load kits."""
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / 'extension'
# Only reviewed runtime files. A surprise file in the extension is a build error,
# rather than something to ship because its extension happens to be .json or .js.
FILES = frozenset('''manifest.json archive.js background.js extract.js job.html job.js
network.js popup.css popup.html popup.js preview.js settings.html settings.js
store.js vault.js style.css video-preview.js video.js icons/16.png icons/32.png
icons/48.png icons/128.png'''.split())


def build():
    paths = list(EXTENSION.rglob('*'))
    if any(p.is_symlink() or p.resolve() != EXTENSION / p.relative_to(EXTENSION) for p in paths):
        raise ValueError('Unexpected link in extension directory')
    names = {p.relative_to(EXTENSION).as_posix() for p in paths if p.is_file()}
    if names != FILES:
        raise ValueError(f'Unexpected or missing runtime files: {sorted(names ^ FILES)}')
    # The public project is distributed under MIT: include the notice
    # in copies of the runtime as well as in source checkouts.
    entries = {name: path.read_bytes() for name, path in sorted(
        [(name, EXTENSION / name) for name in FILES] + [('LICENSE', ROOT / 'LICENSE')])}
    manifest = json.loads(entries['manifest.json'])
    version = manifest['version']
    if manifest['manifest_version'] != 3 or version != json.loads((ROOT / 'package.json').read_bytes())['version']:
        raise ValueError('Manifest/project version mismatch')
    if any(field in manifest for field in ('key', 'update_url', 'host_permissions')):
        raise ValueError('Unexpected identity, update host or required host permissions')
    if any(b'not-a-real-key-pageleaf-fixture' in body or b'-----BEGIN PRIVATE KEY' in body for body in entries.values()):
        raise ValueError('Credential or test fixture in runtime files')
    buf = BytesIO()
    with ZipFile(buf, 'w') as archive:
        for name, body in entries.items():
            info = ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = ZIP_DEFLATED
            archive.writestr(info, body)
    payload = buf.getvalue()
    with ZipFile(BytesIO(payload)) as archive:
        if archive.namelist() != list(entries) or archive.testzip() or any(archive.read(n) != b for n, b in entries.items()):
            raise ValueError('ZIP contents failed readback')
    dest = ROOT / 'release' / f'pageleaf-cws-{version}.zip'
    dest.parent.mkdir(exist_ok=True)
    try:
        with dest.open('xb') as f:
            f.write(payload)
    except FileExistsError:
        if dest.read_bytes() != payload:
            raise ValueError('Different ZIP already exists; do not overwrite a versioned release')
    print(f'{dest.name} | {len(entries)} files (runtime + license) | {len(payload)} bytes | SHA-256 {sha256(payload).hexdigest()}')


if __name__ == '__main__':
    build()
