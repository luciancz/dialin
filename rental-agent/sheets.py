"""Stage 2: download listing photos, build one contact sheet per listing for the niceness review, and page thumbnails."""
import io, json, os, time, urllib.request
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
os.makedirs(os.path.join(DATA, "sheets"), exist_ok=True)
os.makedirs(os.path.join(HERE, "site", "thumbs"), exist_ok=True)
def img(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        return Image.open(io.BytesIO(urllib.request.urlopen(req, timeout=30).read())).convert("RGB")
    except Exception:
        return None
for c in json.load(open(os.path.join(DATA, "candidates.json"))):
    sheet = os.path.join(DATA, "sheets", c["id"] + ".jpg")
    if os.path.exists(sheet): continue
    urls = (c.get("photos") or c.get("thumbs") or [])[:15]
    ims = [i for i in (img(u) for u in urls) if i]
    time.sleep(0.3)
    if not ims: print("no photos", c["id"]); continue
    cols = 5; rows = (len(ims) + cols - 1) // cols
    s = Image.new("RGB", (cols * 400, rows * 267), "white")
    for n, im in enumerate(ims):
        s.paste(im.resize((400, 267)), ((n % cols) * 400, (n // cols) * 267))
    s.save(sheet, quality=80)
    ims[0].resize((360, 240)).save(os.path.join(HERE, "site", "thumbs", c["id"] + ".jpg"), quality=72)
print("done", len(os.listdir(os.path.join(DATA, "sheets"))))
