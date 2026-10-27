"""Compare les deux sources meteorologiques téléchargées.

Deux jeux de données qui n'empruntent pas la même methode — reanalyse ERA5
pour Open-Meteo, climatologie satellitaire MERRA-2 pour NASA POWER — ne
doivent pas coincider au dixieme de degre. Ce qu'on mesure ici, c'est
l'ecart, pour verifier que les fichiers sont exploitables ensemble et non
deux series sans rapport.

    python scripts/comparer_sources.py
"""

from __future__ import annotations

import csv
import statistics
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
BASE = RACINE / "meteo" / "2024"

# Colonnes comparables entre les deux sources.
PAIRES = [
    ("température moyenne", "temperature_2m_mean", "T2M", 0.0, 5.0),
    ("température max", "temperature_2m_max", "T2M_MAX", 0.0, 5.0),
    ("température min", "temperature_2m_min", "T2M_MIN", 0.0, 5.0),
    ("précipitations", "precipitation_sum", "PRECTOTCORR", 0.0, 40.0),
]


def lire(chemin: Path) -> dict[str, float]:
    if not chemin.exists():
        return {}
    out: dict[str, float] = {}
    with chemin.open(encoding="utf-8") as f:
        for ligne in csv.DictReader(f):
            cle = ligne.get("date") or ligne.get("heure")
            if cle:
                out[cle] = ligne
    return out


def nombre(ligne: dict, col: str):
    try:
        v = float(ligne[col])
    except (TypeError, ValueError, KeyError):
        return None
    return v if v > -900 else None


def main() -> int:
    points = sorted(p.name for p in BASE.iterdir() if p.is_dir()) if BASE.exists() else []
    if not points:
        print(f"Aucune donnee dans {BASE}")
        return 1

    for point in points:
        om = lire(BASE / point / "openmeteo_quotidien.csv")
        pw = lire(BASE / point / "power_quotidien.csv")
        communes = sorted(set(om) & set(pw))
        print(f"=== {point} — {len(communes)} jours communs")
        if not communes:
            print("    aucune date commune")
            continue

        print(f"    {'variable':22s} {'Open-Meteo':>12s} {'POWER':>12s}"
              f" {'ecart moy.':>12s} {'ecart max':>10s}  {'tol.':>6s}")
        for nom, col_om, col_pw, tol_min, tol_max in PAIRES:
            a, b, ecarts = [], [], []
            for d in communes:
                va = nombre(om[d], col_om)
                vb = nombre(pw[d], col_pw)
                if va is None or vb is None:
                    continue
                a.append(va)
                b.append(vb)
                ecarts.append(abs(va - vb))
            if not ecarts:
                print(f"    {nom:22s}  (aucune paire exploitable)")
                continue
            moy = statistics.mean(ecarts)
            mx = max(ecarts)
            verdict = "ok" if moy <= tol_max else "À VÉRIFIER"
            if moy < tol_min:
                verdict = "ok"
            print(f"    {nom:22s} {statistics.mean(a):12.2f} {statistics.mean(b):12.2f}"
                  f" {moy:12.2f} {mx:10.2f}  {verdict:>6s}")
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())