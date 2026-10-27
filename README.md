# Analyses spatiales sur les pharmacies d'officine (France)

Traitement complet de `pharmacies_point.csv` (extraction OSM) : 19 142 points
d'officines, dont 19 094 se rattachent a une commune de France continentale.

Tout est reproductible avec `python scripts/run_all.py`. Aucune donnée de
population n'est utilisee pour ponder les comptes : la population n'apparait que
dans le seul indicateur explicitement pondere du bloc 5.

## Verification prealable de la donnee

Points de controle effectues avant toute analyse :

| Controle | Resultat |
|---|---|
| Encodage | UTF-8 valide ; le `?` affiche en console est un artefact d'affichage PowerShell, pas du fichier |
| Geometrie | 19 142 points, tous valides, aucun vide ; CRS source EPSG:3857, reprojete en Lambert 93 (EPSG:2154) |
| Doublons `osm_id` | 0 |
| Etendue | lon -5,10 / 9,55 ; lat 41,39 / 51,07 — France continentale uniquement, hors outre-mer |
| Jointure aux communes | 19 094 / 19 142 rattaches ; les 48 orphelins sont a Monaco, Andorre et en zone maritime |
| `amenity` | 100 % `pharmacy`, sans exception |
| Attributs vides | `addr-postcode` 24 %, `opening_hours` 52 %, `wheelchair` 20 %, `addr-city` 23 % |

Deux points conditionnent l'interpretation de tous les resultats :

- **`dispensing` ne discrimine rien.** 95,5 % des valeurs valent `yes`, 23 valent
  `no`, le reste est vide. En pratique cet attribut est pose par defaut, il ne
  signale pas une habilitation particuliere. La carte de localisation reste
  produite (`pharmacies_dispensing.csv`) mais elle ne veut rien dire comme
  carte de specialisation.
- **Moitie des pharmacies n'a pas d'horaire.** Tous les taux calcules sur les
  horaires ont donc pour denominateur les 9 982 pharmacies dont l'horaire a pu
  etre decode, jamais les 19 142. Le silence de la donnee n'est jamais confondu
  avec une fermeture.

## Interpretation des horaires OSM

4 880 valeurs distinctes de `opening_hours`, dans la syntaxe OSM. Un decodeur
local (`scripts/common.py`) les convertit en grille hebdomadaire de 7 x 96
demi-heures. Il gere les selecteurs de jours, les plages multiples, `off`,
`closed`, `24/7`, `||`, le suffixe `+`, les regexpferences saisonnieres
(`Jul-Aug`, `week 01-53/2`, `PH`) et les commentaires entre guillemets.

4 879 valeurs sur 4 880 sont decodees. La seule non lue est `closed`, qui ne
decrit aucune plage. 7 pharmacies concernees au total.

Trois conventions meritent d'etre connues :

- Les regles saisonnieres sont conservees et marquees `horaires_saisonniers`
  (180 pharmacies). Elles decrivent un ete, pas une semaine type.
- Une fermeture datee (`May 29 off`) est ignoree plutot que lue comme une
  fermeture hebdomadaire.
- `Su-Mo` est traite comme {dimanche, lundi} et non comme la semaine entiere.

## Les cinq blocs

### 1. Repartition spatiale (`02_spatial.py`)

- **Densite kernel**, noyau quartique de 4 km, raster 400 m, sans population.
  `kernel_density_grid.csv` sort la grille cellule par cellule.
- **Distance au plus proche voisin** : mediane 505 m, p90 5,6 km, max 24,8 km.
  Cette queue longue isole les pharmacies rurales.
- **Comptage brut** par departement et par region, avec la surface en
  appoint. Paris 873 officines, Ile-de-France 3 297.
- **DBSCAN** (eps 1,5 km, min 8) : 238 grappes pour 8 408 pharmacies, 10 734
  hors grappe. `grappes_dbscan.csv` donne par grappe l'effectif, la surface de
  l'enveloppe convexe et le rayon equivalent.

Cartes : `01`, `02`, `03`, `04`, `05`.

### 2. Horaires (`03_horaires.py`)

- **Ouvert a un instant donne**, cinq panneaux (lundi 9 h, mercredi 19 h,
  jeudi 20 h, samedi 12 h, dimanche 10 h). La liste `INSTANTS` en tete de
  script se modifie pour explorer d'autres moments.
- **Couverture en soiree et la nuit**, par departement. Seuils a 20 h et 22 h
  et non 19 h 30, qui est la fermeture reglementaire usuelle et ne distinguerait
  rien. Denominateur : les pharmacies avec horaires.
- **Gardes dominicales** : 369 pharmacies declarees ouvertes le dimanche.
- **Amplitude** : moyenne par departement et par profil horaire hebdomadaire.

Cartes : `06` a `12`.

### 3. Attributs de service (`04_services.py`)

- **PMR** : 3 174 accessibles, 335 partiellement, 297 explicitement non, 15 326
  non renseigne. 6 060 communes ont une pharmacie mais aucune declaree
  accessible — dont une part importante ou l'accessibilite n'est simplement pas
  documentee. La carte les separe de celles ou l'information manque.
