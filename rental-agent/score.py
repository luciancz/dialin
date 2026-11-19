"""Stage 3: merge niceness reviews, estimate negotiated rent, score value, rank, and write data/listings.json."""
import datetime, json, os, re
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
CFG = json.load(open(os.path.join(HERE, "config.json")))
D = CFG["discount"]; W = CFG["niceness_weights"]
cands = json.load(open(os.path.join(DATA, "candidates.json")))
nice = {}
for f in sorted(os.listdir(DATA)):
    if f.startswith("niceness") and f.endswith(".json"):
        for r in json.load(open(os.path.join(DATA, f))): nice[str(r["id"])] = r

def discount(c):
    agent = (c.get("agent") or "").lower(); why = []
    if any(a in agent for a in CFG["large_agents"]): d = D["large_agent"]; why.append("large agent")
    else: d = D["independent_agent"]; why.append("independent agent")
    added = (c.get("added") or "").lower(); text = (c.get("description") or "").lower()
    if "reduced" in added: d += D["reduced"]; why.append("already reduced")
    if "> 14 days" in added: d += D["stale_over_14_days"]; why.append("listed over 2 weeks")
    if "today" in added or "yesterday" in added or "< 7 days" in added: d += D["fresh_under_7_days"]; why.append("new this week")
    if re.search(r"offers? (considered|invited|welcome)|open to offers", text): d += D["offers_invited"]; why.append("offers invited")
    return max(0.0, min(D["cap"], d)), why

def niceness(r):
    tot = 0; wsum = 0
    for k, w in W.items():
        v = (r.get("scores") or {}).get(k)
        if v is None: continue           # not applicable (e.g. unfurnished): weight is redistributed
        tot += w * v; wsum += w
    return round(tot / wsum * 10) if wsum else None

out = []
for c in cands:
    r = nice.get(c["id"])
    if not r: continue
    d, why = discount(c)
    c["discount"] = round(d, 3); c["discount_why"] = why
    c["expected"] = int(round(c["price"] * (1 - d) / 5) * 5)
    c["niceness"] = niceness(r); c["scores"] = r["scores"]; c["note"] = r.get("note"); c["flags"] = r.get("flags") or []
    if not c.get("sqft") and r.get("sqft"): c["sqft"] = r["sqft"]; c["sqft_est"] = True
    c["furnished"] = r.get("furnished")
    out.append(c)

# Value: expected rent vs what the market here charges for this walk, niceness, baths and size.
n = len(out); med_sq = float(np.median([c["sqft"] for c in out if c.get("sqft")] or [1100]))
X = np.array([[1, c["walk_min"], c["niceness"], c["baths"], c.get("sqft") or med_sq] for c in out], float)
y = np.array([c["expected"] for c in out], float)
if n >= 25:
    mu, sd = X[:, 1:].mean(0), X[:, 1:].std(0) + 1e-9
    Z = np.c_[np.ones(n), (X[:, 1:] - mu) / sd]
    beta = np.linalg.solve(Z.T @ Z + np.diag([0, 3, 3, 3, 3]), Z.T @ y)   # light ridge: small sample
    pred = Z @ beta; method = "model"
else:
    pred = np.full(n, np.median(y)); method = "median"
for c, p in zip(out, pred):
    c["predicted"] = int(round(p / 5) * 5)
    c["value"] = int(round(max(0, min(100, 50 + 50 * (p - c["expected"]) / (0.20 * p)))))
    c["ppsf"] = round(c["expected"] * 12 / c["sqft"], 1) if c.get("sqft") else None
    ow = CFG["overall_weights"]
    c["overall"] = round(ow["niceness"] * c["niceness"] + ow["value"] * c["value"])
    lo, hi = CFG["band"]
    asking_in = lo <= c["price"] <= hi
    c["tier"] = "main" if (asking_in or (c["price"] > hi and c["expected"] <= hi)) else "outside"
    c["negotiable_only"] = c["tier"] == "main" and not asking_in
out.sort(key=lambda c: -c["overall"])
stats = json.load(open(os.path.join(DATA, "run_stats.json")))
json.dump({"run_date": datetime.date.today().isoformat(), "value_method": method, "stats": stats, "config": CFG, "listings": out},
          open(os.path.join(DATA, "listings.json"), "w"), indent=1)
print(n, method, "main", sum(c["tier"] == "main" for c in out), "outside", sum(c["tier"] == "outside" for c in out))
