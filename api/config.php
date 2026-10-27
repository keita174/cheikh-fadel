<?php
$host = 'localhost';
$dbname = 'l3geom';
$dbuser = 'postgres';
$dbpass = 'gavi3010';
$port=5432;

try{
    $conn = new PDO("pgsql:dbname=$dbname;host=$host;port=$port", $dbuser, $dbpass);
    //echo "Connexion reussie";
}
catch (PDOException $e) { echo "Erreur : " . $e->getMessage();}
?>