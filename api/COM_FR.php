<?php
declare(strict_types=1);

/**
 * API GeoJSON des communes (PostGIS).
 *
 * Paramètres (tous optionnels) :
 *   bbox=minLon,minLat,maxLon,maxLat   communes intersectant l'emprise (WGS84)
 *   dep=67                             filtre sur le département (2A/2B ok)
 *   reg=44                             filtre sur la région
 *   insee=67043,67034                  une ou plusieurs communes par code INSEE
 *   type=...                           filtre sur la catégorie de commune
 *   q=nom                              recherche sur le début du nom
 *   simplif=0.0005                     simplification des contours (degrés)
 *   limite=3000                        nombre maximal de communes (max 50000)
 *
 * Prérequis : PHP 7.4+, extension pdo_pgsql, config.php définissant $conn (PDO).
 */

// ─── Configuration ──────────────────────────────────────────────────────────
const TABLE         = 'public."COM_FR"';
const COLONNE_GEOM  = 'geom';
const SRID_TABLE    = 4326;                 // 2154 si la table est en Lambert-93
const LIMITE_DEFAUT = 3000;
const LIMITE_MAX    = 50000;
const COLONNES = [                          // noms réels des colonnes de la table
    'insee'      => 'code_insee',
    'nom'        => 'nom',
    'dep'        => 'code_dep',
    'reg'        => 'code_reg',
    'population' => 'population',
    'superficie' => 'superficie_km2',
    'type'       => 'type_com',
];

ini_set('display_errors', '0');             // une erreur ne doit jamais casser le JSON
ini_set('display_startup_errors', '0');
ini_set('log_errors', '1');
error_reporting(E_ALL);

header('Access-Control-Allow-Origin: *');
header('Content-Type: application/json; charset=utf-8');

// ─── Fonctions utilitaires ──────────────────────────────────────────────────

/** Envoie une erreur JSON propre et arrête le script. */
function repondreErreur(int $statut, string $message): void
{
    http_response_code($statut);
    header('Cache-Control: no-store');
    echo json_encode(
        ['type' => 'FeatureCollection', 'features' => [], 'error' => $message],
        JSON_UNESCAPED_UNICODE
    );
    exit;
}

/** Nom de colonne entre guillemets, à partir de sa clé logique. */
function col(string $cle): string
{
    return '"' . COLONNES[$cle] . '"';
}

/** Code INSEE sur 5 caractères (8217 => 08217, 2a004 => 2A004). */
function normaliserInsee(string $code): string
{
    return str_pad(strtoupper(trim($code)), 5, '0', STR_PAD_LEFT);
}

// ─── Lecture et validation des paramètres ───────────────────────────────────

$limite = LIMITE_DEFAUT;
if (isset($_GET['limite'])) {
    $limite = max(1, min(LIMITE_MAX, (int) $_GET['limite']));
}

$tolerance = 0.0;
if (isset($_GET['simplif'])) {
    $tolerance = max(0.0, min(0.05, (float) $_GET['simplif']));
}

$where  = [];
$params = [];

// Emprise : l'index GIST sur la géométrie rend ce filtre très rapide.
if (isset($_GET['bbox']) && $_GET['bbox'] !== '') {
    $b = explode(',', (string) $_GET['bbox']);
    if (count($b) !== 4 || count(array_filter($b, 'is_numeric')) !== 4) {
        repondreErreur(400, 'bbox attendu : minLon,minLat,maxLon,maxLat.');
    }
    [$minLon, $minLat, $maxLon, $maxLat] = array_map('floatval', $b);
    if ($minLon >= $maxLon || $minLat >= $maxLat
        || abs($minLon) > 180 || abs($maxLon) > 180
        || abs($minLat) > 90 || abs($maxLat) > 90) {
        repondreErreur(400, 'bbox hors limites.');
    }
    $enveloppe = 'ST_MakeEnvelope(CAST(:minLon AS float8), CAST(:minLat AS float8), '
               . 'CAST(:maxLon AS float8), CAST(:maxLat AS float8), 4326)';
    if (SRID_TABLE !== 4326) {
        $enveloppe = 'ST_Transform(' . $enveloppe . ', ' . SRID_TABLE . ')';
    }
    $where[] = COLONNE_GEOM . ' && ' . $enveloppe;
    $params[':minLon'] = $minLon;
    $params[':minLat'] = $minLat;
    $params[':maxLon'] = $maxLon;
    $params[':maxLat'] = $maxLat;
}

if (isset($_GET['dep']) && $_GET['dep'] !== '') {
    $dep = strtoupper(trim((string) $_GET['dep']));
    if (!preg_match('/^(\d{2,3}|2[AB])$/', $dep)) {
        repondreErreur(400, 'Paramètre dep invalide.');
    }
    $where[] = col('dep') . ' = :dep';
    $params[':dep'] = $dep;
}

