"""Rightmove source: one radius search around SW7, filter, route, fetch details, merge into data/candidates.json."""
import json, os, re, sys, time
import crawl
from crawl import CFG, DATA, get, km, route
RM = "https://www.rightmove.co.uk"
SEARCH = RM + "/property-to-rent/find.html?locationIdentifier=OUTCODE%5E2520&radius=3.0&minBedrooms=3&maxBedrooms=3&minBathrooms=2&minPrice=3000&maxPrice=5000&sortType=6&dontShow=houseShare%2Cretirement%2Cstudent&index="

def next_data(html):
    return json.loads(re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S).group(1))["props"]["pageProps"]

def search():
    seen = {}; idx = 0; total = None
    while total is None or idx < min(total, 1000):
        html = get(SEARCH + str(idx)); time.sleep(1.2)
        if not html: break
        sr = next_data(html)["searchResults"]
        total = int(str(sr["resultCount"]).replace(",", ""))
        if not sr["properties"]: break
        for p in sr["properties"]: seen.setdefault(p["id"], p)
        idx += 24
    print("rightmove results", total, "unique", len(seen), flush=True)
    return list(seen.values())

def added(p):
    s = p.get("addedOrReduced") or ""; m = re.search(r"(\d\d)/(\d\d)/(\d{4})", s)
    kind = "Reduced" if "educed" in s else "Added"
    if "today" in s: return kind + " today"
    if "yesterday" in s: return kind + " yesterday"
    if not m: return kind
    import datetime
    days = (datetime.date.today() - datetime.date(int(m.group(3)), int(m.group(2)), int(m.group(1)))).days
    return f"{kind} {'< 7 days' if days < 7 else '< 14 days' if days < 14 else '> 14 days'}"

def unflatten(arr):
    """Rightmove ships page data as a flat array where object values are indexes into the array."""
    memo = {}
    def res(i):
        if not isinstance(i, int) or i < 0 or i >= len(arr): return None
        if i in memo: return memo[i]
        v = arr[i]
        if isinstance(v, dict):
            out = memo[i] = {}
            for k, x in v.items(): out[k] = res(x)
            return out
        if isinstance(v, list):
            out = memo[i] = []
            out.extend(res(x) for x in v)
            return out
        return v
    return res(0)

def detail(c):
    html = get(c["url"]); time.sleep(1.2)
    if not html: return False
    try:
        i = html.index("PAGE_MODEL = ") + 13
        model, _ = json.JSONDecoder().raw_decode(html[i:].lstrip())
        pd = unflatten(json.loads(model["data"]))["propertyData"] if "data" in model else model["propertyData"]
    except Exception as e:
        print("detail parse fail", c["url"], e, file=sys.stderr); return False
    txt = re.sub(r"<[^>]+>", " ", (pd.get("text") or {}).get("description") or "")
    c["description"] = re.sub(r"\s+", " ", txt).strip()
    c["features"] = [f.strip() for f in pd.get("keyFeatures") or [] if f]
    L = pd.get("lettings") or {}
    c["letting"] = [f"{k}: {v}" for k, v in L.items() if v not in (None, "")]
    c["let_type"] = L.get("letType")
    c["key_info"] = {}
    sq = [s for s in pd.get("sizings") or [] if s.get("unit") == "sqft"]
    c["sqft"] = int(sq[0]["minimumSize"]) if sq and sq[0].get("minimumSize", 0) > 200 else None
    c["photos"] = [(i.get("resizedImageUrls") or {}).get("size656x437") or i["url"] for i in pd.get("images") or []]
    c["floorplans"] = [f["url"] for f in pd.get("floorplans") or []]
    c["stations"] = [s.get("name") for s in (pd.get("nearestStations") or [])[:2]]
    a = pd.get("address") or {}
    c["postcode"] = (a.get("outcode") or "") + " " + (a.get("incode") or "")
    return True

if __name__ == "__main__":
    o = CFG["origin"]; lo, hi = CFG["outer_band"]; stats = {}
    props = search(); stats["crawled"] = len(props); cands = []
    for p in props:
        price = (p.get("price") or {}); amt = price.get("amount"); loc = p.get("location") or {}
        if price.get("frequency") == "weekly": amt = round(amt * 52 / 12)
        if not amt or not (lo <= amt <= hi) or p.get("bedrooms") != CFG["beds"] or (p.get("bathrooms") or 0) < CFG["min_baths"]: continue
        stats["in_price"] = stats.get("in_price", 0) + 1
        d = km(o["lat"], o["lon"], loc["latitude"], loc["longitude"])
        if d > CFG["prefilter_km"]: continue
        cands.append({"id": "rm" + str(p["id"]), "source": "Rightmove", "price": amt, "lat": loc["latitude"], "lon": loc["longitude"], "crow_km": round(d, 2),
                      "address": p.get("displayAddress"), "baths": p.get("bathrooms"), "type": p.get("propertySubType"),
                      "agent": (p.get("customer") or {}).get("branchDisplayName"), "added": added(p),
                      "url": f"{RM}/properties/{p['id']}", "thumbs": []})
    stats["near"] = len(cands)
    existing = json.load(open(os.path.join(DATA, "candidates.json")))
    for e in existing: e.setdefault("source", "OnTheMarket")
    existing = [e for e in existing if e["source"] != "Rightmove"]
    def dup(c):   # same flat already found on another portal: within ~120 m and same rent
        for e in existing:
            if abs(e["price"] - c["price"]) <= 5 and km(e["lat"], e["lon"], c["lat"], c["lon"]) < 0.12 and e["baths"] == c["baths"]:
                e.setdefault("also", []); 
                if not any(a["url"] == c["url"] for a in e["also"]): e["also"].append({"agent": c["agent"], "url": c["url"]})
                return True
        return False
    new = []
    for c in cands:
        if dup(c): stats["dup_other_portal"] = stats.get("dup_other_portal", 0) + 1; continue
        dist = route(c)
        if dist is None: continue
        c["walk_m"] = round(dist); c["walk_min"] = round(dist / 80.0, 1)
        if c["walk_min"] > CFG["max_walk_min"]: continue
        stats["walk_ok"] = stats.get("walk_ok", 0) + 1
        if not detail(c): continue
        blob = " ".join([c.get("let_type") or ""] + c["features"]).lower()
        if "short" in blob: continue
        k = [n for n in new if abs(n["price"] - c["price"]) <= 5 and km(n["lat"], n["lon"], c["lat"], c["lon"]) < 0.03]
        if k: k[0].setdefault("also", []).append({"agent": c["agent"], "url": c["url"]}); continue
        new.append(c)
    stats["new"] = len(new)
    json.dump(existing + new, open(os.path.join(DATA, "candidates.json"), "w"), indent=1)
    allst = json.load(open(os.path.join(DATA, "run_stats.json")))
    allst["rightmove"] = stats; json.dump(allst, open(os.path.join(DATA, "run_stats.json"), "w"), indent=1)
    print(stats)
    for c in new:
        open(os.path.join(DATA, "review", c["id"] + ".txt"), "w").write(json.dumps({k: c.get(k) for k in ["id","address","postcode","type","price","sqft","features","letting","key_info","description"]}, indent=1))
