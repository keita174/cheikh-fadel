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
$ville = isset($_GET['ville']) ? $_GET['ville'] : '*';

// Préparation SQL
if ($ville === '*') {
    $sql = "SELECT 
                id, name, amenity, dispensing, wheelchair,
                \"addr-housenumber\", \"addr-street\", \"addr-city\", \"addr-postcode\",
                phone, \"contact-phone\", opening_hours, \"ref-FR-FINESS\",
                ST_AsGeoJSON(ST_Transform(geom, 4326)) AS geojson
            FROM public.pharmacie
            ORDER BY id ASC";
} else {
    $sql = "SELECT 
                id, name, amenity, dispensing, wheelchair,
                \"addr-housenumber\", \"addr-street\", \"addr-city\", \"addr-postcode\",
                phone, \"contact-phone\", opening_hours, \"ref-FR-FINESS\",
                ST_AsGeoJSON(ST_Transform(geom, 4326)) AS geojson 
            FROM public.pharmacie 
            WHERE \"addr-city\" = :ville
            ORDER BY id ASC";
}

try {
    $stmt = $conn->prepare($sql);

    if ($ville !== '*') {
        $stmt->bindParam(':ville', $ville, PDO::PARAM_STR);
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