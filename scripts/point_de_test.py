"""Cherche un point où « l'hôpital le plus proche » et « le plus proche avec
urgences » sont deux établissements différents.

C'est le cas qui justifie les deux entrées du panel « Autour de vous » : si
les deux se confondent toujours, la deuxième entrée ne sert à rien.
"""

import json
import math
import urllib.request

RAYON_TERRE = 6371.0088


def distance(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * RAYON_TERRE * math.asin(math.sqrt(a))


def main():
    url = "http://127.0.0.1/PROJET%20SIG%20AIX/api/hopitaux.php"
    d = json.loads(urllib.request.urlopen(url, timeout=120).read().decode("utf-8"))

    hops = []
    for f in d["features"]:
        p = f["properties"]
        hops.append({
            "nom": p.get("name") or "(sans nom)",
            "lat": p["lat"], "lon": p["lon"],
            "urgence": p.get("emergency") in ("yes", "limited"),
            "commune": p.get("commune_nom"),
        })

    avec = [h for h in hops if h["urgence"]]
    sans = [h for h in hops if not h["urgence"]]
    print(f"{len(hops)} établissements, dont {len(avec)} avec urgences")

    for depart in sans:
        dtous = min(hops, key=lambda h: distance(depart["lat"], depart["lon"], h["lat"], h["lon"]))
        durg = min(avec, key=lambda h: distance(depart["lat"], depart["lon"], h["lat"], h["lon"]))
        d_all = distance(depart["lat"], depart["lon"], dtous["lat"], dtous["lon"]) * 1000
        d_urg = distance(depart["lat"], depart["lon"], durg["lat"], durg["lon"]) * 1000
        if d_urg > 500 and d_urg < 11000:
            print()
            print(f"point de test : {depart['lat']:.6f}, {depart['lon']:.6f}"
                  f"  ({depart['commune']})")
            print(f"  plus proche, tous       : {dtous['nom'][:46]:46s} {d_all:6.0f} m"
                  f"  urgences={dtous['urgence']}")
            print(f"  plus proche, urgences   : {durg['nom'][:46]:46s} {d_urg:6.0f} m")
            return 0

    print("aucun point trouvé : le plus proche a presque toujours des urgences")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())