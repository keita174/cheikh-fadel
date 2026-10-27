"""Telechargement des contours ADMIN EXPRESS (IGN) et chargement dans PostgreSQL.

Cree et remplit `public.commune_ign` avec les communes de France metropolitaine,
en WGS84. La table `public."COMMUNE"` existante n'est pas modifiee.

    python scripts/admin_express.py

Source : https://data.geopf.fr/wfs/ows  (ADMINEXPRESS-COG-CARTO.LATEST)
"""

from __future__ import annotations

import io
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

import geopandas as gpd

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "cache"
CACHE.mkdir(exist_ok=True)

WFS = "https://data.geopf.fr/wfs/ows"
NS = "ADMINEXPRESS-COG-CARTO.LATEST"
TABLE = "COM_FR"

PROPS = ["geometrie", "code_insee", "nom_officiel", "code_insee_du_departement",
         "code_insee_de_la_region", "population", "superficie_cadastrale"]

PAGE = 5000  # plafond impose par le service
RETRIES = 4

# Connexion lue dans api/config.php : aucun identifiant n'est recopie ici.
PHP = (ROOT / "api" / "config.php").read_text(encoding="utf-8")


def php_val(nom: str) -> str:
    m = re.search(rf"\${nom}\s*=\s*(?:'([^']*)'|\"([^\"]*)\"|([^;\s]+))", PHP)
    if not m:
        raise SystemExit(f"${nom} absent de api/config.php")
    return next(g for g in m.groups() if g is not None)


def _get(url: str, timeout: int = 600) -> bytes:
    last = None
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "communes-fr/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except (urllib.error.URLError, TimeoutError) as e:  # pragma: no cover
            last = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"echec WFS : {last}")


def telecharger() -> gpd.GeoDataFrame:
    cache = CACHE / "admin_express_communes.parquet"
    if cache.exists():
        print(f"[cache] {cache.name}")
        return gpd.read_parquet(cache)

    base = (f"{WFS}?service=WFS&version=2.0.0&request=GetFeature"
            f"&typeNames={NS}:commune&outputFormat=application/json"
            f"&propertyName={','.join(PROPS)}")
    pages, start = [], 0
    while True:
        g = gpd.read_file(io.BytesIO(_get(f"{base}&count={PAGE}&startIndex={start}")))
        if len(g) == 0:
            break
        pages.append(g)
        print(f"  {len(g)} communes (cumul {sum(len(p) for p in pages)})")
        start += PAGE
    if not pages:
        raise RuntimeError("aucune commune recue")

    gdf = gpd.GeoDataFrame(gpd.pd.concat(pages, ignore_index=True), crs="EPSG:4326")
    if gdf.geometry.isna().any():
        raise RuntimeError("geometries manquantes")
    gdf.to_parquet(cache, index=False)
    print(f"[save] {cache.name} ({len(gdf)} communes, {cache.stat().st_size / 1e6:.0f} Mo)")
    return gdf


def charger(gdf: gpd.GeoDataFrame) -> None:
    """Cree la table PostGIS et l'indexe : sans l'index GIST, le filtre par
    emprise des endpoints devient un parcours sequentiel de 35 000 lignes."""
    import psycopg2

    conn = psycopg2.connect(dbname=php_val("dbname"), host=php_val("host"),
                           user=php_val("dbuser"), password=php_val("dbpass"),
                           port=int(php_val("port")))
    cur = conn.cursor()
    cur.execute("SELECT postgis_version()")
    print(f"PostGIS {cur.fetchone()[0]}")

    # Hors-mer : l'emprise nationale wreckerait l'affichage continental.
    g = gdf[~gdf["code_insee"].astype(str).str.startswith(
        ("97", "98", "984", "986", "987", "988", "989"))].copy()

    cur.execute(f'DROP TABLE IF EXISTS public."{TABLE}"')
    cur.execute(f'''CREATE TABLE public."{TABLE}" (
        code_insee text PRIMARY KEY,
        nom text,
        code_dep text,
        code_reg text,
        population integer,
        superficie_km2 numeric,
        geom geometry(Geometry, 4326))''')

    from psycopg2.extras import execute_values
    lignes = [(r["code_insee"], r["nom_officiel"], r["code_insee_du_departement"],
               r["code_insee_de_la_region"],
               None if r["population"] is None else int(r["population"]),
               None if r["superficie_cadastrale"] is None else r["superficie_cadastrale"] / 100.0,
               f"SRID=4326;{r.geometry.wkt}")
              for _, r in g.iterrows()]
    # La colonne est de type geometry : PostGIS lit l'EWKT directement.
    # (Passer `ST_GeomFromEWKT(%s)` ici est impossible : `execute_values`
    # découpe la requête sur `%s` et refuse une expression.)
    execute_values(cur, f'INSERT INTO public."{TABLE}" VALUES %s', lignes,
                   template="(%s,%s,%s,%s,%s,%s,%s)", page_size=1000)
    cur.execute(f'CREATE INDEX ON public."{TABLE}" USING GIST (geom)')
    cur.execute(f'ANALYZE public."{TABLE}"')
    conn.commit()

    cur.execute(f'SELECT count(*) FROM public."{TABLE}"')
    print(f"[ok] public.{TABLE} : {cur.fetchone()[0]} communes")
    cur.execute(f'SELECT ST_Extent(geom) FROM public."{TABLE}"')
    print(f"     emprise : {cur.fetchone()[0]}")
    conn.close()


def main() -> None:
    charger(telecharger())


if __name__ == "__main__":
    main()