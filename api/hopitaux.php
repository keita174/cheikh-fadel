<?php
/**
 * Établissements de santé (table public.hospitals_france).
 *
 * Complète commune.php et hopital.php, qui interrogent tous deux la table
 * des communes et renvoient donc les mêmes 189 entités.
 *
 * Paramètres acceptés (tous optionnels) :
 *   ?departement=13   filtre sur le code du champ libre associé à l'établissement
 *   ?urgence=1        ne renvoie que les établissements avec un service d'urgence
 *   ?bbox=minLon,minLat,maxLon,maxLat   filtre spatial sur l'emprise de la carte
 */
ini_set('display_errors', 0);   // une erreur ne doit jamais polluer le JSON
ini_set('display_startup_errors', 0);
error_reporting(E_ALL);

header('Access-Control-Allow-Origin: *');
header('Content-Type: application/json; charset=utf-8');

include_once('config.php');

$urgence  = isset($_GET['urgence']) ? $_GET['urgence'] : '';
$bbox     = isset($_GET['bbox']) ? $_GET['bbox'] : '';
$departement = isset($_GET['departement']) ? $_GET['departement'] : '';

$champs = 'id, name, amenity, emergency, capacity, wheelchair, operator,
           "addr-housenumber", "addr-street", "addr-city", "addr-postcode",
           phone, "contact-phone", "ref-FR-FINESS", "healthcare-speciality",
           lon, lat';

$where = [];
$params = [];

// Filtre spatial : l'index GIST sur geom rend ce tri par emprise très rapide.
if ($bbox !== '' && is_array($b = explode(',', $bbox)) && count($b) === 4) {
    list($minLon, $minLat, $maxLon, $maxLat) = array_map('floatval', $b);
    $where[] = 'h.geom && ST_MakeEnvelope(:minLon, :minLat, :maxLon, :maxLat, 4326)';
    $params[':minLon'] = $minLon; $params[':minLat'] = $minLat;
    $params[':maxLon'] = $maxLon; $params[':maxLat'] = $maxLat;
}

// Urgences : `yes` et `limited` sont retenues, `no` et NULL sont exclus.
if ($urgence === '1') {
    $where[] = 'h.emergency IN (\'yes\', \'limited\')';
}

// Commune de rattachement, résolue par inclusion géométrique contre
// public."COM_FR" (34 875 communes). Elle est calculée ici, et non dans le
// navigateur : les contours ne sont chargés que par emprise, donc un
// établissement hors de la vue courante n'aurait sinon aucune commune.
// Un LEFT JOIN garde l'établissement même quand il ne tombe dans aucune
// commune (point en mer, coordonnées douteuses) : il vaut mieux une ligne
// sans commune qu'un établissement disparu.
$jointure = '
        LEFT JOIN LATERAL (
            SELECT c.nom, c.code_insee, c.code_dep, c.code_reg, c.type_com
            FROM public."COM_FR" c
            WHERE c.geom && ST_SetSRID(ST_MakePoint(h.lon, h.lat), 4326)
              AND ST_Contains(c.geom, ST_SetSRID(ST_MakePoint(h.lon, h.lat), 4326))
            LIMIT 1
        ) c ON TRUE';

$sql = "SELECT $champs,
               c.nom        AS commune_nom,
               c.code_insee AS commune_code,
               c.code_dep   AS commune_dep,
               c.code_reg   AS commune_reg,
               c.type_com   AS commune_type
        FROM public.hospitals_france h$jointure";
if ($where) {
    // Les filtres portent sur la table des établissements, préfixée `h`.
    $sql .= ' WHERE ' . implode(' AND ', $where);
}
$sql .= ' ORDER BY h.id ASC';

try {
    $stmt = $conn->prepare($sql);
    $stmt->execute($params);

    $geojson = ['type' => 'FeatureCollection', 'features' => []];
    while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
        // `lon`/`lat` sont déjà en WGS84 : on construit un Point à partir d'eux
        // plutôt que de transformer la géométrie, plus coûteux et sans gain.
        if ($row['lon'] === null || $row['lat'] === null) {
            continue;
        }
        unset($row['geojson']);

        // Les champs numériques sont convertis explicitement. On n'utilise pas
        // JSON_NUMERIC_CHECK : ce drapeau transforme aussi les chaînes de
        // chiffres, et le code INSEE '75056' deviendrait le nombre 75056. Le
        // rapprochement avec la couche des communes se fait par code, donc
        // le type doit rester une chaîne.
        $row['lon'] = (float) $row['lon'];
        $row['lat'] = (float) $row['lat'];
        $row['capacity'] = is_numeric($row['capacity'])
            ? (int) $row['capacity'] : null;

        $geojson['features'][] = [
            'type' => 'Feature',
            'geometry' => [
                'type' => 'Point',
                'coordinates' => [$row['lon'], $row['lat']],
            ],
            'properties' => $row,
        ];
    }

    echo json_encode($geojson, JSON_UNESCAPED_UNICODE);

} catch (Exception $e) {
    http_response_code(500);
    echo json_encode([
        'type' => 'FeatureCollection',
        'features' => [],
        'error' => 'Établissements momentanément indisponibles.',
    ], JSON_UNESCAPED_UNICODE);
}

$conn = null;
exit;