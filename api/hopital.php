<?php
// Toujours afficher les erreurs en dev (désactive en prod si besoin)
ini_set('display_errors', 1);
ini_set('display_startup_errors', 1);
error_reporting(E_ALL);

// En-têtes HTTP
header("Access-Control-Allow-Origin: *");
header('Content-Type: application/json; charset=utf-8');

// Connexion
include_once('config.php');

// Récup param
$departement = isset($_GET['departement']) ? $_GET['departement'] : '*';

// Préparation SQL
if ($departement === '*') {
    $sql = "SELECT 
                id, \"INSEE_COM\", \"NOM\", \"INSEE_DEP\", \"INSEE_REG\", 
                \"POPULATION\", \"CODE_POST\",
                ST_AsGeoJSON(ST_Transform(geom, 4326)) AS geojson
            FROM public.\"COMMUNE\"
            ORDER BY id ASC";
} else {
    $sql = "SELECT 
                id, \"INSEE_COM\", \"NOM\", \"INSEE_DEP\", \"INSEE_REG\", 
                \"POPULATION\", \"CODE_POST\",
                ST_AsGeoJSON(ST_Transform(geom, 4326)) AS geojson 
            FROM public.\"COMMUNE\" 
            WHERE \"INSEE_DEP\" = :departement
            ORDER BY id ASC";
}

try {
    $stmt = $conn->prepare($sql);

    if ($departement !== '*') {
        $stmt->bindParam(':departement', $departement, PDO::PARAM_STR);
    }

    $stmt->execute();

    $geojson = [
        'type' => 'FeatureCollection',
        'features' => []
    ];

    while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
        if (!$row['geojson']) continue;

        $properties = $row;
        unset($properties['geojson'], $properties['geom']);

        $feature = [
            'type' => 'Feature',
            'geometry' => json_decode($row['geojson'], true),
            'properties' => $properties
        ];
        $geojson['features'][] = $feature;
    }

    echo json_encode($geojson, JSON_NUMERIC_CHECK | JSON_UNESCAPED_UNICODE);

} catch (Exception $e) {
    // Toujours renvoyer un JSON valide même en cas d'erreur
    echo json_encode([
        'type' => 'FeatureCollection',
        'features' => [],
        'error' => $e->getMessage()
    ]);
}

$conn = null;
exit;