if (isset($_GET['reg']) && $_GET['reg'] !== '') {
    $reg = trim((string) $_GET['reg']);
    if (!preg_match('/^\d{2}$/', $reg)) {
        repondreErreur(400, 'Paramètre reg invalide.');
    }
    $where[] = col('reg') . ' = :reg';
    $params[':reg'] = $reg;
}

if (isset($_GET['insee']) && $_GET['insee'] !== '') {
    $codes = [];
    foreach (explode(',', (string) $_GET['insee']) as $c) {
        $c = trim($c);
        if ($c === '' || !ctype_alnum($c) || strlen($c) > 5) {
            repondreErreur(400, 'Paramètre insee invalide.');
        }
        $codes[] = normaliserInsee($c);
    }
    $where[] = col('insee') . " = ANY(string_to_array(CAST(:codes AS text), ','))";
    $params[':codes'] = implode(',', $codes);
}

if (isset($_GET['type']) && $_GET['type'] !== '') {
    $where[] = col('type') . ' = :type';
    $params[':type'] = (string) $_GET['type'];
}

if (isset($_GET['q']) && trim((string) $_GET['q']) !== '') {
    $where[] = col('nom') . ' ILIKE :q';
    $params[':q'] = addcslashes(trim((string) $_GET['q']), '%_\\') . '%';
}

// ─── Requête ────────────────────────────────────────────────────────────────

include_once __DIR__ . '/config.php';
if (!isset($conn) || !($conn instanceof PDO)) {
    error_log('commune.php : $conn (PDO) non défini par config.php');
    repondreErreur(500, 'Connexion à la base indisponible.');
}
$conn->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

// Géométrie de sortie : toujours en WGS84, simplifiée si demandé.
$geom = COLONNE_GEOM;
if (SRID_TABLE !== 4326) {
    $geom = 'ST_Transform(' . $geom . ', 4326)';
}
if ($tolerance > 0) {
    $geom = 'ST_SimplifyPreserveTopology(' . $geom . ', '
          . number_format($tolerance, 6, '.', '') . ')';
}

$sql = 'SELECT ' . implode(', ', [
        col('insee') . ' AS insee',
        col('nom') . ' AS nom',
        col('dep') . ' AS dep',
        col('reg') . ' AS reg',
        col('population') . ' AS population',
        col('superficie') . ' AS superficie',
        col('type') . ' AS type',
        'ST_AsGeoJSON(' . $geom . ', 6) AS geojson',
    ])
    . ' FROM ' . TABLE
    . ' WHERE ' . COLONNE_GEOM . ' IS NOT NULL'
    . ($where ? ' AND ' . implode(' AND ', $where) : '')
    . ' ORDER BY ' . col('nom')
    . ' LIMIT ' . $limite;

try {
    $stmt = $conn->prepare($sql);
    $stmt->execute($params);
} catch (Throwable $e) {
    error_log('commune.php : ' . $e->getMessage());
    repondreErreur(500, 'Données cartographiques temporairement indisponibles.');
}

// ─── Réponse en flux ────────────────────────────────────────────────────────
// Un feature à la fois : la mémoire reste constante quelle que soit la taille.
// La géométrie est déjà en JSON côté PostGIS, on l'insère telle quelle.

header('Cache-Control: public, max-age=300');
ini_set('zlib.output_compression', 'On');

echo '{"type":"FeatureCollection","features":[';

$premier = true;
$nombre  = 0;
$erreur  = false;

try {
    while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
        $props = [
            'code'       => normaliserInsee((string) $row['insee']),
            'nom'        => $row['nom'],
            'code_dep'   => $row['dep'],
            'code_reg'   => $row['reg'],
            'population' => $row['population'] === null ? null : (int) $row['population'],
            'superficie' => $row['superficie'] === null ? null : round((float) $row['superficie'], 2),
            'type_com'   => $row['type'],
        ];
        $json = json_encode(
            $props,
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE
        );
        echo $premier ? '' : ',';
        echo '{"type":"Feature","geometry":', $row['geojson'],
             ',"properties":', ($json !== false ? $json : '{}'), '}';
        $premier = false;
        $nombre++;
    }
} catch (Throwable $e) {
    error_log('commune.php (lecture) : ' . $e->getMessage());
    $erreur = true;
}

echo '],"count":', $nombre;
echo ',"truncated":', ($nombre >= $limite ? 'true' : 'false');
if ($erreur) {
    echo ',"error":"Lecture interrompue."';
}
echo '}';

$stmt = null;
$conn = null;