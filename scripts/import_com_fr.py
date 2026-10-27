"""Charge l'ADMIN EXPRESS national dans PostgreSQL, table public."COM_FR".

Source : cache/admin_express_communes.parquet, déposé par
scripts/admin_express.py. 34 877 communes, France entière outre-mer compris,
avec population et superficie cadastrale pour toutes les lignes.

La catégorie de rattachement à l'aire urbaine (`type_com`) vient de
com_uu2020_2026.shp, accolée par code INSEE. C'est le seul attribut repris de
ce fichier : les codes d'UU en sont écartés, ils alourdissent la couche sans
rien ajouter à l'échelle communale.

    python scripts/import_com_fr.py
"""

from __future__ import annotations

import re
from pathlib import Path

import geopandas as gpd
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
PARQUET = ROOT / "cache" / "admin_express_communes.parquet"
UU_SHP = ROOT / "com_uu2020_2026.shp"
TABLE = "COM_FR"

PHP = (ROOT / "api" / "config.php").read_text(encoding="utf-8")


def php_val(nom: str) -> str:
    m = re.search(rf"\${nom}\s*=\s*(?:'([^']*)'|\"([^\"]*)\"|([^;\s]+))", PHP)
    if not m:
        raise SystemExit(f"${nom} absent de api/config.php")
    return next(g for g in m.groups() if g is not None)


def main() -> None:
    import psycopg2
    from psycopg2.extras import execute_values

    if not PARQUET.exists():
        raise SystemExit(
            f"{PARQUET} absent.\n"
            "Lance d'abord :  python scripts/admin_express.py")

    gdf = gpd.read_parquet(PARQUET)
    print(f"lu : {len(gdf)} communes depuis ADMIN EXPRESS (CRS {gdf.crs.to_string()})")

    gdf = gdf.rename(columns={
        "code_insee": "code_insee",
        "nom_officiel": "nom",
        "code_insee_du_departement": "code_dep",
        "code_insee_de_la_region": "code_reg",
    })
    gdf["superficie_km2"] = gdf["superficie_cadastrale"] / 100.0
    gdf["type_com"] = None

    # Accolade du type de commune, par code INSEE. Un LEFT JOIN simulé : les
    # codes absents de la nomenclature 2026 restent sans catégorie, ce qui est
    # préférable à un écart silencieux.
    if UU_SHP.exists():
        uu = gpd.read_file(UU_SHP, columns=["codgeo", "type_com"])
        couverture = dict(zip(uu["codgeo"].astype(str), uu["type_com"]))
        gdf["type_com"] = gdf["code_insee"].astype(str).map(couverture)
        rattachees = int(gdf["type_com"].notna().sum())
        print(f"     type_com accolé sur {rattachees} / {len(gdf)} communes")
    else:
        print("     com_uu2020_2026.shp absent : type_com reste vide")

    gdf["code_insee"] = gdf["code_insee"].astype(str)
    colonnes = ["code_insee", "nom", "code_dep", "code_reg",
                "population", "superficie_km2", "type_com", "geometry"]
    gdf = gdf[colonnes]

    conn = psycopg2.connect(dbname=php_val("dbname"), host=php_val("host"),
                            user=php_val("dbuser"), password=php_val("dbpass"),
                            port=int(php_val("port")))
    cur = conn.cursor()
    cur.execute("SELECT postgis_version()")
    print(f"PostGIS {cur.fetchone()[0]}")

    cur.execute(f'DROP TABLE IF EXISTS public."{TABLE}"')
    cur.execute(f'''CREATE TABLE public."{TABLE}" (
        code_insee    text PRIMARY KEY,
        nom           text,
        code_dep      text,
        code_reg      text,
        population    integer,
        superficie_km2 double precision,
        type_com      text,
        geom          geometry(Geometry, 4326))''')

    lignes = [(r["code_insee"], r["nom"], r["code_dep"], r["code_reg"],
               None if pd.isna(r["population"]) else int(r["population"]),
               None if pd.isna(r["superficie_km2"]) else round(float(r["superficie_km2"]), 2),
               r["type_com"], r.geometry.wkt)
              for _, r in gdf.iterrows()]
    execute_values(cur, f'INSERT INTO public."{TABLE}" VALUES %s', lignes,
                   template="(%s,%s,%s,%s,%s,%s,%s,ST_GeomFromText(%s, 4326))",
                   page_size=500)
    cur.execute(f'CREATE INDEX ON public."{TABLE}" USING GIST (geom)')
    cur.execute(f'CREATE INDEX ON public."{TABLE}" (code_dep)')
    cur.execute(f'CREATE INDEX ON public."{TABLE}" (code_reg)')
    cur.execute(f'ANALYZE public."{TABLE}"')
    conn.commit()

    cur.execute(f'SELECT count(*), count(population), count(DISTINCT code_dep) FROM public."{TABLE}"')
    n, pop, deps = cur.fetchone()
    cur.execute(f'SELECT ST_Extent(geom) FROM public."{TABLE}"')
    print(f"[ok] public.\"{TABLE}\" : {n} communes, {deps} departements/regions")
    print(f"     population renseignee : {pop} / {n}")
    print(f"     emprise : {cur.fetchone()[0]}")
    cur.execute(f'SELECT code_dep, count(*) FROM public."{TABLE}" WHERE code_dep >= \'97\' GROUP BY 1 ORDER BY 1')
    for dep, c in cur.fetchall():
        print(f"       outre-mer {dep} : {c} communes")
    conn.close()


if __name__ == "__main__":
    main()