- **dispensing** : voir la reserve plus haut.
- **Completude** sur 9 champs, par region et par departement. Ecart maximal :
  telephone (70 points entre PACA a 26 % et Hauts-de-France a 96 %), puis
  horaires (66 points), puis SIRET (53 points). La carte finale affiche le champ
  au plus fort ecart.

Cartes : `13` a `16`.

### 4. Desserte (`05_desserte.py`)

Buffers de 500 m et 1 km rasterises sur une grille de 250 m. **98,1 % du
territoire continental est hors de portee a 500 m et 94,5 % a 1 km.** Ce chiffre
ne doit pas etre lu comme une carence : il reflete une France dont l'essentiel
de la surface est montagneux ou forestier. C'est pourquoi la carte representee
est le nombre de pharmacies accessibles en echelle log, avec le lointain vide en
blanc — la structure du maillage urbain devient alors lisible. Une carte
departementale de sous-couverture complete le diagnostic.

`taux_apres_20h` et `taux_apres_22h` du bloc 2 repondent a la meme question sous
un autre angle : elles portent sur le nombre de pharmacies, pas sur la surface.

Buffers exportes : `buffers_500m.gpkg`, `buffers_1000m.gpkg`.

Cartes : `17`, `18`, `19`.

### 5. Statistiques descriptives (`06_stats.py`)

- **Classement des communes** : 27 244 communes sans pharmacie, 4 916 avec une
  seule.
- **Urbain / rural** sur la grille INSEE de population communale, qui sert au
  seul classement. 123 agglomerations detiennent 26,3 % des pharmacies ; les
  8 801 communes rurales de moins de 200 habitants en detiennent 5.
- **Histogrammes** d'amplitude hebdomadaire et profil horaire moyen par jour.

Cartes : `20` a `24`.

## Consulter les cartes dans un navigateur

Le projet est sous `C:/xampp/htdocs`, donc Apache sert directement les sorties.

```bash
# démarrer Apache (une seule fois)
C:\xampp\apache\bin\httpd.exe        # ou via xampp_start.bat
```

| Page | URL |
|---|---|
| Atlas des 24 cartes | <http://localhost/PROJET%20SIG%20AIX/outputs/index.html> |
| Carte interactive | <http://localhost/PROJET%20SIG%20AIX/outputs/web/carte.html> |

Sans XAMPP, `python scripts/serve.py` sert le dossier `outputs/` sur le port 8000.

**L'atlas** (`07_gallery.py`) est une page autonome : 24 cartes rangées par bloc,
navigation par ancres, clic pour ouvrir en plein écran (`Échap` ou clic dehors).
Aucune ressource externe.

**La carte interactive** (`08_web_layers.py` + `outputs/web/`) donne :
- les contours **communes** (34 746), départements et régions, tous cliquables ;
- les 19 142 pharmacies, regroupées en mailles d'environ 2 km quand elles se
  chevauchent, avec une fiche au clic (adresse, téléphone, FINESS, horaires) ;
- les rasters de **densité** et de **desserte à 500 m**, calés sur la carte par
  proj4 depuis le Lambert 93 des calculs ;
- les filtres PMR, dimanche et fermeture après 20 h, appliqués côté client ;
- trois thèmes de coloration des communes (nombre, pour 1 000 habitants, type).

Deux décisions pour que la page reste fluide : la couche communes pèse 59 Mo et
n'est donc chargée qu'au-delà du zoom 7 ; Apache a été configuré pour compresser
les GeoJSON (`mod_deflate` et `mod_filter` activés dans `httpd.conf`), ce qui
ramène `regions.geojson` de 934 Ko à 314 Ko.

## Reproduction

```bash
python -m pip install geopandas shapely pyarrow rasterio scipy scikit-learn matplotlib pandas
python scripts/run_all.py
```

`00_fetch_admin.py` telecharge les contours ADMIN EXPRESS (IGN) via le WFS
Geopf. C'est le seul etape reseau ; les autres lisent le CSV local. Le cache
evite de re-telecharger.

## Sorties

```
cache/           volumes intermediaires (grilles, couches enrichies)
outputs/         tableaux CSV, couches GeoPackage, index.html (atlas)
outputs/maps/    24 cartes PNG
outputs/web/     carte interactive (carte.html, carte.js, vendor/, data/)
```

## Limites

- `dispensing` ne permet pas d'analyser une habilitation particuliere.
- Les horaires couvrent 52 % des pharmacies ; les cartes d'ouverture sous-
  estiment donc la couverture reelle, elles mesurent ce que la donnee dit.
- La typologie urbain / rural utilise la population, contrairement au reste du
  corpus. Elle est isolee au bloc 5 et signalee comme telle.
- ADMIN EXPRESS est en version CARTO (simplifiee) : suffisante pour du comptage
  et de la densite, impropre a un calcul de surface exacte.
- 48 pharmacies (Monaco, Andorre, mer) ne sont rattachees a aucune commune et
  sortent des agregats administratifs.