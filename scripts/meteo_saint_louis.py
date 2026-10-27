"""Téléchargement des données météorologiques de 2024 pour le port de Saint-Louis.

Deux sources indépendantes, téléchargées séparément puis comparables :

  - Open-Meteo (archive) : réanalyse ERA5 via l'API Historical Weather.
    hourly weather. Séries horaires et quotidiennes, fuseau Africa/Dakar.
  - NASA POWER : climatologie satellitaire journalière, par point et sans clé.

Trois points sont descargés parce que « le port de Saint-Louis » ne désigne
pas un point unique : le port commercial (Hydrobase) et le port de pêche ne
sont pas au même endroit, à environ quatre kilomètres l'un de l'autre.

    python scripts/meteo_saint_louis.py --annee 2024
    python scripts/meteo_saint_louis.py --annee 2024 --sources power

Sorties, dans meteo/<année>/<point>/ :
    openmeteo_horaire.csv    une ligne par heure
    openmeteo_quotidien.csv  une ligne par jour
    power_quotidien.csv      une ligne par jour
    provenance.json          URL, coordonnées, date de téléchargement
"""

from __future__ import annotations

import argparse
import csv
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
DESTINATION = RACINE / "meteo"

AGENT = "CarteMedicale-SIG/1.0 (travail personnel, usage non commercial)"

# Les trois points ont été relevés dans OpenStreetMap via Nominatim, et non
# choisis à vue : un décalage de deux kilomètres change le vent et la pluie.
POINTS = {
    "port-hydrobase": {
        "nom": "Port de l'Hydrobase (port commercial)",
        "lat": 15.99176, "lon": -16.50921,
        "source": "OSM Nominatim — type=industrial",
    },
    "port-peche": {
        "nom": "Port de pêche (pont Moustapha Malick Gaye)",
        "lat": 16.02603, "lon": -16.50672,
        "source": "OSM Nominatim — Pont Moustapha Malick Gaye",
    },
    "ville": {
        "nom": "Saint-Louis, centre-ville",
        "lat": 16.02804, "lon": -16.50487,
        "source": "OSM Nominatim — administrative",
    },
}

VARIABLES_HORAIRES = [
    "temperature_2m", "relative_humidity_2m", "dew_point_2m", "apparent_temperature",
    "precipitation", "rain", "cloud_cover", "wind_speed_10m", "wind_direction_10m",
    "wind_gusts_10m", "surface_pressure", "visibility",
]

VARIABLES_QUOTIDIENNES = [
    "temperature_2m_max", "temperature_2m_min", "temperature_2m_mean",
    "precipitation_sum", "rain_sum", "wind_speed_10m_max", "wind_gusts_10m_max",
    "wind_direction_10m_dominant", "shortwave_radiation_sum", "et0_fao_evapotranspiration",
]

# POWER limite le nombre de paramètres par requête : on les envoie par lots.
# Liste vérifiée un par un : `PRECTOTLAND`, `WIND_SPEED_10M`, `TSMIN` et
# `TQSENSMAX` refusent tous la requête quotidienne (HTTP 422) pour la
# communauté RE. Le vent disponible est donc celui à 2 mètres, `WS2M`.
LOTS_POWER = [
    ["T2M", "T2M_MAX", "T2M_MIN", "T2MDEW", "T2MWET", "RH2M", "PS", "WS2M", "WD2M"],
    ["PRECTOTCORR", "ALLSKY_SFC_SW_DWN", "EVPTRNS", "TS"],
]


def dire(message: str) -> None:
    print(message, flush=True)


def attendre(secondes: float) -> None:
    """Pause entre deux requêtes, pour rester correct avec les API publiques."""
    time.sleep(secondes)


def telecharger(url: str, essai: int = 4) -> bytes:
    """Lit une URL, avec quelques reprises en cas d'échec réseau."""
    derniere = None
    for tour in range(essai):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": AGENT})
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read()
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as e:
            derniere = e
            if tour < essai - 1:
                attendre = 2 ** tour
                dire(f"    échec ({type(e).__name__}), nouvel essai dans {attendre} s")
                time.sleep(attendre)
    raise RuntimeError(f"téléchargement impossible : {url}\n  cause : {derniere}")


