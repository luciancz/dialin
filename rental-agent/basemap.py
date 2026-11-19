"""Stitch a static OpenStreetMap base map around the origin (artifact pages cannot load live tiles)."""
import io, json, math, os, time, urllib.request
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(HERE, "config.json")))
Z = 14
def xy(lat, lon):
    n = 2 ** Z
    return ((lon + 180) / 360 * n, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
o = CFG["origin"]; cx, cy = xy(o["lat"], o["lon"])
span = 3.9 / (40075 * math.cos(math.radians(o["lat"])) / 2 ** Z)  # km -> tiles
x0, x1, y0, y1 = math.floor(cx - span), math.floor(cx + span), math.floor(cy - span), math.floor(cy + span)
img = Image.new("RGB", ((x1 - x0 + 1) * 256, (y1 - y0 + 1) * 256))
for x in range(x0, x1 + 1):
    for y in range(y0, y1 + 1):
        req = urllib.request.Request(f"https://tile.openstreetmap.org/{Z}/{x}/{y}.png", headers={"User-Agent": "imperial-rental-search/1.0 (personal, one-off static map)"})
        img.paste(Image.open(io.BytesIO(urllib.request.urlopen(req, timeout=30).read())).convert("RGB"), ((x - x0) * 256, (y - y0) * 256))
        time.sleep(0.25)
os.makedirs(os.path.join(HERE, "site"), exist_ok=True)
img.save(os.path.join(HERE, "site", "basemap.jpg"), quality=82)
json.dump({"z": Z, "x0": x0, "y0": y0, "w": img.width, "h": img.height}, open(os.path.join(HERE, "data", "basemap.json"), "w"))
print(img.size, x0, y0)
