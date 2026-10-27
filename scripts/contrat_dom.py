"""Liste les identifiants DOM que le JavaScript attend.

Sert à vérifier que le HTML供給 garde le contrat attendu avant de le
réécrire : un identifiant manquant casse silencieusement une partie de l'UI.
"""

import re
import pathlib

FICHIERS = ("js/ui.js", "js/app.js", "js/map-view.js")

MOTIFS = {
    "getElementById": r"getElementById\(\s*['\"]([\w-]+)['\"]\s*\)",
    "$('#id')": r"\$\(\s*['\"]#([\w-]+)['\"]\s*\)",
    "data-filtre": r"data-filtre=['\"](\w+)['\"]",
    "data-action": r"data-action=['\"]([\w-]+)['\"]",
    "selecteur-classe": r"\$\$?\(\s*['\"]\.([\w-]+)['\"]",
}


def main() -> None:
    trouve: dict[str, set[str]] = {k: set() for k in MOTIFS}
    for f in FICHIERS:
        txt = pathlib.Path(f).read_text(encoding="utf-8")
        for nom, motif in MOTIFS.items():
            trouve[nom] |= set(re.findall(motif, txt))

    print("IDENTIFIANTS DOM ATTENDUS PAR LE JS\n")
    for nom in ("getElementById", "$('#id')", "data-filtre", "data-action"):
        print(f"  {nom} ({len(trouve[nom])})")
        for v in sorted(trouve[nom]):
            print(f"      {v}")
        print()

    classes = sorted(trouve["selecteur-classe"])
    print(f"  classes ({len(classes)})")
    for c in classes:
        print(f"      .{c}")


if __name__ == "__main__":
    main()