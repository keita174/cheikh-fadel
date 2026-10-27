"""Exporte les couches cartographiques en GeoJSON, pour servir sur GitHub Pages.

GitHub Pages ne fait pas tourner PHP : les endpoints `api/*.php` renvoient une
erreur 404. Le frontend (`js/data-manager.js`) cherche alors dans l'ordre :

    ENDPOINTS.communes = ['../api/COM_FR.php', 'api/com_fr.php', '../api/commune.php']
    ENDPOINTS.hopitaux = ['../api/hopitaux.php', '../api/hospital_etablissements.php']

Ce script produit des fichiers statiques portant les mêmes noms de ressources
(`api/COM_FR.geojson`, `api/hopitaux.geojson`) que le frontend pourra consommer
directement, sans PHP. Ils doivent rester sous 100 Mo chacun.

    python scripts/exporter_geojson_statique.py
"""

from __future__ import annotations

import json
import re
from decimal import Decimal
from pathlib import Path

import psycopg2
from shapely import wkt
from shapely.geometry import mapping

ROOT = Path(__file__).resolve().parent.parent
API = ROOT / "api"


def php_val(nom: str) -> str:
    m = re.search(rf"\${nom}\s*=\s*(?:'([^']*)'|\"([^\"]*)\"|([^;\s]+))", (API / "config.php").read_text(encoding="utf-8"))
    if not m:
        raise SystemExit(f"${nom} absent de api/config.php")
    return next(g for g in m.groups() if g is not None)


def exporter_hopitaux() -> None:
    conn = psycopg2.connect(
        host=php_val("host"), dbname=php_val("dbname"), user=php_val("dbuser"),
        password=php_val("dbpass"), port=int(php_val("port")))
    cur = conn.cursor()
    cur.execute("""
        SELECT h.id, h.name, h.amenity, h.emergency, h.capacity, h.wheelchair, h.operator,
               h."addr-housenumber", h."addr-street", h."addr-city", h."addr-postcode",
               h.phone, h."contact-phone", h."ref-FR-FINESS", h."healthcare-speciality",
               h.lon, h.lat,
               c.nom AS commune_nom, c.code_insee AS commune_code, c.code_dep AS commune_dep,
               c.code_reg AS commune_reg, c.type_com AS commune_type
        FROM public.hospitals_france h
        LEFT JOIN LATERAL (
            SELECT c.nom, c.code_insee, c.code_dep, c.code_reg, c.type_com
            FROM public."COM_FR" c
            WHERE c.geom && ST_SetSRID(ST_MakePoint(h.lon, h.lat), 4326)
              AND ST_Contains(c.geom, ST_SetSRID(ST_MakePoint(h.lon, h.lat), 4326))
            LIMIT 1
        ) c ON TRUE
        ORDER BY h.id ASC
    """)
    cols = [d[0] for d in cur.description]
    rows = cur.fetchall()
    feats = []
    for r in rows:
        d = dict(zip(cols, r))
        lon = d.get("lon"); lat = d.get("lat")
        geom = {"type": "Point", "coordinates": [lon, lat]} if lon and lat else None
        props = {k: v for k, v in d.items() if v is not None}
        feats.append({"type": "Feature", "geometry": geom, "properties": props})
    conn.close()
    out = API / "hopitaux.geojson"
    out.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False, default=lambda o: float(o) if isinstance(o, Decimal) else str(o)), encoding="utf-8")
    print(f"hopitaux -> {out} : {len(feats)} features")


def exporter_communes(simplif: float = 0.002) -> None:
    conn = psycopg2.connect(
        host=php_val("host"), dbname=php_val("dbname"), user=php_val("dbuser"),
        password=php_val("dbpass"), port=int(php_val("port")))
    cur = conn.cursor()
    cur.execute("""
        SELECT code_insee, nom, code_dep, code_reg, population, type_com, ST_AsText(geom) AS geom
        FROM public."COM_FR"
        ORDER BY code_insee
    """)
    cols = [d[0] for d in cur.description]
    rows = cur.fetchall()
    feats = []
    for r in rows:
        d = dict(zip(cols, r))
        if not d.get("geom"):
            continue
        g = wkt.loads(d["geom"])
        if g.is_empty:
            continue
        g = g.simplify(simplif, preserve_topology=True)
        feats.append({
            "type": "Feature",
            "geometry": mapping(g),
            "properties": {
                "code_insee": d.get("code_insee") or "",
                "nom": d.get("nom") or "",
                "code_dep": d.get("code_dep"),
                "code_reg": d.get("code_reg"),
                "population": d.get("population"),
                "type_com": d.get("type_com"),
            },
        })
    conn.close()
    out = API / "COM_FR.geojson"
    out.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False, default=lambda o: float(o) if isinstance(o, Decimal) else str(o)), encoding="utf-8")
    print(f"communes -> {out} : {len(feats)} features (simplif={simplif})")


if __name__ == "__main__":
    exporter_hopitaux()
    exporter_communes(0.005)
