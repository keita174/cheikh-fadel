@echo off
REM ===================================================================
REM  Carte medicale - lanceur
REM
REM  Demarre Apache s'il ne l'est pas, puis ouvre la page sur
REM  http://localhost. Cette adresse est obligatoire : ouverte en file://,
REM  le navigateur bloque fetch() (CORS) et PHP n'est pas execute.
REM
REM  Le projet doit se trouver sous le DocumentRoot d'Apache
REM  (C:\xampp\htdocs par defaut).
REM ===================================================================
setlocal enabledelayedexpansion

set "XAMPP=C:\xampp"
set "APACHE=%XAMPP%\apache\bin\httpd.exe"
set "RACINE=%~dp0"
set "PORT=80"

echo.
echo   Carte medicale - demarrage...
echo.

if not exist "%APACHE%" (
    echo   [X] Apache introuvable : "%APACHE%"
    echo       Verifiez que XAMPP est installe dans C:\xampp
    echo.
    pause
    exit /b 1
)

REM --- Apache ecoute-t-il deja sur le port 80 ? -------------------------------
set "DEJA=non"
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if not errorlevel 1 set "DEJA=oui"

if "!DEJA!"=="oui" (
    echo   [1/2] Apache est deja demarre.
) else (
    echo   [1/2] Demarrage d'Apache...
    start "" /B "%APACHE%" -d "%XAMPP%\apache"
    ping -n 3 127.0.0.1 >nul
    powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
    if errorlevel 1 (
        echo.
        echo   [X] Apache n'ecoute toujours pas sur le port %PORT%.
        echo       Verifiez que le port n'est pas occupe par un autre programme,
        echo       ou lancez XAMPP depuis le Panneau de configuration.
        echo.
        pause
        exit /b 1
    )
)

REM --- Chemin web du projet --------------------------------------------------
REM Apache sert "%XAMPP%\htdocs" : on retire ce prefixe pour obtenir le chemin
REM web, puis on encode chaque segment (l'espace du nom de dossier doit
REM devenir %%20). Le remplacement se fait par chaine, pas par longueur.
set "DOSPATH=%RACINE:~0,-1%"
set "DOCROOT=%XAMPP%\htdocs"
set "WEBPATH=%DOSPATH:%DOCROOT%=%"
if "%WEBPATH%"=="%DOSPATH%" set "WEBPATH=%DOSPATH:\=/%"
set "WEBPATH=%WEBPATH:\=/%"

REM Le chemin est converti par PowerShell (lecture des variables d'environnement
REM du process enfant) : cela evite tout conflit de guillemets entre le
REM fichier batch et la ligne de commande PowerShell. Le separateur de `for /f`
REM est un accent grave, ce qui laisse les apostrophes libres a l'interieur.
set "URIPATH="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$d=$env:DOSPATH; $r=$env:DOCROOT; if($d.StartsWith($r)){$p=$d.Substring($r.Length)}else{$p=$d}; -join ((($p.Replace([char]92,[char]47)).Trim('/') -split '/') | ForEach-Object { [uri]::EscapeDataString($_) })"`) do set "URIPATH=%%i"

set "URL=http://localhost/%URIPATH%/index.html"

echo   [2/2] Ouverture de la page...
echo.
echo        %URL%
echo.
start "" "%URL%"

endlocal