def ecrire_csv(chemin: Path, entetes: list[str], lignes: list[list]) -> Path:
    chemin.parent.mkdir(parents=True, exist_ok=True)
    with chemin.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, delimiter=",")
        w.writerow(entetes)
        w.writerows(lignes)
    return chemin


# --------------------------------------------------------------------------- #
# Open-Meteo
# --------------------------------------------------------------------------- #

def base_openmeteo(lat: float, lon: float, annee: int) -> str:
    return "https://archive-api.open-meteo.com/v1/archive?" + urllib.parse.urlencode({
        "latitude": round(lat, 5), "longitude": round(lon, 5),
        "start_date": f"{annee}-01-01", "end_date": f"{annee}-12-31",
        "timezone": "Africa/Dakar",
    })


def chunker(valeurs: list, taille: int):
    for i in range(0, len(valeurs), taille):
        yield valeurs[i:i + taille]


def telecharger_openmeteo(lat: float, lon: float, annee: int, dossier: Path) -> dict:
    """Récupère les séries horaires et quotidiennes, par lots.

    L'API refuse les requêtes trop longues ; on découpe donc les variables en
    trois paquets horaires et on fusionne les résultats par index horaire.
    """
    base = base_openmeteo(lat, lon, annee)
    infos: dict = {}

    # --- quotidien -------------------------------------------------------- #
    quotidien: dict[str, list] = {}
    dates: list[str] = []
    for lot in chunker(VARIABLES_QUOTIDIENNES, 5):
        url = f"{base}&daily={','.join(lot)}"
        dire(f"    quotidien {len(lot)} variables…")
        j = json.loads(telecharger(url).decode("utf-8"))
        d = j.get("daily", {})
        if not d:
            raise RuntimeError(f"aucune donnée quotidienne renvoyée : {url}")
        # Le tableau des dates est celui de la clé `time`, pas celui de la
        # première variable : le prendre par ordre d'arrivée mettait les
        # températures dans la colonne `date` du fichier produit.
        if not dates:
            dates = d.get("time") or []
        for cle in lot:
            if cle in d:
                quotidien[cle] = d[cle]
        infos["unites_quotidiennes"] = j.get("daily_units", {})
        infos["altitude_m"] = j.get("elevation")
        attendre(1)

    if not dates:
        raise RuntimeError("aucune date dans la réponse quotidienne")

    noms = list(quotidien.keys())
    entetes = ["date"] + noms
    lignes = [[dates[i]] + [quotidien[c][i] for c in noms] for i in range(len(dates))]
    p = ecrire_csv(dossier / "openmeteo_quotidien.csv", entetes, lignes)
    infos["quotidien"] = {"fichier": p.name, "lignes": len(lignes), "colonnes": entetes}
    dire(f"    → {p.name} ({len(lignes)} lignes)")

    # --- horaire ---------------------------------------------------------- #
    horaire: dict[str, list] = {}
    heures: list[str] = []
    for lot in chunker(VARIABLES_HORAIRES, 6):
        url = f"{base}&hourly={','.join(lot)}"
        dire(f"    horaire {len(lot)} variables…")
        j = json.loads(telecharger(url).decode("utf-8"))
        h = j.get("hourly", {})
        if not h:
            raise RuntimeError(f"aucune donnée horaire renvoyée : {url}")
        if not heures:
            heures = h.get("time") or []
        for cle in lot:
            if cle in h:
                horaire[cle] = h[cle]
        infos["unites_horaires"] = j.get("hourly_units", {})
        attendre(1)

    if not heures:
        raise RuntimeError("aucune heure dans la réponse horaire")

    noms = list(horaire.keys())
    entetes = ["heure"] + noms
    lignes = [[heures[i]] + [horaire[c][i] for c in noms] for i in range(len(heures))]
    p = ecrire_csv(dossier / "openmeteo_horaire.csv", entetes, lignes)
    infos["horaire"] = {"fichier": p.name, "lignes": len(lignes), "colonnes": entetes}
    dire(f"    → {p.name} ({len(lignes)} lignes)")

    infos["fuseau"] = "Africa/Dakar (GMT, UTC+0 toute l'année au Sénégal)"
    return infos


# --------------------------------------------------------------------------- #
# NASA POWER
# --------------------------------------------------------------------------- #

