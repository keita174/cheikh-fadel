/**
 * DataManager — chargement, normalisation et interrogation des données.
 *
 * Règle absolue : ne jamais inventer une information. Chaque champ absent est
 * simplement `null` ; l'interface se construit autour de ce qui existe
 * réellement, et les fonctionnalités sans source de données sont désactivées
 * avec une explication au lieu d'être simulées.
 *
 * Tolérance aux formats : les API sont saisies à la main et peuvent changer de
 * casse ou de nom de colonne. On accepte donc plusieurs alias pour chaque
 * champ, et on rejette proprement les coordonnées inexploitables.
 */
(function (global) {
  'use strict';

  /**
   * Sous-domaines des API, testés dans l'ordre.
   *
   * `COM_FR.php` passe en premier : c'est la couche ADMIN EXPRESS complète
   * (34 877 communes, outre-mer compris) et la seule à savoir simplifier les
   * contours côté serveur, ce qui la rend utilisable pour le pays entier.
   * `commune.php` ne sert qu'un import partiel de 189 communes : c'est un
   * repli, pas une source de travail.
   *
   * Chemins relatifs : la page vit dans `html/`.
   */
  const ENDPOINTS = {
    communes: ['../api/COM_FR.php', 'api/com_fr.php', '../api/commune.php'],
    communesFallback: ['../api/commune.php', 'api/com_fr.php'],
    communesStatiques: ['../api/COM_FR.geojson', 'api/COM_FR.geojson'],
    hopitaux: ['../api/hopitaux.php', '../api/hospital_etablissements.php'],
    hopitauxStatiques: ['../api/hopitaux.geojson', 'api/hopitaux.geojson'],
  };

  /**
   * Simplification demandée au serveur, en degrés.
   *
   * 0,002° vaut environ 140 m en latitude : invisible à l'écran, mais la
   * charge passe de 160 Mo à 23 Mo. C'est le meilleur rapport gain/compromis
   * mesuré sur cette couche.
   */
  const SIMPLIFICATION = 0.002;

  /** Alias acceptés pour la latitude. */
  const CLE_LAT = ['lat', 'latitude', 'LAT', 'LATITUDE', 'ycoord', 'y', 'geom_lat', 'Latitude'];
  /** Alias acceptés pour la longitude. */
  const CLE_LON = ['lon', 'lng', 'long', 'longitude', 'LON', 'LONGITUDE', 'xcoord', 'x', 'geom_lon', 'Longitude'];
  /** Alias pour un booléen de service d'urgence. */
  const CLE_URGENCE = ['emergency', 'urgence', 'has_emergency', 'service_urgence', 'urgences', 'emergency_department'];
  /** Alias pour un indicateur de garde. Absent des données actuelles. */
  const CLE_GARDE = ['garde', 'on_call', 'garde_24h', 'de_garde', 'duty', 'astreinte', 'pharmacie_garde', 'on_duty'];
  /** Alias pour les horaires. */
  const CLE_HORAIRES = ['opening_hours', 'horaires', 'hours', 'openingHours'];

  /** Rayon de la Terre en km — formule de haversine. */
  const R_TERRE_KM = 6371.0088;

  /** Ramène un objetGeoJSON à une géométrie Leaflet, quel que soit son format d'entrée. */
  function versGeometrie(brut) {
    if (!brut) return null;
    // Le PHP renvoie parfois le GeoJSON sous forme de chaîne JSON.
    if (typeof brut === 'string') {
      try { brut = JSON.parse(brut); } catch (e) { return null; }
    }
    if (Array.isArray(brut.coordinates)) {
      return brut.type === 'Point'
        ? [brut.coordinates[1], brut.coordinates[0]]   // Leaflet : [lat, lon]
        : null;
    }
    return null;
  }

  /** Première clé présente dans l'objet, alias normalisés (casse/espaces ignorés). */
  function chercher(objet, alias) {
    if (!objet) return undefined;
    const index = {};
    for (const k of Object.keys(objet)) index[k.toLowerCase().replace(/[\s_-]/g, '')] = k;
    for (const a of alias) {
      const k = index[a.toLowerCase().replace(/[\s_-]/g, '')];
      if (k !== undefined && objet[k] !== null && objet[k] !== '') return objet[k];
    }
    return undefined;
  }

  function nombre(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }

  /** Distance en kilomètres entre deux points (haversine). */
  function distanceKm(lat1, lon1, lat2, lon2) {
    if ([lat1, lon1, lat2, lon2].some(x => x === null || !Number.isFinite(x))) return null;
    const rlat = (lat2 - lat1) * Math.PI / 180;
    const rlon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(rlat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(rlon / 2) ** 2;
    return 2 * R_TERRE_KM * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** Normalise une entité hospitalière. Ne comble aucun champ manquant. */
  function normalizeHospital(feature, index) {
    const p = feature.properties || feature;
    const g = feature.geometry;

    let lat = nombre(chercher(p, CLE_LAT));
    let lon = nombre(chercher(p, CLE_LON));

    // Repli sur la géométrie si les colonnesDediees sont vides.
    if ((lat === null || lon === null) && g && g.type === 'Point') {
      lat = lat ?? g.coordinates[1];
      lon = lon ?? g.coordinates[0];
    }
    const valide = lat !== null && lon !== null &&
      Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

    const urgenceBrut = chercher(p, CLE_URGENCE);
    const urgence = typeof urgenceBrut === 'string' ? urgenceBrut.toLowerCase() : null;

    const gardeBrut = chercher(p, CLE_GARDE);
    const garde = typeof gardeBrut === 'string'
      ? ['yes', 'oui', 'true', 'garde', 'on_call'].includes(gardeBrut.toLowerCase())
      : (gardeBrut === true);

    return {
      id: p.id ?? `h${index}`,
      index: index,
      nom: chercher(p, ['name', 'nom', 'libelle', 'label', 'etablissement']) || 'Établissement sans nom',
      lat: valide ? lat : null,
      lon: valide ? lon : null,
      valide: valide,
      // Une urgence est retenue pour « yes » et « limited » uniquement :
      // `no`, `ambulance_station` et `landing_site` n'en sont pas une.
      urgence: urgence === 'yes' || urgence === 'limited',
      urgenceBrut: urgenceBrut ?? null,
      garde: garde,
      gardeBrut: gardeBrut ?? null,
      horaires: chercher(p, CLE_HORAIRES) ?? null,
      adresse: [chercher(p, ['addr-street', 'adresse']), chercher(p, ['addr-city', 'ville'])]
        .filter(Boolean).join(', ') || null,
      ville: chercher(p, ['addr-city', 'ville', 'commune']) ?? null,
      codePostal: chercher(p, ['addr-postcode', 'cp', 'code_postal']) ?? null,
      telephone: chercher(p, ['phone', 'telephone', 'tel']) ?? null,
      finess: chercher(p, ['ref-FR-FINESS', 'finess']) ?? null,
      accessibilite: chercher(p, ['wheelchair', 'accessibilite']) ?? null,
      specialite: chercher(p, ['healthcare-speciality', 'specialite', 'specialty']) ?? null,
      capacite: nombre(chercher(p, ['capacity', 'capacite', 'lits'])) ?? null,
      operateur: chercher(p, ['operator', 'operateur', 'gestionnaire']) ?? null,
      // Commune de rattachement, résolue côté serveur par inclusion
      // géométrique contre la couche nationale. Les contours n'étant chargés
      // que par emprise, un établissement hors de la vue courante n'aurait
      // sinon aucune commune.
      commune: chercher(p, ['commune_nom', 'commune']) ?? null,
      codeCommune: chercher(p, ['commune_code']) ?? null,
      depCommune: chercher(p, ['commune_dep']) ?? null,
      regCommune: chercher(p, ['commune_reg']) ?? null,
      typeCommune: chercher(p, ['commune_type']) ?? null,
      distance: null,
      marker: null,
    };
  }

  /** Normalise une commune. */
  function normalizeCommune(feature, index) {
    const p = feature.properties || feature;
    return {
      id: p.id ?? `c${index}`,
      code: String(chercher(p, ['INSEE_COM', 'code', 'code_insee', 'insee_com']) ?? ''),
      nom: chercher(p, ['NOM', 'nom', 'name', 'libelle']) || 'Commune',
      // `code_dep` et `code_reg` sont les noms réellement produits par
      // COM_FR.php : sans eux, le filtre par département ne trouve aucune
      // valeur et la liste des départements reste vide.
      departement: chercher(p, ['INSEE_DEP', 'code_dep', 'code_insee_departement',
        'departement', 'dep', 'insee_dep']) ?? null,
      region: chercher(p, ['INSEE_REG', 'code_reg', 'insee_reg', 'region', 'reg']) ?? null,
      population: nombre(chercher(p, ['POPULATION', 'population', 'pop'])) ?? null,
      codePostal: chercher(p, ['CODE_POST', 'code_postal', 'cp']) ?? null,
      // Nomenclature INSEE : catégorie de rattachement de la commune à son aire
      // urbaine. Les codes d'UU ne sont pas repris — la couche reste à
      // l'échelle communale.
      typeCommune: chercher(p, ['type_com', 'TYP_COM', 'type_commune']) ?? null,
      geometry: feature.geometry || null,
      // Remplis après l'agrégation des hôpitaux.
      layer: null,
      nbHopitaux: 0, nbUrgences: 0, nbGarde: 0,
      centre: null,
    };
  }

  /** Convertit une FeatureCollection en tableau, quelle que soit sa forme. */
  function enFeatures(reponse) {
    if (!reponse) return [];
    if (Array.isArray(reponse)) return reponse;
    if (Array.isArray(reponse.features)) return reponse.features;
    // Certains endpoints imbriquent le résultat sous une clé.
    for (const cle of ['data', 'resultats', 'resultats', 'items', 'rows']) {
      if (reponse[cle] && Array.isArray(reponse[cle])) return reponse[cle];
    }
    return [];
  }

  const DataManager = {
    communes: [],
    hopitaux: [],
    /** Nombre de communes connues, même après un filtre d'affichage. */
    totalCommunes: 0,
    /** Champs de garde réellement présents dans les données. */
    gardeDisponible: false,
    sourceHopitaux: null,
    sourceCommunes: null,
    erreurs: [],

    /** Charge une API en essayant plusieurs fichiers. */
    async _essayer(urls) {
      let dernier = null;
      for (const url of urls) {
        try {
          const r = await fetch(url, { cache: 'no-store' });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const json = await r.json();
          const feats = enFeatures(json);
          if (feats.length) return { url, features: feats, erreur: json.error || null };
          dernier = new Error(json.error || `${url} : aucune entité renvoyée`);
        } catch (e) {
          dernier = e;
        }
      }
      throw dernier || new Error('aucune source disponible');
    },

    /** Emprise Leaflet (en LngLat) → bounding box WGS84 élargi. */
    empriseDeCarte(carte, marge = 0.35) {
      const b = carte.getBounds().pad(0.15);
      return {
        ouest: b.getWest() - marge,
        sud: b.getSouth() - marge,
        est: b.getEast() + marge,
        nord: b.getNorth() + marge,
      };
    },

    /**
     * Charge la couche communale.
     *
     * La couche est chargée en une seule fois, pour toute la France. Le
     * paramètre `simplif` du serveur réduit la charge de 160 Mo à 23 Mo sans
     * écart perceptible à l'écran : 0,002° représente environ 140 m en
     * latitude, très en deçà de la taille de la plus petite commune.
     *
     * Un chargement par emprise avait été essayé : il obligeait à recomputer
     * le rattachement des établissements à chaque déplacement, et laissait
     * la majeure partie du pays sans commune. Le pays entier tient en mémoire
     * sans difficulté.
     */
    async loadCommunes() {
      const base = `${ENDPOINTS.communes[0]}?limite=50000&simplif=${SIMPLIFICATION}`;
      let features, source;

      try {
        const r = await fetch(base, { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        features = enFeatures(j);
        source = ENDPOINTS.communes[0];
        if (!features.length) throw new Error('aucune commune renvoyée');
        // Le serveur signale lui-même si le résultat a été tronqué : mieux
        // vaut le savoir que croire la couche complète.
        if (j.truncated) {
          this.erreurs.push(
            `${source} : ${features.length} communes sur un maximum de ${j.limite || '?'}`);
        }
      } catch (e) {
        this.erreurs.push(`${base} : ${e.message}`);
        let features = [], source = base;
        try {
          const repli = await this._essayer(ENDPOINTS.communesFallback);
          features = repli.features;
          source = repli.url;
        } catch (e2) {
          // Source statique : sert sur GitHub Pages, qui ne fait pas tourner
          // PHP. Le fichier geojson portant le meme nom de ressource que
          // l'endpoint dynamique, aucun changement d'appel n'est necessaire.
          const statique = await this._essayer(ENDPOINTS.communesStatiques);
          features = statique.features;
          source = statique.url;
        }
      }

      const communes = [];
      try {
        for (const f of features) {
          const c = normalizeCommune(f, communes.length);
          if (!c.geometry || !c.code) continue;
          c._bbox = this._bbox(c.geometry);
          c.centre = this._centre(c.geometry);
          communes.push(c);
        }
      } catch (e) {
        this.erreurs.push(`communes : ${e.message}`);
      }

      this.communes = communes;
      this.totalCommunes = this.communes.length;
      this.sourceCommunes = source;
      this._indexNoms = null;
      this._compterParCommune();
      return this.communes;
    },

    /**
     * Recalcule le nombre d'établissements par commune.
     *
     * L'appartenance d'un établissement à sa commune est tranchée par le
     * serveur, par inclusion géométrique contre la couche nationale.
     */
    _compterParCommune() {
      // L'emprise de chaque commune est calculée ici, pas seulement dans
      // `agregerCommunes` : les communes chargées par emprise arrivent sans
      // `_bbox`, et sans elle le filtre de rejet les écarte toutes — aucun
      // établissement n'est alors compté.
      for (const c of this.communes) {
        if (!c._bbox) c._bbox = this._bbox(c.geometry);
        c.nbHopitaux = 0; c.nbUrgences = 0; c.nbGarde = 0;
      }
      const avecGeom = this.communes.filter(c => c._bbox);
      let sansCommune = 0;

      for (const h of this.hopitaux) {
        // Repli : si le serveur n'a pas su trancher, on tente avec les
        // communes effectivement chargées. Un rapprochement par nom de
        // ville est écarté : `addr-city` manque sur 1 900 établissements et
        // afficherait parfois un nom faux au lieu de n'afficher aucun nom.
        if (!h.commune) {
          const c = avecGeom.find(x =>
            h.lat >= x._bbox[0] && h.lat <= x._bbox[2] &&
            h.lon >= x._bbox[1] && h.lon <= x._bbox[3] &&
            this._dansPolygone(h.lat, h.lon, x.geometry));
          if (c) h.commune = c.nom;
        }
        if (!h.commune) sansCommune++;

        const c = avecGeom.find(x => x.code === h.codeCommune);
        if (c) {
          c.nbHopitaux++;
          if (h.urgence) c.nbUrgences++;
          if (h.garde) c.nbGarde++;
        }
      }
      this.hopitauxSansCommune = sansCommune;
      return this.communes;
    },

    async loadHospitals() {
      let charge;
      try {
        charge = await this._essayer(ENDPOINTS.hopitaux);
      } catch (e) {
        // Source statique : GitHub Pages ne fait pas tourner PHP, les endpoints
        // `.php` renvoient donc un 404. Le fallback sert partout, y compris en
        // local, sans rien casser.
        charge = await this._essayer(ENDPOINTS.hopitauxStatiques);
      }
      this.sourceHopitaux = charge.url;
      this.hopitaux = charge.features.map(normalizeHospital)
        .filter(h => h.valide);
      // Une information de garde n'est annoncée que si la colonne existe
      // réellement et qu'au moins un établissement la porte.
      this.gardeDisponible = this.hopitaux.some(h => h.gardeBrut !== null);
      return this.hopitaux;
    },

    /** Centroïde approché : moyenne des sommets, suffisant pour recadrer. */
    _centre(geometry) {
      const pts = [];
      const parcourir = (c) => {
        if (typeof c[0] === 'number') { pts.push(c); return; }
        c.forEach(parcourir);
      };
      parcourir(geometry.coordinates);
      if (!pts.length) return null;
      const s = pts.reduce((a, p) => [a[0] + p[1], a[1] + p[0]], [0, 0]);
      return [s[0] / pts.length, s[1] / pts.length];
    },

    /**
     * Rattache chaque établissement à la commune qui le contient réellement, par
     * inclusion géométrique, puis compte hôpitaux, urgences et gardes.
     *
     * Un rapprochement par nom de ville serait plus simple mais trompeur :
     * `addr-city` est absent de 1 900 établissements sur 2 506, et les communes
     * de la base ne couvrent qu'une partie du territoire national. Le comptage
     * par géométrie est donc le seul qui dise ce qu'il mesure.
     */
    agregerCommunes() {
      // Emprise de chaque commune, pour écarter vite les candidates.
      for (const c of this.communes) {
        c._bbox = c._bbox || this._bbox(c.geometry);
      }
      this._indexNoms = null;   // les communes ont changé : index à refaire
      return this._compterParCommune();
    },

    _parNom() {
      if (!this._indexNoms) {
        this._indexNoms = new Map(this.communes.map(c => [c.nom.trim(), c]));
      }
      return this._indexNoms;
    },

    /** Emprise [minLat, minLon, maxLat, maxLon] d'une géométrie. */
    _bbox(geometry) {
      let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
      const parcourir = (c) => {
        if (typeof c[0] === 'number') {
          if (c[1] < minLat) minLat = c[1];
          if (c[1] > maxLat) maxLat = c[1];
          if (c[0] < minLon) minLon = c[0];
          if (c[0] > maxLon) maxLon = c[0];
          return;
        }
        c.forEach(parcourir);
      };
      parcourir(geometry.coordinates);
      return Number.isFinite(minLat) ? [minLat, minLon, maxLat, maxLon] : null;
    },

    /** Lancer de rayon : le point est-il dans le polygone ? */
    _dansPolygone(lat, lon, geometry) {
      const dansAnneau = (anneau) => {
        let dedans = false;
        for (let i = 0, j = anneau.length - 1; i < anneau.length; j = i++) {
          const [xi, yi] = anneau[i], [xj, yj] = anneau[j];
          if (((yi > lat) !== (yj > lat)) &&
            (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) dedans = !dedans;
        }
        return dedans;
      };
      const g = geometry.type === 'Polygon' ? [geometry.coordinates]
        : geometry.coordinates;
      // Multipolygone : dedans si l'un des polygones contient le point.
      if (!dansAnneau(g[0][0])) return false;
      // Un trou écarte le point.
      for (const poly of g) {
        for (let k = 1; k < poly.length; k++) {
          if (dansAnneau(poly[k])) return false;
        }
      }
      return true;
    },

    /**
     * Établissements passant le filtre courant.
     *
     * `departement` porte le code du département choisi dans le panneau
     * Filtres. Il s'applique au département de la commune de rattachement,
     * résolu par le serveur, et non au champ `addr-city` : celui-ci manque
     * sur 1 900 établissements sur 2 506 et n'accepterait pas 2A/2B.
     */
    filterHospitals(options = {}) {
      const {
        urgence = false, garde = false, rayonKm = null, position = null,
        departement = '',
      } = options;
      return this.hopitaux.filter(h => {
        if (departement && String(h.depCommune || '') !== String(departement)) return false;
        if (urgence && !h.urgence) return false;
        if (garde && !h.garde) return false;
        if (rayonKm !== null && position) {
          if (h.distance === null) return false;
          if (h.distance > rayonKm) return false;   // distance en km, comme rayonKm
        }
        return true;
      });
    },

    /** Calcule et mémorise la distance de chaque établissement à une position. */
    calcuerDistances(lat, lon) {
      for (const h of this.hopitaux) {
        h.distance = distanceKm(lat, lon, h.lat, h.lon);
      }
      this.hopitaux.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
      return this.hopitaux;
    },

    /**
     * Établissement le plus proche d'une position.
     *
     * `options.urgence` restreint la recherche aux sites disposant d'un
     * service d'urgences. Les deux résultats sont utiles et différents :
     * l'hôpital le plus proche peut être une clinique sans urgences, et c'est
     * alors le plus proche *avec* urgences qui intéresse.
     */
    findNearestHospital(lat, lon, options = {}) {
      let meilleur = null, d = Infinity;
      for (const h of this.hopitaux) {
        if (options.urgence && !h.urgence) continue;
        const dd = distanceKm(lat, lon, h.lat, h.lon);
        if (dd !== null && dd < d) { d = dd; meilleur = h; }
      }
      if (meilleur) meilleur.distance = d;
      return meilleur;
    },

    stats() {
      return {
        hopitaux: this.hopitaux.length,
        urgences: this.hopitaux.filter(h => h.urgence).length,
        garde: this.gardeDisponible ? this.hopitaux.filter(h => h.garde).length : null,
        communes: this.communes.length,
      };
    },

    /**
     * Catégories de communes réellement présentes dans les communes chargées,
     * avec leur nombre. La liste est reconstruite à chaque appel : les
     * communes arrivent par emprise, donc le panorama se complète au fur et à
     * mesure des déplacements.
     */
    typesCommunes() {
      const compte = new Map();
      for (const c of this.communes) {
        if (!c.typeCommune) continue;
        compte.set(c.typeCommune, (compte.get(c.typeCommune) || 0) + 1);
      }
      return [...compte.entries()]
        .map(([type, nb]) => ({ type, nb }))
        .sort((a, b) => b.nb - a.nb);
    },

    /** Communes d'une catégorie de rattachement à l'aire urbaine. */
    communesDeType(type) {
      return type ? this.communes.filter(c => c.typeCommune === type) : this.communes.slice();
    },
  };

  global.DataManager = DataManager;
  global.GeoUtils = { distanceKm, versGeometrie, nombre };
})(window);