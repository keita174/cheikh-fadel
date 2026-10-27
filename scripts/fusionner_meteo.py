"""Fusionne les CSV meteorologiques en un seul fichier exploitable.

Les telechargements produisent trois fichiers par point et par source, ce
qui est pratique pour la traçabilite mais penible pour l'analyse. Ce script
les assemble en une table unique, une ligne par jour et par point.

Les colonnes sont prefixees par le modele reel derriere chaque source, et non
par le nom de l'API : `era5_` pour la reanalyse ERA5 servie par Open-Meteo,
`merra2_` pour la climatologie MERRA-2 servie par NASA POWER. Le prefixe
empeche de melanger les deux series de precipitations par megarde : 154 mm
d'un cote, 347 mm de l'autre, ce n'est pas le meme orage.

    python scripts/fusionner_meteo.py
"""

from __future__ import annotations

import csv
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
BASE = RACINE / "meteo" / "2024"

SORTIE = BASE / "saint-louis-2024_meteo.csv"
SORTIE_POINTS = BASE / "port-hydrobase-2024_quotidien.csv"

RENOMS = {
    # identite
    "point": "point", "nom_point": "nom_point",
    "latitude": "latitude", "longitude": "longitude", "date": "date",
    # Open-Meteo = reanalyse ERA5
    "temperature_2m_max": "era5_tmax_c",
    "temperature_2m_min": "era5_tmin_c",
    "temperature_2m_mean": "era5_tmean_c",
    "precipitation_sum": "era5_precip_mm",
    "rain_sum": "era5_pluie_mm",
    "wind_speed_10m_max": "era5_vent10_max_kmh",
    "wind_gusts_10m_max": "era5_rafales10_max_kmh",
    "wind_direction_10m_dominant": "era5_vent10_dir_deg",
    "shortwave_radiation_sum": "era5_rayonnement_mj",
    "et0_fao_evapotranspiration": "era5_et0_mm",
    # NASA POWER = MERRA-2
    "T2M": "merra2_tmean_c",
    "T2M_MAX": "merra2_tmax_c",
    "T2M_MIN": "merra2_tmin_c",
    "T2MDEW": "merra2_rosee_c",
    "T2MWET": "merra2_bulbe_mouille_c",
    "RH2M": "merra2_humidite_pct",
    "PS": "merra2_pression_kpa",
    "WS2M": "merra2_vent2_ms",
    "PRECTOTCORR": "merra2_precip_mm",
    "ALLSKY_SFC_SW_DWN": "merra2_rayonnement_kwh",
    "EVPTRNS": "merra2_evapotranspiration_kwh",
    "TS": "merra2_temperature_sol_c",
}

ORDRE = [
    "point", "nom_point", "latitude", "longitude", "date",
    "era5_tmax_c", "era5_tmin_c", "era5_tmean_c", "era5_precip_mm", "era5_pluie_mm",
    "era5_vent10_max_kmh", "era5_rafales10_max_kmh", "era5_vent10_dir_deg",
    "era5_rayonnement_mj", "era5_et0_mm",
    "merra2_tmean_c", "merra2_tmax_c", "merra2_tmin_c",
    "merra2_rosee_c", "merra2_bulbe_mouille_c", "merra2_humidite_pct",
    "merra2_pression_kpa", "merra2_vent2_ms", "merra2_precip_mm",
    "merra2_rayonnement_kwh", "merra2_evapotranspiration_kwh",
    "merra2_temperature_sol_c",
]


def lire_csv(chemin: Path) -> list[dict]:
    if not chemin.exists():
        return []
    with chemin.open(encoding="utf-8") as f:
        return list(csv.DictReader(f))


def coordonnees(dossier: str):
    """Relit nom et coordonnées depuis provenance.json plutôt que de les réécrire."""
    import json
    p = BASE / dossier / "provenance.json"
    if not p.exists():
        return "", 0.0, 0.0
    j = json.loads(p.read_text(encoding="utf-8"))
    return j.get("nom", ""), j.get("latitude"), j.get("longitude")


def main() -> int:
    if not BASE.exists():
        print(f" repertoire absent : {BASE}")
        return 1

    points = sorted(p.name for p in BASE.iterdir() if p.is_dir())
    if not points:
        print(" aucun point trouve")
        return 1

    lignes: list[dict] = []
    for point in points:
        nom, lat, lon = coordonnees(point)
        om = {r["date"]: r for r in lire_csv(BASE / point / "openmeteo_quotidien.csv")}
        pw = {r["date"]: r for r in lire_csv(BASE / point / "power_quotidien.csv")}
        dates = sorted(set(om) | set(pw))
        if not dates:
            print(f"  {point} : aucune donnee")
            continue
        for d in dates:
            lig = {"point": point, "nom_point": nom,
                   "latitude": lat, "longitude": lon, "date": d}
            for src in (om.get(d) or {}, pw.get(d) or {}):
                for k, v in src.items():
                    nom = RENOMS.get(k)
                    if nom and v not in ("", None):
                        lig[nom] = v
            lignes.append(lig)
        print(f"  {point} : {len(dates)} jours")

    if not lignes:
        print(" rien a fusionner")
        return 1

    # L'ordre des colonnes est impose : `ODRE` liste ce qu'on veut voir en
    # tete, puis le reste eventuel, pour ne pas perdre de donnee.
    entetes = [c for c in ORDRE if any(c in l for l in lignes)]
    for l in lignes:
        for c in l:
            if c not in entetes:
                entetes.append(c)

    with SORTIE.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=entetes, extrasaction="ignore")
        w.writeheader()
        w.writerows(lignes)
    print(f"\n-> {SORTIE.name} : {len(lignes)} lignes, {len(entetes)} colonnes")

    # Version ramenee au seul port commercial, sans colonne de point :
    # c'est le fichier a ouvrir si on ne veut qu'une seule serie.
    port = [l for l in lignes if l["point"] == "port-hydrobase"]
    if port:
        entetes_port = [c for c in entetes if c not in ("point", "nom_point")]
        cible = SORTIE_POINTS
        with cible.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=entetes_port, extrasaction="ignore")
            w.writeheader()
            w.writerows(port)
        print(f"-> {cible.name} : {len(port)} lignes (port commercial seul)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())