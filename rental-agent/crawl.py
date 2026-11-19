"""Stage 1: crawl OnTheMarket area pages (path-only URLs, per robots.txt), filter, route, fetch details."""
import json, math, re, sys, time, urllib.request, os
HERE = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(HERE, "config.json")))
DATA = os.path.join(HERE, "data")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
BASE = "https://www.onthemarket.com"

def get(url, tries=5):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:
            err = e
            time.sleep(4 * (i + 1))
    print("FAILED", url, err, file=sys.stderr)
    return None

def state(html):
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    return json.loads(m.group(1))["props"]["pageProps"]["initialReduxState"]

def km(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = math.sin((lat2-lat1)*p/2)**2 + math.cos(lat1*p)*math.cos(lat2*p)*math.sin((lon2-lon1)*p/2)**2
    return 12742 * math.asin(math.sqrt(a))

def pcm(s):
    m = re.search(r"£([\d,]+)\s*pcm", s or "")
    return int(m.group(1).replace(",", "")) if m else None

def crawl():
    seen = {}
    for area in CFG["areas"]:
        url = f"{BASE}/to-rent/{CFG['beds']}-bed-property/{area}/"
        pages = 0
        while url and pages < 40:
            html = get(url); time.sleep(1.1)
            if not html: break
            try: r = state(html)["results"]
            except Exception as e:
                print("parse fail", url, e, file=sys.stderr); break
            for it in r["list"]:
                seen.setdefault(it["id"], it)
            nxt = (r.get("paginationControls") or {}).get("next")
            url = BASE + nxt["next-link"] if nxt and nxt.get("next-link") else None
            pages += 1
        print(area, "pages", pages, "total unique", len(seen), flush=True)
    json.dump(list(seen.values()), open(os.path.join(DATA, "raw_search.json"), "w"))
    return list(seen.values())

def filt(items):
    o = CFG["origin"]; lo, hi = CFG["outer_band"]; out = []; stats = {"crawled": len(items)}
    for it in items:
        price = pcm(it.get("price")); loc = it.get("location") or {}
        if it.get("bedrooms") != CFG["beds"] or not price or not loc.get("lat"): continue
        if not (lo <= price <= hi): continue
        stats["in_price"] = stats.get("in_price", 0) + 1
        if (it.get("bathrooms") or 0) < CFG["min_baths"]: continue
        stats["baths_ok"] = stats.get("baths_ok", 0) + 1
        if any("short let" in f.lower() for f in it.get("features") or []): continue
        d = km(o["lat"], o["lon"], loc["lat"], loc["lon"])
        if d > CFG["prefilter_km"]: continue
        stats["near"] = stats.get("near", 0) + 1
        out.append({"id": it["id"], "price": price, "lat": loc["lat"], "lon": loc["lon"], "crow_km": round(d, 2),
                    "address": it.get("address"), "baths": it.get("bathrooms"), "type": it.get("humanised-property-type"),
                    "agent": (it.get("agent") or {}).get("name"), "added": it.get("days-since-added-reduced"),
                    "url": BASE + it["details-url"], "thumbs": [i["default"] for i in it.get("images") or []]})
    return out, stats

def route(c):
    o = CFG["origin"]
    u = f"https://routing.openstreetmap.de/routed-foot/route/v1/foot/{c['lon']},{c['lat']};{o['lon']},{o['lat']}?overview=false"
    t = get(u); time.sleep(0.6)
    if not t: return None
    r = json.loads(t)["routes"][0]
    return r["distance"]

def detail(c):
    html = get(c["url"]); time.sleep(1.1)
    if not html: return False
    p = state(html)["property"]
    txt = re.sub(r"<[^>]+>", " ", p.get("description") or "")
    c["description"] = re.sub(r"\s+", " ", txt).strip()
    c["features"] = [f["feature"] for f in p.get("features") or []]
    c["letting"] = (p.get("lettingDetails") or {}).get("items") or []
    c["key_info"] = {k["title"]: k.get("value") for k in p.get("keyInfo") or [] if k.get("value")}
    sq = p.get("minimumAreaSqFt") or 0
    c["sqft"] = sq if sq and sq > 200 else None
    c["photos"] = [i["prefix"] + "-480x320." + i.get("ext", "jpg") for i in p.get("images") or []]
    c["floorplans"] = [f.get("largeUrl") for f in p.get("floorplans") or []]
    c["stations"] = [s.get("name") for s in (p.get("station") or [])[:2]]
    c["postcode"] = None
    try: c["postcode"] = json.loads(p["headerData"]["dataLayer"]).get("postcode")
    except Exception: pass
    c["baths"] = p.get("bathrooms") or c["baths"]
    return True

if __name__ == "__main__":
    raw_path = os.path.join(DATA, "raw_search.json")
    items = json.load(open(raw_path)) if "--reuse" in sys.argv and os.path.exists(raw_path) else crawl()
    cands, stats = filt(items)
    kept = []
    for c in cands:
        dist = route(c)
        if dist is None: continue
        # routed distance at 4.8 km/h (the router's own foot speed is slower than a normal walk)
        c["walk_m"] = round(dist); c["walk_min"] = round(dist / 80.0, 1)
        if c["walk_min"] <= CFG["max_walk_min"]: kept.append(c)
    stats["walk_ok"] = len(kept)
    final = []
    for c in kept:
        if not detail(c): continue
        blob = " ".join(c["letting"] + c["features"]).lower()
        if "short term let" in blob or "short let" in blob: continue
        final.append(c)
    # same flat listed by several agents: same rounded position and price
    ded = {}
    for c in final:
        k = (round(c["lat"], 4), round(c["lon"], 4), c["price"])
        if k in ded: ded[k].setdefault("also", []).append({"agent": c["agent"], "url": c["url"]})
        else: ded[k] = c
    final = list(ded.values()); stats["final"] = len(final)
    json.dump(final, open(os.path.join(DATA, "candidates.json"), "w"), indent=1)
    json.dump(stats, open(os.path.join(DATA, "run_stats.json"), "w"), indent=1)
    print(stats)
