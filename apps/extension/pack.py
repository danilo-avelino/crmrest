# Gera o pacote da extensão para a Chrome Web Store e para o download do site (/extensao).
# O pacote sai sem http://localhost:3000 (permissão e origens aceitas), que fica só no código para o desenvolvimento.
# Uso: python apps/extension/pack.py
import json
import re
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SITE = ROOT.parent / "web" / "public" / "extensao"
FILES = ["background.js", "panel.html", "panel.js", "agent-page.js", "widget.js"]
DEV_ORIGIN = ', "http://localhost:3000"'

manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
manifest["host_permissions"].remove("http://localhost:3000/*")
version = manifest["version"]

target = ROOT / "store" / f"dish-desk-extensao-{version}.zip"
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
    zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    for name in FILES:
        text = (ROOT / name).read_text(encoding="utf-8")
        if name in ("panel.js", "widget.js"):
            if text.count(DEV_ORIGIN) != 1:
                raise SystemExit(f"{name}: origem de dev não encontrada")
            text = text.replace(DEV_ORIGIN, "")
        zf.writestr(name, text)
    for icon in sorted((ROOT / "icons").glob("*.png")):
        zf.write(icon, f"icons/{icon.name}")

shutil.copyfile(target, SITE / "dish-desk-extensao.zip")
page = SITE / "index.html"
# Em bytes, para não trocar as quebras de linha do arquivo no Windows.
html, n = re.subn(rb"(<span data-ext-version>)[^<]*(</span>)", rb"\g<1>" + version.encode() + rb"\g<2>", page.read_bytes())
if n == 0:
    raise SystemExit("index.html do site: marcador da versão não encontrado")
page.write_bytes(html)
print(f"{target.relative_to(ROOT.parent.parent)} e o download do site na versão {version}")
