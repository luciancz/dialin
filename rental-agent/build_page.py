"""Stage 4: render site/index.html from the template and data/listings.json."""
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
d = json.load(open(os.path.join(HERE, "data", "listings.json")))
keep = ["id","price","expected","discount","discount_why","lat","lon","address","baths","agent","added","url","walk_min","sqft","sqft_est","ppsf",
        "niceness","value","overall","predicted","scores","note","flags","furnished","tier","negotiable_only","source"]
d["listings"] = [{k: c.get(k) for k in keep} for c in d["listings"]]
d["config"] = {"origin": d["config"]["origin"]}
bm = json.load(open(os.path.join(HERE, "data", "basemap.json")))
t = open(os.path.join(HERE, "template.html")).read()
t = t.replace("/*DATA*/null", json.dumps(d).replace("</", "<\\/")).replace("/*BASEMAP*/null", json.dumps(bm))
open(os.path.join(HERE, "site", "index.html"), "w").write(t)
print("wrote", len(t))