def requete_power(lat: float, lon: float, annee: int, params: list[str]) -> dict:
    """Une requête POWER. Un seul paramètre invalide fait échouer tout le lot
    en HTTP 422 : on réessaie donc paramètre par paramètre pour ne pas perdre
    une série entière à cause d'un nom refusé."""
    def url(p: list[str]) -> str:
        return "https://power.larc.nasa.gov/api/temporal/daily/point?" + urllib.parse.urlencode({
            "parameters": ",".join(p), "community": "RE",
            "longitude": round(lon, 5), "latitude": round(lat, 5),
            "start": f"{annee}0101", "end": f"{annee}1231", "format": "JSON",
        })

    try:
        return json.loads(telecharger(url(params), essai=1).decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code != 422 or len(params) == 1:
            raise
        dire(f"    lot refusé (422) : {', '.join(params)} — nouvelle tentative par paramètre")
    except RuntimeError:
        if len(params) == 1:
            raise
        dire(f"    lot indisponible — nouvelle tentative par paramètre : {', '.join(params)}")

    j: dict = {}
    for p in params:
        try:
            j = json.loads(telecharger(url([p]), essai=2).decode("utf-8"))
            dire(f"      {p:16s} accepté")
        except Exception:
            dire(f"      {p:16s} refusé par l'API, ignoré")
        attendre(1)
    return j


# Plages physiques attendues. Une série entièrement hors de sa plage n'est
# pas une série : au port de Saint-Louis, POWER renvoie WD2M entre -8999 et
# -5407 pour les 366 jours, ce qui n'est pas une direction de vent mais un
# code interne. Such parameter is dropped and reported rather than written.
PLAGES_PLAUSIBLES = {
    "T2M": (-40, 60), "T2M_MAX": (-40, 65), "T2M_MIN": (-40, 55),
    "T2MDEW": (-50, 45), "T2MWET": (-50, 50), "TS": (-40, 70),
    "RH2M": (0, 100), "PS": (80, 110), "WS2M": (0, 60), "WD2M": (0, 360),
    "PRECTOTCORR": (0, 300), "ALLSKY_SFC_SW_DWN": (0, 15),
    "EVPTRNS": (0, 15),
}


def controler_plausibilite(nom: str, serie: dict) -> tuple[bool, int, str]:
    """Indique si une série tient dans sa plage physique.

    `nom` est passé explicitement : le dictionnaire est indexé par date, et
    prendre sa première clé renvoie « 20240101 », pas le nom du paramètre —
    d'où une vérification qui ne vérifiait rien.

    On tolère une petite proportion de valeurs aberrantes, mais une série
    entièrement hors bornes est inexploitable.
    """
    valeurs = []
    for v in serie.values():
        try:
            valeurs.append(float(v))
        except (TypeError, ValueError):
            continue
    if not valeurs:
        return False, 0, "aucune valeur exploitable"
    plage = PLAGES_PLAUSIBLES.get(nom)
    if plage is None:
        return True, len(valeurs), "hors vérification"
    bas, haut = plage
    dans = [v for v in valeurs if bas <= v <= haut]
    taux = len(dans) / len(valeurs)
    detail = (f"{len(dans)}/{len(valeurs)} valeurs dans [{bas:g}, {haut:g}]"
              f" — hors bornes de {min(valeurs):g} à {max(valeurs):g}")
    return taux >= 0.9, len(dans), detail


def telecharger_power(lat: float, lon: float, annee: int, dossier: Path) -> dict:
    """Série quotidienne de POWER, par lots de paramètres."""
    colonnes: dict[str, dict] = {}
    entetes: dict[str, str] = {}
    unites: dict[str, str] = {}
    ecartes: dict[str, str] = {}
    j: dict = {}

    for lot in LOTS_POWER:
        dire(f"    lot {len(lot)} paramètres : {', '.join(lot)}")
        j = requete_power(lat, lon, annee, lot)

        for message in j.get("messages", []) or []:
            dire(f"    [POWER] {message}")

        prop = (j.get("properties") or {}).get("parameter", {})
        for cle in lot:
            if cle not in prop:
                continue
            # Une requête « daily » renvoie un objet indexé par date
            # ("20240101": 24.27), et non la structure mensuelle
            # ALL / JAN / YYYYMMDD qu'on trouve ailleurs dans l'API POWER.
            if not isinstance(prop[cle], dict):
                dire(f"    [POWER] structure inattendue pour {cle}, paramètre ignoré")
                continue
            plausible, n, detail = controler_plausibilite(cle, prop[cle])
            if not plausible:
                dire(f"    [POWER] {cle} écarté : {detail}")
                ecartes[cle] = detail
                continue
            dire(f"    [POWER] {cle} retenu ({n} valeurs)")
            colonnes[cle] = prop[cle]
        for cle, meta in (j.get("parameters") or {}).items():
            entetes[cle] = meta.get("units", "")
            unites[cle] = meta.get("longname", "")
        attendre(1)

    if not colonnes:
        raise RuntimeError("aucun paramètre POWER exploitable")

    dates = sorted({d for serie in colonnes.values() for d in serie})
    if not dates:
        raise RuntimeError("aucune date dans la réponse POWER")

    noms = list(colonnes.keys())
    entete = ["date"] + noms
    lignes = []
    # POWER renvoie WD2D hors bornes sur certaines journées (-8385 par
    # exemple) : ce n'est pas une direction, c'est un code interne. Ces
    # valeurs sont mises à vide plutôt que propagées dans le CSV.
    for d in dates:
        vals = []
        for c in noms:
            v = colonnes[c].get(d, "")
            if c == "WD2M" and v not in ("", None):
                try:
                    if not 0 <= float(v) <= 360:
                        v = ""
                except (TypeError, ValueError):
                    v = ""
            vals.append(v)
        lignes.append([f"{d[0:4]}-{d[4:6]}-{d[6:8]}"] + vals)
    p = ecrire_csv(dossier / "power_quotidien.csv", entete, lignes)

    with (dossier / "power_unites.txt").open("w", encoding="utf-8") as f:
        f.write("Colonnes de power_quotidien.csv\n")
        for c in colonnes:
            f.write(f"  {c:16s} unité {entetes.get(c, ''):12s} {unites.get(c, '')}\n")

    dire(f"    → {p.name} ({len(lignes)} lignes, {len(noms)} paramètres retenues)")
    sources = (j.get("header") or {}).get("sources") or []
    if ecartes:
        with (dossier / "power_unites.txt").open("a", encoding="utf-8") as f:
            f.write("\nParamètres écartés (valeurs hors bornes)\n")
            for c, why in ecartes.items():
                f.write(f"  {c:12s} {why}\n")
    return {"quotidien": {"fichier": p.name, "lignes": len(lignes), "colonnes": entete},
            "unites": entetes,
            "parametres_ecartes": ecartes,
            "modele_source": sources[0] if sources else None}


# --------------------------------------------------------------------------- #
# Synthèse
# --------------------------------------------------------------------------- #

def resumer(chemin: Path) -> dict:
    """Statistiques calculées sur les fichiers réellement téléchargés."""
    if not chemin.exists():
        return {}
    with chemin.open(encoding="utf-8") as f:
        lignes = list(csv.DictReader(f))
    if not lignes:
        return {}

    def valeurs(col: str) -> list[float]:
        out = []
        for l in lignes:
            try:
                v = float(l[col])
            except (TypeError, ValueError, KeyError):
                continue
            # POWER signale une valeur manquante par -999.
            if v > -900:
                out.append(v)
        return out

    tmax = valeurs("temperature_2m_max")
    tmin = valeurs("temperature_2m_min")
    tmoy = valeurs("temperature_2m_mean")
    pluie = valeurs("precipitation_sum")
    vent = valeurs("wind_speed_10m_max")
    rad = valeurs("shortwave_radiation_sum")

    s = {
        "jours": len(lignes),
        "temp_max_c": [round(min(tmax), 1), round(max(tmax), 1)] if tmax else None,
        "temp_min_c": [round(min(tmin), 1), round(max(tmin), 1)] if tmin else None,
        "temp_moyenne_annuelle_c": round(sum(tmoy) / len(tmoy), 2) if tmoy else None,
        "pluie_totale_mm": round(sum(pluie), 1) if pluie else None,
        "pluie_max_jour_mm": round(max(pluie), 1) if pluie else None,
        "jours_de_pluie": sum(1 for v in pluie if v >= 1.0),
        "vent_max_kmh": round(max(vent), 1) if vent else None,
        "vent_10p_plus_frequent_kmh": (
            round(sorted(vent)[len(vent) // 10], 1) if len(vent) > 10 else None),
        "rayonnement_mj_m2_total": round(sum(rad), 1) if rad else None,
    }
    if pluie:
        wet = [v for v in pluie if v >= 1.0]
        if wet:
            s["pluie_moyenne_jour_de_pluie_mm"] = round(sum(wet) / len(wet), 1)
    return s


# --------------------------------------------------------------------------- #

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--annee", type=int, default=2024)
    ap.add_argument("--sources", default="openmeteo,power",
                    help="sources à télécharger : openmeteo, power, ou les deux")
    ap.add_argument("--points", default=",".join(POINTS),
                    help="points à traiter, séparés par des virgules")
    args = ap.parse_args()

    sources = {s.strip() for s in args.sources.split(",") if s.strip()}
    choisis = [p.strip() for p in args.points.split(",") if p.strip() in POINTS]
    if not choisis:
        print(f"Aucun point reconnu. Choix possibles : {', '.join(POINTS)}")
        return 1

    horodatage = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    print(f"Données météo {args.annee} — port de Saint-Louis")
    print(f"Téléchargé le {horodatage}")
    print(f"Sources : {', '.join(sorted(sources))}")
    print()

    for cle in choisis:
        info = POINTS[cle]
        dossier = DESTINATION / str(args.annee) / cle
        dossier.mkdir(parents=True, exist_ok=True)

        print(f"[{cle}] {info['nom']}")
        print(f"    {info['lat']:.5f}, {info['lon']:.5f}  ({info['source']})")

        provenance = {
            "point": cle, "nom": info["nom"],
            "latitude": info["lat"], "longitude": info["lon"],
            "origine_coordonnees": info["source"],
            "annee": args.annee,
            "telecharge_le": horodatage,
        }

        if "openmeteo" in sources:
            dire("    source Open-Meteo (réanalyse ERA5)")
            try:
                provenance["openmeteo"] = telecharger_openmeteo(
                    info["lat"], info["lon"], args.annee, dossier)
            except Exception as e:
                dire(f"    ÉCHEC Open-Meteo : {e}")
                provenance["openmeteo"] = {"erreur": str(e)}
        if "power" in sources:
            dire("    source NASA POWER (climatologie satellitaire)")
            try:
                provenance["power"] = telecharger_power(
                    info["lat"], info["lon"], args.annee, dossier)
            except Exception as e:
                dire(f"    ÉCHEC POWER : {e}")
                provenance["power"] = {"erreur": str(e)}

        synthese = resumer(dossier / "openmeteo_quotidien.csv")
        if synthese:
            provenance["synthese_openmeteo"] = synthese
            dire("    synthèse :")
            for k, v in synthese.items():
                dire(f"      {k:34s} {v}")

        (dossier / "provenance.json").write_text(
            json.dumps(provenance, ensure_ascii=False, indent=2), encoding="utf-8")
        print()

    print(f"Récapitulatif de l'année {args.annee} :")
    for cle in choisis:
        p = DESTINATION / str(args.annee) / cle / "openmeteo_quotidien.csv"
        s = resumer(p)
        if not s:
            continue
        nom = POINTS[cle]["nom"]
        print(f"  {nom}")
        if s.get("temp_moyenne_annuelle_c") is not None:
            print(f"    température moyenne      {s['temp_moyenne_annuelle_c']} °C"
                  f"   (max {s['temp_max_c'][1]} °C, min {s['temp_min_c'][0]} °C)")
        if s.get("pluie_totale_mm") is not None:
            print(f"    pluie cumulée            {s['pluie_totale_mm']} mm"
                  f"   sur {s['jours_de_pluie']} jours de pluie"
                  f"   (record {s['pluie_max_jour_mm']} mm/jour)")
        if s.get("vent_max_kmh") is not None:
            print(f"    vent maximal             {s['vent_max_kmh']} km/h")
    print()
    print(f"Fichiers dans : {DESTINATION / str(args.annee)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())