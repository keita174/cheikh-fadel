"""Export de la table public.COM_FR en shapefile, à la racine du projet.

Produit COM_FR.shp (et .dbf/.shx/.prj/.cpg) en EPSG:2154 (Lambert 93),
même système que le COMMUNE.shp déjà présent dans le dossier.

    python scripts/export_shp.py
"""

from __future__ import annotations

import re
import struct
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely import wkb

ROOT = Path(__file__).resolve().parent.parent
PHP = (ROOT / "api" / "config.php").read_text(encoding="utf-8")


def php_val(nom: str) -> str:
    m = re.search(rf"\${nom}\s*=\s*(?:'([^']*)'|\"([^\"]*)\"|([^;\s]+))", PHP)
    if not m:
        raise SystemExit(f"${nom} absent de api/config.php")
    return next(g for g in m.groups() if g is not None)


def reduire_dbf(chemin: Path) -> tuple[int, int]:
    """Réécrit un .dbf avec des champs à la largeur réelle du contenu.

    pyogrio déclare tous les champs texte à 80 octets, la largeur par défaut
    d'OGR, sans la recalculer : cinq champs à 80 octets font 400 octets par
    enregistrement, soit 13,9 Mo pour 34 746 communes au lieu de 3 Mo.

    Le .dbf est donc réécrit à la main : en-tête et enregistrements sont
    repackés avec la longueur maximale réellement occupée par chaque champ.
    Les largeurs sont calculées en octets UTF-8, jamais en caractères, et
    aucune valeur n'est tronquée puisque la largeur vaut son propre maximum.
    """
    brut = chemin.read_bytes()
    n_enr, len_entete, len_enr = struct.unpack("<IHH", brut[4:12])
    n_champs = (len_entete - 33) // 32

    noms, largeurs = [], []
    for i in range(n_champs):
        off = 32 + i * 32
        noms.append(brut[off:off + 11].split(b"\x00")[0].decode("latin-1"))
        largeurs.append(brut[off + 16])

    # Contenu utile de chaque champ, champ par champ.
    colonnes = [[] for _ in range(n_champs)]
    pos = len_entete
    for _ in range(n_enr):
        enr = brut[pos:pos + len_enr]
        pos += len_enr
        off = 1                       # le premier octet est l'indicateur
        # d'effacement, 0x20 quand l'enregistrement est valide.
        for i, lg in enumerate(largeurs):
            colonnes[i].append(enr[off:off + lg])
            off += lg

    nouvelles = [max(1, max((len(v.rstrip(b" \x00")) for v in col), default=1))
                 for col in colonnes]

    entete = bytearray(brut[:len_entete])
    struct.pack_into("<H", entete, 10, 1 + sum(nouvelles) + 1)
    for i, lg in enumerate(nouvelles):
        entete[32 + i * 32 + 16] = lg

    sortie = bytearray(entete)
    for r in range(n_enr):
        sortie.append(0x20)
        for i, lg in enumerate(nouvelles):
            # `.ljust` ne coupe pas : la largeur vaut le maximum mesuré.
            sortie += colonnes[i][r].rstrip(b" \x00").ljust(lg, b" ")
        sortie.append(0x20)
    sortie.append(0x1A)              # marqueur de fin de fichier

    chemin.write_bytes(bytes(sortie))
    return len(brut), len(sortie)


def ecrire_shp(gdf, base: Path, epsg: int) -> None:
    """Écrit un shapefile en UTF-8, en supprimant les fichiers existants."""
    # GDAL n'ajoute pas l'extension si le nom fourni n'en a pas : on passe
    # `COM_FR.shp` explicitement, sinon il crée un dossier sans suffixe.
    for ext in (".shp", ".shx", ".dbf", ".prj", ".cpg"):
        p = base.with_suffix(ext)
        if p.exists():
            p.unlink()
    gdf.to_file(base.with_suffix(".shp"), driver="ESRI Shapefile",
                encoding="UTF-8")
    reduire_dbf(base.with_suffix(".dbf"))


def main() -> None:
    import psycopg2

    conn = psycopg2.connect(dbname=php_val("dbname"), host=php_val("host"),
                            user=php_val("dbuser"), password=php_val("dbpass"),
                            port=int(php_val("port")))
    cur = conn.cursor()

    # La table est créée en majuscules et doit donc être citée entre
    # guillemets : sans eux, PostgreSQL la rabat en minuscules et ne la
    # retrouve pas.
    cur.execute('''
        SELECT code_insee, nom, code_dep, code_reg, population,
               superficie_km2, type_com, ST_AsBinary(geom) AS wkb
        FROM public."COM_FR"
        ORDER BY nom
    ''')
    lignes = cur.fetchall()
    conn.close()
    if not lignes:
        raise SystemExit("public.\"COM_FR\" est vide")

    # Un shapefile limite les noms de champs à 10 caractères.
    colonnes = ["CODE_INSEE", "NOM", "DEP", "REG", "POP", "SUPERF_KM2",
                "TYP_COM"]
    gdf = gpd.GeoDataFrame(
        [r[:7] for r in lignes], columns=colonnes,
        # psycopg2 renvoie le bytea en `memoryview` : shapely attend des octets.
        geometry=[wkb.loads(bytes(r[7])) for r in lignes], crs="EPSG:4326")

    # Lambert 93 n'est valable qu'en France métropolitaine : projeter la
    # Guyane ou la Polynésie dedans donnerait des coordonnées aberrantes
    # (des centaines de milliers de km). L'outre-mer reste donc en WGS84,
    # dans un fichier distinct.
    metropole = gdf.geometry.apply(
        lambda g: g.bounds[0] > -12 and g.bounds[2] < 12
        and g.bounds[1] > 40 and g.bounds[3] < 52)
    outremer = ~metropole

    base = ROOT / "COM_FR"
    base_om = ROOT / "COM_FR_OUTREMER"
    ecrire_shp(gdf[metropole].to_crs(2154), base, 2154)
    ecrire_shp(gdf[outremer], base_om, 4326)

    print(f"[ok] {base.name}.shp : {int(metropole.sum())} communes, EPSG:2154")
    for ext in (".shp", ".dbf", ".shx", ".prj", ".cpg"):
        p = base.with_suffix(ext)
        taille = f"{p.stat().st_size / 1e6:6.2f} Mo" if p.exists() else "  ABSENT"
        print(f"     {p.name:18s} {taille}")
    surf = gdf[metropole].to_crs(2154).geometry.area.sum() / 1e6
    print(f"     surface metropole : {surf:,.0f} km2".replace(",", " "))

    if outremer.any():
        print(f"[ok] {base_om.name}.shp : {int(outremer.sum())} communes, EPSG:4326")
        for ext in (".shp", ".dbf", ".shx", ".prj", ".cpg"):
            p = base_om.with_suffix(ext)
            if p.exists():
                print(f"     {p.name:18s} {p.stat().st_size / 1e6:6.2f} Mo")

    print(gdf[metropole].head(3).drop(columns="geometry").to_string(index=False))


if __name__ == "__main__":
    main()