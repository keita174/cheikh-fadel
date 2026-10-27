/**
 * MapView — carte, marqueurs, communes, filtres visuels.
 *
 * Les marqueurs sont des SVG dessinés à la main : les marqueurs par défaut de
 * Leaflet ne permettent pas de distinguer urgence / garde par la forme seule,
 * or l'information ne doit pas reposer sur la couleur (accessibilité).
 */
(function (global) {
  'use strict';

  // Le marqueur est du SVG injecté dans la page : `L.icon()` ne sait pas
  // renderer du HTML (il utilise `iconUrl` et produirait une image vide), il
  // faut donc `L.divIcon`. `className` vide pour ne pas hériter du cadre blanc
  // par défaut de Leaflet.
  function iconeLeaflet(type) {
    return L.divIcon({
      html: icone(type),
      className: '',
      iconSize: [32, 32],
      iconAnchor: [16, 32],
      popupAnchor: [0, -28],
    });
  }

  const PALETTE = {
    hopital: '#2563eb',
    urgence: '#dc2626',
    garde: '#16a34a',
    urgenceGarde: '#7c3aed',
    position: '#0f172a',
  };

  /** Icône SVG pour un établissement. */
  function icone(type) {
    const c = PALETTE[type];
    // Animation discrète : halo pour la garde, pulsation pour l'urgence.
    const defs = type === 'urgence'
      ? '<animate attributeName="r" values="6;11;6" dur="2.4s" repeatCount="indefinite"/>'
      : type === 'garde'
        ? '<animate attributeName="opacity" values="0.35;0.05;0.35" dur="2.6s" repeatCount="indefinite"/>'
        : '';
    const halo = type === 'garde'
      ? `<circle cx="16" cy="16" r="14" fill="${c}" opacity="0.18">${defs}</circle>` : '';
    const croix = type === 'urgence'
      ? `<path d="M14.2 10.6h3.6v3.6h3.6v3.6h-3.6v3.6h-3.6v-3.6h-3.6v-3.6h3.6z" fill="#fff"/>`
      : `<path d="M14 10.8h4v3.2h3.2v4H18v3.2h-4V18h-3.2v-4H14z" fill="#fff"/>`;
    return `<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
      ${halo}
      ${type === 'urgence'
        ? `<circle cx="16" cy="16" r="13" fill="none" stroke="${c}" stroke-width="2" opacity="0.5">${defs}</circle>` : ''}
      <path d="M16 2c-4.4 0-8 3.5-8 7.9 0 6 8 20.1 8 20.1s8-14.1 8-20.1c0-4.4-3.6-7.9-8-7.9z"
            fill="${c}" stroke="#fff" stroke-width="1.5"/>
      ${croix}
    </svg>`;
  }

  function typeDe(h) {
    if (h.urgence && h.garde) return 'urgenceGarde';
    if (h.urgence) return 'urgence';
    if (h.garde) return 'garde';
    return 'hopital';
  }

  const MapView = {
    carte: null,
    couches: {},
    groupes: {},
    _markers: new Map(),   // id → marker, pour réutiliser au lieu de recréer
    _selectionCommune: null,
    /** Code du département filtré, ou chaîne vide. */
    filtreDepartement: '',

    init(elementId, options) {
      this.carte = L.map(elementId, {
        center: options.centre || [46.6, 2.4],
        zoom: options.zoom || 7,
        zoomControl: false,
        preferCanvas: true,
      });
      // Pas de `L.control.zoom` : l'application fournit ses propres boutons,
      // plus grands et avec des libellés accessibles.
      //
      // Un seul fournisseur de tuiles, OpenStreetMap, sans clé ni compte.
      // Le rendu « sobre » est obtenu en désaturant les tuiles par CSS
      // (voir `.leaflet-tile-pane` dans la feuille de style) : c'est la seule
      // façon de obtains un fond neutre sans introduire une dépendance
      // externe. Les fonds gris de CARTO ont été écartés parce qu'ils
      // exigent une clé d'API et affichent « API KEY REQUIRED » sans elle.
      this.nomFond = 'sobre';
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(this.carte);

      this.couches.communes = L.geoJSON(null, { style: f => this._styleCommune(f) })
        .addTo(this.carte);

      // Regroupement des établissements.
      //
      // À l'échelle nationale, 2 506 pins individuels recouvrent la France
      // entière : ils se chevauchent, masquent la carte et rendent les
      // contours illisibles. Regroupés, ils tiennent en un point portant son
      // nombre, et se séparent à mesure que l'on zoome.
      //
      // `chunkedLoading` évite de bloquer le navigateur pendant la création
      // des 2 506 marqueurs, `removeOutsideVisibleBounds` fait le ménage.
      const optionsCluster = {
        // `removeOutsideVisibleBounds` est volontairement laissé à false.
        // Sur un saut d'un bout à l'autre du pays (Paris → Marseille), il
        // vidait le groupe des marqueurs de l'ancien emprise après les avoir
        // ajoutés pour la nouvelle : la carte s'affichait vide. Le gain
        // mémoire qu'il apporte est négligeable pour 2 506 marqueurs.
        chunkedLoading: true,
        showCoverageOnHover: false,
        // Au zoom maximal, les pins d'un groupe s'écartent en cercle plutôt
        // que de se superposer : on voit tous les établissements d'une ville.
        spiderfyOnMaxZoom: true,
        disableClusteringAtZoom: 16,
        // Rayon large à l'échelle nationale, pour que la France tienne en un
        // seul point ; il se resserre ensuite à mesure qu'on zoome.
        maxClusterRadius: (zoom) => (zoom <= 6 ? 150 : zoom <= 9 ? 90 : 60),
        iconCreateFunction: (cluster) => this._iconeGroupe(cluster),
      };

      // Repli si le plugin n'a pas pu se charger : on perd le regroupement,
      // pas la carte. Mieux vaut 2 506 pins qui s'affichent qu'un écran vide.
      this.couches.hopitaux = (typeof L.markerClusterGroup === 'function'
        ? L.markerClusterGroup(optionsCluster)
        : L.layerGroup()).addTo(this.carte);
      this.regroupement = this.couches.hopitaux instanceof L.MarkerClusterGroup;

      this.couches.position = L.layerGroup().addTo(this.carte);
      this.couches.rayon = L.layerGroup().addTo(this.carte);
      this.couches.route = L.layerGroup().addTo(this.carte);

      return this.carte;
    },

    /**
     * Rampe séquentielle du nombre d'établissements par commune.
     *
     * Choix à l'appui du fond de carte : la rampe est violette, pas bleue.
     * Le bleu est déjà la couleur de l'eau sur un fond de carte, et le bleu
     * de la marque sur les marqueurs ; un dégradé bleu se lisait comme une
     * teinte du fond plutôt que comme une donnée.
     *
     * L'échelle est volontairement **qualitative en bas et quantitative en
     * haut** : « aucun établissement » est un gris neutre, qui dit l'absence
     * de matière et se distingue du tout premier établissement. Une simple
     * interpolation aurait rendu les deux premiers practically identiques.
     */
    CLASSES: [
      { seuil: 20, couleur: '#45207d', texte: '20 et plus' },
      { seuil: 10, couleur: '#6b45ac', texte: '10 à 19' },
      { seuil: 5, couleur: '#9276ce', texte: '5 à 9' },
      { seuil: 2, couleur: '#b7a6e3', texte: '2 à 4' },
      { seuil: 1, couleur: '#d8cff0', texte: '1' },
      { seuil: 0, couleur: '#e9eaee', texte: 'aucun', neutre: true },
    ],

    /** Couleur d'une commune selon le nombre d'établissements. */
    _couleur(n) {
      if (!n) return '#e9eaee';
      for (const c of this.CLASSES) {
        if (n >= c.seuil) return c.couleur;
      }
      return '#e9eaee';
    },

    /**
     * Bascule entre le rendu sobre et le rendu détaillé.
     *
     * Ce n'est pas un changement de fournisseur mais un filtre CSS sur les
     * tuiles : même source, mêmes attributs, donc pas de second appel réseau.
     * Le fond standard d'OpenStreetMap est beige, vert et bleu ; désaturé, il
     * devient un support neutre et la couleur des communes redevient la seule
     * couleur de l'écran.
     */
    changerFond(nom) {
      const valide = nom === 'detaille' ? 'detaille' : 'sobre';
      this.nomFond = valide;
      // L'attribut va sur l'élément conteneur, pas sur l'objet carte :
      // `setAttribute` est une méthode DOM, pas une méthode Leaflet.
      const conteneur = this.carte && this.carte.getContainer
        ? this.carte.getContainer() : null;
      if (conteneur) conteneur.setAttribute('data-fond', valide);
      return valide;
    },

    /**
     * Style complet d'une commune.
     *
     * Point unique de décision : le filtre de département et la sélection au
     * clic sont tous deux lus ici, plutôt que.redéfinis dans chaque appelant.
     * C'est ce qui évite qu'un survol de souris restitue un style qui ignore
     * le filtre, et fasse réapparaître une commune hors département.
     *
     * Hors du département filtré, la commune est conservée mais estompée :
     * supprimer les contours ferait perdre le contexte territorial, qui est
     * précisément ce qui permet de situer le département choisi.
     */
    _styleDeCommune(c) {
      const dep = this.filtreDepartement;
      const dansFiltre = !dep || String(c && c.departement) === String(dep);
      const estChoisie = !!(this._selectionCommune && c
        && this._selectionCommune.code === c.code);

      const base = {
        color: '#7c3aed',
        weight: 0.7,
        opacity: 1,
        fillColor: this._couleur(c ? c.nbHopitaux : 0),
        fillOpacity: 0.6,
        className: 'commune-polygone',
      };

      if (!dansFiltre) {
        // Gris franc, contour gris : hors du département filtré, la teinte
        // violette disparaît entièrement. La différence avec la classe
        // « aucun établissement » tient donc à la teinte du contour, pas
        // seulement à l'opacité, sinon les deux se confondraient.
        return {
          ...base,
          color: '#b9c2cc', weight: 0.7, opacity: 1,
          fillColor: '#eceff3', fillOpacity: 0.55,
        };
      }
      if (dep) {
        return { ...base, color: '#5b21b6', weight: 1.1, fillOpacity: 0.82 };
      }
      if (estChoisie) {
        return { ...base, color: '#2e1065', weight: 2.5, fillOpacity: 0.85 };
      }
      return base;
    },

    _styleCommune(f) {
      const c = f.feature && f.feature.properties && f.feature.properties.__commune;
      return this._styleDeCommune(c);
    },

    /**
     * Restreint la coloration des contours à un département.
     *
     * Les styles sont modifiés couche par couche : reconstructions 34 877
     * polygones prendrait plusieurs secondes, alors que changer un style
     * prend une fraction de seconde.
     */
    appliquerFiltreDepartement(dep) {
      this.filtreDepartement = dep || '';
      this._selectionCommune = null;
      if (!this._pret()) return 0;
      let retenues = 0;
      this.couches.communes.eachLayer(l => {
        const c = l.__commune;
        if (!c) return;
        if (this.filtreDepartement && String(c.departement) === String(this.filtreDepartement)) retenues++;
        l.setStyle(this._styleDeCommune(c));
      });
      return retenues;
    },

    /** Nombre de communes d'un département, d'après les communes chargées. */
    compterCommunes(dep) {
      const communes = global.DataManager.communes;
      if (!dep) return communes.length;
      return communes.filter(c => String(c.departement) === String(dep)).length;
    },

    /** Cadrage sur les communes d'un département. */
    cadrerDepartement(dep) {
      if (!this._pret() || !dep) return;
      const cible = global.DataManager.communes.filter(
        c => String(c.departement) === String(dep));
      if (!cible.length) return;
      const pts = [];
      for (const c of cible) {
        if (!c._bbox) continue;
        pts.push([c._bbox[0], c._bbox[1]], [c._bbox[2], c._bbox[3]]);
      }
      if (!pts.length) return;
      const lats = pts.map(p => p[0]), lons = pts.map(p => p[1]);
      this.carte.fitBounds(
        [[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]],
        { padding: [40, 40] });
    },

    /**
     * Redessine la couche communes avec l'état courant du DataManager.
     *
     * Les trois méthodes d'affichage ci-dessous sont volontairement tolérantes :
     * le navigateur peut avoir des données alors que la carte n'existe pas
     * encore (la page d'accueil se charge avant que l'utilisateur ouvre la
     * carte). Elles ne font alors rien, et l'affichage réel a lieu à
     * l'initialisation.
     */
    _pret() {
      return !!(this.carte && this.couches && this.couches.communes);
    },

    /** Redessine la couche communes avec l'état courant du DataManager. */
    majCommunes() {
      if (!this._pret()) return;
      this.afficherCommunes(global.DataManager.communes, global.UI.ouvrirFicheCommune);
    },

    /** Trace les communes et branche survol / clic / infobulle. */
    afficherCommunes(communes, onSelection) {
      if (!this._pret()) return;

      // La géométrie est reprise telle quelle, sans copie : Leaflet la convertit
      // en tableaux Leaflet sans jamais modifier l'objet source, et un
      // `JSON.parse(JSON.stringify(...))` sur 34 877 polygones coûterait
      // plusieurs secondes et doublerait la mémoire du navigateur.
      const geojson = {
        type: 'FeatureCollection',
        features: communes.map(c => ({
          type: 'Feature',
          geometry: c.geometry,
          properties: {
            __commune: true,
            code: c.code, nom: c.nom,
            nbHopitaux: c.nbHopitaux, nbUrgences: c.nbUrgences, nbGarde: c.nbGarde,
            population: c.population,
          },
        })),
      };
      // Attache l'objet commune réel pour l'affichage.
      this._communesParCode = new Map(communes.map(c => [c.code, c]));
      const couche = this.couches.communes;
      couche.clearLayers();
      couche.options.style = f => this._styleCommune({
        feature: { properties: this._propsCommune(f) },
      });
      couche.addData(geojson);

      couche.eachLayer(layer => {
        const p = layer.feature.properties;
        const c = this._communesParCode.get(p.code);
        if (c) { c.layer = layer; layer.__commune = c; }

        // Survol : légère montée de couleur, contour renforcé, curseur.
        layer.on('mouseover', () => {
          // Contour quasi noir : c'est la seule teinte qui contraste avec
          // toutes les classes de la rampe et avec le gris des communes hors
          // filtre. Le cyan d'avant se confondait avec le bleu du fond.
          layer.setStyle({ weight: 2.2, color: '#0f172a', fillOpacity: 0.85 });
          if (layer.getElement()) layer.getElement().classList.add('survol');
          global.UI?.infobulleCommune(c);
        });
        layer.on('mouseout', () => {
          this._restaurerStyle(layer);
          if (layer.getElement()) layer.getElement().classList.remove('survol');
          global.UI?.masquerInfobulle();
        });
        layer.on('click', () => {
          this.selectionnerCommune(c);
          onSelection && onSelection(c);
        });
        if (layer.getElement()) layer.getElement().classList.add('commune');
      });
      return couche;
    },

    _propsCommune(layer) {
      const p = (layer.feature && layer.feature.properties) || {};
      const c = this._communesParCode && this._communesParCode.get(p.code);
      return { __commune: true, ...p, nbHopitaux: c ? c.nbHopitaux : p.nbHopitaux };
    },

    _restaurerStyle(layer) {
      const c = layer.__commune;
      if (!c) return;
      layer.setStyle(this._styleDeCommune(c));
    },

    /**
     * Sélectionne une commune et estompe les autres.
     *
     * Les styles repassent tous par `_styleDeCommune`, donc le filtre de
     * département reste respecté : sélectionner une commune hors du
     * département filtré ne la fait pas « revenir en couleur ».
     */
    selectionnerCommune(commune) {
      this._selectionCommune = commune;
      if (!this._pret()) return;
      this.couches.communes.eachLayer(l => {
        const c = l.__commune;
        if (!c) return;
        const style = this._styleDeCommune(c);
        if (commune && c.code !== commune.code) {
          // La sélection ressort : les autres baissent d'un cran de plus.
          style.opacity = style.opacity * 0.45;
          style.fillOpacity = style.fillOpacity * 0.5;
        }
        l.setStyle(style);
      });
      if (commune && commune.layer) commune.layer.bringToFront();
    },

    /**
     * Dessine les établissements, en réutilisant les marqueurs existants.
     *
     * L'ajout et le retrait se font par lots (`addLayers` / `removeLayers`)
     * et non marqueur par marqueur : la couche est un groupe de regroupement,
     * dont chaque ajout déclenche un recalcul des groupes. Sur 2 506
     * établissements, l'ajout un à un gèle l'interface pendant plusieurs
     * secondes à chaque changement de filtre.
     */
    afficherHopitaux(hopitaux) {
      if (!this._pret()) return;
      const vus = new Set(hopitaux.map((h) => h.id));
      const aAjouter = [];
      const aRetirer = [];

      for (const h of hopitaux) {
        const type = typeDe(h);
        const existant = this._markers.get(h.id);
        if (existant) {
          // L'icône encode l'état d'urgence : elle doit suivre le filtre.
          if (existant._type !== type) {
            existant.setIcon(iconeLeaflet(type));
            existant._type = type;
          }
          h.marker = existant;
          continue;
        }
        const m = L.marker([h.lat, h.lon], {
          icon: iconeLeaflet(type),
          keyboard: true,
          alt: h.nom,
          riseOnHover: true,
        });
        m._type = type;
        m.bindPopup(global.UI?.fichePopup(h) || h.nom);
        m.on('click', () => global.UI?.ouvrirFicheHopital(h));
        this._markers.set(h.id, m);
        h.marker = m;
        aAjouter.push(m);
      }

      for (const [id, m] of this._markers) {
        if (!vus.has(id)) { aRetirer.push(m); this._markers.delete(id); }
      }

      if (aRetirer.length) this.couches.hopitaux.removeLayers(aRetirer);
      if (aAjouter.length) this.couches.hopitaux.addLayers(aAjouter);
    },

    /**
     * Bulle d'un groupe d'établissements.
     *
     * La pastille devient rouge quand **la moitié** de ses établissements ont
     * des urgences, et non dès qu'il y en a un seul. Le critère « au moins
     * un » rendait presque tous les groupes rouges : sur 2 506
     * établissements, la moindre agglomération un peu urbaine suffisait, et la
     * couleur ne distinguait plus rien. La proportion, elle, dit si un
     * secteur est plutôt pourvu en urgences ou non.
     */
    _iconeGroupe(cluster) {
      const n = cluster.getChildCount();
      // Taille croissante sur une échelle courte : 1, 10, 100, 1000
      // établissements doivent se distinguer d'un coup d'œil.
      const taille = n < 10 ? 38 : n < 100 ? 46 : n < 1000 ? 56 : 66;
      const avecUrgences = cluster.getAllChildMarkers()
        .filter(m => m._type === 'urgence' || m._type === 'urgence-garde').length;
      const urgence = avecUrgences * 2 >= n;

      return L.divIcon({
        html: `<span class="groupe${urgence ? ' groupe--urgence' : ''}">`
          + `<span class="groupe-nombre">${n >= 1000 ? Math.round(n / 100) / 10 + 'k' : n}</span>`
          + '</span>',
        className: 'groupe-icone',
        iconSize: [taille, taille],
      });
    },

    /** Position de l'utilisateur et cercle de rayon. */
    afficherPosition(lat, lon, rayonKm) {
      this.couches.position.clearLayers();
      this.couches.rayon.clearLayers();
      const p = L.circleMarker([lat, lon], {
        radius: 8, weight: 3, color: '#fff',
        fillColor: PALETTE.position, fillOpacity: 1,
      }).addTo(this.couches.position);
      p.bindPopup('Votre position');
      if (rayonKm) {
        L.circle([lat, lon], {
          radius: rayonKm * 1000, weight: 1.5, color: '#00a9ce',
          fillColor: '#00a9ce', fillOpacity: 0.08, dashArray: '6 4',
        }).addTo(this.couches.rayon);
      }
      return p;
    },

    effacerPosition() {
      this.couches.position.clearLayers();
      this.couches.rayon.clearLayers();
    },

    /**
     * Cercle de rayon de recherche autour d'une position.
     *
     * Séparé de `afficherPosition` parce que changer de rayon ne doit pas
     * remplacer le marqueur de position : il faut seulement retracer le cercle.
     */
    afficherRayon(position, rayonKm) {
      this.couches.rayon.clearLayers();
      if (!position || !rayonKm) return;
      L.circle([position.lat, position.lon], {
        radius: rayonKm * 1000, weight: 1.5, color: PALETTE.position,
        fillColor: PALETTE.position, fillOpacity: 0.08, dashArray: '6 4',
      }).addTo(this.couches.rayon);
    },

    /** Tracé de l'itinéraire, animé. */
    afficherRoute(coordonnees) {
      this.couches.route.clearLayers();
      if (!coordonnees || !coordonnees.length) return null;
      const ligne = L.polyline(coordonnees, {
        color: '#00a9ce', weight: 5, opacity: 0.9, lineJoin: 'round',
      }).addTo(this.couches.route);
      // Halo sombre dessous pour détacher le tracé du fond.
      L.polyline(coordonnees, { color: '#ffffff', weight: 9, opacity: 0.5 })
        .addTo(this.couches.route).bringToBack();
      return ligne;
    },

    /**
     * Recadre sur l'itinéraire et l'anime.
     *
     * La carte utilise le rendu canvas (`preferCanvas`), où un tracé n'a pas
     * d'élément SVG : manipuler `classList` sur `getElement()` échoue donc.
     * L'animation se fait sur `dashOffset`, qui fonctionne dans les deux modes
     * de rendu.
     */
    animerRoute() {
      const couches = this.couches.route.getLayers();
      if (!couches.length) return;
      const ligne = couches[0];
      if (!ligne.setStyle || !ligne.getBounds) return;

      ligne.setStyle({ dashArray: '10 14', dashOffset: 24 });
      const depart = performance.now();
      const pas = (t) => {
        const reste = 1 - (t - depart) / 1200;
        if (reste <= 0) {
          // On rend le trait plein une fois l'animation terminée.
          ligne.setStyle({ dashArray: null, dashOffset: null });
          return;
        }
        ligne.setStyle({ dashOffset: 24 * reste });
        requestAnimationFrame(pas);
      };
      requestAnimationFrame(pas);

      this.carte.fitBounds(ligne.getBounds(), { padding: [48, 48] });
    },

    effacerRoute() { this.couches.route.clearLayers(); },

    /** Cadrage sur un ensemble de points. */
    cadrer(points, marge = 60) {
      if (!points || !points.length) return;
      const lats = points.map(p => p[0]), lons = points.map(p => p[1]);
      this.carte.fitBounds(
        [[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]],
        { padding: [marge, marge], maxZoom: 16 });
    },

    /**
     * Cadrage sur la France métropolitaine.
     *
     * Les coordonnées sont écrites en dur plutôt que dérivées des données :
     * la couche contient aussi l'outre-mer, et un cadrage calculé sur
     * l'ensemble des communes plaquerait la France métropolitaine dans un coin
     * de l'écran.
     */
    cadrerFrance() {
      this.carte.fitBounds([[41.3, -5.2], [51.1, 9.6]], { padding: [24, 24] });
    },

    PALETTE, typeDe, icone,
  };

  global.MapView = MapView;
})(window);